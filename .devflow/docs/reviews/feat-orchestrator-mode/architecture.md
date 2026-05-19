# Architecture Review Report

**Branch**: feat/orchestrator-mode -> main
**Date**: 2026-03-27 (updated review -- post-fix commits)
**PR**: #123
**Commits**: 25 (7bbc8e6..3d07ac5)

## Issues in Your Changes (BLOCKING)

### HIGH

**OrchestrationHandler uses positional constructor params while all sibling handlers use deps objects** - `src/services/handlers/orchestration-handler.ts:25-29`
**Confidence**: 92%
- Problem: Every other handler in this PR was refactored to use typed deps objects (e.g., `CheckpointHandlerDeps`, `LoopHandlerDeps`, `ScheduleHandlerDeps`, `DependencyHandlerDeps`, `WorkerHandlerDeps`). The `OrchestrationHandler` private constructor and `create()` factory still use positional parameters. This violates the consistency principle established by this PR itself and creates a maintenance divergence point for the handler family.
- Impact: The next developer adding a dependency to `OrchestrationHandler` must remember positional ordering (fragile). All other handlers in the same directory use a deps interface -- this one does not.
- Fix: Extract an `OrchestrationHandlerDeps` interface and thread it through `create()` and the private constructor, matching the pattern in `LoopHandler`, `ScheduleHandler`, etc.
```typescript
export interface OrchestrationHandlerDeps {
  readonly orchestrationRepo: SyncOrchestrationOperations;
  readonly loopRepo: SyncLoopOperations;
  readonly database: TransactionRunner;
  readonly eventBus: EventBus;
  readonly logger: Logger;
}

// private constructor(deps: OrchestrationHandlerDeps) { ... }
// static async create(deps: OrchestrationHandlerDeps): Promise<Result<OrchestrationHandler>> { ... }
```

**OrchestrationHandler.create() silently swallows subscription failures** - `src/services/handlers/orchestration-handler.ts:48-59`
**Confidence**: 88%
- Problem: When `eventBus.subscribe` fails for either `LoopCompleted` or `LoopCancelled`, the handler logs an error but still returns `ok(handler)`. A handler that cannot receive events is non-functional. Other factory-pattern handlers (e.g., `CheckpointHandler.create()`, `DependencyHandler.create()`, `LoopHandler.create()`) return `err()` when `subscribeToEvents()` fails.
- Impact: The orchestrator mode could silently run without status updates -- orchestrations would remain in "running" forever because the handler never receives loop completion events. This is a data consistency risk.
- Fix: Collect subscription results and return `err()` if any critical subscription fails.
```typescript
const completedSub = eventBus.subscribe<LoopCompletedEvent>('LoopCompleted', ...);
if (!completedSub.ok) {
  return err(new AutobeatError(ErrorCode.SYSTEM_ERROR,
    'OrchestrationHandler failed to subscribe to LoopCompleted'));
}
const cancelledSub = eventBus.subscribe<LoopCancelledEvent>('LoopCancelled', ...);
if (!cancelledSub.ok) {
  return err(new AutobeatError(ErrorCode.SYSTEM_ERROR,
    'OrchestrationHandler failed to subscribe to LoopCancelled'));
}
```

**Shared exit condition script at fixed path creates race condition** - `src/core/orchestrator-state.ts:128`
**Confidence**: 82%
- Problem: `writeExitConditionScript()` writes to a fixed path `{stateDir}/check-complete.js` that is the same for ALL orchestrations. If two orchestrations are created near-simultaneously, they overwrite each other's exit condition script. The script uses `process.argv[2] || <hardcoded-default-path>` as a fallback, so the hardcoded path reflects whichever orchestration wrote last.
- Impact: Concurrent orchestrations could evaluate the wrong state file, leading to premature completion or infinite running. The CLI invocation at `orchestration-manager.ts:154` passes the state file path as an argument, so the argv[2] path is correct -- but the baked-in fallback path is wrong for all but the last-written orchestration. If a shell argument is ever truncated or missing, the fallback kicks in with the wrong file.
- Fix: Generate a unique script name per orchestration (e.g., `check-complete-{uuid}.js`) or remove the fallback entirely and rely solely on the command-line argument.
```typescript
export function writeExitConditionScript(dir: string, orchestrationId: string, stateFilePath: string): string {
  const scriptPath = path.join(dir, `check-complete-${orchestrationId}.js`);
  const script = `try {
  const s = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
  process.exit(s.status === 'complete' ? 0 : 1);
} catch { process.exit(1); }
`;
  // ...
}
```

