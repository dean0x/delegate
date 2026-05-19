# Complexity Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17
**Diff Range**: 40f9537...HEAD (5 commits)

## Issues in Your Changes (BLOCKING)

### HIGH

(none)

### MEDIUM

**Repeated cleanup error-handling block (4 occurrences)** -- Confidence: 85%
- `tmux-connector.ts:165-171`, `tmux-connector.ts:204-210`, `tmux-connector.ts:247-253`, `tmux-connector.ts:629-635`
- Problem: The same 5-line pattern (call `hooks.cleanup`, check `!ok`, warn with context object) is duplicated 4 times across `spawn`, `destroy`, `dispose`, and `triggerExit`. This was introduced by this diff -- previously cleanup results were silently ignored, now each call site has an identical error-handling block with only the log prefix string varying.
- Impact: Adding a new cleanup call site requires copying the same block. If the logging format or error-handling strategy changes, 4 locations must be updated in sync.
- Fix: Extract a private helper:
  ```typescript
  private loggedCleanup(caller: string, taskId: string, sessionsDir: string): void {
    const result = this.deps.hooks.cleanup(taskId, sessionsDir);
    if (!result.ok) {
      this.deps.logger.warn(`${caller}: hooks.cleanup failed`, {
        taskId,
        error: result.error.message,
      });
    }
  }
  ```
  Then replace all 4 call sites with `this.loggedCleanup('spawn', ...)` etc.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`spawn()` is 54 lines** -- Confidence: 82%
- `tmux-connector.ts:135-188`
- Problem: After the refactoring that extracted `buildActiveSession`, `spawn()` is still 54 lines (including the JSDoc). The complexity threshold for "warning" is 30-50 lines. The method itself is well-structured with numbered steps and early returns, so this is borderline rather than urgent. The bulk comes from the cleanup error-handling block (addressed above) -- extracting `loggedCleanup` would bring spawn under 50 lines.
- Impact: Minor readability concern. The numbered-step comments make it easy to follow despite the length.
- Fix: Extracting the cleanup helper (see Blocking finding above) would reduce this to ~48 lines, bringing it within the warning threshold.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`flushPendingFiles` nesting depth reaches 4 levels** -- Confidence: 82%
- `tmux-connector.ts:461-508`
- Problem: The method has `try > for > try > catch` nesting that reaches 4 levels of indentation. The method is 48 lines, right at the warning threshold. This is pre-existing structure that was not introduced by this diff (the diff only extracted the force-deliver tail into `forceDeliverRemaining`).
- Impact: Not blocking. The extraction of `forceDeliverRemaining` actually improved this method's length. A future pass could extract the inner parse loop into a helper to flatten the nesting.

**`handleMessageFile` is 41 lines with moderate complexity** -- Confidence: 60%
- `tmux-connector.ts:543-583`
- Problem: Contains an async gap re-check pattern, type guard, buffer insertion, ordered delivery, and a safety-cap overflow handler. Cyclomatic complexity is approximately 7 (moderate). The only change in this diff is wrapping the `.catch()` on the caller side, not the method body itself.
- Impact: Below the reporting threshold for pre-existing issues.

## Suggestions (Lower Confidence)

- **`startMessagesWatcher` callback nesting** - `tmux-connector.ts:338-362` (Confidence: 70%) -- The watch callback contains a nested `setTimeout` callback, which itself contains a `.catch` callback. Three levels of closure nesting is tolerable but makes the control flow harder to trace at a glance.

- **`TmuxConnector` class is 662 lines** - `tmux-connector.ts` (Confidence: 65%) -- The file exceeds the 500-line "warning" threshold. The class has 15 methods (6 public, 9 private). The extractions in this diff (splitting `startWatchers` into `startSentinelWatcher` + `startMessagesWatcher`, extracting `buildActiveSession` and `forceDeliverRemaining`) added method count but each method is well-focused. Consider grouping related private methods or extracting a message-delivery helper class in a future pass.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Complexity Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The changes in this diff are net positive for complexity: `startWatchers` was split into two focused methods, `buildActiveSession` was extracted to shrink `spawn`, the force-deliver loop was extracted into `forceDeliverRemaining`, and the staleness check was made safe against concurrent-modification by collecting stale entries before mutating. The `MIN_CHECK_INTERVAL_MS` clamp replaces a manual loop with a clean `Math.max(Math.min(...), floor)` expression.

The one actionable condition is the repeated cleanup error-handling block (4 identical copies introduced by this diff). Extracting a `loggedCleanup` helper would eliminate the duplication and also bring `spawn()` back under 50 lines.
