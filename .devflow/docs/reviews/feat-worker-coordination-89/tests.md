# Tests Review Report

**Branch**: feat/worker-coordination-89 -> main
**Date**: 2026-03-17

## Issues in Your Changes (BLOCKING)

### HIGH

**Duplicated mock factory functions across 8+ test files** - `tests/**/*.test.ts`
- Problem: `createMockWorkerRepo()`/`createMockWorkerRepository()` is copy-pasted identically across 8 test files (event-flow, task-persistence, worker-pool-management, event-driven-worker-pool, system-resource-monitor, recovery-manager, handler-setup, and more). Similarly, `createMockOutputRepo()`/`createMockOutputRepository()` is duplicated across 7 test files. The `TestWorkerRepository` class was added to `tests/fixtures/test-doubles.ts` but none of the test files use it -- they all inline their own mock factories instead.
- Impact: Maintenance burden. If the `WorkerRepository` or `OutputRepository` interface changes (e.g., new method), every duplicate factory must be updated individually. Inconsistency risk is high. The existing `TestWorkerRepository` in test-doubles.ts was created but never consumed.
- Fix: Centralize mock factories into `tests/fixtures/test-doubles.ts` or a dedicated `tests/fixtures/mock-factories.ts` and import them across all test files. Either use the existing `TestWorkerRepository` class or export a single `createMockWorkerRepository()` function. Example:
  ```typescript
  // tests/fixtures/mock-factories.ts
  export const createMockWorkerRepository = () => ({
    register: vi.fn().mockReturnValue(ok(undefined)),
    unregister: vi.fn().mockReturnValue(ok(undefined)),
    findByTaskId: vi.fn().mockReturnValue(ok(null)),
    findByOwnerPid: vi.fn().mockReturnValue(ok([])),
    findAll: vi.fn().mockReturnValue(ok([])),
    getGlobalCount: vi.fn().mockReturnValue(ok(0)),
    deleteByOwnerPid: vi.fn().mockReturnValue(ok(0)),
  });

  export const createMockOutputRepository = () => ({
    save: vi.fn().mockResolvedValue(ok(undefined)),
    append: vi.fn().mockResolvedValue(ok(undefined)),
    get: vi.fn().mockResolvedValue(ok(null)),
    delete: vi.fn().mockResolvedValue(ok(undefined)),
  });
  ```

### MEDIUM

**Missing error path test for `flushOutput` when `getOutput` returns error** - `tests/unit/services/process-connector.test.ts`
- Problem: `ProcessConnector.flushOutput()` has an early return when `outputResult.ok` is false (line 114 of `process-connector.ts`). No test verifies this path -- all tests only exercise the happy path (`getOutput` returning `ok(...)`) or the empty output path (`totalSize === 0`).
- Impact: The `getOutput` error path is untested. While the code is a simple early return, verifying it ensures `outputRepository.save` is never called when `getOutput` fails.
- Fix: Add a test:
  ```typescript
  it('should not call outputRepository.save when getOutput returns error', async () => {
    const capture = createMockOutputCapture();
    (capture.getOutput as ReturnType<typeof vi.fn>).mockReturnValue(
      err(new Error('capture error')),
    );
    const outputRepo = createMockOutputRepository();
    const connector = new ProcessConnector(capture, logger, outputRepo);
    const proc = createMockProcess();
    connector.connect(proc as never, taskId, vi.fn());
    await vi.advanceTimersByTimeAsync(500);
    expect(outputRepo.save).not.toHaveBeenCalled();
  });
  ```

**Missing test for `RecoveryManager` Phase 0 error path: `unregister` fails** - `tests/unit/services/recovery-manager.test.ts`
- Problem: `RecoveryManager.recover()` handles `unregResult.ok === false` on line 42-45 of `recovery-manager.ts` by logging the error and continuing. No test verifies that recovery continues gracefully when `workerRepository.unregister()` fails for a dead worker.
- Impact: Error resilience path is untested. If `unregister` throws or returns an error, recovery should still proceed to mark the task as failed.
- Fix: Add a test in the "Phase 0: Dead worker cleanup" describe block:
  ```typescript
  it('should continue recovery when unregister fails for dead worker', async () => {
    const deadWorker = { workerId: WorkerId('w-dead'), taskId: TaskId('task-dead'),
      pid: DEAD_PID, ownerPid: DEAD_PID, agent: 'claude', startedAt: Date.now() };
    workerRepo.findAll.mockReturnValue(ok([deadWorker]));
    workerRepo.unregister.mockReturnValue(err(new AutobeatError(ErrorCode.SYSTEM_ERROR, 'DB error')));
    setupFindByStatus([], []);

    const result = await manager.recover();
    expect(result.ok).toBe(true); // Recovery continues despite unregister failure
    expect(logger.error).toHaveBeenCalledWith('Failed to unregister dead worker', expect.any(Error),
      expect.objectContaining({ workerId: WorkerId('w-dead') }));
  });
  ```

