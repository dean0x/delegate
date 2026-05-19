# Consistency Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17
**Diff**: `git diff 1bec153be5..40f9537` (6 incremental commits)

## Issues in Your Changes (BLOCKING)

### HIGH

**cleanup() Result silently discarded (4 occurrences)** -- Confidence: 90%
- `src/implementations/tmux/tmux-connector.ts:185`, `src/implementations/tmux/tmux-connector.ts:218`, `src/implementations/tmux/tmux-connector.ts:255`, `src/implementations/tmux/tmux-connector.ts:576`
- Problem: `TmuxHooks.cleanup()` returns `Result<void, AutobeatError>` but all four call sites discard the result without checking or logging. This violates the project's Result-type pattern (CLAUDE.md: "Always use Result types") -- if a method returns a Result, the caller should handle both arms. The `destroy()` path at line 218 and `triggerExit()` at line 576 could silently fail to remove a session directory with no diagnostic trace. This is inconsistent with how the connector handles errors from `sessionManager.destroySession()` in `dispose()` (lines 249-254), where a failed result IS logged.
- Fix: At minimum, log a warning when cleanup fails, matching the dispose() pattern:
  ```typescript
  const cleanupResult = this.deps.hooks.cleanup(handle.taskId, handle.sessionsDir);
  if (!cleanupResult.ok) {
    this.deps.logger.warn('cleanup failed', {
      taskId: handle.taskId,
      error: cleanupResult.error.message,
    });
  }
  ```

### MEDIUM

**SAFE_PATH_REGEX defined in tmux-hooks.ts but TASK_ID_REGEX defined in types.ts -- inconsistent placement** -- Confidence: 82%
- `src/implementations/tmux/tmux-hooks.ts:35` vs `src/implementations/tmux/types.ts:228`
- Problem: Both `TASK_ID_REGEX` and `SAFE_PATH_REGEX` serve the same purpose -- input validation regexes for security. `TASK_ID_REGEX` is exported from `types.ts` (the canonical constants location) and re-exported via `index.ts`. `SAFE_PATH_REGEX` is a module-scoped constant in `tmux-hooks.ts`, not exported. This creates an inconsistency: if another module needs to validate a sessions path, it cannot reuse `SAFE_PATH_REGEX`. The convention established by `SESSION_NAME_REGEX` and `TASK_ID_REGEX` is to define validation regexes in `types.ts`.
- Fix: Move `SAFE_PATH_REGEX` to `types.ts` alongside the other validation regexes. Export it from `index.ts` for symmetry.

**TASK_ID_REGEX not exported from index.ts** -- Confidence: 85%
- `src/implementations/tmux/index.ts:34-42`
- Problem: `TASK_ID_REGEX` is defined and exported from `types.ts` (line 228) and imported by `tmux-hooks.ts`, but it is not re-exported from `index.ts`. All other validation constants (`SESSION_NAME_REGEX`, `SESSION_NAME_PREFIX`, `SENTINEL_DONE`, `SENTINEL_EXIT`) are re-exported through `index.ts`. This breaks the module's public API convention -- consumers outside the tmux directory cannot access this regex through the barrel export.
- Fix: Add `TASK_ID_REGEX` to the constants re-export block in `index.ts`:
  ```typescript
  export {
    DEFAULT_STALENESS_CONFIG,
    MAX_CONCURRENT_SESSIONS,
    SENTINEL_DONE,
    SENTINEL_EXIT,
    SESSION_NAME_PREFIX,
    SESSION_NAME_REGEX,
    TASK_ID_REGEX,
  } from './types.js';
  ```

**Tests `await` a synchronous spawn() method** -- Confidence: 80%
- `tests/unit/implementations/tmux/tmux-connector.test.ts:166`, and ~30 other call sites
- Problem: `TmuxConnector.spawn()` returns `Result<TmuxHandle, AutobeatError>` (synchronous, not a Promise). Every test in the file uses `await connector.spawn(...)`. While `await` on a non-Promise is harmless at runtime (it resolves immediately), it signals to readers that the method is async when it is not. This creates a misleading API contract in tests. Note: this pattern existed before these 6 commits but was reinforced by the new test cases added in this diff (lines 288-321, 453-481).
- Fix: Remove `await` from `connector.spawn()` calls and change test callbacks from `async () =>` to `() =>` where spawn is the only async-looking call. The tests that genuinely need `async` (for `sleep()` or `vi.waitFor()`) should keep `async` but drop the `await` on `spawn`.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**SESSIONS_DIR comment in tmux-hooks.ts says "double-quoted" but code uses single quotes** -- Confidence: 88%
- `src/implementations/tmux/tmux-hooks.ts:10`
- Problem: The module-level JSDoc says "All paths embedded in the generated script are double-quoted to prevent word splitting and glob expansion." However, the security fix in this diff correctly changed `SESSIONS_DIR="${sessionDir}"` to `SESSIONS_DIR='${sessionDir}'` (single-quoted, line 85). The JSDoc header at line 10 is now stale and misleading -- it claims double-quoting when the code uses single-quoting.
- Fix: Update line 10 to: `* SECURITY: The SESSIONS_DIR path is single-quoted to prevent variable interpolation.`

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **escapeSingleQuoted is duplicated** - `src/implementations/tmux/tmux-session-manager.ts:45` (Confidence: 65%) -- The function is a module-scoped utility in `tmux-session-manager.ts`. If any future module (e.g., connector or hooks) needs the same escaping logic, it would be duplicated. Consider extracting to a shared util. Currently only one consumer, so not blocking.

- **SESSION_NAME_REGEX allows underscores in TASK_ID_REGEX but not in session names** - `src/implementations/tmux/types.ts:221,228` (Confidence: 70%) -- `TASK_ID_REGEX` is `/^[a-z0-9][a-z0-9_-]*$/` (allows underscores), but `SESSION_NAME_REGEX` is `/^beat-[a-z0-9-]+$/` (no underscores). Session names are derived from task IDs with `beat-` prefix, so a task ID like `task_abc` would pass TASK_ID validation but the resulting `beat-task_abc` would fail SESSION_NAME validation. May be intentional constraint or a gap.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Consistency Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The primary consistency concern (avoids PF-001) is the silent discard of `cleanup()` Result values at 4 call sites, which contradicts the project's strict Result-type handling pattern. The connector correctly handles `destroySession()` errors in `dispose()` with a logged warning but ignores the structurally identical `cleanup()` errors everywhere. The remaining findings are medium-severity naming/placement inconsistencies that should be addressed while the tmux module is actively being built.
