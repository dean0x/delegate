# Complexity Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17

## Issues in Your Changes (BLOCKING)

### HIGH

**`spawn()` exceeds 50-line function limit** - `tmux-connector.ts:135`
**Confidence**: 85%
- Problem: At 53 lines, `spawn()` slightly exceeds the 50-line threshold. It orchestrates 5 sequential steps (validate, generate wrapper, start watchers, create session, restart staleness timer) with early-return error handling. Each step is already delegated, but the orchestration itself is long enough to require scrolling past one screen.
- Fix: The function is borderline and well-structured with numbered comments. The `buildActiveSession` extraction already reduced it from what would have been ~80 lines. Consider extracting the session-creation + error-cleanup block (lines 162-179) into a private helper like `createAndRegisterSession()`, but this is marginal — the current form is readable with its numbered steps.

**`buildWrapperScript()` is a 59-line template function** - `tmux-hooks.ts:94`
**Confidence**: 82%
- Problem: At 59 lines, this function exceeds the 50-line threshold. However, it is primarily a bash template literal with embedded shell comments. The actual TypeScript logic is just 3 lines at the top (lines 95-97) followed by a single `return` of the template.
- Fix: This is a template-generation function — its length comes from the generated script content, not from branching logic. Cyclomatic complexity is 1 (no branches in the TypeScript code). Splitting the template into fragments would actually hurt readability since the bash script needs to be read as a whole. Acceptable as-is given the nature of template code. If desired, the sentinel-guard block and the main-loop block could be extracted as named constants similar to `NEXT_SEQ_FN`.

### MEDIUM

**`flushPendingFiles()` has 4 levels of nesting** - `tmux-connector.ts:472`
**Confidence**: 83%
- Problem: The `try/finally` + `for` loop + inner `try/catch` creates 4 levels of nesting (method -> try -> for -> try). While each level serves a purpose (re-entrancy guard, cleanup guarantee, per-file error isolation), it requires careful reading.
- Fix: Extract the inner per-file parsing into a private helper:
  ```typescript
  private parseMessageFile(filePath: string): OutputMessage | null {
    try {
      const raw = this.readFileSyncFn(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return isOutputMessage(parsed) ? parsed : null;
    } catch {
      this.deps.logger.warn('Flush: failed to parse message file', { filePath });
      return null;
    }
  }
  ```
  This reduces `flushPendingFiles` nesting to 3 levels and makes the flush loop body a simple filter-and-accumulate.

**`runSharedStalenessCheck()` has moderate cyclomatic complexity** - `tmux-connector.ts:412`
**Confidence**: 80%
- Problem: At 47 lines with 5 branch points (empty check, listResult error, for-loop with exited check, alive-set membership check, silence threshold), cyclomatic complexity is approximately 7. The two-phase approach (collect stale entries, then trigger exits) is correct for mutation safety but adds cognitive overhead.
- Fix: The function is well-commented and the two-phase pattern is the correct approach for iterating-then-mutating. No action needed — complexity is within the warning range (5-10) but not critical.

**`triggerExit()` has 6 parameters** - `tmux-connector.ts:621`
**Confidence**: 82%
- Problem: The function takes 6 parameters (`taskId`, `session`, `code`, `signal`, `callbacks`, `skipTimerRestart`). This exceeds the 5-parameter warning threshold. The `skipTimerRestart` boolean parameter is a flag that changes behavior — a design smell.
- Fix: Since `callbacks` is always `session.callbacks` at every call site (verified: line 451 and 551), remove it from the parameter list and read it from `session.callbacks` directly. This drops to 5 parameters. The `skipTimerRestart` flag is justified by the batch-stale-detection optimization comment at the call site.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`ActiveSession` interface has 11 fields** - `tmux-connector.ts:88`
**Confidence**: 80%
- Problem: The `ActiveSession` interface groups 11 fields into a flat structure. While all fields are needed for session management, the breadth makes it harder to reason about which fields relate to which concern (delivery state vs. watcher state vs. lifecycle state).
- Fix: Consider grouping related fields into sub-objects if the interface grows further. Current grouping could be:
  - Delivery state: `lastDeliveredSeq`, `pendingMessages`, `nextExpectedSeq`
  - Watcher state: `sentinelWatcher`, `messagesWatcher`, `debounceTimers`
  - Lifecycle: `exited`, `handle`, `callbacks`, `flushing`
  - Config: `stalenessConfig`, `lastAliveCheck`, `messagesDir`
  
  However, 11 fields for an internal (non-exported) state object is borderline acceptable. Flag for future if it grows beyond 12-13.

## Pre-existing Issues (Not Blocking)

(none — all files are new in this branch)

## Suggestions (Lower Confidence)

- **`listSessions()` parsing loop has implicit coupling to tmux format string** - `tmux-session-manager.ts:203` (Confidence: 65%) — The 5-part colon-split parsing is tightly coupled to the format string 3 lines above. If one changes without the other, parsing silently produces wrong results. A named constant for the expected field count would make the coupling explicit.

- **File-level line count for `tmux-connector.ts` is 700 lines** - `tmux-connector.ts` (Confidence: 70%) — At 700 lines the file exceeds the 500-line warning threshold. However, it contains a single cohesive class with clear responsibility (managed session lifecycle). The 17 methods are individually small and well-named. Splitting would fragment related logic across files. Acceptable given the domain complexity.

- **`handleMessageFile` re-checks `session.exited` after async gap** - `tmux-connector.ts:563` (Confidence: 62%) — The double-check pattern (`if (session.exited) return` before and after `await`) is correct but non-obvious. A brief inline comment exists (line 562) which helps. No action needed.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Complexity Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

## Rationale

The codebase demonstrates strong complexity management practices overall:

1. **Good decomposition**: The 700-line connector has 17 methods averaging 25 lines each. The largest method (`spawn` at 53 lines) is only marginally over the threshold and reads sequentially.
2. **Named constants**: All magic numbers are extracted (`DEBOUNCE_MS`, `MAX_PENDING_MESSAGES`, `MIN_CHECK_INTERVAL_MS`, `FILE_MODE`, `DEFAULT_WIDTH/HEIGHT`).
3. **Design decisions documented**: Module-level JSDoc explains non-obvious architectural choices (shared timer, pre-launch watcher, sentinel detection).
4. **Nesting controlled**: Maximum nesting is 4 levels (in `flushPendingFiles`), with one actionable extraction opportunity.
5. **Clear control flow**: Early returns used consistently; no deeply nested if/else chains.

The two HIGH findings are borderline (53 lines vs 50 limit, template function at 59 lines). The most actionable fix is extracting the per-file parsing in `flushPendingFiles` and removing the redundant `callbacks` parameter from `triggerExit`.
