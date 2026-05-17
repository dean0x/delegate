/**
 * Types and constants for the tmux abstraction layer
 * Pure type definitions — no runtime logic
 */

import type { AgentProvider } from '../../core/agents.js';
import type { AutobeatError } from '../../core/errors.js';
import type { Result } from '../../core/result.js';

/**
 * Agent types supported by the tmux abstraction layer.
 * Gemini is excluded because it does not have a tmux wrapper implementation.
 */
export type TmuxAgentType = Extract<AgentProvider, 'claude' | 'codex'>;

// ─── Session configuration ───────────────────────────────────────────────────

/**
 * Base session configuration for creating a tmux session
 */
export interface TmuxSessionConfig {
  /** Session name — must match SESSION_NAME_REGEX (beat-* prefix) */
  name: string;
  /** Command to run inside the session */
  command: string;
  /** Working directory for the session (optional — omit to use tmux default) */
  cwd?: string;
  /** Optional environment variables to inject */
  env?: Record<string, string>;
  /** Terminal width in columns (default: 220) */
  width?: number;
  /** Terminal height in rows (default: 50) */
  height?: number;
}

/**
 * Extended configuration for spawning a managed agent session
 */
export interface TmuxSpawnConfig extends TmuxSessionConfig {
  /** Task identifier — used to name the session directory */
  taskId: string;
  /** Base directory where all session data lives */
  sessionsDir: string;
  /** Agent type to wrap — must match a supported WrapperConfig agent value */
  agent: TmuxAgentType;
  /** Staleness detection configuration */
  staleness?: Partial<StalenessConfig>;
}

/**
 * Handle to a live tmux session
 * Returned from spawn(); passed back to destroy/sendKeys/isAlive
 */
export interface TmuxHandle {
  /** Full session name (e.g. "beat-task-abc123") */
  sessionName: string;
  /** Task ID that owns this session */
  taskId: string;
  /** Base directory where session data (sentinel, messages) lives */
  sessionsDir: string;
}

/**
 * Result of TmuxSessionManager.createSession() — omits sessionsDir because
 * the session manager doesn't know the sessions directory (it's a higher-level
 * concern owned by TmuxConnector/TmuxSpawnConfig).
 */
export type TmuxSessionResult = Omit<TmuxHandle, 'sessionsDir'>;

// ─── Output & messaging ───────────────────────────────────────────────────────

/**
 * A single output message written by the wrapper script
 */
export interface OutputMessage {
  /** Monotonically increasing sequence number */
  sequence: number;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Message type */
  type: 'stdout' | 'stderr' | 'result';
  /** Message content */
  content: string;
}

// ─── Wrapper script ───────────────────────────────────────────────────────────

/**
 * Communication mode for wrapper-generated inter-session messages
 */
export type CommunicationMode = 'unicast' | 'broadcast';

/**
 * Configuration for generating a wrapper script around an agent invocation
 */
export interface WrapperConfig {
  /** Task identifier */
  taskId: string;
  /** Agent type being wrapped */
  agent: TmuxAgentType;
  /** Base directory for session data */
  sessionsDir: string;
  /** Agent executable path or name */
  agentCommand: string;
  /** Arguments to pass to the agent */
  agentArgs: string[];
  /** tmux session names to forward output to */
  communicationTargets?: string[];
  /** How to deliver messages to targets */
  communicationMode?: CommunicationMode;
  /** Return address session name for result routing */
  returnAddress?: string;
}

/**
 * Paths to all artifacts produced by generateWrapper()
 */
export interface WrapperManifest {
  /** Path to the generated wrapper shell script */
  wrapperPath: string;
  /** Task-specific session directory (sessionsDir/taskId) */
  sessionDir: string;
  /** Path to the completion sentinel file (.done or .exit) */
  sentinelPath: string;
  /** Directory where output JSON messages are written */
  messagesDir: string;
  /** Path to the atomic sequence-number file */
  seqFilePath: string;
}

// ─── Session info ─────────────────────────────────────────────────────────────

/**
 * Information about a running tmux session
 */
export interface TmuxSessionInfo {
  /** Session name */
  name: string;
  /** Unix timestamp when the session was created */
  created: number;
  /** Whether a client is currently attached */
  attached: boolean;
  /** Terminal width in columns */
  width: number;
  /** Terminal height in rows */
  height: number;
}

/**
 * Information about the tmux installation
 */
export interface TmuxInfo {
  /** Parsed version string (e.g. "3.4") */
  version: string;
  /** Path to the tmux binary */
  path: string;
  /** Path to the jq binary (required for JSON escaping in wrapper scripts) */
  jqPath: string;
}

// ─── Staleness detection ──────────────────────────────────────────────────────

/**
 * Configuration for staleness (crashed agent) detection
 */
