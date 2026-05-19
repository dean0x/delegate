# Architecture Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17
**Diff**: `git diff 40f9537...HEAD` (5 files, +250/-71)

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

### MEDIUM

**Mutable handle field in ActiveSession undermines immutable-by-default principle** - `tmux-connector.ts:176-179`
**Confidence**: 82%
- Problem: `session.handle` is mutated in-place after construction via `session.handle = { ...session.handle, sessionName: sessionResult.value.sessionName }`. The `buildActiveSession()` creates the session with `config.name` as `sessionName`, then `spawn()` overwrites it with the value from `sessionManager.createSession()`. This is a pre-existing pattern (not introduced in this diff), but `buildActiveSession()` was extracted in this diff and now formalizes this two-phase construction. The handle field is declared without `readonly`, enabling this mutation. This creates a window where `session.handle.sessionName` is stale (between `startWatchers()` on line 155 and the mutation on line 176-179), and the sentinel watcher captures `taskId` (correct) but uses the pre-mutation `sessionDir` (also correct since that comes from `manifest`), so it works in practice. However, the pattern is fragile: any future code that reads `session.handle.sessionName` between `buildActiveSession()` and the mutation on line 178 would get the wrong value.
- Fix: Accept the actual session name as a parameter to `buildActiveSession()`, or use a builder pattern where the handle is only constructed once with the final session name. Alternatively, make `sessionName` a `let` binding in `spawn()` and construct the handle only after `createSession()` succeeds:
```typescript
// Option A: delay handle construction
const session = this.buildActiveSession(config, manifest.messagesDir, callbacks, sessionResult.value.sessionName);

// Option B: two-step with explicit temporary name
private buildActiveSession(config: TmuxSpawnConfig, messagesDir: string, callbacks: SpawnCallbacks): ActiveSession {
  return {
    handle: {
      sessionName: '', // placeholder, set after createSession
      ...
    },
    ...
  };
}
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Cleanup error-handling pattern repeated 4 times without extraction** - `tmux-connector.ts:165-171`, `tmux-connector.ts:204-210`, `tmux-connector.ts:247-253`, `tmux-connector.ts:629-635`
**Confidence**: 85%
- Problem: The same `hooks.cleanup` + `if (!cleanupResult.ok)` + `logger.warn` pattern appears in `spawn()`, `destroy()`, `dispose()`, and `triggerExit()`. Each call site differs only by the log prefix string and the context object. This is the kind of duplication that introduces inconsistency risk (e.g., one call site might forget to log, or log with a different structure). The pattern was introduced in this diff (previously cleanup was fire-and-forget).
- Fix: Extract a private helper:
```typescript
private cleanupWithLogging(taskId: string, sessionsDir: string, context: string): void {
  const result = this.deps.hooks.cleanup(taskId, sessionsDir);
  if (!result.ok) {
    this.deps.logger.warn(`${context}: hooks.cleanup failed`, {
      taskId,
      error: result.error.message,
    });
  }
}
```
Then call `this.cleanupWithLogging(taskId, sessionsDir, 'spawn')` at each site.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**TmuxConnector class is approaching god-class territory** - `tmux-connector.ts` (662 lines, 18 methods)
**Confidence**: 80%
- Problem: TmuxConnector handles session lifecycle (spawn, destroy, dispose), watcher management (sentinel, messages), message ordering (pending buffer, sequence tracking, dedup), staleness detection (timer, heartbeat), and file I/O (flush, read). This is 5 distinct responsibilities. The class is still manageable at 662 lines, but the extraction of `buildActiveSession()`, `startSentinelWatcher()`, `startMessagesWatcher()`, and `forceDeliverRemaining()` in this diff (while good refactoring) is a sign that it is growing. Each new extraction adds a private method but does not reduce the number of responsibilities.
- Impact: Future changes to message ordering should not require understanding staleness detection, and vice versa. SRP suggests these could be separate collaborators injected via the deps object.
- Note: This is Phase 1 of 10 and purely additive. Flagging for awareness as integration phases add more complexity.

## Suggestions (Lower Confidence)

- **`Date.now()` call in `buildActiveSession` is not injectable** - `tmux-connector.ts:277` (Confidence: 65%) -- `lastAliveCheck: Date.now()` makes the initial timestamp non-deterministic. Consider injecting a `clock` or `now` function via deps for testability of time-dependent staleness scenarios.

- **`handleMessageFile` signature takes both `session` and `callbacks` but `callbacks` is always `session.callbacks`** - `tmux-connector.ts:543` (Confidence: 70%) -- Every call site passes `session.callbacks` as the `callbacks` argument. The parameter could be removed in favor of reading from `session` directly, reducing surface area. Same applies to `deliverSingle` and `deliverPendingMessages`.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Architecture Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The incremental changes are well-structured refactoring: method extraction to reduce `spawn()` complexity, a critical fix for map-mutation-during-iteration in `runSharedStalenessCheck()`, proper error observability on `hooks.cleanup()` calls, and a minimum-interval clamp to prevent tight-loop timers. The dependency direction is clean (connector -> interfaces in types.ts), ISP is respected (TmuxValidator, TmuxSessionManager, TmuxHooks are narrow interfaces), and DIP is consistently applied via constructor injection. The `SAFE_PATH_REGEX` and `TASK_ID_REGEX` constants were correctly moved to `types.ts` and re-exported through the barrel, following the established pattern.

The one blocking concern is the mutable handle pattern formalized by `buildActiveSession()`. The cleanup duplication should be addressed while the pattern is fresh. The god-class note is informational for future phases. No circular dependencies, no layer violations, no ISP violations detected. Avoids PF-001 by surfacing all findings including pre-existing.
