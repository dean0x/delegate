# Resolution Summary

**Branch**: fix/retry-loop-git-reset -> main
**Date**: 2026-05-12_1058
**Review**: .docs/reviews/fix-retry-loop-git-reset/2026-05-12_1058
**Command**: /resolve

## Decisions Citations

- avoids PF-001 — all issues addressed or explicitly deferred with rationale (none silently skipped)

## Statistics
| Metric | Value |
|--------|-------|
| Total Issues | 12 |
| Fixed | 8 |
| False Positive | 1 |
| Deferred | 3 |
| Blocked | 0 |

## Fixed Issues
| Issue | File:Line | Commit |
|-------|-----------|--------|
| I1: statusColor() missing progress case (gray instead of cyan) | src/cli/dashboard/format.ts:62 | 3c34186 |
| I2: Strategy-conditional ternary duplicated 3x | src/services/handlers/loop-handler.ts:268,1623,1865 | 42e1a82 |
| I5: getResetTargetSha latent RETRY footgun (resolved by I2) | src/services/handlers/loop-handler.ts:1449 | 42e1a82 |
| I12: getResetTargetSha naming (resolved by I2) | src/services/handlers/loop-handler.ts:1449 | 42e1a82 |
| I3: Missing recovery test for progress status | tests/unit/services/handlers/loop-handler.test.ts | bdef430 |
| I4: Missing OPTIMIZE TaskFailed git reset test | tests/unit/services/handlers/loop-handler.test.ts | bdef430 |
| I9: Extract IterationStatus named type alias | src/core/domain.ts:656 | 5b9c3b8 |
| I10: iterationStatusColor accepts string not typed | src/cli/dashboard/views/loop-detail.tsx:28 | 5b9c3b8 |

## False Positives
| Issue | File:Line | Reasoning |
|-------|-----------|-----------|
| I11: ◉ icon may not render on all terminals | src/cli/dashboard/format.ts:94 | Same Unicode Geometric Shapes block as existing icons (◎, ⊘, ⊖, ⏸). Deliberate project-wide choice; no evidence of special-casing for broader compatibility elsewhere. |

## Deferred to Tech Debt
| Issue | File:Line | Risk Factor |
|-------|-----------|-------------|
| I6: handleTaskTerminal 130 lines | src/services/handlers/loop-handler.ts:258 | Pre-existing complexity not introduced by this PR. Sub-extraction only meaningful after file-level split (I8). |
| I7: handleOptimizeResult 112 lines, recoverSingleLoop 123 lines | src/services/handlers/loop-handler.ts | Pre-existing. Same deferral rationale as I6. |
| I8: loop-handler.ts 1905 lines | src/services/handlers/loop-handler.ts | Architectural overhaul — splitting into git-ops, recovery, iteration-eval modules requires careful interface design beyond bug-fix PR scope. |

## Blocked
None.

## Bonus Fix
Batch-2 refactoring (I2) exposed a latent bug in the "iteration discard" path at line 1386: it called resetIterationGitState with no override, silently using gitStartCommitSha for RETRY loops instead of preIterationCommitSha. This would have discarded all progress commits. Now automatically correct via the centralized getResetTargetSha logic.
