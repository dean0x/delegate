# Architecture Review Report

**Branch**: feat/134-system-prompt-support -> main
**Date**: 2026-04-17
**PR**: #147
**Commits**: 7 (c43d303..ef16f93)
**Files changed**: 22 (+571, -82)

## Issues in Your Changes (BLOCKING)

### HIGH

**Incomplete feature surface: ScheduleTask, SchedulePipeline, and ScheduleLoop MCP tools do not accept systemPrompt** - `src/adapters/mcp-adapter.ts`
**Confidence**: 88%
- Problem: `DelegateTask`, `CreateLoop`, and `CreateOrchestrator` all accept `systemPrompt`, but the three schedule tools (`ScheduleTask` at line 146, `SchedulePipeline` at line 232, `ScheduleLoop` at line 426) do not. The `ScheduleTaskSchema` Zod schema lacks the field, and `handleScheduleTask` (line 1959) does not thread it into `ScheduleCreateRequest`. Similarly, `ScheduleLoopSchema` does not include `systemPrompt` in the `loopConfig` construction (line 2790-2807). This means users cannot schedule tasks or loops with a system prompt -- the feature is silently absent from scheduled execution.
- Impact: Inconsistent API surface. Users who discover `systemPrompt` on `DelegateTask` will expect it on `ScheduleTask` and `ScheduleLoop`. Scheduled tasks lose the system prompt that was specified at scheduling time. This is an ISP/OCP-adjacent inconsistency: the abstraction level for "create a task" varies depending on whether it is immediate or scheduled.
- Fix: Add `systemPrompt` to `ScheduleTaskSchema`, `ScheduleLoopSchema`, and their handlers. Thread the value into `ScheduleCreateRequest.taskTemplate.systemPrompt` and `loopConfig.systemPrompt` respectively. The `SchedulePipelineSchema` may also need per-step `systemPrompt` or a top-level default, consistent with how `model` is handled.

**Gemini adapter performs file I/O inside getSystemPromptConfig -- violates separation of concerns** - `src/implementations/gemini-adapter.ts:52-110`
**Confidence**: 82%
- Problem: `getSystemPromptConfig` is documented as a method to "declare how this adapter injects a system prompt" (base-agent-adapter.ts:57), but `GeminiAdapter.getSystemPromptConfig` performs synchronous file reads (`readFileSync`, `existsSync`, `statSync`), file writes (`writeFileSync`, `mkdirSync`), and staleness logging. This violates the single responsibility implied by the abstract method's contract -- it both declares configuration and performs I/O side effects. The base class JSDoc at line 61 acknowledges "Adapters that require a file must write it inside this method," so this is partially by design, but it pushes infrastructure concerns (cache management, staleness policy, filesystem error handling) into a method that other adapters implement as pure data returns.
- Impact: The adapter pattern becomes asymmetrically complex. Claude and Codex adapters are 3-line pure functions; Gemini is 60 lines of I/O with 3 error paths and a 30-day staleness constant. Testing Gemini's prompt injection requires filesystem fixtures. Future adapters looking at the pattern will be unclear whether `getSystemPromptConfig` should be pure or effectful.
- Fix: Consider extracting the cache read/write logic into a separate `GeminiSystemPromptCache` class injected via the constructor, keeping `getSystemPromptConfig` as a thin delegation. This preserves the abstract adapter pattern's simplicity while isolating the Gemini-specific caching concern. Alternatively, document the "I/O is expected" contract more prominently in the abstract base class if this asymmetry is intentional.

### MEDIUM

**System prompt temp file cleanup is coupled to worker pool instead of adapter** - `src/implementations/event-driven-worker-pool.ts:304-312`
**Confidence**: 85%
- Problem: `cleanupWorkerState` in `EventDrivenWorkerPool` unconditionally attempts `unlinkSync` on a system prompt temp file path (`~/.autobeat/system-prompts/{taskId}.md`). This cleanup concern belongs to the adapter that wrote the file (GeminiAdapter), not to the worker pool. The worker pool now has knowledge of a file path convention that is an implementation detail of one specific adapter. Claude and Codex adapters never write this file, yet the worker pool attempts to delete it for every task.
- Impact: Layering violation (worker pool depends on adapter implementation detail). If the file path convention changes in GeminiAdapter, the worker pool must be updated in sync. The current `try/catch` suppresses errors, so the functional impact is low, but the architectural coupling is real.
- Fix: Add a `cleanup(taskId: string): void` method to the `AgentAdapter` interface (or `BaseAgentAdapter`). The adapter that wrote the file owns its cleanup. The worker pool calls `adapter.cleanup(taskId)` during `cleanupWorkerState` instead of reaching into the filesystem directly.

