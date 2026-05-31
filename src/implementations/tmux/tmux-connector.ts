/**
 * TmuxConnector — high-level managed session lifecycle with push-based events
 *
 * DESIGN DECISION: Sentinel detection via fs.watch() is push-based (no polling).
 * A 50ms debounce window suppresses platform double-fire events. Message files
 * are delivered in sequence order regardless of fs.watch() arrival order.
 *
 * DESIGN DECISION: The watcher is created BEFORE the tmux session launches to
 * eliminate the race condition where the agent exits before the watcher is ready.
 *
 * DESIGN DECISION: Staleness detection uses a single shared setInterval that calls
 * listSessions() once per tick and checks all active sessions. This avoids O(N)
 * concurrent isAlive syscalls. The timer starts on first spawn and stops when
 * activeSessions empties. Per-session maxSilenceMs and lastAliveCheck remain
 * per-session for independent stale detection.
 */

import * as path from 'path';
import type { TaskId } from '../../core/domain.js';
import type { AutobeatError } from '../../core/errors.js';
import { tmuxSessionFailed } from '../../core/errors.js';
import type { Logger } from '../../core/interfaces.js';
import type { Result } from '../../core/result.js';
import { err, ok } from '../../core/result.js';
import type { SpawnCallbacks, TmuxSpawnCoreConfig } from '../../core/tmux-types.js';
import type {
  OutputMessage,
  SetupShimConfig,
  StalenessConfig,
  TmuxConnectorPort,
  TmuxHandle,
  TmuxHooksPort,
  TmuxSessionManagerPort,
  TmuxSpawnConfig,
  TmuxValidatorPort,
  WatchFn,
} from './types.js';
import { DEFAULT_STALENESS_CONFIG, MAX_CONCURRENT_SESSIONS } from './types.js';

/** Debounce window for suppressing fs.watch double-fires (ms) */
const DEBOUNCE_MS = 50;

/**
 * Maximum number of pending out-of-order messages before forcing delivery.
 *
 * DESIGN DECISION: The check in handleMessageFile fires AFTER inserting the
 * new message, so the map can transiently hold MAX_PENDING_MESSAGES + 1 entries
 * before the gap-skip fires. This one-entry overshoot is intentional — it avoids
 * a pre-insert size check that would require reading the same value twice and
 * keeps the hot-path code flat. Memory impact is bounded to one extra message.
 */
const MAX_PENDING_MESSAGES = 100;

/** Minimum allowed checkIntervalMs to prevent tight-loop setInterval */
const MIN_CHECK_INTERVAL_MS = 1000;

/** Valid literal values for OutputMessage.type */
const VALID_OUTPUT_TYPES = new Set<string>(['stdout', 'stderr', 'result']);

/**
 * Type guard for OutputMessage. Validates all required fields including the
 * 'type' literal union so that the unsafe `as OutputMessage` cast is safe.
 */
function isOutputMessage(value: unknown): value is OutputMessage {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.sequence === 'number' &&
    typeof v.timestamp === 'string' &&
    typeof v.type === 'string' &&
    VALID_OUTPUT_TYPES.has(v.type) &&
    typeof v.content === 'string'
  );
}

export interface TmuxConnectorDeps {
  sessionManager: TmuxSessionManagerPort;
  hooks: TmuxHooksPort;
  validator: TmuxValidatorPort;
  logger: Logger;
  watch: WatchFn;
  /** Sync file read — used for sentinel and flush paths (one-shot, sync) */
  readFileSync: (path: string, encoding: BufferEncoding) => string;
  /** Async file read — used for the hot-path message handler (non-blocking) */
  readFile: (path: string, encoding: BufferEncoding) => Promise<string>;
  /** Sync directory listing — used for flush path */
  readdirSync: (dirPath: string) => string[];
}

/**
 * Lifecycle state for a managed session.
 *
 * DESIGN DECISION (Phase B): Replaces the boolean `exited` field to support the
 * three-state lifecycle needed for persistent session reuse.
 *
 * - 'active': session running, watchers active, processing output
 * - 'parked': iteration complete, tmux session alive, watchers closed, awaiting reuse.
 *   The session directory has been preserved; a new one will be created for the next
 *   iteration. The staleness timer skips parked sessions — they are intentionally idle.
 * - 'exited': session destroyed, fully cleaned up (terminal state)
 */
type SessionState = 'active' | 'parked' | 'exited';

/**
 * Internal state for a single managed session
 */
interface ActiveSession {
  handle: TmuxHandle;
  sentinelWatcher: ReturnType<WatchFn> | null;
  messagesWatcher: ReturnType<WatchFn> | null;
  /** Per-session staleness config — used by the shared staleness timer */
  stalenessConfig: StalenessConfig;
  /** Timestamp of last confirmed-alive check — used for maxSilenceMs threshold */
  lastAliveCheck: number;
  /**
   * Current session state. Replaces the boolean `exited` field (Phase B).
   * Guards in handleMessageFile, onMessageFileChange, and triggerExit check
   * state !== 'active' to avoid processing output after exit/park.
   */
  state: SessionState;
  /** Watermark: highest sequence number successfully delivered (monotonic) */
  lastDeliveredSeq: number;
  /** Pending messages waiting for gap-filling (sequence ordering) */
  pendingMessages: Map<number, OutputMessage>;
  /** Next expected sequence number */
  nextExpectedSeq: number;
  /** Debounce timers keyed by filename */
  debounceTimers: Map<string, ReturnType<typeof setTimeout>>;
  /** Path to the messages directory for disk-based flush */
  messagesDir: string;
  /** Path to the session root directory (parent of messages/) — used by sentinel watcher */
  sessionDir: string;
  /**
   * Whether this session was spawned in persistent (interactive REPL) mode.
   * When true, triggerExit() parks rather than destroys — the tmux session
   * stays alive for the next loop iteration.
   */
  persistent: boolean;
  /** Stored callbacks for flush-on-destroy/dispose */
  callbacks: SpawnCallbacks;
  /** Re-entrancy guard for flushPendingFiles */
  flushing: boolean;
}

