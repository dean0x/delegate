# Testing Review Report

**Branch**: feat/178-worker-pool-rewiring -> main
**Date**: 2026-05-19

## Issues in Your Changes (BLOCKING)

### CRITICAL

**Failing test: `buildTmuxCommand() -- ProcessSpawnerAdapter` expects `err` but implementation now returns `ok`** - `tests/unit/implementations/build-tmux-command.test.ts:422`
**Confidence**: 100%
- Problem: `ProcessSpawnerAdapter.buildTmuxCommand()` was changed from returning `err(new AutobeatError(ErrorCode.INVALID_OPERATION, ...))` to returning `ok({...})` in `src/implementations/process-spawner-adapter.ts:49-62`. However, the test at line 422 still asserts `expect(result.ok).toBe(false)`. This test fails when run (`npm run test:implementations` produces 1 failure). This is a verified red test in the branch.
- Fix: Either update the test to match the new behavior (assert `result.ok === true` and validate the returned config shape), or revert the implementation if the old error behavior was intentional. Given that `ProcessSpawnerAdapter` is now used with tmux-backed pools that need `buildTmuxCommand` to succeed, updating the test is the correct fix:
```typescript
it('returns ok with a valid tmux config', () => {
  const mockSpawner = { spawn: vi.fn(), kill: vi.fn() };
  const adapter = new ProcessSpawnerAdapter(mockSpawner);
  const result = adapter.buildTmuxCommand({ ...baseOptions, sessionsDir: '/tmp/sessions' });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.config.name).toMatch(/^beat-/);
  expect(result.value.prompt).toBe(baseOptions.prompt);
});
```

### HIGH

**No tests for RecoveryManager tmux liveness paths** - `src/services/recovery-manager.ts:100-112, 169-176, 422-446`
**Confidence**: 95%
- Problem: RecoveryManager gained 75 new lines implementing tmux-aware recovery: a new `isTmuxSessionAlive()` method (lines 108-112), tmux-specific branching in `cleanDeadWorkerRegistrations()` (lines 169-176), and tmux-specific branching in `recoverRunningTasks()` (lines 422-446). These are critical paths -- they determine whether a crashed tmux worker is detected and its task is marked FAILED. The existing recovery-manager test file (`tests/unit/services/recovery-manager.test.ts`) has zero changes and zero tmux references. Key untested scenarios:
  - Worker with `pid=0` and valid `sessionName` where `isTmuxSessionAlive()` returns true (should skip recovery)
  - Worker with `pid=0` and valid `sessionName` where `isTmuxSessionAlive()` returns false (should fail task)
  - Worker with `pid=0` and no `sessionName` (should fail task -- incomplete registration)
  - Worker with `pid=0` and no `tmuxSessionManager` injected (falls back to false)
  - Stale heartbeat warning path for tmux workers
- Fix: Add test cases to `tests/unit/services/recovery-manager.test.ts` that inject a mock `TmuxSessionManagerCorePort` and verify the branching logic for tmux workers. Example:
```typescript
it('should skip recovery for tmux worker with live session', async () => {
  const mockTmuxSM = { isAlive: vi.fn().mockReturnValue(ok(true)), sendControlKeys: vi.fn() };
  // Create RecoveryManager with tmuxSessionManager injected
  // Register worker with pid=0 and sessionName='beat-task-123'
  // Run recover()
  // Assert task is NOT marked failed
});
```

**Missing timeout behavior tests for tmux worker pool** - `tests/unit/implementations/event-driven-worker-pool.test.ts`
**Confidence**: 85%
- Problem: The implementation has a `handleWorkerTimeout()` method (lines 647-675) and `setupTimeoutForWorker()` (lines 517-534) that set up timeout timers for tasks. The rewritten test file has zero timeout test cases. The old test file (57 lines on main) also had none, but the implementation has been significantly expanded. With fake timers already in use in the test file, timeout behavior is straightforwardly testable and is a critical path (tasks that hang forever).
- Fix: Add test cases that verify timeout triggers `kill()` and emits `TaskTimeout`:
```typescript
describe('Timeout handling', () => {
  it('emits TaskTimeout when task exceeds timeout', async () => {
    const task = { ...buildTask(), timeout: 5000 };
    await pool.spawn(task);
    await vi.advanceTimersByTimeAsync(5500);
    expect(eventBus.emit).toHaveBeenCalledWith('TaskTimeout', expect.objectContaining({ taskId: task.id }));
  });
});
```

