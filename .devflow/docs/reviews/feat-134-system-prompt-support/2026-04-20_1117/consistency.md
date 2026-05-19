# Consistency Review Report

**Branch**: feat/134-system-prompt-support -> main
**Date**: 2026-04-20

## Issues in Your Changes (BLOCKING)

### HIGH

**`??` vs `||` inconsistency causes empty-string systemPrompt to bypass auto-generated prompt** - `src/services/orchestration-manager.ts:322`
**Confidence**: 92%
- Problem: `buildFinalPrompts` uses `customSystemPrompt ?? orchestratorSystemPrompt` on line 322 but `customSystemPrompt ? ... : ...` on line 323. The `??` operator treats empty string (`""`) as present (not nullish), while the ternary `?` treats it as falsy/absent. When a user passes `systemPrompt: "   "`, after `.trim()` it becomes `""`. Result: `finalSystemPrompt = ""` (empty string replaces the full auto-generated prompt) but `finalUserPrompt = userPrompt` (no operational contract injected). The DECISION comment says custom systemPrompt replaces the auto-generated one, but an empty string is clearly not a custom prompt -- it is the absence of one. The test at line 227-240 has the correct title ("treats empty-string systemPrompt as absent") but weak assertions that do not catch this.
- Fix: Change `??` to `||` on line 322 so that empty strings fall through to the auto-generated prompt:
  ```typescript
  const finalSystemPrompt = customSystemPrompt || orchestratorSystemPrompt;
  ```
  Both operators then agree: empty string = absent. Alternatively, assign `const customSystemPrompt = request.systemPrompt?.trim() || undefined;` to normalize early.

---

**Missing per-step `systemPrompt` in `SchedulePipelineSchema` (Zod and JSON Schema)** - `src/adapters/mcp-adapter.ts:248-253`
**Confidence**: 90%
- Problem: `CreatePipelineSchema` (line 222) and its JSON Schema (line 1028) correctly include `systemPrompt` as a per-step override. The domain type `PipelineStepRequest` also has it (line 450). But `SchedulePipelineSchema` (line 248-253) and its JSON Schema (line 1078-1105) are missing per-step `systemPrompt`. This means immediate pipelines support per-step system prompts, but scheduled pipelines silently drop them -- a feature gap between two tools that share the same domain type.
- Fix: Add `systemPrompt` to `SchedulePipelineSchema` step object (line 252) and its JSON Schema counterpart (line 1099-1105):
  ```typescript
  // Zod (after model on line 252):
  systemPrompt: z.string().optional().describe('System prompt override for this step'),
  ```
  ```typescript
  // JSON Schema (after model block around line 1104):
  systemPrompt: {
    type: 'string',
    description: 'System prompt override for this step',
  },
  ```

---

**Stale JSDoc comment references removed `.max(16000)` constraint** - `src/adapters/mcp-adapter.ts:102`
**Confidence**: 95%
- Problem: The JSDoc comment on line 102 still reads `Max 16000 chars to stay well within typical schema sizes.` but the `.max(16000)` constraint was removed from `jsonSchema` on line 104 as part of this PR. This is documentation drift -- the comment describes a validation rule that no longer exists.
- Fix: Remove the stale sentence from the JSDoc:
  ```typescript
  /**
   * v1.3.0: JSON schema for structured output (Claude only).
   * DECISION: Passed through to TaskRequest unchanged -- validation at boundary.
   * Why: Claude --json-schema enables deterministic structured responses.
   */
  ```

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **`setupAdapter` helper scope** - `tests/unit/implementations/agent-adapters.test.ts:67-79` (Confidence: 65%) -- The `setupAdapter` generic helper is defined at module scope but `beforeEach`/`afterEach` calls inside it execute in the context of the enclosing `describe` block. This works due to Vitest's hook scoping but is unusual -- a reader might expect the hooks to register globally. The pattern is internally consistent within this file so it is not blocking, but adding a brief comment explaining Vitest hook scoping could help future readers.

- **`systemPrompt` field on `ScheduleLoopSchema` is top-level but inconsistent with loop config nesting** - `src/adapters/mcp-adapter.ts:486` (Confidence: 62%) -- `ScheduleLoopSchema` has `systemPrompt` as a top-level field alongside schedule timing fields, while in the domain type (`ScheduledLoopCreateRequest`) it lives under `loopConfig`. The MCP adapter handler presumably maps it correctly, but the flat-vs-nested shape difference between schema and domain type is an inconsistency that could cause confusion. Pre-existing pattern, not introduced by this PR.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 3 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | - | 0 | 0 |

**Consistency Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The limit-removal changes are consistently applied across all Zod schemas, JSON schemas, and tests -- good pattern alignment. The `orchestrator-prompt.ts` shared-fragment refactor keeps systemPrompt and operationalContract in sync -- solid DRY improvement. Test name normalization to "should ..." is consistently applied.

Three HIGH issues need attention: (1) the `??` vs `||` semantic mismatch silently produces a broken orchestrator when whitespace-only systemPrompt is passed; (2) `SchedulePipelineSchema` is missing per-step `systemPrompt` that `CreatePipelineSchema` and the domain type already support; (3) a stale JSDoc comment references a removed constraint.
