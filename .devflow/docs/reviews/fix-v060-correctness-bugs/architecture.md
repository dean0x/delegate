# Architecture Review Report

**Branch**: fix/v060-correctness-bugs -> main
**Date**: 2026-03-19
**Commits**: 4 (18d7657, 6866844, 894d3f9, 3301a2e)

## Issues in Your Changes (BLOCKING)

### HIGH

**Duplicated `linesSize` utility function** - `src/implementations/output-capture.ts:13` and `src/services/task-manager.ts:33`

- Problem: The identical `linesSize` helper function is defined in two separate files with the exact same signature and implementation. The project already has a `src/utils/` directory with shared utility modules (`cron.ts`, `validation.ts`, `retry.ts`, etc.), making this a clear DRY violation.
- Impact: If the calculation logic needs to change (e.g., to fix the byte-vs-character mismatch noted below), two files must be updated in lockstep. The self-review commit (`3301a2e`) explicitly extracted this helper but duplicated it rather than creating a shared module.
- Fix: Extract to `src/utils/output.ts` (or similar) and import from both call sites:
  ```typescript
  // src/utils/output.ts
  /** Sum the character lengths of all lines in an array */
  export function linesSize(lines: readonly string[]): number {
    return lines.reduce((sum, line) => sum + line.length, 0);
  }
  ```

### MEDIUM

**Semantic inconsistency in `totalSize` unit: bytes vs character-length** - `src/implementations/output-capture.ts:119` and `src/services/task-manager.ts:153`

- Problem: `BufferedOutputCapture.capture()` accumulates `buffer.totalSize` using `Buffer.byteLength(data, 'utf8')` (byte count), but the new `linesSize()` recalculation after tail-slicing uses `string.length` (character count). For ASCII-only content the values are identical, but for multi-byte characters (emoji, CJK, etc.) the recalculated `totalSize` will be smaller than expected. The non-tail path continues returning the byte-based `buffer.totalSize`, so the same `TaskOutput.totalSize` field returns bytes sometimes and character-lengths other times.
- Impact: Any downstream consumer comparing `totalSize` across calls with and without `tail` will see inconsistent units. Not blocking because the field is primarily informational (used for logging/display, not for allocation or limit enforcement), but it is a correctness inconsistency introduced by this PR.
- Fix: Use `Buffer.byteLength` consistently in `linesSize`:
  ```typescript
  function linesSize(lines: readonly string[]): number {
    return lines.reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8'), 0);
  }
  ```
  Or document that `totalSize` after tail-slicing represents character-length, not byte-length. Choose one unit and apply it consistently.

**RecoveryManager emits `TaskFailed` triggering redundant persistence write** - `src/services/recovery-manager.ts:124-133` and `src/services/recovery-manager.ts:266-275`

- Problem: RecoveryManager manually calls `repository.update(taskId, { status: FAILED, ... })` and then emits `TaskFailed`. The `PersistenceHandler` subscribes to `TaskFailed` and also calls `repository.update(taskId, { status: FAILED, ... })`. This results in a guaranteed double-write for every crashed/dead-worker task during recovery. The update is idempotent (same status written twice), so no data corruption occurs, but the architectural intent is unclear: the event-driven pattern says "all state changes MUST go through events," yet here the RecoveryManager writes state directly AND through events.
- Impact: The double-write is benign from a correctness standpoint since the `update` method is idempotent. However, it creates architectural ambiguity. The documented hybrid pattern is "commands via events, queries via repos." RecoveryManager is a special case (it MUST write directly because the event handlers might not be ready during early startup recovery), but this is not documented at the call sites.
- Fix: Add a comment at both emission sites clarifying the intent:
  ```typescript
  // NOTE: Direct update above is required because recovery may run before
  // event handlers are fully initialized. The TaskFailed emission here is
  // specifically for DependencyHandler to resolve downstream deps.
  // PersistenceHandler will also handle this event (idempotent no-op).
  ```
  This preserves correctness while making the architectural decision explicit.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`cancelSchedule` fetches unbounded execution history** - `src/services/schedule-manager.ts:183`

