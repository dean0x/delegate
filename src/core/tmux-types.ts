/**
 * Consumer-facing tmux port interfaces
 *
 * DESIGN DECISION (Phase 3): Port interfaces needed by core-layer consumers
 * (EventDrivenWorkerPool, RecoveryManager) are defined here so that core-layer
 * modules have a stable contract without importing from the implementations layer.
 *
 * src/implementations/tmux/types.ts imports these types from here and re-exports
 * them so that existing callers that import from tmux/types.ts continue to work.
 *
 * Internal types (WrapperConfig, WrapperManifest, StalenessConfig, ExecFn, WatchFn,
 * TmuxSessionConfig, TmuxAgentType, etc.) remain in src/implementations/tmux/types.ts
 * because they are implementation concerns. TmuxSpawnConfig extends TmuxSpawnCoreConfig
 * defined here — that extension is the only coupling point.
 */

import type { TaskId } from './domain.js';
import type { AutobeatError } from './errors.js';
import type { Result } from './result.js';

// ─── Handle ───────────────────────────────────────────────────────────────────

/**
 * Handle to a live tmux session.
 * Returned from TmuxConnectorPort.spawn(); passed back to destroy/sendKeys/isAlive.
 */
export interface TmuxHandle {
  /** Full session name (e.g. "beat-task-abc123") */
  readonly sessionName: string;
  /** Task ID that owns this session */
  readonly taskId: TaskId;
  /** Base directory where session data (sentinel, messages) lives */
  readonly sessionsDir: string;
}

// ─── Output message ───────────────────────────────────────────────────────────

/**
 * A single output message written by the wrapper script.
 */
export interface OutputMessage {
  readonly sequence: number;
  readonly timestamp: string;
  readonly type: 'stdout' | 'stderr' | 'result';
  readonly content: string;
}

// ─── Callbacks ────────────────────────────────────────────────────────────────

/**
 * Callbacks passed to TmuxConnectorPort.spawn() for push-based event delivery.
 */
export interface SpawnCallbacks {
  onOutput: (msg: OutputMessage) => void;
  onExit: (code: number | null, signal?: string) => void;
}

// ─── Spawn config ─────────────────────────────────────────────────────────────

/**
 * Minimal spawn configuration for the TmuxConnectorPort interface.
 *
 * DESIGN DECISION: Defined here (core layer) to break the circular dependency
 * between core/agents.ts (AgentAdapter.buildTmuxCommand return type) and
 * src/implementations/tmux/types.ts (TmuxSpawnConfig). Only the fields needed
 * at the port boundary are declared here. Implementation-layer TmuxSpawnConfig
 * extends this interface and adds agent-specific fields (TmuxAgentType, staleness,
 * etc.) that are not implementation concerns of the core layer.
 *
 * Core-layer consumers (EventDrivenWorkerPool) treat this type opaquely — they
 * receive it from AgentAdapter.buildTmuxCommand() and pass it directly to
 * TmuxConnectorPort.spawn() without accessing individual fields.
 */
export interface TmuxSpawnCoreConfig {
  /** Task identifier — used to name the session directory and tmux session */
  readonly taskId: TaskId;
  /** Base directory where all session data lives */
  readonly sessionsDir: string;
  /** Session name — must match SESSION_NAME_REGEX (beat-* prefix) */
  readonly name: string;
  /** Command to run inside the session */
  readonly command: string;
  /** CLI arguments to pass to the agent */
  readonly agentArgs: readonly string[];
  /**
   * Optional environment variables to inject into the session.
   * buildTmuxCommand() populates this (e.g. AUTOBEAT_WORKER=true).
   * Callers that need to strip or override variables (e.g. interactive
   * orchestrator removing AUTOBEAT_WORKER) can spread and override this field.
   */
  readonly env?: Record<string, string>;
  /**
   * Persistent session mode (Phase 5).
   * When true: agent runs interactively (no --print), output captured via Stop hook,
   * completion detected via per-iteration sentinel files. Used for loop iteration reuse.
   * When false/absent: existing --print + wrapper pipeline mode.
   */
  readonly persistent?: boolean;
}

// ─── Port interfaces ──────────────────────────────────────────────────────────

/**
 * Minimal session manager port for RecoveryManager (Phase 3).
 * Only the methods needed by core-layer consumers are exposed here.
 * The full TmuxSessionManagerPort (with createSession, destroySession, etc.)
 * remains in src/implementations/tmux/types.ts for the tmux package internals.
 */
