# Consistency Review Report

**Branch**: feat/134-system-prompt-support -> main
**Date**: 2026-04-17
**Scope**: Incremental review (7 commits since ef16f93)

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Inconsistent dash-guard pattern across CLI flag parsers** -- `src/cli.ts`, `src/cli/commands/orchestrate.ts`, `src/cli/commands/loop.ts`
**Confidence**: 85%
- Problem: The `--system-prompt` flag correctly uses `next === undefined` instead of `!next.startsWith('-')` to accept dash-prefixed prompt values. However, other value-bearing flags in the same CLI parsers (e.g., `--agent`, `--model`, `--working-directory`) still use the `!next.startsWith('-')` pattern. This means a user could pass `--agent --gemini` (a typo) and get a confusing error, while `--system-prompt --some-text` works correctly. The rationale for the dash-guard fix is that system prompts are freeform text, but the same inconsistency exists within the orchestrate parser where `--model` and `--working-directory` use `!next || next.startsWith('-')` while `--system-prompt` uses `next === undefined`.
- Fix: This is a deliberate design decision (system prompts are freeform text, other flags expect specific values). The inconsistency is justified and well-tested. No code change needed, but a brief inline comment at each `--system-prompt` handler explaining why it differs from sibling flags would prevent future reviewers from "normalizing" it back.

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

_No CRITICAL pre-existing issues found in the changed files._

## Suggestions (Lower Confidence)

- **`createScheduledLoop` taskTemplate omits `systemPrompt`** -- `src/services/schedule-manager.ts:508-514` (Confidence: 65%) -- The `createScheduledLoop` method does not include `systemPrompt` in the synthetic `taskTemplate` it constructs, while `createSchedule` and `createScheduledPipeline` do. This is architecturally correct because the loop path uses `loopConfig` (not `taskTemplate`) as the authoritative source for `systemPrompt`, and `taskTemplate` is only a fallback for `workingDirectory`. However, the three `createSchedule` call sites now have divergent shapes, which could confuse future contributors. Adding `systemPrompt: request.loopConfig.systemPrompt` to the taskTemplate would make the shape consistent at no functional cost.

- **`GeminiBasePromptCache` uses `console.error` for warnings instead of structured logger** -- `src/implementations/gemini-adapter.ts:101` (Confidence: 70%) -- The new `GeminiBasePromptCache` class uses `console.error(JSON.stringify(...))` for warning logs. The project convention (per CLAUDE.md: "Structured logging - JSON logs with context") and the existing adapter code both use structured logging where a `Logger` is injected. `GeminiBasePromptCache` constructs its own JSON-stringified output to `console.error`, which works but is a different pattern from sibling classes. This is a minor concern since the class is intentionally decoupled from the adapter's logger.

- **`GeminiBasePromptCache` uses private `#field` syntax while codebase uses `private readonly`** -- `src/implementations/gemini-adapter.ts:25-27` (Confidence: 62%) -- The new `GeminiBasePromptCache` class uses ES2022 private fields (`#cached`, `#cacheDir`, `#warn`, `#ensureCacheLoaded`). The rest of the codebase (e.g., `BaseAgentAdapter`, all repositories, all handlers) uses TypeScript `private readonly` for private members. Both are valid, but using a different access modifier syntax within the same file (`GeminiAdapter` uses `readonly #cache` which is fine, but methods like `#warn`, `#ensureCacheLoaded` differ from the `private method()` pattern elsewhere) creates a stylistic inconsistency.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Consistency Score**: 8/10
**Recommendation**: APPROVED

### Rationale

The incremental changes across these 7 commits are highly consistent with existing codebase patterns:

1. **`@design` to `DECISION:` migration**: All `@design` JSDoc tags have been replaced with `// DECISION:` line comments. Zero `@design` references remain in `src/`. The new tag is used consistently across all 7 changed files.

2. **`v1.4.0` reference cleanup**: All version-specific references in source code have been removed. Comments now describe the feature without pinning it to a version, matching the project's convention for released features.

3. **System prompt threading**: The `systemPrompt` field flows through all four creation paths (DelegateTask, ScheduleTask, SchedulePipeline, CreateLoop, CreateOrchestrator) with consistent Zod schemas, matching `.describe()` text patterns, and correct propagation to task creation.

4. **Adapter pattern consistency**: All three adapters (Claude, Codex, Gemini) implement the same `getSystemPromptConfig` + `cleanup` interface contract. `BaseAgentAdapter` provides the no-op default. `ProcessSpawnerAdapter` also implements the new `cleanup` method.

5. **Test structure**: New tests follow the existing project conventions (describe/it blocks, Result-type assertions with early-return guards, factory pattern for test data).

6. **File permission hardening**: `mode: 0o700` for directories and `mode: 0o600` for files is applied consistently across `agents.ts` and `gemini-adapter.ts`.

7. **Known pitfall PF-006 (paired-interface drift)**: The `cleanup(taskId: string): void` method was added to both the `AgentAdapter` interface AND all implementations (`BaseAgentAdapter`, `ProcessSpawnerAdapter`). This directly addresses the pitfall of interface widening without updating siblings.

The single MEDIUM blocking issue (dash-guard pattern inconsistency) is an intentional design choice that is well-tested. The suggestions are all in the 60-79% confidence range and do not block the PR.
