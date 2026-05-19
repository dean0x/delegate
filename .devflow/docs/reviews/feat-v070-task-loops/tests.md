# Tests Review Report

**Branch**: feat/v070-task-loops -> main
**Date**: 2026-03-21

## Issues in Your Changes (BLOCKING)

### HIGH

**No unit tests for MCP adapter loop tool handlers (4 handlers, ~240 lines)** - `src/adapters/mcp-adapter.ts:1847-2088`
**Confidence**: 92%
- Problem: Four new MCP tool handlers were added (`handleCreateLoop`, `handleLoopStatus`, `handleListLoops`, `handleCancelLoop`) comprising ~240 lines of business logic (input parsing, path validation, request mapping, response formatting). The existing MCP adapter test file (`tests/unit/adapters/mcp-adapter.test.ts`) only updates constructor signatures to pass `stubLoopService` -- no tests exercise the loop tool handlers themselves.
- Impact: Regressions in input validation, request mapping (e.g., `toOptimizeDirection`), or response formatting would be undetected. The pattern of other MCP tools (DelegateTask, TaskStatus, etc.) is well-tested in the same file, so this is a coverage gap specific to the new loop tools.
- Fix: Add tests for each of the 4 loop MCP handlers following the existing pattern in `mcp-adapter.test.ts`. At minimum: success path, validation error path, and service error path for each handler.

**No unit tests for CLI loop commands (400 lines)** - `src/cli/commands/loop.ts:1-400`
**Confidence**: 88%
- Problem: The `handleLoopCommand` function and its sub-commands (`handleLoopCreate`, `handleLoopList`, `handleLoopGet`, `handleLoopCancel`) are 400 lines of untested code. This includes argument parsing, validation, error display, and service integration. No test file exists for the loop CLI commands.
- Impact: CLI argument parsing bugs (e.g., `--until`/`--eval` mutual exclusion, `--pipeline` mode validation, `--direction` enforcement) would be undetected. The CLI is a primary user interface, and the parsing logic has numerous edge cases.
- Fix: Add a `tests/unit/cli/loop.test.ts` file testing the argument parsing and validation logic. The existing `tests/unit/cli.test.ts` can serve as a pattern.

### MEDIUM

**Integration test disables FK constraints without documenting the production impact** - `tests/integration/task-loops.test.ts:63`
**Confidence**: 82%
- Problem: The integration test disables `foreign_keys` pragma with the comment that LoopHandler records iterations before PersistenceHandler saves the task. While the comment acknowledges the FK ordering issue, this means the integration test never validates FK integrity. If the production system also has this ordering issue, it could lead to orphaned iteration records.
- Fix: Consider testing with FK constraints enabled in at least one test case to verify that the real bootstrap wiring (where both handlers run in the same event pipeline) maintains FK integrity. Alternatively, add an explicit test that verifies the ordering is correct in the full pipeline.

**LoopHandler recovery test does not verify recovered behavior end-to-end** - `tests/unit/services/handlers/loop-handler.test.ts:534-584`
**Confidence**: 80%
- Problem: The recovery test (R3) creates a loop with a running iteration directly in the DB, then creates a new LoopHandler instance. It verifies that the factory `create()` succeeds, but does not verify that the recovered handler actually processes a `TaskCompleted` event for the recovered task. The comment says "The task-to-loop map should be populated (we can verify by checking that a TaskCompleted event for this task is handled)" but then does not actually perform that verification.
- Fix: After creating the fresh handler, emit a `TaskCompleted` event for the recovered `taskId` and verify the loop's iteration is updated (or the loop completes/continues). This would validate that the taskToLoop map was actually rebuilt correctly.

