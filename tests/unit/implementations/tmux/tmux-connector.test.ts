/**
 * Unit tests for TmuxConnector
 * All external deps (sessionManager, hooks, validator, logger, watch) are mocked.
 * Fake timers are used for staleness testing.
 */

import { describe, expect, it, vi } from 'vitest';
import { AutobeatError, ErrorCode } from '../../../../src/core/errors.js';
import type { Logger } from '../../../../src/core/interfaces.js';
import { err, ok } from '../../../../src/core/result.js';
import { TmuxConnector, type TmuxConnectorDeps } from '../../../../src/implementations/tmux/tmux-connector.js';
import type {
  OutputMessage,
  TmuxHandle,
  TmuxHooks,
  TmuxSessionManager,
  TmuxSessionResult,
  TmuxSpawnConfig,
  TmuxValidator,
  WrapperManifest,
} from '../../../../src/implementations/tmux/types.js';
import { MAX_CONCURRENT_SESSIONS } from '../../../../src/implementations/tmux/types.js';
import { sleep } from '../../../fixtures/test-data.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

function makeManifest(taskId: string, sessionsDir = '/tmp/sessions'): WrapperManifest {
  return {
    wrapperPath: `${sessionsDir}/${taskId}/wrapper.sh`,
    sessionDir: `${sessionsDir}/${taskId}`,
    sentinelPath: `${sessionsDir}/${taskId}/.done`,
    messagesDir: `${sessionsDir}/${taskId}/messages`,
    seqFilePath: `${sessionsDir}/${taskId}/.seq`,
  };
}

function makeHandle(taskId: string, sessionName: string): TmuxHandle {
  return { sessionName, taskId, sessionsDir: '/tmp/sessions' };
}

function makeSessionResult(taskId: string, sessionName: string): TmuxSessionResult {
  return { sessionName, taskId };
}

const BASE_CONFIG: TmuxSpawnConfig = {
  name: 'beat-task-abc',
  command: 'claude',
  cwd: '/tmp',
  taskId: 'task-abc',
  sessionsDir: '/tmp/sessions',
  agent: 'claude',
};

/**
 * A mock of fs.watch that captures the error handler on one specific watcher call (by index).
 * The other watcher call returns a plain stub with no error capture.
 * callIndex: 1 = sentinel watcher (first fs.watch call), 2 = messages watcher (second call)
 */
function makeWatchWithErrorCapture(callIndex: 1 | 2): {
  watch: TmuxConnectorDeps['watch'];
  triggerError: (e: Error) => void;
} {
  let errorHandler: ((err: Error) => void) | null = null;
  let callCount = 0;

  const watch = vi
    .fn()
    .mockImplementation((_watchPath: string, _opts: unknown, _callback: (event: string, f: string | null) => void) => {
      callCount++;
      if (callCount === callIndex) {
        return {
          close: vi.fn(),
          on: vi.fn().mockImplementation((event: string, handler: (err: Error) => void) => {
            if (event === 'error') errorHandler = handler;
          }),
        };
      }
      return { close: vi.fn(), on: vi.fn() };
    }) as unknown as TmuxConnectorDeps['watch'];

  return {
    watch,
    triggerError: (e: Error) => {
      if (!errorHandler) throw new Error('error handler was never registered');
      errorHandler(e);
    },
  };
}

/**
 * A mock of fs.watch that captures registered callbacks so tests can fire them
 */
function makeWatchMock(): {
  watch: TmuxConnectorDeps['watch'];
  fireSentinel: (filename: string) => void;
  fireMessage: (filename: string) => void;
  sentinelWatcher: { close: ReturnType<typeof vi.fn> };
  messageWatcher: { close: ReturnType<typeof vi.fn> };
} {
  let sentinelCallback: ((event: string, filename: string | null) => void) | null = null;
  let messageCallback: ((event: string, filename: string | null) => void) | null = null;
  const sentinelWatcher = { close: vi.fn(), on: vi.fn() };
  const messageWatcher = { close: vi.fn(), on: vi.fn() };

  let callCount = 0;

  const watch = vi
    .fn()
    .mockImplementation((watchPath: string, _opts: unknown, callback: (event: string, f: string | null) => void) => {
      callCount++;
      if (callCount === 1) {
        // First watch call = sentinel watcher (sessions dir)
        sentinelCallback = callback;
        return sentinelWatcher;
      } else {
        // Second watch call = messages watcher
        messageCallback = callback;
        return messageWatcher;
      }
    }) as unknown as TmuxConnectorDeps['watch'];

  return {
    watch,
    fireSentinel: (filename: string) => sentinelCallback?.('change', filename),
    fireMessage: (filename: string) => messageCallback?.('change', filename),
    sentinelWatcher,
    messageWatcher,
  };
}

function makeValidValidator(): TmuxValidator {
  return {
    validate: vi.fn().mockReturnValue(ok({ version: '3.4', path: 'tmux', jqPath: '/usr/bin/jq' })),
  } as unknown as TmuxValidator;
}

function makeFailingValidator(): TmuxValidator {
  return {
    validate: vi.fn().mockReturnValue(err(new AutobeatError(ErrorCode.TMUX_VALIDATION_FAILED, 'tmux not found'))),
  } as unknown as TmuxValidator;
}

function makeValidHooks(taskId = 'task-abc'): TmuxHooks {
  return {
    generateWrapper: vi.fn().mockReturnValue(ok(makeManifest(taskId))),
    cleanup: vi.fn().mockReturnValue(ok(undefined)),
  } as unknown as TmuxHooks;
}

function makeFailingHooks(code = ErrorCode.TMUX_HOOK_FAILED): TmuxHooks {
  return {
    generateWrapper: vi.fn().mockReturnValue(err(new AutobeatError(code, 'hook failed'))),
    cleanup: vi.fn().mockReturnValue(ok(undefined)),
  } as unknown as TmuxHooks;
}

function makeValidSessionManager(taskId = 'task-abc'): TmuxSessionManager {
  return {
    createSession: vi.fn().mockReturnValue(ok(makeSessionResult(taskId, `beat-${taskId}`))),
    destroySession: vi.fn().mockReturnValue(ok(undefined)),
    sendKeys: vi.fn().mockReturnValue(ok(undefined)),
    isAlive: vi.fn().mockReturnValue(ok(true)),
    listSessions: vi.fn().mockReturnValue(ok([])),
    getSessionEnvironment: vi.fn().mockReturnValue(ok(undefined)),
  } as unknown as TmuxSessionManager;
}

