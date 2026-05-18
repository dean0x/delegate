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

import * as fs from 'fs';
import * as path from 'path';
import type { AutobeatError } from '../../core/errors.js';
import { tmuxSessionFailed } from '../../core/errors.js';
import type { Logger } from '../../core/interfaces.js';
import type { Result } from '../../core/result.js';
import { err, ok } from '../../core/result.js';
import type {
  OutputMessage,
  SpawnCallbacks,
  StalenessConfig,
  TmuxConnectorPort,
  TmuxHandle,
  TmuxHooks,
  TmuxSessionManager,
  TmuxSpawnConfig,
  TmuxValidator,
} from './types.js';
import { DEFAULT_STALENESS_CONFIG, MAX_CONCURRENT_SESSIONS } from './types.js';

export type { SpawnCallbacks } from './types.js';

/** fs.watch callback signature */
type WatchFn = typeof fs.watch;

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
  sessionManager: TmuxSessionManager;
  hooks: TmuxHooks;
  validator: TmuxValidator;
  logger: Logger;
  watch: WatchFn;
  /** Injectable readFileSync — used for sentinel and flush paths (one-shot, sync); injected in tests */
  readFileSync?: (path: string, encoding: BufferEncoding) => string;
  /** Injectable readFile — used for the hot-path message handler (async, non-blocking); injected in tests */
  readFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
  /** Injectable readdirSync — defaults to fs.readdirSync; injected in tests */
  readdirSync?: (dirPath: string) => string[];
}

/**
 * Internal state for a single managed session
 */
interface ActiveSession {
  handle: TmuxHandle;
  sentinelWatcher: fs.FSWatcher | null;
  messagesWatcher: fs.FSWatcher | null;
  /** Per-session staleness config — used by the shared staleness timer */
  stalenessConfig: StalenessConfig;
  /** Timestamp of last confirmed-alive check — used for maxSilenceMs threshold */
  lastAliveCheck: number;
  exited: boolean;
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
  /** Stored callbacks for flush-on-destroy/dispose */
  callbacks: SpawnCallbacks;
  /** Re-entrancy guard for flushPendingFiles */
  flushing: boolean;
}

