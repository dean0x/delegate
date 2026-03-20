/**
 * Tests for CLI service helpers: exitOnError, exitOnNull, errorMessage
 *
 * ARCHITECTURE: Pure unit tests with vi.mock() for ui module and process.exit.
 * These helpers are critical-path for all CLI error handling (~15 call sites).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { err, ok, type Result } from '../../src/core/result';
import type { Spinner } from '../../src/cli/ui';

// Mock ui module before importing services
vi.mock('../../src/cli/ui.js', () => ({
  error: vi.fn(),
}));

// Must import after mock setup
import * as ui from '../../src/cli/ui.js';
import { errorMessage, exitOnError, exitOnNull } from '../../src/cli/services';

const mockError = vi.mocked(ui.error);

// ============================================================================
// Test Helpers
// ============================================================================

function createMockSpinner(): Spinner {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    message: vi.fn(),
    cancel: vi.fn(),
    error: vi.fn(),
    clear: vi.fn(),
    get isCancelled() {
      return false;
    },
  } as unknown as Spinner;
}

// ============================================================================
// errorMessage
// ============================================================================

describe('errorMessage', () => {
  it('extracts message from Error instance', () => {
    expect(errorMessage(new Error('something broke'))).toBe('something broke');
  });

  it('converts non-Error values to string', () => {
    expect(errorMessage('plain string')).toBe('plain string');
    expect(errorMessage(42)).toBe('42');
    expect(errorMessage(null)).toBe('null');
    expect(errorMessage(undefined)).toBe('undefined');
  });
});

// ============================================================================
// exitOnError
// ============================================================================

describe('exitOnError', () => {
  let mockExit: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    mockError.mockClear();
  });

  afterEach(() => {
    mockExit.mockRestore();
  });

  it('returns unwrapped value on success', () => {
    const result: Result<string> = ok('hello');
    const value = exitOnError(result);

    expect(value).toBe('hello');
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('calls process.exit(1) on error', () => {
    const result: Result<string> = err(new Error('boom'));
    exitOnError(result);

    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('calls ui.error with error message when no prefix', () => {
    const result: Result<string> = err(new Error('connection refused'));
    exitOnError(result);

    expect(mockError).toHaveBeenCalledWith('connection refused');
  });

  it('prepends prefix to error message', () => {
    const result: Result<string> = err(new Error('connection refused'));
    exitOnError(result, undefined, 'Bootstrap failed');

    expect(mockError).toHaveBeenCalledWith('Bootstrap failed: connection refused');
  });

  it('stops spinner with default "Failed" message', () => {
    const spinner = createMockSpinner();
    const result: Result<string> = err(new Error('oops'));
    exitOnError(result, spinner);

    expect(spinner.stop).toHaveBeenCalledWith('Failed');
  });

  it('stops spinner with custom stopMsg', () => {
    const spinner = createMockSpinner();
    const result: Result<string> = err(new Error('oops'));
    exitOnError(result, spinner, 'Init error', 'Initialization failed');

    expect(spinner.stop).toHaveBeenCalledWith('Initialization failed');
  });

  it('does not call spinner.stop when spinner is undefined', () => {
    const result: Result<string> = err(new Error('oops'));
    exitOnError(result, undefined);

    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('does not call spinner.stop on success', () => {
    const spinner = createMockSpinner();
    const result: Result<number> = ok(42);
    exitOnError(result, spinner);

    expect(spinner.stop).not.toHaveBeenCalled();
  });
});

// ============================================================================
// exitOnNull
// ============================================================================

describe('exitOnNull', () => {
  let mockExit: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    mockError.mockClear();
  });

  afterEach(() => {
    mockExit.mockRestore();
  });

  it('returns value when non-null', () => {
    const value = exitOnNull('present', undefined, 'not used');

    expect(value).toBe('present');
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('returns value when zero (falsy but not null)', () => {
    const value = exitOnNull(0, undefined, 'not used');

    expect(value).toBe(0);
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('returns value when empty string (falsy but not null)', () => {
    const value = exitOnNull('', undefined, 'not used');

    expect(value).toBe('');
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('calls process.exit(1) on null', () => {
    exitOnNull(null, undefined, 'Task not found');

    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('calls process.exit(1) on undefined', () => {
    exitOnNull(undefined, undefined, 'Task not found');

    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('calls ui.error with provided message', () => {
    exitOnNull(null, undefined, 'Schedule abc-123 not found');

    expect(mockError).toHaveBeenCalledWith('Schedule abc-123 not found');
  });

  it('stops spinner with default "Not found" message', () => {
    const spinner = createMockSpinner();
    exitOnNull(null, spinner, 'missing');

    expect(spinner.stop).toHaveBeenCalledWith('Not found');
  });

  it('stops spinner with custom stopMsg', () => {
    const spinner = createMockSpinner();
    exitOnNull(null, spinner, 'missing', 'Error');

    expect(spinner.stop).toHaveBeenCalledWith('Error');
  });

  it('does not call spinner.stop on success', () => {
    const spinner = createMockSpinner();
    exitOnNull({ id: '1' }, spinner, 'not used');

    expect(spinner.stop).not.toHaveBeenCalled();
  });
});