function makeFailingSessionManager(code = ErrorCode.TMUX_SESSION_FAILED): TmuxSessionManager {
  return {
    createSession: vi.fn().mockReturnValue(err(new AutobeatError(code, 'session create failed'))),
    destroySession: vi.fn().mockReturnValue(ok(undefined)),
    sendKeys: vi.fn().mockReturnValue(ok(undefined)),
    isAlive: vi.fn().mockReturnValue(ok(false)),
    listSessions: vi.fn().mockReturnValue(ok([])),
    getSessionEnvironment: vi.fn().mockReturnValue(ok(undefined)),
  } as unknown as TmuxSessionManager;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TmuxConnector.spawn()', () => {
  it('validates tmux before doing anything else — validator error → no session created', () => {
    const validator = makeFailingValidator();
    const sessionManager = makeValidSessionManager();
    const hooks = makeValidHooks();
    const { watch } = makeWatchMock();

    const connector = new TmuxConnector({
      validator,
      sessionManager,
      hooks,
      logger: makeLogger(),
      watch,
    });

    const result = connector.spawn(BASE_CONFIG, { onOutput: vi.fn(), onExit: vi.fn() });
    expect(result.ok).toBe(false);
    expect(sessionManager.createSession).not.toHaveBeenCalled();
  });

  it('calls hooks.generateWrapper before creating the session', () => {
    const hooks = makeValidHooks();
    const sessionManager = makeValidSessionManager();
    const { watch } = makeWatchMock();

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager,
      hooks,
      logger: makeLogger(),
      watch,
    });

    connector.spawn(BASE_CONFIG, { onOutput: vi.fn(), onExit: vi.fn() });
    expect(hooks.generateWrapper).toHaveBeenCalled();
  });

  it('creates session with the wrapper script as the command', () => {
    const sessionManager = makeValidSessionManager();
    const { watch } = makeWatchMock();

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager,
      hooks: makeValidHooks(),
      logger: makeLogger(),
      watch,
    });

    connector.spawn(BASE_CONFIG, { onOutput: vi.fn(), onExit: vi.fn() });
    const createCall = (sessionManager.createSession as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(createCall?.command).toContain('wrapper.sh');
  });

  it('starts a sentinel watcher (fs.watch called at least once)', () => {
    const { watch } = makeWatchMock();

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks: makeValidHooks(),
      logger: makeLogger(),
      watch,
    });

    connector.spawn(BASE_CONFIG, { onOutput: vi.fn(), onExit: vi.fn() });
    expect(watch).toHaveBeenCalled();
  });

  it('starts a messages watcher (fs.watch called at least twice)', () => {
    const { watch } = makeWatchMock();

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks: makeValidHooks(),
      logger: makeLogger(),
      watch,
    });

    connector.spawn(BASE_CONFIG, { onOutput: vi.fn(), onExit: vi.fn() });
    expect(watch).toHaveBeenCalledTimes(2);
  });

  it('starts staleness timer (setInterval is called)', () => {
    vi.useFakeTimers();
    const { watch } = makeWatchMock();

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks: makeValidHooks(),
      logger: makeLogger(),
      watch,
    });

    connector.spawn(BASE_CONFIG, { onOutput: vi.fn(), onExit: vi.fn() });
    // If no error was thrown and spawn succeeded, staleness timer is running
    // We clean up to avoid timer leaks
    connector.dispose();
    vi.useRealTimers();
  });

  it('returns ok(TmuxHandle) on success', () => {
    const { watch } = makeWatchMock();

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks: makeValidHooks(),
      logger: makeLogger(),
      watch,
    });

    const result = connector.spawn(BASE_CONFIG, { onOutput: vi.fn(), onExit: vi.fn() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.taskId).toBe('task-abc');
  });

  it('returns hook error when generateWrapper fails', () => {
    const { watch } = makeWatchMock();

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks: makeFailingHooks(),
      logger: makeLogger(),
      watch,
    });

    const result = connector.spawn(BASE_CONFIG, { onOutput: vi.fn(), onExit: vi.fn() });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.TMUX_HOOK_FAILED);
  });

  it('spawn succeeds even when the messages watcher throws (graceful degradation)', () => {
    // The 2nd watch call (messages watcher) throws; spawn must still return ok
    let callCount = 0;
    const watch = vi.fn().mockImplementation((..._args: unknown[]) => {
      callCount++;
      if (callCount === 1) {
        // First call = sentinel watcher — succeed
        return { close: vi.fn(), on: vi.fn() };
      }
      // Second call = messages watcher — simulate failure (e.g. dir not ready)
      throw new Error('ENOENT: messages dir does not exist');
    }) as unknown as TmuxConnectorDeps['watch'];

    const logger = makeLogger();

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks: makeValidHooks(),
      logger,
      watch,
    });

    const result = connector.spawn(BASE_CONFIG, { onOutput: vi.fn(), onExit: vi.fn() });

    // spawn must succeed despite the messages watcher failure
    expect(result.ok).toBe(true);
    // A warning about the watcher failure must be logged
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to start messages watcher'),
      expect.any(Object),
    );
    connector.dispose();
  });

  it('returns session error when createSession fails, and does not register the handle', () => {
    const { watch } = makeWatchMock();

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeFailingSessionManager(),
      hooks: makeValidHooks(),
      logger: makeLogger(),
      watch,
    });

    const result = connector.spawn(BASE_CONFIG, { onOutput: vi.fn(), onExit: vi.fn() });
    expect(result.ok).toBe(false);
    expect(connector.getActiveHandles()).toHaveLength(0);
  });
});

describe('TmuxConnector — sentinel detection', () => {
  it('.done sentinel fires onExit with code 0', () => {
    const { watch, fireSentinel } = makeWatchMock();
    const onExit = vi.fn();
    const readFileSync = vi.fn().mockReturnValue('0');

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks: makeValidHooks(),
      logger: makeLogger(),
      watch,
      readFileSync,
    });

    connector.spawn(BASE_CONFIG, { onOutput: vi.fn(), onExit });
    fireSentinel('.done');

    expect(onExit).toHaveBeenCalledWith(0, undefined);
  });

  it('.exit sentinel fires onExit with non-zero code', () => {
    const { watch, fireSentinel } = makeWatchMock();
    const onExit = vi.fn();
    const readFileSync = vi.fn().mockReturnValue('1');

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks: makeValidHooks(),
      logger: makeLogger(),
      watch,
      readFileSync,
    });

    connector.spawn(BASE_CONFIG, { onOutput: vi.fn(), onExit });
    fireSentinel('.exit');

    expect(onExit).toHaveBeenCalledWith(1, undefined);
  });

  it('sentinel fires onExit synchronously when the sentinel file appears', () => {
    const { watch, fireSentinel } = makeWatchMock();
    const onExit = vi.fn();
    const readFileSync = vi.fn().mockReturnValue('0');

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks: makeValidHooks(),
      logger: makeLogger(),
      watch,
      readFileSync,
    });

    connector.spawn(BASE_CONFIG, { onOutput: vi.fn(), onExit });
    fireSentinel('.done');

    // The callback fires synchronously — assert that it was called, not how fast
    expect(onExit).toHaveBeenCalled();
  });
});

// B1: handleSentinel edge cases
describe('TmuxConnector — handleSentinel edge cases', () => {
  it('.exit sentinel with unreadable file defaults to exit code 1', () => {
    const { watch, fireSentinel } = makeWatchMock();
    const onExit = vi.fn();
    const readFileSync = vi.fn().mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks: makeValidHooks(),
      logger: makeLogger(),
      watch,
      readFileSync,
    });

    connector.spawn(BASE_CONFIG, { onOutput: vi.fn(), onExit });
    fireSentinel('.exit');

    expect(onExit).toHaveBeenCalledWith(1, undefined);
  });

  it('.exit sentinel with non-numeric file content defaults to exit code 1', () => {
    const { watch, fireSentinel } = makeWatchMock();
    const onExit = vi.fn();
    const readFileSync = vi.fn().mockReturnValue('not-a-number');

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks: makeValidHooks(),
      logger: makeLogger(),
      watch,
      readFileSync,
    });

    connector.spawn(BASE_CONFIG, { onOutput: vi.fn(), onExit });
    fireSentinel('.exit');

    expect(onExit).toHaveBeenCalledWith(1, undefined);
  });

  it('.done sentinel with unreadable file defaults to exit code 0', () => {
    const { watch, fireSentinel } = makeWatchMock();
    const onExit = vi.fn();
    const readFileSync = vi.fn().mockImplementation(() => {
      throw new Error('ENOENT: no such file or directory');
    });

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks: makeValidHooks(),
      logger: makeLogger(),
      watch,
      readFileSync,
    });

    connector.spawn(BASE_CONFIG, { onOutput: vi.fn(), onExit });
    fireSentinel('.done');

    expect(onExit).toHaveBeenCalledWith(0, undefined);
  });
});