```typescript
// After creating the new handler:
vi.mocked(execSync).mockReturnValue('ok\n');
await freshEventBus.emit('TaskCompleted', { taskId, exitCode: 0, duration: 100 });
await flushEventLoop();

// Verify the handler processed the event
const updatedLoop = loopRepo.findByIdSync(loop.id);
expect(updatedLoop!.status).not.toBe(LoopStatus.RUNNING);
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Context enrichment test only verifies checkpoint was queried, not that prompt was enriched** - `tests/unit/services/handlers/loop-handler.test.ts:610-652`
**Confidence**: 85%
- Problem: The R2 context enrichment test sets up a mock checkpoint with `outputSummary` and `errorSummary`, triggers a second iteration, and then only asserts `expect(mockCheckpointRepo.findLatest).toHaveBeenCalled()`. It does not verify that the emitted `TaskDelegated` event contains the enriched prompt with "Previous Iteration Context" text. This tests implementation (mock was called) rather than behavior (prompt was enriched).
- Fix: Capture the emitted `TaskDelegated` event and verify the task's prompt contains the checkpoint context:

```typescript
// Subscribe to TaskDelegated to capture the enriched prompt
let delegatedTask: Task | undefined;
freshEventBus.subscribe('TaskDelegated', (event) => {
  delegatedTask = event.task;
});
// ... trigger second iteration ...
expect(delegatedTask?.prompt).toContain('Previous Iteration Context');
expect(delegatedTask?.prompt).toContain('Test output from previous run');
```

**LoopManager cancelLoop with cancelTasks=true not tested** - `tests/unit/services/loop-manager.test.ts:293-323`
**Confidence**: 82%
- Problem: The `cancelLoop()` method in `LoopManagerService` has a significant code path for `cancelTasks=true` (lines 273-295 in loop-manager.ts) that emits `TaskCancellationRequested` events for running iterations. The test file only tests basic cancel (without `cancelTasks`). The `cancelTasks` parameter is tested in the integration test via `service.cancelLoop(loopId, 'User cancelled')` but without `cancelTasks=true`.
- Fix: Add a test in `loop-manager.test.ts` that creates a loop, saves a running iteration, calls `cancelLoop(loopId, 'reason', true)`, and verifies `TaskCancellationRequested` events were emitted.

## Pre-existing Issues (Not Blocking)

_No CRITICAL pre-existing issues found._

## Suggestions (Lower Confidence)

- **Missing edge case: maxIterations=0 (unlimited)** - `tests/unit/services/handlers/loop-handler.test.ts` (Confidence: 72%) -- The handler has logic for `maxIterations > 0` to check termination. No test verifies that `maxIterations=0` allows unlimited iterations (the loop continues without hitting the iteration limit).

- **Missing error path: evaluateExitCondition timeout** - `tests/unit/services/handlers/loop-handler.test.ts` (Confidence: 68%) -- The `evaluateExitCondition` passes `timeout: loop.evalTimeout` to `execSync`. No test simulates a timeout scenario where `execSync` throws with a timeout-specific error to verify the handler handles it gracefully.

- **Repetitive `if (!result.ok) return;` boilerplate in repository tests** - `tests/unit/implementations/loop-repository.test.ts` (Confidence: 65%) -- The pattern `expect(result.ok).toBe(true); if (!result.ok) return;` appears 40+ times. This is consistent with the project's existing test conventions for Result types, but a helper like `expectOk(result)` that narrows the type and returns the value would reduce noise.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 1 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Tests Score**: 6/10
**Recommendation**: CHANGES_REQUESTED

### Rationale

The new test suite is well-structured and thorough for the core loop engine (repository: 45 tests, handler: 20 tests, manager: 24 tests, integration: 5 tests). Test design follows project conventions with behavioral focus, real SQLite databases, and proper Result pattern validation. The repository tests cover CRUD, pagination, JSON round-trips, FK cascade, transaction atomicity, and cleanup. The handler tests cover both strategies, pipeline loops, cooldown, cancel, recovery, and env var injection. The integration test validates end-to-end lifecycle with real shell commands.

However, two significant coverage gaps reduce the score: the 4 MCP adapter loop handlers (~240 lines) and the CLI loop commands (400 lines) have zero test coverage. Together these represent the primary user-facing interfaces for the loop feature. The recovery test also has an assertion gap where it verifies setup but not actual recovered behavior. These gaps should be addressed before merge.
