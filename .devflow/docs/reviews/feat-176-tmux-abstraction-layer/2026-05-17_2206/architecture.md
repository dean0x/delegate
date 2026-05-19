# Architecture Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17T22:06

## Issues in Your Changes (BLOCKING)

### HIGH

**destroy() deletes session directory before killing tmux session** - `src/implementations/tmux/tmux-connector.ts:198`
**Confidence**: 90%
- Problem: `destroy()` calls `loggedCleanup()` (line 198, which does `rmSync` on the session directory) before `sessionManager.destroySession()` (line 200, which kills the tmux process). When `destroy()` is called on a running session (cancellation path), the wrapper script is still writing message files and sentinels to the directory that just got deleted. The wrapper will get I/O errors and may fail silently without writing its sentinel, masking the real exit code. Compare with `dispose()` (lines 228-235) which correctly kills the tmux session first, then cleans up the directory.
- Fix: Move `loggedCleanup` after `destroySession` to match the `dispose()` ordering:
```typescript
destroy(handle: TmuxHandle): Result<void, AutobeatError> {
  const session = this.activeSessions.get(handle.taskId);
  if (session) {
    session.exited = true;
    this.flushPendingFiles(session);
    this.closeSession(session);
    this.activeSessions.delete(handle.taskId);
    this.restartSharedStalenessTimer();
  }
  const result = this.deps.sessionManager.destroySession(handle.sessionName);
  // Clean up session directory AFTER the tmux process is killed
  this.loggedCleanup('destroy', handle.taskId, handle.sessionsDir);
  return result;
}
```

**Hardcoded `agent: 'claude'` in spawn() bypasses multi-agent support** - `src/implementations/tmux/tmux-connector.ts:143`
**Confidence**: 85%
- Problem: `spawn()` hardcodes `agent: 'claude'` when calling `hooks.generateWrapper()`. The project supports Claude, Codex, and Gemini agents (per CLAUDE.md v0.5.0). `TmuxSpawnConfig` has no `agent` field, so the caller cannot specify which agent type is being spawned. While Phase 1 generates a single wrapper pattern for all agents, the `WrapperConfig.agent` field exists with type `'claude' | 'codex'` -- the connector should propagate it rather than hardcoding. This also prevents adding agent-specific wrapper behavior later without changing the connector API.
- Fix: Add an `agent` field to `TmuxSpawnConfig` and propagate it:
```typescript
// In types.ts:
export interface TmuxSpawnConfig extends TmuxSessionConfig {
  taskId: string;
  sessionsDir: string;
  agent: 'claude' | 'codex';  // or WrapperConfig['agent']
  staleness?: Partial<StalenessConfig>;
}

// In tmux-connector.ts spawn():
agent: config.agent,
```

### MEDIUM

**`getSessionEnvironment` not on interface -- leaky abstraction** - `src/implementations/tmux/tmux-session-manager.ts:237`
**Confidence**: 85%
- Problem: `getSessionEnvironment()` is implemented on `DefaultTmuxSessionManager` (line 237) but is absent from the `TmuxSessionManager` interface (types.ts:189-196). Consumers injecting `TmuxSessionManager` cannot call this method without a downcast to the concrete class. This violates DIP -- the method is only accessible by depending on the concretion. The method is tested (6 test cases) and used in integration tests, suggesting it is intended for public use. (avoids PF-001: surfacing rather than deferring)
- Fix: Add `getSessionEnvironment` to the `TmuxSessionManager` interface:
```typescript
export interface TmuxSessionManager {
  createSession(config: TmuxSessionConfig): Result<TmuxSessionResult, AutobeatError>;
  destroySession(name: string): Result<void, AutobeatError>;
  sendKeys(name: string, keys: string): Result<void, AutobeatError>;
  isAlive(name: string): Result<boolean, AutobeatError>;
  listSessions(): Result<TmuxSessionInfo[], AutobeatError>;
  getSessionEnvironment(name: string, varName: string): Result<string | undefined, AutobeatError>;
}
```

**triggerExit does not kill the tmux session on STALE detection** - `src/implementations/tmux/tmux-connector.ts:438-439`
**Confidence**: 80%
- Problem: When the staleness timer fires, `triggerExit` cleans up internal state and the session directory (`loggedCleanup`) but never calls `sessionManager.destroySession()`. Stale detection fires when the session is NOT in `listSessions()` output, implying the tmux process already crashed. However, there are edge cases: a session could be stale (no output for `maxSilenceMs`) but still alive (the agent is hung, not crashed). In that case, the tmux session is orphaned -- the connector forgets about it and deletes its directory, but the tmux process continues running indefinitely. The caller receives `onExit(null, 'STALE')` but has no guarantee the tmux session is actually dead.
- Fix: Call `sessionManager.destroySession()` in `triggerExit` (idempotent if already dead):
```typescript
private triggerExit(...): void {
  if (session.exited) return;
  session.exited = true;
  this.flushPendingFiles(session);
  this.closeSession(session);
  this.activeSessions.delete(taskId);
  if (!skipTimerRestart) {
    this.restartSharedStalenessTimer();
  }
  // Kill the tmux session (idempotent if already dead)
  this.deps.sessionManager.destroySession(session.handle.sessionName);
  this.loggedCleanup('triggerExit', taskId, session.handle.sessionsDir);
  callbacks.onExit(code, signal);
}
```

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **`WrapperConfig.agent` type is narrower than project agent roster** - `src/implementations/tmux/types.ts:88` (Confidence: 65%) -- The `agent` field accepts `'claude' | 'codex'` but the project also supports `'gemini'` and `'ollama'`. If the type is expanded later, it requires changes in types.ts and potentially in `buildWrapperScript`. Consider whether the type should be a string union that covers all supported agents or whether the wrapper script generator genuinely differs per agent. (avoids PF-002: no backward-compat needed since v1.6.0 is unpublished)

- **`TmuxSessionResult.taskId` derived from session name in `createSession`** - `src/implementations/tmux/tmux-session-manager.ts:106,128` (Confidence: 60%) -- `createSession` derives `taskId` by stripping the `beat-` prefix from the session name, embedding a naming convention assumption. The connector ignores this field, so the derivation is unused by the only consumer. If the naming convention changes, this derivation silently produces wrong values.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Architecture Score**: 8/10
**Recommendation**: CHANGES_REQUESTED

### Architecture Strengths

The four-class hierarchy is well-designed with clear single responsibilities:
- **TmuxValidator**: validation + caching (one reason to change)
- **TmuxSessionManager**: CLI facade (one reason to change)
- **TmuxHooks**: script generation + directory lifecycle (one reason to change)
- **TmuxConnector**: orchestration + lifecycle (one reason to change)

Dependency direction is strictly downward -- no circular imports. All dependencies are injected via constructor interfaces. Result types are used consistently throughout with no thrown exceptions in business logic. The `types.ts` file cleanly separates interfaces from implementations, enabling consumers to depend on abstractions. The barrel export is well-organized with type-only re-exports for zero-cost imports.

### Architecture Concerns

The two HIGH findings (destroy ordering and hardcoded agent type) are behavioral bugs that should be fixed before merge. The destroy ordering creates a race condition on the cancellation path that could corrupt exit codes. The hardcoded agent type is a minor coupling that will need to be addressed when the layer integrates with the multi-agent runtime.