**refreshBasePrompt CLI command uses spawnSync with hardcoded command** - `src/cli/commands/agents.ts:250-260`
**Confidence**: 80%
- Problem: `refreshBasePrompt` spawns `gemini` CLI with `spawnSync` using a hardcoded binary name. The rest of the codebase resolves agent binaries through `BaseAgentAdapter.command` and validates via `isCommandInPath`. The hardcoded approach bypasses this resolution and cannot be overridden by configuration or tests.
- Impact: Minor DIP violation -- the CLI command depends on a concrete binary name rather than the configured adapter's command. If the Gemini CLI binary changes or a user has it installed under a different name, this command breaks while the main spawn path still works.
- Fix: Resolve the Gemini binary name through `GeminiAdapter` or `AgentConfig` rather than hardcoding. For v1.4.0 scope, this is acceptable as a known limitation if documented.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Orchestrator system prompt override is all-or-nothing with no composition option** - `src/services/orchestration-manager.ts:219-222`
**Confidence**: 80%
- Problem: The decision at line 219-222 (`const finalSystemPrompt = request.systemPrompt ?? orchestratorSystemPrompt`) means a user providing `systemPrompt` on `CreateOrchestrator` loses all auto-generated role instructions (ROLE, STATE FILE, WORKER MANAGEMENT, DECISION PROTOCOL, RESILIENCE sections). The JSDoc and MCP instructions document this clearly, but the architecture provides no middle ground -- users cannot extend the default role instructions, only replace them entirely.
- Impact: Users who want to add project-specific rules (e.g., "always run lint before committing") must duplicate the entire 2KB+ orchestrator system prompt. This creates a maintenance burden: when the orchestrator prompt is updated in a future version, custom system prompts become stale. The `--append-system-prompt` pattern used by Claude shows that append semantics are often preferable.
- Fix: Consider a `systemPromptMode: 'replace' | 'append'` field defaulting to `'replace'` for backward compatibility. When `'append'`, concatenate: `orchestratorSystemPrompt + "\n\n" + request.systemPrompt`. This is a design decision, not a bug -- flagging for consideration.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**PF-006 reconfirmed: ProcessSpawnerAdapter silently drops fields** - `src/implementations/process-spawner-adapter.ts:26-28`
**Confidence**: 90%
- Problem: `ProcessSpawnerAdapter.spawn()` delegates the full `SpawnOptions` bag to `ProcessSpawner.spawn()`, which accepts `SpawnOptions` in its interface. However, the known pitfall PF-006 documents that `ProcessSpawner` implementations may destructure only a subset of fields. With `systemPrompt` now added to `SpawnOptions`, any `ProcessSpawner` implementation that destructures specific fields will silently drop it. The current `ProcessSpawnerAdapter` itself is clean (it passes the whole bag), but downstream mock implementations may not forward the field.
- Impact: Test-only impact currently. Real spawns go through `BaseAgentAdapter` subclasses. The risk is that tests using `MockProcessSpawner` will not exercise system prompt behavior.
- Fix: This is informational per PF-006. No action needed for this PR, but the adapter should eventually be deleted as noted in its own architecture comment.

## Suggestions (Lower Confidence)

- **System prompt max length diverges from prompt max length** - `src/adapters/mcp-adapter.ts` (Confidence: 65%) -- `systemPrompt` allows 16000 chars while task `prompt` allows 4000. The 4x difference is intentional per the JSDoc, but the MCP instructions do not explain the rationale. Users may be confused by the asymmetry.

- **Missing validation for systemPrompt content** - `src/adapters/mcp-adapter.ts:110-116` (Confidence: 70%) -- The Zod schema validates max length but not content. While sanitization is not the adapter's job, consider whether system prompts should be stripped of control characters (matching the `orchestratorId` sanitization pattern at base-agent-adapter.ts:227).

- **v1.4.0 version comments in code while package.json is 1.3.1** - Multiple files (Confidence: 72%) -- JSDoc comments reference "v1.4.0" throughout, but the codebase is at v1.3.1. This is consistent with the project's pattern of feature-tagging before release, but could confuse contributors.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Architecture Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The abstract adapter pattern (`getSystemPromptConfig`) is well-designed -- it cleanly separates the per-agent injection mechanism from the base spawn logic (OCP, DIP). The orchestrator prompt split (system + user) is a correct separation that enables proper routing through each agent's native system prompt mechanism. The domain-to-persistence-to-worker-pool threading is complete for the three primary tools.

The two HIGH findings are:
1. **Incomplete API surface** -- the three schedule tools are missing `systemPrompt`, creating an inconsistency that will confuse users.
2. **Gemini adapter coupling** -- file I/O in `getSystemPromptConfig` breaks the otherwise clean adapter pattern, and the cleanup is owned by the wrong layer (worker pool instead of adapter).

The task-repository changes correctly update all 14 paired locations (Zod schema, TypeScript interface, save/update statements, all 8 SELECT queries, `toDbFormat`, `rowToTask`), directly addressing the PF-006 paired-interface drift risk called out in the PR description.