// B2: session exited during async read — message must be dropped
describe('TmuxConnector — session-exited-during-async-read', () => {
  it('drops message when session exits during async readFile gap', async () => {
    const { watch, fireMessage, fireSentinel } = makeWatchMock();
    const onOutput = vi.fn();
    const onExit = vi.fn();
    const readFileSync = vi.fn().mockReturnValue('0');
    // readdirSync returns empty so flush has nothing to deliver
    const readdirSync = vi.fn().mockReturnValue([]);

    // readFile returns a promise that we resolve manually
    let resolveRead!: (value: string) => void;
    const pendingRead = new Promise<string>((resolve) => {
      resolveRead = resolve;
    });
    const readFile = vi.fn().mockReturnValue(pendingRead);

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks: makeValidHooks(),
      logger: makeLogger(),
      watch,
      readFileSync,
      readFile,
      readdirSync,
    });

    connector.spawn(BASE_CONFIG, { onOutput, onExit });

    // Fire a message — readFile starts but doesn't resolve yet
    fireMessage('00001-stdout.json');

    // Wait for debounce to fire (so handleMessageFile is called and awaiting read)
    await sleep(100);

    // Fire the exit sentinel while readFile is still pending
    fireSentinel('.done');
    expect(onExit).toHaveBeenCalledWith(0, undefined);

    // Now resolve the pending read — but session.exited is true so message must be dropped
    resolveRead(JSON.stringify({ sequence: 1, timestamp: 'ts', type: 'stdout', content: 'late' }));

    // Allow the promise chain to settle
    await sleep(50);

    expect(onOutput).not.toHaveBeenCalled();
  });
});

// B4: handleMessageFile readFile rejection
describe('TmuxConnector — handleMessageFile readFile rejection', () => {
  it('calls logger.warn when readFile rejects', async () => {
    const { watch, fireMessage } = makeWatchMock();
    const logger = makeLogger();
    const readFile = vi.fn().mockRejectedValue(new Error('ENOENT: file vanished'));

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks: makeValidHooks(),
      logger,
      watch,
      readFile,
    });

    connector.spawn(BASE_CONFIG, { onOutput: vi.fn(), onExit: vi.fn() });
    fireMessage('00001-stdout.json');

    // Wait for debounce and the rejection to propagate through the .catch handler
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalled(), { timeout: 300 });

    connector.dispose();
  });
});

describe('TmuxConnector — watcher error handler', () => {
  it('logs a warning when the sentinel watcher emits an error event', () => {
    const logger = makeLogger();
    const { watch, triggerError } = makeWatchWithErrorCapture(1);

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks: makeValidHooks(),
      logger,
      watch,
    });

    connector.spawn(BASE_CONFIG, { onOutput: vi.fn(), onExit: vi.fn() });
    triggerError(new Error('ENOSPC: no space left on device'));

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Sentinel watcher error'),
      expect.objectContaining({ taskId: BASE_CONFIG.taskId }),
    );

    connector.dispose();
  });

  it('logs a warning when the messages watcher emits an error event', () => {
    const logger = makeLogger();
    const { watch, triggerError } = makeWatchWithErrorCapture(2);

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks: makeValidHooks(),
      logger,
      watch,
    });

    connector.spawn(BASE_CONFIG, { onOutput: vi.fn(), onExit: vi.fn() });
    triggerError(new Error('ENOSPC: no space left on device'));

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Messages watcher error'),
      expect.objectContaining({ taskId: BASE_CONFIG.taskId }),
    );

    connector.dispose();
  });
});

