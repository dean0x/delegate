# Performance Review Report

**Branch**: feat/orchestrator-mode -> main
**Date**: 2026-03-27
**PR**: #123

## Issues in Your Changes (BLOCKING)

### HIGH

**Cleanup creates unprepared statements inside a loop** - `src/implementations/orchestration-repository.ts:223`
**Confidence**: 90%
- Problem: `cleanupOldOrchestrations()` calls `this.db.prepare(...)` inside a transaction callback loop (line 223). Each batch iteration compiles a new SQL statement with a dynamically constructed placeholder list (`WHERE id IN (?,?,?...)`). While this is batched at 500 rows, prepared-statement compilation is not free -- and this runs during server startup recovery on every boot. The existing `cleanupOldLoops` in `loop-repository.ts:371` uses a single pre-compiled `DELETE ... WHERE status IN (...) AND completed_at < ?` statement that returns `changes` count directly, avoiding dynamic statement preparation entirely.
- Fix: Use a pre-prepared DELETE statement with the same WHERE clause as the cleanup SELECT, or loop with the existing `deleteStmt`:
  ```typescript
  // Option A: Single pre-prepared statement (preferred, matches loop-repository pattern)
  // In constructor:
  this.cleanupDeleteStmt = this.db.prepare(`
    DELETE FROM orchestrations
    WHERE status IN ('completed', 'failed', 'cancelled') AND completed_at < ?
  `);

  // In cleanupOldOrchestrations():
  // First SELECT to get file paths, then DELETE with single prepared stmt
  const rows = this.cleanupStmt.all(cutoff) as Array<{ id: string; state_file_path: string }>;
  if (rows.length === 0) return 0;
  const result = this.cleanupDeleteStmt.run(cutoff);
  // Then async file cleanup with Promise.allSettled...

  // Option B: Loop with existing deleteStmt inside a transaction
  const deleteTx = this.db.transaction((ids: string[]) => {
    for (const id of ids) {
      this.deleteStmt.run(id);
    }
  });
  deleteTx(ids);
  ```

### MEDIUM

**Synchronous file I/O in CLI status path with unbounded state file** - `src/cli/commands/orchestrate.ts:160-171`
**Confidence**: 82%
- Problem: `handleOrchestrateStatus()` calls `readStateFile()` which uses `readFileSync` on the state file path. The state file format includes an unbounded `context: Record<string, unknown>` field and a `plan` array, both of which grow over the orchestration lifetime. For long-running orchestrations with many plan steps and accumulated context, this file could grow significantly. In the CLI context (short-lived process), this is tolerable, but it sets up a pattern that could be problematic if reused in server contexts.
- Fix: Acceptable for CLI use. Document the CLI-only constraint. If the function is ever used in a long-lived server context, switch to `fs.promises.readFile`.

**Detach-mode polling reads entire log file on every tick** - `src/cli/detach-helpers.ts:120`
**Confidence**: 80%
- Problem: `pollLogFileForId()` calls `readFileSync(logFile, 'utf-8')` on every 200ms poll tick (up to 75 times = 15 seconds). Each call re-reads the entire file from the start. As the background process writes bootstrap logs, the file grows and each read gets progressively larger. Additionally, `content.match(idPattern)` and `errorPattern.test(content)` scan the full content on each tick.
- Fix: This is a CLI UX path (not server hot path) with a 15-second max window. The file during the pre-ID phase is typically small (a few KB of bootstrap output). This is an existing pattern refactored from `run.ts` (not introduced by this PR), so not a regression. If the background process becomes chatty, consider tracking file offset and only reading new bytes.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`writeExitConditionScript` overwrites shared file on every orchestration creation** - `src/core/orchestrator-state.ts:126-136`
**Confidence**: 85%
- Problem: `writeExitConditionScript()` writes `check-complete.js` to the shared state directory (`~/.autobeat/orchestrator-state/`) on every `createOrchestration()` call. The script is identical for all orchestrations (the actual state path is passed via `process.argv[2]`). If two orchestrations are created concurrently (via parallel MCP calls), one write could partially overwrite while a third process is reading it. The file write includes `writeFileSync` (not atomic) and `mkdirSync`.
- Fix: Add an existence check before writing:
  ```typescript
  import { existsSync } from 'fs';

  export function writeExitConditionScript(dir: string, stateFilePath: string): string {
    const scriptPath = path.join(dir, 'check-complete.js');
    if (existsSync(scriptPath)) return scriptPath;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const script = `...`;
    writeFileSync(scriptPath, script, { encoding: 'utf-8', mode: 0o700 });
    return scriptPath;
  }
  ```

