/**
 * useTaskOutputStream — live per-task output streaming via polling
 * ARCHITECTURE: Ring-buffer hook, ANSI-stripped, delta-parse for efficiency
 * Pattern: Custom React hook + exported pure helpers for unit-testability
 *
 * Key exports:
 *  - useTaskOutputStream: React hook (used by App/WorkspaceView)
 *  - buildStreamState: Pure function (exported for testing)
 *  - stripAnsi: Pure function (exported for testing)
 *  - mergeOutputLines: Pure function (exported for testing)
 *  - shouldPollThisTick: Pure function (exported for testing)
 *  - MAX_LINES_PER_STREAM: Constant (exported for testing)
 *  - codePointLength: Pure function (exported for testing)
 *  - codePointSlice: Pure function (exported for testing)
 *  - computeDelta: Pure function (exported for testing)
 *  - trySizeProbe: Async probe function (exported for testing)
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TaskId, TaskOutput } from '../../core/domain.js';
import type { OutputRepository } from '../../core/interfaces.js';

// ============================================================================
// Types
// ============================================================================

export type TaskStreamStatus = 'pending' | 'queued' | 'running' | 'terminal';

export interface OutputStreamState {
  /** Tail buffer, capped at MAX_LINES_PER_STREAM */
  readonly lines: readonly string[];
  readonly totalBytes: number;
  /**
   * Character (code-point) count corresponding to totalBytes.
   * Used for UTF-8-safe delta slicing: we slice by char index, not byte offset,
   * so multi-byte characters (emoji, CJK, accented) are never split mid-sequence.
   *
   * Defaults to 0 when absent (backward-compatible with callers that construct
   * a literal OutputStreamState without this field, e.g. TaskPanel.EMPTY_STREAM).
   * The delta logic reads `prev.totalChars ?? 0`, so an absent field is equivalent
   * to a fresh start — the first poll will read the full content from char 0.
   */
  readonly totalChars?: number;
  readonly lastFetchedAt: Date | null;
  readonly error: string | null;
  /** Number of lines trimmed from front due to ring buffer overflow */
  readonly droppedLines: number;
  readonly taskStatus: TaskStreamStatus;
}

// ============================================================================
// Constants
// ============================================================================

export const MAX_LINES_PER_STREAM = 500;

/**
 * Comprehensive ANSI / terminal escape sequence regex.
 *
 * Covers:
 *  - CSI sequences:       \x1B[ ... final-byte (colors, cursor, SGR)
 *  - OSC sequences:       \x1B] ... \x07  OR  \x1B] ... \x1B\\ (hyperlinks, title-set)
 *  - DCS / PM / APC / SOS: \x1BP ... \x1B\\  (device control, rarely seen)
 *  - Single-char ESC:     \x1B followed by any char in 0x40–0x5F (e.g. \x1BM for RI)
 *  - C1 controls (8-bit): U+0080–U+009F (often emitted by terminal emulators)
 *
 * Reference: https://invisible-island.net/xterm/ctlseqs/ctlseqs.html
 * The pattern is intentionally broad to prevent malicious task output from
 * rewriting the terminal title, injecting OSC 8 hyperlinks, or altering state.
 */
const ANSI_REGEX =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P_\]^X][^\x1b]*\x1b\\|\x1b[@-_]|[\x80-\x9f]/g;

/** Number of ticks between polls for non-running tasks */
const SLOW_POLL_INTERVAL = 5;

// ============================================================================
// Pure helper functions (exported for unit testing)
// ============================================================================

/**
 * Strip ANSI escape sequences from a string.
 * Uses the permissive regex from the plan §5.
 */
export function stripAnsi(input: string): string {
  return input.replace(ANSI_REGEX, '');
}

/**
 * Split a string on newlines into an array of lines.
 * Trailing empty string (from trailing newline) is omitted.
 */
