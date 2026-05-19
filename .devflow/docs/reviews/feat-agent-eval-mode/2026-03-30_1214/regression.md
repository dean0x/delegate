# Regression Review Report

**Branch**: feat/agent-eval-mode -> main
**Date**: 2026-03-30T12:14

## Issues in Your Changes (BLOCKING)

### HIGH

**MCP JSON Schema for CreateLoop still requires `exitCondition`** - `src/adapters/mcp-adapter.ts:1043`
**Confidence**: 95%
- Problem: The manually-defined JSON Schema for the `CreateLoop` MCP tool lists `required: ['strategy', 'exitCondition']` (line 1043). However, the corresponding Zod schema (`CreateLoopSchema`) at line 237 makes `exitCondition` optional (`.optional()`). This means an MCP client using agent eval mode (which does not need `exitCondition`) will have its request rejected by the JSON Schema validation before the Zod schema even runs. The Zod schema and the JSON Schema are inconsistent -- one says `exitCondition` is required, the other says it is optional.
- Fix: Change `required: ['strategy', 'exitCondition']` to `required: ['strategy']` at line 1043, matching the Zod schema behavior where `exitCondition` is optional and validated conditionally by `LoopManagerService`.

**MCP JSON Schema for ScheduleLoop still requires `exitCondition`** - `src/adapters/mcp-adapter.ts:1180`
**Confidence**: 95%
- Problem: Same issue as above but for the `ScheduleLoop` tool. Line 1180 has `required: ['strategy', 'exitCondition', 'scheduleType']`, but the Zod `ScheduleLoopSchema` at line 311 makes `exitCondition` optional. An agent-mode scheduled loop will fail at JSON Schema validation.
- Fix: Change to `required: ['strategy', 'scheduleType']` at line 1180.

**MCP JSON Schema for CreateLoop missing `evalMode`, `evalPrompt` properties** - `src/adapters/mcp-adapter.ts:966-1044`
**Confidence**: 92%
- Problem: The Zod-based `CreateLoopSchema` (lines 237-262) defines `evalMode` and `evalPrompt` fields, and the `callTool` handler at line 2180 passes them through. But the manually-defined JSON Schema returned by `listTools()` (lines 966-1044) does not include `evalMode` or `evalPrompt` in its `properties` object. MCP clients that rely on the tool schema for auto-discovery will not know these fields exist. This is an incomplete migration -- the Zod schema was updated, the handler was updated, but the JSON Schema was not.
- Fix: Add `evalMode` and `evalPrompt` properties to the JSON Schema `properties` block, and update the description for `exitCondition` to note it is required only for shell eval mode.

**MCP JSON Schema for ScheduleLoop missing `evalMode`, `evalPrompt` properties** - `src/adapters/mcp-adapter.ts:1146-1181`
**Confidence**: 92%
- Problem: Same as above for `ScheduleLoop`. The Zod `ScheduleLoopSchema` includes `evalMode` and `evalPrompt`, and the handler at line 2511 passes them, but the JSON Schema at lines 1146-1181 does not list these properties.
- Fix: Add `evalMode` and `evalPrompt` to the `ScheduleLoop` JSON Schema properties.

### MEDIUM

**`schedule-manager.ts` validation unconditionally requires `exitCondition` for scheduled loops** - `src/services/schedule-manager.ts:485`
**Confidence**: 90%
- Problem: `createScheduledLoop()` at line 485 validates `if (!request.loopConfig.exitCondition || request.loopConfig.exitCondition.trim().length === 0)` and returns an error. This validation does not account for agent eval mode, where `exitCondition` is intentionally empty/absent. A scheduled loop with `evalMode: 'agent'` will be rejected by this validation.
- Fix: Guard the validation with `if (evalMode !== 'agent')`:
```typescript
const evalMode = request.loopConfig.evalMode ?? 'shell';
if (evalMode === 'shell') {
  if (!request.loopConfig.exitCondition || request.loopConfig.exitCondition.trim().length === 0) {
    return err(
      new AutobeatError(ErrorCode.INVALID_INPUT, 'loopConfig.exitCondition is required for shell eval mode', {
        field: 'loopConfig.exitCondition',
      }),
    );
  }
}
```