export class TmuxConnector implements TmuxConnectorPort {
  private readonly activeSessions = new Map<TaskId, ActiveSession>();
  /** Shared staleness timer — started on first spawn, stopped when activeSessions empties */
  private sharedStalenessTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * The interval (ms) the current sharedStalenessTimer was started with.
   * Used to skip unnecessary teardown/recreate when the minimum checkIntervalMs
   * across all active sessions has not changed — avoids O(N) timer churn during
   * batch spawn (e.g. a pipeline launching 10 tasks back-to-back).
   */
  private currentTimerIntervalMs: number | null = null;

  constructor(private readonly deps: TmuxConnectorDeps) {}

  /**
   * Spawns a new managed tmux session.
   * 1. Validates tmux availability
   * 2. Generates the wrapper script (or setup shim for persistent mode)
   * 3. Starts fs.watch watchers (BEFORE session launch to avoid race)
   * 4. Creates the tmux session running the wrapper
   * 5. Starts (or restarts) the shared staleness timer
   *
   * DESIGN DECISION (Phase 5): When rawConfig.persistent=true, a setup shim is used
   * instead of the wrapper pipeline. The agent runs as an interactive REPL — no --print,
   * no piping. Output is captured via the Stop hook; completion via per-iteration sentinels.
   * The session remains alive across iterations; WorkerPool manages reuse.
   */
  spawn(rawConfig: TmuxSpawnCoreConfig, callbacks: SpawnCallbacks): Result<TmuxHandle, AutobeatError> {
    // TmuxSpawnConfig extends TmuxSpawnCoreConfig (the port interface type) and adds
    // implementation-specific fields (agent, staleness, cwd, env). Cast here at the
    // implementation boundary where the full field set is needed.
    const config = rawConfig as TmuxSpawnConfig;

    // Guard: reject duplicate taskId to prevent orphaning the first session's watchers/timers
    if (this.activeSessions.has(config.taskId)) {
      return err(tmuxSessionFailed('spawn', `session for taskId '${config.taskId}' already exists`));
    }

    // DESIGN DECISION: Dual-gate session cap — connector (in-memory) + session-manager (tmux-level).
    // This check is the fast in-memory gate: it's O(1) and avoids the ~5-20ms exec cost of a
    // tmux list-sessions call on every spawn when the cap has already been reached. The
    // session-manager gate below is the authoritative tmux-level check and also guards against
    // crash-recovery scenarios where the connector's in-memory map was reset (e.g. process
    // restart) but tmux sessions are still alive. Both checks are necessary; neither alone
    // provides complete protection.
    if (this.activeSessions.size >= MAX_CONCURRENT_SESSIONS) {
      return err(tmuxSessionFailed('spawn', `connector session limit reached (${MAX_CONCURRENT_SESSIONS})`));
    }

    // 1. Validate tmux
    const validationResult = this.deps.validator.validate();
    if (!validationResult.ok) return validationResult;

    // 2. Generate wrapper or setup shim depending on mode
    if (config.persistent) {
      const shimConfig: SetupShimConfig = {
        taskId: config.taskId,
        sessionsDir: config.sessionsDir,
        agentCommand: config.command,
        agentArgs: config.agentArgs,
      };
      const shimResult = this.deps.hooks.generateSetupShim(shimConfig);
      if (!shimResult.ok) return shimResult;
      const shim = shimResult.value;

      return this.createAndRegisterSession(config, shim.shimPath, shim.messagesDir, shim.sessionDir, callbacks);
    }

    // Non-persistent (default): wrapper pipeline mode
    const manifestResult = this.deps.hooks.generateWrapper({
      taskId: config.taskId,
      agent: config.agent,
      sessionsDir: config.sessionsDir,
      agentCommand: config.command,
      agentArgs: config.agentArgs,
    });
    if (!manifestResult.ok) return manifestResult;
    const manifest = manifestResult.value;

    return this.createAndRegisterSession(
      config,
      manifest.wrapperPath,
      manifest.messagesDir,
      manifest.sessionDir,
      callbacks,
    );
  }

