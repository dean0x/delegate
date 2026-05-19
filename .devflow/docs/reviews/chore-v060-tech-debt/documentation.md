# Documentation Review Report

**Branch**: chore/v060-tech-debt -> main
**Date**: 2026-03-20
**PR**: #107

## Issues in Your Changes (BLOCKING)

### MEDIUM

**BootstrapOptions JSDoc removed without equivalent on BootstrapMode** - `src/bootstrap.ts:39-43`
**Confidence**: 85%
- Problem: The original `BootstrapOptions` interface had per-property JSDoc comments explaining each field's purpose and typical usage (e.g., `/** Custom ProcessSpawner implementation (e.g., NoOpProcessSpawner for tests) */`). The new interface strips all per-property documentation. While the `BootstrapMode` type alias has a good top-level comment explaining each mode variant, the remaining `processSpawner` and `resourceMonitor` fields on `BootstrapOptions` lost their JSDoc hints about test doubles.
- Fix: Add brief JSDoc to the remaining DI fields:
```typescript
export interface BootstrapOptions {
  mode?: BootstrapMode;
  /** Custom ProcessSpawner (e.g., NoOpProcessSpawner for tests) */
  processSpawner?: ProcessSpawner;
  /** Custom ResourceMonitor (e.g., TestResourceMonitor for tests) */
  resourceMonitor?: ResourceMonitor;
}
```

**OutputRepository interface methods lack per-method JSDoc** - `src/core/interfaces.ts:471-476`
**Confidence**: 82%
- Problem: The `OutputRepository` interface was moved from `src/implementations/output-repository.ts` to `src/core/interfaces.ts`. The original also lacked per-method JSDoc, so this is not a regression -- but the move is an opportunity to add documentation since the interface is now a first-class core contract alongside other well-documented repository interfaces (e.g., `ScheduleRepository`, `CheckpointRepository`). All four methods (`save`, `append`, `get`, `delete`) are undocumented.
- Fix: Add brief JSDoc to each method:
```typescript
export interface OutputRepository {
  /** Persist full output snapshot (stdout + stderr) */
  save(taskId: TaskId, output: TaskOutput): Promise<Result<void>>;
  /** Append incremental data to a stream */
  append(taskId: TaskId, stream: 'stdout' | 'stderr', data: string): Promise<Result<void>>;
  /** Retrieve stored output for a task */
  get(taskId: TaskId): Promise<Result<TaskOutput | null>>;
  /** Remove stored output for a task */
  delete(taskId: TaskId): Promise<Result<void>>;
}
```

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

### MEDIUM

**ROADMAP.md v0.6.0 "Remaining" items not updated** - `docs/ROADMAP.md:73-79`
**Confidence**: 85%
- Problem: The ROADMAP lists items #83, #101, and #104 under "Remaining (bugs + tech debt)" for v0.6.0. This PR implements all three of those tech debt items. Items #84, #82, and #95 from the same list were already merged in PR #106 (fix/v060-correctness-bugs). After this PR merges, all six "Remaining" items will be done, but the roadmap will still show them as pending.
- Fix: After this PR merges, update `docs/ROADMAP.md` to move these items from "Remaining" to "Features (merged)" or mark them complete. This could be done in a follow-up PR or as part of the v0.6.0 release preparation.

### LOW

**CLAUDE.md ScheduleExecutor note may become stale** - `CLAUDE.md:60`
**Confidence**: 65% (see Suggestions)
- Problem: CLAUDE.md describes ScheduleExecutor as having "direct repo writes, architectural exception to event-driven pattern." With the new transaction wrapping (#83), the executor now uses `SyncScheduleOperations` + `TransactionRunner` interfaces rather than raw repo access, which is a cleaner architectural pattern. The "exception" note is still technically accurate (the executor does write directly rather than going through events), but the framing could be updated to reflect the improvement.

## Suggestions (Lower Confidence)

- **CLAUDE.md ScheduleExecutor description could be refined** - `CLAUDE.md:60` (Confidence: 65%) -- The note "(note: has direct repo writes, architectural exception to event-driven pattern)" is still factually correct post-refactor, but the new transactional wrapping via `TransactionRunner` is a notable improvement that the comment does not reflect.

- **Test uses old boolean-flag naming as assertions** - `tests/integration/service-initialization.test.ts:389-391` (Confidence: 70%) -- The newly added `BootstrapMode flag derivation` test uses the old boolean flag names (`skipResourceMonitoring`, `skipScheduleExecutor`, `skipRecovery`) as property names in expected objects. This works correctly as a unit test of the derivation logic, but the naming could be confusing since those properties no longer exist in the public API. Consider whether this test is testing an internal concern.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 1 | 1 |

**Documentation Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The PR makes three clean refactors with good inline documentation on the new `BootstrapMode` type and the transaction wrapping rationale. The `OutputRepository` interface docstring explaining the "all repo interfaces live in core/interfaces.ts" pattern is a nice touch. Two minor documentation gaps remain: the removed per-property JSDoc on `BootstrapOptions` fields and the opportunity to add method-level docs on the newly promoted `OutputRepository` interface. Neither is blocking -- the code is self-explanatory -- but adding them would bring these interfaces up to the standard set by neighboring repository contracts.