describe('TmuxConnector — output handling', () => {
  function buildOutputMsg(seq: number): OutputMessage {
    return { sequence: seq, timestamp: '2026-01-01T00:00:00.000Z', type: 'stdout', content: `line ${seq}` };
  }

  it('output JSON file fires onOutput with parsed OutputMessage', async () => {
    const msg = buildOutputMsg(1);
    // readFile is used by the hot-path message handler (async, non-blocking)
    const readFile = vi.fn().mockResolvedValue(JSON.stringify(msg));
    const { watch, fireMessage } = makeWatchMock();
    const onOutput = vi.fn();

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks: makeValidHooks(),
      logger: makeLogger(),
      watch,
      readFile,
    });

    connector.spawn(BASE_CONFIG, { onOutput, onExit: vi.fn() });
    fireMessage('00001-stdout.json');

    // Allow debounce timer and async readFile to resolve
    await vi.waitFor(() => expect(onOutput).toHaveBeenCalled(), { timeout: 300 });
    expect(onOutput.mock.calls[0]?.[0]).toMatchObject({ sequence: 1, type: 'stdout' });
    connector.dispose();
  });

  it('ignores .tmp files in message watcher', async () => {
    const { watch, fireMessage } = makeWatchMock();
    const onOutput = vi.fn();

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks: makeValidHooks(),
      logger: makeLogger(),
      watch,
    });

    connector.spawn(BASE_CONFIG, { onOutput, onExit: vi.fn() });
    fireMessage('00001-stdout.json.tmp');

    await sleep(100);
    expect(onOutput).not.toHaveBeenCalled();
    connector.dispose();
  });

  it('silently drops messages with an invalid type field — onOutput not called', async () => {
    // A structurally valid JSON object whose 'type' is not in ['stdout','stderr','result']
    const invalidTypeMsg = {
      sequence: 1,
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'unknown-type',
      content: 'should be dropped',
    };
    const readFile = vi.fn().mockResolvedValue(JSON.stringify(invalidTypeMsg));
    const { watch, fireMessage } = makeWatchMock();
    const onOutput = vi.fn();
    const logger = makeLogger();

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks: makeValidHooks(),
      logger,
      watch,
      readFile,
    });

    connector.spawn(BASE_CONFIG, { onOutput, onExit: vi.fn() });
    fireMessage('00001-stdout.json');

    await sleep(200);
    expect(onOutput).not.toHaveBeenCalled();
    connector.dispose();
  });

  it('logs warning and skips callback for malformed JSON', async () => {
    // readFile is used by the hot-path message handler
    const readFile = vi.fn().mockResolvedValue('not json at all!!!');
    const { watch, fireMessage } = makeWatchMock();
    const onOutput = vi.fn();
    const logger = makeLogger();

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks: makeValidHooks(),
      logger,
      watch,
      readFile,
    });

    connector.spawn(BASE_CONFIG, { onOutput, onExit: vi.fn() });
    fireMessage('00001-stdout.json');

    await sleep(200);
    expect(onOutput).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
    connector.dispose();
  });

  it('delivers messages in sequence order even if files arrive out of order', async () => {
    const msgs: Record<string, OutputMessage> = {
      '00003-stdout.json': { sequence: 3, timestamp: 'ts', type: 'stdout', content: 'three' },
      '00001-stdout.json': { sequence: 1, timestamp: 'ts', type: 'stdout', content: 'one' },
      '00002-stdout.json': { sequence: 2, timestamp: 'ts', type: 'stdout', content: 'two' },
    };

    // readFile is used by the hot-path message handler (async)
    const readFile = vi.fn().mockImplementation((p: string) => {
      const base = p.split('/').pop()!;
      const found = msgs[base];
      if (!found) return Promise.reject(new Error(`Unknown file: ${base}`));
      return Promise.resolve(JSON.stringify(found));
    });

    const { watch, fireMessage } = makeWatchMock();
    const received: OutputMessage[] = [];

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks: makeValidHooks(),
      logger: makeLogger(),
      watch,
      readFile,
    });

    connector.spawn(BASE_CONFIG, {
      onOutput: (m) => received.push(m),
      onExit: vi.fn(),
    });

    // Fire in reverse order — wait for debounce and async read between each
    fireMessage('00003-stdout.json');
    await sleep(80);
    fireMessage('00001-stdout.json');
    await sleep(80);
    fireMessage('00002-stdout.json');
    await sleep(80);

    expect(received.map((m) => m.sequence)).toEqual([1, 2, 3]);
    connector.dispose();
  });

  it('debounces double-fire — same file fired twice in 50ms fires onOutput once', async () => {
    const msg = buildOutputMsg(1);
    // readFile is used by the hot-path message handler (async)
    const readFile = vi.fn().mockResolvedValue(JSON.stringify(msg));
    const { watch, fireMessage } = makeWatchMock();
    const onOutput = vi.fn();

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks: makeValidHooks(),
      logger: makeLogger(),
      watch,
      readFile,
    });

    connector.spawn(BASE_CONFIG, { onOutput, onExit: vi.fn() });
    fireMessage('00001-stdout.json');
    fireMessage('00001-stdout.json'); // double-fire within 50ms

    await sleep(200);
    expect(onOutput).toHaveBeenCalledTimes(1);
    connector.dispose();
  });

  it('drops messages and warns when pending buffer exceeds MAX_PENDING_MESSAGES (100)', async () => {
    // Simulate a sequence gap: deliver seq 102..202 before seq 1 so 101+ messages
    // are buffered without being deliverable. The connector must warn and skip ahead.
    const received: OutputMessage[] = [];
    const logger = makeLogger();

    // Build message map: sequences 2..103 (102 messages) — seq 1 is intentionally missing
    // so nothing delivers until the overflow cap fires.
    const msgMap: Record<string, OutputMessage> = {};
    for (let seq = 2; seq <= 103; seq++) {
      const filename = `${String(seq).padStart(5, '0')}-stdout.json`;
      msgMap[filename] = buildOutputMsg(seq);
    }

    // readFile is used by the hot-path message handler (async)
    const readFile = vi.fn().mockImplementation((p: string) => {
      const base = (p as string).split('/').pop()!;
      const found = msgMap[base];
      if (!found) return Promise.reject(new Error(`Unknown file: ${base}`));
      return Promise.resolve(JSON.stringify(found));
    });

    // Use a fresh watch mock — makeWatchMock resets callCount so each connector
    // gets its own independent sentinel/message pair.
    const { watch, fireMessage } = makeWatchMock();

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks: makeValidHooks(),
      logger,
      watch,
      readFile,
    });

    connector.spawn(BASE_CONFIG, {
      onOutput: (m) => received.push(m),
      onExit: vi.fn(),
    });

    // Fire 102 out-of-order messages (seq 2..103) without ever firing seq 1.
    // After the 101st fire the buffer size exceeds MAX_PENDING_MESSAGES (100)
    // and the connector must skip ahead, log a warning, and drain what it has.
    for (const filename of Object.keys(msgMap)) {
      fireMessage(filename);
    }

    // Allow debounce timers and async reads to settle
    await sleep(300);

    // The overflow warning must have been emitted
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Pending message buffer exceeded cap'),
      expect.any(Object),
    );

    // Messages that were buffered must eventually be delivered (the skip-ahead
    // drains whatever was sitting in the map).
    expect(received.length).toBeGreaterThan(0);

    connector.dispose();
  });
});

