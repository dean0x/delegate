# Database Review Report

**Branch**: feat/134-system-prompt-support -> main
**Date**: 2026-04-17
**Scope**: Incremental review of 7 commits since ef16f93b

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

**Missing `systemPrompt` in schedule repository TaskRequestSchema** - `src/implementations/schedule-repository.ts:78-95`
**Confidence**: 95%
- Problem: The `TaskRequestSchema` Zod schema in the schedule repository does not include a `systemPrompt` field. The schedule-manager now stores `systemPrompt` in the `taskTemplate` JSON blob (lines 75, 304 in `schedule-manager.ts`), but when the schedule is loaded back from SQLite, `rowToSchedule()` parses the JSON through `TaskRequestSchema.parse()` which strips any unknown keys. On the next trigger, `createTask({ ...schedule.taskTemplate, dependsOn })` (schedule-handler.ts:298) creates a task without the system prompt. The pipeline trigger path at schedule-handler.ts:401 (`systemPrompt: defaults.systemPrompt`) is equally affected since `defaults` is the deserialized template.
- Impact: System prompts set on scheduled tasks silently vanish after the first schedule persistence cycle. The data is stored in SQLite correctly (JSON blob retains the key), but Zod strips it on read. This affects single-task, pipeline, and loop schedule triggers.
- Fix: Add `systemPrompt: z.string().optional()` to `TaskRequestSchema` in `src/implementations/schedule-repository.ts`:
  ```typescript
  const TaskRequestSchema = z.object({
    prompt: z.string().min(1),
    // ... existing fields ...
    orchestratorId: z.string().optional(),
    systemPrompt: z.string().optional(),  // <-- add this
  });
  ```

**Missing `systemPrompt` in schedule repository LoopConfigSchema** - `src/implementations/schedule-repository.ts:124-142`
**Confidence**: 92%
- Problem: The `LoopConfigSchema` Zod schema does not include `systemPrompt`, even though `LoopCreateRequest` (domain.ts:692) defines it as optional. When a scheduled loop fires, `handleLoopTrigger` reads `schedule.loopConfig` which was deserialized through `LoopConfigSchema.parse()`. The `systemPrompt` field is stripped. The `satisfies z.ZodType<LoopCreateRequest>` guard on line 142 does not catch this because all omitted fields are optional (the output type is a subset, which is assignable to the full interface).
- Impact: System prompts set on scheduled loops silently vanish after the loop config round-trips through the database. Same class of silent data loss as the TaskRequestSchema issue above.
- Fix: Add `systemPrompt: z.string().optional()` to `LoopConfigSchema` in `src/implementations/schedule-repository.ts`:
  ```typescript
  const LoopConfigSchema = z.object({
    // ... existing fields ...
    gitBranch: z.string().optional(),
    systemPrompt: z.string().optional(),  // <-- add this
  }) satisfies z.ZodType<LoopCreateRequest>;
  ```

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none -- pre-existing pitfalls PF-001, PF-004, PF-005 are not reintroduced by this diff)

## Suggestions (Lower Confidence)

(none)

## Pitfall Check

| Pitfall | Relevant? | Status |
|---------|-----------|--------|
| PF-001 (1Hz polling indexes) | No | No new queries added |
| PF-004 (prepared statement caching) | No | No new repo query methods added |
| PF-005 (Zod on repo reads) | Tangentially | Migration v23 adds a column; the existing `rowToTask` Zod schema already covers `system_prompt` (task-repository.ts:40). However, the schedule repository Zod schemas are missing the field (reported as BLOCKING above) |

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | - | 0 | 0 |

**Database Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

### Rationale

The migration itself (v23: `ALTER TABLE tasks ADD COLUMN system_prompt TEXT`) is clean -- nullable TEXT column, no data migration needed, idempotent `ALTER TABLE ADD COLUMN`. The task repository correctly handles the new column in save/update/find paths with proper Zod validation.

The two HIGH findings are both the same class of bug: Zod schemas in the schedule repository strip `systemPrompt` during deserialization, silently losing the field on DB round-trip. This directly undermines the feature's stated goal of persisting system prompts through retry/resume cycles when tasks are scheduled. The fix is mechanical (add one line to each schema) but the impact without it is silent data loss in scheduled task/pipeline/loop triggers.

The comment-style changes (`@design` -> `DECISION:`) and version tag removal (`v1.4.0` -> none) in migration v23 and the loop repository Zod schema are cosmetic and correct.