export interface TmuxSessionManagerCorePort {
  isAlive(name: string): Result<boolean, AutobeatError>;
  /**
   * Send control key sequence (e.g. C-c) to a session WITHOUT -l (literal) mode.
   * Implementation: tmux send-keys -t '<name>' <keys>  (no -l flag)
   */
  sendControlKeys(name: string, keys: string): Result<void, AutobeatError>;
  /**
   * List all active tmux sessions. Used by RecoveryManager to batch liveness
   * checks at startup — one exec call instead of N sequential has-session calls.
   * Returns an array of objects with at least `name` and `created` (Unix epoch seconds)
   * fields; on error (e.g. no tmux server running) returns an empty array rather than
   * propagating the error so callers can treat the empty result as "no live sessions".
   *
   * The `created` field is used by orphan cleanup to apply a grace period: sessions
   * younger than ORPHAN_GRACE_PERIOD_MS are not destroyed, preventing TOCTOU races
   * where a worker just spawned between listSessions() and findAll().
   */
  listSessions(): Result<ReadonlyArray<{ readonly name: string; readonly created: number }>, AutobeatError>;
  /**
   * Destroy a tmux session by name.
   * Used by RecoveryManager orphan cleanup and graceful shutdown session sweep.
   * Treated as idempotent — no error if the session does not exist.
   */
  destroySession(name: string): Result<void, AutobeatError>;
  /**
   * Capture the visible pane content of a tmux session.
   * Implementation: `tmux capture-pane -t '{name}' -p -S -{lines}`
   *
   * ARCHITECTURE (Phase 9 Dashboard): Display-only method for live pane preview
   * in the channel detail view. No business logic depends on the captured content.
   *
   * Session validation: name must match SESSION_NAME_REGEX.
   * "Session not found" is treated as empty string (ok('')) rather than an error —
   * the session may have exited between the liveness check and this call.
   *
   * @param name - Tmux session name (must match SESSION_NAME_REGEX)
   * @param lines - Number of lines to capture from the bottom (default: 10)
   */
  capturePaneContent(name: string, lines?: number): Result<string, AutobeatError>;
}

/**
 * Port interface for the high-level managed session lifecycle.
 * TmuxConnector is the canonical implementation.
 *
 * DESIGN DECISION: Defined in core/tmux-types.ts in Phase 3 so that core-layer
 * consumers (EventDrivenWorkerPool) can depend on this interface without
 * importing from the implementations layer.
 *
 * spawn() accepts TmuxSpawnCoreConfig — the minimal core-layer type. The concrete
 * TmuxConnector casts it to the richer TmuxSpawnConfig (which extends TmuxSpawnCoreConfig)
 * at the implementation boundary, where the full field set is needed to configure
 * the tmux session and wrapper script.
 */
export interface TmuxConnectorPort {
  spawn(config: TmuxSpawnCoreConfig, callbacks: SpawnCallbacks): Result<TmuxHandle, AutobeatError>;
  destroy(handle: TmuxHandle): Result<void, AutobeatError>;
  sendKeys(handle: TmuxHandle, keys: string): Result<void, AutobeatError>;
  /**
   * Send control key sequence (e.g. C-c) to a session WITHOUT -l (literal) mode.
   * Delegates to TmuxSessionManagerPort.sendControlKeys(handle.sessionName, keys).
   */
  sendControlKeys(handle: TmuxHandle, keys: string): Result<void, AutobeatError>;
  isAlive(handle: TmuxHandle): Result<boolean, AutobeatError>;
  /**
   * Set a named environment variable in a running tmux session.
   * Used by WorkerPool for persistent session reuse — updates AUTOBEAT_TASK_ID
   * so the Stop hook attributes output to the new iteration's task ID.
   * Implementation: `tmux set-environment -t <sessionName> <varName> <value>`
   */
  setEnvironment(handle: TmuxHandle, varName: string, value: string): Result<void, AutobeatError>;
  /**
   * Delivers content to a tmux session using load-buffer / paste-buffer pattern.
   * Writes content to a named buffer to avoid shell expansion on special characters
   * (unlike sendKeys, which shells out with quoting that can still expand metacharacters).
   *
   * Flow: load-buffer -b beat-channel < content → paste-buffer -b beat-channel -t session → delete-buffer -b beat-channel
   *
   * DESIGN DECISION (Phase 7): Channel members receive multi-line agent output via
   * paste-buffer rather than send-keys to guarantee literal delivery regardless of
   * shell metacharacters ($, `, \n, etc.) in the content.
   */
  pasteContent(handle: TmuxHandle, content: string): Result<void, AutobeatError>;
  /**
   * Prepare a parked persistent session for reuse by the next loop iteration.
   *
   * DESIGN DECISION (Phase B): Encapsulates all connector-internal reuse steps behind
   * a single port method so WorkerPool does not need to know about task directories,
   * sequence counters, or watcher lifecycle. The port boundary stays thin.
   *
   * Steps:
   * 1. Create new task directory (sessionsDir/newTaskId/messages/) and reset .seq to 0
   * 2. Register a new ActiveSession with state 'active' for newTaskId
   * 3. Start new sentinel + messages watchers for the new directory
   * 4. Restart the staleness timer
   *
   * Must be called AFTER setEnvironment(AUTOBEAT_TASK_ID) and the /clear settle delay,
   * and BEFORE sendKeys(prompt) so watchers are ready before any output arrives.
   *
   * Returns err() if the task directory cannot be created.
   */
  prepareForReuse(handle: TmuxHandle, newTaskId: TaskId, callbacks: SpawnCallbacks): Result<void, AutobeatError>;
  getActiveHandles(): TmuxHandle[];
  dispose(): void;
}
