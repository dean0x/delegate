# Consistency Review Report

**Branch**: fix-retry-loop-git-reset -> main
**Date**: 2026-05-12

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

### MEDIUM

**Iteration display text for `progress` status shows feedback column but may benefit from showing errorMessage too** - `src/cli/dashboard/views/loop-detail.tsx:76`
**Confidence**: 82%
- Problem: The loop detail view displays `errorMessage` for `fail` and `crash` statuses, and `feedback` for all others. The new `progress` status may have both `evalFeedback` and `errorMessage` set (the `passed=false` code path in `handleRetryResult` passes `errorMessage: evalResult.error` via `recordAndContinue`). The current code always shows `feedback` for `progress` iterations, which is the correct choice (feedback is more useful than the error message for a non-crash situation), but this warrants awareness since the existing pattern groups display content by fail/crash vs everything-else.
- Fix: No code change needed -- `progress` correctly falls into the feedback-display bucket (line 76). The existing `fail || crash` check is the right discriminator. This is informational: the consistency of the pattern holds because `progress` is semantically closer to `pass`/`keep` than to `fail`/`crash`.

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **OPTIMIZE decision=continue uses `'discard'` while RETRY decision=continue now uses `'progress'`** - `src/services/handlers/loop-handler.ts:960` vs `:874` (Confidence: 65%) -- The two strategies use different iteration statuses for the decision=continue path. This is intentional (OPTIMIZE's `discard` has score-comparison semantics while RETRY's `progress` has work-preservation semantics), but the asymmetry means the `recordAndContinue` helper accepts a wide union of statuses. If this divergence ever confuses future contributors, consider adding a JSDoc note on the helper explaining why RETRY and OPTIMIZE use different statuses for the same decision.

- **`getResetTargetSha` method JSDoc says "Used when no overrideTarget is provided" but RETRY callers always provide overrideTarget** - `src/services/handlers/loop-handler.ts:1443-1446` (Confidence: 72%) -- The updated JSDoc correctly states that RETRY callers pass `overrideTarget = preIterationCommitSha` directly, making `getResetTargetSha` effectively an OPTIMIZE-only method now. The name `getResetTargetSha` is generic enough to be clear, but if the method is never called for RETRY anymore, it could be renamed to `getOptimizeResetTargetSha` for precision.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Consistency Score**: 9/10
**Recommendation**: APPROVED

## Analysis

This PR demonstrates strong consistency across all layers of the change:

**1. Domain type consistency**: The `progress` status was added to the `LoopIteration['status']` union in `domain.ts` (line 656), the Zod schema in `loop-repository.ts` (line 79), and the database CHECK constraint via migration v26. All three sources of truth are synchronized.

**2. UI presentation consistency**: The new status is handled in all three presentation layers:
   - `format.ts`: STATUS_ICONS map (line 94, circle icon matching the semantic of "in-progress but committed")
   - `loop-detail.tsx`: iterationStatusColor (line 32, cyan -- same as `running` in ui.ts)
   - `ui.ts`: colorStatus (line 126, cyan -- consistent choice since `progress` is a running-adjacent state)

**3. Migration pattern consistency**: Migration v26 follows the exact same table-recreation pattern as migrations v2, v3, v11, and v22 -- CREATE new table with updated CHECK, INSERT-SELECT, DROP old, RENAME new, recreate indexes. All four indexes on `loop_iterations` are recreated. The PF-002 citation in the migration comment is appropriate (avoids PF-002 -- no backward-compat path for zero-user feature).

**4. Git strategy consistency**: The `handleIterationGitOutcome` method's `isCommitPath` check now includes `progress` alongside `pass` and `keep` (line 1380). This is consistent: all three statuses represent work the user wants preserved. The reset paths (`resetIterationGitState`) consistently use `overrideTarget = preIterationCommitSha` for RETRY and fall through to `getResetTargetSha` for OPTIMIZE, applied in all four call sites: TaskFailed (line 264-269), pipeline intermediate failure (line 1619-1624), recovered task failure (line 1861-1866), and the `handleIterationGitOutcome` discard path (line 1386, no override = OPTIMIZE default).

**5. Recovery path consistency**: The `recoverSingleLoop` method's comment at line 1808 correctly lists `progress` in the statuses that trigger "check termination, then continue" -- consistent with how recovery treats all non-`pass` terminal iterations.

**6. Test consistency**: Tests T1-T3 updated to match new semantics (progress instead of fail, consecutiveFailures=0 instead of increment). Tests T4-T9 provide thorough coverage of the new behavior. The integration test update (line 368-399) aligns the human-readable test name with the behavioral change.

**7. consecutiveFailures semantics consistency**: The change from "increment on exit-condition-not-met" to "reset to 0 on successful task that misses exit condition" is applied uniformly across both the `decision=continue` path (line 874-876) and the `passed=false` fallback path (line 930-932). This ensures no behavioral divergence between feedforward and schema eval modes.