export function mergeOutputLines(content: string): string[] {
  if (content === '') return [];
  const lines = content.split('\n');
  // Omit trailing empty string from trailing newline
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

/**
 * Count Unicode code points in a string using the for-of iterator.
 * Correct for multi-byte characters (emoji, CJK) that are represented as
 * surrogate pairs in JavaScript's UTF-16 encoding: spread/for-of yields one
 * iteration per code point, not per UTF-16 code unit.
 *
 * ARCHITECTURE: Replaces `[...str].length` spread — avoids allocating a full
 * array of characters on every poll tick, eliminating the O(N) memory spike
 * that caused dashboard OOM crashes with large task outputs.
 */
export function codePointLength(str: string): number {
  // ASCII fast-path: for strings with no multi-byte characters (charCode ≤ 0x7F),
  // every UTF-16 code unit is exactly one code point so str.length is correct.
  // CLI/build log output is almost always pure ASCII, making this the common case.
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) > 0x7f) {
      // Non-ASCII found — fall through to accurate for-of code-point count
      let n = 0;
      for (const _ of str) n++;
      return n;
    }
  }
  return str.length;
}

/**
 * Return the substring of `str` starting at the given Unicode code-point index.
 * Safe for multi-byte characters: the for-of iterator yields one step per code
 * point, so the returned slice never cuts inside a surrogate pair.
 *
 * ARCHITECTURE: Replaces `[...str].slice(start).join('')` spread — avoids
 * allocating a full code-point array, eliminating the OOM-inducing allocation
 * that grew linearly with task output size on every poll tick.
 */
export function codePointSlice(str: string, start: number): string {
  if (start === 0) return str;
  let cpIdx = 0;
  let cuIdx = 0;
  for (const ch of str) {
    if (cpIdx === start) return str.substring(cuIdx);
    cuIdx += ch.length;
    cpIdx++;
  }
  return '';
}

/**
 * Compute the incremental delta from a set of output chunks, given the previously
 * processed character count.
 *
 * Algorithm:
 * 1. Pass 1 — count code points per chunk via codePointLength (ASCII fast-path is
 *    O(1) per pure-ASCII chunk), accumulate into fullChars.
 * 2. If prevTotalChars >= fullChars → no new data; return { fullChars, newContent: '' }.
 * 3. If prevTotalChars === 0 → first fetch; join all chunks (nothing to skip).
 * 4. Pass 2 — walk chunks with a running code-point accumulator; find the boundary
 *    chunk where accumulated + chunkLen > prevTotalChars, then codePointSlice the
 *    boundary chunk and join only the remaining chunks.
 *
 * PERFORMANCE: Avoids the O(N) `stdout.join('')` allocation on every change tick by
 * working per-chunk and only joining the new suffix. The ASCII fast-path in
 * codePointLength makes Pass 1 nearly free for typical CLI/build output.
 *
 * CORRECTNESS: codePointSlice is used at the boundary so multi-byte characters
 * (emoji, CJK) are never split, preventing U+FFFD replacement characters.
 */
export function computeDelta(
  chunks: readonly string[],
  prevTotalChars: number,
): { fullChars: number; newContent: string } {
  // Pass 1: count total code points across all chunks
  let fullChars = 0;
  for (const chunk of chunks) {
    fullChars += codePointLength(chunk);
  }

  // No new content (includes the prevTotalChars > fullChars defensive case)
  if (prevTotalChars >= fullChars) {
    return { fullChars, newContent: '' };
  }

  // First fetch — return all chunks joined (nothing to skip)
  if (prevTotalChars === 0) {
    return { fullChars, newContent: chunks.join('') };
  }

  // Pass 2: walk chunks to find the boundary where prevTotalChars falls
  let accumulated = 0;
  const result: string[] = [];
  let boundaryFound = false;

  for (const chunk of chunks) {
    const chunkLen = codePointLength(chunk);

    if (boundaryFound) {
      // All chunks after the boundary are included in full
      result.push(chunk);
    } else if (accumulated + chunkLen > prevTotalChars) {
      // This chunk contains the boundary — slice from the remaining offset
      const offsetInChunk = prevTotalChars - accumulated;
      result.push(codePointSlice(chunk, offsetInChunk));
      boundaryFound = true;
    }
    // accumulated + chunkLen <= prevTotalChars → entire chunk already seen, skip
    accumulated += chunkLen;
  }

  return { fullChars, newContent: result.join('') };
}

