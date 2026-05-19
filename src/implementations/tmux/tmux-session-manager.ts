/**
 * TmuxSessionManager — low-level tmux session lifecycle operations
 *
 * DESIGN DECISION: All operations use a synchronous ExecFn (wraps spawnSync)
 * so that the caller controls async boundaries. This simplifies testing and
 * avoids hidden event-loop coupling.
 *
 * SECURITY: sendKeys uses `-l` (literal mode) to prevent tmux from
 * interpreting shell metacharacters. Additional escaping is applied for
 * single quotes to prevent breaking the shell quoting context.
 */

import type { AutobeatError } from '../../core/errors.js';
import { tmuxSendKeysFailed, tmuxSessionFailed } from '../../core/errors.js';
import type { Result } from '../../core/result.js';
import { err, ok } from '../../core/result.js';
import { escapeForSingleQuotes } from './tmux-shell-utils.js';
import type { ExecFn, TmuxSessionConfig, TmuxSessionInfo, TmuxSessionManagerPort, TmuxSessionResult } from './types.js';
import { MAX_CONCURRENT_SESSIONS, SAFE_PATH_REGEX, SESSION_NAME_REGEX } from './types.js';

/**
 * Dependencies for TmuxSessionManager.
 * Follows the *Deps interface convention used by TmuxConnectorDeps and TmuxHooksDeps.
 */
export interface TmuxSessionManagerDeps {
  exec: ExecFn;
  maxConcurrentSessions?: number;
}

/** Default terminal dimensions if not specified */
const DEFAULT_WIDTH = 220;
const DEFAULT_HEIGHT = 50;

/**
 * "Session not found" patterns returned by tmux when the target doesn't exist.
 * Treated as idempotent success for destroySession().
 */
const SESSION_NOT_FOUND_PATTERNS = ["can't find session", 'no server running', 'session not found'];

/** Valid POSIX environment variable name: must start with letter or underscore */
const POSIX_ENV_VAR_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Maximum byte length for an environment variable value — protects against oversized inputs */
const MAX_ENV_VALUE_LENGTH = 4096;

/**
 * Allowlist of tmux control key tokens accepted by sendControlKeys().
 * SECURITY: Keys are interpolated directly into the shell command without quoting
 * (no -l flag so tmux can interpret them as key bindings). Restricting to known
 * tmux key names prevents shell injection through the keys parameter.
 */
export const ALLOWED_CONTROL_KEYS = new Set(['C-c', 'C-d', 'C-z', 'C-\\', 'Enter', 'Escape']);

function isSessionNotFound(output: string): boolean {
  const lower = output.toLowerCase();
  return SESSION_NOT_FOUND_PATTERNS.some((p) => lower.includes(p));
}

function validateSessionName(name: string, operation: string): Result<void, AutobeatError> {
  if (!SESSION_NAME_REGEX.test(name)) {
    return err(
      tmuxSessionFailed(operation, `Session name "${name}" does not match required pattern ${SESSION_NAME_REGEX}`, {
        sessionName: name,
      }),
    );
  }
  return ok(undefined);
}

export class TmuxSessionManager implements TmuxSessionManagerPort {
  private readonly maxConcurrentSessions: number;

  constructor(private readonly deps: TmuxSessionManagerDeps) {
    this.maxConcurrentSessions = deps.maxConcurrentSessions ?? MAX_CONCURRENT_SESSIONS;
  }

