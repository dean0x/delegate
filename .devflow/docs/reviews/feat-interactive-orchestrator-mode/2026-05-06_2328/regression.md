# Regression Review Report

**Branch**: feat-interactive-orchestrator-mode -> main
**Date**: 2026-05-06

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`ScaffoldResult.exitConditionScript` type change may cause runtime crash in existing `orchestrator-scaffold.test.ts`** - `src/core/orchestrator-scaffold.ts:38`
**Confidence**: 82%
- Problem: `exitConditionScript` and `suggestedExitCondition` are now `string | undefined` in `ScaffoldResult`. The existing test at `tests/unit/core/orchestrator-scaffold.test.ts:81` calls `existsSync(result.value.exitConditionScript)` and `readFileSync(result.value.exitConditionScript, 'utf-8')` without a null guard. While these tests will still pass at runtime (they don't pass `template`, so the standard path runs and the fields are always defined), the type widening means future callers consuming `ScaffoldResult` may dereference `undefined`. TypeScript does not flag this because `existsSync` accepts `PathLike` which is broad enough, and `readFileSync` also accepts it -- but the semantics are fragile. Confirmed that `npm run typecheck` passes cleanly.
- Fix: This is a latent fragility, not a blocking runtime bug. The existing tests pass because the standard code path always sets these fields. If a future change causes the standard path to also omit them, the tests would crash with an unhelpful error. Consider adding `!` assertions in the test or adjusting the type to use a discriminated union by template type.

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **`handleOrchestrateInteractive` accesses `container.get` by string key without type safety** - `src/cli/commands/orchestrate.ts:695` (Confidence: 65%) -- The function calls `container.get<AgentRegistry>('agentRegistry')`, `container.get<EventBus>('eventBus')`, and `container.get<OrchestrationRepository>('orchestrationRepository')` using bare string keys. If these keys change in the container configuration, the failure will be a runtime error with no compile-time signal. This is consistent with existing patterns in the codebase, so not a regression per se, but the interactive flow introduces three new usages of this pattern.

- **`handleOrchestrateDetach` silently strips `--interactive`/`-i` from re-spawn args** - `src/cli/commands/orchestrate.ts:436` (Confidence: 70%) -- When `--interactive` appears alongside other flags in a `create` context, `handleOrchestrateDetach` strips it from the re-spawned child args. This is correct defensive behavior, but no user feedback is produced. An invocation like `beat orchestrate "goal" --interactive` correctly routes to `handleOrchestrateInteractive` (not detach), so the filter only matters if the parsing logic changes in the future.

- **MCP `InitCustomOrchestrator` tool does not expose the `template` parameter** - `src/adapters/mcp-adapter.ts:3370` (Confidence: 72%) -- The MCP tool calls `scaffoldCustomOrchestrator` without passing `template`, so MCP users cannot scaffold an interactive orchestrator. This may be intentional (interactive mode requires TTY, which MCP doesn't provide), but it means the MCP tool always returns `exitConditionScript` and `suggestedExitCondition` and never `suggestedCommand` for the interactive path.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | - |
| Should Fix | - | 0 | 1 | - |
| Pre-existing | - | - | 0 | 0 |

**Regression Score**: 9/10
**Recommendation**: APPROVED

## Regression Analysis

### No Lost Functionality

- No exports removed (`git diff main...HEAD | grep "^-export"` returned empty)
- No files deleted (`git diff main...HEAD --name-status | grep "^D"` returned empty)
- All existing CLI subcommands preserved: `create`, `status`, `list`, `cancel`, `init`
- The `handleOrchestrateInit` standard template path preserves exact prior output format (exit condition, loop command, instruction snippets)

### No Broken Behavior

- `ScaffoldResult.exitConditionScript` and `suggestedExitCondition` changed from `string` to `string | undefined` -- widened, not narrowed. All existing callers handle the standard path which always defines these fields.
- `BaseAgentAdapter.spawn()` was refactored to extract `resolveSpawnConfig()` as shared logic. The spawn method's behavior is identical: same config resolution chain (runtime -> auth -> model -> system prompt -> env), same `spawn()` call with `stdio: ['ignore', 'pipe', 'pipe']`. This is a mechanical extraction with no behavior change.
- Orchestration list output now includes `mode` column -- additive change, no existing output removed.
- Orchestration status output now conditionally includes `mode` -- additive, old fields unchanged.

### Intent vs Reality Match

- PR adds interactive orchestrator mode: CLI parsing, agent adapter `spawnInteractive`, orchestration manager `createInteractiveOrchestration`, cancel support, migration v25, scaffold template, liveness check -- all present and tested.
- 814 lines of tests cover all new code paths with regression guards for the standard template path.

### Migration Completeness

- New `spawnInteractive` method added to `AgentAdapter` interface in `agents.ts`
- All three concrete adapters implement it: `ClaudeAdapter`, `CodexAdapter`, `GeminiAdapter`
- `ProcessSpawnerAdapter` returns `err(INVALID_OPERATION)` -- correct for a test-only compatibility shim
- `BaseAgentAdapter` provides the shared implementation -- all subclasses covered
- Migration v25 adds `mode` and `pid` columns with NULL defaults -- backward compatible with all existing rows
- `OrchestrationRowSchema` updated with `.nullable().optional()` for both new fields
- `toRow` and `rowToOrchestration` handle the new fields with proper null coalescing

### Backward Compatibility Confirmed

- `scaffoldCustomOrchestrator({ goal: 'X' })` (no template) still produces the standard scaffold with `exitConditionScript` and `suggestedExitCondition` defined -- verified by test at line 757-764
- `createOrchestration` (non-interactive) flow is unchanged -- no `mode` or `pid` set, loop-based lifecycle preserved
- `checkOrchestrationLiveness` falls through to the existing loop-based check when `mode !== 'interactive'`
- `cancelOrchestration` falls through to the existing loop cancel path when `mode !== 'interactive'`
