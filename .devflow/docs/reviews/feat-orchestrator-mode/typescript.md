# TypeScript Review Report

**Branch**: feat/orchestrator-mode -> main
**Date**: 2026-03-27
**PR**: #123
**Files Changed**: 51 files (+4206, -703)

## Issues in Your Changes (BLOCKING)

### HIGH

**Unsafe `as` cast: `status as OrchestratorStatus | undefined`** - `src/adapters/mcp-adapter.ts:2701`
**Confidence**: 88%
- Problem: The Zod schema `ListOrchestratorsSchema` validates `status` as `z.enum(['planning', 'running', 'completed', 'failed', 'cancelled']).optional()`. After Zod validation, the inferred type is `'planning' | 'running' | ... | undefined`. This is then cast with `as OrchestratorStatus | undefined`. While the string values currently match `OrchestratorStatus` enum values, this assertion bypasses the type system -- if a new enum value is added to `OrchestratorStatus` or a Zod enum value is changed, the compiler will not catch the mismatch. The `as AgentProvider | undefined` cast at line 2605 follows the same pre-existing pattern across 8 other call sites.
- Fix: Use `z.nativeEnum(OrchestratorStatus)` in the Zod schema so the inferred type is already `OrchestratorStatus | undefined`, eliminating the cast:
```typescript
const ListOrchestratorsSchema = z.object({
  status: z.nativeEnum(OrchestratorStatus).optional(),
  limit: z.number().min(1).max(100).optional().default(50),
  offset: z.number().min(0).optional().default(0),
});
```

**`OrchestrationHandler.create()` uses positional args while all other handlers use deps object** - `src/services/handlers/orchestration-handler.ts:38-43`
**Confidence**: 85%
- Problem: This PR refactors every handler constructor and factory method from positional parameters to a deps-object pattern: `CheckpointHandler`, `DependencyHandler`, `LoopHandler`, `ScheduleHandler`, `WorkerHandler`, `EventDrivenWorkerPool`, `TaskManagerService`, `RecoveryManager`, and `MCPAdapter`. The `OrchestrationHandler` is the only new handler that still uses 5 positional parameters in both its private constructor (line 25-31) and `create()` factory (line 38-43). This creates an inconsistency within the PR's own refactoring.
- Fix: Define an `OrchestrationHandlerDeps` interface and convert to the deps-object pattern:
```typescript
export interface OrchestrationHandlerDeps {
  readonly orchestrationRepo: SyncOrchestrationOperations;
  readonly loopRepo: SyncLoopOperations;
  readonly database: TransactionRunner;
  readonly eventBus: EventBus;
  readonly logger: Logger;
}

private constructor(deps: Omit<OrchestrationHandlerDeps, 'eventBus'>) {
  super(deps.logger, 'OrchestrationHandler');
  this.orchestrationRepo = deps.orchestrationRepo;
  this.loopRepo = deps.loopRepo;
  this.database = deps.database;
}

static async create(deps: OrchestrationHandlerDeps): Promise<Result<OrchestrationHandler>> {
  const handler = new OrchestrationHandler(deps);
  // ...subscriptions using deps.eventBus...
}
```

### MEDIUM

**`OrchestrationHandler.create()` returns `ok(handler)` even when event subscriptions fail** - `src/services/handlers/orchestration-handler.ts:48-63`
**Confidence**: 82%
- Problem: If `eventBus.subscribe` for `LoopCompleted` or `LoopCancelled` fails, the error is logged but `ok(handler)` is still returned. The handler would exist but silently miss all loop lifecycle events, causing orchestrations to remain stuck in `RUNNING` status forever. The `handler-setup.ts` at line 384-398 also treats `OrchestrationHandler` creation failure as non-fatal (logs a warning and continues), which compounds this: even a partial failure at event subscription time goes undetected.
- Fix: Return an error result if either subscription fails:
```typescript
if (!completedSub.ok) {
  return err(new AutobeatError(
    ErrorCode.SYSTEM_ERROR,
    `Failed to subscribe OrchestrationHandler to LoopCompleted: ${completedSub.error.message}`,
  ));
}
```

