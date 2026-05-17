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

import { AutobeatError, tmuxSendKeysFailed, tmuxSessionFailed } from '../../core/errors.js';
import { err, ok, Result } from '../../core/result.js';
import {
  ExecFn,
  MAX_CONCURRENT_SESSIONS,
  SESSION_NAME_REGEX,
  TmuxSessionConfig,
  TmuxSessionInfo,
  TmuxSessionManager,
  TmuxSessionResult,
} from './types.js';

/** Default terminal dimensions if not specified */
const DEFAULT_WIDTH = 220;
const DEFAULT_HEIGHT = 50;

/**
 * "Session not found" patterns returned by tmux when the target doesn't exist.
 * Treated as idempotent success for destroySession().
 */
const SESSION_NOT_FOUND_PATTERNS = ["can't find session", 'no server running', 'session not found'];

function isSessionNotFound(output: string): boolean {
  const lower = output.toLowerCase();
  return SESSION_NOT_FOUND_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Escapes a string for embedding inside a single-quoted shell context.
 * Only single quotes need escaping — all other characters are literal
 * inside single quotes per POSIX shell rules.
 */
function escapeSingleQuoted(value: string): string {
  return value.replace(/'/g, "'\\''");
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

export class DefaultTmuxSessionManager implements TmuxSessionManager {
  private readonly maxConcurrentSessions: number;

  constructor(private readonly deps: { exec: ExecFn; maxConcurrentSessions?: number }) {
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

    // Enforce concurrent session limit
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
    if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
      return err(tmuxSessionFailed('create', `Invalid dimensions: ${width}x${height}`, { width, height }));
    }
    const cwdFlag = config.cwd ? ` -c '${escapeSingleQuoted(config.cwd)}'` : '';

    const spawnResult = this.deps.exec(
      `tmux new-session -d -s ${config.name} -x ${width} -y ${height}${cwdFlag} '${escapeSingleQuoted(config.command)}'`,
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
    this.injectEnvironment(config.name, taskId, config.env);

    return ok({ sessionName: config.name, taskId });
  }

  /**
   * Injects environment variables into an existing session.
   * Auto-vars (AUTOBEAT_TASK_ID, AUTOBEAT_SPAWN_TIME) win on conflict with
   * caller-supplied env. Invalid POSIX key names are silently skipped.
   * Best-effort — does not roll back the session on failure.
   */
  private injectEnvironment(sessionName: string, taskId: string, callerEnv: Record<string, string> | undefined): void {
    // Auto-inject task identity variables so workers can identify their session
    const autoVars: Record<string, string> = {
      AUTOBEAT_TASK_ID: taskId,
      AUTOBEAT_SPAWN_TIME: new Date().toISOString(),
    };

    // Inject caller-provided env vars, then the auto vars (auto vars win on conflict)
    const allEnv: Record<string, string> = { ...(callerEnv ?? {}), ...autoVars };

    // Filter to valid POSIX env var keys and build a batched command to avoid N+1 spawns
    const validEntries = Object.entries(allEnv).filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key));

    if (validEntries.length > 0) {
      const commands = validEntries
        .map(([key, value]) => {
          return `tmux set-environment -t ${sessionName} ${key} '${escapeSingleQuoted(value)}'`;
        })
        .join(' && ');
      // Best-effort: session is created; don't roll back for env var failures
      this.deps.exec(commands);
    }
  }

  /**
   * Destroys a tmux session. Idempotent — succeeds even if the session
   * no longer exists.
   */
  destroySession(name: string): Result<void, AutobeatError> {
    const nameCheck = validateSessionName(name, 'destroy');
    if (!nameCheck.ok) return nameCheck;

    const result = this.deps.exec(`tmux kill-session -t ${name}`);

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

    const escaped = escapeSingleQuoted(keys);
    const result = this.deps.exec(`tmux send-keys -t ${name} -l '${escaped}'`);

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

    const result = this.deps.exec(`tmux has-session -t ${name}`);
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
      const trimmed = line.trim();
      if (!trimmed) continue;

      const parts = trimmed.split(':');
      if (parts.length < 5) continue;

      const [name, createdStr, attachedStr, widthStr, heightStr] = parts as [string, string, string, string, string];

      // Filter to only beat-* sessions
      if (!SESSION_NAME_REGEX.test(name)) continue;

      const created = parseInt(createdStr, 10);
      const width = parseInt(widthStr, 10);
      const height = parseInt(heightStr, 10);
      if (isNaN(created) || isNaN(width) || isNaN(height)) continue;

      sessions.push({
        name,
        created,
        attached: attachedStr === '1',
        width,
        height,
      });
    }

    return ok(sessions);
  }

  /**
   * Retrieves an environment variable from a session.
   * Returns undefined if the variable is not set.
   */
  getSessionEnvironment(name: string, varName: string): Result<string | undefined, AutobeatError> {
    const nameCheck = validateSessionName(name, 'getSessionEnvironment');
    if (!nameCheck.ok) return nameCheck;

    // Validate varName: must be a valid POSIX environment variable name
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName)) {
      return err(
        tmuxSessionFailed('getSessionEnvironment', `Invalid environment variable name "${varName}"`, { varName }),
      );
    }

    const result = this.deps.exec(`tmux show-environment -t ${name} ${varName}`);

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
