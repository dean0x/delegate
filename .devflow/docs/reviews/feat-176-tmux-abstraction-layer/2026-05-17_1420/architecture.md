# Architecture Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17T14:20

## Issues in Your Changes (BLOCKING)

### HIGH

**Duplicated message parsing/validation logic (DRY violation)** - `tmux-connector.ts:314-334` and `tmux-connector.ts:376-397`
**Confidence**: 95%
- Problem: The JSON read + parse + shape-validation block is copy-pasted between `flushPendingFiles()` and `handleMessageFile()`. Both perform identical steps: `readFileSync` -> `JSON.parse` -> 4-field type guard -> cast to `OutputMessage`. This violates SRP at the method level (each method mixes "parse a message" with "decide what to do with it") and creates a maintenance risk: any schema change to `OutputMessage` must be updated in two places.
- Fix: Extract a private `parseMessageFile(filePath: string): OutputMessage | null` method that encapsulates the read + parse + validate logic. Both `flushPendingFiles` and `handleMessageFile` call it and handle `null` returns.

```typescript
private parseMessageFile(filePath: string): OutputMessage | null {
  let parsed: unknown;
  try {
    const raw = this.readFileSyncFn(filePath, 'utf8');
    parsed = JSON.parse(raw);
  } catch {
    this.deps.logger.warn('Failed to parse output message file', { filePath });
    return null;
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).sequence !== 'number' ||
    typeof (parsed as Record<string, unknown>).timestamp !== 'string' ||
    typeof (parsed as Record<string, unknown>).type !== 'string' ||
    typeof (parsed as Record<string, unknown>).content !== 'string'
  ) {
    this.deps.logger.warn('Output message missing required fields', { filePath });
    return null;
  }

  return parsed as OutputMessage;
}
```

**Unused `agent` field in `WrapperConfig` type** - `types.ts:81` and `tmux-connector.ts:109`
**Confidence**: 92%
- Problem: `WrapperConfig.agent` is declared as `'claude' | 'codex'` and is set to `'claude'` in `TmuxConnector.spawn()`, but `TmuxHooks.buildWrapperScript()` never reads `config.agent`. This is dead data flowing through the interface -- it wastes API surface, confuses readers about what the field controls, and the union type implies multi-agent support that doesn't actually exist yet. Per ISP, interfaces should not carry fields consumers don't use.
- Fix: Remove the `agent` field from `WrapperConfig` entirely. When multi-agent wrapper differentiation is actually needed, add it back with the behavior that consumes it. This avoids PF-002 (no backward-compatibility scaffolding for unused features).

### MEDIUM

**`dispose()` silently discards `Result` errors** - `tmux-connector.ts:281`
**Confidence**: 85%
- Problem: In `dispose()`, the loop calls `this.deps.sessionManager.destroySession(session.handle.sessionName)` but discards the returned `Result`. If any session fails to destroy during shutdown, the error is silently lost. The project's global engineering principles mandate Result types for all fallible operations, and `destroy()` (the single-session method at line 250) does return the Result properly. The inconsistency between `destroy()` and `dispose()` is a concern.
- Fix: Collect errors and log them. `dispose()` is a shutdown path so it should not fail the caller, but it should not lose information either.

```typescript
dispose(): void {
  const sessions = Array.from(this.activeSessions.values());
  this.activeSessions.clear();
  for (const session of sessions) {
    this.flushPendingFiles(session);
    this.closeSession(session);
    const result = this.deps.sessionManager.destroySession(session.handle.sessionName);
    if (!result.ok) {
      this.deps.logger.warn('dispose: failed to destroy session', {
        sessionName: session.handle.sessionName,
        error: result.error.message,
      });
    }
  }
}
```

**`TmuxConnector.spawn()` hardcodes `agentArgs: []`** - `tmux-connector.ts:112`
**Confidence**: 82%
- Problem: `spawn()` passes an empty `agentArgs` array to `generateWrapper()`, ignoring any arguments the caller might want to pass to the agent command. `TmuxSpawnConfig` does not carry an `agentArgs` field either, so there is no way for callers to control agent arguments. This is an OCP concern: when integration happens and callers need to pass `--print`, `--model`, etc., both `TmuxSpawnConfig` and the `spawn()` method will need modification.
- Fix: Either add `agentArgs?: string[]` to `TmuxSpawnConfig` now and forward it, or document the limitation explicitly with a TODO. Given this is a pure infrastructure layer not yet integrated, a documented TODO is acceptable.

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **ActiveSession interface could be a class** - `tmux-connector.ts:61-81` (Confidence: 65%) -- The `ActiveSession` interface has 11 fields and associated behavior spread across multiple `TmuxConnector` methods (`flushPendingFiles`, `deliverPendingMessages`, `closeSession`). This is feature envy; the behavior belongs to the data owner. Extracting `ActiveSession` as a class with methods like `flush()`, `deliver()`, `close()` would improve cohesion and reduce parameter passing. However, this is a judgment call and the current flat struct + private methods pattern is serviceable at this size.

- **`TmuxConnector` at 480 lines approaches boundary** - `tmux-connector.ts` (Confidence: 62%) -- The class has 5 public methods, 6 private methods, and manages watcher lifecycle, message ordering, staleness detection, and file-system operations. Each concern is well-separated into private methods, and the class is below the 500-line threshold, so this is informational. If further responsibilities are added during integration (e.g., output buffering, reconnection), consider extracting message delivery into its own collaborator.

- **`TmuxSessionManager.createSession` mixes validation, resource limiting, and session creation** - `tmux-session-manager.ts:81-133` (Confidence: 68%) -- The method performs name validation, calls `listSessions()` for the concurrent limit check, creates the session, then injects environment variables. This is 4 distinct responsibilities in one method. However, each step is sequential with early returns, so the linear flow is readable and the method is only 52 lines. Splitting would add indirection without proportional benefit at this size.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Architecture Score**: 8/10
**Recommendation**: CHANGES_REQUESTED

### Rationale

The overall architecture is well-designed. The four-class hierarchy (Validator -> SessionManager -> Hooks -> Connector) follows clean layering with correct dependency direction: all dependencies point inward toward `types.ts` and `core/`. Dependency injection is applied consistently via constructor-injected interfaces. The interface segregation between `ITmuxSessionManager` (4 methods used by Connector) and the concrete `TmuxSessionManager` (6 methods including `listSessions` and `getSessionEnvironment`) is a textbook ISP application. Result types are used throughout with no thrown exceptions. No circular dependencies exist.

The two HIGH findings (duplicated parsing logic and dead `agent` field) are straightforward fixes that should be addressed before merge -- avoids PF-001. The MEDIUM findings (silent error discard in `dispose`, hardcoded empty args) are lower risk but worth addressing for consistency with the project's error-handling patterns.
