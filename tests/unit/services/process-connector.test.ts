/**
 * Unit tests for ProcessConnector
 *
 * ARCHITECTURE: Tests stream wiring, exit handling, double-exit guard,
 * periodic flush, and output repository persistence
 * Pattern: Mock ChildProcess (EventEmitter) + mock OutputCapture + mock OutputRepository + TestLogger
 */

import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskId } from '../../../src/core/domain.js';
import type { Logger, OutputCapture } from '../../../src/core/interfaces.js';
import { ok } from '../../../src/core/result.js';
import { ProcessConnector } from '../../../src/services/process-connector.js';
import { createMockOutputRepository } from '../../fixtures/mocks.js';

function createMockProcess(): EventEmitter & {
  stdout: EventEmitter | null;
  stderr: EventEmitter | null;
} {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter | null;
    stderr: EventEmitter | null;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

function createTestLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => createTestLogger(),
  };
}

function createMockOutputCapture(): OutputCapture {
  return {
    capture: vi.fn().mockReturnValue(ok(undefined)),
    getOutput: vi.fn().mockReturnValue(ok({ taskId: 'test', stdout: [], stderr: [], totalSize: 0 })),
    clear: vi.fn().mockReturnValue(ok(undefined)),
  };
}

describe('ProcessConnector', () => {
  const taskId = 'task-1' as TaskId;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should capture stdout data', () => {
    const capture = createMockOutputCapture();
    const logger = createTestLogger();
    const outputRepo = createMockOutputRepository();
    const connector = new ProcessConnector(capture, logger, outputRepo);
    const proc = createMockProcess();
    const onExit = vi.fn();

    connector.connect(proc as never, taskId, onExit);
    proc.stdout!.emit('data', Buffer.from('hello'));

    expect(capture.capture).toHaveBeenCalledWith(taskId, 'stdout', 'hello');
  });

  it('should capture stderr data', () => {
    const capture = createMockOutputCapture();
    const logger = createTestLogger();
    const outputRepo = createMockOutputRepository();
    const connector = new ProcessConnector(capture, logger, outputRepo);
    const proc = createMockProcess();
    const onExit = vi.fn();

    connector.connect(proc as never, taskId, onExit);
    proc.stderr!.emit('data', Buffer.from('error output'));

    expect(capture.capture).toHaveBeenCalledWith(taskId, 'stderr', 'error output');
  });

  it('should call onExit with exit code on process exit', async () => {
    const capture = createMockOutputCapture();
    const logger = createTestLogger();
    const outputRepo = createMockOutputRepository();
    const connector = new ProcessConnector(capture, logger, outputRepo);
    const proc = createMockProcess();
    const onExit = vi.fn();

    connector.connect(proc as never, taskId, onExit);
    proc.emit('exit', 42);

    // safeOnExit is async — wait for promise chain (.then/.catch/.finally)
    await vi.runAllTimersAsync();

    expect(onExit).toHaveBeenCalledWith(42);
  });

  it('should preserve exit code 0 (nullish coalescing)', async () => {
    const capture = createMockOutputCapture();
    const logger = createTestLogger();
    const outputRepo = createMockOutputRepository();
    const connector = new ProcessConnector(capture, logger, outputRepo);
    const proc = createMockProcess();
    const onExit = vi.fn();

    connector.connect(proc as never, taskId, onExit);
    proc.emit('exit', 0);

    await vi.runAllTimersAsync();

    expect(onExit).toHaveBeenCalledWith(0);
  });

  it('should capture error and call onExit(1) on process error', async () => {
    const capture = createMockOutputCapture();
    const logger = createTestLogger();
    const outputRepo = createMockOutputRepository();
    const connector = new ProcessConnector(capture, logger, outputRepo);
    const proc = createMockProcess();
    const onExit = vi.fn();

    connector.connect(proc as never, taskId, onExit);
    proc.emit('error', new Error('spawn failed'));

    await vi.runAllTimersAsync();

    expect(capture.capture).toHaveBeenCalledWith(taskId, 'stderr', 'Process error: spawn failed\n');
    expect(onExit).toHaveBeenCalledWith(1);
  });

  it('should prevent multiple onExit calls (double-exit guard)', async () => {
    const capture = createMockOutputCapture();
    const logger = createTestLogger();
    const outputRepo = createMockOutputRepository();
    const connector = new ProcessConnector(capture, logger, outputRepo);
    const proc = createMockProcess();
    const onExit = vi.fn();

    connector.connect(proc as never, taskId, onExit);
    proc.emit('exit', 0);
    proc.emit('exit', 1); // second exit should be ignored

    await vi.runAllTimersAsync();

    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith(0);
  });

  it('should handle process without stdout/stderr streams', async () => {
    const capture = createMockOutputCapture();
    const logger = createTestLogger();
    const outputRepo = createMockOutputRepository();
    const connector = new ProcessConnector(capture, logger, outputRepo);
    const proc = createMockProcess();
    proc.stdout = null;
    proc.stderr = null;
    const onExit = vi.fn();

    // Should not throw
    connector.connect(proc as never, taskId, onExit);
    proc.emit('exit', 0);

    await vi.runAllTimersAsync();

    expect(onExit).toHaveBeenCalledWith(0);
  });

  it('should start periodic flush at configured interval', async () => {
    const capture = createMockOutputCapture();
    (capture.getOutput as ReturnType<typeof vi.fn>).mockReturnValue(
      ok({ taskId, stdout: ['line1'], stderr: [], totalSize: 5 }),
    );
    const logger = createTestLogger();
    const outputRepo = createMockOutputRepository();
    const flushIntervalMs = 500;
    const connector = new ProcessConnector(capture, logger, outputRepo, flushIntervalMs);
    const proc = createMockProcess();
    const onExit = vi.fn();

    connector.connect(proc as never, taskId, onExit);

    // Advance past one flush interval
    await vi.advanceTimersByTimeAsync(flushIntervalMs);

    expect(capture.getOutput).toHaveBeenCalledWith(taskId);
    expect(outputRepo.save).toHaveBeenCalledWith(taskId, { taskId, stdout: ['line1'], stderr: [], totalSize: 5 });

    // Advance another interval — should flush again
    await vi.advanceTimersByTimeAsync(flushIntervalMs);
    expect(outputRepo.save).toHaveBeenCalledTimes(2);
  });

  it('should not call outputRepository.save when totalSize is 0', async () => {
    const capture = createMockOutputCapture();
    // Default mock returns totalSize: 0
    const logger = createTestLogger();
    const outputRepo = createMockOutputRepository();
    const flushIntervalMs = 500;
    const connector = new ProcessConnector(capture, logger, outputRepo, flushIntervalMs);
    const proc = createMockProcess();
    const onExit = vi.fn();

    connector.connect(proc as never, taskId, onExit);

    await vi.advanceTimersByTimeAsync(flushIntervalMs);

    expect(capture.getOutput).toHaveBeenCalledWith(taskId);
    expect(outputRepo.save).not.toHaveBeenCalled();
  });

  it('should stop periodic flushing via stopFlushing', async () => {
    const capture = createMockOutputCapture();
    (capture.getOutput as ReturnType<typeof vi.fn>).mockReturnValue(
      ok({ taskId, stdout: ['data'], stderr: [], totalSize: 4 }),
    );
    const logger = createTestLogger();
    const outputRepo = createMockOutputRepository();
    const flushIntervalMs = 500;
    const connector = new ProcessConnector(capture, logger, outputRepo, flushIntervalMs);
    const proc = createMockProcess();
    const onExit = vi.fn();

    connector.connect(proc as never, taskId, onExit);

    // First interval fires
    await vi.advanceTimersByTimeAsync(flushIntervalMs);
    expect(outputRepo.save).toHaveBeenCalledTimes(1);

    // Stop flushing
    connector.stopFlushing(taskId);

    // Next interval should NOT fire
    await vi.advanceTimersByTimeAsync(flushIntervalMs);
    expect(outputRepo.save).toHaveBeenCalledTimes(1);
  });

  it('should flush and clear in-memory buffer on exit', async () => {
    const capture = createMockOutputCapture();
    (capture.getOutput as ReturnType<typeof vi.fn>).mockReturnValue(
      ok({ taskId, stdout: ['final'], stderr: [], totalSize: 5 }),
    );
    const logger = createTestLogger();
    const outputRepo = createMockOutputRepository();
    const connector = new ProcessConnector(capture, logger, outputRepo);
    const proc = createMockProcess();
    const onExit = vi.fn();

    connector.connect(proc as never, taskId, onExit);
    proc.emit('exit', 0);

    await vi.runAllTimersAsync();

    // Final flush should have persisted output
    expect(outputRepo.save).toHaveBeenCalledWith(taskId, { taskId, stdout: ['final'], stderr: [], totalSize: 5 });

    // In-memory buffer should be cleared after flush
    expect(capture.clear).toHaveBeenCalledWith(taskId);

    // onExit should still be called
    expect(onExit).toHaveBeenCalledWith(0);
  });

  it('should skip flush when previous flush is still in-flight (backpressure)', async () => {
    const capture = createMockOutputCapture();
    (capture.getOutput as ReturnType<typeof vi.fn>).mockReturnValue(
      ok({ taskId, stdout: ['data'], stderr: [], totalSize: 4 }),
    );
    const logger = createTestLogger();
    const outputRepo = createMockOutputRepository();

    // Make save hang indefinitely (never resolves during test)
    let resolveSave: (() => void) | undefined;
    (outputRepo.save as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );

    const flushIntervalMs = 500;
    const connector = new ProcessConnector(capture, logger, outputRepo, flushIntervalMs);
    const proc = createMockProcess();
    const onExit = vi.fn();

    connector.connect(proc as never, taskId, onExit);

    // First interval fires — starts a flush that hangs
    await vi.advanceTimersByTimeAsync(flushIntervalMs);
    expect(outputRepo.save).toHaveBeenCalledTimes(1);

    // Second interval fires — should skip because first is still in-flight
    await vi.advanceTimersByTimeAsync(flushIntervalMs);
    expect(outputRepo.save).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledWith('Skipping flush — previous flush still in-flight', { taskId });

    // Resolve the hanging flush
    resolveSave!();
    await vi.advanceTimersByTimeAsync(0); // Let promise resolve

    // Third interval fires — should flush again now that previous completed
    await vi.advanceTimersByTimeAsync(flushIntervalMs);
    expect(outputRepo.save).toHaveBeenCalledTimes(2);
  });

  it('should call onExit even when final flush fails', async () => {
    const capture = createMockOutputCapture();
    (capture.getOutput as ReturnType<typeof vi.fn>).mockReturnValue(
      ok({ taskId, stdout: ['data'], stderr: [], totalSize: 4 }),
    );
    const logger = createTestLogger();
    const outputRepo = createMockOutputRepository();
    (outputRepo.save as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB write failed'));
    const connector = new ProcessConnector(capture, logger, outputRepo);
    const proc = createMockProcess();
    const onExit = vi.fn();

    connector.connect(proc as never, taskId, onExit);
    proc.emit('exit', 0);

    await vi.runAllTimersAsync();

    // onExit must still be called despite flush failure (.finally)
    expect(onExit).toHaveBeenCalledWith(0);

    // Error should be logged
    expect(logger.error).toHaveBeenCalled();
  });
});
