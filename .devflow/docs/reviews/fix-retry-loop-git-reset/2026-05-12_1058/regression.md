# Regression Review Report

**Branch**: fix-retry-loop-git-reset -> main
**Date**: 2026-05-12
**PR**: #163

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

(none)

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | - | 0 | 0 |

**Regression Score**: 9/10
**Recommendation**: APPROVED

## Detailed Analysis

### 1. Lost Functionality Check

No exports, CLI options, API endpoints, or event handlers were removed. The `LoopIteration` status union was **widened** (added `'progress'`), not narrowed. All pre-existing statuses (`running`, `pass`, `fail`, `keep`, `discard`, `crash`, `cancelled`) remain unchanged. The widening is backward-compatible: any code consuming the old union will continue to work, and `progress` is additive.

### 2. Broken Behavior Check

**Intentional behavior change (not a regression):**

The PR deliberately changes RETRY loop semantics:
- **Old behavior**: When a task completed successfully but the exit condition was not met, the iteration was marked `fail`, `consecutiveFailures` was incremented, and `git reset --hard` wiped all work back to `gitStartCommitSha`.
- **New behavior**: The iteration is marked `progress`, work is committed (not reset), and `consecutiveFailures` is reset to 0.
- **Old behavior**: On `TaskFailed`, the working directory was reset to `gitStartCommitSha` (the loop's original start).
- **New behavior**: On `TaskFailed`, the working directory is reset to `preIterationCommitSha` (preserving prior progress commits).

These are clearly documented as bug fixes in the commit messages, DECISION comments, and test descriptions. The intent (preserve accumulated work) matches the implementation. The PR description explicitly explains the semantic shift.

**OPTIMIZE strategy is unchanged.** All three `resetIterationGitState` calls for OPTIMIZE pass `undefined` as overrideTarget, falling through to `getResetTargetSha()` which returns `bestIterationCommitSha` or `gitStartCommitSha` — identical to pre-PR behavior.

### 3. Intent vs Reality Mismatch Check

Commit messages match the code:
- `ff98f54`: Main fix commit describes all changes accurately. Each file touched matches the description.
- `06d1e97`: Fixes the inconsistency where `decision=continue` passed `loop.consecutiveFailures` (stale value) to `checkTerminationConditions` while the DB was already updated to 0. Code confirms this alignment.
- `4977b1c`: Makes TaskFailed git reset strategy-conditional. The `overrideTarget` parameter is correctly applied only in RETRY paths, with OPTIMIZE passing `undefined`.
- `ec02d5d`: Integration test update matches the new `consecutiveFailures` reset-to-0 semantics.
- `ed9d0c6`: Dashboard presentation changes add `progress` to all three UI status renderers (format icon, detail view color, CLI color).

### 4. Incomplete Migration Check

All consumers of `LoopIteration.status` were examined:
- **domain.ts** (type union): `'progress'` added -- Confidence: 100%
- **loop-repository.ts** (Zod schema): `'progress'` added -- Confidence: 100%
- **database.ts** (migration v26): CHECK constraint updated via table recreation -- Confidence: 100%
- **loop-handler.ts** (core logic): All RETRY paths produce `'progress'` instead of `'fail'` where appropriate. `handleIterationGitOutcome` includes `progress` in commit path. Recovery code comment updated. -- Confidence: 100%
- **format.ts** (dashboard icon): `progress: '◉'` added -- Confidence: 100%
- **loop-detail.tsx** (iteration color): `if (status === 'progress') return 'cyan'` added -- Confidence: 100%
- **ui.ts** (CLI color): `case 'progress': return pc.cyan(status)` added -- Confidence: 100%
- **loop-detail.tsx line 76** (error/feedback display): `progress` does not match `fail || crash`, so it shows `feedback` — correct behavior since progress iterations have eval feedback, not crash errors. -- Confidence: 95%
- **MCP adapter**: Passes `iter.status` as-is (string), no enumeration of values needed -- Confidence: 100%
- **No other files** switch/branch on iteration status values.

No migration path is needed for the `progress` value (applies PF-002: this feature has no real-world users yet, clean break is correct).

### 5. Test Coverage Assessment

The test changes are thorough:
- **T1** (renamed): RETRY exit condition not met now asserts `progress` status, `commitAllChanges` called, `resetToCommit` NOT called
- **T2** (renamed): RETRY task failure now asserts reset to `preIterationCommitSha` (not `gitStartCommitSha`)
- **T3** (updated): `decision: continue` now asserts `progress` status instead of `fail`
- **T4**: RETRY exit condition not met + git: progress status, commit called, consecutiveFailures=0
- **T5**: RETRY decision=continue + git: progress status, commit called, consecutiveFailures=0
- **T6**: TaskFailed after accumulated progress: reset to preIterationCommitSha
- **T7**: Multi-iteration crash isolation: each failure resets to its own preIterationCommitSha
- **T8**: Pipeline step failure: reset to preIterationCommitSha (RETRY)
- **T9**: consecutiveFailures resets to 0 after progress iteration
- **Integration test**: `consecutiveFailures` expectation updated from 2 to 0 (matching new semantics)

All existing tests are preserved and updated — no tests were deleted or weakened.

### 6. Regression Checklist

- [x] No exports removed without deprecation
- [x] Return types backward compatible (status union widened, not narrowed)
- [x] Default values unchanged
- [x] Side effects preserved (events, logging, git operations)
- [x] All consumers of changed code updated (7 files, all enumerated above)
- [x] Migration complete across codebase (no orphaned old-style status handling)
- [x] CLI options preserved
- [x] API endpoints preserved
- [x] Commit messages match implementation
- [x] Breaking changes documented in commit messages and code comments
- [x] PF-002 applied: no backward-compat migration path for zero-user feature