- Problem: The previous code used `getExecutionHistory(scheduleId, 1)` which was wrong (only latest). The fix correctly removes the `1` limit, but now calls `getExecutionHistory(scheduleId)` with no limit. The default is `100` from `DEFAULT_LIMIT`, but for a long-running CRON schedule with frequent triggers, there could be many completed executions loaded from the database only to be immediately filtered out by `filter((e) => e.status === 'triggered')`. The work is bounded by `DEFAULT_LIMIT=100`, so it is not unbounded, but the approach loads potentially many rows that are immediately discarded.
- Impact: Low-to-moderate. For most schedules this is fine. For high-frequency CRON schedules with long history, this fetches up to 100 rows from disk when typically only a few are active.
- Fix: Consider adding a `findActiveExecutions(scheduleId)` repository method that pushes the `status = 'triggered'` filter to the SQL query, or at minimum add a comment explaining the bounded default.

### LOW

**RecoveryManager constructor parameter count growing** - `src/services/recovery-manager.ts:13-20`

- Problem: `RecoveryManager` now takes 6 constructor parameters: `TaskRepository`, `TaskQueue`, `EventBus`, `Logger`, `WorkerRepository`, `DependencyRepository`. While each dependency is individually justified and properly injected via interface, this is approaching the threshold where a parameter object would improve readability.
- Impact: Not blocking. The dependencies all serve distinct purposes. However, the next dependency addition should trigger a refactor to a configuration/context object pattern.
- Fix: No action needed now, but consider refactoring if another dependency is added:
  ```typescript
  interface RecoveryDeps {
    readonly repository: TaskRepository;
    readonly queue: TaskQueue;
    readonly eventBus: EventBus;
    readonly logger: Logger;
    readonly workerRepository: WorkerRepository;
    readonly dependencyRepo: DependencyRepository;
  }
  ```

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`TestOutputCapture` does not apply `linesSize` recalculation** - `src/implementations/output-capture.ts:213`

- Problem: `TestOutputCapture.getOutput()` computes `totalSize` as `stdout.join('').length + stderr.join('').length` (always character-based, always recalculated). The production `BufferedOutputCapture` now has different behavior (byte-based for non-tail, character-based for tail). Test and production implementations compute `totalSize` differently, which means tests may pass with values that production would not produce.
- Impact: Test fidelity gap. Not introduced by this PR (the test implementation was pre-existing), but the divergence is now wider due to the `linesSize` change.

### LOW

**`output-capture.ts` swallows EventBus errors in `.catch(() => {})`** - `src/implementations/output-capture.ts:84`

- Problem: The empty `.catch()` block silently swallows event emission errors during output capture. The inline comment acknowledges this ("Log error but don't fail the capture operation") but the empty callback does not actually log anything.
- Impact: Pre-existing issue. Not related to this PR's changes.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 1 |
| Pre-existing | 0 | 0 | 1 | 1 |

**Architecture Score**: 7/10

The PR makes correct architectural decisions overall: injecting `DependencyRepository` via interface (DIP), emitting events for dependency resolution (event-driven consistency), and fixing the schedule cancellation to cover all active executions. The core bugs are real and the fixes are well-targeted. Deductions are for: (1) duplicated utility function that violates DRY, (2) inconsistent `totalSize` units mixing bytes and character-length, and (3) undocumented double-write pattern in recovery.

**Recommendation**: CHANGES_REQUESTED

The HIGH-severity `linesSize` duplication should be extracted to a shared utility before merge. The `totalSize` byte-vs-character inconsistency (MEDIUM) should at minimum be documented. The double-write in RecoveryManager needs an explanatory comment. None of these are architectural showstoppers, but they represent the kind of small drift that compounds over time.
