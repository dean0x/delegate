# Regression Review Report

**Branch**: feat-134-system-prompt-support -> main
**Date**: 2026-04-17T16:41
**Commits**: 7 (c43d303..ef16f93)
**Files Changed**: 22 (+571, -82)

## Issues in Your Changes (BLOCKING)

### HIGH

**ScheduleLoop incomplete migration -- systemPrompt silently stripped** - `src/adapters/mcp-adapter.ts:426-472`
**Confidence**: 92%
- Problem: `CreateLoop` (Zod schema at line 389, handler at line 2470) correctly accepts `systemPrompt`, but `ScheduleLoopSchema` (line 426) does not include it. When a user calls `ScheduleLoop` with `systemPrompt`, Zod's `safeParse` silently strips the unknown field. The loop config serialized into the `loop_config` DB column will lack systemPrompt. When the schedule triggers, the loop is created without the system prompt the user intended.
- Impact: Users who schedule loops with system prompts get silently different behavior than users who create loops directly. No error, no warning -- the feature just does not work for scheduled loops.
- Fix: Add `systemPrompt` to both the Zod schema and the inputSchema:
  ```typescript
  // In ScheduleLoopSchema (line ~455, before gitBranch or after model):
  systemPrompt: z.string().max(16000).optional()
    .describe('System prompt injected into each iteration task agent'),
  ```
  ```typescript
  // In ScheduleLoop inputSchema properties (line ~1386, near model):
  systemPrompt: {
    type: 'string',
    description: 'System prompt injected into each iteration task agent (max 16000 chars)',
    maxLength: 16000,
  },
  ```
  And in the handler at line 2789, add `systemPrompt: data.systemPrompt` to the `loopConfig` object.

**ScheduleTask and SchedulePipeline do not support systemPrompt** - `src/adapters/mcp-adapter.ts:146-171`, `src/adapters/mcp-adapter.ts:232-262`
**Confidence**: 82%
- Problem: `DelegateTask` now accepts `systemPrompt`, but `ScheduleTask` and `SchedulePipeline` do not. Users who schedule individual tasks or pipelines cannot attach a system prompt. While this is arguably a "feature not yet added" rather than a regression (these schemas never had it), it creates an inconsistent API surface: the same task creation works with systemPrompt via `DelegateTask` but not via `ScheduleTask`.
- Impact: Users cannot schedule tasks with system prompts. The `ScheduleCreateRequest` domain type would also need updating to propagate systemPrompt through the schedule executor path. This is more an incomplete feature than a regression, but the inconsistency is a HIGH concern given the PR adds systemPrompt to every other task-creating tool.
- Fix: Add `systemPrompt` to `ScheduleTaskSchema`, `SchedulePipelineSchema` (per-step), their inputSchemas, handlers, and the underlying `ScheduleCreateRequest`/`ScheduledPipelineCreateRequest` domain types. This may warrant a follow-up PR if the scope is intentionally limited.

### MEDIUM

**--system-prompt CLI flag accepts values starting with a dash if they contain non-flag text** - `src/cli.ts:180-188`
**Confidence**: 80%
- Problem: The `--system-prompt` flag check `!next.startsWith('-')` will reject any system prompt starting with a dash. While this guards against mistakenly consuming the next flag, system prompts legitimately starting with `-` (e.g., `- You are a code reviewer`) are rejected. The same pattern exists for `--model` and `--agent` which is fine for short values, but system prompts are free-form text up to 16KB.
- Impact: Users providing system prompts with leading dashes get a confusing error ("--system-prompt requires a prompt string") when the value is valid. Quoting does not help since the check is on the parsed argv value, not shell syntax.
- Fix: Consider removing the `!next.startsWith('-')` guard for `--system-prompt` specifically, or use a different approach like `--system-prompt=VALUE` syntax. Alternatively, accept a file path (`--system-prompt-file`) for long prompts, which sidesteps the issue entirely.

## Issues in Code You Touched (Should Fix)

_No issues found in this category._

## Pre-existing Issues (Not Blocking)

### MEDIUM