**Missing test for `RecoveryManager` Phase 0 error path: `update` fails for dead worker task** - `tests/unit/services/recovery-manager.test.ts`
- Problem: Lines 47-55 of `recovery-manager.ts` handle the case where `repository.update()` fails when trying to mark a dead worker's task as failed. This error path logs and continues but has no dedicated test.
- Impact: Resilience path untested.
- Fix: Add test verifying `update` failure is logged and recovery proceeds.

**No test for `flushOutput` when `outputRepository.save` returns `err()`** - `tests/unit/services/process-connector.test.ts`
- Problem: `ProcessConnector.flushOutput()` logs an error when `saveResult.ok` is false (line 121-123 of `process-connector.ts`). The existing "final flush fails" test uses `mockRejectedValue` (thrown exception), but there is no test for a `Result` error (i.e., `save` resolving with `err(...)`). These are two distinct code paths.
- Impact: The `save` returning an error Result (non-exception) exercises the `if (!saveResult.ok)` branch, which is distinct from the `.catch()` path tested by `mockRejectedValue`.
- Fix: Add a test where `save` returns `ok` but wraps an error via the Result pattern:
  ```typescript
  it('should log error when outputRepository.save returns error Result', async () => {
    const capture = createMockOutputCapture();
    (capture.getOutput as ReturnType<typeof vi.fn>).mockReturnValue(
      ok({ taskId, stdout: ['data'], stderr: [], totalSize: 4 }),
    );
    const outputRepo = createMockOutputRepository();
    (outputRepo.save as ReturnType<typeof vi.fn>).mockResolvedValue(
      err(new Error('DB constraint violation')),
    );
    const connector = new ProcessConnector(capture, logger, outputRepo);
    const proc = createMockProcess();
    connector.connect(proc as never, taskId, vi.fn());
    await vi.advanceTimersByTimeAsync(500);
    expect(logger.error).toHaveBeenCalledWith('Failed to persist output', expect.any(Error), { taskId });
  });
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`TestWorkerRepository` in `test-doubles.ts` is unused dead code** - `tests/fixtures/test-doubles.ts:704-780`
- Problem: The PR adds a full 77-line `TestWorkerRepository` implementation class to `test-doubles.ts`, but every test file that needs a mock worker repository creates its own inline `vi.fn()` mock instead. The `TestWorkerRepository` class has zero imports/consumers.
- Impact: Dead code that adds to maintenance burden. Either remove it or migrate tests to use it.
- Fix: Either (a) remove `TestWorkerRepository` entirely and keep the `vi.fn()` mock factory approach (centralized as suggested above), or (b) use `TestWorkerRepository` for tests that don't need `vi.fn()` call assertions and keep a thin mock factory for tests that do.

**Naming inconsistency in mock factories** - Multiple test files
- Problem: The same factory is named `createMockWorkerRepo` in some files and `createMockWorkerRepository` in others. Same for `createMockOutputRepo` vs `createMockOutputRepository`. This will be resolved if factories are centralized.
- Impact: Inconsistency makes codebase navigation harder.
- Fix: Standardize on one name when centralizing.

### LOW

**Integration test setup boilerplate is verbose** - `tests/integration/worker-pool-management.test.ts`
- Problem: Each integration test in this file repeats 15-20 lines of nearly identical setup (logger, config, eventBus, processSpawner, outputCapture, resourceMonitor, workerRepository, outputRepository, agentRegistry, workerPool). This setup is duplicated 6 times across the 6 `it()` blocks.
- Impact: Test readability. The repeated setup makes it harder to see what's actually being tested.
- Fix: Move shared setup to `beforeEach` or extract a `createWorkerPoolTestHarness()` helper that returns all dependencies as a single object.

## Pre-existing Issues (Not Blocking)

### LOW

**`process-connector.test.ts` creates mock per test instead of in `beforeEach`** - `tests/unit/services/process-connector.test.ts`
- Problem: Every test creates its own `capture`, `logger`, `outputRepo`, `connector`, `proc`, and `onExit` locally. While this avoids shared state, it makes each test 6-8 lines of boilerplate before the actual assertion.
- Impact: Minor readability concern. The pattern is safe (no shared mutation) but verbose.
- Fix: Consider a `beforeEach` with shared variables, or a helper function like `createTestContext()` that returns all mock objects.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 4 | 0 |
| Should Fix | 0 | 0 | 2 | 1 |
| Pre-existing | 0 | 0 | 0 | 1 |

**Tests Score**: 7/10

The new test coverage is solid in terms of breadth -- the PR adds comprehensive tests for `SQLiteWorkerRepository` (288 lines, 15 test cases), `ProcessConnector` flush lifecycle (6 new tests), `RecoveryManager` PID-based detection (8 updated/new tests), `TaskManagerService` DB-fallback logs (4 new tests), and integration tests for worker registration/unregistration (4 new tests). Test structure follows AAA pattern consistently, test names are descriptive, and assertions verify behavior rather than implementation. The main gaps are (1) duplicated mock factories that should be centralized, (2) a few missing error-path tests, and (3) an unused `TestWorkerRepository` class.

**Recommendation**: CHANGES_REQUESTED

The duplicated mock factory issue should be addressed before merge to prevent interface drift bugs. The missing error-path tests are recommended but less critical since the paths are simple log-and-continue patterns.
