# Performance Review Report

**Branch**: HEAD (feat/system-prompt-support) -> main
**Date**: 2026-04-17T16:41

## Issues in Your Changes (BLOCKING)

### HIGH

**Synchronous file I/O in spawn hot path (Gemini adapter)** - `src/implementations/gemini-adapter.ts:61-81`
**Confidence**: 90%
- Problem: `getSystemPromptConfig()` performs three synchronous filesystem operations on the spawn path: `existsSync()` (line 61), `statSync()` (line 63), `readFileSync()` (line 76), plus `mkdirSync()` (line 80) and `writeFileSync()` (line 81). The `spawn()` method in `BaseAgentAdapter` is already synchronous (returns `Result`, not `Promise<Result>`), so these calls block the Node.js event loop during task spawn. While a single spawn is not a hot path, orchestrations spawning multiple Gemini tasks in quick succession (maxWorkers up to 20) will serialize all spawn I/O. The `readFileSync` of the base cache file could be significant if the Gemini base prompt is large.
- Impact: Event loop blocked for ~1-5ms per spawn (existsSync + statSync + readFileSync + mkdirSync + writeFileSync). With 20 concurrent Gemini spawns, this serializes into 20-100ms of blocked event loop time, delaying heartbeat timers, event bus emissions, and dashboard polling callbacks.
- Fix: Cache the base prompt content in-memory on first read (it changes only when `refresh-base-prompt` is run). This eliminates `existsSync`, `statSync`, and `readFileSync` on every spawn:

```typescript
export class GeminiAdapter extends BaseAgentAdapter {
  private baseCacheContent: string | null | undefined; // undefined = not loaded yet

  private loadBaseCache(): string | null {
    if (this.baseCacheContent !== undefined) return this.baseCacheContent;
    const baseCachePath = path.join(os.homedir(), '.autobeat', 'system-prompts', 'gemini-base.md');
    try {
      if (!existsSync(baseCachePath)) {
        this.baseCacheContent = null;
        return null;
      }
      this.baseCacheContent = readFileSync(baseCachePath, 'utf8');
      // Check staleness once at load time
      const stat = statSync(baseCachePath);
      if (Date.now() - stat.mtimeMs > 30 * 24 * 60 * 60 * 1000) {
        console.error(JSON.stringify({ level: 'warn', message: '...' }));
      }
      return this.baseCacheContent;
    } catch {
      this.baseCacheContent = null;
      return null;
    }
  }
}
```

The `writeFileSync` for the combined prompt file is harder to avoid since the file must exist before `spawn()` starts the child process. This is acceptable as a single small write per spawn.

---

**Synchronous `unlinkSync` on every worker cleanup regardless of systemPrompt** - `src/implementations/event-driven-worker-pool.ts:305-312`
**Confidence**: 92%
- Problem: `cleanupWorkerState()` unconditionally calls `unlinkSync(systemPromptPath)` for every task completion, even when the task had no system prompt (the vast majority of tasks). The `try/catch` silences the `ENOENT` error, but `unlinkSync` still makes a synchronous syscall that blocks the event loop. This runs on the worker completion callback path, which also emits `TaskCompleted`/`TaskFailed` events.
- Impact: Every single task completion pays the cost of a failed synchronous filesystem syscall. With 1Hz dashboard polling and multiple concurrent workers completing, this adds unnecessary event loop stalls. The syscall overhead is small (~0.1ms) but it is pure waste for tasks without systemPrompt.
- Fix: Guard the unlink behind a check for whether systemPrompt was actually set on the task:

```typescript
// Only attempt cleanup if the task had a system prompt
const task = this.workers.get(workerId)?.task;
if (task?.systemPrompt) {
  const systemPromptPath = path.join(os.homedir(), '.autobeat', 'system-prompts', `${taskId}.md`);
  try {
    unlinkSync(systemPromptPath);
  } catch {
    // File may not exist (Gemini used prependToPrompt fallback)
  }
}
```

Note: The worker lookup must happen BEFORE `this.workers.delete(workerId)` on line 295. Move the cleanup block above the delete, or capture the task reference earlier.

### MEDIUM

