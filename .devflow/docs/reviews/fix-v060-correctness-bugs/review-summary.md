# Code Review Summary

**Branch**: fix/v060-correctness-bugs -> main
**Date**: 2026-03-19
**Commits**: 4 (18d7657, 6866844, 894d3f9, 3301a2e)
**Reviewers**: 8 domain experts (security, architecture, performance, complexity, consistency, regression, tests, typescript)

---

## Merge Recommendation: CHANGES_REQUESTED

**Status**: Blocking issues found in your changes. Three medium-severity items must be resolved before merge:

1. **Duplicated `linesSize` utility** (HIGH - DRY violation)
2. **`totalSize` measurement unit inconsistency** (MEDIUM - correctness)
3. **Missing test for TaskFailed emit failure** (HIGH - test coverage)

All three are actionable and straightforward to fix. Core bug fixes are sound.

---

## Issue Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW | Total |
|----------|----------|------|--------|-----|-------|
| **Blocking** (Issues in Your Changes) | 0 | 2 | 6 | 1 | **9** |
| **Should Fix** (Code You Touched) | 0 | 0 | 4 | 1 | **5** |
| **Pre-existing** (Not Your Problem) | 0 | 0 | 5 | 5 | **10** |
| **TOTAL** | **0** | **2** | **15** | **7** | **24** |

---

## Blocking Issues (Must Fix Before Merge)

### HIGH Priority

#### 1. Duplicated `linesSize` Utility Function (Architecture, Complexity, Consistency, TypeScript, Regression)

**Location**: `src/implementations/output-capture.ts:13-15` and `src/services/task-manager.ts:33-35`

**Problem**: The identical `linesSize()` function is defined as a private module function in two separate files. Both were introduced by this PR. This is a DRY violation and creates a maintenance burden -- if the calculation logic changes (e.g., to account for separator sizes or switch to byte-length), both copies must be updated in sync.

**Impact**: HIGH - Drift risk. If one copy is updated and the other is missed, the two code paths diverge silently. The function appears to be in the hot path for output retrieval.

**Fix**: Extract to a shared utility module:

```typescript
// src/utils/output.ts
/** Sum the character lengths of all lines in an array */
export function linesSize(lines: readonly string[]): number {
  return lines.reduce((sum, line) => sum + line.length, 0);
}
```

Then import in both `output-capture.ts` and `task-manager.ts`:
```typescript
import { linesSize } from '../utils/output';
```

**Category**: 1 (Your Changes)

---

#### 2. Missing Test Coverage for TaskFailed Emit Failure Path (Tests)

**Location**: `tests/unit/services/recovery-manager.test.ts` (missing tests)

**Problem**: The production code emits `TaskFailed` events with explicit error-handling branches (lines 129-132 for dead workers, lines 271-274 for crashed tasks) that log errors and continue. Neither failure path is tested. The tests verify successful emission but not the error branch.

**Impact**: HIGH - Untested error paths. If the error-handling logic is accidentally removed or broken, no test would catch it.

**Fix**: Add two tests for the emit-failure paths:

```typescript
it('should log error but continue when TaskFailed emit fails for dead worker', async () => {
  const reg = buildWorkerRegistration('dead-worker-fail');
  workerRepo.find.mockReturnValue(ok([reg]));
  const emitError = new AutobeatError(ErrorCode.SYSTEM_ERROR, 'event bus down');

  // First emit succeeds, TaskFailed emit fails
  eventBus.emit
    .mockResolvedValueOnce(ok(undefined)) // WorkerDead succeeds
    .mockResolvedValueOnce(err(emitError)); // TaskFailed fails

  const result = await manager.recover();

  expect(result.ok).toBe(true); // Recovery continues
  expect(logger.error).toHaveBeenCalledWith(
    'Failed to emit TaskFailed event',
    emitError,
    { taskId: reg.taskId }
  );
});

it('should log error but continue when TaskFailed emit fails for crashed task', async () => {
  const task = buildRunningTask('crashed-emit-fail');
  setupFindByStatus([], [task]);
  workerRepo.findByTaskId.mockReturnValue(ok(null));
  const emitError = new AutobeatError(ErrorCode.SYSTEM_ERROR, 'event bus down');

  eventBus.emit.mockResolvedValueOnce(err(emitError)); // TaskFailed fails

  const result = await manager.recover();

  expect(result.ok).toBe(true); // Recovery continues
  expect(logger.error).toHaveBeenCalledWith(
    'Failed to emit TaskFailed event',
    emitError,
    { taskId: task.id }
  );
});
```

