# TypeScript Review Report

**Branch**: feat/134-system-prompt-support -> main
**Date**: 2026-04-20

## Issues in Your Changes (BLOCKING)

### MEDIUM

**`buildFinalPrompts` parameter `agent` typed as `string` instead of `AgentProvider`** - `src/services/orchestration-manager.ts:305`
**Confidence**: 85%
- Problem: The new private method `buildFinalPrompts` declares its `agent` parameter as `string`, but the caller always passes a value of type `AgentProvider` (from `resolveDefaultAgent`), and the downstream `OrchestratorPromptParams.agent` field is also `string | undefined`. While this works at runtime (AgentProvider is a subtype of string), it loses the narrowed type information. If a future caller passes an arbitrary string, the compiler will not flag it.
- Fix: Change the parameter type to `AgentProvider`:
  ```typescript
  private buildFinalPrompts(
    request: OrchestratorCreateRequest,
    orchestration: Orchestration,
    stateFilePath: string,
    workingDirectory: string,
    agent: AgentProvider,  // was: string
  ): { finalSystemPrompt: string; finalUserPrompt: string } {
  ```
  This also requires importing `AgentProvider` if not already imported in this file (it likely is, since `resolveDefaultAgent` returns it).

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

_No issues found._

## Suggestions (Lower Confidence)

- **`setupAdapter` return type could use explicit generic constraint** - `tests/unit/implementations/agent-adapters.test.ts:68` (Confidence: 65%) -- The helper `setupAdapter<T extends { dispose(): void }>` is well-typed, but the `getAdapter` pattern returns `T` which is initialized in `beforeEach`. The `let adapter: T` variable is assigned inside the callback, so TypeScript cannot verify it is initialized before `getAdapter()` is called. In practice this is safe because test runners guarantee `beforeEach` runs before `it`, but a stricter pattern (e.g., using a wrapper object) would eliminate the definite-assignment gap entirely.

- **Removed `.max()` validators across all Zod schemas** - `src/adapters/mcp-adapter.ts` (multiple lines) (Confidence: 70%) -- Removing all `max()` constraints from string fields (prompt, systemPrompt, jsonSchema, goal, etc.) is intentional per the commit message, but from a TypeScript/Zod perspective this removes boundary validation entirely. If an MCP client sends a multi-megabyte string, nothing prevents it from reaching downstream code. This is a design choice rather than a bug -- the agents themselves enforce context window limits -- but worth noting.

- **`cleanupFn` closure captures adapter reference indefinitely** - `src/implementations/event-driven-worker-pool.ts:129` (Confidence: 60%) -- The closure `(taskId: string) => adapter.cleanup(taskId)` captures the adapter reference at spawn time. This is intentional (the whole point is to survive registry disposal), but it means the adapter instance cannot be GC'd until the worker completes. For long-running workers with large adapter state, this could retain memory. Given that adapters are lightweight in this codebase, this is unlikely to matter in practice.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**TypeScript Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The TypeScript changes are well-structured. The `buildFinalPrompts` extraction is a clean refactor with proper return type annotation. The `cleanupFn` closure pattern on `WorkerState` is a good improvement over the previous runtime registry lookup -- it eliminates the silent `?? 'claude'` fallback and survives registry disposal. Domain types (`PipelineStepRequest`, `PipelineCreateRequest`) are correctly extended with `readonly systemPrompt?: string`. The one actionable item is the `agent: string` widening in `buildFinalPrompts` which should use `AgentProvider` for type safety consistency.