/**
 * Determine whether a task should be polled on the given tick number.
 * - running: every tick
 * - pending/queued: every SLOW_POLL_INTERVAL ticks
 * - terminal: never (one final fetch was already done at transition time)
 */
export function shouldPollThisTick(status: TaskStreamStatus, tick: number): boolean {
  switch (status) {
    case 'running':
      return true;
    case 'pending':
    case 'queued':
      return tick % SLOW_POLL_INTERVAL === 0;
    case 'terminal':
      return false;
  }
}

/**
 * Build the next OutputStreamState from the previous state and a fresh TaskOutput.
 *
 * Algorithm:
 * 1. If output is null, return updated-status copy of prev state.
 * 2. Delta-parse: extract only the characters beyond prev.totalChars.
 *    We slice by character index (not byte offset) so multi-byte codepoints
 *    (emoji, CJK, accented characters) are never split across chunk boundaries,
 *    which would produce U+FFFD replacement characters in the ring buffer.
 * 3. ANSI-strip the new suffix.
 * 4. Merge new lines into ring buffer, trim from front if over MAX_LINES_PER_STREAM.
 */
export function buildStreamState(
  prev: OutputStreamState,
  output: TaskOutput | null,
  nextStatus: TaskStreamStatus,
): OutputStreamState {
  if (output === null) {
    return {
      ...prev,
      taskStatus: nextStatus,
    };
  }

  const newTotalBytes = output.totalSize;

  // No new data — update status and timestamp only
  if (newTotalBytes <= prev.totalBytes && prev.lines.length > 0) {
    return {
      ...prev,
      taskStatus: nextStatus,
      lastFetchedAt: new Date(),
    };
  }

  // Compute delta: extract only the code points beyond what we've already processed.
  // computeDelta works per-chunk, avoiding the O(N) stdout.join('') allocation on
  // every change tick. It also uses codePointSlice at chunk boundaries, which is
  // UTF-8-safe and prevents U+FFFD corruption for multi-byte characters (emoji, CJK).
  //
  // prevTotalChars defaults to 0 if the caller constructed the state literal
  // without the totalChars field (backward-compatible — treats as fresh start).
  const prevTotalChars = prev.totalChars ?? 0;
  const { fullChars, newContent } = computeDelta(output.stdout, prevTotalChars);

  if (newContent === '') {
    // No new characters — update metadata only
    return { ...prev, totalBytes: newTotalBytes, totalChars: fullChars, taskStatus: nextStatus, lastFetchedAt: new Date() };
  }

  // Strip ANSI and split into lines
  const stripped = stripAnsi(newContent);
  const newLines = mergeOutputLines(stripped);

  if (newLines.length === 0) {
    return {
      ...prev,
      totalBytes: newTotalBytes,
      totalChars: fullChars,
      taskStatus: nextStatus,
      lastFetchedAt: new Date(),
    };
  }

  // Merge into ring buffer
  const combined = [...prev.lines, ...newLines];
  let droppedLines = prev.droppedLines;

  if (combined.length > MAX_LINES_PER_STREAM) {
    const excess = combined.length - MAX_LINES_PER_STREAM;
    droppedLines += excess;
    combined.splice(0, excess);
  }

  return {
    lines: combined,
    totalBytes: newTotalBytes,
    totalChars: fullChars,
    lastFetchedAt: new Date(),
    error: null,
    droppedLines,
    taskStatus: nextStatus,
  };
}

// ============================================================================
// Size probe (exported for unit testing)
// ============================================================================

/**
 * Cheap size-probe: queries `outputRepo.getSize()` to determine whether the
 * remote output has changed since the last fetch.
 *
 * Returns `true` when the probe confirms output is unchanged (full fetch can be
 * skipped). Returns `false` in ALL other cases — getSize error, size changed,
 * or prev.lines is empty (initial fetch must always proceed).
 *
 * DECISION: Side effects on probe-hit (updating streamsRef, marking terminal)
 * are intentionally left to the caller so this function stays pure and
 * independently testable.
 */