**Category**: 1 (Your Changes)

---

### MEDIUM Priority (Blocking)

#### 3. `totalSize` Measurement Unit Inconsistency: Bytes vs. Characters

**Location**: `src/implementations/output-capture.ts:14` and `src/implementations/output-capture.ts:51`

**Problem**: During `capture()`, `totalSize` is accumulated using `Buffer.byteLength(data, 'utf8')` (counts **bytes**). However, the new `linesSize()` function uses `string.length` (counts **UTF-16 code units / characters**). When tail-slicing is applied, the recalculated `totalSize` returns character-length. When tail is NOT applied, the non-sliced path returns byte-length. For ASCII-only content these are identical, but for multi-byte characters (emoji, CJK, accented), they diverge.

**Impact**: MEDIUM - Correctness. The `totalSize` field now has an inconsistent meaning depending on whether tail-slicing was applied. This is the inverse of the original bug (which always reported full buffer size regardless of tail) but creates a different inconsistency.

**Evidence**:
- Security report: "character-vs-byte inconsistency was introduced in this PR"
- Regression report: "The recalculated `totalSize` will be smaller than expected" (for multi-byte content)
- TypeScript report: "The two metrics diverge" for non-ASCII content

**Fix**: Choose ONE unit consistently across both paths. The `maxOutputBuffer` limit check uses byte-length, suggesting byte-length is the correct semantic:

**Option A (Recommended)**: Use byte-length consistently in `linesSize`:

```typescript
function linesSize(lines: readonly string[]): number {
  return lines.reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8'), 0);
}
```

**Option B**: Use character-length consistently (change `capture()` accumulation), but this could affect the 10MB buffer limit semantics.

**Category**: 1 (Your Changes)

---

#### 4. `RecoveryManager` Double-Write Pattern Undocumented (Architecture)

**Location**: `src/services/recovery-manager.ts:124-133` and `src/services/recovery-manager.ts:266-275`

**Problem**: `RecoveryManager` manually calls `repository.update(taskId, { status: FAILED, ... })` and then emits `TaskFailed`. The `PersistenceHandler` subscribes to `TaskFailed` and also calls `repository.update(taskId, { status: FAILED, ... })`. This results in an intentional double-write (idempotent, so no data corruption) but the architectural intent is unclear at the call sites. The documented hybrid pattern says "all state changes MUST go through events," yet here state is written directly AND through events.

**Impact**: MEDIUM - Architectural clarity. The double-write is benign (idempotent) but undocumented.

**Fix**: Add explanatory comments at both emission sites:

```typescript
// NOTE: Direct update above is required because recovery may run before
// event handlers are fully initialized. The TaskFailed emission here is
// specifically for DependencyHandler to resolve downstream task dependencies.
// PersistenceHandler will also handle this event (idempotent write).
const emitResult = await this.eventBus.emit('TaskFailed', {
  taskId: reg.taskId,
  error: new AutobeatError(ErrorCode.SYSTEM_ERROR, 'Worker process died (dead PID detected)'),
  exitCode: -1,
});
```

**Category**: 1 (Your Changes)

---

#### 5. `TestOutputCapture` Diverges from `BufferedOutputCapture` (Architecture, Consistency, Regression, TypeScript)

**Location**: `src/implementations/output-capture.ts:213`

**Problem**: `TestOutputCapture.getOutput()` calculates `totalSize` using `stdout.join('').length + stderr.join('').length` (character-based). The production `BufferedOutputCapture` now mixes byte-length (non-tail path) and character-length (tail path). The test implementation was not updated to align with the production changes in this PR. This creates a test-fidelity gap -- the test double behaves differently from production.

**Impact**: MEDIUM - Test fidelity. Tests may pass with values that production would produce differently, masking bugs for multi-byte content.

**Fix**: Update `TestOutputCapture` to use the shared `linesSize` utility (once extracted):

```typescript
// Replace line 213:
const totalSize = stdout.join('').length + stderr.join('').length;
// With:
const totalSize = linesSize(stdout) + linesSize(stderr);
```

**Category**: 1 (Your Changes)

---

#### 6. `cancelSchedule` Fetches Unbounded Execution History (Architecture, Performance)

