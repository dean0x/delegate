/**
 * Unit tests for ProcessConnector
 *
 * ARCHITECTURE: Tests stream wiring, exit handling, and double-exit guard
 * Pattern: Mock ChildProcess (EventEmitter) + mock OutputCapture + TestLogger
 */

import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import type { TaskId } from '../../../src/core/domain.js';
import type { Logger, OutputCapture } from '../../../src/core/interfaces.js';
import { ok } from '../../../src/core/result.js';
import { ProcessConnector } from '../../../src/services/process-connector.js';

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

  it('should capture stdout data', () => {
    const capture = createMockOutputCapture();
    const logger = createTestLogger();
    const connector = new ProcessConnector(capture, logger);
    const proc = createMockProcess();
    const onExit = vi.fn();

    connector.connect(proc as never, taskId, onExit);
    proc.stdout!.emit('data', Buffer.from('hello'));

    expect(capture.capture).toHaveBeenCalledWith(taskId, 'stdout', 'hello');
  });

  it('should capture stderr data', () => {
    const capture = createMockOutputCapture();
    const logger = createTestLogger();
    const connector = new ProcessConnector(capture, logger);
    const proc = createMockProcess();
    const onExit = vi.fn();

    connector.connect(proc as never, taskId, onExit);
    proc.stderr!.emit('data', Buffer.from('error output'));

    expect(capture.capture).toHaveBeenCalledWith(taskId, 'stderr', 'error output');
  });

  it('should call onExit with exit code on process exit', () => {
    const capture = createMockOutputCapture();
    const logger = createTestLogger();
    const connector = new ProcessConnector(capture, logger);
    const proc = createMockProcess();
    const onExit = vi.fn();

    connector.connect(proc as never, taskId, onExit);
    proc.emit('exit', 42);

    expect(onExit).toHaveBeenCalledWith(42);
  });

  it('should preserve exit code 0 (nullish coalescing)', () => {
    const capture = createMockOutputCapture();
    const logger = createTestLogger();
    const connector = new ProcessConnector(capture, logger);
    const proc = createMockProcess();
    const onExit = vi.fn();

    connector.connect(proc as never, taskId, onExit);
    proc.emit('exit', 0);

    expect(onExit).toHaveBeenCalledWith(0);
  });

  it('should capture error and call onExit(1) on process error', () => {
    const capture = createMockOutputCapture();
    const logger = createTestLogger();
    const connector = new ProcessConnector(capture, logger);
    const proc = createMockProcess();
    const onExit = vi.fn();

    connector.connect(proc as never, taskId, onExit);
    proc.emit('error', new Error('spawn failed'));

    expect(capture.capture).toHaveBeenCalledWith(taskId, 'stderr', 'Process error: spawn failed\n');
    expect(onExit).toHaveBeenCalledWith(1);
  });

  it('should prevent multiple onExit calls (double-exit guard)', () => {
    const capture = createMockOutputCapture();
    const logger = createTestLogger();
    const connector = new ProcessConnector(capture, logger);
    const proc = createMockProcess();
    const onExit = vi.fn();

    connector.connect(proc as never, taskId, onExit);
    proc.emit('exit', 0);
    proc.emit('exit', 1); // second exit should be ignored

    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith(0);
  });

  it('should handle process without stdout/stderr streams', () => {
    const capture = createMockOutputCapture();
    const logger = createTestLogger();
    const connector = new ProcessConnector(capture, logger);
    const proc = createMockProcess();
    proc.stdout = null;
    proc.stderr = null;
    const onExit = vi.fn();

    // Should not throw
    connector.connect(proc as never, taskId, onExit);
    proc.emit('exit', 0);

    expect(onExit).toHaveBeenCalledWith(0);
  });
});