**Schedule CLI `ParsedLoopConfig` interface missing `evalMode` and `evalPrompt`** - `src/cli/commands/schedule.ts:32-44`
**Confidence**: 88%
- Problem: The `ParsedLoopConfig` interface in schedule.ts does not include `evalMode` or `evalPrompt` fields. The schedule CLI loop creation path has no support for `--eval-mode agent` -- it will always create shell-mode loops. While this may be intentional (agent eval mode via CLI schedule is not supported yet), the interface divergence means `ParsedLoopConfig` is out of sync with the domain's `LoopCreateRequest`.
- Fix: Add `evalMode?: 'shell' | 'agent'` and `evalPrompt?: string` to `ParsedLoopConfig`, and add `--eval-mode` / `--eval-prompt` CLI flag parsing in `parseScheduleLoopFlags()`. If this is intentionally deferred, add a comment documenting the gap.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`loop.ts` CLI status display always shows `Exit Cond` label for shell mode** - `src/cli/commands/loop.ts:469`
**Confidence**: 82%
- Problem: In the loop status display (line 469), the code shows `Exit Cond: ${loop.exitCondition}` when `evalMode === 'shell'`. For shell-mode loops this is correct, but the exit condition value is the raw shell command which could be very long. The new agent-mode display logic at lines 468-473 is well-handled, but the truncation applied to `evalPrompt` via `truncatePrompt()` is not applied to `exitCondition`. This is a minor inconsistency introduced by proximity to the changes.
- Fix: Consider applying `truncatePrompt()` to `exitCondition` as well, or leave as-is since shell exit conditions are typically short commands. This is a minor polish item.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`ShellExitConditionEvaluator` will execute empty `exitCondition` string** - `src/services/exit-condition-evaluator.ts:31`
**Confidence**: 85%
- Problem: If a bug in the composite routing allows an agent-mode loop to reach `ShellExitConditionEvaluator`, it will call `execAsync(loop.exitCondition, ...)` with an empty string. On most systems, `exec('')` will succeed silently (exit code 0), causing a false `passed: true` result. The `CompositeExitConditionEvaluator` routing prevents this, but there is no defensive guard in the shell evaluator itself.
- Fix: Add an empty-string guard at the top of `ShellExitConditionEvaluator.evaluate()`:
```typescript
if (!loop.exitCondition || loop.exitCondition.trim().length === 0) {
  return { passed: false, error: 'No exit condition specified for shell evaluation' };
}
```

## Suggestions (Lower Confidence)

- **`LoopRowSchema` relaxed validation on `exit_condition`** - `src/implementations/loop-repository.ts:38` (Confidence: 72%) -- Changed from `z.string().min(1)` to `z.string()`, removing minimum length constraint. This is correct for agent mode (empty string), but means invalid data in the DB for shell-mode loops would no longer be caught at the repository layer.

- **Orchestration manager always uses shell eval mode** - `src/services/orchestration-manager.ts:154` (Confidence: 65%) -- The orchestrator creates loops with `exitCondition` but no `evalMode` field. This works because `evalMode` defaults to `'shell'`, but if the default ever changed it would break orchestrator mode. Consider adding explicit `evalMode: 'shell'`.

- **Schedule executor may not pass `evalMode`/`evalPrompt` from loopConfig to createLoop** - `src/services/schedule-executor.ts` (Confidence: 68%) -- The schedule executor reads `loopConfig` from the schedule record and passes it to `loopService.createLoop()`. If `evalMode`/`evalPrompt` fields are stored in the schedule's `loopConfig` JSON but the executor does not forward them, agent-mode scheduled loops would silently fall back to shell mode.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 4 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Regression Score**: 4/10
**Recommendation**: CHANGES_REQUESTED

The primary regression risk is the incomplete migration across the two-schema system (Zod validation schema vs. JSON Schema for MCP tool discovery). The Zod schemas and handler code were updated to support optional `exitCondition` and new `evalMode`/`evalPrompt` fields, but the manually-defined JSON Schemas in `listTools()` were not updated -- they still require `exitCondition` and do not expose the new fields. Additionally, `schedule-manager.ts` validation blocks agent-mode scheduled loops. These issues will prevent agent eval mode from working through the MCP interface and scheduled loop paths.