export async function trySizeProbe(
  outputRepo: OutputRepository,
  taskId: TaskId,
  prev: OutputStreamState,
  closing: boolean,
): Promise<boolean> {
  if (closing) return true; // closing — treat as "skip fetch"
  const sizeResult = await outputRepo.getSize(taskId);
  if (sizeResult.ok && sizeResult.value === prev.totalBytes && prev.lines.length > 0) {
    return true;
  }
  return false;
}

// ============================================================================
// React hook
// ============================================================================

const INITIAL_STREAM_STATE: OutputStreamState = {
  lines: [],
  totalBytes: 0,
  totalChars: 0,
  lastFetchedAt: null,
  error: null,
  droppedLines: 0,
  taskStatus: 'pending',
};

function classifyStatus(rawStatus: string): TaskStreamStatus {
  switch (rawStatus) {
    case 'running':
      return 'running';
    case 'queued':
      return 'queued';
    case 'completed':
    case 'failed':
    case 'cancelled':
      return 'terminal';
    case 'pending':
    default:
      return 'pending';
  }
}

/**
 * Hook that polls OutputRepository for each taskId in the list, maintaining
 * per-task stream state in a ref-backed Map (version counter triggers renders).
 *
 * Polling strategy:
 * - running tasks: every tick (1s)
 * - pending/queued tasks: every 5 ticks
 * - terminal tasks: one final fetch at transition, then stopped
 *
 * On taskIds prop change: entries for removed tasks are purged; new entries
 * start as pending.
 *
 * Polling cadence stability: taskIds and taskStatuses are stored in refs so
 * doPoll's useCallback does NOT depend on them. This prevents the interval
 * from being torn down and re-established on every render when the caller
 * supplies fresh [] / new Map() references (e.g. from nullish-coalescing
 * fallbacks like `data?.workspaceData?.childTaskIds ?? []`).
 */
