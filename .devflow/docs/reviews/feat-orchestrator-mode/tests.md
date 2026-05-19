# Tests Review Report

**Branch**: feat/orchestrator-mode -> main
**Date**: 2026-03-27
**PR**: #123

## Issues in Your Changes (BLOCKING)

### HIGH

**No MCP adapter tests for 4 new orchestration tool handlers** - `src/adapters/mcp-adapter.ts:252-445`
**Confidence**: 95%
- Problem: The PR adds 4 new MCP tool handlers (`handleCreateOrchestrator`, `handleOrchestratorStatus`, `handleListOrchestrators`, `handleCancelOrchestrator`) totaling ~200 lines of business logic including Zod validation, `validatePath` calls, `match()` result pattern handling, and JSON serialization. The existing test file `tests/unit/adapters/mcp-adapter.test.ts` was modified (constructor signature changed to deps object) but no orchestration test cases were added. Each handler also has a `!this.orchestrationService` guard returning `ORCHESTRATION_UNAVAILABLE` -- none tested.
- Fix: Add test cases for each handler. At minimum:
  - `CreateOrchestrator`: valid input, Zod validation failure, path validation error, service error, service undefined
  - `OrchestratorStatus`: valid ID, invalid input, not-found error, service undefined
  - `ListOrchestrators`: default params, status filter, service error, service undefined
  - `CancelOrchestrator`: valid cancel, not-found error, service undefined
  Follow the existing `simulate*` helper pattern used for loop/schedule tools.

**No tests for orchestration cleanup in RecoveryManager** - `src/services/recovery-manager.ts:203-210`
**Confidence**: 92%
- Problem: A new `cleanupOldOrchestrations()` method was added (Phase 1c of recovery) and the constructor now accepts an optional `orchestrationRepository` parameter. The recovery-manager test file has loop cleanup tests (Phase 1b) but zero orchestration cleanup tests. The default manager instance in tests omits `orchestrationRepository`, so the cleanup code path is never exercised.
- Fix: Add a `describe('Orchestration cleanup')` section mirroring the existing `describe('Loop cleanup')` block:
  1. Cleanup called with correct retention when orchestrationRepository is provided
  2. Cleanup count logged when orchestrations are cleaned
  3. Cleanup skipped when orchestrationRepository is undefined (no crash)

### MEDIUM

**`cancelOrchestration` for PLANNING state (no loopId) untested** - `src/services/orchestration-manager.ts:268-276`
**Confidence**: 85%
- Problem: `cancelOrchestration()` has two branches: (1) `orchestration.loopId` exists, cancel the loop first; (2) no `loopId` (PLANNING state), update DB directly. The test at `tests/unit/services/orchestration-manager.test.ts:198` only tests the loopId-present path. The PLANNING-state path (lines 268-276 with direct `orchestrationRepo.update()`) is never exercised.
- Fix: Add a test that creates an orchestration without letting the loop attach (e.g., mock the event handler so `LoopCreated` does not persist the loop, or manually set status to PLANNING with no loopId), then cancel it and verify DB status is CANCELLED and `OrchestrationCancelled` event was emitted.

**`require('fs')` used instead of existing import in test cleanup** - `tests/unit/core/orchestrator-state.test.ts:29`
**Confidence**: 88%
- Problem: The test file imports `{ unlinkSync, rmdirSync, ... }` from `'fs'` at the top (line 6), but `afterEach` cleanup uses `require('fs').readdirSync(tmpDir)` instead of adding `readdirSync` to the existing ESM import. Mixing ESM `import` with CJS `require` in the same file is inconsistent.
- Fix: Add `readdirSync` to the existing import:
  ```typescript
  import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'fs';
  ```
  Then replace `require('fs').readdirSync(tmpDir)` with `readdirSync(tmpDir)`.

**CLI `parseOrchestrateArgs` (non-create subcommands) untested** - `src/cli/commands/orchestrate.ts:796-826`
**Confidence**: 82%
- Problem: Only `parseOrchestrateCreateArgs` is exported and tested in `tests/unit/cli/orchestrate.test.ts`. The wrapper function `parseOrchestrateArgs` that routes `status`, `list`/`ls`, `cancel`, and default-to-create subcommands has no tests. Edge cases include: missing ID for status/cancel (returns null), `ls` alias, `--status` flag parsing on list.
- Fix: Either export `parseOrchestrateArgs` and add tests, or add integration-level tests verifying the routing through `handleOrchestrateCommand`.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**handler-setup.test.ts has no coverage for OrchestrationHandler wiring** - `src/services/handler-setup.ts:358-376`
**Confidence**: 82%
- Problem: `setupEventHandlers` now conditionally creates an `OrchestrationHandler` when `orchestrationRepository` is present (lines 358-376), with a non-fatal warning path if creation fails. The `handler-setup.test.ts` file was not updated with any orchestration-related assertions.
- Fix: Add two test cases: (1) `orchestrationHandler` is present in result when deps include `orchestrationRepository`, (2) `orchestrationHandler` is `undefined` when `orchestrationRepository` is omitted (graceful skip).

