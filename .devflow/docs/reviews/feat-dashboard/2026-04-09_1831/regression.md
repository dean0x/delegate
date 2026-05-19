# Regression Review Report

**Branch**: feat-dashboard -> main
**Date**: 2026-04-09T18:31

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

**Test doubles missing `countByStatus()` after interface expansion (2 occurrences)** -- Confidence: 85%
- `tests/fixtures/test-doubles.ts:332` (`TestTaskRepository implements TaskRepository`)
- `tests/unit/services/handlers/worker-handler.test.ts:168` (`MockTaskRepo implements TaskRepository`)
- Problem: The `TaskRepository` interface gained a new `countByStatus()` method in this PR. The two test doubles that `implements TaskRepository` do not implement this method. The `tsconfig.json` excludes test files from type-checking, so this does not produce a compile error today. However, any future test that exercises `countByStatus()` through these doubles will get a runtime `TypeError: ...countByStatus is not a function`. This is an incomplete migration per the regression skill -- some consumers of the changed interface were not updated.
- Fix: Add `countByStatus()` to both test doubles:
  ```typescript
  // TestTaskRepository (test-doubles.ts)
  async countByStatus(): Promise<Result<Record<string, number>, Error>> {
    if (this.findError) return err(this.findError);
    const counts: Record<string, number> = {};
    for (const task of this.tasks.values()) {
      counts[task.status] = (counts[task.status] ?? 0) + 1;
    }
    return ok(counts);
  }

  // MockTaskRepo (worker-handler.test.ts)
  async countByStatus(): Promise<Result<Record<string, number>>> {
    return ok({});
  }
  ```

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **`ScheduleRepository` and `OrchestrationRepository` test doubles may also be incomplete** - `tests/fixtures/test-doubles.ts` and other test files (Confidence: 65%) -- If any test double implements `ScheduleRepository`, `LoopRepository`, or `OrchestrationRepository`, it would also need `countByStatus()`. A codebase-wide grep found no additional implementing classes beyond the SQLite implementations, but future test doubles should be verified.

- **Filter cycle does not include all domain statuses** - `src/cli/dashboard/use-keyboard.ts:1476` (Confidence: 70%) -- The `FILTER_CYCLE` array is `[null, 'running', 'completed', 'failed', 'cancelled']` but some entity types have statuses like `active` (schedules), `paused` (loops/schedules), `planning` (orchestrations), `queued` (tasks), and `expired` (schedules). Users filtering schedules by "running" will see no results because the active status for schedules is `active`, not `running`. This may be intentional (dashboard shows the common statuses) but could confuse users.

- **`scoreTrend` always receives `undefined` as previous in main view** - `src/cli/dashboard/views/main-view.tsx:1925` (Confidence: 65%) -- `scoreTrend(loop.bestScore, undefined, direction)` always passes `undefined` for the previous score, so the trend arrow is always "->". This appears to be a Phase 1 limitation where iteration history is not available in the main view row renderer, but users may wonder why the trend is always flat.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | - | 0 | 0 |

**Regression Score**: 8/10
**Recommendation**: CHANGES_REQUESTED

### Rationale

This PR is a well-structured additive feature (new `beat dashboard` command). The regression surface is minimal:

- **No exports removed**: Zero `export` removals detected.
- **No files deleted**: Zero deletions.
- **No TODOs introduced**: Clean implementation.
- **No return type changes**: All interface additions are purely additive (`countByStatus()` added to 4 repository interfaces).
- **No default value changes**: Existing behavior unchanged.
- **No side effects removed**: Event handlers, logging, and CLI command routing all preserved.
- **Build compiles clean**: `tsc --noEmit` passes with 0 errors.
- **All existing test suites pass**: core, handlers, repositories, CLI, dashboard (826 tests verified across 5 suites).
- **Commit messages match implementation**: 6 commits align with phased dashboard implementation.
- **CLI routing insertion is correct**: `dashboard`/`dash` command inserted before the `help` catch-all, preserving all existing command routing.
- **tsconfig.json change is backward-compatible**: Adding `"jsx": "react-jsx"` enables JSX compilation without affecting non-JSX files.
- **vitest.config.ts change is backward-compatible**: Widening test include from `*.test.ts` to `*.test.{ts,tsx}` is a superset.

The single HIGH issue (incomplete migration of test doubles) is a should-fix before merge to keep test infrastructure consistent with the expanded interfaces. It will not cause runtime failures in production code, but it creates a landmine for future test authors.
