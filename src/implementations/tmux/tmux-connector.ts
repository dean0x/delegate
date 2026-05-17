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
 * DESIGN DECISION: Staleness detection (setInterval + isAlive) acts as a safety
 * net for processes that crash without writing a sentinel. It fires onExit(null,
 * 'STALE') and stops itself after the first firing to prevent double-fire.
 */

import * as fs from 'fs';
import * as path from 'path';
import { AutobeatError } from '../../core/errors.js';
import type { Logger } from '../../core/interfaces.js';
import { ok, Result } from '../../core/result.js';
import {
  DEFAULT_STALENESS_CONFIG,
  OutputMessage,
  StalenessConfig,
  TmuxHandle,
  TmuxHooks,
  TmuxSessionManager,
  TmuxSpawnConfig,
  TmuxValidator,
} from './types.js';

/** fs.watch callback signature */
type WatchFn = typeof fs.watch;

/** Debounce window for suppressing fs.watch double-fires (ms) */
const DEBOUNCE_MS = 50;

/** Maximum number of pending out-of-order messages before forcing delivery */
const MAX_PENDING_MESSAGES = 100;

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
  /** Injectable readFileSync — defaults to fs.readFileSync; injected in tests */
  readFileSync?: (path: string, encoding: BufferEncoding) => string;
  /** Injectable readdirSync — defaults to fs.readdirSync; injected in tests */
  readdirSync?: (dirPath: string) => string[];
}

export interface SpawnCallbacks {
  onOutput: (msg: OutputMessage) => void;
  onExit: (code: number | null, signal?: string) => void;
}

/**
 * Internal state for a single managed session
 */
interface ActiveSession {
  handle: TmuxHandle;
  sentinelWatcher: fs.FSWatcher | null;
  messagesWatcher: fs.FSWatcher | null;
  stalenessTimer: ReturnType<typeof setInterval> | null;
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

export class TmuxConnector {
  private readonly activeSessions = new Map<string, ActiveSession>();
  private readonly readFileSyncFn: (path: string, encoding: BufferEncoding) => string;
  private readonly readdirSyncFn: (dirPath: string) => string[];

  constructor(private readonly deps: TmuxConnectorDeps) {
    this.readFileSyncFn = deps.readFileSync ?? ((p, enc) => fs.readFileSync(p, enc));
    this.readdirSyncFn = deps.readdirSync ?? ((p) => fs.readdirSync(p));
  }

  /**
   * Spawns a new managed tmux session.
   * 1. Validates tmux availability
   * 2. Generates the wrapper script
   * 3. Starts fs.watch watchers (BEFORE session launch to avoid race)
   * 4. Creates the tmux session running the wrapper
   * 5. Starts the staleness timer
   */
  spawn(config: TmuxSpawnConfig, callbacks: SpawnCallbacks): Result<TmuxHandle, AutobeatError> {
    // 1. Validate tmux
    const validationResult = this.deps.validator.validate();
    if (!validationResult.ok) return validationResult;

    // 2. Generate wrapper
    const manifestResult = this.deps.hooks.generateWrapper({
      taskId: config.taskId,
      agent: 'claude',
      sessionsDir: config.sessionsDir,
      agentCommand: config.command,
      agentArgs: [],
    });
    if (!manifestResult.ok) return manifestResult;
    const manifest = manifestResult.value;

    // Build the internal session state (before launching, to set up watchers first)
    const session: ActiveSession = {
      handle: {
        sessionName: config.name,
        taskId: config.taskId,
        sessionsDir: config.sessionsDir,
      },
      sentinelWatcher: null,
      messagesWatcher: null,
      stalenessTimer: null,
      exited: false,
      lastDeliveredSeq: 0,
      pendingMessages: new Map(),
      nextExpectedSeq: 1,
      debounceTimers: new Map(),
      messagesDir: manifest.messagesDir,
      callbacks,
      flushing: false,
    };

    // 3. Start fs.watch watchers (BEFORE session launch to avoid race)
    this.startWatchers(session, config.taskId, manifest.sessionsDir, manifest.messagesDir, callbacks);

    // 4. Create tmux session running the wrapper
    const sessionResult = this.deps.sessionManager.createSession({
      ...config,
      command: manifest.wrapperPath,
    });
    if (!sessionResult.ok) {
      // Clean up watchers and generated session directory on failure
      this.closeSession(session);
      this.deps.hooks.cleanup(config.taskId, config.sessionsDir);
      return sessionResult;
    }

    // Update handle with the actual session handle details
    session.handle = {
      ...session.handle,
      sessionName: sessionResult.value.sessionName,
    };

    // 5. Start staleness timer
    const stalenessConfig: StalenessConfig = {
      ...DEFAULT_STALENESS_CONFIG,
      ...config.staleness,
    };
    this.startStalenessTimer(session, config.taskId, stalenessConfig, callbacks);

    this.activeSessions.set(config.taskId, session);
    return ok(session.handle);
  }