export function useTaskOutputStream(
  outputRepo: OutputRepository,
  taskIds: readonly TaskId[],
  taskStatuses: ReadonlyMap<TaskId, string>,
  enabled: boolean,
): { streams: ReadonlyMap<TaskId, OutputStreamState>; refreshNow: () => void } {
  // Version counter drives re-renders without exposing the mutable Map to React
  const [, setVersion] = useState(0);

  // Internal mutable Map — never directly set to React state
  const streamsRef = useRef<Map<TaskId, OutputStreamState>>(new Map());

  // Tick counter for cadence gating
  const tickRef = useRef(0);

  // Guard against overlapping in-flight fetches
  const fetchingRef = useRef(false);

  // Closing ref to prevent setState after unmount
  const closingRef = useRef(false);

  // Track previous task IDs to detect changes
  const prevTaskIdsRef = useRef<readonly TaskId[]>([]);

  // Refs that hold the latest taskIds / taskStatuses so doPoll can read them
  // without being included in doPoll's dependency array. This keeps the
  // setInterval cadence stable even when callers pass fresh array/map references.
  const taskIdsRef = useRef<readonly TaskId[]>(taskIds);
  const taskStatusesRef = useRef<ReadonlyMap<TaskId, string>>(taskStatuses);

  // Keep refs in sync on every render (before doPoll fires)
  taskIdsRef.current = taskIds;
  taskStatusesRef.current = taskStatuses;

  // Synchronize streamsRef when taskIds change
  const taskIdsKey = taskIds.join(',');

  // Track which terminal tasks have had their final fetch done
  const terminalFetchedRef = useRef<Set<TaskId>>(new Set());

  useEffect(() => {
    const currentTaskIds = taskIdsRef.current;
    const prevIds = new Set(prevTaskIdsRef.current);
    const nextIds = new Set(currentTaskIds);

    // Purge removed tasks
    for (const [id] of streamsRef.current) {
      if (!nextIds.has(id)) {
        streamsRef.current.delete(id);
        terminalFetchedRef.current.delete(id);
      }
    }

    // Initialize new tasks
    for (const id of currentTaskIds) {
      if (!prevIds.has(id)) {
        streamsRef.current.set(id, { ...INITIAL_STREAM_STATE });
      }
    }

    prevTaskIdsRef.current = currentTaskIds;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskIdsKey]);

  // Convenience accessor: returns the current stream state for a task, or the
  // initial state if no entry exists yet. Centralises the fallback pattern that
  // previously appeared 5× in doPoll, each time with a slightly different spread.
  const getPrev = (id: TaskId): OutputStreamState =>
    streamsRef.current.get(id) ?? INITIAL_STREAM_STATE;

  // doPoll reads taskIds/taskStatuses via refs — stable identity across renders.
  const doPoll = useCallback(async (): Promise<void> => {
    if (fetchingRef.current || !enabled) return;
    fetchingRef.current = true;

    const currentTick = tickRef.current;
    tickRef.current += 1;

    // Snapshot the refs at poll time so all fetches in this batch use the same list
    const currentTaskIds = taskIdsRef.current;
    const currentTaskStatuses = taskStatusesRef.current;

    try {
      const fetches: Array<Promise<void>> = [];

      for (const taskId of currentTaskIds) {
        const prev = getPrev(taskId);
        const rawStatus = currentTaskStatuses.get(taskId) ?? 'pending';
        const status = classifyStatus(rawStatus);

        // Terminal tasks: one final fetch, then stop
        if (status === 'terminal') {
          if (terminalFetchedRef.current.has(taskId)) {
            continue; // Already done final fetch
          }
        } else if (!shouldPollThisTick(status, currentTick)) {
          continue;
        }

        const fetchTask = async (): Promise<void> => {
          try {
            const probeHit = await trySizeProbe(outputRepo, taskId, prev, closingRef.current);
            if (probeHit) {
              // Probe confirmed no new output — apply status/timestamp update only
              if (!closingRef.current) {
                streamsRef.current.set(taskId, {
                  ...getPrev(taskId),
                  taskStatus: status,
                  lastFetchedAt: new Date(),
                });
                if (status === 'terminal') terminalFetchedRef.current.add(taskId);
              }
              return;
            }

            const result = await outputRepo.get(taskId);
            if (closingRef.current) return;

            if (!result.ok) {
              const errorState: OutputStreamState = {
                ...getPrev(taskId),
                error: result.error.message,
              };
              streamsRef.current.set(taskId, errorState);
              return;
            }

            streamsRef.current.set(taskId, buildStreamState(getPrev(taskId), result.value, status));

            if (status === 'terminal') terminalFetchedRef.current.add(taskId);
          } catch (e) {
            if (!closingRef.current) {
              const errorState: OutputStreamState = {
                ...getPrev(taskId),
                error: e instanceof Error ? e.message : String(e),
              };
              streamsRef.current.set(taskId, errorState);
            }
          }
        };

        fetches.push(fetchTask());
      }

      if (fetches.length > 0) {
        await Promise.all(fetches);
        if (!closingRef.current) {
          setVersion((v) => v + 1);
        }
      }
    } finally {
      fetchingRef.current = false;
    }
    // outputRepo and enabled are the only true dependencies — taskIds/taskStatuses
    // are consumed via refs so they don't force interval recreation.
  }, [outputRepo, enabled]);

  useEffect(() => {
    closingRef.current = false;

    if (!enabled) return;

    // Immediate poll on mount or when enabled
    void doPoll();

    const interval = setInterval(() => {
      void doPoll();
    }, 1_000);

    return () => {
      closingRef.current = true;
      clearInterval(interval);
    };
  }, [doPoll, enabled]);

  const refreshNow = useCallback(() => {
    void doPoll();
  }, [doPoll]);

  return {
    streams: streamsRef.current as ReadonlyMap<TaskId, OutputStreamState>,
    refreshNow,
  };
}
