# Regression Review Report

**Branch**: feat/134-system-prompt-support -> main
**Date**: 2026-04-18
**Diff**: `git diff abbd413...HEAD` (13 files, +565/-22 lines)

## Issues in Your Changes (BLOCKING)

_No blocking regression issues found._

## Issues in Code You Touched (Should Fix)

_No should-fix regression issues found._

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`createPipeline()` does not thread `systemPrompt` to step schedules** - `src/services/schedule-manager.ts:361-372`
**Confidence**: 65%
- Problem: `createPipeline()` calls `this.createSchedule()` for each pipeline step but does not pass `systemPrompt`. The `PipelineCreateRequest` and `PipelineStepRequest` types also lack a `systemPrompt` field. This means non-scheduled pipelines (`CreatePipeline` MCP tool / `beat pipeline` CLI) cannot inject system prompts, while `ScheduledPipelineCreateRequest` and `ScheduleCreateRequest` can.
- Impact: Users creating non-scheduled pipelines have no way to set a system prompt on pipeline steps. This is a design gap, not a regression introduced by this PR -- the types never had the field. Noting for completeness since this PR extends `systemPrompt` to schedules and loops but not to non-scheduled pipelines.
- Fix: Add `systemPrompt?: string` to `PipelineCreateRequest`, `PipelineStepRequest`, and thread it in `createPipeline()`. Consider in a follow-up PR.

## Suggestions (Lower Confidence)

_No suggestions._

## Regression Checklist

- [x] No exports removed without deprecation
- [x] Return types backward compatible (`buildOrchestratorPrompt` return type expanded from `{ systemPrompt, userPrompt }` to `{ systemPrompt, userPrompt, operationalContract }` -- additive, not breaking; sole caller updated in same PR)
- [x] Default values unchanged (no behavioral changes to existing flows without `systemPrompt`)
- [x] Side effects preserved (events, logging unchanged; cleanup try/catch is additive safety)
- [x] All consumers of changed code updated (single caller of `buildOrchestratorPrompt` updated; `AgentAdapter.cleanup()` implemented by all adapters)
- [x] Migration complete across codebase (Zod schemas in `schedule-repository.ts` updated for both `TaskRequestSchema` and `LoopConfigSchema`)
- [x] CLI options preserved
- [x] API endpoints preserved
- [x] Commit message matches implementation
- [x] No deleted files

## Detailed Analysis

### 1. Lost Functionality -- NONE

No exports removed. No files deleted. No CLI options removed. No event handlers removed. All existing interfaces expanded additively (new optional fields only).

### 2. Broken Behavior -- NONE

**`buildOrchestratorPrompt` return type expansion**: The return type was `{ systemPrompt, userPrompt }` and is now `{ systemPrompt, userPrompt, operationalContract }`. This is strictly additive. The sole caller in `orchestration-manager.ts` destructures the new field. No other callers exist in the codebase.

**`mkdirSync` hoisted to constructor**: In `GeminiBasePromptCache`, `mkdirSync(this.#cacheDir, { recursive: true, mode: 0o700 })` was moved from `buildCombinedFile()` to the constructor. This is a timing change (directory created at adapter construction vs. first use) but is safe because `{ recursive: true }` is idempotent and the adapter is long-lived. This is actually an improvement -- avoids redundant mkdir calls on every `buildCombinedFile()` invocation.

**`cleanup()` try/catch wrapping**: In `event-driven-worker-pool.ts`, the call to `agentResult.value.cleanup(taskId)` is now wrapped in a try/catch. Before this change, a throwing `cleanup()` would propagate up through `cleanupWorkerState()` into `handleWorkerCompletion()` or `kill()`, potentially breaking worker lifecycle. The try/catch makes cleanup truly best-effort, which is the documented intent. This is a bug fix, not a regression.

**Orchestrator custom systemPrompt flow**: When `request.systemPrompt` is provided to `createOrchestration()`, the code now:
1. Uses the user-provided prompt instead of the auto-generated one (`finalSystemPrompt`)
2. Injects `operationalContract` into the user prompt so the agent retains operational knowledge

The fallback (no `systemPrompt` or whitespace-only) preserves the existing behavior exactly -- `hasCustomSystemPrompt` is `false`, so `orchestratorSystemPrompt` is used and `operationalContract` is not injected. The empty-string guard (`Boolean(request.systemPrompt?.trim())`) correctly treats whitespace-only as absent.

### 3. Intent vs Reality Mismatch -- NONE

The PR implements system prompt support for tasks, loops, schedules, and orchestrators. The diff shows:
- Schedule repository Zod schemas updated for `systemPrompt` in both `TaskRequestSchema` and `LoopConfigSchema`
- Schedule manager threads `systemPrompt` through `createSchedule()`, `createScheduledPipeline()`, and `createScheduledLoop()`
- Orchestration manager handles custom vs. auto-generated systemPrompt with operational contract injection
- Worker pool delegates cleanup to adapters with path-traversal protection and best-effort error handling
- All changes have corresponding test coverage (regression guards, round-trip tests, traversal tests, cleanup delegation tests)

### 4. Incomplete Migrations -- NONE (in scope)

All consumers of the changed APIs have been updated:
- `buildOrchestratorPrompt` -- sole caller updated
- `AgentAdapter.cleanup()` -- all adapter implementations provide it (base class has no-op default, `GeminiAdapter` overrides, `ProcessSpawnerAdapter` has no-op)
- Zod schemas -- both `TaskRequestSchema` and `LoopConfigSchema` include `systemPrompt`
- Mock adapters in tests -- `agent-registry.test.ts` mock updated with `cleanup: vi.fn()`

The `PipelineCreateRequest` gap is pre-existing and outside this PR's scope.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | - | 1 | 0 |

**Regression Score**: 9/10
**Recommendation**: APPROVED
