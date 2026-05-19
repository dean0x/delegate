# Performance Review Report

**Branch**: feat/134-system-prompt-support -> main
**Date**: 2026-04-17T22:18
**Scope**: Incremental review (7 commits since ef16f93b)

## Issues in Your Changes (BLOCKING)

### HIGH

**Synchronous file I/O in spawn hot path (GeminiBasePromptCache.buildCombinedFile)** - `src/implementations/gemini-adapter.ts:37-59`
**Confidence**: 85%
- Problem: `buildCombinedFile()` calls `mkdirSync()` and `writeFileSync()` on every Gemini task spawn that has a system prompt. Additionally, `#ensureCacheLoaded()` calls `existsSync()`, `statSync()`, and `readFileSync()` on the first call. These are blocking I/O operations in the worker pool's `spawn()` path. While the read is cached after first load (good improvement from prior version), the directory creation and file write happen on every spawn. Under concurrent Gemini task spawning (e.g., orchestrator with maxWorkers=5, all using systemPrompt), these synchronous writes serialize on the event loop.
- Fix: The write is necessary before the child process starts (it needs the file), so async I/O is not straightforward here. However, `mkdirSync` can be hoisted to the constructor (create once, not per-call) since the cache directory is stable:
  ```typescript
  constructor(cacheDir = path.join(os.homedir(), '.autobeat', 'system-prompts')) {
    this.#cacheDir = cacheDir;
    mkdirSync(this.#cacheDir, { recursive: true, mode: 0o700 });
  }

  buildCombinedFile(systemPrompt: string, outputPath: string): string | null {
    // ... omit mkdirSync here ...
    writeFileSync(outputPath, combined, { encoding: 'utf8', mode: 0o600 });
    return outputPath;
  }
  ```
  This removes one sync syscall per spawn. The remaining `writeFileSync` is acceptable since the child process needs the file to exist before `execvp`.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Agent registry lookup on every cleanup call** - `src/implementations/event-driven-worker-pool.ts:308-311`
**Confidence**: 82%
- Problem: `cleanupWorkerState()` calls `this.agentRegistry.get(worker.task.agent)` on every worker completion when a system prompt is present. While `agentRegistry.get()` is likely a Map lookup (O(1)), this is unnecessary indirection in the completion hot path. The adapter instance was already resolved during `spawn()` but is not retained.
- Fix: Store the adapter reference on the `WorkerState` during `registerWorker()` so cleanup can call `adapter.cleanup(taskId)` directly without re-resolving:
  ```typescript
  // In WorkerState interface:
  adapter?: AgentAdapter;

  // In registerWorker():
  worker.adapter = adapter;

  // In cleanupWorkerState():
  if (worker?.task.systemPrompt && worker.adapter) {
    worker.adapter.cleanup(taskId);
  }
  ```
  This eliminates a Map lookup per completion and is more explicit about the relationship.

## Pre-existing Issues (Not Blocking)

No pre-existing CRITICAL performance issues found in the touched files.

## Suggestions (Lower Confidence)

- **Redundant `mkdirSync` in `refreshBasePrompt` CLI command** - `src/cli/commands/agents.ts:242` (Confidence: 65%) -- The directory is created with `mode: 0o700` during the `refreshBasePrompt` command. The `GeminiBasePromptCache.buildCombinedFile` also calls `mkdirSync` with the same mode on every spawn. If the constructor hoists `mkdirSync` per the above fix, the CLI command's mkdir becomes redundant when both paths share the same directory. Low impact since `refreshBasePrompt` is a one-shot CLI command.

- **`Buffer.byteLength` called on every Gemini spawn with system prompt** - `src/implementations/gemini-adapter.ts:48` (Confidence: 62%) -- The combined prompt size check calls `Buffer.byteLength(combined, 'utf8')` on every spawn. For typical system prompts this is negligible (microseconds), but if the base cache is large (e.g., 40KB), this does a full string scan each time. Could be optimized by caching the base prompt byte length and only computing the delta, but the absolute cost is small.

## Pitfall Cross-Check

Reviewed PF-001 through PF-009 against this diff:

- **PF-004 (Prepared statement caching)**: No new repository query methods were added in this incremental diff. The `system_prompt` column addition (migration v23) is a simple ALTER TABLE, no new queries. No regression.
- **PF-006 (Paired-interface drift)**: The new `cleanup(taskId)` method was added to `AgentAdapter` interface, `BaseAgentAdapter` (default no-op), `ProcessSpawnerAdapter` (no-op), and `GeminiAdapter` (override). All implementations are present -- no interface drift.
- Other pitfalls (PF-001, PF-002, PF-003, PF-005, PF-007, PF-008, PF-009) do not overlap with files in this incremental diff.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 0 | - |
| Should Fix | - | 0 | 1 | - |
| Pre-existing | - | - | 0 | 0 |

**Performance Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The performance profile of this incremental diff is solid overall. The in-memory caching of the Gemini base prompt (replacing per-call `readFileSync`) is a clear improvement over the prior version. The one blocking HIGH issue (`mkdirSync` per spawn) is a straightforward optimization. The worker pool cleanup path works correctly but could avoid an unnecessary registry lookup. No N+1 queries, no unbounded caches, no sequential-when-parallel-possible patterns were introduced.