  /**
   * Steps 3–5 of spawn(): start watchers, launch the tmux session, register the
   * session in activeSessions, and (re)start the shared staleness timer.
   * Extracted from spawn() so spawn() stays under 50 lines.
   *
   * On createSession failure, cleans up watchers and the generated session
   * directory before returning the error.
   */
  private createAndRegisterSession(
    config: TmuxSpawnConfig,
    wrapperPath: string,
    messagesDir: string,
    sessionDir: string,
    callbacks: SpawnCallbacks,
  ): Result<TmuxHandle, AutobeatError> {
    // 3. Start fs.watch watchers (BEFORE session launch to avoid race).
    // Build a temporary session object with a placeholder sessionName so watchers
    // can be registered before createSession() returns the real name.
    const activeSessionResult = this.buildActiveSession(config, config.name, messagesDir, sessionDir, callbacks);
    if (!activeSessionResult.ok) return activeSessionResult;
    const session = activeSessionResult.value;
    this.startWatchers(session, sessionDir);

    // 4. Create tmux session running the wrapper
    const sessionResult = this.deps.sessionManager.createSession({
      ...config,
      command: wrapperPath,
    });
    if (!sessionResult.ok) {
      // Clean up watchers and generated session directory on failure
      this.closeSession(session);
      this.loggedCleanup('spawn', config.taskId, config.sessionsDir);
      return sessionResult;
    }

    // Overwrite the placeholder sessionName with the real one returned by createSession
    session.handle = {
      ...session.handle,
      sessionName: sessionResult.value.sessionName,
    };

    this.activeSessions.set(config.taskId, session);

    // 5. Start (or restart) the shared staleness timer — uses the minimum
    // checkIntervalMs across all active sessions so no session is checked late.
    this.restartSharedStalenessTimer();

    return ok(session.handle);
  }

  /**
   * Destroys a session and cleans up all watchers and timers.
   * Idempotent. Returns early when the handle is not tracked to avoid
   * acting on sessions owned by other connectors.
   */
  destroy(handle: TmuxHandle): Result<void, AutobeatError> {
    const session = this.activeSessions.get(handle.taskId);
    if (!session) return ok(undefined);

    // Set state to 'exited' before flush so late staleness timer ticks cannot trigger
    // onExit after we have already destroyed the session.
    session.state = 'exited';
    this.flushPendingFiles(session);
    this.closeSession(session);
    // Kill the tmux session before removing the directory — the wrapper script
    // may still be writing when destroy() is called, and rmSync while the
    // process has open file handles produces I/O errors.
    const destroyResult = this.deps.sessionManager.destroySession(handle.sessionName);
    if (!destroyResult.ok) {
      // Keep the session in activeSessions so the caller can retry destroy().
      // The exited flag (set above) prevents watchers and staleness ticks from
      // re-firing while the session remains tracked.
      this.deps.logger.warn('destroy: failed to destroy tmux session, keeping tracked for retry', {
        taskId: handle.taskId,
        sessionName: handle.sessionName,
        error: destroyResult.error.message,
      });
      return destroyResult;
    }
    // Success path: remove tracking, fire cleanup, and notify the caller.
    this.activeSessions.delete(handle.taskId);
    this.restartSharedStalenessTimer();
    this.loggedCleanup('destroy', handle.taskId, handle.sessionsDir);
    // Notify the caller so the task does not remain stuck in RUNNING after an
    // explicit destroy request. Use 'DESTROYED' to distinguish from natural
    // exits ('STALE', 'SHUTDOWN') and sentinel-driven exits.
    this.safeCallOnExit('destroy', session, null, 'DESTROYED');
    return destroyResult;
  }

  sendKeys(handle: TmuxHandle, keys: string): Result<void, AutobeatError> {
    return this.deps.sessionManager.sendKeys(handle.sessionName, keys);
  }

  /**
   * Delegates sendControlKeys to the session manager.
   * Used for kill flow (C-c → SIGINT) where tmux key interpretation is required.
   */
  sendControlKeys(handle: TmuxHandle, keys: string): Result<void, AutobeatError> {
    return this.deps.sessionManager.sendControlKeys(handle.sessionName, keys);
  }

  isAlive(handle: TmuxHandle): Result<boolean, AutobeatError> {
    return this.deps.sessionManager.isAlive(handle.sessionName);
  }

  /**
   * Delegates setEnvironment to the session manager.
   * Used by WorkerPool for persistent session reuse (Phase 5).
   */
  setEnvironment(handle: TmuxHandle, varName: string, value: string): Result<void, AutobeatError> {
    return this.deps.sessionManager.setSessionEnvironment(handle.sessionName, varName, value);
  }

  /**
   * Delivers content to a session via load-buffer / paste-buffer.
   * Delegates to session manager. Used by ChannelManager (Phase 7) for literal message delivery.
   */
  pasteContent(handle: TmuxHandle, content: string): Result<void, AutobeatError> {
    return this.deps.sessionManager.pasteContent(handle.sessionName, content);
  }

