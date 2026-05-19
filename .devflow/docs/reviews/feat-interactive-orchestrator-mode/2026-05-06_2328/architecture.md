# Architecture Review Report

**Branch**: feat-interactive-orchestrator-mode -> main
**Date**: 2026-05-06T23:28
**PR**: #159

## Issues in Your Changes (BLOCKING)

### HIGH

**CLI command handler (handleOrchestrateInteractive) bypasses service layer, directly resolves DI container** - `src/cli/commands/orchestrate.ts:695-733`
**Confidence**: 88%
- Problem: `handleOrchestrateInteractive` manually resolves `agentRegistry`, `eventBus`, and `orchestrationRepository` from the DI container via `container.get<>()` calls, then performs orchestration lifecycle management (status transitions, event emission, process spawning) inline. This violates the Clean Architecture dependency rule -- the CLI layer is performing work that belongs in the service/domain layer. The existing `createOrchestration` flow delegates all lifecycle to `OrchestrationManagerService`; the interactive path does not.
  - Lines 695: resolves `agentRegistry` from container
  - Lines 730-740: calls `adapter.spawnInteractive()` directly (spawning is worker pool/service responsibility)
  - Lines 744-748: catches spawn failure, manually updates orchestration to FAILED via raw repo access
  - Lines 792-809: performs status transition + event emission inline (duplicates service-layer patterns)
- Impact: The CLI handler becomes hard to test in isolation (needs real or mock container), lifecycle logic is split across two layers, and changes to orchestration status management must be coordinated across both `orchestration-manager.ts` and `orchestrate.ts`.
- Fix: Move the spawn + wait + status transition + event emission logic into `OrchestrationManagerService` (or a dedicated `runInteractiveOrchestration` method). The CLI handler should call the service and receive a result, similar to how `handleOrchestrateForeground` delegates to `orchestrationService.createOrchestration()`. The service already has access to `eventBus`, `orchestrationRepo`, and could accept an `AgentAdapter` via DI or a registry.

**Code duplication between createInteractiveOrchestration and createOrchestration -- input validation + state file setup** - `src/services/orchestration-manager.ts:330-368`
**Confidence**: 85%
- Problem: `createInteractiveOrchestration` duplicates 40+ lines of validation and state file setup that are identical to `createOrchestration` (goal validation at lines 333-335, working directory validation at lines 338-348, agent resolution at lines 350-352, state file creation at lines 354-368). The project's engineering principles require composing with shared functions. This also means bugs fixed in one path might not be fixed in the other.
  - Notably, `createInteractiveOrchestration` is missing the compensation/cleanup pattern that `createOrchestration` has (lines 126-195 in the standard path). If `orchestrationRepo.save()` succeeds but a later step fails, the state file is orphaned and no FAILED marker is written.
- Impact: Maintenance burden doubles for any change to the create flow. Missing compensation logic means orphaned state files on failure in interactive mode.
- Fix: Extract the shared validation + state file setup into a private method (e.g., `prepareOrchestration(request)`), then have both methods call it. Also add a compensation path to `createInteractiveOrchestration` for save failure cleanup, following the pattern established in `createOrchestration`.

### MEDIUM

**Orchestration object construction uses Object.freeze spread override instead of factory function** - `src/services/orchestration-manager.ts:370-374`
**Confidence**: 85%
- Problem: Interactive orchestration construction bypasses the `createOrchestration` factory function by spreading its result and overriding `status` and `mode` fields via `Object.freeze({...createOrchestration(...), status: RUNNING, mode: 'interactive'})`. The project consistently uses factory functions + `updateOrchestration()` for domain object creation (see `createOrchestration` at domain.ts:824, `updateOrchestration` at domain.ts:851). This ad-hoc construction means the factory's defaults and invariants could be bypassed.
- Impact: If `createOrchestration` gains new mandatory fields or validation, the interactive path silently skips them. Inconsistent object construction patterns make the codebase harder to reason about.
- Fix: Either (a) extend `createOrchestration` to accept optional `mode` and initial `status` parameters, or (b) use the factory then immediately call `updateOrchestration(orchestration, { status: RUNNING, mode: 'interactive' })` as a two-step pattern consistent with the standard creation flow.

