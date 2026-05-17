/**
 * tmux abstraction layer — public API
 *
 * Provides foundational tmux session management, wrapper script generation,
 * and push-based completion detection for the v1.6.0 worker migration.
 */

// Implementations
export type { SpawnCallbacks, TmuxConnectorDeps } from './tmux-connector.js';
export { TmuxConnector } from './tmux-connector.js';
export type { TmuxHooksDeps } from './tmux-hooks.js';
export { DefaultTmuxHooks } from './tmux-hooks.js';
export { DefaultTmuxSessionManager } from './tmux-session-manager.js';
export { DefaultTmuxValidator } from './tmux-validator.js';
// Types (type-only re-exports to avoid unnecessary runtime imports)
export type {
  CommunicationMode,
  ExecFn,
  ExecResult,
  OutputMessage,
  StalenessConfig,
  TmuxHandle,
  TmuxHooks,
  TmuxInfo,
  TmuxSessionConfig,
  TmuxSessionInfo,
  TmuxSessionManager,
  TmuxSpawnConfig,
  TmuxValidator,
  WrapperConfig,
  WrapperManifest,
} from './types.js';
// Constants
export {
  DEFAULT_STALENESS_CONFIG,
  MAX_CONCURRENT_SESSIONS,
  SENTINEL_DONE,
  SENTINEL_EXIT,
  SESSION_NAME_PREFIX,
  SESSION_NAME_REGEX,
} from './types.js';