**Location**: `src/services/schedule-manager.ts:183`

**Problem**: The old code called `getExecutionHistory(scheduleId, 1)` which only fetched the latest execution (a bug). The new code calls `getExecutionHistory(scheduleId)` with no limit, which defaults to `DEFAULT_LIMIT = 100` from the repository. This fetches up to 100 rows from disk, maps to objects, then filters in memory. While 100 is bounded, it's a design smell (fetch-then-filter pattern).

**Impact**: MEDIUM - Efficiency. For high-frequency CRON schedules with long execution history, unnecessary work is done fetching non-active executions. The DEFAULT_LIMIT prevents truly unbounded queries, but the approach is not optimal.

**Fix**: Add a dedicated repository method to push the filter to SQL:

```typescript
// src/implementations/schedule-repository.ts
async getActiveExecutions(
  scheduleId: ScheduleId,
  limit: number = this.DEFAULT_LIMIT
): Promise<Result<ScheduleExecution[]>> {
  // SELECT * FROM schedule_executions
  // WHERE schedule_id = ? AND status = 'triggered'
  // ORDER BY scheduled_for DESC LIMIT ?
}
```

Or at minimum add a comment documenting the bounded default.

**Category**: 1 (Your Changes)

---

#### 7. TOCTOU Window Between Dependency Check and Enqueue (Security)

**Location**: `src/services/recovery-manager.ts:166-180`

**Problem**: There is a time gap between the `isBlocked()` check (line 166) and the subsequent `queue.enqueue()` call (line 180). During this window, a dependency could be resolved by another process (unlikely but theoretically possible), causing the task to be unblocked and enqueued elsewhere via the `TaskUnblocked` event path, resulting in a potential double-enqueue.

**Impact**: MEDIUM - Low-probability race. The existing `queue.contains()` guard at line 158 mitigates the first case. The latter case (blocked -> unblocked between check and enqueue) could lead to double processing, though the queue's own deduplication provides a safety net.

**Fix**: The security reviewer notes this is an acceptable trade-off given the fail-safe comment on lines 163-165 already documents the design intent. However, consider adding a comment noting the TOCTOU window is mitigated by queue deduplication:

```typescript
// NOTE: Small TOCTOU window exists between isBlocked check and enqueue,
// but queue.contains() pre-check and queue deduplication provide mitigation.
// Recovery runs once at startup, so window is minimized and bounded.
```

**Category**: 1 (Your Changes)

---

#### 8. Sequential Dependency and Cancellation Checks (Performance)

**Location**: `src/services/recovery-manager.ts:166` and `src/services/schedule-manager.ts:189-200`

**Problem**:
- `recoverQueuedTasks()` calls `this.dependencyRepo.isBlocked(task.id)` in a loop, issuing N sequential SQLite queries for N queued tasks.
- `cancelSchedule()` emits `TaskCancellationRequested` events one-at-a-time via `await` in a loop, sequentializing potentially many emissions.

**Impact**: MEDIUM - Performance. For large pipelines or schedules with many overlapping executions, this serializes work. However, both operations run at non-hot paths (recovery at startup, admin cancellation).

**Mitigating factors**: SQLite is local with no network latency. Recovery runs once at startup. Cancellation is infrequent. Number of QUEUED tasks at crash time is typically small.

**Fix**: No immediate action needed, but consider batching if scale grows:

For `isBlocked` checking:
```typescript
// Instead of N queries, batch into single query:
const blockedSet = await this.dependencyRepo.getBlockedTaskIds(tasks.map(t => t.id));
for (const task of tasks) {
  if (blockedSet.has(task.id)) { blockedCount++; continue; }
  // ... enqueue
}
```

For cancellation:
```typescript
await Promise.all(allTaskIds.map(taskId =>
  this.eventBus.emit('TaskCancellationRequested', { taskId, reason: '...' })
));
```

**Category**: 1 (Your Changes)

---

## Should Fix (Code You Touched)

### MEDIUM Priority

#### 1. `cleanDeadWorkerRegistrations` Nesting and Length (Complexity)

**Location**: `src/services/recovery-manager.ts:78-141`

**Problem**: The method grew from ~40 lines to 63 lines with nesting depth reaching 4 levels (for -> if -> if -> if). Approaching warning thresholds.

