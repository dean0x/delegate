# Testing Review Report

**Branch**: feat-interactive-orchestrator-mode -> main
**Date**: 2026-05-06

## Issues in Your Changes (BLOCKING)

### HIGH

**Test file not included in any test group script** - `tests/unit/interactive-orchestrator.test.ts`
**Confidence**: 95%
- Problem: The new test file `tests/unit/interactive-orchestrator.test.ts` (60 tests) is not included in any `package.json` test group script. The `test:orchestration` group explicitly lists orchestration-related test files but omits this one. Since `test:all` is composed of named groups (`test:core && test:handlers && ... && test:orchestration && ...`), these 60 tests will never run in CI or via `npm run test:all`. They only run when invoked directly via `vitest run tests/unit/interactive-orchestrator.test.ts`.
- Fix: Add the file to the `test:orchestration` group in `package.json`:
  ```json
  "test:orchestration": "NODE_OPTIONS='--max-old-space-size=2048' vitest run tests/unit/core/orchestrator-state.test.ts tests/unit/core/orchestrator-scaffold.test.ts tests/unit/implementations/orchestration-repository.test.ts tests/unit/services/orchestration-manager.test.ts tests/unit/services/orchestrator-prompt.test.ts tests/unit/services/orchestrator-prompt-snippets.test.ts tests/unit/services/handlers/orchestration-handler.test.ts tests/unit/cli/orchestrate.test.ts tests/unit/cli/orchestrate-init.test.ts tests/unit/cli/orchestrate-foreground.test.ts tests/unit/interactive-orchestrator.test.ts tests/integration/orchestration-lifecycle.test.ts --no-file-parallelism"
  ```

**Missing test for `updateInteractiveOrchestrationPid`** - `src/services/orchestration-manager.ts:419-425`
**Confidence**: 90%
- Problem: The `updateInteractiveOrchestrationPid` method in `OrchestrationManagerService` has zero test coverage. This method performs a read-then-write pattern (`getOrchestration` then `orchestrationRepo.update`) that could fail at either step. The happy path (PID is persisted to DB) and the error path (orchestration not found) are both untested.
- Fix: Add tests to the `createInteractiveOrchestration` describe block:
  ```typescript
  it('should persist PID via updateInteractiveOrchestrationPid', async () => {
    const createResult = await service.createInteractiveOrchestration({ goal: 'Test' });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;
    createdStateFiles.push(createResult.value.orchestration.stateFilePath);

    const pidResult = await service.updateInteractiveOrchestrationPid(
      createResult.value.orchestration.id,
      12345,
    );
    expect(pidResult.ok).toBe(true);

    const dbResult = await orchestrationRepo.findById(createResult.value.orchestration.id);
    expect(dbResult.ok).toBe(true);
    expect(dbResult.value!.pid).toBe(12345);
  });

  it('should return error when updating PID for non-existent orchestration', async () => {
    const result = await service.updateInteractiveOrchestrationPid(
      OrchestratorId('orchestrator-nonexistent'),
      12345,
    );
    expect(result.ok).toBe(false);
  });
  ```

### MEDIUM

**Missing test for `handleOrchestrateInteractive` FAILED status on spawn failure** - `src/cli/commands/orchestrate.ts:742-750`
**Confidence**: 85%
- Problem: When `adapter.spawnInteractive()` fails, the handler marks the orchestration as FAILED in the DB (line 745) before exiting. This compensating write is an important correctness guarantee but has no test coverage. The spawn failure path is tested for the adapter itself (CLI not found), but the CLI handler's compensation behavior -- marking the orchestration FAILED -- is untested.
- Fix: This is a CLI handler function that is difficult to unit test due to `process.exit()` and `withServices()`. Consider extracting the compensation logic into a testable helper, or adding an integration-level test. At minimum, this is a coverage gap to acknowledge.

**Missing test for cancel with stored PID (process.kill path)** - `src/services/orchestration-manager.ts:476-484`
**Confidence**: 82%
- Problem: `cancelOrchestration` for interactive mode calls `process.kill(orchestration.pid, 'SIGTERM')` when a PID is stored. The existing cancel test creates an interactive orchestration (which has no PID stored since `updateInteractiveOrchestrationPid` is never called in the test), so the `process.kill` path is never exercised. The ESRCH catch path (process already dead) is also untested.
- Fix: Add a test that stores a PID before cancelling:
  ```typescript
  it('should attempt SIGTERM when interactive orchestration has stored PID', async () => {
    const createResult = await service.createInteractiveOrchestration({ goal: 'Test' });
    if (!createResult.ok) return;
    createdStateFiles.push(createResult.value.orchestration.stateFilePath);

    // Store a fake PID
    await service.updateInteractiveOrchestrationPid(
      createResult.value.orchestration.id,
      99999,
    );

    // Cancel should attempt process.kill but swallow ESRCH
    const cancelResult = await service.cancelOrchestration(createResult.value.orchestration.id);
    expect(cancelResult.ok).toBe(true);
  });
  ```

**No `OrchestrationFailed` event emission test for interactive mode** - `src/cli/commands/orchestrate.ts:800-808`
**Confidence**: 80%
- Problem: When an interactive orchestration fails (non-zero exit code), the handler does NOT emit `OrchestrationFailed` -- it only emits for `CANCELLED` and `COMPLETED`. This may be intentional (the FAILED case has no event emission), but there is no test validating this deliberate omission. If a future change accidentally adds or removes event emission, no test would catch it.
- Fix: Add a test or code comment documenting the intentional omission of the FAILED event for interactive mode.

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

_No issues found._

## Suggestions (Lower Confidence)

- **Repetitive beforeEach/afterEach setup across describe blocks** - `tests/unit/interactive-orchestrator.test.ts:485-505,602-622` (Confidence: 65%) -- The `createInteractiveOrchestration` and `cancelOrchestration - interactive mode` describe blocks duplicate identical setup/teardown code (DB creation, repo instantiation, state file cleanup). Consider extracting into a shared helper or wrapping describe block to reduce boilerplate.

- **Top-level vi.mock placement** - `tests/unit/interactive-orchestrator.test.ts:187-195` (Confidence: 60%) -- The `vi.mock('child_process')` and `vi.mock('../../src/core/agents')` are at the top level outside any describe block. This is correct for Vitest hoisting but affects all tests in the file, including the service-layer tests that use real in-memory SQLite. The mocks are scoped appropriately here, but in a larger file this pattern could cause unexpected interactions.

- **ProcessSpawnerAdapter.spawnInteractive is untested** - `src/implementations/process-spawner-adapter.ts:31-35` (Confidence: 70%) -- The adapter returns a hardcoded error for interactive mode. While simple, it represents a contract (interactive mode is unsupported for ProcessSpawner) that should ideally have a test.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | - | 2 | 2 | - |
| Should Fix | - | - | - | - |
| Pre-existing | - | - | - | - |

**Testing Score**: 6/10
**Recommendation**: CHANGES_REQUESTED

The test file is well-structured with good coverage of CLI arg parsing, adapter interactive args, service-layer orchestration create/cancel, migration schema, scaffold templates, and liveness checks. Tests follow AAA structure, use real SQLite in-memory databases (per project convention), and properly clean up state files. However, two blocking issues prevent approval: (1) the test file is not included in any CI test group, meaning these 60 tests will never run in `test:all` or CI, and (2) a key service method (`updateInteractiveOrchestrationPid`) has zero coverage. The cancel-with-PID path also lacks coverage of the `process.kill` branch.