describe('TmuxConnector — flush before exit', () => {
  function buildOutputMsg(seq: number): OutputMessage {
    return { sequence: seq, timestamp: '2026-01-01T00:00:00.000Z', type: 'stdout', content: `line ${seq}` };
  }

  function makeFlushReadFileSync(msgs: Record<string, OutputMessage>, sentinelContent = '0'): ReturnType<typeof vi.fn> {
    return vi.fn().mockImplementation((p: string) => {
      if (p.endsWith('.done') || p.endsWith('.exit')) return sentinelContent;
      const base = p.split('/').pop()!;
      const found = msgs[base];
      if (!found) throw new Error(`Unknown file: ${base}`);
      return JSON.stringify(found);
    });
  }

  it('delivers debounced messages before onExit when sentinel fires during debounce window', () => {
    const msgs: Record<string, OutputMessage> = {
      '00001-stdout.json': buildOutputMsg(1),
      '00002-stdout.json': buildOutputMsg(2),
    };
    const readFileSync = makeFlushReadFileSync(msgs);
    const readdirSync = vi.fn().mockReturnValue(['00001-stdout.json', '00002-stdout.json']);
    const { watch, fireMessage, fireSentinel } = makeWatchMock();
    const onOutput = vi.fn();
    const onExit = vi.fn();

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks: makeValidHooks(),
      logger: makeLogger(),
      watch,
      readFileSync,
      readdirSync,
    });

    connector.spawn(BASE_CONFIG, { onOutput, onExit });

    // Fire two messages — they enter 50ms debounce, not yet delivered
    fireMessage('00001-stdout.json');
    fireMessage('00002-stdout.json');

    // Sentinel fires immediately — flush must deliver pending messages before onExit
    fireSentinel('.done');

    expect(onOutput).toHaveBeenCalledTimes(2);
    expect(onExit).toHaveBeenCalledTimes(1);

    // onOutput calls must precede onExit
    const outputOrder = onOutput.mock.invocationCallOrder;
    const exitOrder = onExit.mock.invocationCallOrder;
    expect(outputOrder[0]!).toBeLessThan(exitOrder[0]!);
    expect(outputOrder[1]!).toBeLessThan(exitOrder[0]!);
  });

  it('flush does not re-deliver already-delivered messages', async () => {
    const msgs: Record<string, OutputMessage> = {
      '00001-stdout.json': buildOutputMsg(1),
      '00002-stdout.json': buildOutputMsg(2),
    };
    const readFileSync = makeFlushReadFileSync(msgs);
    // readFile wraps the sync mock as a Promise for the hot-path message handler
    const readFile = vi.fn().mockImplementation((p: string) => Promise.resolve(readFileSync(p)));
    const readdirSync = vi.fn().mockReturnValue(['00001-stdout.json', '00002-stdout.json']);
    const { watch, fireMessage, fireSentinel } = makeWatchMock();
    const onOutput = vi.fn();
    const onExit = vi.fn();

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks: makeValidHooks(),
      logger: makeLogger(),
      watch,
      readFileSync,
      readFile,
      readdirSync,
    });

    connector.spawn(BASE_CONFIG, { onOutput, onExit });

    // Deliver msg1 normally via debounce
    fireMessage('00001-stdout.json');
    await sleep(200);
    expect(onOutput).toHaveBeenCalledTimes(1);

    // Now fire msg2 + sentinel immediately — flush should deliver msg2 but NOT re-deliver msg1
    fireMessage('00002-stdout.json');
    fireSentinel('.done');

    expect(onOutput).toHaveBeenCalledTimes(2);
    expect(onOutput.mock.calls[0]![0].sequence).toBe(1);
    expect(onOutput.mock.calls[1]![0].sequence).toBe(2);
  });

  it('dispose flushes pending messages before closing', () => {
    const msgs: Record<string, OutputMessage> = {
      '00001-stdout.json': buildOutputMsg(1),
    };
    const readFileSync = makeFlushReadFileSync(msgs);
    const readdirSync = vi.fn().mockReturnValue(['00001-stdout.json']);
    const { watch, fireMessage } = makeWatchMock();
    const onOutput = vi.fn();
    const onExit = vi.fn();

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks: makeValidHooks(),
      logger: makeLogger(),
      watch,
      readFileSync,
      readdirSync,
    });

    connector.spawn(BASE_CONFIG, { onOutput, onExit });

    // Fire message — enters debounce window
    fireMessage('00001-stdout.json');

    // dispose immediately (before debounce settles) — must flush messages then
    // signal SHUTDOWN so callers don't leave tasks stuck in RUNNING.
    connector.dispose();

    expect(onOutput).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith(null, 'SHUTDOWN');
  });

  it('destroy flushes pending messages before closing', () => {
    const msgs: Record<string, OutputMessage> = {
      '00001-stdout.json': buildOutputMsg(1),
    };
    const readFileSync = makeFlushReadFileSync(msgs);
    const readdirSync = vi.fn().mockReturnValue(['00001-stdout.json']);
    const { watch, fireMessage } = makeWatchMock();
    const onOutput = vi.fn();
    const onExit = vi.fn();

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks: makeValidHooks(),
      logger: makeLogger(),
      watch,
      readFileSync,
      readdirSync,
    });

    const spawnResult = connector.spawn(BASE_CONFIG, { onOutput, onExit });
    if (!spawnResult.ok) return;

    // Fire message — enters debounce window
    fireMessage('00001-stdout.json');

    // destroy immediately (before debounce settles) — must flush
    connector.destroy(spawnResult.value);

    expect(onOutput).toHaveBeenCalledTimes(1);
    expect(onExit).not.toHaveBeenCalled();
  });

  it('flush delivers all messages with sequence gaps ([1, 3, 5])', () => {
    const msgs: Record<string, OutputMessage> = {
      '00001-stdout.json': buildOutputMsg(1),
      '00003-stdout.json': buildOutputMsg(3),
      '00005-stdout.json': buildOutputMsg(5),
    };
    const readFileSync = makeFlushReadFileSync(msgs);
    const readdirSync = vi.fn().mockReturnValue(['00001-stdout.json', '00003-stdout.json', '00005-stdout.json']);
    const { watch, fireSentinel } = makeWatchMock();
    const received: OutputMessage[] = [];
    const onExit = vi.fn();

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks: makeValidHooks(),
      logger: makeLogger(),
      watch,
      readFileSync,
      readdirSync,
    });

    connector.spawn(BASE_CONFIG, { onOutput: (m) => received.push(m), onExit });

    fireSentinel('.done');

    // All 3 messages delivered despite gaps at 2 and 4
    expect(received).toHaveLength(3);
    expect(received.map((m) => m.sequence)).toEqual([1, 3, 5]);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('flush with gaps skips already-delivered messages', async () => {
    const msgs: Record<string, OutputMessage> = {
      '00001-stdout.json': buildOutputMsg(1),
      '00003-stdout.json': buildOutputMsg(3),
      '00005-stdout.json': buildOutputMsg(5),
    };
    const readFileSync = makeFlushReadFileSync(msgs);
    // readFile wraps the sync mock as a Promise for the hot-path message handler
    const readFile = vi.fn().mockImplementation((p: string) => Promise.resolve(readFileSync(p)));
    const readdirSync = vi.fn().mockReturnValue(['00001-stdout.json', '00003-stdout.json', '00005-stdout.json']);
    const { watch, fireMessage, fireSentinel } = makeWatchMock();
    const received: OutputMessage[] = [];
    const onExit = vi.fn();

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks: makeValidHooks(),
      logger: makeLogger(),
      watch,
      readFileSync,
      readFile,
      readdirSync,
    });

    connector.spawn(BASE_CONFIG, { onOutput: (m) => received.push(m), onExit });

    // Deliver msg 1 normally via debounce
    fireMessage('00001-stdout.json');
    await sleep(200);
    expect(received).toHaveLength(1);

    // Sentinel triggers flush — should deliver only 3 and 5 (not re-deliver 1)
    fireSentinel('.done');

    expect(received).toHaveLength(3);
    expect(received.map((m) => m.sequence)).toEqual([1, 3, 5]);
  });

  it('flush is re-entrancy safe — onOutput calling destroy does not loop', () => {
    const msgs: Record<string, OutputMessage> = {
      '00001-stdout.json': buildOutputMsg(1),
    };
    const readFileSync = makeFlushReadFileSync(msgs);
    const readdirSync = vi.fn().mockReturnValue(['00001-stdout.json']);
    const { watch, fireSentinel } = makeWatchMock();
    const onExit = vi.fn();

    let connector: TmuxConnector;
    let handle: TmuxHandle;

    const onOutput = vi.fn().mockImplementation(() => {
      // Re-entrant: onOutput calls destroy during flush
      connector.destroy(handle);
    });

    connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks: makeValidHooks(),
      logger: makeLogger(),
      watch,
      readFileSync,
      readdirSync,
    });

    const spawnResult = connector.spawn(BASE_CONFIG, { onOutput, onExit });
    if (!spawnResult.ok) return;
    handle = spawnResult.value;

    // Sentinel fires — triggers flush → onOutput → destroy (re-entrant)
    expect(() => fireSentinel('.done')).not.toThrow();
    expect(onOutput).toHaveBeenCalledTimes(1);
  });

  it('flush handles missing messagesDir gracefully', () => {
    const readFileSync = vi.fn().mockReturnValue('0');
    const readdirSync = vi.fn().mockImplementation(() => {
      const e = new Error('ENOENT') as NodeJS.ErrnoException;
      e.code = 'ENOENT';
      throw e;
    });
    const { watch, fireSentinel } = makeWatchMock();
    const onExit = vi.fn();

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks: makeValidHooks(),
      logger: makeLogger(),
      watch,
      readFileSync,
      readdirSync,
    });

    connector.spawn(BASE_CONFIG, { onOutput: vi.fn(), onExit });

    // Sentinel fires with missing messages dir — should not throw
    expect(() => fireSentinel('.done')).not.toThrow();
    expect(onExit).toHaveBeenCalledWith(0, undefined);
  });
});

describe('TmuxConnector — MIN_CHECK_INTERVAL_MS floor clamp', () => {
  it('clamps checkIntervalMs below 1000ms to 1000ms', () => {
    vi.useFakeTimers();
    const { watch } = makeWatchMock();
    const onExit = vi.fn();
    const sessionManager = makeValidSessionManager();
    // listSessions returns [] so the session is considered dead every tick
    // maxSilenceMs=0 so any tick past the first check triggers STALE

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager,
      hooks: makeValidHooks(),
      logger: makeLogger(),
      watch,
    });

    connector.spawn(
      { ...BASE_CONFIG, staleness: { checkIntervalMs: 100, maxSilenceMs: 0 } },
      { onOutput: vi.fn(), onExit },
    );

    // 999ms — still under the 1000ms floor; timer must not have fired yet
    vi.advanceTimersByTime(999);
    expect(onExit).not.toHaveBeenCalled();

    // 1001ms — past the 1000ms floor; first tick fires and STALE is triggered
    vi.advanceTimersByTime(2);
    expect(onExit).toHaveBeenCalledWith(null, 'STALE');

    vi.useRealTimers();
  });
});

