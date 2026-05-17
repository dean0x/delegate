/**
 * Types and constants for the tmux abstraction layer
 * Pure type definitions — no runtime logic
 */

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
  agent: 'claude' | 'codex';
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
  /** Session data root directory */
  sessionsDir: string;
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

import type { AutobeatError } from '../../core/errors.js';
import type { Result } from '../../core/result.js';

/**
 * Interface for session lifecycle operations.
 * DefaultTmuxSessionManager is the canonical implementation; alternative
 * implementations (test doubles, future adapters) only need to implement these methods.
 */
export interface TmuxSessionManager {
  createSession(config: TmuxSessionConfig): Result<TmuxHandle, AutobeatError>;
  destroySession(name: string): Result<void, AutobeatError>;
  sendKeys(name: string, keys: string): Result<void, AutobeatError>;
  isAlive(name: string): Result<boolean, AutobeatError>;
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

// ─── Constants ────────────────────────────────────────────────────────────────

/** All Autobeat-managed tmux sessions carry this prefix */
export const SESSION_NAME_PREFIX = 'beat-' as const;

/** Regex that valid session names must match */
export const SESSION_NAME_REGEX = /^beat-[a-z0-9-]+$/;

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
