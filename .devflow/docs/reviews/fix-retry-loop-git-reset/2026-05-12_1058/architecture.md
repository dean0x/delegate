# Architecture Review Report

**Branch**: fix-retry-loop-git-reset -> main
**Date**: 2026-05-12
**PR**: #163

## Issues in Your Changes (BLOCKING)

### MEDIUM

**`getResetTargetSha` still returns `gitStartCommitSha` for RETRY strategy when no `overrideTarget` is passed** - `src/services/handlers/loop-handler.ts:1449-1454`
**Confidence**: 82%
- Problem: The `getResetTargetSha` method's fallback branch (`return loop.gitStartCommitSha`) is reachable for RETRY loops when `overrideTarget` is not provided. All current RETRY callers correctly pass `overrideTarget = iteration.preIterationCommitSha`, but the method itself is strategy-unaware: a future caller that omits `overrideTarget` for a RETRY loop would silently revert to `gitStartCommitSha`, undoing the fix this PR introduces. The JSDoc says "Retry callers pass overrideTarget directly (bypasses this method)" but that's a convention enforced by documentation, not by the type system or a guard.
- Fix: Add a RETRY-specific guard inside `getResetTargetSha` or refactor so the method is only callable for OPTIMIZE loops. Simplest option: add a log warning if the method is entered for RETRY strategy as a defense-in-depth tripwire.

```typescript
private getResetTargetSha(loop: Loop): string | undefined {
  if (loop.strategy === LoopStrategy.RETRY) {
    // RETRY callers must pass overrideTarget to resetIterationGitState.
    // Reaching this method for RETRY means a caller forgot the override.
    this.logger.warn('getResetTargetSha called for RETRY loop — callers should pass overrideTarget', {
      loopId: loop.id,
    });
  }
  if (loop.strategy === LoopStrategy.OPTIMIZE && loop.bestIterationCommitSha) {
    return loop.bestIterationCommitSha;
  }
  return loop.gitStartCommitSha;
}
```

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

_No CRITICAL pre-existing issues found._

## Suggestions (Lower Confidence)

- **Strategy-conditional logic scattered across callers** - `src/services/handlers/loop-handler.ts:262-268,1617-1623,1859-1865` (Confidence: 72%) -- The ternary `loop.strategy === LoopStrategy.RETRY ? iteration.preIterationCommitSha : undefined` is repeated verbatim in three callers (handleTaskTerminal, handlePipelineIntermediateTask, recoverSingleLoop). This is not a violation yet, but if a third strategy is added, all three sites need updating. Consider extracting a helper like `getResetTargetForFailure(loop, iteration)` that encapsulates the strategy-conditional logic in one place.

- **`progress` status not handled in `handleLoopCancelled` iteration status check** - `src/services/handlers/loop-handler.ts:444` (Confidence: 65%) -- The cancellation handler only cancels iterations with `status === 'running'`. A `progress` iteration is already terminal (completedAt is set), so this is likely correct, but the comment on line 440 ("Mark current running iteration as cancelled") could benefit from noting that `progress` iterations are already finalized and don't need cancellation.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Architecture Score**: 9/10
**Recommendation**: APPROVED_WITH_CONDITIONS

## Analysis

### What this PR does well

**Clean separation of concerns**: The new `progress` status is a domain-level concept introduced at the right layer (domain type -> Zod schema -> migration -> handler logic -> UI). Each layer is updated consistently without leaking concerns across boundaries.

**Strategy-aware git reset via parameter injection**: Rather than embedding strategy knowledge inside `resetIterationGitState`, the PR adds an `overrideTarget` parameter and lets callers decide. This follows the Open/Closed principle -- the method is extended without modifying its existing OPTIMIZE behavior.

**Migration follows established pattern**: Migration v26 uses the same table-recreation approach as v2, v3, v11, and v22 (SQLite cannot ALTER CHECK constraints). The migration explicitly cites PF-002 (avoids PF-002) to justify the clean break without backward-compat scaffolding.

**Event-driven consistency preserved**: The PR maintains the hybrid event-driven architecture: state mutations go through transactions, events are emitted after commit, and the recovery path (`recoverSingleLoop`) correctly handles the new `progress` status in its terminal-iteration dispatch.

**Atomic transactions for state consistency**: The `recordAndContinue` method atomically commits both the iteration `progress` status and the `consecutiveFailures: 0` reset in a single transaction, preventing the inconsistency window that could occur if these were separate writes.

### Architectural alignment

The change correctly identifies that RETRY and OPTIMIZE have fundamentally different git semantics:
- **RETRY**: accumulates progress across iterations (commit-and-build pattern), so failure resets only to the iteration boundary (`preIterationCommitSha`), preserving prior iterations' work.
- **OPTIMIZE**: explores alternatives that may be worse, so failure resets to the globally best state (`bestIterationCommitSha` or `gitStartCommitSha`).

This maps cleanly to the existing strategy pattern in the codebase where `handleRetryResult` and `handleOptimizeResult` are separate methods.

### The one condition

The `getResetTargetSha` method remains a latent footgun for RETRY loops (MEDIUM finding above). A defense-in-depth warning log would close this gap at near-zero cost.