**Impact**: MEDIUM - Readability. The method handles three concerns: unregistration, task status update, and event emission.

**Fix**: Extracting the proposed `emitTaskFailed` helper (blocker issue #4) would reduce nesting by one level and bring the method back under 50 lines.

**Category**: 2 (Code You Touched)

---

#### 2. Integration Test Missing Dependency-Aware Recovery Validation (Tests)

**Location**: `tests/integration/task-persistence.test.ts:82-90`

**Problem**: The integration tests were updated to pass `dependencyRepo` to `RecoveryManager` (required by constructor change), but no integration test actually exercises the dependency-blocking behavior. All tasks in the tests have no dependencies, so the new codepath is only tested at unit level with mocks.

**Impact**: MEDIUM - Coverage gap. A bug in `SQLiteDependencyRepository.isBlocked()` interacting with recovery would not be caught by integration tests.

**Fix**: Add an integration test that creates a QUEUED task with an unresolved dependency, runs recovery, and verifies the task is NOT re-queued:

```typescript
it('should not re-queue QUEUED tasks with unresolved dependencies during recovery', async () => {
  // Create parent task (RUNNING), child task (QUEUED, dependsOn: parent.id)
  // Mark parent as FAILED to simulate crash recovery scenario
  // Run recovery
  // Assert child is NOT re-queued (remains QUEUED, blocked)
  // Assert parent is marked FAILED
});
```

**Category**: 2 (Code You Touched)

---

#### 3. `RecoveryManager` Constructor Parameter Count Growing (Architecture)

**Location**: `src/services/recovery-manager.ts:14-19`

**Problem**: `RecoveryManager` now takes 6 constructor parameters: `TaskRepository`, `TaskQueue`, `EventBus`, `Logger`, `WorkerRepository`, `DependencyRepository`. While each dependency is justified, this approaches the threshold where a parameter object would improve readability.

**Impact**: MEDIUM - Approaching maintenance threshold. The next dependency addition should trigger a refactor.

**Fix**: No action needed now, but consider refactoring if another dependency is added:

```typescript
interface RecoveryDeps {
  readonly repository: TaskRepository;
  readonly queue: TaskQueue;
  readonly eventBus: EventBus;
  readonly logger: Logger;
  readonly workerRepository: WorkerRepository;
  readonly dependencyRepo: DependencyRepository;
}

constructor(deps: RecoveryDeps) { ... }
```

**Category**: 2 (Code You Touched)

---

#### 4. Naming Inconsistency in RecoveryManager Constructor (Consistency)

**Location**: `src/services/recovery-manager.ts:14-19`

**Problem**: The constructor uses three different naming conventions:
- `repository` (TaskRepository) -- bare noun, no suffix
- `workerRepository` (WorkerRepository) -- full `*Repository` suffix
- `dependencyRepo` (DependencyRepository) -- abbreviated `*Repo` suffix

**Impact**: MEDIUM - Minor inconsistency. The codebase has an established split pattern: handlers use abbreviated `*Repo`, while pre-existing `RecoveryManager` code uses full `*Repository` suffix.

**Fix**: This is low-risk and noted for awareness. The abbreviated style is arguably more consistent with the broader codebase. A full rename would be a separate refactor.

**Category**: 2 (Code You Touched)

---

### LOW Priority

#### 1. Duplicated TaskFailed Emission Block (Complexity)

**Location**: `src/services/recovery-manager.ts:124-133` and `src/services/recovery-manager.ts:266-275`

**Problem**: Two nearly identical blocks emit `TaskFailed` with the same structure, only differing in the error message. Six lines of boilerplate duplicated.

**Impact**: LOW - Maintenance. If the emission pattern changes, both sites need updating.

**Fix**: Extract a private helper (addresses blocker issue #4 as well):

```typescript
private async emitTaskFailed(taskId: TaskId, reason: string): Promise<void> {
  const result = await this.eventBus.emit('TaskFailed', {
    taskId,
    error: new AutobeatError(ErrorCode.SYSTEM_ERROR, reason),
    exitCode: -1,
  });
  if (!result.ok) {
    this.logger.error('Failed to emit TaskFailed event', result.error, { taskId });
  }
}
```

**Category**: 2 (Code You Touched)

---

## Pre-existing Issues (Not Blocking)

**Summary**: 10 pre-existing issues found across security, architecture, performance, complexity, consistency, regression, and tests. These are informational only and should NOT block this PR.

**Notable pre-existing issues**:
- `worker-handler.ts` emits `TaskFailed` with `new Error()` instead of `AutobeatError` (type inconsistency)
- `process.kill(pid, 0)` used for PID existence check (low risk given internal PID source)
- `OutputRepository.save()` recalculates totalSize independently using character-length (pre-existing semantic mismatch)
- Sequential event emission patterns in `recoverRunningTasks` (established pattern, acceptable for startup)
- `.catch(() => {})` swallows EventBus errors in output-capture (pre-existing, doesn't log as intended)

See individual reviewer reports for complete pre-existing issue details.

---

## Quality Assessment

| Dimension | Score | Notes |
|-----------|-------|-------|
| **Security** | 8/10 | No injection vectors, hardcoded secrets, or authentication bypasses. TOCTOU window mitigated. |
| **Architecture** | 7/10 | Correct DIP pattern with DependencyRepository, sound event-driven decisions. Deductions for duplication and double-write clarity. |
| **Performance** | 8/10 | N+1 patterns acceptable at current scale (local SQLite, startup recovery). Sequential emissions are established patterns. |
| **Complexity** | 7/10 | Functions approaching (but not exceeding) warning thresholds. Guard patterns well-structured and readable. |
| **Consistency** | 7/10 | Strong overall consistency in error handling, events, tests. Minor naming inconsistencies noted. |
| **Regression** | 9/10 | No API breaks, constructor changes all consumed, behavior changes well-justified. totalSize semantics change is intentional bug fix. |
| **Tests** | 8/10 | Good coverage for happy paths. Gap is the missing emit-failure test coverage. |
| **TypeScript** | 7/10 | Good use of branded types, readonly arrays, Result types. Duplication and measurement inconsistency are type-level issues. |
| **Average** | **7.6/10** | Solid PR with actionable issues that don't undermine the core bug fixes. |

---

## Action Plan

### Before Merge (REQUIRED)

1. **Extract `linesSize` to `src/utils/output.ts`** (HIGH priority, HIGH complexity)
   - Creates new file with shared utility
   - Updates both call sites to import
   - Resolves duplication across multiple reviews
   - Estimated: 10 minutes

2. **Resolve `totalSize` measurement unit inconsistency** (HIGH priority, MEDIUM complexity)
   - Choose byte-length or character-length consistently
   - Recommend: Change `linesSize` to use `Buffer.byteLength()` for consistency with `capture()`
   - Update `TestOutputCapture` to use shared `linesSize` helper
   - Estimated: 15 minutes

3. **Add test coverage for TaskFailed emit failure paths** (HIGH priority, MEDIUM complexity)
   - Add two test cases for emit-failure branches
   - Verify error logging and recovery continuation
   - Estimated: 20 minutes

4. **Add explanatory comment to double-write pattern** (MEDIUM priority, LOW complexity)
   - Document why RecoveryManager writes state directly AND through events
   - Estimated: 5 minutes

5. **Update TestOutputCapture to align with BufferedOutputCapture** (MEDIUM priority, LOW complexity)
   - Import and use shared `linesSize` helper
   - Estimated: 5 minutes

### Follow-up (OPTIONAL, Not Blocking)

- Add integration test for dependency-aware recovery
- Consider adding `getActiveExecutions()` repository method for the `cancelSchedule` fetch pattern
- Refactor `RecoveryManager` constructor to parameter object pattern if another dependency is added
- Extract `emitTaskFailed` private helper to reduce nesting in `cleanDeadWorkerRegistrations`

---

## Summary

**Overall**: This PR delivers four important correctness bug fixes:
1. **RecoveryManager dependency check** - Prevents re-queuing blocked tasks, enables dependency resolution after crashes
2. **CancelSchedule multi-execution** - Cancels tasks from ALL active executions, not just the latest
3. **Output totalSize recalculation** - Returns actual content size for tail-sliced output
4. **Self-review cleanup** - Addresses self-discovered issues

The **core logic is sound** and well-tested. The **blocking issues are straightforward to fix**: extract a duplicated utility, ensure measurement consistency, and add two test cases. No architectural rework needed.

**Recommendation**: Fix the three blocking issues (duplication, measurement inconsistency, test coverage), add the clarifying comment, and this PR is ready to merge.

**Estimated fix time**: 45-60 minutes