  /**
   * Prepares a parked persistent session for reuse by the next loop iteration.
   *
   * Protocol:
   * 1. Create new task directory (newTaskId/messages/) and reset .seq to 0
   * 2. Build a new ActiveSession registered under newTaskId with state 'active'
   * 3. Start new sentinel + messages watchers for the new directory
   * 4. Restart the staleness timer
   *
   * Must be called AFTER setEnvironment(AUTOBEAT_TASK_ID) and the /clear settle
   * delay, and BEFORE sendKeys(prompt) so watchers are ready before output arrives.
   *
   * Returns err() if the task directory cannot be created (caller falls through
   * to fresh spawn by calling cleanupPersistentSession then spawning fresh).
   */
  prepareForReuse(handle: TmuxHandle, newTaskId: TaskId, callbacks: SpawnCallbacks): Result<void, AutobeatError> {
    // Guard: reject if newTaskId is already active (shouldn't happen in steady state)
    if (this.activeSessions.has(newTaskId)) {
      return err(
        tmuxSessionFailed('prepareForReuse', `session for taskId '${newTaskId}' already exists`),
      );
    }

    // Step 1: Create new task directory
    const initResult = this.deps.hooks.initTaskDirectory(newTaskId, handle.sessionsDir);
    if (!initResult.ok) return initResult;
    const { sessionDir, messagesDir } = initResult.value;

    // Step 2: Build a new ActiveSession with state 'active'
    // Re-use the existing handle's sessionName — the tmux session is still alive.
    const newHandle: TmuxHandle = {
      sessionName: handle.sessionName,
      taskId: newTaskId,
      sessionsDir: handle.sessionsDir,
    };

    // Synthesise a minimal TmuxSpawnConfig for buildActiveSession.
    // Only the fields needed by buildActiveSession are required here:
    // taskId, sessionsDir, staleness (default), and persistent=true.
    const syntheticConfig = {
      taskId: newTaskId,
      sessionsDir: handle.sessionsDir,
      name: handle.sessionName,
      command: '',      // not used by buildActiveSession
      agentArgs: [],    // not used by buildActiveSession
      agent: 'claude' as const, // not used by buildActiveSession
      persistent: true,
    };

    const sessionResult = this.buildActiveSession(syntheticConfig, handle.sessionName, messagesDir, sessionDir, callbacks);
    if (!sessionResult.ok) return sessionResult;
    const session = sessionResult.value;

    // Override the handle in the new session to point to the new taskId
    session.handle = newHandle;

    // Step 3: Start new watchers for the new task directory
    this.startWatchers(session, sessionDir);

    // Step 4: Register and restart staleness timer
    this.activeSessions.set(newTaskId, session);
    this.restartSharedStalenessTimer();

    this.deps.logger.info('Session prepared for reuse', {
      sessionName: handle.sessionName,
      newTaskId,
    });

    return ok(undefined);
  }

  getActiveHandles(): TmuxHandle[] {
    return Array.from(this.activeSessions.values()).map((s) => s.handle);
  }

