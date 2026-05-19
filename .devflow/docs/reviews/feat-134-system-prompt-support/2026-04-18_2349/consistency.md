# Consistency Review Report

**Branch**: feat/134-system-prompt-support -> main
**Date**: 2026-04-18

## Issues in Your Changes (BLOCKING)

### HIGH

**`createPipeline()` does not thread `systemPrompt` to per-step schedules** - `src/services/schedule-manager.ts:363-371`
**Confidence**: 90%
- Problem: `createPipeline()` passes `priority`, `workingDirectory`, `agent`, and `model` from the shared request to each step's `createSchedule()` call, but does not pass `systemPrompt`. However, `PipelineCreateRequest` (domain.ts:452) does not include `systemPrompt` at all, so this is actually a gap in the domain type, not the service. Meanwhile, `ScheduledPipelineCreateRequest` (domain.ts:479) does include `systemPrompt` and `createScheduledPipeline()` correctly threads it into `taskTemplate`. This creates a silent asymmetry: scheduled pipelines support systemPrompt, but immediate pipelines do not.
- Fix: Either add `systemPrompt?: string` to `PipelineCreateRequest` and `PipelineStepRequest` and thread it through `createPipeline()`, or document this as an intentional omission with a DECISION comment. The fact that `model` was added to both `PipelineCreateRequest` and `PipelineStepRequest` in a prior version but `systemPrompt` was not suggests this may be an oversight.

```typescript
// In PipelineCreateRequest (domain.ts:452):
export interface PipelineCreateRequest {
  readonly steps: readonly PipelineStepRequest[];
  readonly priority?: Priority;
  readonly workingDirectory?: string;
  readonly agent?: AgentProvider;
  readonly model?: string;
  readonly systemPrompt?: string; // ADD: shared default for all steps
}

// In createPipeline() (schedule-manager.ts:363):
const result = await this.createSchedule({
  prompt: step.prompt,
  scheduleType: ScheduleType.ONE_TIME,
  scheduledAt,
  priority: step.priority ?? request.priority,
  workingDirectory: step.workingDirectory ?? request.workingDirectory,
  afterScheduleId: previousScheduleId,
  agent: step.agent ?? request.agent,
  model: step.model ?? request.model,
  systemPrompt: request.systemPrompt, // ADD: thread through
});
```

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

_No critical pre-existing consistency issues found in reviewed files._

## Suggestions (Lower Confidence)

- **Mixed test naming convention** - `tests/unit/services/orchestration-manager.test.ts:187-242` (Confidence: 65%) -- The new `systemPrompt handling` describe block uses verb-first naming (`'uses ...'`, `'does not ...'`, `'treats ...'`) while most tests in this file use `'should ...'`. However, line 346 already uses verb-first (`'emits ...'`), so there is precedent within this same file. This is a stylistic observation, not a violation.

- **`result!` non-null assertion in test** - `tests/unit/implementations/agent-adapters.test.ts:980` (Confidence: 70%) -- The refactored GeminiAdapter test uses `result!.ok` with a non-null assertion. While `result` is always assigned in the try block (it's returned synchronously), the TypeScript compiler does not narrow `let` variables through try/finally boundaries. The `!` is technically necessary but could be replaced by moving the assertion inside the try block.

- **`operationalContract` duplicates content from `systemPrompt`** - `src/services/orchestrator-prompt.ts:141-159` (Confidence: 60%) -- The `operationalContract` duplicates several lines from the `systemPrompt` (state file path, working directory, beat CLI commands, constraints). If either is updated, the other must be updated in lockstep. Consider extracting shared sections into template variables referenced by both.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | - | 0 | 0 |

**Consistency Score**: 8/10
**Recommendation**: CHANGES_REQUESTED

### Notes

The system prompt feature demonstrates strong consistency overall across the 13 changed files:

1. **Error handling**: New code consistently uses the `Result<T>` pattern with `ok`/`err` returns, matching the codebase convention.
2. **Zod schemas**: `systemPrompt: z.string().optional()` added to both `TaskRequestSchema` and `LoopConfigSchema` in schedule-repository.ts, with proper `satisfies` guard on LoopConfigSchema.
3. **Logging pattern**: The new `try/catch` in `cleanupWorkerState` uses `this.logger.warn()` with structured context (`{ taskId, error }`) matching the existing convention (e.g., heartbeat handler at line 376).
4. **DECISION comments**: The comment at `orchestration-manager.ts:223` uses the `DECISION:` prefix, matching the project convention.
5. **Path-traversal guard**: The guard in `gemini-adapter.ts:68-69` reuses the `path.resolve() + startsWith()` pattern established in `orchestration-manager.ts:137-139`.
6. **Test patterns**: New tests follow the established structure of paired positive/negative assertions (e.g., "should thread X when provided" / "should leave X undefined when not provided"), matching the `model` threading tests already in the same files.
7. **Mock interface**: `cleanup: vi.fn()` added to mock adapter in `agent-registry.test.ts:19`, keeping mock in sync with the `AgentAdapter` interface.

The one blocking issue is the asymmetry between `createPipeline` (immediate) and `createScheduledPipeline` (scheduled) in systemPrompt support, which creates a gap where users of the MCP `CreatePipeline` tool cannot pass system prompts while `SchedulePipeline` users can.