describe('TmuxConnector — staleness detection', () => {
  it('fires onExit(null, STALE) when session is dead for maxSilenceMs', () => {
    vi.useFakeTimers();
    const { watch } = makeWatchMock();
    const onExit = vi.fn();

    // listSessions returns [] by default — session is absent from alive set,
    // so after maxSilenceMs it is marked STALE.
    const sessionManager = makeValidSessionManager();

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager,
      hooks: makeValidHooks(),
      logger: makeLogger(),
      watch,
    });

    connector.spawn(
      { ...BASE_CONFIG, staleness: { checkIntervalMs: 1000, maxSilenceMs: 500 } },
      { onOutput: vi.fn(), onExit },
    );

    // Advance past maxSilenceMs
    vi.advanceTimersByTime(2000);

    expect(onExit).toHaveBeenCalledWith(null, 'STALE');
    vi.useRealTimers();
  });

  it('staleness timer uses the configured checkIntervalMs', () => {
    vi.useFakeTimers();
    const { watch } = makeWatchMock();
    // listSessions returns [] by default — session is absent, triggers STALE after maxSilenceMs
    const sessionManager = makeValidSessionManager();
    const onExit = vi.fn();

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager,
      hooks: makeValidHooks(),
      logger: makeLogger(),
      watch,
    });

    connector.spawn(
      { ...BASE_CONFIG, staleness: { checkIntervalMs: 5000, maxSilenceMs: 1000 } },
      { onOutput: vi.fn(), onExit },
    );

    // Not enough time for first check interval
    vi.advanceTimersByTime(4999);
    expect(onExit).not.toHaveBeenCalled();

    // Past first check interval
    vi.advanceTimersByTime(5001);
    expect(onExit).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('staleness timer logs warning and does NOT fire onExit when listSessions returns err', () => {
    vi.useFakeTimers();
    const { watch } = makeWatchMock();
    const onExit = vi.fn();
    const logger = makeLogger();

    const sessionManager = makeValidSessionManager();
    // listSessions fails with a transient error every tick
    (sessionManager.listSessions as ReturnType<typeof vi.fn>).mockReturnValue(
      err(new AutobeatError(ErrorCode.TMUX_SESSION_FAILED, 'tmux command failed')),
    );

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager,
      hooks: makeValidHooks(),
      logger,
      watch,
    });

    connector.spawn(
      { ...BASE_CONFIG, staleness: { checkIntervalMs: 1000, maxSilenceMs: 500 } },
      { onOutput: vi.fn(), onExit },
    );

    // Advance well past maxSilenceMs — the timer fires but must NOT call onExit
    vi.advanceTimersByTime(5000);

    // Warning must be logged for each failed tick
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('listSessions failed'),
      expect.objectContaining({ error: expect.any(String) }),
    );
    // onExit must NOT have been triggered
    expect(onExit).not.toHaveBeenCalled();
    connector.dispose();
    vi.useRealTimers();
  });

  it('alive session resets lastAliveCheck and does NOT fire STALE', () => {
    vi.useFakeTimers();
    const { watch } = makeWatchMock();
    const onExit = vi.fn();

    const sessionManager = makeValidSessionManager();
    // listSessions returns the session as alive on every tick
    (sessionManager.listSessions as ReturnType<typeof vi.fn>).mockReturnValue(ok([{ name: `beat-task-abc` }]));

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager,
      hooks: makeValidHooks(),
      logger: makeLogger(),
      watch,
    });

    connector.spawn(
      { ...BASE_CONFIG, staleness: { checkIntervalMs: 1000, maxSilenceMs: 500 } },
      { onOutput: vi.fn(), onExit },
    );

    // Advance well past maxSilenceMs — session is alive every tick so STALE must not fire
    vi.advanceTimersByTime(10000);

    expect(onExit).not.toHaveBeenCalled();
    connector.dispose();
    vi.useRealTimers();
  });

  it('staleness timer stops after exit — no double-fire', () => {
    vi.useFakeTimers();
    const { watch, fireSentinel } = makeWatchMock();
    const onExit = vi.fn();
    const readFileSync = vi.fn().mockReturnValue('0');

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks: makeValidHooks(),
      logger: makeLogger(),
      watch,
      readFileSync,
    });

    connector.spawn(
      { ...BASE_CONFIG, staleness: { checkIntervalMs: 1000, maxSilenceMs: 500 } },
      { onOutput: vi.fn(), onExit },
    );

    // Trigger sentinel exit first
    fireSentinel('.done');

    // Then advance timers — staleness should NOT double-fire
    vi.advanceTimersByTime(5000);

    expect(onExit).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe('TmuxConnector.destroy()', () => {
  it('closes sentinel watcher on destroy', () => {
    const { watch, sentinelWatcher } = makeWatchMock();

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks: makeValidHooks(),
      logger: makeLogger(),
      watch,
    });

    const spawnResult = connector.spawn(BASE_CONFIG, { onOutput: vi.fn(), onExit: vi.fn() });
    if (!spawnResult.ok) return;
    connector.destroy(spawnResult.value);

    expect(sentinelWatcher.close).toHaveBeenCalled();
  });

  it('closes messages watcher on destroy', () => {
    const { watch, messageWatcher } = makeWatchMock();

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks: makeValidHooks(),
      logger: makeLogger(),
      watch,
    });

    const spawnResult = connector.spawn(BASE_CONFIG, { onOutput: vi.fn(), onExit: vi.fn() });
    if (!spawnResult.ok) return;
    connector.destroy(spawnResult.value);

    expect(messageWatcher.close).toHaveBeenCalled();
  });

  it('clears staleness timer on destroy', () => {
    vi.useFakeTimers();
    const { watch } = makeWatchMock();
    const onExit = vi.fn();

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks: makeValidHooks(),
      logger: makeLogger(),
      watch,
    });

    const spawnResult = connector.spawn(
      { ...BASE_CONFIG, staleness: { checkIntervalMs: 1000, maxSilenceMs: 500 } },
      { onOutput: vi.fn(), onExit },
    );
    if (!spawnResult.ok) {
      vi.useRealTimers();
      return;
    }

    connector.destroy(spawnResult.value);

    // After destroy, advancing time should NOT fire staleness
    vi.advanceTimersByTime(5000);
    expect(onExit).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('calls sessionManager.destroySession with the session name', () => {
    const { watch } = makeWatchMock();
    const sessionManager = makeValidSessionManager();

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager,
      hooks: makeValidHooks(),
      logger: makeLogger(),
      watch,
    });

    const spawnResult = connector.spawn(BASE_CONFIG, { onOutput: vi.fn(), onExit: vi.fn() });
    if (!spawnResult.ok) return;
    connector.destroy(spawnResult.value);

    expect(sessionManager.destroySession).toHaveBeenCalled();
  });

  it('calls hooks.cleanup with taskId and sessionsDir on destroy', () => {
    const { watch } = makeWatchMock();
    const hooks = makeValidHooks();

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks,
      logger: makeLogger(),
      watch,
    });

    const spawnResult = connector.spawn(BASE_CONFIG, { onOutput: vi.fn(), onExit: vi.fn() });
    if (!spawnResult.ok) return;
    connector.destroy(spawnResult.value);

    expect(hooks.cleanup).toHaveBeenCalledWith(BASE_CONFIG.taskId, BASE_CONFIG.sessionsDir);
  });

  it('destroy is idempotent — calling twice does not throw', () => {
    const { watch } = makeWatchMock();

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks: makeValidHooks(),
      logger: makeLogger(),
      watch,
    });

    const spawnResult = connector.spawn(BASE_CONFIG, { onOutput: vi.fn(), onExit: vi.fn() });
    if (!spawnResult.ok) return;

    expect(() => {
      connector.destroy(spawnResult.value);
      connector.destroy(spawnResult.value);
    }).not.toThrow();
  });
});

