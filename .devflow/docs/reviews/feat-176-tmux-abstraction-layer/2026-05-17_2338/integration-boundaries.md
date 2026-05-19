# Integration Boundary Review

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17
**Reviewer focus**: Integration-boundary correctness across TmuxValidator, TmuxHooks, TmuxSessionManager, and TmuxConnector

## Summary

The four modules compose correctly at their seams. Interface alignment, error propagation, lifecycle ordering, and resource cleanup on failure are all sound. Two lower-priority issues were identified: (1) a stale filesystem artifact edge case where `generateWrapper` does not clear pre-existing sentinel files before starting watchers, and (2) an implicit naming convention between session name and taskId that could cause a misleading `AUTOBEAT_TASK_ID` env var if the convention is violated.

## Findings

### [P2] Stale sentinel files can trigger false exit on respawn after crash

- **Location**: `tmux-connector.ts:189-190` (watcher start) + `tmux-hooks.ts:180-184` (directory creation)
- **Description**: `generateWrapper` uses `mkdirSync({ recursive: true })` which is non-destructive -- it does not remove existing files. If a previous process crashed without running `hooks.cleanup`, the session directory may contain a leftover `.done` or `.exit` sentinel. When `startWatchers` is called (line 190), the sentinel watcher watches the session directory. On some platforms, `fs.watch` emits events for files that already exist when the watcher starts. Even if `fs.watch` does not fire for pre-existing files, the stale sentinel could cause issues if a filesystem event (e.g., wrapper script write) triggers a directory scan that notices the sentinel.
- **Impact**: A respawned task with the same taskId path could immediately trigger `handleSentinel`, causing the new session to exit before the agent runs. The duplicate taskId guard (line 137) prevents same-taskId reuse within a process lifetime, but across process restarts the same path could be reused.
- **Suggestion**: Have `generateWrapper` remove any pre-existing `.done` and `.exit` files from the session directory before returning, or have the connector clear them after watcher setup but before session launch. A targeted `unlinkSync` for the two sentinel paths is safer than `rmSync(recursive)` since it preserves the directory structure.

### [P2] Session manager derives taskId from session name via implicit convention

- **Location**: `tmux-session-manager.ts:112`
- **Description**: `createSession` derives the taskId for `AUTOBEAT_TASK_ID` env var injection via `config.name.replace(/^beat-/, '')`. This assumes the session name follows the `beat-{taskId}` convention. However, `TmuxSessionConfig.name` and `TmuxSpawnConfig.taskId` are independent fields -- nothing enforces that `name === 'beat-' + taskId`. The connector passes the full `TmuxSpawnConfig` (which contains `taskId`) to `createSession` via spread, but since `TmuxSessionConfig` does not include `taskId`, the session manager cannot access it.
- **Impact**: If the naming convention is violated, `AUTOBEAT_TASK_ID` would contain the wrong value. This is best-effort (env injection failures do not fail the session), and the current codebase consistently uses `beat-{taskId}` naming, so this is not a runtime issue today. It becomes a trap for future callers who construct names differently.
- **Suggestion**: Either: (a) add an optional `taskId` field to `TmuxSessionConfig` that `createSession` prefers over the derived value, or (b) document the `beat-{taskId}` naming requirement as a contract in the `TmuxSessionConfig.name` JSDoc and add a test that verifies the derived taskId matches the connector's actual taskId.

## No Issues Found

The following integration boundaries were verified clean:

- **Interface alignment**: `TmuxConnector` calls `TmuxValidator.validate()`, `TmuxHooks.generateWrapper(WrapperConfig)`, `TmuxHooks.cleanup(taskId, sessionsDir)`, `TmuxSessionManager.createSession(TmuxSessionConfig)`, `TmuxSessionManager.destroySession(name)`, `TmuxSessionManager.sendKeys(name, keys)`, `TmuxSessionManager.isAlive(name)`, and `TmuxSessionManager.listSessions()` with correct argument types matching the interface definitions in `types.ts`.

- **Lifecycle ordering**: The spawn flow correctly validates tmux first, generates the wrapper second, starts watchers third (before session launch to prevent race), creates the session fourth, and starts the staleness timer fifth. The session is only added to `activeSessions` after all steps succeed, preventing the staleness timer from seeing an incomplete session.

- **Error propagation**: All `Result` returns from dependencies are checked with `if (!result.ok) return result` or logged. No errors are silently swallowed. `destroySession` failures in `triggerExit` are logged via `logger.warn`. `hooks.cleanup` failures are logged via `loggedCleanup`. `injectEnvironment` failures in the session manager are best-effort by design (documented in comments).

- **Resource cleanup on failure**: When `createSession` fails (line 197), the connector calls `closeSession(session)` to close watchers and `loggedCleanup` to remove the hooks directory. This is correct and prevents leaked watchers and orphaned directories.

- **Shared state / filesystem paths**: The connector uses `manifest.sessionDir` (= `sessionsDir/taskId`) for sentinel watching, `manifest.messagesDir` (= `sessionsDir/taskId/messages`) for message watching, and `manifest.wrapperPath` (= `sessionsDir/taskId/wrapper.sh`) as the tmux command. The hooks generate sentinel files at `sessionsDir/taskId/.done` and `sessionsDir/taskId/.exit`. The connector checks for filenames `.done` and `.exit` in the sentinel watcher -- these match the `SENTINEL_DONE` and `SENTINEL_EXIT` constants (though hardcoded strings are used instead of the constants, which is a minor consistency issue, not a correctness one).

- **Concurrency / double-exit prevention**: `triggerExit` has `if (session.exited) return` as the first line. The `session.exited = true` flag is set synchronously before any async work. Since Node.js is single-threaded, concurrent sentinel and staleness triggers cannot both execute `triggerExit` -- one will see `exited = true` and return. The `runSharedStalenessCheck` method collects stale sessions into an array before calling `triggerExit` to avoid mutating `activeSessions` during iteration.

- **Staleness timer / watcher interaction**: The shared staleness timer only starts after a session is registered in `activeSessions`. It checks `session.handle.sessionName` against the `listSessions()` result. Since the session name is finalized before `activeSessions.set()`, there is no window where the timer could check a placeholder name. The timer stops cleanly via `restartSharedStalenessTimer()` when all sessions are removed.

- **dispose() correctness**: `dispose()` iterates a snapshot of sessions (`Array.from`), clears `activeSessions` first, stops the staleness timer, then destroys each session and calls `onExit(null, 'SHUTDOWN')`. The snapshot prevents mutation-during-iteration issues. Setting `exited = true` before flush prevents late timer ticks from interfering.

- **destroy() vs triggerExit() contract**: `destroy()` intentionally does not call `onExit` -- the caller is explicitly destroying the session. `triggerExit()` (sentinel/staleness path) and `dispose()` (shutdown path) do call `onExit`. This asymmetry is correct for the push-based event model.