**system_prompt TEXT column fetched in all SELECT queries including dashboard 1Hz polling** - `src/implementations/task-repository.ts:142,150,158,174,185,199`
**Confidence**: 82%
- Problem: The `system_prompt` column (up to 16KB per task) is now included in every SELECT query: `findById`, `findAllUnbounded`, `findByStatus`, `findAllPaginated`, `findUpdatedSince`, and `findByOrchestratorId`. The dashboard polls via `findAll(FETCH_LIMIT=100)` and `findUpdatedSince` at 1Hz. For most use cases, the system prompt is never displayed (it requires explicit `includeSystemPrompt: true`). This means up to 100 * 16KB = 1.6MB of TEXT data is read from SQLite and parsed through Zod on every dashboard tick, only to be discarded.
- Impact: Increased SQLite I/O and memory allocation on the 1Hz polling path. With PF-001 (known pitfall: 1Hz polling amplifies query cost), this compounds existing pressure. The TEXT column forces SQLite to read overflow pages for rows where system_prompt exceeds the page-internal threshold (~2KB depending on page size).
- Fix: Consider a projection optimization: define separate prepared statements for "lightweight" queries (dashboard, status listing) that omit `system_prompt`, and "full" queries (single-task detail with includeSystemPrompt) that include it. Alternatively, accept this as a known tradeoff documented with a TODO. The system_prompt column is nullable and will be NULL for the majority of tasks, so SQLite stores it as a single NULL byte in those rows -- the actual impact is only for tasks that have system prompts set.

**Amended assessment**: Since most tasks will have `system_prompt = NULL`, SQLite stores this as a single byte per row. The real cost materializes only when many tasks have large system prompts. This reduces the practical severity. Recommend adding a `TODO` comment documenting the tradeoff and deferring the projection split unless profiling shows measurable impact.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Gemini base prompt file read on every spawn -- no in-memory caching** - `src/implementations/gemini-adapter.ts:76`
**Confidence**: 85%
- Problem: Every Gemini task spawn with a system prompt reads `~/.autobeat/system-prompts/gemini-base.md` from disk. The base prompt is static between `refresh-base-prompt` invocations. The file could be cached in a class instance field and invalidated only when the user runs `refresh-base-prompt`.
- Impact: Redundant disk I/O per Gemini spawn. The file is likely small (a few KB), but it is read synchronously, blocking the event loop.
- Fix: See the in-memory caching suggestion in the BLOCKING HIGH finding above. Same fix addresses both issues.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**PF-004 overlap: `findByOrchestratorId` with status filter still uses inline `db.prepare()`** - `src/implementations/task-repository.ts:443-451`
**Confidence**: 80%
- Problem: The status-filtered branch of `findByOrchestratorId` creates a new prepared statement on each call (`this.db.prepare(...)`). This was documented in PF-004 (known pitfall). The new `system_prompt` column was correctly added to this query (line 447), but the underlying per-call prepare pattern remains.
- Impact: Wasted CPU on statement compilation. Not in the 1Hz hot path (only drill-through view), so lower urgency.

## Suggestions (Lower Confidence)

- **`refreshBasePrompt` uses `spawnSync` with 30s timeout** - `src/cli/commands/agents.ts:250-260` (Confidence: 65%) -- This is a CLI command (not a hot path), so `spawnSync` is acceptable. However, if the gemini CLI hangs, the 30s timeout blocks the entire CLI process. Consider noting this is intentional for CLI context.

- **system_prompt serialization in MCP JSON responses** - `src/adapters/mcp-adapter.ts:1726` (Confidence: 70%) -- The `includeSystemPrompt` flag correctly gates serialization in TaskStatus and LoopStatus responses. No performance concern when the flag is false (default). When true, a single large systemPrompt (up to 16KB) is serialized once. This is a non-issue.

- **`agents.ts` refresh-base-prompt: `readFileSync` + `writeFileSync` in CLI command** - `src/cli/commands/agents.ts:286,296` (Confidence: 60%) -- These sync calls are in a one-shot CLI command that exits immediately. No performance concern.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Performance Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

### Rationale

The two HIGH findings are both actionable and have clear fixes:

1. **Gemini adapter sync I/O**: The `readFileSync` + `statSync` + `existsSync` on every Gemini spawn should be replaced with in-memory caching. The base prompt changes only when the user explicitly runs `refresh-base-prompt`. A single class-level cache eliminates 3 syscalls per spawn.

2. **Unconditional `unlinkSync` on worker cleanup**: Every task completion -- including the vast majority that have no system prompt -- pays the cost of a synchronous filesystem syscall. A simple `if (task?.systemPrompt)` guard eliminates this for the common case.

The MEDIUM finding about `system_prompt` in all SELECT queries is a valid concern but mitigated by the fact that NULL columns are cheap in SQLite. This can be deferred to profiling-driven optimization.

Overall the feature is well-designed with good performance awareness (the `includeSystemPrompt` opt-in flag on status queries, the fallback-to-prepend pattern for Gemini). The issues above are incremental improvements to an already reasonable approach.