  /**
   * Creates a new detached tmux session.
   * Validates the session name, enforces the concurrent-session limit,
   * spawns the session, then injects any requested environment variables.
   */
  createSession(config: TmuxSessionConfig): Result<TmuxSessionResult, AutobeatError> {
    const nameCheck = validateSessionName(config.name, 'create');
    if (!nameCheck.ok) return nameCheck;

    // DESIGN DECISION: Dual-gate session cap — this is the authoritative tmux-level gate.
    // TmuxConnector performs a fast in-memory check (O(1)) before calling here; that check
    // avoids the ~5-20ms exec cost of listSessions() on every spawn when the cap is already
    // reached. This listSessions() call is the ground-truth gate: it reflects the actual
    // state of tmux and guards against crash-recovery scenarios where the connector's
    // in-memory map was reset (process restart) but tmux sessions are still alive. The
    // defense-in-depth duplication is intentional — removing either gate would create a
    // window where the limit could be bypassed.
    const listResult = this.listSessions();
    if (!listResult.ok) return listResult;
    if (listResult.value.length >= this.maxConcurrentSessions) {
      return err(
        tmuxSessionFailed('create', `Concurrent session limit reached (${this.maxConcurrentSessions})`, {
          current: listResult.value.length,
          limit: this.maxConcurrentSessions,
        }),
      );
    }

    const width = config.width ?? DEFAULT_WIDTH;
    const height = config.height ?? DEFAULT_HEIGHT;
    const dimensionCheck = this.validateDimensions(width, height);
    if (!dimensionCheck.ok) return dimensionCheck;

    // Defense-in-depth: validate cwd against SAFE_PATH_REGEX before embedding
    // in a shell command — same check applied to sessionsDir in tmux-hooks.ts.
    if (config.cwd !== undefined && !SAFE_PATH_REGEX.test(config.cwd)) {
      return err(
        tmuxSessionFailed('create', `unsafe cwd path: ${config.cwd}`, {
          cwd: config.cwd,
        }),
      );
    }
    const cwdFlag = config.cwd ? ` -c '${escapeForSingleQuotes(config.cwd)}'` : '';

    const spawnResult = this.deps.exec(
      `tmux new-session -d -s '${config.name}' -x ${width} -y ${height}${cwdFlag} '${escapeForSingleQuotes(config.command)}'`,
    );

    if (spawnResult.status !== 0) {
      return err(
        tmuxSessionFailed('create', spawnResult.stderr || spawnResult.stdout, {
          sessionName: config.name,
          exitStatus: spawnResult.status,
        }),
      );
    }

    const taskId = config.name.replace(/^beat-/, '');
    // injectEnvironment is best-effort — a false return means the set-environment command
    // failed (e.g. session exited immediately). The session is still created.
    // No logger dep on this class; observable only via exec mock in tests.
    // See: cons-sm-3 — promoting to a logger warn when a logger dep is added.
    this.injectEnvironment(config.name, taskId, config.env);

    return ok({ sessionName: config.name });
  }