  /**
   * Destroys a session and cleans up all watchers and timers.
   * Idempotent.
   */
  destroy(handle: TmuxHandle): Result<void, AutobeatError> {
    const session = this.activeSessions.get(handle.taskId);
    if (session) {
      // Set exited before flush so late staleness timer ticks cannot trigger
      // onExit after we have already destroyed the session.
      session.exited = true;
      this.flushPendingFiles(session);
      this.closeSession(session);
      this.activeSessions.delete(handle.taskId);
    }
    return this.deps.sessionManager.destroySession(handle.sessionName);
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
    for (const session of sessions) {
      // Set exited before flush so late staleness timer ticks that fire during
      // teardown see session.exited = true and return early.
      session.exited = true;
      this.flushPendingFiles(session);
      this.closeSession(session);
      const result = this.deps.sessionManager.destroySession(session.handle.sessionName);
      if (!result.ok) {
        this.deps.logger.warn('dispose: failed to destroy session', {
          sessionName: session.handle.sessionName,
          error: result.error.message,
        });
      }
    }
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  /**
   * Starts the sentinel and messages fs.watch watchers for a session.
   * Called BEFORE session launch so we never miss events from a fast-exiting agent.
   */
  private startWatchers(
    session: ActiveSession,
    taskId: string,
    sessionDir: string,
    messagesDir: string,
    callbacks: SpawnCallbacks,
  ): void {
    // Sentinel watcher — detects .done / .exit files written by the wrapper
    try {
      session.sentinelWatcher = this.deps.watch(
        sessionDir,
        { persistent: false },
        (_eventType: string, filename: string | null) => {
          if (!filename) return;
          if (filename === '.done' || filename === '.exit') {
            this.handleSentinel(taskId, sessionDir, filename, callbacks);
          }
        },
      );
    } catch {
      // Directory may not exist yet — sentinel detection degrades gracefully
      this.deps.logger.warn('Failed to start sentinel watcher', { taskId, sessionDir });
    }

    // Messages watcher — picks up output message JSON files
    try {
      session.messagesWatcher = this.deps.watch(
        messagesDir,
        { persistent: false },
        (_eventType: string, filename: string | null) => {
          if (!filename) return;
          // Ignore temp files and non-JSON
          if (filename.endsWith('.tmp')) return;
          if (!filename.endsWith('.json')) return;

          // Debounce double-fires for the same file
          const existing = session.debounceTimers.get(filename);
          if (existing) clearTimeout(existing);
          const timer = setTimeout(() => {
            session.debounceTimers.delete(filename);
            this.handleMessageFile(path.join(messagesDir, filename), session, callbacks);
          }, DEBOUNCE_MS);
          session.debounceTimers.set(filename, timer);
        },
      );
    } catch {
      this.deps.logger.warn('Failed to start messages watcher', { taskId, messagesDir });
    }
  }

  /**
   * Starts the staleness detection timer for a session.
   * Fires onExit(null, 'STALE') when the tmux session disappears without a sentinel.
   */
  private startStalenessTimer(
    session: ActiveSession,
    taskId: string,
    stalenessConfig: StalenessConfig,
    callbacks: SpawnCallbacks,
  ): void {
    let lastAliveCheck = Date.now();
    session.stalenessTimer = setInterval(() => {
      // closeSession() clears the timer; this guard handles any in-flight tick
      if (session.exited) return;

      const aliveResult = this.deps.sessionManager.isAlive(session.handle.sessionName);

      if (!aliveResult.ok) {
        // Transient exec error — cannot confirm dead; do not advance or reset timer.
        // Only confirmed-dead (ok(false)) triggers stale detection.
        this.deps.logger.warn('isAlive check failed — transient error, skipping', {
          sessionName: session.handle.sessionName,
          error: aliveResult.error.message,
        });
        return;
      }

      if (aliveResult.value) {
        // Confirmed alive — update the alive timestamp.
        lastAliveCheck = Date.now();
        return;
      }

      // Confirmed dead: session is gone. Check if it has been silent long enough.
      const silentMs = Date.now() - lastAliveCheck;
      if (silentMs >= stalenessConfig.maxSilenceMs) {
        this.deps.logger.warn('Session stale — no heartbeat detected', {
          sessionName: session.handle.sessionName,
          silentMs,
        });
        this.triggerExit(taskId, session, null, 'STALE', callbacks);
      }
    }, stalenessConfig.checkIntervalMs);
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
        const filePath = path.join(session.messagesDir, filename);
        let parsed: unknown;
        try {
          const raw = this.readFileSyncFn(filePath, 'utf8');
          parsed = JSON.parse(raw);
        } catch {
          this.deps.logger.warn('Flush: failed to parse message file', { filePath });
          continue;
        }

        if (!isOutputMessage(parsed)) {
          continue;
        }

        const msg = parsed;
        if (msg.sequence <= session.lastDeliveredSeq) continue;
        session.pendingMessages.set(msg.sequence, msg);
      }

      // Deliver consecutive messages from nextExpectedSeq
      this.deliverPendingMessages(session, session.callbacks);

      // Force-deliver any remaining out-of-order messages (no more will arrive)
      if (session.pendingMessages.size > 0) {
        const sortedSeqs = Array.from(session.pendingMessages.keys()).sort((a, b) => a - b);
        session.nextExpectedSeq = sortedSeqs[0]!;
        this.deliverPendingMessages(session, session.callbacks);
      }
    } finally {
      session.flushing = false;
    }
  }

