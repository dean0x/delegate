# Performance Review Report

**Branch**: feat/134-system-prompt-support -> main
**Date**: 2026-04-20

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Removal of all string length limits on MCP schema inputs creates unbounded memory allocation risk** - `src/adapters/mcp-adapter.ts:49,104,112,141,146,217,248,291,342,347,354,404,410,443,448,455,488`
**Confidence**: 82%
- Problem: This PR removes `.max()` constraints from 16+ Zod schema fields (prompt, systemPrompt, jsonSchema, goal, exitCondition, evalPrompt, judgePrompt, additionalContext). Previously, prompts were capped at 4,000 chars, goals at 8,000, and system prompts at 16,000. Now there is no upper bound on any string field entering the MCP layer. An LLM caller could send a 100MB prompt string that survives Zod parsing and gets allocated into memory, passed to domain logic, stored in SQLite, and injected into CLI args. The Gemini adapter has a 64KB guard on the combined file but individual prompt and systemPrompt strings have no limit before reaching that guard. The `Buffer.byteLength` check in `GeminiBasePromptCache.buildCombinedFile` only catches the combined size, not the input string alone.
- Fix: Add a reasonable upper bound to each field. If the prior limits were too restrictive, raise them rather than removing them entirely. For example:
  ```typescript
  prompt: z.string().min(1).max(100_000),  // 100KB
  systemPrompt: z.string().max(100_000).optional(),
  goal: z.string().min(1).max(100_000),
  jsonSchema: z.string().max(100_000).optional(),
  ```
  This preserves the MCP boundary validation principle (validate at boundaries) while being generous enough for real workloads.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Synchronous writeFileSync in spawn request path blocks the event loop** - `src/implementations/gemini-adapter.ts:68`
**Confidence**: 80%
- Problem: `GeminiBasePromptCache.buildCombinedFile()` calls `writeFileSync()` on line 68, which is invoked during the synchronous `spawn()` method in `BaseAgentAdapter`. While the file is small (up to 64KB due to the MAX_COMBINED_PROMPT_BYTES guard), this synchronous write occurs in the spawn path for every Gemini task with a system prompt. In a scenario where multiple Gemini tasks with system prompts are being spawned concurrently, this blocks the Node.js event loop for each write. This is a pre-existing pattern (not introduced by this PR) but the PR adds a new path-traversal guard (line 50-56) and touches this method, making it the right time to note.
- Fix: This is constrained by the synchronous `spawn()` return type (`Result<...>` not `Promise<Result<...>>`). A future refactor could make spawn async, but for now the 64KB guard keeps this bounded and acceptable. No action required in this PR; noting for future reference.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Synchronous I/O chain in GeminiBasePromptCache.#ensureCacheLoaded** - `src/implementations/gemini-adapter.ts:90-111`
**Confidence**: 80%
- Problem: `#ensureCacheLoaded()` calls `existsSync()`, `statSync()`, and `readFileSync()` sequentially. This is mitigated by the in-memory cache (first call loads, subsequent calls are no-ops) but the initial load on the first Gemini spawn with a system prompt will block the event loop for the full stat + read cycle.
- Impact: Low in practice since this happens once per process lifetime and the file is small (base prompt cache).

**Synchronous mkdirSync and unlinkSync in orchestration-manager.ts** - `src/services/orchestration-manager.ts:105,137`
**Confidence**: 80%
- Problem: `mkdirSync` during orchestration creation and `unlinkSync` during cleanup are synchronous filesystem operations in an async method. The directory creation happens once per orchestration, and the cleanup writes are bounded and small.
- Impact: Low in practice given the bounded number of concurrent orchestrations.

## Suggestions (Lower Confidence)

- **Closure capture in cleanupFn retains adapter reference** - `src/implementations/event-driven-worker-pool.ts:129` (Confidence: 65%) -- The `cleanupFn` closure captures the `adapter` reference at spawn time. This means the adapter object cannot be GC'd while any worker with a system prompt is alive. For long-running workers this keeps the adapter (and its GeminiBasePromptCache including the cached base prompt string) in memory. In practice this is negligible since the adapter is typically a singleton registered in the registry, but worth noting for correctness.

- **String concatenation for large prompts in orchestrator-prompt.ts** - `src/services/orchestrator-prompt.ts:58-82` (Confidence: 62%) -- The `buildOrchestratorPrompt` function builds the system prompt via template literals with multiple interpolated sections. With the removal of size limits, if a very large goal or system prompt is provided, this creates intermediate strings. Template literals in V8 are well-optimized, so this is unlikely to be a practical issue.

- **Unbounded prompt passthrough to CLI args** - `src/implementations/base-agent-adapter.ts:210,252` (Confidence: 70%) -- With string limits removed, very large prompts are now passed directly as CLI arguments via `spawn()`. Most OS shells have a `MAX_ARG_STRLEN` limit (~128KB on Linux, ~262KB on macOS). A prompt exceeding this limit would cause `spawn()` to fail with E2BIG. Adding a size check before spawn would produce a clearer error message.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 2 | 0 |

**Performance Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The core performance characteristics of this PR are sound. The cleanupFn closure pattern eliminates a registry lookup at cleanup time, the shared prompt fragments in orchestrator-prompt.ts reduce duplication, and the 64KB guard on combined Gemini prompts is appropriate. The primary concern is the removal of all string length limits on MCP inputs, which removes the boundary validation defense against unbounded memory allocation. Replacing the removed limits with generous-but-bounded maximums would address this without restricting legitimate use.