### MEDIUM

**Duplicate MockTmuxConnector implementations with behavioral divergence** - `tests/unit/implementations/event-driven-worker-pool.test.ts:31-74` and `tests/fixtures/mocks.ts:147-186`
**Confidence**: 82%
- Problem: Two `createMockTmuxConnector` implementations exist. The unit test version (line 58) throws `Error` when `_simulateExit` is called for an unknown taskId; the shared fixture version (line 173) silently returns without calling any callback. This behavioral difference means the unit tests are stricter than integration tests, which could mask bugs where callbacks are never registered. The unit test mock also lacks the `autoComplete` option that the shared fixture supports.
- Fix: Consolidate into a single shared implementation in `tests/fixtures/mocks.ts`. The unit test file should import from fixtures instead of defining its own. The shared mock already has the correct shape -- the only change needed is making the `_simulateExit` throw when callbacks are missing (matching the unit test's stricter behavior, which is preferable for catching registration bugs):
```typescript
// In mocks.ts, change _simulateExit to:
_simulateExit(taskId: string, code: number | null): void {
  const callbacks = callbacksMap.get(taskId);
  if (!callbacks) throw new Error(`No callbacks registered for taskId: ${taskId}`);
  callbacks.onExit(code);
},
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`as any` type cast for TmuxConnectorPort in handler-setup test** - `tests/unit/services/handler-setup.test.ts:94`
**Confidence**: 80%
- Problem: The inline no-op tmux connector is cast with `as any` to satisfy the `TmuxConnectorPort` type. This bypasses type checking and could mask interface drift. The shared `createMockTmuxConnector()` in fixtures already implements the correct interface without `as any`.
- Fix: Import and use the shared `createMockTmuxConnector` from fixtures:
```typescript
import { createMockTmuxConnector } from '../../fixtures/mocks.js';
// ...
tmuxConnector: createMockTmuxConnector(),
```

## Pre-existing Issues (Not Blocking)

(none found at CRITICAL severity)

## Suggestions (Lower Confidence)

- **Missing test for `cleanupFn` invocation on tmux worker completion** - `src/implementations/event-driven-worker-pool.ts:503-511` (Confidence: 70%) -- The `cleanupFn` path (for tasks with system prompts) is never tested in the new test suite. When `adapter.cleanup(taskId)` throws, the catch block at line 506 logs a warning. This error-swallowing behavior should have a test.

- **No test for `sendControlKeys` failure in kill path** - `src/implementations/event-driven-worker-pool.ts:238-243` (Confidence: 65%) -- When `sendControlKeys` returns an error during `kill()`, the code logs a warning and proceeds to force-destroy. This graceful degradation path is untested.

- **Integration test `createWorkerPoolFixture` does not reset between tests** - `tests/integration/worker-pool-management.test.ts:22-54` (Confidence: 62%) -- The fixture factory is called per-test but mock call counts from `vi.fn()` carry across tests within the same describe block since there is no `beforeEach`/`afterEach` that resets the mocks. Currently not a problem because tests use `try/finally` with `killAll`, but fragile if new tests are added.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 1 | 2 | 1 | - |
| Should Fix | - | - | 1 | - |
| Pre-existing | - | - | - | - |

**Testing Score**: 6/10
**Recommendation**: CHANGES_REQUESTED

The new test suite for `EventDrivenWorkerPool` is well-structured with clear AC/EC-numbered test cases covering spawn, kill, heartbeat, output routing, exit callbacks, and double-completion guards. However, the CRITICAL failing test (`build-tmux-command.test.ts:422`) must be fixed before merge. The missing RecoveryManager tmux recovery tests represent a significant gap -- those paths determine whether crashed tmux workers are detected at startup, which is a core reliability concern for the tmux migration. The timeout behavior gap is lower risk since the old test file also lacked it, but should be addressed given the expanded implementation.
