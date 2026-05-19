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
 * TmuxSessionConfig, TmuxSpawnConfig, TmuxAgentType, etc.) remain in
 * src/implementations/tmux/types.ts because they are implementation concerns.
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
}

/**
 * Port interface for the high-level managed session lifecycle.
 * TmuxConnector is the canonical implementation.
 *
 * DESIGN DECISION: Defined in core/tmux-types.ts in Phase 3 so that core-layer
 * consumers (EventDrivenWorkerPool) can depend on this interface without
 * importing from the implementations layer.
 *
 * spawn() uses `unknown` for config to avoid pulling TmuxSpawnConfig (which
 * depends on TmuxAgentType/TmuxSessionConfig from tmux/types.ts) into core.
 * The concrete TmuxConnector still enforces full typing internally. Callers in
 * the implementations layer import TmuxSpawnConfig from tmux/types.ts directly.
 */
export interface TmuxConnectorPort {
  // spawn config type is TmuxSpawnConfig from tmux/types.ts; kept as any here
  // to avoid pulling implementation details into the core layer.
  // ARCHITECTURE EXCEPTION: any config breaks the circular dependency.
  // biome-ignore lint/suspicious/noExplicitAny: circular dependency — TmuxSpawnConfig lives in implementations layer
  spawn(config: any, callbacks: SpawnCallbacks): Result<TmuxHandle, AutobeatError>;
  destroy(handle: TmuxHandle): Result<void, AutobeatError>;
  sendKeys(handle: TmuxHandle, keys: string): Result<void, AutobeatError>;
  /**
   * Send control key sequence (e.g. C-c) to a session WITHOUT -l (literal) mode.
   * Delegates to TmuxSessionManagerPort.sendControlKeys(handle.sessionName, keys).
   */
  sendControlKeys(handle: TmuxHandle, keys: string): Result<void, AutobeatError>;
  isAlive(handle: TmuxHandle): Result<boolean, AutobeatError>;
  getActiveHandles(): TmuxHandle[];
  dispose(): void;
}