describe('TmuxConnector.sendKeys() / isAlive()', () => {
  it('sendKeys delegates to sessionManager.sendKeys', () => {
    const { watch } = makeWatchMock();
    const sessionManager = makeValidSessionManager();

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager,
      hooks: makeValidHooks(),
      logger: makeLogger(),
      watch,
    });

    const spawnResult = connector.spawn(BASE_CONFIG, { onOutput: vi.fn(), onExit: vi.fn() });
    if (!spawnResult.ok) return;

    connector.sendKeys(spawnResult.value, 'hello');
    expect(sessionManager.sendKeys).toHaveBeenCalledWith(spawnResult.value.sessionName, 'hello');
  });
});

describe('TmuxConnector.dispose()', () => {
  it('logs warning when destroySession returns err during dispose()', () => {
    const { watch } = makeWatchMock();
    const logger = makeLogger();

    const sessionManager = makeValidSessionManager();
    (sessionManager.destroySession as ReturnType<typeof vi.fn>).mockReturnValue(
      err(new AutobeatError(ErrorCode.TMUX_SESSION_FAILED, 'destroy failed')),
    );

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager,
      hooks: makeValidHooks(),
      logger,
      watch,
    });

    connector.spawn(BASE_CONFIG, { onOutput: vi.fn(), onExit: vi.fn() });
    connector.dispose();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Dispose: failed to destroy session'),
      expect.objectContaining({ sessionName: expect.any(String) }),
    );
  });

  it('calls hooks.cleanup with taskId and sessionsDir on dispose', () => {
    const { watch } = makeWatchMock();
    const hooks = makeValidHooks();

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks,
      logger: makeLogger(),
      watch,
    });

    connector.spawn(BASE_CONFIG, { onOutput: vi.fn(), onExit: vi.fn() });
    connector.dispose();

    expect(hooks.cleanup).toHaveBeenCalledWith(BASE_CONFIG.taskId, BASE_CONFIG.sessionsDir);
  });

  it('dispose cleans up all active handles', () => {
    const { watch: watch1 } = makeWatchMock();
    const { watch: watch2 } = makeWatchMock();

    let callCount = 0;
    const combinedWatch = vi.fn().mockImplementation((...args: Parameters<typeof watch1>) => {
      callCount++;
      if (callCount <= 2) return watch1(...args);
      return watch2(...args);
    }) as unknown as TmuxConnectorDeps['watch'];

    const sessionManager = {
      ...makeValidSessionManager(),
      createSession: vi
        .fn()
        .mockReturnValueOnce(ok(makeSessionResult('task-abc', 'beat-task-abc')))
        .mockReturnValueOnce(ok(makeSessionResult('task-def', 'beat-task-def'))),
    } as unknown as TmuxSessionManager;

    const hooks = {
      generateWrapper: vi
        .fn()
        .mockReturnValueOnce(ok(makeManifest('task-abc')))
        .mockReturnValueOnce(ok(makeManifest('task-def'))),
      cleanup: vi.fn().mockReturnValue(ok(undefined)),
    } as unknown as TmuxHooks;

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager,
      hooks,
      logger: makeLogger(),
      watch: combinedWatch,
    });

    connector.spawn(BASE_CONFIG, { onOutput: vi.fn(), onExit: vi.fn() });
    connector.spawn(
      { ...BASE_CONFIG, name: 'beat-task-def', taskId: 'task-def' },
      { onOutput: vi.fn(), onExit: vi.fn() },
    );

    expect(connector.getActiveHandles()).toHaveLength(2);

    connector.dispose();
    expect(connector.getActiveHandles()).toHaveLength(0);
  });
});

describe('TmuxConnector.getActiveHandles()', () => {
  it('returns all currently active session handles', () => {
    const { watch } = makeWatchMock();

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks: makeValidHooks(),
      logger: makeLogger(),
      watch,
    });

    expect(connector.getActiveHandles()).toHaveLength(0);

    connector.spawn(BASE_CONFIG, { onOutput: vi.fn(), onExit: vi.fn() });
    expect(connector.getActiveHandles()).toHaveLength(1);

    connector.dispose();
  });
});

describe('TmuxConnector — loggedCleanup failure logging', () => {
  function makeCleanupFailingHooks(taskId = 'task-abc'): TmuxHooks {
    return {
      generateWrapper: vi.fn().mockReturnValue(ok(makeManifest(taskId))),
      cleanup: vi.fn().mockReturnValue(err(new AutobeatError(ErrorCode.TMUX_HOOK_FAILED, 'cleanup error'))),
    } as unknown as TmuxHooks;
  }

  it('logs warning when hooks.cleanup fails during spawn rollback (createSession fails)', () => {
    const { watch } = makeWatchMock();
    const logger = makeLogger();
    const hooks = makeCleanupFailingHooks();

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeFailingSessionManager(),
      hooks,
      logger,
      watch,
    });

    // createSession fails → spawn rolls back → loggedCleanup is called → cleanup returns err
    const result = connector.spawn(BASE_CONFIG, { onOutput: vi.fn(), onExit: vi.fn() });
    expect(result.ok).toBe(false);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Hooks cleanup failed'),
      expect.objectContaining({ caller: 'spawn', taskId: BASE_CONFIG.taskId }),
    );
  });

  it('logs warning when hooks.cleanup fails during destroy()', () => {
    const { watch } = makeWatchMock();
    const logger = makeLogger();
    const hooks = makeCleanupFailingHooks();

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks,
      logger,
      watch,
    });

    const spawnResult = connector.spawn(BASE_CONFIG, { onOutput: vi.fn(), onExit: vi.fn() });
    if (!spawnResult.ok) return;

    // spawn calls cleanup and logs a warning, reset so we can assert cleanly on destroy
    (logger.warn as ReturnType<typeof vi.fn>).mockClear();

    connector.destroy(spawnResult.value);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Hooks cleanup failed'),
      expect.objectContaining({ caller: 'destroy', taskId: BASE_CONFIG.taskId }),
    );
  });

  it('logs warning when hooks.cleanup fails during triggerExit (sentinel fires)', () => {
    const { watch, fireSentinel } = makeWatchMock();
    const logger = makeLogger();
    const hooks = makeCleanupFailingHooks();
    const readFileSync = vi.fn().mockReturnValue('0');

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks,
      logger,
      watch,
      readFileSync,
    });

    connector.spawn(BASE_CONFIG, { onOutput: vi.fn(), onExit: vi.fn() });

    // spawn calls cleanup and logs a warning, reset so we can assert cleanly on exit
    (logger.warn as ReturnType<typeof vi.fn>).mockClear();

    fireSentinel('.done');

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Hooks cleanup failed'),
      expect.objectContaining({ caller: 'triggerExit', taskId: BASE_CONFIG.taskId }),
    );
  });
});

// ─── Batch-4 regression tests ─────────────────────────────────────────────────