**Zod `.parse()` called on every row read from SQLite** - `src/implementations/orchestration-repository.ts:287`
**Confidence**: 82%
- Problem: `rowToOrchestration()` calls `OrchestrationRowSchema.parse(row)` for every row returned from SQLite. When `findAll()` or `findByStatus()` return up to 100 rows (the default limit), this invokes full Zod schema validation 100 times. However, this is consistent with the project's existing pattern -- every other repository does the same (`TaskRowSchema.parse`, `LoopRowSchema.parse`, `ScheduleRowSchema.parse`, etc.). The project has made a deliberate "parse, don't validate" architectural decision. Orchestrations are low-volume (tens, not thousands), so the impact is negligible.
- Fix: No change needed for consistency. The Zod validation cost is acceptable at current volume. If performance becomes measurable at scale, this could be addressed project-wide rather than for this single repository.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**PF-005 (Known Pitfall): `getResetTargetSha` O(n) iteration scan** - `src/services/handlers/loop-handler.ts`
**Confidence**: 95%
- Problem: Already documented in `.memory/knowledge/pitfalls.md` (PF-005). Fetches up to 100 iterations for a linear scan to find the best iteration's commit SHA. This PR does not modify this code path, but it is in the same file that was touched for the LoopHandler deps refactor.
- Fix: Documented as tech debt in pitfalls.md. Requires domain change + DB migration.

**PF-006 (Known Pitfall): `commitAllChanges` spawns 4 sequential git processes** - `src/utils/git-state.ts`
**Confidence**: 95%
- Problem: Already documented in `.memory/knowledge/pitfalls.md` (PF-006). ~120-240ms overhead per successful iteration. This PR does not modify git-state.ts.
- Fix: Deferred per pitfalls.md -- parsing git commit stdout is fragile across versions.

## Suggestions (Lower Confidence)

- **`Object.freeze()` on every domain object creation** - `src/core/domain.ts:665,688` (Confidence: 65%) -- `Object.freeze()` has measurable overhead on V8. However, the project uses this pattern consistently for all domain objects, and orchestrations are low-volume. Not worth changing unless profiled.

- **Redundant `mkdirSync` calls in state file creation flow** - `src/services/orchestration-manager.ts:103` and `src/core/orchestrator-state.ts:97` (Confidence: 70%) -- `mkdirSync` with `recursive: true` is called in `createOrchestration()` then again inside `writeStateFile()`. The second call is defensive. Minor overhead, defensive design is reasonable.

- **Loop prompt length limit removed** - `src/services/loop-manager.ts:55-60` (Confidence: 60%) -- The 4000-character prompt validation was removed from `validateCreateRequest()`. The orchestrator prompt with a large goal (up to 8000 chars) plus the template could produce a very long prompt. If there is no downstream limit enforced by the agent adapters, this could cause unexpected behavior or token waste.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 2 | 0 |

**Performance Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The new orchestrator mode is well-architected from a performance perspective. Key positives:
- Repository uses pre-prepared statements for all hot-path operations (save, update, find)
- Database indexes on `status` and `loop_id` for query performance
- Proper pagination with configurable limits and defaults
- OrchestrationHandler uses synchronous transactions for atomic status updates
- Cleanup uses batch processing with transaction wrapping
- Deps-object refactoring across handlers/services is purely structural with no performance impact

The one HIGH finding (dynamic `db.prepare()` in cleanup) should be fixed before merge to maintain the project's established pattern of pre-prepared statements. The MEDIUM findings are tolerable given the current usage patterns (CLI-only file reads, low-volume orchestrations).

Conditions for approval:
- Fix `cleanupOldOrchestrations` to use a pre-prepared DELETE statement instead of dynamic `IN (...)` construction (HIGH, 90% confidence)
