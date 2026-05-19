# Testing Review Report

**Branch**: feat/134-system-prompt-support -> main
**Date**: 2026-04-20

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Missing service-level test for `createPipeline` systemPrompt fallback logic** - `src/services/schedule-manager.ts:372`
**Confidence**: 85%
- Problem: The new line `systemPrompt: step.systemPrompt ?? request.systemPrompt` implements fallback logic where a per-step systemPrompt takes precedence over the shared pipeline-level systemPrompt. This is the only place in the entire `createPipeline` flow where the `??` fallback occurs for systemPrompt, yet there is no service-level test in `schedule-manager.test.ts` for this behavior. The MCP adapter test verifies the MCP layer passes the field through to the service, but does not verify the service correctly applies the fallback when creating chained schedules. Other analogous fields (priority, workingDirectory, model) all have dedicated per-step override + shared default tests in the `createPipeline()` describe block (lines 724-838). systemPrompt is the only one missing.
- Fix: Add two tests to the `createPipeline()` describe block in `tests/unit/services/schedule-manager.test.ts`:
  ```typescript
  it('should thread shared systemPrompt to all steps as default', async () => {
    const result = await service.createPipeline(pipelineRequest({ systemPrompt: 'Be concise' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const events = eventBus.getEmittedEvents('ScheduleCreated');
    expect(events[0].schedule.taskTemplate.systemPrompt).toBe('Be concise');
    expect(events[1].schedule.taskTemplate.systemPrompt).toBe('Be concise');
  });

  it('should allow per-step systemPrompt override', async () => {
    const result = await service.createPipeline({
      steps: [{ prompt: 'Step one', systemPrompt: 'Step-specific' }, { prompt: 'Step two' }],
      systemPrompt: 'Shared default',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const events = eventBus.getEmittedEvents('ScheduleCreated');
    expect(events[0].schedule.taskTemplate.systemPrompt).toBe('Step-specific');
    expect(events[1].schedule.taskTemplate.systemPrompt).toBe('Shared default');
  });
  ```

## Issues in Code You Touched (Should Fix)

No issues found.

## Pre-existing Issues (Not Blocking)

No issues found.

## Suggestions (Lower Confidence)

- **ScheduleTask/ScheduleLoop MCP adapter tests do not verify systemPrompt passthrough** - `tests/unit/adapters/mcp-adapter.test.ts` (Confidence: 65%) -- The ScheduleTask and ScheduleLoop tool handlers in the MCP adapter accept `systemPrompt` via Zod schema, but the existing adapter-level tests for these tools do not exercise systemPrompt passthrough to the mock service. The service-level tests in `schedule-manager.test.ts` do cover this, so the gap is at the adapter integration boundary only.

- **Gemini fallback test no longer uses try/finally for consoleSpy restore** - `tests/unit/implementations/agent-adapters.test.ts:940-941` (Confidence: 62%) -- The refactored Gemini "without base cache" test now calls `consoleSpy.mockRestore()` inline rather than in a `finally` block. If `adapter.spawn()` throws unexpectedly, the spy would leak into subsequent tests. The risk is low because spawn returns Result (never throws), but the prior code was more defensive.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Testing Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The test suite is strong overall. The new system prompt feature is well-covered across all three agent adapters (Claude, Codex, Gemini) with both positive and negative/regression-guard tests. The GeminiBasePromptCache has thorough unit tests including path traversal, cache hit/miss, invalidation, staleness, and size guard scenarios. The worker pool cleanup delegation tests properly verify the new closure-based pattern including the edge case of post-dispose registry. The orchestrator prompt tests verify both default and custom systemPrompt flows including the operational contract injection. The MCP adapter tests verify CreatePipeline systemPrompt passthrough for both shared and per-step levels. The one gap is the service-level `createPipeline` fallback test, which should be added before merge to match the coverage pattern of other per-step override fields.
