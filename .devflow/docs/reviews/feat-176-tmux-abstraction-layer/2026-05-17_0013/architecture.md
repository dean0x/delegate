# Architecture Review Report

**Branch**: feat-176-tmux-abstraction-layer -> main
**Date**: 2026-05-17

## Issues in Your Changes (BLOCKING)

### HIGH

**TmuxConnector imports concrete classes instead of depending on interfaces** - `src/implementations/tmux/tmux-connector.ts:21-23`
**Confidence**: 85%
- Problem: TmuxConnector directly imports `TmuxHooks`, `TmuxSessionManager`, and `TmuxValidator` as concrete classes. While the `TmuxConnectorDeps` interface correctly declares the dependency slots, it types them as the concrete class instances (`sessionManager: TmuxSessionManager`) rather than interfaces extracted from those classes. This creates tight coupling between the Connector and its sub-classes — swapping implementations requires modifying the imports, violating DIP.
- Impact: Future phases of the tmux migration may need alternative implementations (e.g., a mock session manager for dry-run mode, or a different hooks implementation for Codex vs Claude). The concrete coupling makes this harder without changing TmuxConnector itself.
- Fix: Extract interfaces from each sub-class and depend on those in `TmuxConnectorDeps`:
```typescript
// types.ts (or separate files)
export interface ITmuxSessionManager {
  createSession(config: TmuxSessionConfig): Result<TmuxHandle, AutobeatError>;
  destroySession(name: string): Result<void, AutobeatError>;
  sendKeys(name: string, keys: string): Result<void, AutobeatError>;
  isAlive(name: string): Result<boolean, AutobeatError>;
  listSessions(): Result<TmuxSessionInfo[], AutobeatError>;
}

export interface ITmuxValidator {
  validate(): Result<TmuxInfo, AutobeatError>;
}

export interface ITmuxHooks {
  generateWrapper(config: WrapperConfig): Result<WrapperManifest, AutobeatError>;
  cleanup(taskId: string, sessionsDir: string): Result<void, AutobeatError>;
}

// tmux-connector.ts
export interface TmuxConnectorDeps {
  sessionManager: ITmuxSessionManager;
  hooks: ITmuxHooks;
  validator: ITmuxValidator;
  logger: Logger;
  watch: WatchFn;
  readFileSync?: (path: string, encoding: BufferEncoding) => string;
}
```
This aligns with the project-wide DI pattern (constructors accept interfaces, not implementations) and allows future extension without modification (OCP).

**index.ts exports all sub-classes as public API, contradicting "TmuxConnector is only public entry point"** - `src/implementations/tmux/index.ts:10-14`
**Confidence**: 82%
- Problem: The barrel file exports `TmuxHooks`, `TmuxSessionManager`, and `TmuxValidator` as top-level public exports. The FEATURE_KNOWLEDGE states "TmuxConnector is the only public entry point" for this layer. Exporting the sub-classes invites direct consumption from service-layer code, bypassing the Connector's lifecycle management (watcher setup, staleness detection, cleanup).
- Impact: If consumers construct `TmuxSessionManager` directly, they skip sentinel detection and staleness timers, creating orphaned sessions. The architectural intent is that all external callers go through `TmuxConnector.spawn()`.
- Fix: Restrict exports to only the Connector and types needed for construction:
```typescript
// Public entry point
export type { SpawnCallbacks, TmuxConnectorDeps } from './tmux-connector.js';
export { TmuxConnector } from './tmux-connector.js';

// Types needed by the consumer to construct dependencies
export type { TmuxHooksDeps } from './tmux-hooks.js';
export { TmuxHooks } from './tmux-hooks.js';
export { TmuxSessionManager } from './tmux-session-manager.js';
export { TmuxValidator } from './tmux-validator.js';
```
Alternatively, if the intent is that a DI container wires the deps, keep the exports but add a JSDoc `@internal` annotation on the sub-classes. The cleanest approach is a factory function `createTmuxConnector(config)` that constructs all deps internally, keeping sub-classes module-private.

### MEDIUM