  /**
   * Cleans up ALL active sessions. Call on process shutdown.
   */
  dispose(): void {
    const sessions = Array.from(this.activeSessions.values());
    this.activeSessions.clear();
    this.stopSharedStalenessTimer();
    for (const session of sessions) {
      // Per-session try/catch ensures one failing teardown does not prevent
      // the remaining sessions from being cleaned up.
      try {
        // Set state to 'exited' before flush so late staleness timer ticks that
        // fire during teardown see state !== 'active' and return early.
        session.state = 'exited';
        this.flushPendingFiles(session);
        this.closeSession(session);
        const result = this.deps.sessionManager.destroySession(session.handle.sessionName);
        if (!result.ok) {
          this.deps.logger.warn('Dispose: failed to destroy session', {
            sessionName: session.handle.sessionName,
            error: result.error.message,
          });
        }
        this.loggedCleanup('dispose', session.handle.taskId, session.handle.sessionsDir);
        // Notify callers so tasks don't remain stuck in RUNNING after shutdown.
        this.safeCallOnExit('dispose', session, null, 'SHUTDOWN');
      } catch (teardownErr: unknown) {
        this.deps.logger.error(
          'Dispose: unhandled error during session teardown',
          teardownErr instanceof Error ? teardownErr : new Error(String(teardownErr)),
          { taskId: session.handle.taskId },
        );
      }
    }
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  /**
   * Constructs the initial ActiveSession state object.
   * Extracted from spawn() to keep spawn() under 50 lines.
   *
   * Returns err() when the caller-supplied staleness config is invalid:
   *   - maxSilenceMs must be > 0 (zero or negative would declare every session
   *     immediately stale, since silentMs >= 0 is always true)
   *
   * @param sessionName - The tmux session name to embed in the handle. Callers
   *   may pass a placeholder before createSession() returns the real name, then
   *   overwrite session.handle.sessionName afterward.
   * @param sessionDir - The session root directory (parent of messages/).
   */
  private buildActiveSession(
    config: TmuxSpawnConfig,
    sessionName: string,
    messagesDir: string,
    sessionDir: string,
    callbacks: SpawnCallbacks,
  ): Result<ActiveSession, AutobeatError> {
    const stalenessConfig: StalenessConfig = {
      ...DEFAULT_STALENESS_CONFIG,
      ...config.staleness,
    };

    if (stalenessConfig.maxSilenceMs <= 0) {
      return err(
        tmuxSessionFailed('spawn', `staleness.maxSilenceMs must be positive (got ${stalenessConfig.maxSilenceMs})`),
      );
    }

    return ok({
      handle: {
        sessionName,
        taskId: config.taskId,
        sessionsDir: config.sessionsDir,
      },
      sentinelWatcher: null,
      messagesWatcher: null,
      stalenessConfig,
      lastAliveCheck: Date.now(),
      state: 'active' as SessionState,
      lastDeliveredSeq: 0,
      pendingMessages: new Map(),
      nextExpectedSeq: 1,
      debounceTimers: new Map(),
      messagesDir,
      sessionDir,
      persistent: config.persistent === true,
      callbacks,
      flushing: false,
    });
  }

  /**
   * Starts the sentinel and messages fs.watch watchers for a session.
   * Called BEFORE session launch so we never miss events from a fast-exiting agent.
   */
  private startWatchers(session: ActiveSession, sessionDir: string): void {
    this.startSentinelWatcher(session, sessionDir);
    this.startMessagesWatcher(session);
  }

  /**
   * Starts the sentinel watcher that detects .done / .exit files written by the wrapper.
   * Errors are logged but do not throw — staleness detection handles the degraded path.
   */
  private startSentinelWatcher(session: ActiveSession, sessionDir: string): void {
    const { taskId } = session.handle;
    try {
      session.sentinelWatcher = this.deps.watch(
        sessionDir,
        { persistent: false },
        (_eventType: string, filename: string | null) => {
          if (!filename) return;
          if (filename === '.done' || filename === '.exit') {
            // No debounce needed here: handleSentinel() reads session.exited
            // synchronously at the top of the event-loop tick. Because
            // triggerExit() sets session.exited = true before returning,
            // any platform double-fire of the same sentinel file is a no-op —
            // the second callback sees exited = true and returns immediately.
            this.handleSentinel(taskId, sessionDir, filename);
          }
        },
      );
      // Log watcher errors but do not throw or trigger exit — staleness timer handles detection
      session.sentinelWatcher.on('error', (...args: unknown[]) => {
        const watchErr = args[0];
        this.deps.logger.warn('Sentinel watcher error — degrading to staleness detection', {
          taskId,
          sessionDir,
          error: watchErr instanceof Error ? watchErr.message : String(watchErr),
        });
      });
    } catch {
      // Directory may not exist yet — degrade gracefully to staleness-only detection.
      // With no sentinel watcher, the connector relies solely on the shared staleness
      // timer (maxSilenceMs, default 60s) to detect session exit.
      this.deps.logger.info('Sentinel watcher unavailable — degrading to staleness-only detection', {
        taskId,
        sessionDir,
        fallbackMaxSilenceMs: session.stalenessConfig.maxSilenceMs,
      });
    }
  }

  /**
   * Starts the messages watcher that picks up output message JSON files.
   * Applies a debounce window to suppress platform double-fire events.
   * Errors are logged but do not throw — staleness detection handles the degraded path.
   */
  private startMessagesWatcher(session: ActiveSession): void {
    const { taskId } = session.handle;
    const { messagesDir } = session;
    try {
      session.messagesWatcher = this.deps.watch(
        messagesDir,
        { persistent: false },
        (_eventType: string, filename: string | null) => this.onMessageFileChange(session, filename),
      );
      // Log watcher errors but do not throw or trigger exit — staleness timer handles detection
      session.messagesWatcher.on('error', (...args: unknown[]) => {
        const watchErr = args[0];
        this.deps.logger.warn('Messages watcher error — degrading to staleness detection', {
          taskId,
          messagesDir,
          error: watchErr instanceof Error ? watchErr.message : String(watchErr),
        });
      });
    } catch {
      this.deps.logger.warn('Failed to start messages watcher', { taskId, messagesDir });
    }
  }

  /**
   * Called by the messages watcher for each file-change event.
   * Validates the filename, debounces double-fires, and schedules async message delivery.
   * Extracted from startMessagesWatcher to flatten nesting and keep the watcher setup readable.
   */
  private onMessageFileChange(session: ActiveSession, filename: string | null): void {
    if (!filename || session.state !== 'active') return;
    // Ignore temp files and non-JSON
    if (filename.endsWith('.tmp')) return;
    if (!filename.endsWith('.json')) return;

    const { taskId } = session.handle;
    const { messagesDir, callbacks } = session;

    // Debounce double-fires for the same file
    const existing = session.debounceTimers.get(filename);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      session.debounceTimers.delete(filename);
      this.handleMessageFile(path.join(messagesDir, filename), session, callbacks).catch((err: unknown) => {
        this.deps.logger.warn('handleMessageFile threw unexpectedly', {
          taskId,
          filename,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, DEBOUNCE_MS);
    session.debounceTimers.set(filename, timer);
  }

  /**
   * Restarts the shared staleness timer using the minimum checkIntervalMs across
   * all active sessions. Called whenever the session set changes (spawn/exit).
   * The single timer calls listSessions() once per tick and checks all sessions.
   *
   * DESIGN DECISION: A single shared timer avoids O(N) concurrent isAlive syscalls.
   * listSessions() returns all live beat-* sessions in one tmux invocation; each
   * session's lastAliveCheck and maxSilenceMs are stored per-session for independent
   * stale detection.
   *
   * DESIGN DECISION: Skip-if-same-interval optimisation — when multiple sessions
   * are spawned back-to-back (e.g. a pipeline launching 10 tasks) with identical
   * checkIntervalMs, the first spawn starts the timer and subsequent calls see that
   * the required interval is already running and skip the teardown/recreate. This
   * avoids O(N) clearInterval+setInterval churn for the common case where all
   * sessions share the same staleness config.
   */
  private restartSharedStalenessTimer(): void {
    if (this.activeSessions.size === 0) {
      this.stopSharedStalenessTimer();
      return;
    }

    // Use the minimum checkIntervalMs across all sessions, clamped to the floor.
    // A for-loop avoids the spread-args stack limit that Math.min(...array) hits on large inputs.
    let minInterval = Number.MAX_SAFE_INTEGER;
    for (const s of this.activeSessions.values()) {
      if (s.stalenessConfig.checkIntervalMs < minInterval) {
        minInterval = s.stalenessConfig.checkIntervalMs;
      }
    }
    if (minInterval < MIN_CHECK_INTERVAL_MS) minInterval = MIN_CHECK_INTERVAL_MS;

    // Skip teardown/recreate when the timer is already running at the correct interval.
    if (this.sharedStalenessTimer !== null && this.currentTimerIntervalMs === minInterval) return;

    this.stopSharedStalenessTimer();
    this.currentTimerIntervalMs = minInterval;
    this.sharedStalenessTimer = setInterval(() => this.runSharedStalenessCheck(), minInterval);
    // unref() prevents this timer from keeping the Node.js process alive in CLI/run modes
    // when no workers are active — consistent with heartbeat and flush timers in worker pool.
    this.sharedStalenessTimer.unref();
  }

  /**
   * Checks all active sessions for staleness using a single listSessions() call.
   * Sessions confirmed alive update their lastAliveCheck. Sessions confirmed dead
   * for longer than maxSilenceMs are triggered for exit with STALE signal.
   */
  private runSharedStalenessCheck(): void {
    if (this.activeSessions.size === 0) return;

    const listResult = this.deps.sessionManager.listSessions();
    if (!listResult.ok) {
      // Transient error — cannot confirm any session dead; skip this tick
      this.deps.logger.warn('listSessions failed — transient error, skipping staleness check', {
        error: listResult.error.message,
      });
      return;
    }

    const aliveSessions = new Set<string>(listResult.value.map((s) => s.name));
    const now = Date.now();

    // Collect stale sessions first so triggerExit does not mutate activeSessions
    // while we are still iterating it.
    const staleEntries: Array<[TaskId, ActiveSession]> = [];

    for (const [taskId, session] of this.activeSessions) {
      // Skip sessions that are not active — 'exited' sessions are in cleanup,
      // 'parked' sessions are intentionally idle between loop iterations and
      // should not be treated as stale (tmux session is alive, just waiting).
      if (session.state !== 'active') continue;
      if (this.checkSessionStaleness(session, aliveSessions, now)) {
        staleEntries.push([taskId, session]);
      }
    }

    for (const [taskId, session] of staleEntries) {
      this.triggerExit(taskId, session, null, 'STALE', true);
    }
    // Restart once after the batch rather than once per stale session to avoid
    // O(N) timer teardown/recreate churn during batch stale detection.
    if (staleEntries.length > 0) {
      this.restartSharedStalenessTimer();
    }
  }

  /**
   * Checks a single session's staleness against the alive-sessions set.
   * If alive, resets lastAliveCheck. If dead long enough, logs a warning and returns true.
   * Returns true when the session should be marked stale, false otherwise.
   */
  private checkSessionStaleness(session: ActiveSession, aliveSessions: Set<string>, now: number): boolean {
    if (aliveSessions.has(session.handle.sessionName)) {
      // Confirmed alive — reset the silent-since timestamp
      session.lastAliveCheck = now;
      return false;
    }
    // Confirmed dead — check if silent long enough
    const silentMs = now - session.lastAliveCheck;
    if (silentMs >= session.stalenessConfig.maxSilenceMs) {
      this.deps.logger.warn('Session stale — no heartbeat detected', {
        sessionName: session.handle.sessionName,
        silentMs,
      });
      return true;
    }
    return false;
  }

  private stopSharedStalenessTimer(): void {
    if (this.sharedStalenessTimer !== null) {
      clearInterval(this.sharedStalenessTimer);
      this.sharedStalenessTimer = null;
      this.currentTimerIntervalMs = null;
    }
  }

  /**
   * Reads all undelivered message files from disk and delivers them via the
   * session's pending-message pipeline. Called before exit/destroy/dispose to
   * prevent the debounce window from silently dropping final messages.
   */
  private flushPendingFiles(session: ActiveSession): void {
    if (session.flushing) return;
    session.flushing = true;
    const flushStart = Date.now();
    try {
      // Clear debounce timers — we'll read files directly instead
      for (const timer of session.debounceTimers.values()) {
        clearTimeout(timer);
      }
      session.debounceTimers.clear();

      let files: string[];
      try {
        files = this.deps.readdirSync(session.messagesDir);
      } catch {
        // Directory may not exist (no output written) — nothing to flush
        files = [];
      }

      const jsonFiles = files.filter((f) => f.endsWith('.json') && !f.endsWith('.tmp')).sort();

      for (const filename of jsonFiles) {
        // Fast path: skip files whose sequence number (from filename prefix, e.g.
        // "00001-stdout.json") is already delivered, avoiding the readFileSync call.
        const seqStr = filename.split('-')[0];
        const filenameSeq = seqStr !== undefined ? parseInt(seqStr, 10) : NaN;
        if (!isNaN(filenameSeq) && filenameSeq <= session.lastDeliveredSeq) continue;

        const filePath = path.join(session.messagesDir, filename);
        const parsed = this.parseMessageFile(filePath);
        if (parsed === null) continue;

        if (parsed.sequence <= session.lastDeliveredSeq) continue;
        session.pendingMessages.set(parsed.sequence, parsed);
      }

      // Deliver consecutive messages from nextExpectedSeq
      this.deliverPendingMessages(session, session.callbacks);

      // Force-deliver any remaining out-of-order messages (no more will arrive)
      this.forceDeliverRemaining(session);

      this.deps.logger.info('Flush complete', {
        taskId: session.handle.taskId,
        fileCount: jsonFiles.length,
        elapsedMs: Date.now() - flushStart,
      });
    } finally {
      session.flushing = false;
    }
  }

  /**
   * Reads and parses a single message file from disk.
   * Returns the parsed OutputMessage, or null if the file is unreadable,
   * unparseable, or fails the isOutputMessage type guard.
   * Used by flushPendingFiles to keep nesting ≤ 3 levels.
   */
  private parseMessageFile(filePath: string): OutputMessage | null {
    let parsed: unknown;
    try {
      const raw = this.deps.readFileSync(filePath, 'utf8');
      parsed = JSON.parse(raw);
    } catch {
      this.deps.logger.warn('Flush: failed to parse message file', { filePath });
      return null;
    }
    if (!isOutputMessage(parsed)) return null;
    return parsed;
  }

  /**
   * Force-delivers all remaining pending messages in sequence order, bypassing
   * the gap-filling logic. Used at flush time when no further messages will arrive.
   */
  private forceDeliverRemaining(session: ActiveSession): void {
    if (session.pendingMessages.size === 0) return;
    const sorted = Array.from(session.pendingMessages.entries()).sort((a, b) => a[0] - b[0]);
    for (const [seq, msg] of sorted) {
      session.pendingMessages.delete(seq);
      this.deliverSingle(msg, session, session.callbacks);
    }
  }

  private handleSentinel(taskId: TaskId, sessionDir: string, filename: string): void {
    const session = this.activeSessions.get(taskId);
    if (!session || session.state !== 'active') return;

    // Read exit code from sentinel file
    let code: number | null = null;
    try {
      const sentinelPath = path.join(sessionDir, filename);
      const raw = this.deps.readFileSync(sentinelPath, 'utf8').trim();
      code = parseInt(raw, 10);
      if (isNaN(code)) code = null;
    } catch {
      // Sentinel may not be readable yet — use null
    }

    // For .exit sentinel, code is the actual exit code; for .done it's 0
    const exitCode = filename === '.done' ? (code ?? 0) : (code ?? 1);
    this.triggerExit(taskId, session, exitCode, undefined);
  }

  private async handleMessageFile(filePath: string, session: ActiveSession, callbacks: SpawnCallbacks): Promise<void> {
    if (session.state !== 'active') return;

    let parsed: unknown;
    try {
      // Async read to avoid blocking the event loop on the hot output path.
      // Sentinel and flush paths remain sync (one-shot on exit).
      const raw = await this.deps.readFile(filePath, 'utf8');
      // Re-check after async gap — session may have exited or been parked during the read
      if (session.state !== 'active') return;
      parsed = JSON.parse(raw);
    } catch {
      this.deps.logger.warn('Failed to parse output message file', { filePath });
      return;
    }

    if (!isOutputMessage(parsed)) {
      this.deps.logger.warn('Output message missing required fields', { filePath });
      return;
    }

    // Buffer for ordered delivery
    session.pendingMessages.set(parsed.sequence, parsed);

    // Deliver all consecutive messages starting from nextExpectedSeq
    this.deliverPendingMessages(session, callbacks);

    // Safety cap: if too many pending messages accumulate (gap that won't fill),
    // skip ahead and deliver what we have to prevent unbounded memory growth.
    // DESIGN DECISION: After the gap-skip, we run deliverPendingMessages once to
    // drain the consecutive run starting at the lowest known sequence. If the map
    // is still above a lower watermark (half the cap), we force-deliver the
    // remainder immediately so a pathological arrival pattern that oscillates near
    // MAX_PENDING_MESSAGES cannot stall delivery indefinitely.
    if (session.pendingMessages.size > MAX_PENDING_MESSAGES) {
      this.deps.logger.warn('Pending message buffer exceeded cap, skipping gap', {
        nextExpectedSeq: session.nextExpectedSeq,
        pendingCount: session.pendingMessages.size,
      });
      // Find the lowest pending sequence and deliver from there
      const sortedSeqs = Array.from(session.pendingMessages.keys()).sort((a, b) => a - b);
      const lowestSeq = sortedSeqs[0];
      if (lowestSeq !== undefined) {
        session.nextExpectedSeq = lowestSeq;
        // Re-run the delivery loop after resetting the gap
        this.deliverPendingMessages(session, callbacks);
      }
      // Force-drain if still above lower watermark to break any oscillation pattern
      if (session.pendingMessages.size > MAX_PENDING_MESSAGES / 2) {
        this.forceDeliverRemaining(session);
      }
    }
  }

  /**
   * Delivers a single message if it is above the lastDeliveredSeq watermark.
   * Shared by the ordered delivery loop and the force-deliver path in flushPendingFiles
   * to ensure both paths use the same dedup watermark logic.
   */
  private deliverSingle(msg: OutputMessage, session: ActiveSession, callbacks: SpawnCallbacks): void {
    if (msg.sequence > session.lastDeliveredSeq) {
      session.lastDeliveredSeq = msg.sequence;
      try {
        callbacks.onOutput(msg);
      } catch (cbErr: unknown) {
        this.deps.logger.error(
          'deliverSingle: onOutput callback threw',
          cbErr instanceof Error ? cbErr : new Error(String(cbErr)),
          { taskId: session.handle.taskId, sequence: msg.sequence },
        );
      }
    }
  }

  /**
   * Delivers all consecutive pending messages starting from session.nextExpectedSeq.
   * Uses lastDeliveredSeq as a monotonic watermark to prevent duplicate delivery.
   * The upper bound (pendingMessages.size + 1) prevents unbounded iteration should
   * the map somehow grow during delivery (e.g. re-entrant onOutput callback).
   */
  private deliverPendingMessages(session: ActiveSession, callbacks: SpawnCallbacks): void {
    const maxDelivery = session.pendingMessages.size + 1;
    let delivered = 0;
    while (delivered < maxDelivery && session.pendingMessages.has(session.nextExpectedSeq)) {
      const msg = session.pendingMessages.get(session.nextExpectedSeq);
      if (msg === undefined) break;
      session.pendingMessages.delete(session.nextExpectedSeq);
      this.deliverSingle(msg, session, callbacks);
      session.nextExpectedSeq++;
      delivered++;
    }
  }

  private triggerExit(
    taskId: TaskId,
    session: ActiveSession,
    code: number | null,
    signal: string | undefined,
    skipTimerRestart = false,
  ): void {
    if (session.state !== 'active') return;

    // DESIGN DECISION (Phase B): Persistent sessions are "parked" rather than destroyed
    // when a sentinel fires — the tmux session stays alive between loop iterations.
    // WorkerPool will call prepareForReuse() on the next iteration to set up new
    // watchers and task directory, then sendKeys() to deliver the next prompt.
    if (session.persistent) {
      // Set state to 'parked' BEFORE flushPendingFiles so that any in-flight staleness
      // timer ticks that fire during the flush see state !== 'active' and return early.
      session.state = 'parked';
      this.flushPendingFiles(session);
      this.closeSession(session);
      // Remove from activeSessions — prepareForReuse() will re-register with new taskId.
      this.activeSessions.delete(taskId);
      if (!skipTimerRestart) {
        this.restartSharedStalenessTimer();
      }
      // Notify the caller (fires TaskCompleted event). Session directory preserved for
      // output reading — cleanup happens via loggedCleanup on the NEXT iteration's park
      // or when cleanupPersistentSession() is called by WorkerPool at loop end.
      this.safeCallOnExit('triggerExit', session, code, signal);
      return;
    }

    // Non-persistent path: destroy session, cleanup directory, fire onExit.

    // Set state to 'exited' BEFORE flushPendingFiles so that any in-flight staleness
    // timer tick that fires during the flush sees state !== 'active' and returns early,
    // preventing a double onExit call.
    session.state = 'exited';
    this.flushPendingFiles(session);
    this.closeSession(session);
    this.activeSessions.delete(taskId);
    // Restart (or stop) the shared timer so remaining sessions are still checked
    // at the correct minimum interval now that this session has been removed.
    // skipTimerRestart=true when called from the batch stale loop — the caller
    // restarts once after all exits to avoid O(N) timer churn.
    if (!skipTimerRestart) {
      this.restartSharedStalenessTimer();
    }
    // Kill the tmux session — an agent that is hung (not crashed) won't produce a
    // sentinel, so the stale path must forcefully terminate it. destroySession is
    // idempotent when the session no longer exists (already-exited agents).
    const destroyResult = this.deps.sessionManager.destroySession(session.handle.sessionName);
    if (!destroyResult.ok) {
      this.deps.logger.warn('triggerExit: failed to destroy session', {
        taskId,
        sessionName: session.handle.sessionName,
        error: destroyResult.error.message,
      });
    }
    this.loggedCleanup('triggerExit', taskId, session.handle.sessionsDir);
    this.safeCallOnExit('triggerExit', session, code, signal);
  }

  /**
   * Calls session.callbacks.onExit() and logs a warning if the callback throws.
   * Extracted from destroy/dispose/triggerExit to eliminate the repeated try/catch
   * guard pattern around user-supplied callbacks.
   */
  private safeCallOnExit(caller: string, session: ActiveSession, code: number | null, signal?: string): void {
    try {
      session.callbacks.onExit(code, signal);
    } catch (cbErr: unknown) {
      this.deps.logger.error(
        `${caller}: onExit callback threw`,
        cbErr instanceof Error ? cbErr : new Error(String(cbErr)),
        { taskId: session.handle.taskId },
      );
    }
  }

  /**
   * Runs hooks.cleanup and logs a warning if it fails.
   * Extracted from spawn/destroy/dispose/triggerExit to eliminate the repeated
   * 5-line cleanup+log pattern. All log messages use sentence case to match the
   * pre-existing style in this file.
   */
  private loggedCleanup(caller: string, taskId: TaskId, sessionsDir: string): void {
    const cleanupResult = this.deps.hooks.cleanup(taskId, sessionsDir);
    if (!cleanupResult.ok) {
      this.deps.logger.warn('Hooks cleanup failed', {
        caller,
        taskId,
        error: cleanupResult.error.message,
      });
    }
  }

  private closeSession(session: ActiveSession): void {
    if (session.sentinelWatcher) {
      try {
        session.sentinelWatcher.close();
      } catch {
        /* ignore */
      }
      session.sentinelWatcher = null;
    }
    if (session.messagesWatcher) {
      try {
        session.messagesWatcher.close();
      } catch {
        /* ignore */
      }
      session.messagesWatcher = null;
    }
    for (const timer of session.debounceTimers.values()) {
      clearTimeout(timer);
    }
    session.debounceTimers.clear();
  }
}
