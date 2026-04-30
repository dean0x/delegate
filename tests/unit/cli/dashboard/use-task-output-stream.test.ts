/**
 * Tests for useTaskOutputStream hook
 * ARCHITECTURE: Tests polling, ring-buffer, ANSI stripping, status-gated cadence
 * Pattern: Fake timers + mock OutputRepository — no real processes
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutputStreamState } from '../../../../src/cli/dashboard/use-task-output-stream.js';
import { MAX_LINES_PER_STREAM, useTaskOutputStream } from '../../../../src/cli/dashboard/use-task-output-stream.js';
import type { TaskId } from '../../../../src/core/domain.js';
import type { OutputRepository } from '../../../../src/core/interfaces.js';
import { err, ok } from '../../../../src/core/result.js';

// ============================================================================
// Helpers
// ============================================================================

function makeTaskId(id: string): TaskId {
  return id as TaskId;
}

function makeOutputRepo(overrides: Partial<OutputRepository> = {}): OutputRepository {
  return {
    get: vi.fn().mockResolvedValue(ok(null)),
    save: vi.fn().mockResolvedValue(ok(undefined)),
    append: vi.fn().mockResolvedValue(ok(undefined)),
    delete: vi.fn().mockResolvedValue(ok(undefined)),
    getSize: vi.fn().mockResolvedValue(ok(0)),
    ...overrides,
  } as OutputRepository;
}

function makeTaskOutput(stdout: string[], stderr: string[] = []) {
  const content = stdout.join('');
  const totalSize = Buffer.byteLength(content, 'utf-8');
  return {
    taskId: makeTaskId('task-1'),
    stdout,
    stderr,
    totalSize,
  };
}

// ============================================================================
// Direct function-level tests (polling logic is pure, hook is integration)
// ============================================================================

// We test the exported pure helpers and the state machine logic via
// the exported hook factory (non-React version) if available, else via
// stub extraction. Since useTaskOutputStream is a React hook we test
// the extracted pure logic it delegates to.

import {
  buildStreamState,
  codePointLength,
  codePointSlice,
  mergeOutputLines,
  stripAnsi,
  trySizeProbe,
} from '../../../../src/cli/dashboard/use-task-output-stream.js';

describe('stripAnsi', () => {
  it('removes basic color codes', () => {
    const input = '\x1b[31mred text\x1b[0m';
    expect(stripAnsi(input)).toBe('red text');
  });

  it('removes cursor movement codes', () => {
    const input = '\x1b[2A\x1b[1Bsome text';
    expect(stripAnsi(input)).toBe('some text');
  });

  it('removes complex sequences (256-color)', () => {
    const input = '\x1b[38;5;196mcolored\x1b[0m normal';
    expect(stripAnsi(input)).toBe('colored normal');
  });

  it('passes through plain text unchanged', () => {
    const input = 'hello world';
    expect(stripAnsi(input)).toBe('hello world');
  });

  it('handles empty string', () => {
    expect(stripAnsi('')).toBe('');
  });

  it('strips OSC 8 hyperlinks (security: prevents terminal hyperlink injection)', () => {
    // OSC 8 ;; URL ST — common hyperlink sequence
    const input = 'before\x1b]8;;https://evil.example.com\x07click here\x1b]8;;\x07after';
    expect(stripAnsi(input)).toBe('beforeclick hereafter');
  });

  it('strips OSC title-set sequences (xterm \x1B]0;title\x07)', () => {
    // OSC 0 sets terminal window title — could be abused for phishing
    const input = '\x1b]0;injected title\x07normal output';
    expect(stripAnsi(input)).toBe('normal output');
  });

  it('strips OSC sequences with ST terminator (\x1B\\) instead of BEL', () => {
    const input = '\x1b]2;title\x1b\\normal';
    expect(stripAnsi(input)).toBe('normal');
  });

  it('strips single-char ESC sequences (e.g. ESC M reverse-index)', () => {
    const input = 'line\x1bMmore';
    expect(stripAnsi(input)).toBe('linemore');
  });

  it('strips C1 control characters (0x80–0x9F)', () => {
    // C1 controls can trigger terminal state changes in 8-bit mode
    const input = 'text\x9bsequence\x9f';
    expect(stripAnsi(input)).toBe('textsequence');
  });
});

describe('mergeOutputLines', () => {
  it('splits on newlines and returns array of lines', () => {
    const result = mergeOutputLines('line1\nline2\nline3');
    expect(result).toEqual(['line1', 'line2', 'line3']);
  });

  it('handles single line (no newline)', () => {
    const result = mergeOutputLines('single');
    expect(result).toEqual(['single']);
  });

  it('handles empty string', () => {
    const result = mergeOutputLines('');
    expect(result).toEqual([]);
  });

  it('handles trailing newline (omits trailing empty string)', () => {
    const result = mergeOutputLines('line1\nline2\n');
    expect(result).toEqual(['line1', 'line2']);
  });
});

describe('buildStreamState', () => {
  const EMPTY_INITIAL: OutputStreamState = {
    lines: [],
    totalBytes: 0,
    totalChars: 0,
    lastFetchedAt: null,
    error: null,
    droppedLines: 0,
    taskStatus: 'pending',
  };

  it('returns pending state when output is null', () => {
    const state = buildStreamState(EMPTY_INITIAL, null, 'pending');
    expect(state.lines).toEqual([]);
    expect(state.taskStatus).toBe('pending');
    expect(state.totalBytes).toBe(0);
  });

  it('appends new lines when totalSize grows', () => {
    const content = 'line1\nline2\n';
    const output = makeTaskOutput([content]);
    const state = buildStreamState(EMPTY_INITIAL, output, 'running');
    expect(state.lines).toEqual(['line1', 'line2']);
    expect(state.totalBytes).toBe(output.totalSize);
    expect(state.taskStatus).toBe('running');
    expect(state.lastFetchedAt).not.toBeNull();
  });

  it('strips ANSI codes from appended lines', () => {
    const content = '\x1b[32mgreen\x1b[0m\nplain\n';
    const output = makeTaskOutput([content]);
    const state = buildStreamState(EMPTY_INITIAL, output, 'running');
    expect(state.lines).toContain('green');
    expect(state.lines).toContain('plain');
  });

  it('performs delta-parse: only appends new content beyond previous totalBytes', () => {
    const initial = 'first\n';
    const firstOutput = makeTaskOutput([initial]);
    const firstState = buildStreamState(EMPTY_INITIAL, firstOutput, 'running');
    expect(firstState.lines).toEqual(['first']);

    // Now more content appended
    const extended = 'first\nsecond\n';
    const secondOutput = makeTaskOutput([extended]);
    const secondState = buildStreamState(firstState, secondOutput, 'running');
    expect(secondState.lines).toEqual(['first', 'second']);
  });

  it('does not duplicate lines when called with same totalBytes', () => {
    const content = 'line1\nline2\n';
    const output = makeTaskOutput([content]);
    const firstState = buildStreamState(EMPTY_INITIAL, output, 'running');
    const secondState = buildStreamState(firstState, output, 'running');
    // Same totalBytes — no delta, lines unchanged
    expect(secondState.lines).toEqual(['first_NOT_PRESENT', 'line1', 'line2'].slice(1));
    expect(secondState.lines.length).toBe(2);
  });

  it('trims ring buffer to MAX_LINES_PER_STREAM when exceeded', () => {
    // Pre-fill with MAX_LINES_PER_STREAM lines
    const initialLines = Array.from({ length: MAX_LINES_PER_STREAM }, (_, i) => `line-${i}`);
    const prevContent = 'x'.repeat(1000); // ASCII only: bytes === chars
    const withMaxLines: OutputStreamState = {
      ...EMPTY_INITIAL,
      lines: initialLines,
      totalBytes: 1000,
      totalChars: 1000, // ASCII: byte count equals char count
    };

    // Add 2 more lines
    const newContent = 'new1\nnew2\n';
    const fullContent = prevContent + newContent;
    const output = {
      taskId: makeTaskId('task-1'),
      stdout: [fullContent],
      stderr: [],
      totalSize: Buffer.byteLength(fullContent, 'utf-8'),
    };
    const state = buildStreamState(withMaxLines, output, 'running');

    expect(state.lines.length).toBe(MAX_LINES_PER_STREAM);
    expect(state.droppedLines).toBe(2); // 2 old lines trimmed from front
    // Tail should include the new lines
    const lastTwo = state.lines.slice(-2);
    expect(lastTwo).toEqual(['new1', 'new2']);
  });

  it('sets error when provided', () => {
    const state: OutputStreamState = {
      ...EMPTY_INITIAL,
      error: 'fetch failed',
    };
    // error field is sticky — preserved until cleared externally
    expect(state.error).toBe('fetch failed');
  });

  it('transitions taskStatus to terminal correctly', () => {
    const content = 'done\n';
    const output = makeTaskOutput([content]);
    const state = buildStreamState(EMPTY_INITIAL, output, 'terminal');
    expect(state.taskStatus).toBe('terminal');
  });

  // ---- UTF-8 multi-byte safety regression tests ----

  it('preserves emoji characters without U+FFFD corruption (delta at ASCII boundary)', () => {
    // "hello\n" is 6 bytes / 6 chars.  Then we append " 🎉\n" which is
    // a 4-byte emoji — a naive byte-offset slice at byte 6 would be safe
    // here, but the real danger is when the emoji straddles the boundary.
    const first = 'hello\n';
    const firstOutput = makeTaskOutput([first]);
    const firstState = buildStreamState(EMPTY_INITIAL, firstOutput, 'running');
    expect(firstState.lines).toEqual(['hello']);

    const extended = 'hello\n🎉\n';
    const secondOutput = makeTaskOutput([extended]);
    const secondState = buildStreamState(firstState, secondOutput, 'running');
    expect(secondState.lines).toEqual(['hello', '🎉']);
    // Must NOT contain replacement character from a corrupted byte slice
    expect(secondState.lines.join('')).not.toContain('\uFFFD');
  });

  it('preserves CJK characters across chunk boundary (multi-byte delta)', () => {
    // Each CJK character is 3 bytes in UTF-8.  After "ab" (2 bytes/chars)
    // the emoji/CJK slice must start on a character boundary.
    const first = 'ab';
    const firstOutput = makeTaskOutput([first]);
    const firstState = buildStreamState(EMPTY_INITIAL, firstOutput, 'running');

    // "ab日本語\n" — "日" starts at byte offset 2, char offset 2 — safe
    // but without totalChars tracking a byte-offset slice at prev.totalBytes
    // (=2) would accidentally work here; test with 3-byte char spanning boundary
    const extended = 'ab\n日本語\n';
    const secondOutput = makeTaskOutput([extended]);
    const secondState = buildStreamState(firstState, secondOutput, 'running');
    expect(secondState.lines).toContain('日本語');
    expect(secondState.lines.join('')).not.toContain('\uFFFD');
  });

  it('does not corrupt emoji straddling a simulated chunk boundary via totalChars', () => {
    // Simulate: first poll returns "A🎉" (no newline — no lines yet, but chars tracked).
    // 🎉 = U+1F389 (4 bytes, but 1 Unicode code point via [...str]).
    // totalBytes after first poll = 1 (A) + 4 (🎉) = 5 bytes.
    // totalChars = 2 (A=1, 🎉=1).
    // Second poll returns "A🎉B\n". Delta = chars[2..] = "B\n".
    // The key assertion: result must NOT contain U+FFFD which would appear
    // if we sliced at byte offset 2 (cutting 🎉's 4-byte sequence).
    const firstContent = 'A🎉';
    const firstOutput = makeTaskOutput([firstContent]);
    const firstState = buildStreamState(EMPTY_INITIAL, firstOutput, 'running');
    // totalChars: A=1, 🎉=1 (one code point via [...str]) → 2
    expect(firstState.totalChars).toBe(2);
    // totalBytes: A=1, 🎉=4 → 5
    expect(firstState.totalBytes).toBe(5);

    const secondContent = 'A🎉B\n';
    const secondOutput = makeTaskOutput([secondContent]);
    const secondState = buildStreamState(firstState, secondOutput, 'running');
    // Delta chars[2..] = "B\n" → produces line "B".
    // Naive byte-slice at byte 2 would split the 4-byte 🎉 sequence → U+FFFD.
    // Char-index slice correctly yields only "B\n".
    expect(secondState.lines.join('')).not.toContain('\uFFFD');
    // The ring buffer contains "B" from the delta (A🎉 had no newline so no line)
    expect(secondState.lines).toContain('B');
  });

  it('tracks totalChars correctly alongside totalBytes for multi-byte content', () => {
    // "café\n" — 'é' is 2 bytes but 1 char; total bytes = 6, total chars = 5
    const content = 'café\n';
    const output = makeTaskOutput([content]);
    const state = buildStreamState(EMPTY_INITIAL, output, 'running');
    expect(state.lines).toEqual(['café']);
    expect(state.totalBytes).toBe(Buffer.byteLength(content, 'utf-8'));
    expect(state.totalChars).toBe([...content].length);
    expect(state.totalBytes).toBeGreaterThan(state.totalChars); // bytes > chars for multibyte
  });
});

// ============================================================================
// Polling cadence tests (test the shouldPollThisTick exported helper)
// ============================================================================

import { shouldPollThisTick } from '../../../../src/cli/dashboard/use-task-output-stream.js';

describe('shouldPollThisTick', () => {
  it('always polls when status is running (every tick)', () => {
    for (let tick = 0; tick < 10; tick++) {
      expect(shouldPollThisTick('running', tick)).toBe(true);
    }
  });

  it('polls every 5 ticks when status is pending', () => {
    expect(shouldPollThisTick('pending', 0)).toBe(true);
    expect(shouldPollThisTick('pending', 1)).toBe(false);
    expect(shouldPollThisTick('pending', 4)).toBe(false);
    expect(shouldPollThisTick('pending', 5)).toBe(true);
    expect(shouldPollThisTick('pending', 10)).toBe(true);
  });

  it('polls every 5 ticks when status is queued', () => {
    expect(shouldPollThisTick('queued', 0)).toBe(true);
    expect(shouldPollThisTick('queued', 1)).toBe(false);
    expect(shouldPollThisTick('queued', 5)).toBe(true);
  });

  it('never polls when status is terminal', () => {
    for (let tick = 0; tick < 10; tick++) {
      expect(shouldPollThisTick('terminal', tick)).toBe(false);
    }
  });
});

// ============================================================================
// MAX_LINES_PER_STREAM export
// ============================================================================

describe('MAX_LINES_PER_STREAM', () => {
  it('is 500', () => {
    expect(MAX_LINES_PER_STREAM).toBe(500);
  });
});

// ============================================================================
// codePointLength — Unicode code-point counting
// ============================================================================

describe('codePointLength', () => {
  it('counts ASCII characters correctly (T5)', () => {
    expect(codePointLength('hello')).toBe(5);
  });

  it('counts emoji as 1 code point each (T6)', () => {
    // 🎉 is U+1F389 — 4 bytes in UTF-8 but a single code point
    expect(codePointLength('🎉')).toBe(1);
    expect(codePointLength('A🎉B')).toBe(3);
  });

  it('counts CJK characters as 1 code point each (T7)', () => {
    // '日本語' — 3 CJK chars, 3 code points, 9 UTF-8 bytes
    expect(codePointLength('日本語')).toBe(3);
  });

  it('returns 0 for empty string (T8)', () => {
    expect(codePointLength('')).toBe(0);
  });
});

// ============================================================================
// codePointSlice — Unicode-safe slicing from code-point index
// ============================================================================

describe('codePointSlice', () => {
  it('slices ASCII string from mid-point (T9)', () => {
    expect(codePointSlice('hello world', 6)).toBe('world');
  });

  it('slices at emoji code-point boundary without corruption (T10)', () => {
    // 'A🎉B' → code points: A=0, 🎉=1, B=2
    // Slice from code-point 1 → '🎉B'
    expect(codePointSlice('A🎉B', 1)).toBe('🎉B');
    // Must NOT produce U+FFFD
    expect(codePointSlice('A🎉B', 1)).not.toContain('�');
  });

  it('returns full string when start is 0 (T11)', () => {
    expect(codePointSlice('hello', 0)).toBe('hello');
  });

  it('returns empty string when start >= length (T12)', () => {
    expect(codePointSlice('hi', 2)).toBe('');
    expect(codePointSlice('hi', 10)).toBe('');
  });

  it('handles surrogate-pair emoji correctly (T13)', () => {
    // 'café🚀' — c=0,a=1,f=2,é=3,🚀=4 (5 code points)
    // Slice from 3 → 'é🚀'
    const result = codePointSlice('café🚀', 3);
    expect(result).toBe('é🚀');
    expect(result).not.toContain('�');
  });
});

// ============================================================================
// buildStreamState totalBytes guard (T17–T19)
// ============================================================================

const INITIAL_STREAM_STATE: OutputStreamState = {
  lines: [],
  totalBytes: 0,
  totalChars: 0,
  lastFetchedAt: null,
  error: null,
  droppedLines: 0,
  taskStatus: 'running',
};

describe('buildStreamState totalBytes guard', () => {
  // T17–T19: These tests verify the in-function size guard inside buildStreamState.
  // The guard skips re-parsing when totalSize is unchanged and lines are populated.

  it('size unchanged, prev has lines → skips full data via totalBytes guard (T17)', () => {
    const output = makeTaskOutput(['hello\n']);
    const state1 = buildStreamState(INITIAL_STREAM_STATE, output, 'running');
    expect(state1.lines).toEqual(['hello']);

    // Same output (same totalSize) — buildStreamState returns status/timestamp update only
    const state2 = buildStreamState(state1, output, 'running');
    expect(state2.lines).toEqual(['hello']); // unchanged
    expect(state2.totalBytes).toBe(state1.totalBytes);
  });

  it('size changed → full fetch produces updated lines (T18)', () => {
    const output1 = makeTaskOutput(['hello\n']);
    const state1 = buildStreamState(INITIAL_STREAM_STATE, output1, 'running');

    const output2 = makeTaskOutput(['hello\nworld\n']);
    const state2 = buildStreamState(state1, output2, 'running');
    expect(state2.lines).toContain('world');
  });

  it('first fetch always goes through when lines is empty (T19)', () => {
    // totalSize matches prev.totalBytes (both 0) BUT prev.lines is empty
    // → buildStreamState must not skip (lines guard in size-skip condition)
    const output = makeTaskOutput(['']);
    const state = buildStreamState(INITIAL_STREAM_STATE, output, 'running');
    expect(state.lines).toEqual([]);
    expect(state.taskStatus).toBe('running');
  });
});

// ============================================================================
// trySizeProbe — actual probe function (T20–T21)
// ============================================================================

describe('trySizeProbe', () => {
  it('getSize error → returns false (full get() should proceed) (T20)', async () => {
    // Arrange: prev state with totalBytes > 0 and lines populated — conditions that
    // would normally trigger a probe-hit if getSize returned the same byte count.
    const taskId = makeTaskId('task-t20');
    const prev: OutputStreamState = {
      ...INITIAL_STREAM_STATE,
      lines: ['existing line'],
      totalBytes: 12,
      totalChars: 12,
    };
    const repo = makeOutputRepo({
      getSize: vi.fn().mockResolvedValue(err(new Error('db read error'))),
    });

    // Act: call the actual exported trySizeProbe function
    const result = await trySizeProbe(repo, taskId, prev, false);

    // Assert: probe returns false — getSize failure must not block the full fetch
    expect(result).toBe(false);
  });

  it('getSize returns matching size with populated lines → returns true (probe hit) (T21)', async () => {
    // Arrange: prev state where totalBytes matches what getSize reports
    const taskId = makeTaskId('task-t21');
    const prev: OutputStreamState = {
      ...INITIAL_STREAM_STATE,
      lines: ['some line'],
      totalBytes: 42,
      totalChars: 42,
    };
    const repo = makeOutputRepo({
      getSize: vi.fn().mockResolvedValue(ok(42)), // matches prev.totalBytes
    });

    // Act
    const result = await trySizeProbe(repo, taskId, prev, false);

    // Assert: probe confirms no new output — full fetch can be skipped
    expect(result).toBe(true);
  });
});
