/**
 * Types and constants for the tmux abstraction layer
 * Pure type definitions — no runtime logic
 *
 * DESIGN DECISION: Naming convention — types re-exported for external consumers
 * (TmuxHandle, TmuxSessionConfig, TmuxSpawnConfig, TmuxSessionInfo, TmuxInfo,
 * TmuxConnectorPort) carry the "Tmux" prefix to avoid collision at call sites.
 * Internal or self-documenting types (OutputMessage, CommunicationMode,
 * StalenessConfig, WrapperConfig, WrapperManifest, SpawnCallbacks) do not carry
 * the prefix because they are unambiguous in context and live behind the barrel
 * re-export in index.ts. Do not add the prefix to internal types retroactively.
 */

import type { AgentProvider } from '../../core/agents.js';
import type { TaskId } from '../../core/domain.js';
import type { AutobeatError } from '../../core/errors.js';
import type { Result } from '../../core/result.js';
// Phase 3: Import consumer-facing types from core/tmux-types.ts so they are
// available within this module (e.g. TmuxHandle in TmuxSessionResult).
// These are also re-exported below for backward compat with external consumers.
import type { OutputMessage, SpawnCallbacks, TmuxHandle } from '../../core/tmux-types.js';

export type {
  OutputMessage,
  SpawnCallbacks,
  TmuxConnectorPort,
  TmuxHandle,
  TmuxSessionManagerCorePort,
} from '../../core/tmux-types.js';

/**
 * Agent types supported by the tmux abstraction layer.
 */
export type TmuxAgentType = Extract<AgentProvider, 'claude' | 'codex'>;

// ─── Session configuration ───────────────────────────────────────────────────

/**
 * Base session configuration for creating a tmux session
 */
export interface TmuxSessionConfig {
  /** Session name — must match SESSION_NAME_REGEX (beat-* prefix) */
  readonly name: string;
  /** Command to run inside the session */
  readonly command: string;
  /** Working directory for the session (optional — omit to use tmux default) */
  readonly cwd?: string;
  /** Optional environment variables to inject */
  readonly env?: Record<string, string>;
  /** Terminal width in columns (default: 220) */
  readonly width?: number;
  /** Terminal height in rows (default: 50) */
  readonly height?: number;
}

/**
 * Extended configuration for spawning a managed agent session
 */
export interface TmuxSpawnConfig extends TmuxSessionConfig {
  /** Task identifier — used to name the session directory */
  readonly taskId: TaskId;
  /** Base directory where all session data lives */
  readonly sessionsDir: string;
  /** Agent type to wrap — must match a supported WrapperConfig agent value */
  readonly agent: TmuxAgentType;
  /** CLI arguments to pass to the agent (populated by adapter's buildTmuxArgs) */
  readonly agentArgs: readonly string[];
  /** Staleness detection configuration */
  readonly staleness?: Partial<StalenessConfig>;
}

// TmuxHandle is now defined in core/tmux-types.ts and re-exported above.

/**
 * Result of TmuxSessionManager.createSession().
 * Only carries the tmux session name — sessionsDir and taskId are higher-level
 * concerns owned by TmuxConnector/TmuxSpawnConfig and are not re-derived here.
 */
export type TmuxSessionResult = Pick<TmuxHandle, 'sessionName'>;

// ─── Output & messaging ───────────────────────────────────────────────────────

// OutputMessage is now defined in core/tmux-types.ts and re-exported above.

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
  readonly taskId: TaskId;
  /** Agent type being wrapped */
  readonly agent: TmuxAgentType;
  /** Base directory for session data */
  readonly sessionsDir: string;
  /** Agent executable path or name */
  readonly agentCommand: string;
  /** Arguments to pass to the agent */
  readonly agentArgs: readonly string[];
  /** tmux session names to forward output to */
  readonly communicationTargets?: readonly string[];
  /** How to deliver messages to targets */
  readonly communicationMode?: CommunicationMode;
  /** Return address session name for result routing */
  readonly returnAddress?: string;
}

/**
 * Paths to all artifacts produced by generateWrapper()
 */
export interface WrapperManifest {
  /** Path to the generated wrapper shell script */
  readonly wrapperPath: string;
  /** Task-specific session directory (sessionsDir/taskId) */
  readonly sessionDir: string;
  /** Path to the completion sentinel file (.done or .exit) */
  readonly sentinelPath: string;
  /** Directory where output JSON messages are written */
  readonly messagesDir: string;
  /** Path to the atomic sequence-number file */
  readonly seqFilePath: string;
}

// ─── Session info ─────────────────────────────────────────────────────────────

/**
 * Information about a running tmux session
 */
