# TypeScript Review Report

**Branch**: fix-retry-loop-git-reset -> main
**Date**: 2026-05-12

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

### MEDIUM

**`getResetTargetSha` still returns `gitStartCommitSha` for RETRY when no `overrideTarget` is provided** - `src/services/handlers/loop-handler.ts:1449-1454`
**Confidence**: 82%
- Problem: `getResetTargetSha()` has a RETRY fallback path that still returns `loop.gitStartCommitSha`. All current RETRY callers pass `overrideTarget`, so this path is dead for RETRY today. However, the method's JSDoc says "Retry callers pass overrideTarget directly (bypasses this method)" but nothing enforces this at the type level. A future caller that forgets `overrideTarget` for a RETRY loop would silently wipe all progress commits by falling through to `gitStartCommitSha`.
- Fix: Add a defensive guard or a DECISION comment clarifying that this is intentional dead code for RETRY:
```typescript
private getResetTargetSha(loop: Loop): string | undefined {
  if (loop.strategy === LoopStrategy.OPTIMIZE && loop.bestIterationCommitSha) {
    return loop.bestIterationCommitSha;
  }
  // DECISION: For RETRY, all callers MUST pass overrideTarget to resetIterationGitState()
  // so this fallback only fires for OPTIMIZE (where gitStartCommitSha is the correct default).
  // If this fires for RETRY, it's a caller bug — but gitStartCommitSha is a safe (conservative) fallback.
  return loop.gitStartCommitSha;
}
```

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **`LoopIteration['status']` is a long string union, not a named type** - `src/core/domain.ts:656` (Confidence: 65%) — The status union `'running' | 'pass' | 'fail' | 'keep' | 'discard' | 'crash' | 'cancelled' | 'progress'` now has 8 members. Extracting it to a named type alias (`type IterationStatus = ...`) would improve readability, allow reuse in the Zod enum, and make the `isCommitPath` and `iterationStatusColor` checks more self-documenting.

- **`handleIterationGitOutcome` switch on status uses boolean OR chain, not exhaustive pattern** - `src/services/handlers/loop-handler.ts:1380` (Confidence: 62%) — `const isCommitPath = iterationStatus === 'pass' || iterationStatus === 'keep' || iterationStatus === 'progress'` is correct but will silently fall through to the discard/reset path if new commit-worthy statuses are added. A discriminated union approach or an exhaustive set would make the intent clearer, though the current pattern matches the existing codebase style.

- **`iterationStatusColor` in `loop-detail.tsx` uses raw string checks, not the domain type** - `src/cli/dashboard/views/loop-detail.tsx:28-33` (Confidence: 60%) — The function parameter is `status: string` rather than `LoopIteration['status']`. This means TypeScript cannot verify that the `'progress'` branch added here aligns with the domain type. Pre-existing pattern, but worth noting now that the status set is growing.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**TypeScript Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Assessment

The changes demonstrate strong TypeScript discipline:

1. **Type consistency**: The `'progress'` status was added to all three layers — the domain type union (`LoopIteration['status']`), the Zod validation schema (`LoopIterationRowSchema`), and the SQLite CHECK constraint (migration v26). This three-layer alignment prevents runtime mismatches. (applies PF-002 — migration v26 uses a clean-break table recreation, no backward-compat path)

2. **Discriminated union integrity**: The `LoopIteration` interface remains a proper discriminated union on `status`. The new `'progress'` member is handled in all switch/if-else chains: `handleIterationGitOutcome`, `handleRetryResult`, `iterationStatusColor`, `colorStatus`, `STATUS_ICONS`, and the recovery path comment.

3. **`overrideTarget` parameter design**: The optional `overrideTarget?: string` parameter on `resetIterationGitState` uses the standard TypeScript optional parameter pattern with `??` fallback. This is clean and avoids overloads. The single MEDIUM finding above is about documentation/safety — not a type error.

4. **No `any` types introduced**: All new code uses explicit types. The `overrideTarget` is `string | undefined`, not `any`.

5. **Test coverage**: 9 new test cases (T1-T9 + updated integration tests) cover the new `'progress'` status across single-task, pipeline, multi-iteration crash isolation, and consecutiveFailures reset scenarios. The test type signatures are consistent with the codebase pattern.

The single MEDIUM condition is a documentation/safety suggestion — the code is correct as-is, but a defensive comment would prevent future regression.