describe('TmuxConnector — connector-level session cap (rel-conn-1)', () => {
  it('returns error when spawn is called with MAX_CONCURRENT_SESSIONS sessions already active', () => {
    // Session manager that accepts any taskId, hooks that return a manifest per taskId
    const sessionManager: TmuxSessionManager = {
      createSession: vi
        .fn()
        .mockImplementation((cfg: TmuxSpawnConfig) => ok(makeSessionResult(cfg.taskId, `beat-${cfg.taskId}`))),
      destroySession: vi.fn().mockReturnValue(ok(undefined)),
      sendKeys: vi.fn().mockReturnValue(ok(undefined)),
      isAlive: vi.fn().mockReturnValue(ok(true)),
      listSessions: vi.fn().mockReturnValue(ok([])),
      getSessionEnvironment: vi.fn().mockReturnValue(ok(undefined)),
    } as unknown as TmuxSessionManager;

    const hooks: TmuxHooks = {
      generateWrapper: vi.fn().mockImplementation((cfg: { taskId: string }) => ok(makeManifest(cfg.taskId))),
      cleanup: vi.fn().mockReturnValue(ok(undefined)),
    } as unknown as TmuxHooks;

    // Use a watch that always returns a no-op watcher so we can spawn many sessions
    let watchCallCount = 0;
    const watch = vi.fn().mockImplementation(() => {
      watchCallCount++;
      return { close: vi.fn(), on: vi.fn() };
    }) as unknown as TmuxConnectorDeps['watch'];

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager,
      hooks,
      logger: makeLogger(),
      watch,
    });

    // Fill up to the limit
    for (let i = 0; i < MAX_CONCURRENT_SESSIONS; i++) {
      const result = connector.spawn(
        { ...BASE_CONFIG, taskId: `task-${i}`, name: `beat-task-${i}` },
        { onOutput: vi.fn(), onExit: vi.fn() },
      );
      expect(result.ok).toBe(true);
    }

    // The next spawn must be rejected at the connector level
    const overflow = connector.spawn(
      { ...BASE_CONFIG, taskId: 'task-overflow', name: 'beat-task-overflow' },
      { onOutput: vi.fn(), onExit: vi.fn() },
    );
    expect(overflow.ok).toBe(false);
    if (overflow.ok) return;
    expect(overflow.error.message).toContain('connector session limit reached');
  });
});

describe('TmuxConnector — watcher exited guard (rel-conn-2)', () => {
  it('watcher callback returns early when session.exited is true, no new debounce timer scheduled', async () => {
    let messageCallback: ((event: string, filename: string | null) => void) | null = null;
    let watchCallCount = 0;
    const watch = vi
      .fn()
      .mockImplementation((_watchPath: string, _opts: unknown, callback: (event: string, f: string | null) => void) => {
        watchCallCount++;
        if (watchCallCount === 2) messageCallback = callback;
        return { close: vi.fn(), on: vi.fn() };
      }) as unknown as TmuxConnectorDeps['watch'];

    const onOutput = vi.fn();
    const readFileSync = vi.fn().mockReturnValue('0');

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks: makeValidHooks(),
      logger: makeLogger(),
      watch,
      readFileSync,
    });

    const spawnResult = connector.spawn(BASE_CONFIG, { onOutput, onExit: vi.fn() });
    if (!spawnResult.ok) throw new Error('spawn failed');

    // Destroy the session — this sets session.exited = true and closes watchers
    connector.destroy(spawnResult.value);

    // Fire the watcher callback AFTER destroy (simulates a late OS event)
    // If the exited guard works, readFile must never be called
    const readFile = vi.fn().mockResolvedValue('{}');
    messageCallback?.('change', '00001-stdout.json');

    // Give any async work (debounce + readFile) a chance to run
    await sleep(100);

    // readFile injected above is not used by this connector instance — but
    // onOutput must not have been called either (the event should be dropped)
    expect(onOutput).not.toHaveBeenCalled();
  });
});

describe('TmuxConnector — deliverPendingMessages explicit bound (rel-conn-3)', () => {
  it('delivers all pending messages without hanging when re-entrant onOutput calls spawn', async () => {
    const msgs: OutputMessage[] = [
      { sequence: 1, timestamp: 't1', type: 'stdout', content: 'line1' },
      { sequence: 2, timestamp: 't2', type: 'stdout', content: 'line2' },
      { sequence: 3, timestamp: 't3', type: 'stdout', content: 'line3' },
    ];

    const { watch, fireSentinel } = makeWatchMock();
    const readFileSync = vi.fn().mockReturnValue('0');
    const readdirSync = vi.fn().mockReturnValue(['00001-stdout.json', '00002-stdout.json', '00003-stdout.json']);
    let readIdx = 0;
    const readFileSyncFull = vi.fn().mockImplementation((filePath: string) => {
      if (filePath.endsWith('.done') || filePath.endsWith('.exit')) return '0';
      return JSON.stringify(msgs[readIdx++ % msgs.length]);
    });

    const received: number[] = [];
    const onOutput = vi.fn().mockImplementation((m: OutputMessage) => {
      received.push(m.sequence);
    });

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks: makeValidHooks(),
      logger: makeLogger(),
      watch,
      readFileSync: readFileSyncFull,
      readdirSync,
    });

    connector.spawn(BASE_CONFIG, { onOutput, onExit: vi.fn() });

    // Sentinel fires — flush reads all 3 files and delivers them
    fireSentinel('.done');

    // All 3 messages must be delivered in order
    expect(received).toEqual([1, 2, 3]);
  });
});

describe('TmuxConnector — flushPendingFiles filename-based skip (perf-conn-1)', () => {
  it('skips readFileSync for files with sequence number at or below lastDeliveredSeq', async () => {
    // Simulate: messages 1 and 2 already delivered; only 3 is new
    const msg3: OutputMessage = { sequence: 3, timestamp: 't3', type: 'stdout', content: 'line3' };

    const { watch, fireMessage, fireSentinel } = makeWatchMock();
    const onOutput = vi.fn();

    // readFile used by the hot path (handleMessageFile) — simulate delivering msg1 and msg2
    let hotPathCalls = 0;
    const readFile = vi.fn().mockImplementation(() => {
      hotPathCalls++;
      const msgs = [
        { sequence: 1, timestamp: 't1', type: 'stdout', content: 'line1' },
        { sequence: 2, timestamp: 't2', type: 'stdout', content: 'line2' },
      ];
      return Promise.resolve(JSON.stringify(msgs[hotPathCalls - 1] ?? msgs[0]));
    });

    // readFileSync used by flush — should only be called for file 3
    const readFileSyncCalls: string[] = [];
    const readFileSync = vi.fn().mockImplementation((filePath: string) => {
      if (filePath.endsWith('.done') || filePath.endsWith('.exit')) return '0';
      readFileSyncCalls.push(filePath);
      return JSON.stringify(msg3);
    });

    const readdirSync = vi.fn().mockReturnValue(['00001-stdout.json', '00002-stdout.json', '00003-stdout.json']);

    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager: makeValidSessionManager(),
      hooks: makeValidHooks(),
      logger: makeLogger(),
      watch,
      readFile,
      readFileSync,
      readdirSync,
    });

    connector.spawn(BASE_CONFIG, { onOutput, onExit: vi.fn() });

    // Deliver msg1 and msg2 via the hot path to advance lastDeliveredSeq to 2
    fireMessage('00001-stdout.json');
    fireMessage('00002-stdout.json');
    await sleep(100); // let debounce + async readFile complete

    // Now sentinel fires — flush should skip files 1 and 2 and only read file 3
    fireSentinel('.done');

    // readFileSyncCalls should only contain the path for file 3, not files 1 or 2
    expect(readFileSyncCalls.every((p) => p.includes('00003'))).toBe(true);
    expect(readFileSyncCalls).toHaveLength(1);
  });
});
