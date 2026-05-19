# Architecture Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17
**Focus**: Architecture — Design Bugs That Manifest as Runtime Failures

## Issues in Your Changes (BLOCKING)

### HIGH

**Inconsistent escaping strategy for env var values — over-escapes backslashes in single-quoted context** - `tmux-session-manager.ts:122`
**Confidence**: 92%
- Problem: The `escapeSingleQuoted` function (line 45-47) correctly states that inside single quotes, only single quotes need escaping per POSIX shell rules. However, the env var injection on line 122 uses a DIFFERENT escaping strategy: `.replace(/\\/g, '\\\\').replace(/'/g, "'\\''")`. This double-escapes backslashes that are already literal inside single quotes. An env var value like `C:\Users\path` would be stored as `C:\\Users\\path` in the tmux environment.
- Fix: Use `escapeSingleQuoted` consistently for all single-quoted values:
```typescript
const commands = validEntries
  .map(([key, value]) => {
    return `tmux set-environment -t ${config.name} ${key} '${escapeSingleQuoted(value)}'`;
  })
  .join(' && ');
```

**No filesystem cleanup on destroy/dispose/triggerExit — session directories leak indefinitely** - `tmux-connector.ts:192,220,471`
**Confidence**: 90%
- Problem: `hooks.cleanup(taskId, sessionsDir)` is only called on spawn failure (line 167). After a successful spawn, neither `destroy()`, `dispose()`, nor `triggerExit()` calls `hooks.cleanup()`. This means the task-specific session directory (`wrapper.sh`, `messages/`, `.done`/`.exit`, `.seq`, `.seq.lock`) is never removed. Over time, the sessionsDir accumulates orphaned directories, one per completed task.
- Fix: Add cleanup calls after successful session shutdown. In `destroy()`:
```typescript
destroy(handle: TmuxHandle): Result<void, AutobeatError> {
  const session = this.activeSessions.get(handle.taskId);
  if (session) {
    session.exited = true;
    this.flushPendingFiles(session);
    this.closeSession(session);
    this.activeSessions.delete(handle.taskId);
  }
  const destroyResult = this.deps.sessionManager.destroySession(handle.sessionName);
  // Clean up filesystem artifacts
  this.deps.hooks.cleanup(handle.taskId, handle.sessionsDir);
  return destroyResult;
}
```
Similarly in `dispose()` and `triggerExit()`. Note: `triggerExit` doesn't have access to `sessionsDir` except through `session.handle.sessionsDir` — which is available.

### MEDIUM

**`TmuxSessionResult.taskId` computed by session manager is silently ignored by connector** - `tmux-session-manager.ts:106,130` / `tmux-connector.ts:172-175`
**Confidence**: 82%
- Problem: `DefaultTmuxSessionManager.createSession()` derives `taskId` by stripping the `beat-` prefix from `config.name` (line 106: `config.name.replace(/^beat-/, '')`). This computed `taskId` is included in `TmuxSessionResult`. However, the connector only uses `sessionResult.value.sessionName` (line 174) and ignores `sessionResult.value.taskId`, relying on its own `config.taskId` throughout. If `config.name` doesn't follow the `beat-{taskId}` convention exactly, the session manager's derived taskId would diverge from the connector's. The type system hides this by never requiring them to match.
- Fix: Either remove `taskId` from `TmuxSessionResult` (it adds no value since the connector knows its own taskId), or replace the `replace(/^beat-/, '')` derivation with the caller-supplied taskId. Simplest:
```typescript
export type TmuxSessionResult = { sessionName: string };
```
And remove the taskId derivation from `createSession`.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**WrapperManifest.sessionsDir is misnamed — it's a task-specific session directory, not a sessions directory** - `types.ts:110` / `tmux-hooks.ts:151`
**Confidence**: 80%
- Problem: `WrapperManifest.sessionsDir` is set to `path.join(config.sessionsDir, config.taskId)` (the task-specific directory, e.g., `/tmp/sessions/task-abc`). But the field is named `sessionsDir`, identical to `TmuxSpawnConfig.sessionsDir` (the base directory, e.g., `/tmp/sessions`). This naming confusion creates cognitive overhead and increases the risk of passing the wrong directory to functions. The connector passes `manifest.sessionsDir` to `startWatchers` as `sessionDir` — making the translation, but only because the developer understood the naming mismatch.
- Fix: Rename `WrapperManifest.sessionsDir` to `sessionDir` (singular, task-specific) to distinguish from the base `sessionsDir`.

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **`dispose()` swallows errors without aggregation** - `tmux-connector.ts:230-234` (Confidence: 65%) — When multiple sessions fail to destroy, each error is logged individually but the caller has no signal that disposal was partial. If `dispose()` ever becomes a Result-returning method, this could lead to resource leaks being silent.

- **Debounce timers survive beyond session lifetime in edge cases** - `tmux-connector.ts:280-284` (Confidence: 62%) — If `startWatchers` fires a debounce timer and then `createSession` fails on line 164, `closeSession` is called which clears timers. However, the timer closure captures `session` and `callbacks` — if the timer fires between the fs.watch callback and the `closeSession` call (extremely unlikely in synchronous code, but possible if node event loop drains microtasks), `handleMessageFile` would operate on a partially-constructed session. In practice this is prevented by the synchronous `createSession` return, but the code structure doesn't make this safety guarantee explicit.

- **Sentinel watcher `sessionDir` captured by closure becomes stale if task dirs are moved** - `tmux-connector.ts:252-259` (Confidence: 60%) — The sentinel watcher captures `sessionDir` at watcher-start time. If the underlying directory were relocated (e.g., by a future migration), the sentinel read path would fail silently. This is a theoretical concern — the directory path is fixed for the session lifetime today.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 1 | 0 |
| Should Fix | - | 0 | 1 | 0 |
| Pre-existing | - | - | 0 | 0 |

**Architecture Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The `TmuxSessionResult` narrowing is clean — `sessionsDir` is correctly managed at the connector level and the session manager doesn't need it. The 4-class hierarchy separation is well-designed. The two blocking issues are: (1) an escaping bug that will corrupt backslash-containing env var values at runtime, and (2) a lifecycle gap where session directories accumulate without cleanup, which is a resource leak that worsens proportionally to task throughput.
