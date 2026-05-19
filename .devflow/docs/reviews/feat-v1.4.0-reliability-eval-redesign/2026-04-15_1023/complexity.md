# Complexity Review Report

**Branch**: feat/v1.4.0-reliability-eval-redesign -> main
**Diff base**: `33abbb78` (incremental)
**Date**: 2026-04-15 10:23
**Pitfall scan**: Active PF-001..PF-005 reviewed — none overlap with this diff (no dashboard, no UTF-8 slicing, no polling hooks, no prepared statements, no repo reads).

## Cleanup Goal Verification

| Metric | Target | Measured | Verdict |
|---|---|---|---|
| `handleTaskTerminal` length | 144 → ~115 lines | **115 lines** (line 198–312, brace-to-brace) | Goal met |
| `handleTaskTerminal` max nesting | 4 → 3 levels | **3 levels** (handleEvent CB → if/else → inside-branch if) | Goal met |
| Stop-decision duplication (~25 lines × 2) | extracted | **`handleStopDecision` ~30 lines, both call sites collapse to 1 line** | Goal met |
| Stale-state refetch duplication | extracted | **`refetchAfterAgentEval` ~42 lines, caller drops from ~33 → 6 lines** | Goal met |
| Stop-decision double-write of loop row | eliminated | **`finishLoop` introduced; pass path now uses it; stop path now uses it** | Goal met |
| Schedule-executor `handleScheduleExecutor` god function | reduce | **78 → 62 lines + 4 testable helpers extracted** | Goal met |

The cleanup achieved its stated metrics. The new helpers are themselves simple and the extraction did not create harmful indirection. Findings below are mostly residual / opportunistic — there are no blocking complexity regressions introduced by this diff.

---

## Issues in Your Changes (BLOCKING)

### CRITICAL

None.

### HIGH

None.

### MEDIUM

**`completeLoop` / `finishLoop` separation creates a usage trap** — `src/services/handlers/loop-handler.ts:1146-1197`
**Confidence**: 82%
- Problem: `completeLoop` performs a DB write then calls `finishLoop` for cleanup. `finishLoop` is documented as the post-transaction-commit variant that skips the DB write. The two functions differ ONLY in whether they perform a DB write — the discipline of choosing the right one is now load-bearing for correctness, but it is not enforceable by the type system. A future caller can innocently call `completeLoop` after a transaction (causing the original double-write the cleanup was meant to fix) and the test suite will pass because the duplicate write is silent and idempotent.
- Concrete evidence: the cleanup itself only fixed two of N call sites. `completeLoop` is still called after a `runInTransaction` block in:
  - `handleTaskTerminal` line 282 (failure path) — tx writes loop row, then `completeLoop(loop, FAILED)` writes again
  - `handlePipelineIntermediateTask` line 1619 — same pattern
  - `recoverSingleLoop` line 1851 — same pattern
  - `handleStopDecision` line 1277 — same pattern (the failure-path branch)
- The double-write is "harmless" by your own comment, but the new pair of functions advertises a contract (`finishLoop` for the post-commit case) that the codebase only honors for the success paths just refactored. The pattern is now half-applied.
- Fix: either (a) collapse back to one function and accept the harmless double-write as a tradeoff, OR (b) audit all `completeLoop` callers and migrate the post-transaction ones to `finishLoop`. Going halfway is the worst of both worlds — the abstraction now exists but its purpose isn't visible from the call sites that need it most.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`handleRetryResult` and `handleOptimizeResult` still contain a near-duplicate "passed" / "first-iteration baseline" block after stop-decision extraction** — `src/services/handlers/loop-handler.ts:881-914` and `986-1052`
**Confidence**: 80%
- Problem: The cleanup removed the duplicated stop-decision handling but left a structurally similar duplication: `handleRetryResult` lines 882–913 and `handleOptimizeResult` lines 991–1007 both follow the pattern `handleIterationGitOutcome → runInTransaction(updateIterationSync + updateSync) → branch on tx result → finishLoop/recordAndContinue`. The signatures and field sets differ slightly (retry has `errorMessage`, optimize has `score`), but the control flow is identical to what `handleStopDecision` now generalizes.
- Impact: The two strategy methods together are 75 + 110 = 185 lines and contain three transaction blocks that are 80% the same shape. Future changes to the iteration-completion atomic write will need to be made in 3+ places.
- Fix: Consider a follow-up extraction `handlePassDecision(loop, iteration, evalResult, iterationStatus)` parallel to `handleStopDecision`. Out of scope for this PR — note for a future cleanup pass.

