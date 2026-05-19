# Architecture Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-18
**Files reviewed**: 6 source files (types.ts, index.ts, tmux-validator.ts, tmux-session-manager.ts, tmux-hooks.ts, tmux-connector.ts), plus errors.ts additions

## Issues in Your Changes (BLOCKING)

### HIGH

**TmuxConnector defaults to concrete `fs` module for readFileSync/readFile/readdirSync** - `tmux-connector.ts:130-132`
**Confidence**: 85%
- Problem: The constructor falls back to `fs.readFileSync`, `fs.promises.readFile`, and `fs.readdirSync` when deps are not provided. This means `import * as fs` at line 18 is a hard dependency pulled at module load time, creating a tight coupling to the `fs` module. The `watch` dependency IS required (no default), but these three have optional defaults. This inconsistency means the DI boundary is partial: `watch` is mandatory-injected but `readFileSync`/`readFile`/`readdirSync` are optional with `fs` defaults. In a codebase where the principle is "inject dependencies, not implementations," optional injection with concrete defaults defeats the purpose for production wiring -- the consumer never _needs_ to inject them, so the concrete dependency is silently baked in.
- Impact: Tests can override these, but production code silently binds to `fs`. If the connector is ever wired in a context where filesystem access must be constrained (sandboxed environment, WASM), the defaults silently work against you. More importantly, `import * as fs` at module level means even importing the module side-effects the dependency graph.
- Fix: Make `readFileSync`, `readFile`, and `readdirSync` required in `TmuxConnectorDeps` (like `watch` already is). Remove `import * as fs` from the connector entirely. The composition root that constructs the connector provides the real `fs` functions. This aligns with the existing pattern where `exec` is always required in `TmuxValidatorDeps` and `TmuxSessionManagerDeps`.

```typescript
// TmuxConnectorDeps — all required, no defaults
export interface TmuxConnectorDeps {
  sessionManager: TmuxSessionManager;
  hooks: TmuxHooks;
  validator: TmuxValidator;
  logger: Logger;
  watch: WatchFn;
  readFileSync: (path: string, encoding: BufferEncoding) => string;
  readFile: (path: string, encoding: BufferEncoding) => Promise<string>;
  readdirSync: (dirPath: string) => string[];
}
```

**TmuxConnector has multiple reasons to change (SRP concern)** - `tmux-connector.ts` (777 lines, ~15 methods)
**Confidence**: 82%
- Problem: TmuxConnector handles five distinct responsibilities: (1) session lifecycle (spawn/destroy/dispose), (2) sentinel detection and parsing, (3) message file reading and delivery with sequence ordering, (4) staleness detection via shared timer, and (5) flush-on-exit orchestration. Each of these could change independently -- e.g., switching from fs.watch to inotify, changing message ordering strategy, or replacing the staleness timer with a heartbeat protocol. At 777 lines with 15+ methods and an 18-field ActiveSession object, this is approaching the "god class" threshold.
- Impact: Adding new completion detection strategies (e.g., polling fallback for NFS mounts) or new message delivery modes requires modifying this single class. The large ActiveSession interface (18 fields) is a symptom -- it carries state for all five concerns.
- Fix: Consider extracting at minimum a `MessageDeliveryPipeline` (handles pendingMessages, sequence ordering, flush, deliverSingle, deliverPendingMessages, forceDeliverRemaining) and a `StalenessDetector` (handles the shared timer, runSharedStalenessCheck, lastAliveCheck tracking). This would bring TmuxConnector down to ~350 lines focused on lifecycle orchestration, with each extracted class having a single reason to change.

### MEDIUM

**Port interface (`TmuxConnectorPort`) lives in implementation package, not in core** - `types.ts:245-252`
**Confidence**: 85%
- Problem: Clean Architecture / Hexagonal Architecture says ports belong to the core (or a dedicated ports package) so that the dependency arrow points inward. `TmuxConnectorPort` is defined in `src/implementations/tmux/types.ts`. When Phase 2/3 consumers (WorkerPool, agent adapters) need to depend on this port, they will import from `src/implementations/tmux/` -- making higher-level code depend on an implementation package. The project's existing pattern has port interfaces in `src/core/interfaces.ts` (e.g., `ProcessSpawner`, `TaskQueue`, `Logger`).
- Impact: When `WorkerPool` or `EventDrivenWorkerPool` is refactored to use `TmuxConnectorPort` (Phase 3 of the migration), it will need to import from `implementations/tmux/types`. This inverts the dependency direction -- the service layer depending on the implementation layer.
- Fix: Move `TmuxConnectorPort`, `SpawnCallbacks`, `TmuxHandle`, `TmuxSpawnConfig`, and `OutputMessage` (the public-facing types) to `src/core/interfaces.ts` or a new `src/core/tmux-port.ts`. Keep implementation-internal types (ActiveSession, WrapperManifest, etc.) in `implementations/tmux/types.ts`.

```typescript
// src/core/interfaces.ts (or src/core/tmux-port.ts)
export interface TmuxConnectorPort {
  spawn(config: TmuxSpawnConfig, callbacks: SpawnCallbacks): Result<TmuxHandle, AutobeatError>;
  destroy(handle: TmuxHandle): Result<void, AutobeatError>;
  sendKeys(handle: TmuxHandle, keys: string): Result<void, AutobeatError>;
  isAlive(handle: TmuxHandle): Result<boolean, AutobeatError>;
  getActiveHandles(): TmuxHandle[];
  dispose(): void;
}
```

