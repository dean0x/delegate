# Security Review Report

**Branch**: feat/134-system-prompt-support -> main
**Date**: 2026-04-20
**Diff**: `git diff aa69fa2007c5ece548f8916d27d86c19bd73126e...HEAD`

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

**Removal of all text length limits from MCP Zod schemas (Denial of Service via resource exhaustion)** - `src/adapters/mcp-adapter.ts` (multiple locations)
**Confidence**: 85%

- Problem: This PR removes every `.max()` constraint from all user-facing MCP tool schemas. The following fields previously had upper bounds and now accept unbounded strings:
  - `prompt`: was `.max(4000)`, now unbounded (DelegateTask, ScheduleTask, CreateLoop, ScheduleLoop, SchedulePipeline steps)
  - `additionalContext`: was `.max(4000)`, now unbounded (ResumeTask)
  - `systemPrompt`: was `.max(16000)`, now unbounded (DelegateTask, ScheduleTask, SchedulePipeline, CreateOrchestrator, CreateLoop, ScheduleLoop)
  - `jsonSchema`: was `.max(16000)`, now unbounded (DelegateTask)
  - `goal`: was `.max(8000)`, now unbounded (CreateOrchestrator)
  - `exitCondition`: was `.max(4000)`, now unbounded (CreateLoop, ScheduleLoop)
  - `evalPrompt`: was `.max(8000)`, now unbounded (CreateLoop)
  - `judgePrompt`: was `.max(8000)`, now unbounded (CreateLoop)

  Additionally, the server-side validation in `orchestration-manager.ts:77-84` that rejected goals exceeding 8000 chars was removed.

  These fields flow into: CLI args passed to `spawn()`, SQLite persistence (TEXT columns), file I/O (`writeFileSync` for Gemini combined prompts -- guarded at 64KB), and prompt concatenation in memory. A single MCP call with a multi-megabyte `prompt` or `systemPrompt` could:
  1. Exhaust memory during string concatenation (e.g., `buildOrchestratorPrompt` concatenates goal + operational contract + system prompt).
  2. Produce oversized CLI args that exceed OS limits (Linux `ARG_MAX` is typically 2MB; macOS ~256KB).
  3. Bloat the SQLite database with large TEXT values, degrading query performance across all consumers.

  The Gemini combined prompt path has a 64KB guard (`MAX_COMBINED_PROMPT_BYTES`), but the Claude `--append-system-prompt` and Codex `-c developer_instructions=` paths pass the raw string as a CLI argument with no limit.

- Fix: Reinstate reasonable upper bounds. These need not be as tight as the originals, but some boundary is essential. For example:

  ```typescript
  // Generous but bounded — prevents multi-MB payloads
  prompt: z.string().min(1).max(100_000),
  systemPrompt: z.string().max(100_000).optional(),
  goal: z.string().min(1).max(100_000),
  jsonSchema: z.string().max(100_000).optional(),
  ```

  The specific values should reflect the practical maximum the downstream consumers can handle (OS `ARG_MAX`, SQLite page size, LLM context windows).

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none -- pre-existing security issues in unchanged code were not at CRITICAL severity)

## Suggestions (Lower Confidence)

- **taskId used as filename without sanitization** - `src/implementations/base-agent-adapter.ts:194-195` (Confidence: 65%) -- The `safeId` variable (which is `taskId ?? crypto.randomUUID()`) is interpolated directly into a file path: `path.join(os.homedir(), '.autobeat', 'system-prompts', \`${safeId}.md\`)`. TaskIds are currently generated server-side as `task-{UUID}`, which is inherently safe, and the `cleanupTaskFile` and `buildCombinedFile` methods have path-traversal guards. However, if the TaskId generation pattern ever changes or an external caller provides a crafted ID, this could become a traversal vector. The existing guards in GeminiBasePromptCache mitigate this adequately today.

- **System prompt content not sanitized before CLI injection** - `src/implementations/claude-adapter.ts:48`, `src/implementations/codex-adapter.ts:41` (Confidence: 60%) -- The systemPrompt string is passed as a CLI argument value (e.g., `--append-system-prompt <value>` for Claude, `-c developer_instructions=<value>` for Codex). Node's `child_process.spawn` with array args handles this safely (no shell interpretation), so this is not exploitable. Noted for completeness since these are user-controlled strings flowing into process arguments.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | - | 0 | 0 |

**Security Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The single HIGH finding -- removal of all input length validation -- is the primary concern. The PR removes 14+ `.max()` constraints and 1 server-side length check without replacing them. While the downstream code paths (spawn via array-based `child_process.spawn`, SQLite TEXT columns, Gemini 64KB guard) provide some defense in depth, the absence of any boundary validation at the MCP ingress point exposes the server to resource exhaustion. Reinstating reasonable upper bounds (even generous ones like 100KB) would resolve this.

The positive security changes in this PR are notable: the new path-traversal guard on `buildCombinedFile` (line 50-56) and the captured cleanup closure pattern in `event-driven-worker-pool.ts` (lines 126-129) that eliminates the silent `?? 'claude'` fallback are both improvements over the prior code.
