# Architecture Review Report

**Branch**: feat/134-system-prompt-support -> main
**Date**: 2026-04-20
**Diff**: `git diff aa69fa2007c5ece548f8916d27d86c19bd73126e...HEAD`

## Issues in Your Changes (BLOCKING)

### HIGH

**SchedulePipelineSchema missing per-step systemPrompt (API asymmetry)** - `src/adapters/mcp-adapter.ts:247`
**Confidence**: 90%
- Problem: `CreatePipelineSchema` (line 222) defines per-step `systemPrompt` and the `handleCreatePipeline` handler (line 2349) maps `s.systemPrompt` per step. However, `SchedulePipelineSchema` (line 244-287) has no per-step `systemPrompt` in its step objects, and `handleSchedulePipeline` (line 2403-2409) does not map `s.systemPrompt`. Both schemas share the same domain type `PipelineStepRequest` which includes `systemPrompt?: string`. This means per-step system prompt overrides work for `CreatePipeline` but silently fail for `SchedulePipeline`.
- Impact: Feature gap -- users who create scheduled pipelines cannot override system prompts per step, while non-scheduled pipeline users can. The domain type supports it, the Zod schema does not. This is an OCP/consistency violation where two API surfaces for the same feature behave differently.
- Fix: Add `systemPrompt: z.string().optional().describe('System prompt override for this step')` to the step object in `SchedulePipelineSchema`, and add `systemPrompt: s.systemPrompt` to the step mapping in `handleSchedulePipeline` at line 2409. Also add `systemPrompt` to the JSON schema step properties block at line 1078-1105.

```typescript
// SchedulePipelineSchema step object (line ~247-253):
z.object({
  prompt: z.string().min(1).describe('Task prompt for this step'),
  priority: z.enum(['P0', 'P1', 'P2']).optional().describe('Priority override for this step'),
  workingDirectory: z.string().optional().describe('Working directory override (absolute path)'),
  agent: z.enum(AGENT_PROVIDERS_TUPLE).optional().describe('Agent override for this step'),
  model: z.string().min(1).max(200).optional().describe('Model override for this step'),
  systemPrompt: z.string().optional().describe('System prompt override for this step'), // ADD
})

// handleSchedulePipeline step mapping (line ~2403-2409):
steps: data.steps.map((s) => ({
  prompt: s.prompt,
  priority: s.priority as Priority | undefined,
  workingDirectory: s.workingDirectory,
  agent: s.agent as AgentProvider | undefined,
  model: s.model ?? data.model,
  systemPrompt: s.systemPrompt, // ADD
})),
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Removal of all text length limits from Zod schemas is an unbounded-input risk** - `src/adapters/mcp-adapter.ts:49,104,112,141,146,219,248,291,342,404,443,452`
**Confidence**: 82%
- Problem: This PR removes `.max()` constraints from every text field: prompt (was 4000), systemPrompt (was 16000), goal (was 8000), exitCondition (was 4000), evalPrompt (was 8000), judgePrompt (was 8000), additionalContext (was 4000), and jsonSchema (was 16000). The commit message `refactor: remove arbitrary text length limits from MCP schemas` frames these as "arbitrary", but they served as a defense-in-depth boundary against memory exhaustion or excessively large prompts being passed to child processes.
- Impact: Without any upper bound, a caller can now submit a multi-megabyte string through the MCP protocol. While the downstream agent CLIs will ultimately constrain input, the Autobeat process itself will buffer the full string in memory during Zod parsing, event emission, SQLite persistence, and prompt building. This is a shallow-module concern (the boundary validates less than it should).
- Fix: Consider reintroducing generous-but-finite limits. If the prior limits were too restrictive, raise them (e.g., prompt to 64000, systemPrompt to 128000) rather than removing entirely. Alternatively, add a single shared constant like `MAX_TEXT_INPUT = 256_000` applied uniformly.

## Pre-existing Issues (Not Blocking)

_No critical pre-existing architecture issues identified in files reviewed._

## Suggestions (Lower Confidence)

- **`buildFinalPrompts` could accept a narrower parameter type** - `src/services/orchestration-manager.ts:300` (Confidence: 70%) -- The private method accepts `OrchestratorCreateRequest` and `Orchestration` objects but only reads `.systemPrompt`, `.goal`, `.maxDepth`, `.maxWorkers`, and `.model` from them. A narrower parameter signature (e.g., a pick type or explicit fields) would better document intent and reduce coupling to the full domain types. This is minor since the method is private and co-located with its only caller.

- **Shared fragments in orchestrator-prompt.ts partially duplicate** - `src/services/orchestrator-prompt.ts:60-74` (Confidence: 65%) -- The refactoring to shared fragments (`stateFileSection`, `delegationSection`, etc.) reduces drift between systemPrompt and operationalContract, which is a good improvement. However, the `delegationSection` fragment and the `WORKER MANAGEMENT` section in the full systemPrompt are not identical (the full version includes extra lines about detaching, database sharing, and loop management). The fragments only cover a subset of the operational knowledge. If the intent was DRY, it was partially applied.

- **`cleanupFn` closure captures adapter reference indefinitely** - `src/implementations/event-driven-worker-pool.ts:129` (Confidence: 62%) -- The cleanup closure `(taskId: string) => adapter.cleanup(taskId)` captures a reference to the adapter instance. If the adapter is disposed before the worker completes (e.g., during a graceful shutdown race), the closure calls `cleanup` on a disposed adapter. The prior code had the same risk (it looked up the adapter from the registry at cleanup time, with a `?? 'claude'` fallback). The new approach is architecturally cleaner (no registry lookup at cleanup), but the lifecycle concern remains unchanged.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 0 | - |
| Should Fix | - | 0 | 1 | - |
| Pre-existing | - | - | 0 | 0 |

**Architecture Score**: 8/10
**Recommendation**: CHANGES_REQUESTED

The overall architecture of the system prompt feature is well-designed: the cleanup closure pattern in `event-driven-worker-pool.ts` is a genuine improvement over the prior registry-lookup-at-cleanup approach; the `buildFinalPrompts` extraction in `orchestration-manager.ts` improves readability; and the shared fragment approach in `orchestrator-prompt.ts` reduces drift between the full system prompt and the operational contract. The one blocking issue is a straightforward API asymmetry between `CreatePipeline` and `SchedulePipeline` where per-step `systemPrompt` was added to the former but not the latter, despite both sharing the same domain type. The unbounded-input concern from removing all `.max()` limits is worth addressing but is not blocking.