export interface StalenessConfig {
  /** How often to poll for staleness (ms) */
  checkIntervalMs: number;
  /** Max silence before marking the session stale (ms) */
  maxSilenceMs: number;
}

// ─── Dependency injection ─────────────────────────────────────────────────────

/**
 * Result of executing a shell command
 * Used for dependency injection in tests
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  status: number;
}

/**
 * Injectable exec function signature
 * Synchronous — wraps spawnSync or equivalent
 */
export type ExecFn = (cmd: string) => ExecResult;

// ─── Dependency interfaces ────────────────────────────────────────────────────

/**
 * Interface for session lifecycle operations.
 * DefaultTmuxSessionManager is the canonical implementation; alternative
 * implementations (test doubles, future adapters) only need to implement these methods.
 */
export interface TmuxSessionManager {
  createSession(config: TmuxSessionConfig): Result<TmuxSessionResult, AutobeatError>;
  destroySession(name: string): Result<void, AutobeatError>;
  sendKeys(name: string, keys: string): Result<void, AutobeatError>;
  isAlive(name: string): Result<boolean, AutobeatError>;
  /** List all running beat-* tmux sessions. Used by the connector's staleness timer and admission control. */
  listSessions(): Result<TmuxSessionInfo[], AutobeatError>;
  /** Read the value of a named environment variable from a running tmux session. */
  getSessionEnvironment(name: string, varName: string): Result<string | undefined, AutobeatError>;
}

/**
 * Interface for wrapper script generation and session directory lifecycle.
 * DefaultTmuxHooks is the canonical implementation.
 */
export interface TmuxHooks {
  generateWrapper(config: WrapperConfig): Result<WrapperManifest, AutobeatError>;
  cleanup(taskId: string, sessionsDir: string): Result<void, AutobeatError>;
}

/**
 * Interface for tmux installation validation.
 * DefaultTmuxValidator is the canonical implementation.
 */
export interface TmuxValidator {
  validate(): Result<TmuxInfo, AutobeatError>;
}

/**
 * Callbacks passed to TmuxConnectorPort.spawn() for push-based event delivery.
 * onOutput fires for each ordered OutputMessage; onExit fires once when the
 * agent process terminates (or is declared stale/shut down).
 */
export interface SpawnCallbacks {
  onOutput: (msg: OutputMessage) => void;
  onExit: (code: number | null, signal?: string) => void;
}

/**
 * Port interface for the high-level managed session lifecycle.
 * TmuxConnector is the canonical implementation; alternative implementations
 * (test doubles, future adapters) only need to implement these methods.
 *
 * DESIGN DECISION: TmuxConnectorPort is kept narrow — it exposes only the
 * methods that consumers outside the tmux package need. Internal helpers
 * (buildActiveSession, startWatchers, etc.) remain in TmuxConnector.
 */
export interface TmuxConnectorPort {
  spawn(config: TmuxSpawnConfig, callbacks: SpawnCallbacks): Result<TmuxHandle, AutobeatError>;
  destroy(handle: TmuxHandle): Result<void, AutobeatError>;
  sendKeys(handle: TmuxHandle, keys: string): Result<void, AutobeatError>;
  isAlive(handle: TmuxHandle): Result<boolean, AutobeatError>;
  getActiveHandles(): TmuxHandle[];
  dispose(): void;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** All Autobeat-managed tmux sessions carry this prefix */
export const SESSION_NAME_PREFIX = 'beat-' as const;

/** Regex that valid session names must match */
export const SESSION_NAME_REGEX = /^beat-[a-z0-9-]+$/;

/**
 * Regex that valid task IDs must match.
 * Task IDs are lowercase alphanumeric with hyphens/underscores (e.g. "task-<uuid>").
 * This prevents shell injection when the task ID is embedded in generated scripts.
 */
export const TASK_ID_REGEX = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Regex that validates a sessions base directory path is safe to embed in a
 * bash single-quoted string. The path may contain alphanumeric characters,
 * forward slashes, hyphens, underscores, and dots — no single quotes or other
 * shell metacharacters. The negative lookahead rejects path traversal sequences
 * (e.g. /tmp/../etc/passwd) that the character class alone cannot prevent.
 */
export const SAFE_PATH_REGEX = /^(?!.*\.\.)([a-zA-Z0-9/_.\-]+)$/;

/** Filename of the success sentinel (exit code 0) */
export const SENTINEL_DONE = '.done' as const;

/** Filename of the failure sentinel (exit code != 0) */
export const SENTINEL_EXIT = '.exit' as const;

/** Default staleness detection configuration */
export const DEFAULT_STALENESS_CONFIG: StalenessConfig = {
  checkIntervalMs: 30_000,
  maxSilenceMs: 60_000,
};

/** Maximum number of concurrent beat-* sessions allowed */
export const MAX_CONCURRENT_SESSIONS = 20;