**PF-006 (Known pitfall): ProcessSpawnerAdapter still silently discards extra SpawnOptions fields** - `src/implementations/process-spawner-adapter.ts:26`
**Confidence**: 85%
- Problem: While `ProcessSpawner` now uses `SpawnOptions` (fixed in v1.3.0), the `ProcessSpawnerAdapter.spawn()` passes the entire options bag through to `this.spawner.spawn(options)`. The underlying mock spawners in tests may or may not handle `systemPrompt`. The adapter itself does not strip it, but neither does it use it -- the mock spawner simply receives whatever `SpawnOptions` contains. This is safe for the shim, but test coverage should verify the field survives round-tripping.
- Impact: Low risk in production (shim only used in tests). The new `systemPrompt` field flows through correctly because `SpawnOptions` is passed as a bag. No silent drop like the original PF-006.

## Suggestions (Lower Confidence)

- **System prompt temp file naming uses taskId which may be undefined** - `src/implementations/base-agent-adapter.ts:193` (Confidence: 72%) -- When `taskId` is undefined (the `SpawnOptions.taskId` is optional), the path becomes `~/.autobeat/system-prompts/unknown.md`. If two concurrent tasks without taskIds both have system prompts, they overwrite each other's temp files. In practice, tasks always have IDs when spawned through the normal flow, but the type system allows undefined.

- **Gemini adapter writes combined prompt file synchronously in spawn path** - `src/implementations/gemini-adapter.ts:80-81` (Confidence: 65%) -- `writeFileSync` in the spawn path blocks the event loop. For most system prompts this is fast (< 16KB), but if the filesystem is slow (NFS, remote mount), it could delay spawning. The `mkdirSync` call at line 80 is also redundant if the cache directory already exists. Both are acceptable for the current scale.

- **v1.4.0 version references in JSDoc/comments may conflict with v1.3.1 release** - multiple files (Confidence: 60%) -- Comments reference "v1.4.0" throughout, but the project is at v1.3.1. If the next release is v1.3.2 or v1.4.0, these comments are either premature or correct. This is a known project convention (PF-009) but worth noting.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Regression Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

### Rationale

The core regression concerns raised in the review prompt are all handled correctly:

1. **buildOrchestratorPrompt() return type change**: Only 2 callers (orchestration-manager.ts and the unit test), both correctly updated to destructure `{ systemPrompt, userPrompt }`. No stale callers.

2. **task-repository prepared statements**: All 10 prepared statements consistently updated to include `system_prompt` in their SELECT lists. The `toDbFormat()` method maps `systemPrompt` to `@systemPrompt`. INSERT and UPDATE statements both include the new column. SQL syntax is valid.

3. **base-agent-adapter spawn()**: When `systemPrompt` is undefined, the `if (systemPrompt)` guard at line 191 skips the entire system prompt injection block. `effectivePrompt` stays as the original `prompt`, `systemPromptArgs` stays empty, `systemPromptEnv` stays empty. The spread of empty arrays/objects into args and env is a no-op. Existing behavior is preserved.

4. **MCP tool schemas expanded**: All new fields (`systemPrompt`, `includeSystemPrompt`) are `.optional()` in Zod schemas. Clients not sending these fields get default behavior. Backwards compatible.

The one blocking regression is the **ScheduleLoop incomplete migration** -- the same feature (systemPrompt on loops) works via `CreateLoop` but silently fails via `ScheduleLoop`. This is a category-4 regression (incomplete migration) per the pattern skill.

### Pitfall Check

- **PF-004** (Prepared statement caching): Not applicable to this PR -- all new SQL includes `system_prompt` in already-cached statements.
- **PF-005** (Zod on repo reads): The new `system_prompt` field is added to `TaskRowSchema` and parsed via Zod. Correct.
- **PF-006** (Paired-interface drift): `SpawnOptions` was widened with `systemPrompt`, and `ProcessSpawner` uses `SpawnOptions` directly (bag pass-through). No silent drop.
- **PF-009** (Release notes desync): v1.4.0 comments throughout but no release notes in this PR. Acceptable as a feature branch.
