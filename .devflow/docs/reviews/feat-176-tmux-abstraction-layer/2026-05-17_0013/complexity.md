# Complexity Review Report

**Branch**: feat-176-tmux-abstraction-layer -> main
**Date**: 2026-05-17

## Issues in Your Changes (BLOCKING)

### HIGH

**`spawn()` method exceeds critical function length (133 lines)** - `src/implementations/tmux/tmux-connector.ts:85-218`
**Confidence**: 90%
- Problem: The `spawn()` method spans 133 lines with 5 numbered steps, multiple try/catch blocks, and inline callback closures. While the FEATURE_KNOWLEDGE acknowledges that spawn follows a "numbered step pattern," the method still exceeds the critical threshold (>50 lines) by nearly 3x. Each step (validate, generate wrapper, start watchers, create session, start staleness timer) is a distinct concern that could be extracted.
- Fix: Extract each numbered step into a private helper method. The resulting `spawn()` becomes a short orchestration function:
```typescript
async spawn(config: TmuxSpawnConfig, callbacks: SpawnCallbacks): Promise<Result<TmuxHandle, AutobeatError>> {
  const validationResult = this.deps.validator.validate();
  if (!validationResult.ok) return validationResult;

  const manifestResult = this.generateManifest(config);
  if (!manifestResult.ok) return manifestResult;

  const session = this.buildSessionState(config);
  this.startWatchers(session, manifestResult.value, config, callbacks);

  const sessionResult = this.launchSession(config, manifestResult.value, session, callbacks);
  if (!sessionResult.ok) return sessionResult;

  this.startStalenessTimer(session, config, callbacks);
  this.activeSessions.set(config.taskId, session);
  return ok(session.handle);
}
```

**Duplicated delivery loop in `handleMessageFile`** - `src/implementations/tmux/tmux-connector.ts:305-334`
**Confidence**: 92%
- Problem: The message delivery while-loop appears twice (lines 305-313 and 326-334) with identical logic: iterate `pendingMessages`, delete from map, check `deliveredSequences`, call `callbacks.onOutput`, increment `nextExpectedSeq`. This violates DRY and inflates cyclomatic complexity of the method.
- Fix: Extract the delivery loop into a private `deliverPendingMessages` helper:
```typescript
private deliverPendingMessages(session: ActiveSession, callbacks: SpawnCallbacks): void {
  while (session.pendingMessages.has(session.nextExpectedSeq)) {
    const msg = session.pendingMessages.get(session.nextExpectedSeq)!;
    session.pendingMessages.delete(session.nextExpectedSeq);
    if (!session.deliveredSequences.has(msg.sequence)) {
      session.deliveredSequences.add(msg.sequence);
      callbacks.onOutput(msg);
    }
    session.nextExpectedSeq++;
  }
}
```
Then call it from both places in `handleMessageFile`.

### MEDIUM

**`createSession()` exceeds critical function length (60 lines)** - `src/implementations/tmux/tmux-session-manager.ts:81-141`
**Confidence**: 82%
- Problem: The `createSession()` method mixes validation, session creation, and environment variable injection in a single 60-line function. The env-var injection loop (lines 114-134) is a distinct concern that could be extracted.
- Fix: Extract environment variable injection into a private `injectEnvironment(sessionName, config)` method. This reduces `createSession` to ~35 lines focused solely on validation and session spawning.

**`ActiveSession` interface has 8 fields tracking disparate concerns** - `src/implementations/tmux/tmux-connector.ts:53-67`
**Confidence**: 80%
- Problem: The `ActiveSession` interface aggregates watcher state (sentinelWatcher, messagesWatcher), timer state (stalenessTimer, debounceTimers), sequencing state (deliveredSequences, pendingMessages, nextExpectedSeq), and lifecycle state (exited, handle). This breadth of concerns in one data structure makes it harder to reason about invariants and increases cognitive load.
- Fix: Group related fields with inline comments or consider a nested structure for message sequencing state:
```typescript
interface MessageBufferState {
  deliveredSequences: Set<number>;
  pendingMessages: Map<number, OutputMessage>;
  nextExpectedSeq: number;
}
```
This is lower priority since the interface is internal, but improves local reasoning.

## Issues in Code You Touched (Should Fix)

_(none)_

## Pre-existing Issues (Not Blocking)

_(none)_

## Suggestions (Lower Confidence)

- **`listSessions()` parsing could use a helper** - `src/implementations/tmux/tmux-session-manager.ts:214-234` (Confidence: 65%) — The line-parsing logic (split by colon, destructure, parseInt) could be extracted into a `parseTmuxSessionLine()` function for testability. Currently 20 lines inside the method, borderline.

- **`buildWrapperScript` inlines all shell logic in a template literal** - `src/implementations/tmux/tmux-hooks.ts:52-97` (Confidence: 62%) — The 45-line heredoc-style shell script makes it harder to validate correctness in TypeScript. However, this is a reasonable pattern for wrapper generation and extracting it further may not improve clarity.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | - | 2 | 2 | - |
| Should Fix | - | - | - | - |
| Pre-existing | - | - | - | - |

**Complexity Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The code demonstrates good separation of concerns at the class level (Validator, SessionManager, Hooks, Connector each <150 lines individually, as noted in FEATURE_KNOWLEDGE). The main complexity issues are within `TmuxConnector.spawn()` (133-line orchestration method) and the duplicated delivery loop in `handleMessageFile`. These are addressable with straightforward extract-method refactoring without changing behavior. The overall architecture is sound.