  /** Validates that width and height are positive integers. */
  private validateDimensions(width: number, height: number): Result<void, AutobeatError> {
    if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
      return err(tmuxSessionFailed('create', `Invalid dimensions: ${width}x${height}`, { width, height }));
    }
    return ok(undefined);
  }

  /**
   * Injects environment variables into an existing session.
   * Auto-vars (AUTOBEAT_TASK_ID, AUTOBEAT_SPAWN_TIME) win on conflict with
   * caller-supplied env. Invalid POSIX key names are silently skipped.
   * Returns true if exec succeeded (or nothing to inject), false if the
   * batched set-environment command failed (e.g. session exited immediately).
   * Best-effort — does not roll back the session on failure.
   */
  private injectEnvironment(
    sessionName: string,
    taskId: string,
    callerEnv: Record<string, string> | undefined,
  ): boolean {
    // Auto-inject task identity variables so workers can identify their session
    const autoVars: Record<string, string> = {
      AUTOBEAT_TASK_ID: taskId,
      AUTOBEAT_SPAWN_TIME: new Date().toISOString(),
    };

    // Inject caller-provided env vars, then the auto vars (auto vars win on conflict)
    const allEnv: Record<string, string> = { ...(callerEnv ?? {}), ...autoVars };

    // Filter to valid POSIX env var keys with value length cap, then batch to avoid N+1 spawns
    const validEntries = Object.entries(allEnv).filter(
      ([key, value]) => POSIX_ENV_VAR_REGEX.test(key) && value.length <= MAX_ENV_VALUE_LENGTH,
    );

    if (validEntries.length === 0) return true;

    const commands = validEntries
      .map(([key, value]) => `tmux set-environment -t '${sessionName}' ${key} '${escapeForSingleQuotes(value)}'`)
      .join(' && ');
    const result = this.deps.exec(commands);
    return result.status === 0;
  }

  /**
   * Destroys a tmux session. Idempotent — succeeds even if the session
   * no longer exists.
   */
  destroySession(name: string): Result<void, AutobeatError> {
    const nameCheck = validateSessionName(name, 'destroy');
    if (!nameCheck.ok) return nameCheck;

    const result = this.deps.exec(`tmux kill-session -t '${name}'`);

    if (result.status !== 0) {
      // Treat "session not found" as success (idempotent)
      const combinedOutput = (result.stderr + result.stdout).toLowerCase();
      if (isSessionNotFound(combinedOutput)) {
        return ok(undefined);
      }
      return err(
        tmuxSessionFailed('destroy', result.stderr || result.stdout, {
          sessionName: name,
          exitStatus: result.status,
        }),
      );
    }

    return ok(undefined);
  }

  /**
   * Sends literal keys to a session.
   * Uses `-l` (literal mode) to prevent tmux key binding interpretation.
   */
  sendKeys(name: string, keys: string): Result<void, AutobeatError> {
    const nameCheck = validateSessionName(name, 'sendKeys');
    if (!nameCheck.ok) return nameCheck;

    const escaped = escapeForSingleQuotes(keys);
    const result = this.deps.exec(`tmux send-keys -t '${name}' -l '${escaped}'`);

    if (result.status !== 0) {
      return err(tmuxSendKeysFailed(name, result.stderr || result.stdout));
    }

    return ok(undefined);
  }

  /**
   * Sends control key sequences to a session WITHOUT -l (literal) mode.
   * Use for keys that tmux should interpret (e.g. C-c triggers SIGINT).
   *
   * SECURITY: Does not use escapeForSingleQuotes because keys like C-c are
   * tmux binding tokens, not user-controlled strings. Callers must only pass
   * well-known tmux key names (e.g. 'C-c', 'Enter').
   */
  sendControlKeys(name: string, keys: string): Result<void, AutobeatError> {
    const nameCheck = validateSessionName(name, 'sendControlKeys');
    if (!nameCheck.ok) return nameCheck;

    // SECURITY: Validate keys against the allowlist before embedding in the shell command.
    // Keys are NOT single-quoted (no -l flag) so tmux interprets them as key bindings.
    // An unvalidated keys parameter would allow shell injection.
    if (!ALLOWED_CONTROL_KEYS.has(keys)) {
      return err(
        tmuxSessionFailed('sendControlKeys', `key '${keys}' is not in the allowed control keys list`, {
          sessionName: name,
        }),
      );
    }

    // DECISION: No -l flag — allows tmux to interpret key bindings (C-c → SIGINT).
    // This is intentionally different from sendKeys which uses -l for literal text.
    const result = this.deps.exec(`tmux send-keys -t '${name}' ${keys}`);

    if (result.status !== 0) {
      return err(tmuxSendKeysFailed(name, result.stderr || result.stdout));
    }

    return ok(undefined);
  }

  /**
   * Returns true if the session is alive (tmux has-session exit 0).
   */
  isAlive(name: string): Result<boolean, AutobeatError> {
    const nameCheck = validateSessionName(name, 'isAlive');
    if (!nameCheck.ok) return nameCheck;

    const result = this.deps.exec(`tmux has-session -t '${name}'`);
    return ok(result.status === 0);
  }

  /**
   * Lists all beat-* sessions with parsed metadata.
   */
  listSessions(): Result<TmuxSessionInfo[], AutobeatError> {
    const result = this.deps.exec(
      "tmux list-sessions -F '#{session_name}:#{session_created}:#{session_attached}:#{session_width}:#{session_height}'",
    );

    // exit 1 with "no server running" or similar means no sessions at all
    if (result.status !== 0) {
      const combinedOutput = (result.stderr + result.stdout).toLowerCase();
      if (isSessionNotFound(combinedOutput)) {
        return ok([]);
      }
      return err(
        tmuxSessionFailed('list', result.stderr || result.stdout, {
          exitStatus: result.status,
        }),
      );
    }

    const sessions: TmuxSessionInfo[] = [];
    for (const line of result.stdout.split('\n')) {
      const parsed = this.parseSessionLine(line);
      if (parsed !== null) sessions.push(parsed);
    }

    return ok(sessions);
  }

  /**
   * Parses a single line from `tmux list-sessions` output.
   * Expected format: `name:created:attached:width:height`
   * Returns null for empty, malformed, or non-beat-* lines.
   */
  private parseSessionLine(line: string): TmuxSessionInfo | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    const parts = trimmed.split(':');
    if (parts.length < 5) return null;

    const [name, createdStr, attachedStr, widthStr, heightStr] = parts;
    if (!name || !createdStr || !attachedStr || !widthStr || !heightStr) return null;

    // Filter to only beat-* sessions
    if (!SESSION_NAME_REGEX.test(name)) return null;

    const created = parseInt(createdStr, 10);
    const width = parseInt(widthStr, 10);
    const height = parseInt(heightStr, 10);
    if (isNaN(created) || isNaN(width) || isNaN(height)) return null;

    return { name, created, attached: attachedStr === '1', width, height };
  }

  /**
   * Retrieves an environment variable from a session.
   * Returns undefined if the variable is not set.
   */
  getSessionEnvironment(name: string, varName: string): Result<string | undefined, AutobeatError> {
    const nameCheck = validateSessionName(name, 'getSessionEnvironment');
    if (!nameCheck.ok) return nameCheck;

    // Validate varName: must be a valid POSIX environment variable name
    if (!POSIX_ENV_VAR_REGEX.test(varName)) {
      return err(
        tmuxSessionFailed('getSessionEnvironment', `Invalid environment variable name "${varName}"`, { varName }),
      );
    }

    const result = this.deps.exec(`tmux show-environment -t '${name}' ${varName}`);

    if (result.status !== 0) {
      // Variable not set in session environment
      return ok(undefined);
    }

    const line = result.stdout.trim();
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) return ok(undefined);

    return ok(line.slice(eqIdx + 1));
  }
}