**`handlePipelineIntermediateTask` (87 lines) was not addressed by the cleanup** — `src/services/handlers/loop-handler.ts:1549-1635`
**Confidence**: 88%
- Problem: This function has 5 early-return guards, a transaction block, two cleanup helpers, and a max/limit branch — same shape as the original `handleTaskTerminal` failure path. It exceeds the "warning" threshold (50 lines) but the cleanup left it unchanged.
- Impact: The `handleTaskTerminal` failure path (lines 259–287) and `handlePipelineIntermediateTask` failure path (lines 1604–1628) are now near-duplicates: same `updatedLoop = updateLoop(loop, { consecutiveFailures: ... })` + `runInTransaction` + `if !ok → completeLoop(FAILED)` + `else if max → completeLoop(FAILED) else scheduleNextIteration` shape. Both could call a shared `recordTaskFailureAndContinue(loop, iteration, failedEvent, errorMessagePrefix)` helper.
- Fix: Note for a follow-up. This is pre-existing; the cleanup did not introduce it but did not address it either.

**`recoverSingleLoop` (118 lines) remains the largest method in the file** — `src/services/handlers/loop-handler.ts:1759-1875`
**Confidence**: 92%
- Problem: 118-line function with 5 distinct branches (no iterations / iteration terminal / no taskId / task COMPLETED / task FAILED / task CANCELLED). The function carries the same "atomic transaction + post-commit limit check + scheduleNextIteration vs completeLoop" duplication noted above. Comment at line 1758 advertises it as "Early-return style for readability" — and the early returns help, but 118 lines is still beyond the 50-line warning threshold.
- Impact: This is the function most likely to introduce subtle recovery bugs. Every new loop status, every new iteration status, every new termination condition has to reason through this function end-to-end.
- Fix: Pre-existing issue, not introduced by this diff. Future cleanup should consider extracting `recoverFromTerminalIteration(loop, iteration)`, `recoverFromCompletedTask(loop, iteration, task)`, `recoverFromFailedTask(loop, iteration, task)`, `recoverFromCancelledTask(loop, iteration, task)` per branch.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`loop-handler.ts` is 1876 lines / 30+ private methods** — `src/services/handlers/loop-handler.ts`
**Confidence**: 95%
- Problem: File length is 6× the "warning" threshold (300 lines). The class has accreted iteration engine, recovery, git outcome handling, prompt enrichment, pipeline cancellation, and cleanup helpers all in one place. The cleanup added net +90 lines (helpers + docs), making this larger, not smaller.
- Impact: Any change requires understanding the full class surface. New contributors must hold 30+ method names + 6 in-memory maps in working memory.
- Fix: Out of scope for this diff. Long-term, consider splitting along the section comments already in the file: `LoopIterationEngine` (start/schedule/setup), `LoopOutcomeHandler` (handleRetry/Optimize/Stop/Continue + recordAndContinue), `LoopGitManager` (setupGit/handleIterationGitOutcome/commitAndCaptureDiff/getResetTargetSha/resetIterationGitState), `LoopRecoveryManager` (rebuildMaps/recoverStuckLoops/recoverSingleLoop). The current handler would orchestrate these.

### LOW

**Boolean-condition complexity in `recoverSingleLoop`'s exhaustive task-status branch** — `src/services/handlers/loop-handler.ts:1772, 1795, 1815, 1827, 1833, 1865`
**Confidence**: 75% — moved to Suggestions section per threshold.

## Suggestions (Lower Confidence)

- **`refetchAfterAgentEval` returns `null` to signal stale state instead of a discriminated union** - `src/services/handlers/loop-handler.ts:324-365` (Confidence: 70%) — three log sites all emit "Loop no longer running after eval, skipping result processing" with subtly different `loopId` vs `loopId, status:` vs `loopId, iterationStatus:` payloads. A `Result<{loop, iteration}, StaleReason>` would let the caller log once with full context. Minor — current code is readable.

- **`completeLoop` / `finishLoop` naming is ambiguous** - `src/services/handlers/loop-handler.ts:1146,1177` (Confidence: 70%) — the verbs convey no signal about which is the post-transaction variant. Consider renaming to `persistAndFinalize` / `finalizeAfterCommit`, or accept a `{ alreadyPersisted: boolean }` flag on a single function.

- **`handleStopDecision` parameter `iterationStatus: 'pass' | 'keep'` is the only thing distinguishing retry from optimize behavior** - `src/services/handlers/loop-handler.ts:1253-1282` (Confidence: 65%) — the union type is doing the work of telling readers which strategy this is for. A typed enum or per-strategy wrapper functions would self-document. Pragmatically fine as-is.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | - | 0 | 3 | 0 |
| Pre-existing | - | - | 1 | 0 |

**Complexity Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The cleanup achieved every stated complexity goal:
- `handleTaskTerminal`: 144 → 115 lines, nesting 4 → 3
- 25-line duplication eliminated via `handleStopDecision`
- 33-line stale-state refetch dance compressed to 6 lines via `refetchAfterAgentEval`
- Schedule-executor god function broken into 4 testable pure helpers

The new helpers are themselves simple, well-named, and well-documented. Extraction created no harmful indirection — control flow is easier to follow, not harder.

The condition for full approval: address the `completeLoop` / `finishLoop` half-applied pattern (Blocking MEDIUM #1). The remaining MEDIUMs are pre-existing god functions (`recoverSingleLoop`, `handlePipelineIntermediateTask`) and the file-size issue, all worth tracking as follow-up tech debt but not introduced by this diff.