  private handleSentinel(taskId: string, sessionDir: string, filename: string, callbacks: SpawnCallbacks): void {
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
    this.triggerExit(taskId, session, exitCode, undefined, callbacks);
  }

  private handleMessageFile(filePath: string, session: ActiveSession, callbacks: SpawnCallbacks): void {
    if (session.exited) return;

    let parsed: unknown;
    try {
      const raw = this.readFileSyncFn(filePath, 'utf8');
      parsed = JSON.parse(raw);
    } catch {
      this.deps.logger.warn('Failed to parse output message file', { filePath });
      return;
    }

    if (!isOutputMessage(parsed)) {
      this.deps.logger.warn('Output message missing required fields', { filePath });
      return;
    }

    const msg = parsed;

    // Buffer for ordered delivery
    session.pendingMessages.set(msg.sequence, msg);

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
   * Delivers all consecutive pending messages starting from session.nextExpectedSeq.
   * Uses lastDeliveredSeq as a monotonic watermark to prevent duplicate delivery.
   */
  private deliverPendingMessages(session: ActiveSession, callbacks: SpawnCallbacks): void {
    while (session.pendingMessages.has(session.nextExpectedSeq)) {
      const msg = session.pendingMessages.get(session.nextExpectedSeq)!;
      session.pendingMessages.delete(session.nextExpectedSeq);
      if (msg.sequence > session.lastDeliveredSeq) {
        session.lastDeliveredSeq = msg.sequence;
        callbacks.onOutput(msg);
      }
      session.nextExpectedSeq++;
    }
  }

  private triggerExit(
    taskId: string,
    session: ActiveSession,
    code: number | null,
    signal: string | undefined,
    callbacks: SpawnCallbacks,
  ): void {
    if (session.exited) return;

    // Set exited BEFORE flushPendingFiles so that any in-flight staleness timer
    // tick that fires during the flush sees session.exited = true and returns
    // early, preventing a double onExit call.
    session.exited = true;
    this.flushPendingFiles(session);
    this.closeSession(session);
    this.activeSessions.delete(taskId);
    callbacks.onExit(code, signal);
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
    if (session.stalenessTimer) {
      clearInterval(session.stalenessTimer);
      session.stalenessTimer = null;
    }
    // Clear any pending debounce timers
    for (const timer of session.debounceTimers.values()) {
      clearTimeout(timer);
    }
    session.debounceTimers.clear();
  }
}
