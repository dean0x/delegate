# Code Review Summary

**Branch**: feat/134-system-prompt-support -> main
**Date**: 2026-04-20
**Reviewers**: 8 specialized agents (security, architecture, performance, complexity, consistency, regression, testing, typescript)

## Merge Recommendation: CHANGES_REQUESTED

The PR implements a well-designed system prompt feature across the full stack. However, **three blocking issues must be resolved before merge**:

1. **Unbounded string inputs on MCP schemas** (Security/Performance) — All `.max()` constraints removed with no replacement
2. **Empty-string systemPrompt semantic regression** (Consistency/Regression) — Uses `??` instead of `||`, breaking empty-string handling
3. **SchedulePipeline missing per-step systemPrompt** (Architecture/Consistency) — Feature gap between CreatePipeline and SchedulePipeline

---

## Issue Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW | Total |
|----------|----------|------|--------|-----|-------|
| **Blocking** | 0 | 4 | 2 | 0 | **6** |
| **Should Fix** | 0 | 0 | 2 | 0 | **2** |
| **Pre-existing** | 0 | 1 | 3 | 0 | **4** |

---

## Blocking Issues (Must Fix Before Merge)

### 🔴 CRITICAL: Unbounded String Inputs Risk DoS via Resource Exhaustion

**Confidence**: 85–90% (flagged by security, architecture, performance reviewers)

**Files**: `src/adapters/mcp-adapter.ts` (lines 49, 104, 112, 141, 146, 217–248, 291, 342, 347, 354, 404, 410, 443, 448, 455, 488)

**Problem**: This PR removes every `.max()` constraint from all user-facing MCP tool schemas without replacement:
- `prompt`: was `.max(4000)`, now unbounded (DelegateTask, ScheduleTask, CreateLoop, ScheduleLoop, SchedulePipeline)
- `additionalContext`: was `.max(4000)`, now unbounded (ResumeTask)
- `systemPrompt`: was `.max(16000)`, now unbounded (DelegateTask, ScheduleTask, SchedulePipeline, CreateOrchestrator, CreateLoop, ScheduleLoop)
- `jsonSchema`: was `.max(16000)`, now unbounded (DelegateTask)
- `goal`: was `.max(8000)`, now unbounded (CreateOrchestrator)
- `exitCondition`: was `.max(4000)`, now unbounded (CreateLoop, ScheduleLoop)
- `evalPrompt`: was `.max(8000)`, now unbounded (CreateLoop)
- `judgePrompt`: was `.max(8000)`, now unbounded (CreateLoop)

Additionally, the server-side validation in `orchestration-manager.ts:77-84` that rejected goals exceeding 8000 chars was removed.

**Impact**: An MCP client can now submit multi-megabyte strings through these fields. These strings flow into:
- CLI arguments passed to `spawn()` (OS limit ~256KB on macOS, ~2MB on Linux)
- SQLite persistence (TEXT columns degrade query perf when bloated)
- Memory during string concatenation (`buildOrchestratorPrompt` concatenates goal + context + system prompt)
- File I/O for Gemini combined prompts (only guarded at 64KB)

**Fix**: Reinstate reasonable upper bounds on all string fields. These can be generous but must exist:

```typescript
prompt: z.string().min(1).max(100_000),  // 100KB — practical for CLI args + memory
systemPrompt: z.string().max(100_000).optional(),
goal: z.string().min(1).max(100_000),
additionalContext: z.string().max(100_000).optional(),
jsonSchema: z.string().max(100_000).optional(),
exitCondition: z.string().max(100_000).optional(),
evalPrompt: z.string().max(100_000).optional(),
judgePrompt: z.string().max(100_000).optional(),
```

---

### 🔴 HIGH: Empty-String systemPrompt Becomes Empty Instead of Using Auto-Generated Prompt

**Confidence**: 92% (flagged by consistency and regression reviewers)

**File**: `src/services/orchestration-manager.ts:322`

**Problem**: `buildFinalPrompts` uses `customSystemPrompt ?? orchestratorSystemPrompt` (nullish coalescing) instead of the original truthiness check. When a user passes `systemPrompt: ""` (empty string), after `.trim()` it remains `""`. The `??` operator treats empty string as present (not nullish), so:
- `finalSystemPrompt = ""` (empty string replaces the full auto-generated orchestrator prompt)
- But the ternary on line 323 uses `customSystemPrompt ?` which treats `""` as absent

This breaks the orchestration: it loses all auto-generated role instructions, decision protocol, resilience patterns.

**The Test Is Too Weak**: The existing test at line 227-240 has the correct title ("treats empty-string systemPrompt as absent") but its assertions are weak: it checks `not.toBe('   ')` and `not.toContain('ORCHESTRATOR CONTRACT')`, both satisfied by `""`, so the test passes despite the bug.