**`toRow` returns `Record<string, unknown>` -- loses type safety** - `src/implementations/orchestration-repository.ts:267-283`
**Confidence**: 80%
- Problem: The `toRow()` method returns `Record<string, unknown>`, which means any typo in a property name (e.g., `loopid` instead of `loopId`) would be silently passed to `better-sqlite3`. The SQL prepared statement uses named parameters (`@loopId`), so a misspelled key would bind as `NULL`, causing subtle data corruption rather than a compile error.
- Fix: Define a typed binding parameters interface:
```typescript
interface OrchestrationBindParams {
  readonly id: string;
  readonly goal: string;
  readonly loopId: string | null;
  readonly stateFilePath: string;
  readonly workingDirectory: string;
  readonly agent: string | null;
  readonly maxDepth: number;
  readonly maxWorkers: number;
  readonly maxIterations: number;
  readonly status: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt: number | null;
}

private toRow(orchestration: Orchestration): OrchestrationBindParams { ... }
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`as AgentProvider | undefined` cast repeated 8+ times across MCP adapter (1 new occurrence at line 2605)** - `src/adapters/mcp-adapter.ts:2605`
**Confidence**: 82%
- Problem: The Zod schema uses `z.enum(AGENT_PROVIDERS_TUPLE)` which yields a string literal union. This is then cast to `AgentProvider | undefined` at every handler call site. The cast is unnecessary if `AGENT_PROVIDERS_TUPLE` is properly `as const` typed so Zod infers the exact literal union assignable to `AgentProvider`. The new `CreateOrchestratorSchema` at line 199 adds one more instance. While this is a pre-existing pattern, the PR touches these files extensively and could fix the root cause.
- Fix: Ensure `AGENT_PROVIDERS_TUPLE` satisfies `readonly AgentProvider[]` so Zod's inferred type is already compatible. Alternatively, use `z.nativeEnum()` if `AgentProvider` is an enum.

**Prompt length validation removed without replacement constant** - `src/services/loop-manager.ts:44-54`
**Confidence**: 80%
- Problem: The `validateCreateRequest` method previously enforced a 4000-character prompt limit. This was removed to accommodate orchestrator prompts (which are longer). The MCP Zod schemas still enforce limits on user-facing inputs, but there is now no internal defense-in-depth limit. Any future code path that calls `loopService.createLoop()` with an unbounded prompt will succeed silently. This is a defense-in-depth concern rather than a current bug.
- Fix: Add an internal constant with a generous limit and document the rationale:
```typescript
/** Internal prompt limit. User-facing limits are enforced by MCP Zod schemas. */
const INTERNAL_PROMPT_LIMIT = 32000;
if (request.prompt && request.prompt.length > INTERNAL_PROMPT_LIMIT) {
  return err(new AutobeatError(ErrorCode.INVALID_INPUT, 'prompt exceeds internal limit', { ... }));
}
```

## Pre-existing Issues (Not Blocking)

### LOW

**`as OrchestrationRow | undefined` casts on `stmt.get()` results (6 occurrences)** - `src/implementations/orchestration-repository.ts`
**Confidence**: 85%
- Problem: The `better-sqlite3` `Statement.get()` returns `unknown`. The code casts to `OrchestrationRow | undefined`. This is the standard pattern across all repositories in the codebase. The Zod `OrchestrationRowSchema.parse(row)` in `rowToOrchestration` provides runtime validation immediately after, so the cast is safe in practice.
- Note: This is a codebase-wide convention, not a new concern. The `cleanupStmt.all(cutoff)` at line 207 also uses an assertion (`as Array<{ id: string; state_file_path: string }>`), but since this is a known query with a fixed schema, the risk is minimal.

## Suggestions (Lower Confidence)

- **Exhaustive switch in `handleOrchestrateCommand`** - `src/cli/commands/orchestrate.ts:500` (Confidence: 70%) -- The switch on `parsed.kind` covers all 4 variants but lacks a `default: const _: never = parsed; throw new Error(...)` exhaustiveness check. If a fifth `OrchestrateParsed` variant is added, the compiler would not flag the missing case.

- **`OrchestratorStateFile` status enum overlaps but diverges from `OrchestratorStatus`** - `src/core/orchestrator-state.ts:21` vs `src/core/domain.ts:663` (Confidence: 65%) -- The state file uses `'complete'` and `'executing'` while the domain enum uses `'completed'` and `'running'`. The distinction is intentional (state file is agent-facing, domain is system-facing) but the subtle naming difference (`complete` vs `completed`) may cause bugs in mapping logic.

- **`pollLogFileForId` regex capture group not validated** - `src/cli/detach-helpers.ts:124` (Confidence: 62%) -- `match[1]` is used without checking if the capture group exists. If the caller passes an `idPattern` regex without a capture group, `id` would be `undefined`, propagated as `{ type: 'found', id: undefined }` despite the `PollResult.id` being typed as `string`.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 0 | 1 |

**TypeScript Score**: 8/10
**Recommendation**: CHANGES_REQUESTED

### Rationale

The PR demonstrates strong TypeScript practices across the board:

**Positives:**
- Zero `any` types in all new code
- Consistent `readonly` on all interface fields and deps objects
- Proper branded types (`OrchestratorId`) with factory functions
- Immutable domain objects via `Object.freeze()`
- Zod validation at all I/O boundaries (MCP args, state file reads, DB row hydration)
- Well-designed discriminated unions for `PollResult` and `OrchestrateParsed`
- Consistent `Result<T, E>` pattern throughout new services
- Successful refactoring of 9 classes from positional args to deps-object pattern
- Proper type-only imports throughout

**Issues to address:**
1. The `as OrchestratorStatus` cast at MCP adapter line 2701 bypasses Zod's type inference -- `z.nativeEnum()` is the correct fix
2. `OrchestrationHandler` is the sole exception to the deps-object refactoring pattern applied to all other handlers
3. The silent success on failed event subscriptions could leave orchestrations stuck in running state
4. The `toRow()` returning `Record<string, unknown>` loses compile-time safety on SQL binding parameter names

Previous CRITICAL issue (cancel without loopId not updating DB) and HIGH issue (readStateFile lacking Zod validation) from the initial review have been resolved.