### MEDIUM

**OrchestrationManagerService.createOrchestration partial-failure: orphan DB row on loop creation failure** - `src/services/orchestration-manager.ts:130-167`
**Confidence**: 85%
- Problem: The method first saves the orchestration to the DB (line 131), then creates the loop (line 151). If loop creation fails, the orchestration row remains in the DB with `status: PLANNING` and no `loopId`. There is no rollback or cleanup path.
- Impact: Orphan orchestrations in PLANNING status without a loop ID will never transition to a terminal state and will accumulate until the 7-day cleanup runs (which only cleans up terminal states -- `completed`, `failed`, `cancelled`). Users querying `beat orchestrate list` will see phantom entries.
- Fix: Add a compensating action to delete the orphan on loop failure:
```typescript
if (!loopResult.ok) {
  // Compensating action: remove orphan orchestration
  await this.orchestrationRepo.delete(orchestration.id);
  this.logger.error('Failed to create orchestrator loop', loopResult.error, {
    orchestratorId: orchestration.id,
  });
  return err(loopResult.error);
}
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**LoopManagerService prompt length validation removed entirely** - `src/services/loop-manager.ts:44`
**Confidence**: 85%
- Problem: The prompt length validation was completely removed (previously 4000 chars). The orchestrator prompt builder generates prompts that exceed 4000 chars, which is presumably why this was removed. However, there is now no upper bound on prompt size at the service layer at all.
- Impact: Without any limit, an erroneous or malicious request could pass an arbitrarily large prompt through to the agent CLI, potentially causing memory issues or shell argument length overflow. CLI users bypass MCP validation and hit the service layer directly.
- Fix: Replace the removed limit with a reasonable higher bound (e.g., 64000 chars) that accommodates orchestrator prompts while still providing a safety net. The Zod schema in the MCP adapter validates `goal` at 8000 chars, but `prompt` in `createLoop` now has no boundary validation.

**CLI orchestrate status/list reads repository directly, bypassing service layer** - `src/cli/commands/orchestrate.ts:342`
**Confidence**: 80%
- Problem: `handleOrchestrateStatus()` and `handleOrchestrateList()` call `ctx.orchestrationRepository.findById()`/`findByStatus()`/`findAll()` directly via `withReadOnlyContext`, while `handleOrchestrateCancel()` correctly uses the service layer via `withServices`. This is an inconsistency within a single file.
- Impact: The project's architecture note says "queries use direct repository access" which partially justifies this -- it follows the hybrid event-driven pattern. However, the inconsistency within the same command file (read-only ops use repo, mutations use service) could confuse contributors. This is more of a consistency observation than a bug.
- Fix: Document the pattern choice in a comment at the top of the file, or consistently use the service layer for all operations.

## Pre-existing Issues (Not Blocking)

_No critical pre-existing issues found in the files reviewed._

## Suggestions (Lower Confidence)

- **Dual cancel notification path for RUNNING orchestrations** - `src/services/orchestration-manager.ts:258-290` (Confidence: 72%) -- For RUNNING orchestrations, the cancel flow calls `loopService.cancelLoop()` (which triggers `LoopCancelled` -> `OrchestrationHandler` updates DB) and also emits `OrchestrationCancelled`. No handler subscribes to `OrchestrationCancelled`, making it a fire-and-forget notification. This is not incorrect, but the dual-path architecture means the actual DB update relies on the `LoopCancelled` handler. If the handler subscription failed (see blocking issue above), the DB is never updated. Consider a direct DB update as a fallback.

- **`getStateDir()` uses hardcoded path convention** - `src/core/orchestrator-state.ts:72-74` (Confidence: 60%) -- The state directory is hardcoded to `~/.autobeat/orchestrator-state`. Other file-based state in the project uses the configuration system (`Configuration` interface). This function is not injectable/configurable.

- **Cleanup uses dynamic SQL with string interpolation** - `src/implementations/orchestration-repository.ts:269-270` (Confidence: 72%) -- `cleanupOldOrchestrations` builds a `DELETE ... WHERE id IN (${placeholders})` query dynamically. While `placeholders` are `?` and values come from the DB (not user input), the pattern diverges from the project's prepared-statement convention.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 3 | 1 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Architecture Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

### What Was Done Well

- **Typed deps objects refactoring**: Converting all existing handlers, services, the worker pool, recovery manager, and MCP adapter from positional constructor parameters to typed deps interfaces is excellent. This significantly improves readability and makes constructor calls self-documenting. The consistency across `TaskManagerServiceDeps`, `RecoveryManagerDeps`, `EventDrivenWorkerPoolDeps`, `MCPAdapterDeps`, `LoopHandlerDeps`, `ScheduleHandlerDeps`, `CheckpointHandlerDeps`, `DependencyHandlerDeps`, and `WorkerHandlerDeps` is commendable.

- **Layer boundary adherence**: The new orchestration feature follows the established layered architecture correctly: domain types in `core/domain.ts`, interfaces in `core/interfaces.ts`, events in `core/events/events.ts`, repository in `implementations/`, service in `services/`, handler in `services/handlers/`, and adapters in `adapters/`. No domain-to-infrastructure dependency violations were found.

- **Composition over inheritance**: `OrchestrationManagerService` composes with `LoopService` rather than extending it. The orchestrator is built on top of the loop system via the service interface, maintaining clean composition and loose coupling.

- **Event-driven consistency**: The orchestration lifecycle follows the established event-driven pattern -- `OrchestrationCreated`, `OrchestrationCompleted`, `OrchestrationCancelled` events, with `OrchestrationHandler` reacting to `LoopCompleted`/`LoopCancelled` events for status correlation. Transactions are used for atomic status updates.

- **Shared detach helpers extraction**: The extraction of `detach-helpers.ts` from `run.ts` eliminates duplication between the `run` and `orchestrate` CLI commands. The shared `pollLogFileForId`, `spawnDetachedProcess`, `createDetachLogDir`, and `createDetachLogFile` functions are well-parameterized.

- **Immutable domain objects**: `createOrchestration()` and `updateOrchestration()` follow the established `Object.freeze()` pattern from `createLoop()`/`updateLoop()`.

- **Zod boundary validation**: State file reading uses `OrchestratorStateFileSchema`, the repository uses `OrchestrationRowSchema`, and the MCP adapter uses Zod schemas for all orchestrator tool inputs. This follows the project's "parse, don't validate" principle.

- **Self-review and fix iteration**: The branch shows a healthy commit pattern -- initial implementation, self-review, targeted fix commits addressing specific issues (Zod validation, CI test inclusion, prompt limit, cleanup order, detach helper extraction, deps object refactoring). This demonstrates good engineering discipline.

### Resolved Since Original Review

The following issues from the original review (pre-fix commits) have been addressed:
1. PLANNING-state cancellation now updates DB directly (commit c06fb38)
2. Zod schema validation added to `readStateFile` (commit 7060d27)
3. `test:orchestration` added to `test:all` (commit 527cd4b)
4. `findByStatus` now accepts `offset` parameter (commit c06fb38)
5. MCPAdapter refactored to use `MCPAdapterDeps` interface (commit ffaad91)
6. Prompt limit removed entirely instead of raised to 16000 (commit 7cdc92c)

### Remaining Blocking Issues

1. **OrchestrationHandler positional params** -- The one handler that was not refactored to the deps object pattern, even though all sibling handlers were.
2. **Silent subscription failure** -- `OrchestrationHandler.create()` returns success even if event subscriptions fail, unlike all other handlers.
3. **Shared exit condition script path** -- Concurrent orchestrations overwrite each other's `check-complete.js` script.