**Fix**: Change line 322 from `??` to `||` so both operators agree (empty string = absent):

```typescript
const finalSystemPrompt = customSystemPrompt || orchestratorSystemPrompt;
```

---

### 🔴 HIGH: SchedulePipelineSchema Missing Per-Step systemPrompt

**Confidence**: 90% (flagged by architecture and consistency reviewers)

**Files**: 
- Zod: `src/adapters/mcp-adapter.ts:248-253` (SchedulePipelineSchema)
- JSON Schema: `src/adapters/mcp-adapter.ts:1078-1105`
- Handler: `src/adapters/mcp-adapter.ts:2403-2409` (handleSchedulePipeline)

**Problem**: `CreatePipelineSchema` (line 222) correctly includes per-step `systemPrompt` and the handler maps it. But `SchedulePipelineSchema` (line 248-253) is missing per-step `systemPrompt` in both Zod and JSON Schema. The domain type `PipelineStepRequest` has it, so this is an API asymmetry.

**Impact**: Users cannot override system prompts per step in scheduled pipelines, while non-scheduled pipelines support it. This is a user-facing feature gap.

**Fix**: Add `systemPrompt` to three places:

```typescript
// 1. SchedulePipelineSchema Zod step object (after model line 252):
systemPrompt: z.string().optional().describe('System prompt override for this step'),

// 2. SchedulePipelineSchema JSON Schema (after model block around line 1104):
systemPrompt: {
  type: 'string',
  description: 'System prompt override for this step',
},

// 3. handleSchedulePipeline step mapping (line ~2409):
steps: data.steps.map((s) => ({
  prompt: s.prompt,
  priority: s.priority as Priority | undefined,
  workingDirectory: s.workingDirectory,
  agent: s.agent as AgentProvider | undefined,
  model: s.model ?? data.model,
  systemPrompt: s.systemPrompt,  // ADD THIS
})),
```

---

### 🔴 HIGH: Stale JSDoc Comment References Removed Constraint

**Confidence**: 95% (flagged by consistency reviewer)

**File**: `src/adapters/mcp-adapter.ts:102`

**Problem**: The JSDoc comment still reads `Max 16000 chars to stay well within typical schema sizes.` but the `.max(16000)` constraint was removed from the `jsonSchema` field on line 104. This is documentation drift.

**Fix**: Remove the stale sentence:

```typescript
/**
 * v1.3.0: JSON schema for structured output (Claude only).
 * DECISION: Passed through to TaskRequest unchanged -- validation at boundary.
 * Why: Claude --json-schema enables deterministic structured responses.
 */
```

---

### 🔴 MEDIUM: Missing Service-Level Test for createPipeline systemPrompt Fallback

**Confidence**: 85% (flagged by testing reviewer)

**File**: `src/services/schedule-manager.ts:372`

**Problem**: The new line `systemPrompt: step.systemPrompt ?? request.systemPrompt` implements fallback logic (per-step overrides shared default). This is the only place where systemPrompt fallback occurs in `createPipeline`, yet there is no service-level test in `schedule-manager.test.ts`. All other override fields (priority, workingDirectory, model) have dedicated per-step tests. systemPrompt is missing.

