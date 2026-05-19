# Performance Review Report

**Branch**: feat-agent-eval-mode -> main
**Date**: 2026-03-30T12:14:00Z
**PR**: #125

## Issues in Your Changes (BLOCKING)

### HIGH

**Unbounded output concatenation in `parseEvalOutput`** - `src/services/agent-exit-condition-evaluator.ts:114`
**Confidence**: 85%
- Problem: The evaluator concatenates the full stdout and stderr arrays into a single string (`[...output.stdout, ...output.stderr].join('\n')`) before parsing. Agent tasks can produce substantial output (analysis, code review narrative, git diffs). This creates a potentially large intermediate string that is then split and filtered again in `parseEvalOutput`. For agent eval mode specifically, where the agent is doing code review and producing multi-page analysis, this could be significant.
- Impact: Two full copies of the output exist in memory simultaneously (the array and the joined string), plus a third filtered copy from `lines.filter()`. For a typical agent eval producing 50-100KB of output this is negligible, but the design does not cap output size at all, and the 600-second timeout gives the agent ample time to produce large output.
- Fix: Only parse the last N lines instead of the full output. The evaluator only needs the last non-empty line for the decision and everything before it for feedback. Consider reading output from the end:
  ```typescript
  // Only need the last line for decision + preceding lines for feedback
  const allLines = [...output.stdout, ...output.stderr];
  const nonEmptyLines = allLines.filter((line) => line.trim().length > 0);
  // parseEvalOutput can work directly on the filtered lines array
  return this.parseEvalOutputFromLines(nonEmptyLines, loop.strategy);
  ```
  This avoids the intermediate `.join('\n')` followed by `.split('\n')` round-trip.

### MEDIUM

**Stale state guard performs two sequential DB reads after eval** - `src/services/handlers/loop-handler.ts:282-318`
**Confidence**: 82%
- Problem: After the potentially slow agent eval completes, the stale state guard performs two sequential async DB reads: `findById(loopId)` then `findIterationByTaskId(taskId)`. These are serialized (the iteration fetch only runs if the loop check passes). While each individual query is fast (SQLite), the two-query pattern adds latency to the critical path of every agent eval completion.
- Impact: Adds ~1-2ms per iteration on the critical path. For shell eval mode this code also runs (unnecessarily, since shell eval is fast and stale state is extremely unlikely). The guard is architecturally correct for agent mode but represents unnecessary overhead for shell mode.
- Fix: Consider making the stale guard conditional on eval mode, or combine both checks into a single query/transaction:
  ```typescript
  // Only perform stale guard for agent eval (shell eval is fast, stale state is near-impossible)
  if (loop.evalMode === 'agent') {
    // ... stale state guard logic
  }
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Duplicated cleanup code in stale state guard branches** - `src/services/handlers/loop-handler.ts:294-296,313-315`
**Confidence**: 80%
- Problem: The three-line cleanup block (`cleanupPipelineTaskTracking`, `taskToLoop.delete`, `cleanupPipelineTasks`) is duplicated across both stale guard branches AND the normal exit path at lines 324-326. While not a runtime performance issue, it increases the likelihood of a future maintenance error where one path gets updated and the other does not, potentially causing a memory leak in the `taskToLoop` Map or `pipelineTasks` Map.
- Impact: Memory leak risk if cleanup paths diverge in future edits. The `taskToLoop` and `pipelineTasks` Maps are in-memory and never cleaned up by any periodic sweep, so a missed cleanup on a hot path would accumulate entries over the server lifetime.
- Fix: Extract the cleanup into a helper or use try/finally to ensure cleanup always runs regardless of which early-return path is taken.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**PF-005: `getResetTargetSha` O(n) iteration scan** - `src/services/handlers/loop-handler.ts` (~line 1224)
**Confidence**: 90%
- Problem: Known pitfall (PF-005 from pitfalls.md). For optimize-strategy loops, `getResetTargetSha()` calls `this.loopRepo.getIterations(loop.id, 100)` and linear-scans for the best iteration's `gitCommitSha`. This PR does not address or worsen this issue, but agent eval mode with optimize strategy will exercise this path. The deferred resolution (adding `bestIterationCommitSha` to Loop domain) still applies.
- Impact: Grows linearly with iteration count. Agent eval loops with optimize strategy will hit this on every discard/fail path.

### LOW

**PF-006: 4 sequential git process spawns per iteration** - `src/utils/git-state.ts` (~line 331)
**Confidence**: 88%
- Problem: Known pitfall (PF-006 from pitfalls.md). Each successful iteration spawns 4 sequential git processes. Agent eval mode does not change this behavior but adds a second agent spawn per iteration for evaluation, making the total process overhead per iteration higher.
- Impact: ~120-240ms git overhead + agent eval spawn time per iteration. Acceptable given iteration frequency.

## Suggestions (Lower Confidence)

- **Default evalTimeout of 60s may be too low for agent eval** - `src/core/domain.ts:623` (Confidence: 70%) -- The default `evalTimeout` is 60000ms (1 minute) for both shell and agent modes. Agent evaluators spawn a full Claude Code instance, read git diffs, and produce analysis. 60 seconds may be tight for complex repos. Consider a higher default for agent mode (e.g., 120-180s).

- **Fallback timer grace period of 5s is fixed** - `src/services/agent-exit-condition-evaluator.ts:212` (Confidence: 65%) -- The fallback timer adds a fixed 5000ms grace period on top of `evalTimeout`. For very short eval timeouts (e.g., 1000ms), 5s is 5x the timeout. For 600s timeouts, 5s is negligible. The grace period could scale with the timeout (e.g., `Math.min(evalTimeout * 0.1, 10000)`).

- **Agent eval task is not cleaned up on evaluator error paths** - `src/services/agent-exit-condition-evaluator.ts:67-75` (Confidence: 62%) -- If `eventBus.emit('TaskDelegated')` fails, the eval task was created but never delegated. The task object will be garbage collected, but the `waitForTaskCompletion` promise and its 4 event subscriptions remain active until the fallback timer fires. This is a minor resource leak (subscriptions + timer) that resolves itself after timeout.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 1 |

**Performance Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The agent eval mode introduces a well-structured evaluator with proper timeout handling and cleanup. The main performance concern is the unbounded output concatenation pattern that does a join-then-split round-trip. The stale state guard is architecturally sound but adds unnecessary overhead for shell eval mode. Pre-existing performance pitfalls (PF-005, PF-006) are not worsened by this PR. Overall, the performance characteristics are reasonable for the feature's use case (agent eval runs are inherently expensive -- spawning a full Claude instance -- so millisecond-level overhead in the handler path is proportionally negligible).
