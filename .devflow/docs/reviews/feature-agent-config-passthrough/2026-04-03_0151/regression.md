# Regression Review Report

**Branch**: feature/agent-config-passthrough -> main
**Date**: 2026-04-03T01:51:00Z

## Issues in Your Changes (BLOCKING)

### CRITICAL

**model field stripped on loop/schedule persistence roundtrip (3 locations)** -- Confidence: 95%
- `src/implementations/loop-repository.ts:87-99`, `src/implementations/schedule-repository.ts:78-89`, `src/implementations/schedule-repository.ts:118-135`
- Problem: The `TaskRequestSchema` Zod objects in both `loop-repository.ts` and `schedule-repository.ts` do not include a `model` field. Zod's default `.parse()` strips unknown keys. When a loop or schedule is saved with a `taskTemplate` containing `model`, the value is serialized to JSON correctly (since `JSON.stringify` preserves all keys). However, when the row is read back via `rowToLoop()` or `rowToSchedule()`, the `TaskRequestSchema.parse()` call strips the `model` field from the parsed object. This means:
  - Loop model overrides are lost after server restart or recovery
  - Scheduled task model overrides are lost after persistence roundtrip
  - Scheduled pipeline step model overrides are also lost (the `PipelineStepsSchema` at `schedule-repository.ts:102-112` is similarly missing `model`)
  - Scheduled loop model overrides are lost (the `LoopConfigSchema` at `schedule-repository.ts:118-135` is similarly missing `model`)
- Impact: Any `model` override specified via MCP or CLI for loops, scheduled tasks, scheduled pipelines, or scheduled loops will silently revert to the agent's default model after the first DB roundtrip (recovery, restart, or status query that triggers deserialization). This defeats the purpose of per-task model passthrough for all persistent constructs.
- Fix: Add `model: z.string().optional()` to all four schemas:
  ```typescript
  // loop-repository.ts TaskRequestSchema (~line 98, before closing })
  agent: z.enum(AGENT_PROVIDERS_TUPLE).optional(),
  model: z.string().optional(),

  // schedule-repository.ts TaskRequestSchema (~line 89, before closing })
  agent: z.enum(AGENT_PROVIDERS_TUPLE).optional(),
  model: z.string().optional(),

  // schedule-repository.ts PipelineStepsSchema (~line 108, inside each step object)
  agent: z.enum(AGENT_PROVIDERS_TUPLE).optional(),
  model: z.string().optional(),

  // schedule-repository.ts LoopConfigSchema (~line 134, before gitBranch)
  agent: z.enum(AGENT_PROVIDERS_TUPLE).optional(),
  model: z.string().optional(),
  ```

### HIGH

**Orchestration model field not persisted to database** -- Confidence: 92%
- `src/implementations/orchestration-repository.ts:25-58`, `src/implementations/orchestration-repository.ts:279-294`, `src/implementations/database.ts:3108-3129`
- Problem: The `Orchestration` domain interface now includes `model?: string` and `createOrchestration()` sets it, but:
  1. No database migration adds a `model` column to the `orchestrations` table (migration v14 at `database.ts:3108-3129` lacks it)
  2. The `OrchestrationRowSchema` at `orchestration-repository.ts:25-39` has no `model` field
  3. The `OrchestrationRow` interface at `orchestration-repository.ts:45-59` has no `model` field
  4. The `toRow()` method at `orchestration-repository.ts:279-294` does not map `model`
  5. The `rowToOrchestration()` method at `orchestration-repository.ts:297-313` does not restore `model`
- Impact: The `model` field on orchestrations is an in-memory-only value. It works for the initial orchestration creation flow (the model is passed to the loop's `taskTemplate`), but:
  - `OrchestratorStatus` CLI display shows `model` from DB (which will be missing)
  - After server restart, the orchestration object retrieved from DB will have `model: undefined`
  - The MCP `OrchestratorStatus` response conditionally includes `model` (line `...(orchestration.model && { model: orchestration.model })`), which will always be false after a DB read
- Fix: Add a migration v17 with `ALTER TABLE orchestrations ADD COLUMN model TEXT`, and update the repository schema, row interface, `toRow()`, and `rowToOrchestration()` methods. Alternatively, document that orchestration model is transient (derived from the loop's taskTemplate) and remove the field from the `Orchestration` interface if persistence is not needed.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Deleted process-spawner.ts removes prompt transformation behavior** -- Confidence: 82%
- `src/implementations/process-spawner.ts` (deleted), `src/implementations/claude-adapter.ts`
- Problem: The deleted `ClaudeProcessSpawner` contained prompt transformation logic (lines 3633-3646 in diff) that would wrap simple prompts with "Execute the following bash command:" when they looked like simple commands (short prompts without explicit instruction words). The `ClaudeAdapter` (which is the replacement) inherits from `BaseAgentAdapter` whose `transformPrompt()` method is a no-op identity function. The `ClaudeAdapter` does not override `transformPrompt()`.
- Impact: This is a behavioral change -- simple prompts like "ls" or "npm test" that were previously automatically wrapped to help Claude understand they should be executed as commands will no longer be wrapped. This could cause regression for users who relied on this implicit wrapping. However, the wrapping was arguably a hack with heuristic detection (checking for specific words), and the Claude Code `--print` flag already handles prompt interpretation. The confidence is 82% because this may actually be an intentional cleanup rather than a regression.
- Fix: If the prompt transformation was intentional, override `transformPrompt()` in `ClaudeAdapter` with the same logic. If removal was intentional, no action needed -- but document the behavioral change.

## Pre-existing Issues (Not Blocking)

No pre-existing issues identified at CRITICAL level.

## Suggestions (Lower Confidence)

- **`createTask` omits explicit `undefined` for optional fields** - `src/core/domain.ts:1957-1959` (Confidence: 65%) -- The `createTask` function was cleaned up to remove explicit `undefined` assignments for `dependents`, `bestScore`, `bestIterationId`, etc. While this is valid JavaScript (missing properties and `undefined` properties are nearly equivalent), some serialization code or tests might behave differently with `key: undefined` vs. missing key. Low risk since the change is cosmetic.

- **Duplicate test describe blocks in mcp-adapter.test.ts** - `tests/unit/adapters/mcp-adapter.test.ts` (Confidence: 75%) -- The diff shows what appears to be the `ConfigureAgent -- Claude baseUrl warning via callTool()` describe block duplicated 4 times. This is likely a diff rendering artifact from the tool output, but if these are actual duplicates in the file, they would cause test name collisions.

- **`-m` flag collision between `--model` and potential future flags** - `src/cli.ts:1041`, `src/cli/commands/orchestrate.ts:1333` (Confidence: 60%) -- The `-m` short flag is used for `--model`. This is a reasonable choice, but worth noting that some CLI tools use `-m` for `--message`. No action needed unless the project plans to add a `--message` flag.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 1 | 1 | - | - |
| Should Fix | - | - | 1 | - |
| Pre-existing | - | - | - | - |

**Regression Score**: 4/10
**Recommendation**: CHANGES_REQUESTED

The CRITICAL issue (model field stripped by Zod boundary schemas on DB roundtrip) silently breaks the core feature being added -- per-task model override for loops, schedules, scheduled pipelines, and scheduled loops. The model value will work for the initial creation but be lost after any persistence roundtrip (server restart, recovery, status queries). This affects 4 separate Zod schemas across 2 repository files. The HIGH issue (orchestration model not persisted) is a separate but related gap in the persistence layer. Both need to be addressed before merge to ensure the model passthrough feature works end-to-end.