**TmuxSessionManager.createSession returns empty `sessionsDir` in TmuxHandle** - `src/implementations/tmux/tmux-session-manager.ts:136-140`
**Confidence**: 88%
- Problem: The returned `TmuxHandle` has `sessionsDir: ''` (empty string). The `TmuxHandle` type defines `sessionsDir` as the base directory where session data lives, but `TmuxSessionManager` has no knowledge of this value — it only manages tmux processes. The caller (TmuxConnector) overwrites this at line 183, but the intermediate state is architecturally misleading and could cause bugs if `createSession` is ever called directly.
- Impact: If future code calls `createSession` standalone (which the public export makes possible), the returned handle has an invalid `sessionsDir`. This is a layering concern — `TmuxSessionManager` shouldn't be forced to populate a field it doesn't own.
- Fix: Either (a) remove `sessionsDir` from TmuxHandle returned by `createSession` (return a narrower type), or (b) accept `sessionsDir` as a parameter in `TmuxSessionConfig` and pass it through:
```typescript
// Option A: Narrower return type for SessionManager
interface SessionHandle { sessionName: string; taskId: string; }
// TmuxConnector wraps it into a full TmuxHandle

// Option B: Pass sessionsDir through config (already present in TmuxSpawnConfig)
return ok({
  sessionName: config.name,
  taskId: config.name.replace(/^beat-/, ''),
  sessionsDir: config.sessionsDir ?? '',
});
```

**`deliveredSequences` Set grows unboundedly** - `src/implementations/tmux/tmux-connector.ts:59,308-309`
**Confidence**: 80%
- Problem: The `deliveredSequences` Set accumulates every delivered sequence number for the lifetime of the session. For long-running agent sessions that produce thousands of messages, this is unbounded memory growth within the `ActiveSession` state. The `pendingMessages` map has a cap (`MAX_PENDING_MESSAGES`), but the delivered set does not.
- Impact: For typical task durations (minutes), this is low-risk. For long-running loops or orchestrations that produce tens of thousands of output lines, memory grows linearly without bound.
- Fix: Since messages are delivered in order, you only need to track `nextExpectedSeq` to prevent duplicates (any sequence < `nextExpectedSeq` is already delivered). Remove `deliveredSequences` and use the sequence number comparison:
```typescript
// Replace deliveredSequences check with:
if (msg.sequence < session.nextExpectedSeq) continue; // already delivered
callbacks.onOutput(msg);
session.nextExpectedSeq = msg.sequence + 1;
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`src/core/errors.ts` tmux error factories lack JSDoc design decision documentation** - `src/core/errors.ts:193-221`
**Confidence**: 80%
- Problem: The project convention (per CLAUDE.md and global instructions) requires design decisions to be documented as JSDoc at decision points in code. The four new error factories (`tmuxSessionFailed`, `tmuxValidationFailed`, `tmuxHookFailed`, `tmuxSendKeysFailed`) have no JSDoc explaining when to use each or the boundary between them. This is notable given the other tmux classes have excellent DESIGN DECISION comments.
- Fix: Add brief JSDoc to each factory clarifying its domain:
```typescript
/** Session create/destroy/lifecycle failures — the tmux command ran but failed */
export const tmuxSessionFailed = ...

/** Pre-flight validation — tmux not installed, wrong version, can't run */
export const tmuxValidationFailed = ...
```

## Pre-existing Issues (Not Blocking)

No critical pre-existing issues found in changed files.

## Suggestions (Lower Confidence)

- **TmuxConnector.spawn hardcodes `agent: 'claude'`** - `src/implementations/tmux/tmux-connector.ts:93` (Confidence: 72%) — The spawn method always passes `agent: 'claude'` to `generateWrapper()`, ignoring any agent configuration from the caller. This may be intentional for Phase 1 but limits multi-agent support without modification (OCP concern for future phases).

- **Staleness detection resets `lastAliveCheck` on every alive=true poll, masking intermittent failures** - `src/implementations/tmux/tmux-connector.ts:211-212` (Confidence: 65%) — If a session briefly returns alive between actual crashes (race condition with tmux has-session), the staleness timer resets and may never fire. A monotonic "last output received" timestamp from the message watcher would be more reliable.

- **No interface for TmuxConnector itself** - `src/implementations/tmux/tmux-connector.ts:69` (Confidence: 60%) — Service-layer consumers (future WorkerPool integration) will want to depend on an interface rather than the concrete class, following the project's DI pattern. Adding this interface now prevents a future breaking change.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Architecture Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The tmux abstraction layer demonstrates strong architectural fundamentals: clear separation of concerns (four classes with distinct responsibilities), proper dependency injection via constructor deps, consistent Result-type error handling, push-based event model, and no domain/repository coupling (pure infrastructure layer as specified). The dependency graph is acyclic — sub-classes depend only on `types.ts` and `core/`, never on each other or on TmuxConnector.

Conditions for merge:
1. **Address the empty `sessionsDir` in TmuxHandle** (MEDIUM) — prevents a subtle bug if SessionManager is used standalone
2. **Consider interface extraction for DIP** (HIGH) — the concrete class imports are the primary architectural concern, though acceptable for Phase 1 if tracked as tech debt for Phase 2 wiring