**Fix**: Add two tests to the `createPipeline()` describe block in `tests/unit/services/schedule-manager.test.ts`:

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
    steps: [
      { prompt: 'Step one', systemPrompt: 'Step-specific' },
      { prompt: 'Step two' },
    ],
    systemPrompt: 'Shared default',
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const events = eventBus.getEmittedEvents('ScheduleCreated');
  expect(events[0].schedule.taskTemplate.systemPrompt).toBe('Step-specific');
  expect(events[1].schedule.taskTemplate.systemPrompt).toBe('Shared default');
});
```

---

### 🔴 MEDIUM: buildFinalPrompts agent Parameter Typed as string Instead of AgentProvider

**Confidence**: 85% (flagged by typescript reviewer)

**File**: `src/services/orchestration-manager.ts:305`

**Problem**: The new private method `buildFinalPrompts` declares its `agent` parameter as `string`, but always receives `AgentProvider` type. While it works at runtime, this loses type narrowness.

**Fix**: Change the parameter type:

```typescript
private buildFinalPrompts(
  request: OrchestratorCreateRequest,
  orchestration: Orchestration,
  stateFilePath: string,
  workingDirectory: string,
  agent: AgentProvider,  // was: string
): { finalSystemPrompt: string; finalUserPrompt: string } {
```

---

## Should-Fix Issues (High Priority, Not Blocking)

### ⚠️ MEDIUM: Synchronous writeFileSync Blocks Event Loop in Spawn Path

**Confidence**: 80% (flagged by performance reviewer)

**File**: `src/implementations/gemini-adapter.ts:68`

**Problem**: `GeminiBasePromptCache.buildCombinedFile()` calls `writeFileSync()` in the `spawn()` method. For every Gemini task with a system prompt, this blocks the Node.js event loop. The 64KB guard keeps it bounded, but synchronous I/O during spawn is not ideal.

**Note**: This is pre-existing (not introduced by this PR) but the PR touched this area.

**Fix**: Future refactor to make spawn async. For this PR: no action required (guard keeps size bounded).

---

### ⚠️ MEDIUM: createOrchestration Method Remains 230+ Lines Despite Extraction

**Confidence**: 82% (flagged by complexity reviewer)

**File**: `src/services/orchestration-manager.ts:60-290`

**Problem**: Despite extracting `buildFinalPrompts`, the parent method still spans ~230 lines with 8+ distinct responsibilities. The method was already long before this PR.

**Note**: Pre-existing complexity, not introduced by this PR.

**Fix**: Future refactor to extract `validateAndResolveInputs()`, `setupStateFiles()`, and `createAndLinkLoop()`.

---

## Suggestions (Lower Confidence)

### ℹ️ Low: taskId Used as Filename Without Sanitization (65% confidence)

**File**: `src/implementations/base-agent-adapter.ts:194-195`

The `safeId` (which is `taskId ?? crypto.randomUUID()`) is interpolated into file paths. TaskIds are generated server-side as `task-{UUID}` (inherently safe) and the existing path-traversal guards in `buildCombinedFile` mitigate this. Low risk today, but if TaskId generation pattern changes, this becomes a concern.

---

### ℹ️ Low: System Prompt Not Sanitized Before CLI Injection (60% confidence)

**Files**: `src/implementations/claude-adapter.ts:48`, `src/implementations/codex-adapter.ts:41`

The systemPrompt is passed as a CLI argument. Node's `child_process.spawn` with array args handles this safely (no shell interpretation), so not exploitable. Noted for completeness.

---

## Summary by Reviewer

| Reviewer | Score | Key Finding |
|----------|-------|-------------|
| **Security** | 7/10 | Unbounded string inputs — HIGH blocking |
| **Architecture** | 8/10 | SchedulePipeline missing systemPrompt — HIGH blocking |
| **Performance** | 7/10 | Unbounded memory allocation risk — MEDIUM should-fix |
| **Complexity** | 7/10 | Extracting `buildFinalPrompts` good; further extraction possible |
| **Consistency** | 7/10 | Stale JSDoc + `??` vs `\|\|` semantic mismatch — HIGH blocking |
| **Regression** | 8/10 | Empty-string handling regression — HIGH blocking |
| **Testing** | 8/10 | Missing service test for systemPrompt fallback — MEDIUM blocking |
| **TypeScript** | 8/10 | `agent: string` should be `AgentProvider` — MEDIUM blocking |

---

## Positive Observations

The PR demonstrates strong architecture and thoughtful design:

1. **Closure-based cleanup pattern** (`event-driven-worker-pool.ts:129`) — Eliminates silent `?? 'claude'` fallback and post-dispose registry lookup risk
2. **Shared prompt fragments** (`orchestrator-prompt.ts:60-74`) — Reduces drift between systemPrompt and operationalContract
3. **Path-traversal guard** (`base-agent-adapter.ts:50-56`) — New defense-in-depth for Gemini file cache
4. **Comprehensive test coverage** — All three agent adapters (Claude, Codex, Gemini) have positive and regression tests
5. **Clean extraction of `buildFinalPrompts`** — Improves readability of long `createOrchestration` method

---

## Action Plan

**Before merge:**

1. Fix unbounded string inputs: Reinstate reasonable `.max()` bounds (100KB for most fields)
2. Fix empty-string regression: Change `??` to `||` on line 322
3. Add per-step systemPrompt to SchedulePipelineSchema (Zod + JSON + handler)
4. Remove stale JSDoc comment on jsonSchema
5. Add two service tests for createPipeline systemPrompt fallback
6. Change buildFinalPrompts `agent: string` to `agent: AgentProvider`

**After merge (non-blocking):**

1. Consider async refactor for `GeminiBasePromptCache.buildCombinedFile()` in I/O path
2. Further extract long `createOrchestration` method into named helpers
3. Update `taskId` sanitization documentation if generation pattern changes

---

**Overall Assessment**: The system prompt feature is well-implemented across the full stack. The six blocking issues are all straightforward fixes (mostly one-liners or schema additions). Once resolved, this PR will be production-ready.