export class TmuxConnector implements TmuxConnectorPort {
  private readonly activeSessions = new Map<string, ActiveSession>();
  private readonly readFileSyncFn: (path: string, encoding: BufferEncoding) => string;
  private readonly readFileFn: (path: string, encoding: BufferEncoding) => Promise<string>;
  private readonly readdirSyncFn: (dirPath: string) => string[];
  /** Shared staleness timer — started on first spawn, stopped when activeSessions empties */
  private sharedStalenessTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: TmuxConnectorDeps) {
    this.readFileSyncFn = deps.readFileSync ?? ((p, enc) => fs.readFileSync(p, enc));
    this.readFileFn = deps.readFile ?? ((p, enc) => fs.promises.readFile(p, enc));
    this.readdirSyncFn = deps.readdirSync ?? ((p) => fs.readdirSync(p));
  }

  /**
   * Spawns a new managed tmux session.
   * 1. Validates tmux availability
   * 2. Generates the wrapper script
   * 3. Starts fs.watch watchers (BEFORE session launch to avoid race)
   * 4. Creates the tmux session running the wrapper
   * 5. Starts (or restarts) the shared staleness timer
   */
  spawn(config: TmuxSpawnConfig, callbacks: SpawnCallbacks): Result<TmuxHandle, AutobeatError> {
    // Guard: reject duplicate taskId to prevent orphaning the first session's watchers/timers
    if (this.activeSessions.has(config.taskId)) {
      return err(tmuxSessionFailed('spawn', `session for taskId '${config.taskId}' already exists`));
    }

    // Guard: enforce connector-level session cap so injected session managers cannot
    // bypass the MAX_CONCURRENT_SESSIONS limit enforced at the tmux level.
    if (this.activeSessions.size >= MAX_CONCURRENT_SESSIONS) {
      return err(tmuxSessionFailed('spawn', `connector session limit reached (${MAX_CONCURRENT_SESSIONS})`));
    }

    // 1. Validate tmux
    const validationResult = this.deps.validator.validate();
    if (!validationResult.ok) return validationResult;

    // 2. Generate wrapper
    const manifestResult = this.deps.hooks.generateWrapper({
      taskId: config.taskId,
      agent: config.agent,
      sessionsDir: config.sessionsDir,
      agentCommand: config.command,
      agentArgs: [],
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
    const session = this.buildActiveSession(config, config.name, messagesDir, callbacks);
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

    // Set exited before flush so late staleness timer ticks cannot trigger
    // onExit after we have already destroyed the session.
    session.exited = true;
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
    try {
      session.callbacks.onExit(null, 'DESTROYED');
    } catch (cbErr: unknown) {
      this.deps.logger.error(
        'destroy: onExit callback threw',
        cbErr instanceof Error ? cbErr : new Error(String(cbErr)),
        { taskId: handle.taskId },
      );
    }
    return destroyResult;
  }

  sendKeys(handle: TmuxHandle, keys: string): Result<void, AutobeatError> {
    return this.deps.sessionManager.sendKeys(handle.sessionName, keys);
  }

  isAlive(handle: TmuxHandle): Result<boolean, AutobeatError> {
    return this.deps.sessionManager.isAlive(handle.sessionName);
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
        // Set exited before flush so late staleness timer ticks that fire during
        // teardown see session.exited = true and return early.
        session.exited = true;
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
        try {
          session.callbacks.onExit(null, 'SHUTDOWN');
        } catch (cbErr: unknown) {
          this.deps.logger.error(
            'dispose: onExit callback threw',
            cbErr instanceof Error ? cbErr : new Error(String(cbErr)),
            { taskId: session.handle.taskId },
          );
        }
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
   * @param sessionName - The tmux session name to embed in the handle. Callers
   *   may pass a placeholder before createSession() returns the real name, then
   *   overwrite session.handle.sessionName afterward.
   */
  private buildActiveSession(
    config: TmuxSpawnConfig,
    sessionName: string,
    messagesDir: string,
    callbacks: SpawnCallbacks,
  ): ActiveSession {
    const stalenessConfig: StalenessConfig = {
      ...DEFAULT_STALENESS_CONFIG,
      ...config.staleness,
    };
    return {
      handle: {
        sessionName,
        taskId: config.taskId,
        sessionsDir: config.sessionsDir,
      },
      sentinelWatcher: null,
      messagesWatcher: null,
      stalenessConfig,
      lastAliveCheck: Date.now(),
      exited: false,
      lastDeliveredSeq: 0,
      pendingMessages: new Map(),
      nextExpectedSeq: 1,
      debounceTimers: new Map(),
      messagesDir,
      callbacks,
      flushing: false,
    };
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
      session.sentinelWatcher.on('error', (watchErr: Error) => {
        this.deps.logger.warn('Sentinel watcher error — degrading to staleness detection', {
          taskId,
          sessionDir,
          error: watchErr.message,
        });
      });
    } catch {
      // Directory may not exist yet — sentinel detection degrades gracefully
      this.deps.logger.warn('Failed to start sentinel watcher', { taskId, sessionDir });
    }
  }

  /**
   * Starts the messages watcher that picks up output message JSON files.
   * Applies a debounce window to suppress platform double-fire events.
   * Errors are logged but do not throw — staleness detection handles the degraded path.
   */
  private startMessagesWatcher(session: ActiveSession): void {
    const { taskId } = session.handle;
    const { messagesDir, callbacks } = session;
    try {
      session.messagesWatcher = this.deps.watch(
        messagesDir,
        { persistent: false },
        (_eventType: string, filename: string | null) => {
          if (!filename || session.exited) return;
          // Ignore temp files and non-JSON
          if (filename.endsWith('.tmp')) return;
          if (!filename.endsWith('.json')) return;

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
        },
      );
      // Log watcher errors but do not throw or trigger exit — staleness timer handles detection
      session.messagesWatcher.on('error', (watchErr: Error) => {
        this.deps.logger.warn('Messages watcher error — degrading to staleness detection', {
          taskId,
          messagesDir,
          error: watchErr.message,
        });
      });
    } catch {
      this.deps.logger.warn('Failed to start messages watcher', { taskId, messagesDir });
    }
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
   */
  private restartSharedStalenessTimer(): void {
    this.stopSharedStalenessTimer();
    if (this.activeSessions.size === 0) return;

    // Use the minimum checkIntervalMs across all sessions, clamped to the floor.
    // A for-loop avoids the spread-args stack limit that Math.min(...array) hits on large inputs.
    let minInterval = Number.MAX_SAFE_INTEGER;
    for (const s of this.activeSessions.values()) {
      if (s.stalenessConfig.checkIntervalMs < minInterval) {
        minInterval = s.stalenessConfig.checkIntervalMs;
      }
    }
    if (minInterval < MIN_CHECK_INTERVAL_MS) minInterval = MIN_CHECK_INTERVAL_MS;

    this.sharedStalenessTimer = setInterval(() => this.runSharedStalenessCheck(), minInterval);
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
    const staleEntries: Array<[string, ActiveSession]> = [];

    for (const [taskId, session] of this.activeSessions) {
      if (session.exited) continue;

      if (aliveSessions.has(session.handle.sessionName)) {
        // Confirmed alive — reset the silent-since timestamp
        session.lastAliveCheck = now;
      } else {
        // Confirmed dead — check if silent long enough
        const silentMs = now - session.lastAliveCheck;
        if (silentMs >= session.stalenessConfig.maxSilenceMs) {
          this.deps.logger.warn('Session stale — no heartbeat detected', {
            sessionName: session.handle.sessionName,
            silentMs,
          });
          staleEntries.push([taskId, session]);
        }
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

  private stopSharedStalenessTimer(): void {
    if (this.sharedStalenessTimer !== null) {
      clearInterval(this.sharedStalenessTimer);
      this.sharedStalenessTimer = null;
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
    try {
      // Clear debounce timers — we'll read files directly instead
      for (const timer of session.debounceTimers.values()) {
        clearTimeout(timer);
      }
      session.debounceTimers.clear();

      let files: string[];
      try {
        files = this.readdirSyncFn(session.messagesDir);
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
      const raw = this.readFileSyncFn(filePath, 'utf8');
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

  private handleSentinel(taskId: string, sessionDir: string, filename: string): void {
    const session = this.activeSessions.get(taskId);
    if (!session || session.exited) return;

    // Read exit code from sentinel file
    let code: number | null = null;
    try {
      const sentinelPath = path.join(sessionDir, filename);
      const raw = this.readFileSyncFn(sentinelPath, 'utf8').trim();
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
    if (session.exited) return;

    let parsed: unknown;
    try {
      // Async read to avoid blocking the event loop on the hot output path.
      // Sentinel and flush paths remain sync (one-shot on exit).
      const raw = await this.readFileFn(filePath, 'utf8');
      // Re-check after async gap — session may have exited during the read
      if (session.exited) return;
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
    // skip ahead and deliver what we have to prevent unbounded memory growth
    if (session.pendingMessages.size > MAX_PENDING_MESSAGES) {
      this.deps.logger.warn('Pending message buffer exceeded cap, skipping gap', {
        nextExpectedSeq: session.nextExpectedSeq,
        pendingCount: session.pendingMessages.size,
      });
      // Find the lowest pending sequence and deliver from there
      const sortedSeqs = Array.from(session.pendingMessages.keys()).sort((a, b) => a - b);
      session.nextExpectedSeq = sortedSeqs[0]!;
      // Re-run the delivery loop after resetting the gap
      this.deliverPendingMessages(session, callbacks);
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
      const msg = session.pendingMessages.get(session.nextExpectedSeq)!;
      session.pendingMessages.delete(session.nextExpectedSeq);
      this.deliverSingle(msg, session, callbacks);
      session.nextExpectedSeq++;
      delivered++;
    }
  }

  private triggerExit(
    taskId: string,
    session: ActiveSession,
    code: number | null,
    signal: string | undefined,
    skipTimerRestart = false,
  ): void {
    if (session.exited) return;

    // Set exited BEFORE flushPendingFiles so that any in-flight staleness timer
    // tick that fires during the flush sees session.exited = true and returns
    // early, preventing a double onExit call.
    session.exited = true;
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
    try {
      session.callbacks.onExit(code, signal);
    } catch (cbErr: unknown) {
      this.deps.logger.error(
        'triggerExit: onExit callback threw',
        cbErr instanceof Error ? cbErr : new Error(String(cbErr)),
        { taskId },
      );
    }
  }

  /**
   * Runs hooks.cleanup and logs a warning if it fails.
   * Extracted from spawn/destroy/dispose/triggerExit to eliminate the repeated
   * 5-line cleanup+log pattern. All log messages use sentence case to match the
   * pre-existing style in this file.
   */
  private loggedCleanup(caller: string, taskId: string, sessionsDir: string): void {
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
    // Clear any pending debounce timers
    for (const timer of session.debounceTimers.values()) {
      clearTimeout(timer);
    }
    session.debounceTimers.clear();
  }
}