**`import * as fs` in tmux-hooks.ts not needed — no fs usage** - `tmux-hooks.ts:18`
**Confidence**: 90%
- Problem: `tmux-hooks.ts` imports `import * as path from 'path'` (used for `path.join`) but all filesystem operations (`writeFile`, `mkdirSync`, `rmSync`) are properly injected via `TmuxHooksDeps`. However, in `tmux-connector.ts`, the `import * as fs` at line 18 is used only for (a) the `WatchFn` type alias at line 41 (`typeof fs.watch`), (b) the `fs.FSWatcher` type at lines 98-99, and (c) the fallback defaults at lines 130-132. If the defaults are made required per the first finding, the only remaining usage is the type references. Types can be imported as `import type`.
- Impact: Module-level `import * as fs` in the connector pulls in the entire `fs` module at load time, even if all actual fs calls are injected. This is a layering concern -- the implementation module should not have a hard runtime dependency on `fs` when DI is the stated pattern.
- Fix: After making the three fs functions required deps, change to `import type { FSWatcher } from 'fs'` and define `WatchFn` inline or import the type from node types. The `path` import in connector is fine (pure computation, no I/O).

**Duplicate `escapeSingleQuoted` / `shellSingleQuote` functions** - `tmux-session-manager.ts:49` and `tmux-hooks.ts:40`
**Confidence**: 88%
- Problem: Both `tmux-session-manager.ts` and `tmux-hooks.ts` define their own shell-quoting function with the same logic (`value.replace(/'/g, "'\\''")`) but different names and slightly different signatures. `escapeSingleQuoted` in session-manager returns the inner escaped string; `shellSingleQuote` in hooks wraps it in single quotes and returns the full token.
- Impact: If the escaping logic needs to change (e.g., to handle NUL bytes or locale-specific shells), it must be updated in two places. This violates DRY within the same package.
- Fix: Extract a shared utility in a `tmux-utils.ts` file (or in `types.ts` since it is already the shared module). Expose both variants if needed:

```typescript
// tmux-utils.ts
export function escapeForSingleQuote(value: string): string {
  return value.replace(/'/g, "'\\''");
}
export function shellSingleQuote(value: string): string {
  return `'${escapeForSingleQuote(value)}'`;
}
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`TmuxConnectorDeps.watch` type defined via `typeof fs.watch`** - `tmux-connector.ts:41`
**Confidence**: 80%
- Problem: The `WatchFn` type is defined as `typeof fs.watch`, which couples the type definition to Node's `fs` module. If the connector's DI goal is to be independent of the concrete `fs` module, the type should be defined structurally rather than referencing the concrete implementation.
- Impact: Minor -- this is a type-level coupling, not a runtime one. But it is inconsistent with how `ExecFn` in `types.ts:189` is defined structurally (`(cmd: string) => ExecResult`) rather than as `typeof child_process.execSync`.
- Fix: Define `WatchFn` structurally in `types.ts`:

```typescript
export type WatchFn = (
  path: string,
  options: { persistent: boolean },
  listener: (eventType: string, filename: string | null) => void
) => FSWatcher;
```

## Pre-existing Issues (Not Blocking)

No pre-existing issues found at CRITICAL severity.

## Suggestions (Lower Confidence)

- **ActiveSession could be split into sub-objects** - `tmux-connector.ts:96-119` (Confidence: 70%) -- The 18-field ActiveSession struct mixes lifecycle state (handle, exited), watcher state (sentinelWatcher, messagesWatcher, debounceTimers), delivery state (lastDeliveredSeq, pendingMessages, nextExpectedSeq, flushing), and staleness state (stalenessConfig, lastAliveCheck). Grouping into sub-objects (e.g., `session.delivery.lastDeliveredSeq`) would make the boundary between concerns explicit, even before extracting separate classes.

- **`TmuxSessionManager` and `TmuxHooks` interfaces could be in core** - `types.ts:198-224` (Confidence: 65%) -- Same concern as `TmuxConnectorPort` but lower confidence because these interfaces are internal to the tmux package and may not need external consumers. If Phase 2/3 never needs to mock SessionManager independently from Connector, keeping them in `implementations/tmux/types.ts` is fine.

- **`buildWrapperScript` generates a large bash string without template separation** - `tmux-hooks.ts:108-168` (Confidence: 62%) -- The wrapper script is a ~50-line bash heredoc embedded in TypeScript. If the script grows (e.g., adding stderr separation, multi-pipeline capture), maintaining it inline becomes difficult. A `.sh.template` file with placeholder substitution would separate concerns, but the current size is manageable.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Architecture Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The tmux abstraction layer demonstrates strong architectural foundations: clean interface segregation (4 separate interfaces for Connector, SessionManager, Hooks, Validator), consistent use of Result types throughout, proper dependency injection via Deps interfaces, and good layer separation between validation, session management, hooks, and orchestration. The error factory pattern in `errors.ts` follows the established codebase convention exactly. The barrel export in `index.ts` cleanly separates type-only and runtime re-exports.

The two HIGH findings (incomplete DI with fs defaults, SRP concern on TmuxConnector) and two MEDIUM findings (port interface location, duplicate escaping) should be addressed before merge. The connector is well-designed but tries to do too much in one class -- extracting message delivery and staleness detection would significantly improve maintainability for Phase 2/3 of the migration. The port interface location issue will become blocking when consumers outside the tmux package need to depend on `TmuxConnectorPort`.
