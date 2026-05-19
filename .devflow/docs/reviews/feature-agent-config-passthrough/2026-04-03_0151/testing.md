# Testing Review Report

**Branch**: feature/agent-config-passthrough -> main
**Date**: 2026-04-03

## Issues in Your Changes (BLOCKING)

### CRITICAL

_No critical issues._

### HIGH

**Orchestration `model` field not persisted -- no test catches the data loss** - `src/implementations/orchestration-repository.ts`
**Confidence**: 95%
- Problem: The `Orchestration` domain type now includes a `model?: string` field (added in `src/core/domain.ts`), and `createOrchestration()` sets it from the request. However, `SQLiteOrchestrationRepository` does not persist `model` at all: the `toRow()` method omits it, the `rowToOrchestration()` method omits it, the `OrchestrationRow` interface lacks it, the `OrchestrationRowSchema` lacks it, and the SQL INSERT/UPDATE statements do not reference it. There is also no database migration (v17) adding a `model` column to the `orchestrations` table. As a result, after saving and re-loading an orchestration, `model` is silently lost. The new test in `orchestration-manager.test.ts:154` ("should pass model to loop creation when model is specified") only verifies the LoopCreated event carries the model -- it does **not** verify the orchestration itself round-trips `model` through the repository. This means: (1) `beat orchestrate status <id>` will never show `model` after restart, and (2) recovery flows that reload orchestrations from DB will lose the model setting.
- Fix: Add migration v17 with `ALTER TABLE orchestrations ADD COLUMN model TEXT`, update `OrchestrationRow`, `OrchestrationRowSchema`, `toRow()`, `rowToOrchestration()`, and INSERT/UPDATE statements. Then add a repository-level round-trip test:
  ```typescript
  it('should persist and retrieve model field', async () => {
    const result = await service.createOrchestration({
      goal: 'Test model persistence',
      model: 'claude-opus-4-5',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const getResult = await service.getOrchestration(result.value.id);
    expect(getResult.ok).toBe(true);
    if (!getResult.ok) return;
    expect(getResult.value.model).toBe('claude-opus-4-5');
  });
  ```

### MEDIUM

**No tests for `model` passthrough in TaskManager.retry() and TaskManager.resume()** - `src/services/task-manager.ts:5977,6083`
**Confidence**: 82%
- Problem: The production code correctly threads `model` through `retry()` (line 5977: `model: originalTask.model`) and `resume()` (line 6083: `model: originalTask.model`), but there are no corresponding tests in `task-manager.test.ts` verifying that the model field survives retry and resume operations. If a regression removes these lines, no test would catch it.
- Fix: Add tests to `tests/unit/services/task-manager.test.ts`:
  ```typescript
  it('should preserve model field on retry', async () => {
    // Create and complete a task with model, then retry
    // Assert the new task carries model: 'claude-opus-4-5'
  });

  it('should preserve model field on resume', async () => {
    // Create and fail a task with model, then resume
    // Assert the new task carries model: 'claude-opus-4-5'
  });
  ```

**No tests for schedule/pipeline/loop `model` field threading through ScheduleHandler** - `src/services/handlers/schedule-handler.ts:4424`
**Confidence**: 80%
- Problem: The `handlePipelineTrigger` method now passes `model: step.model ?? defaults.model` when creating tasks. The `createScheduledLoop` method threads `model` into the loop's `taskTemplate`. None of these paths have dedicated test assertions for the `model` field in the schedule handler or schedule manager test files. While MCP adapter tests cover Zod schema acceptance, the service-layer threading of `model` from schedule -> triggered task is untested.
- Fix: Add targeted tests in schedule handler tests or integration tests verifying:
  - Scheduled task trigger creates a task with the expected model
  - Pipeline trigger threads per-step model and default model correctly
  - Scheduled loop creation threads model into the loop's taskTemplate

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Duplicate test blocks in diff output (verify actual test file)** - `tests/unit/implementations/agent-adapters.test.ts`, `tests/unit/adapters/mcp-adapter.test.ts`
**Confidence**: 85%
- Problem: The diff shows the "baseUrl passthrough", "model passthrough", and "ConfigureAgent -- Claude baseUrl warning" test blocks appearing to be repeated multiple times. The diff rendering may be a context artifact, but the actual files on disk (`agent-adapters.test.ts` at 724 lines, `mcp-adapter.test.ts` at 2959 lines) should be verified to ensure the test blocks are not literally duplicated. Duplicate `describe` blocks with identical names and test cases would run the same tests multiple times, wasting CI time and confusing developers.
- Fix: Verify the actual files do not contain duplicate test blocks. If duplicated, remove the extra copies.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`createTestTask` fixture does not include `model` in its default shape** - `tests/fixtures/test-data.ts:4`
**Confidence**: 80%
- Problem: The `createTestTask` factory uses `Partial<Task>` spread, so callers can pass `model` as an override (and the task-repository test does this successfully). However, the factory does not document or demonstrate `model` in its default set of fields. This is not blocking since the spread pattern works, but it would improve discoverability to add `model: undefined` or a comment indicating its availability.
- Fix: Minor documentation or default field addition in the factory.

## Suggestions (Lower Confidence)

- **No test for `saveAgentConfig` with empty string on `apiKey`** - `src/core/configuration.ts` (Confidence: 70%) -- The empty-string-clears-key behavior is tested for `baseUrl` and `model`, but not for `apiKey`. This edge case could behave differently since `apiKey` was the original field.

- **No test for EventDrivenWorkerPool passing `model` to adapter.spawn()** - `tests/unit/implementations/event-driven-worker-pool.test.ts` (Confidence: 65%) -- The worker pool test file does show `task.model` being passed in `spawn` call assertions (lines 250, 258), which is good. However, these appear to be existing assertions that merely include `model` in the call signature rather than explicitly testing a task with a model value set vs. undefined.

- **CLI `--model` flag parsing not directly tested** - `src/cli.ts` (Confidence: 60%) -- The `--model` flag is added to `beat run` and `beat orchestrate` CLI parsers, but there are no CLI-level tests for this flag. The MCP adapter tests cover the Zod schema, but the imperative CLI arg parsing is only tested implicitly.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Testing Score**: 6/10

The PR adds substantial new tests (agent-config.test.ts with 30 test cases, baseUrl/model passthrough tests in agent-adapters.test.ts, ConfigureAgent warning tests in mcp-adapter.test.ts, domain model tests for `model` field, task-repository model persistence tests, and orchestration-manager model passthrough tests). The test quality is good -- tests follow AAA pattern, use real implementations where possible, and clean up resources properly.

However, there is one HIGH-severity gap: the `model` field on `Orchestration` is not persisted to the database (no migration, no repository support), and no test catches this because the existing test only checks the LoopCreated event, not the repository round-trip. There are also MEDIUM gaps in TaskManager retry/resume and ScheduleHandler threading that lack test coverage for the new `model` field.

**Recommendation**: CHANGES_REQUESTED
