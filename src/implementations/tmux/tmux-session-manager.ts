/**
 * TmuxSessionManager — low-level tmux session lifecycle operations
 *
 * DESIGN DECISION: All operations use a synchronous ExecFn (wraps spawnSync)
 * so that the caller controls async boundaries. This simplifies testing and
 * avoids hidden event-loop coupling.
 *
 * SECURITY: sendKeys uses `-l` (literal mode) to prevent tmux from
 * interpreting shell metacharacters. Additional escaping is applied for
 * single quotes, backslashes, dollar signs, and backticks inside the literal.
 */

import { AutobeatError, tmuxSendKeysFailed, tmuxSessionFailed } from '../../core/errors.js';
import { err, ok, Result } from '../../core/result.js';
import {
  ExecFn,
  MAX_CONCURRENT_SESSIONS,
  SESSION_NAME_REGEX,
  TmuxHandle,
  TmuxSessionConfig,
  TmuxSessionInfo,
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
 * Escapes a string for safe use in tmux send-keys literal mode.
 * Even in literal mode (-l), some characters need escaping when the
 * entire string is embedded in a shell command passed to tmux.
 */
function escapeSendKeys(keys: string): string {
  return (
    keys
      // Backslash must come first
      .replace(/\\/g, '\\\\')
      // Single quotes break the shell quoting around the tmux command
      .replace(/'/g, "'\\''")
      // Dollar signs could be interpolated by the shell wrapping the tmux call
      .replace(/\$/g, '\\$')
      // Backticks trigger command substitution in some shells
      .replace(/`/g, '\\`')
  );
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

export class TmuxSessionManager {
  private readonly maxConcurrentSessions: number;

  constructor(private readonly deps: { exec: ExecFn; maxConcurrentSessions?: number }) {
    this.maxConcurrentSessions = deps.maxConcurrentSessions ?? MAX_CONCURRENT_SESSIONS;
  }

  /**
   * Creates a new detached tmux session.
   * Validates the session name, enforces the concurrent-session limit,
   * spawns the session, then injects any requested environment variables.
   */
  createSession(config: TmuxSessionConfig): Result<TmuxHandle, AutobeatError> {
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
    const cwdFlag = config.cwd ? ` -c '${config.cwd.replace(/'/g, "'\\''")}'` : '';

    const spawnResult = this.deps.exec(
      `tmux new-session -d -s ${config.name} -x ${width} -y ${height}${cwdFlag} '${escapeSendKeys(config.command)}'`,
    );

    if (spawnResult.status !== 0) {
      return err(
        tmuxSessionFailed('create', spawnResult.stderr || spawnResult.stdout, {
          sessionName: config.name,
          exitStatus: spawnResult.status,
        }),
      );
    }

    // Auto-inject task identity variables so workers can identify their session
    const taskId = config.name.replace(/^beat-/, '');
    const spawnTime = new Date().toISOString();
    const autoVars: Record<string, string> = {
      AUTOBEAT_TASK_ID: taskId,
      AUTOBEAT_SPAWN_TIME: spawnTime,
    };

    // Inject caller-provided env vars, then the auto vars (auto vars win on conflict)
    const allEnv: Record<string, string> = { ...(config.env ?? {}), ...autoVars };
    for (const [key, value] of Object.entries(allEnv)) {
      // Validate env var key: must be alphanumeric + underscores (POSIX portable)
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      // Quote the value to prevent shell interpretation
      const quotedValue = `'${value.replace(/'/g, "'\\''")}'`;
      const envResult = this.deps.exec(`tmux set-environment -t ${config.name} ${key} ${quotedValue}`);
      if (envResult.status !== 0) {
        // Best-effort: session is created, log the failure but continue
        // The session itself succeeded — don't roll back for env var failures
      }
    }

    return ok({
      sessionName: config.name,
      taskId: config.name.replace(/^beat-/, ''),
      sessionsDir: '',
    });
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

    const escaped = escapeSendKeys(keys);
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

      sessions.push({
        name,
        created: parseInt(createdStr, 10),
        attached: attachedStr === '1',
        width: parseInt(widthStr, 10),
        height: parseInt(heightStr, 10),
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
