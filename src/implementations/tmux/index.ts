/**
 * tmux abstraction layer — public API
 *
 * Provides foundational tmux session management, wrapper script generation,
 * and push-based completion detection for the v1.6.0 worker migration.
 */

// Implementations
export type { TmuxConnectorDeps } from './tmux-connector.js';
export { TmuxConnector } from './tmux-connector.js';
export type { TmuxHooksDeps } from './tmux-hooks.js';
export { TmuxHooks } from './tmux-hooks.js';
export type { TmuxSessionManagerDeps } from './tmux-session-manager.js';
export { TmuxSessionManager } from './tmux-session-manager.js';
// Shell utilities
export { escapeForSingleQuotes, singleQuoteToken } from './tmux-shell-utils.js';
export type { TmuxValidatorDeps } from './tmux-validator.js';
export { TmuxValidator } from './tmux-validator.js';
// Types (type-only re-exports to avoid unnecessary runtime imports)
export type {
  CommunicationMode,
  ExecFn,
  ExecResult,
  OutputMessage,
  SpawnCallbacks,
  StalenessConfig,
  TmuxAgentType,
  TmuxConnectorPort,
  TmuxHandle,
  TmuxHooksPort,
  TmuxInfo,
  TmuxSessionConfig,
  TmuxSessionInfo,
  TmuxSessionManagerPort,
  TmuxSessionResult,
  TmuxSpawnConfig,
  TmuxValidatorPort,
  WatchFn,
  WrapperConfig,
  WrapperManifest,
} from './types.js';
// Constants
export {
  DEFAULT_STALENESS_CONFIG,
  MAX_CONCURRENT_SESSIONS,
  SAFE_PATH_REGEX,
  SENTINEL_DONE,
  SENTINEL_EXIT,
  SESSION_NAME_PREFIX,
  SESSION_NAME_REGEX,
  TASK_ID_REGEX,
} from './types.js';