**SIGINT handler manipulation in CLI layer -- process.removeAllListeners('SIGINT')** - `src/cli/commands/orchestrate.ts:764-781`
**Confidence**: 82%
- Problem: The interactive handler removes all SIGINT listeners (`process.removeAllListeners('SIGINT')`) at line 765, installs its own, and then attempts to restore the original listeners at lines 778-781. This is fragile: if any listener is added between the save and restore (e.g., by the container or event bus), it will be lost. The cast `handler as NodeJS.SignalsListener` at line 780 also silently suppresses type errors.
- Impact: If an intermediate component adds SIGINT handlers (e.g., the database cleanup listener), they are permanently lost after the interactive session, potentially leaving resources unclean on subsequent SIGINT.
- Fix: Instead of removing all listeners, add the interactive handler with `process.prependOnceListener('SIGINT', ...)` and set a flag. Alternatively, use `AbortController` with `signal` to coordinate cancellation, which is the modern Node.js pattern.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Missing CHECK constraint on `mode` column in migration v25** - `src/implementations/database.ts:993-994`
**Confidence**: 84%
- Problem: Migration v25 adds `mode TEXT DEFAULT NULL` without a CHECK constraint. The project has an established pattern of adding CHECK constraints on enum-like columns -- see `status CHECK(status IN (...))` on orchestrations (migration v14), `eval_type CHECK(...)` (migration v22), and `strategy CHECK(...)` on loops (migration v10). This is documented as "defense-in-depth" in the migration comments.
- Impact: Invalid mode values (e.g., typos like 'interctive') can be persisted without database-level validation, detectable only at read time.
- Fix: Change to `ALTER TABLE orchestrations ADD COLUMN mode TEXT DEFAULT NULL CHECK(mode IS NULL OR mode IN ('standard', 'interactive'))`. This follows the exact pattern used in migration v22 for `eval_type`.

**ScaffoldResult.exitConditionScript and suggestedExitCondition changed from required to optional** - `src/core/orchestrator-scaffold.ts:38-39`
**Confidence**: 80%
- Problem: `exitConditionScript` and `suggestedExitCondition` were changed from required `string` to optional `string | undefined`. This weakens the interface contract -- existing consumers that rely on these fields being present (such as `mcp-adapter.ts:3398` which now needs `?? ''`) must handle the undefined case. The `?? ''` at line 3398 in the MCP adapter is a symptom of this loosened contract.
- Impact: Any future consumer that reads `ScaffoldResult` must defensively handle undefined for what were previously guaranteed fields. The real fix would preserve the contract for standard templates.
- Fix: Consider using a discriminated union: `ScaffoldResult = StandardScaffoldResult | InteractiveScaffoldResult`. The standard variant keeps required `exitConditionScript`/`suggestedExitCondition`; the interactive variant omits them. This preserves type safety for both paths.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**resolveSpawnConfig refactoring left DECISION comments orphaned** - `src/implementations/base-agent-adapter.ts:370`
**Confidence**: 80%
- Problem: The `spawn()` method previously contained inline DECISION comments explaining the resolution order (runtime precedence, agent config loading, auth validation). These were removed during the refactoring to `resolveSpawnConfig()`, but no equivalent comments were added to the new shared method. The comments documented important architectural decisions about resolution order.
- Impact: Future maintainers lose context about why runtime takes precedence and why config is loaded once.

## Suggestions (Lower Confidence)

- **handleOrchestrateInteractive cleanup sequencing** - `src/cli/commands/orchestrate.ts:819-822` (Confidence: 70%) -- `adapter.cleanup(orchestration.id)` is called after status update but before `container.dispose()`. If cleanup is slow or fails, the process exit at line 822 could race with disposal. Consider moving cleanup into the service layer with proper error handling.

- **updateInteractiveOrchestrationPid performs read-modify-write without optimistic locking** - `src/services/orchestration-manager.ts:419-425` (Confidence: 65%) -- The method reads the orchestration, then updates it. Between read and write, another process could change the row. Standard orchestrations use `updateIfStatus` for this. Low risk since interactive mode is single-user.

- **ProcessSpawnerAdapter.spawnInteractive returns err with INVALID_OPERATION** - `src/implementations/process-spawner-adapter.ts:31-35` (Confidence: 65%) -- This adapter is used in tests. If test code ever calls `spawnInteractive`, it gets a runtime error rather than a compile-time check. Consider using a type-level mechanism if interactive is never supported here.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Architecture Score**: 6/10
**Recommendation**: CHANGES_REQUESTED

The feature introduces a well-motivated interactive orchestrator mode with good test coverage (814 lines of tests). The agent adapter refactoring (extracting `resolveSpawnConfig`) demonstrates good code reuse instincts. However, two HIGH-severity issues stand out: (1) the CLI handler performs service-layer orchestration lifecycle management directly, violating the established layering boundary, and (2) the duplicated validation/setup code between the two creation methods introduces maintenance risk and is missing the compensation pattern present in the standard path. The remaining MEDIUM issues (missing CHECK constraint, weakened interface types, SIGINT handler fragility) should be addressed for consistency with established project patterns.