**Integration test duplicates unit tests without true integration coverage** - `tests/integration/orchestration-lifecycle.test.ts`
**Confidence**: 80%
- Problem: The `Cancel orchestration` and `Cleanup old orchestrations` tests in the integration file are near-exact duplicates of the unit test equivalents. Neither wires up `OrchestrationHandler` to observe loop lifecycle events propagating to orchestration status changes. The `Create orchestration` test adds genuine integration value (state file verification, loop repo verification), but the other two do not add value beyond the unit tests.
- Fix: Wire `OrchestrationHandler` into the integration test to verify the full event flow: create orchestration -> emit LoopCompleted -> verify orchestration status is COMPLETED via the handler. This is the true integration path. The cancel/cleanup tests could either be enhanced or removed to reduce duplication.

**OrchestrationHandler.create() subscription failure path untested** - `src/services/handlers/orchestration-handler.ts:51-59`
**Confidence**: 80%
- Problem: The factory method checks for subscription failures and logs errors but continues (graceful degradation). No test exercises this path. While low-risk, it is a design decision worth documenting through a test.
- Fix: Consider a test that verifies handler creation succeeds even when subscriptions fail (if an injectable event bus failure mechanism exists).

## Pre-existing Issues (Not Blocking)

### MEDIUM

**MCP adapter tests bypass Zod validation via simulate helpers** - `tests/unit/adapters/mcp-adapter.test.ts:199-202`
**Confidence**: 85%
- Problem: A TODO comment documents that all MCP adapter tests bypass Zod schema validation, tool routing, and response formatting. This pre-existing limitation means the new orchestration tools also cannot be properly tested through the current approach.
- Impact: Informational -- pre-existing tech debt affecting all tools equally.

## Suggestions (Lower Confidence)

- **Missing test for `readStateFile` with incomplete-but-version-1 JSON** - `tests/unit/core/orchestrator-state.test.ts` (Confidence: 72%) -- The Zod validation was added (good), and tests cover wrong-version and malformed JSON. However, no test verifies that `{ "version": 1 }` (missing goal, status, plan, etc.) is rejected. Adding this would confirm the Zod schema catches structurally incomplete files produced by buggy agents.

- **State file cleanup race in event-based tracking** - `tests/unit/services/orchestration-manager.test.ts:59-64` (Confidence: 65%) -- The `OrchestrationCreated` event subscriber tracks state files for cleanup, but if `createOrchestration` fails after writing the state file but before emitting the event, the file leaks. Consider tracking files from the Result directly.

- **`cleanupOldOrchestrations` file deletion not verified** - `tests/unit/implementations/orchestration-repository.test.ts:175-206` (Confidence: 70%) -- The cleanup method uses `Promise.allSettled` to delete orphan state files. The repository test verifies DB row deletion but not file cleanup. Consider an integration test that creates real temp files and verifies deletion.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 3 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Tests Score**: 6/10
**Recommendation**: CHANGES_REQUESTED

### Rationale

The PR introduces 7 new test files with ~70 tests covering the core orchestration domain (repository, handler, manager, state file, CLI parser, prompt builder, and integration lifecycle). Test quality is generally good:

- Tests use real SQLite in-memory databases instead of mocks for repository/handler tests
- Proper afterEach cleanup: `db.close()`, `eventBus.dispose()`, state file cleanup
- Tests follow the Result pattern correctly with `if (!result.ok) return` guards
- AAA structure is clean and test names describe expected behavior
- Both happy and error paths are covered for most components
- State file tests use unique temp directories preventing test interference

Two significant coverage gaps drive the CHANGES_REQUESTED recommendation:

1. **MCP adapter orchestration tools (4 handlers, ~200 lines)** -- the primary external API surface for this feature -- have zero test coverage. These handlers include Zod validation, path validation, orchestration service delegation, and JSON response formatting.

2. **RecoveryManager orchestration cleanup** -- critical startup infrastructure that runs on every server start -- was added without corresponding test updates.

Additionally, the PLANNING-state cancel path and CLI subcommand routing are untested, and the handler-setup wiring for the new OrchestrationHandler lacks coverage.
