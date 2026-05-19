# Security Review Report

**Branch**: feat/134-system-prompt-support -> main
**Date**: 2026-04-18
**Diff**: `git diff abbd413...HEAD` (13 files, +565/-22 lines)

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`buildCombinedFile` outputPath not validated against path traversal** - `src/implementations/gemini-adapter.ts:40`
**Confidence**: 65%
- Problem: `buildCombinedFile(systemPrompt, outputPath)` writes the combined content to `outputPath` via `writeFileSync` without validating that `outputPath` is within the expected `cacheDir`. While the caller (`base-agent-adapter.ts:195`) constructs `outputPath` from `os.homedir() + taskId` (where taskId is a UUID-based string), the method signature accepts an arbitrary `string`. If a future caller passes an attacker-controlled path, arbitrary file write would be possible.
- Fix: Apply the same `path.resolve` + `startsWith` guard used in `cleanupTaskFile` to `buildCombinedFile`'s `outputPath` parameter. Since the caller already constructs the path within the same directory, this is defense-in-depth rather than an active exploit vector today.

## Suggestions (Lower Confidence)

- **`systemPrompt` not size-bounded at input boundary** - `src/services/orchestration-manager.ts:228`, `src/services/schedule-manager.ts:75` (Confidence: 65%) -- The `systemPrompt` field accepted from MCP tools and CLI is not validated for maximum length. While `goal` is capped at 8000 chars and Gemini's combined prompt has a 64KB guard, a very large systemPrompt could increase memory pressure or token cost. Consider adding a Zod `.max()` constraint at the boundary (MCP adapter/CLI) for consistency with the goal field's validation pattern.

- **`operationalContract` injected into user prompt could be overridden by user** - `src/services/orchestration-manager.ts:233` (Confidence: 60%) -- When a user provides a custom `systemPrompt`, the `operationalContract` is prepended to the user prompt. A carefully crafted `systemPrompt` could instruct the agent to ignore the operational contract, potentially bypassing state file management. This is an inherent LLM prompt-injection consideration rather than a code vulnerability, and the current approach of prepending the contract before the goal is a reasonable mitigation.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Security Score**: 9/10
**Recommendation**: APPROVED

## Analysis Notes

### Positive Security Patterns Observed

1. **Path traversal guard on file deletion** (`gemini-adapter.ts:66-69`): The `cleanupTaskFile` method correctly resolves the constructed file path and validates it starts with the expected cache directory before calling `unlinkSync`. This is defense-in-depth since taskIds are UUIDs, but protects against future misuse.

2. **Restrictive file permissions** (`gemini-adapter.ts:32`): Cache directory created with `mode: 0o700` and combined files written with `mode: 0o600`, preventing other users on multi-tenant systems from reading system prompts.

3. **try/catch around adapter cleanup** (`event-driven-worker-pool.ts:310-316`): The cleanup call is wrapped in try/catch so a throwing adapter cannot prevent worker state cleanup, avoiding resource leaks.

4. **Size guard on combined prompts** (`gemini-adapter.ts:53-58`): The 64KB limit on combined prompt prevents OOM from corrupt or excessively large cache files.

5. **Input validation maintained**: Working directory validation via `validatePath()` is applied in both `orchestration-manager.ts` and `schedule-manager.ts`. Path-validated cleanup helper in orchestration-manager prevents traversal attacks on state file deletion.

6. **No hardcoded secrets**: All configuration flows through dependency injection and environment variables. No API keys, tokens, or credentials appear in the diff.

7. **Zod schemas updated**: The `TaskRequestSchema` and `LoopConfigSchema` in `schedule-repository.ts` correctly include `systemPrompt: z.string().optional()`, ensuring the field survives DB round-trips with proper validation.

8. **SQL injection safe**: All database operations use parameterized queries via better-sqlite3's prepared statements. The new `systemPrompt` field is serialized as part of JSON blobs stored in existing columns, not interpolated into SQL.