export interface TmuxSessionInfo {
  /** Session name */
  readonly name: string;
  /** Unix timestamp when the session was created */
  readonly created: number;
  /** Whether a client is currently attached */
  readonly attached: boolean;
  /** Terminal width in columns */
  readonly width: number;
  /** Terminal height in rows */
  readonly height: number;
}

/**
 * Information about the tmux installation
 */
export interface TmuxInfo {
  /** Parsed version string (e.g. "3.4") */
  readonly version: string;
  /** Path to the tmux binary */
  readonly path: string;
  /** Path to the jq binary (required for JSON escaping in wrapper scripts) */
  readonly jqPath: string;
}

// ─── Staleness detection ──────────────────────────────────────────────────────

/**
 * Configuration for staleness (crashed agent) detection
 */
export interface StalenessConfig {
  /** How often to poll for staleness (ms) */
  readonly checkIntervalMs: number;
  /** Max silence before marking the session stale (ms) */
  readonly maxSilenceMs: number;
}

// ─── Dependency injection ─────────────────────────────────────────────────────

/**
 * Result of executing a shell command
 * Used for dependency injection in tests
 */
export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number;
}

/**
 * Injectable exec function signature
 * Synchronous — wraps spawnSync or equivalent
 */
export type ExecFn = (cmd: string) => ExecResult;

/**
 * Injectable fs.watch function signature.
 * Structural definition matches the Node.js fs.watch overload used by TmuxConnector:
 * watch(path, options, listener) → FSWatcher.
 * Defined structurally (like ExecFn) so tests can pass any compatible mock without
 * importing the real fs module.
 */
export type WatchFn = (
  path: string,
  options: { persistent: boolean },
  listener: (eventType: string, filename: string | null) => void,
) => {
  close(): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
};

// ─── Dependency interfaces ────────────────────────────────────────────────────

/**
 * Port interface for session lifecycle operations.
 * TmuxSessionManager is the canonical implementation; alternative
 * implementations (test doubles, future adapters) only need to implement these methods.
 */
export interface TmuxSessionManagerPort {
  createSession(config: TmuxSessionConfig): Result<TmuxSessionResult, AutobeatError>;
  destroySession(name: string): Result<void, AutobeatError>;
  sendKeys(name: string, keys: string): Result<void, AutobeatError>;
  /**
   * Send control key sequence (e.g. C-c) to a session WITHOUT -l (literal) mode.
   * Implementation: tmux send-keys -t '<name>' <keys>  (no -l flag)
   * DECISION: Separate method from sendKeys to make the no-literal-mode intent explicit
   * at every call site. Passing C-c via sendKeys would send the literal string "C-c"
   * rather than triggering Ctrl+C (SIGINT).
   */
  sendControlKeys(name: string, keys: string): Result<void, AutobeatError>;
  isAlive(name: string): Result<boolean, AutobeatError>;
  /** List all running beat-* tmux sessions. Used by the connector's staleness timer and admission control. */
  listSessions(): Result<TmuxSessionInfo[], AutobeatError>;
  /** Read the value of a named environment variable from a running tmux session. */
  getSessionEnvironment(name: string, varName: string): Result<string | undefined, AutobeatError>;
}

/**
 * Port interface for wrapper script generation and session directory lifecycle.
 * TmuxHooks is the canonical implementation.
 */
export interface TmuxHooksPort {
  generateWrapper(config: WrapperConfig): Result<WrapperManifest, AutobeatError>;
  cleanup(taskId: TaskId, sessionsDir: string): Result<void, AutobeatError>;
}

/**
 * Port interface for tmux installation validation.
 * TmuxValidator is the canonical implementation.
 */
export interface TmuxValidatorPort {
  validate(): Result<TmuxInfo, AutobeatError>;
}

// SpawnCallbacks is now defined in core/tmux-types.ts and re-exported above.

// TmuxConnectorPort is now defined in core/tmux-types.ts and re-exported above.
// The re-exported TmuxConnectorPort.spawn() accepts `any` config to break the
// circular dependency. The concrete TmuxConnector still enforces full typing
// internally via its own spawn(config: TmuxSpawnConfig, ...) signature.

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
 * forward slashes, hyphens, underscores, dots, and spaces. Spaces are included
 * because macOS paths commonly contain them (e.g. /Users/Jane Doe/Projects) and
 * all path embeddings use singleQuoteToken()/escapeForSingleQuotes(), which make
 * spaces safe inside single quotes. No single quotes or other shell metacharacters
 * are permitted. The negative lookahead rejects path traversal sequences
 * (e.g. /tmp/../etc/passwd) that the character class alone cannot prevent.
 */
export const SAFE_PATH_REGEX = /^(?!.*\.\.)([a-zA-Z0-9/_.\ \-]+)$/;

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
