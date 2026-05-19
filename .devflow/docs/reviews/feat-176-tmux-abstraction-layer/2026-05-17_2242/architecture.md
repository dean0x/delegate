# Architecture Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17

## Issues in Your Changes (BLOCKING)

### HIGH

**Missing interface for TmuxConnector (DIP violation)** - `src/implementations/tmux/types.ts`
**Confidence**: 90%
- Problem: `TmuxSessionManager`, `TmuxHooks`, and `TmuxValidator` all have interfaces defined in `types.ts` that decouple consumers from implementations. `TmuxConnector` is the only module without a corresponding interface. Consumers that depend on the connector are forced to depend on the concrete class — violating Dependency Inversion and making it impossible to swap implementations or create test doubles without reaching for `as unknown as` casts.
- Impact: When the worker system integrates with this layer, it will be coupled directly to `TmuxConnector` rather than an abstraction. This complicates testing and locks down the API surface prematurely.
- Fix: Extract a `TmuxConnectorPort` (or similar) interface in `types.ts`:
```typescript
export interface TmuxConnectorPort {
  spawn(config: TmuxSpawnConfig, callbacks: SpawnCallbacks): Result<TmuxHandle, AutobeatError>;
  destroy(handle: TmuxHandle): Result<void, AutobeatError>;
  sendKeys(handle: TmuxHandle, keys: string): Result<void, AutobeatError>;
  isAlive(handle: TmuxHandle): Result<boolean, AutobeatError>;
  getActiveHandles(): TmuxHandle[];
  dispose(): void;
}
```

---

**TmuxConnector accumulates 5 distinct responsibilities (SRP pressure)** - `src/implementations/tmux/tmux-connector.ts`
**Confidence**: 82%
- Problem: The 700-line `TmuxConnector` class handles: (1) spawn orchestration, (2) message ordering/delivery with sequence watermarks, (3) staleness detection via shared timer, (4) fs.watch watcher lifecycle, (5) debounce logic. Each responsibility has independent reasons to change (e.g., switching from fs.watch to inotify, changing the ordering algorithm, tuning staleness heuristics).
- Impact: At 700 lines with 14 private methods and a complex `ActiveSession` state struct with 13 fields, this is approaching God-class territory. Future changes to staleness or message ordering will require modifying a class that also owns session lifecycle.
- Fix: This is a "should extract when it becomes painful" issue rather than an immediate block. The current internal decomposition (private methods grouped by concern, `ActiveSession` as a data struct) provides reasonable containment. If any single concern changes independently in the future, extract it into a collaborator:
  - `MessageDeliveryPipeline` — handles ordering, watermarks, pending buffer, gap detection
  - `StalenessMonitor` — shared timer, alive checks, stale detection
  - Keep the connector as the orchestrator composing these two + watchers

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`SpawnCallbacks` interface defined in implementation file rather than types.ts** - `src/implementations/tmux/tmux-connector.ts:80-83`
**Confidence**: 85%
- Problem: `SpawnCallbacks` is a public export from `tmux-connector.ts` and re-exported from `index.ts`. It defines the contract for how consumers receive output events and exit signals. Unlike the other contracts (`TmuxSessionManager`, `TmuxHooks`, `TmuxValidator`), this interface lives in the implementation file rather than the type-definitions file.
- Impact: Minor inconsistency — consumers importing from the barrel get it fine, but the architectural intent (types.ts = contracts, impl files = implementations) is muddied.
- Fix: Move `SpawnCallbacks` to `types.ts` alongside the other interface definitions. Keep the `TmuxConnectorDeps` interface in the implementation file (it's an implementation detail of the concrete class).

---

**`TmuxConnectorDeps` uses concrete `fs.FSWatcher` type in `ActiveSession`** - `src/implementations/tmux/tmux-connector.ts:90-91`
**Confidence**: 80%
- Problem: The `ActiveSession` struct stores `sentinelWatcher: fs.FSWatcher | null` and `messagesWatcher: fs.FSWatcher | null`. The `WatchFn` type alias already abstracts the watch creation, but the returned watcher is typed to the concrete Node `fs.FSWatcher`. This means the `ActiveSession` struct (and by extension all methods touching it) is coupled to the Node.js fs module's specific watcher API.
- Impact: Low immediate impact since this is internal state. However, if the layer ever needs to support alternative watch mechanisms (e.g., chokidar, native inotify), the internal state would need refactoring.
- Fix: Define a minimal `Watcher` interface:
```typescript
interface Watcher {
  close(): void;
  on(event: 'error', handler: (err: Error) => void): void;
}
```
Use this in `ActiveSession` and constrain `WatchFn` to return it. This keeps the internal contract minimal.

## Pre-existing Issues (Not Blocking)

(No pre-existing code — all files are new additions on this branch.)

## Suggestions (Lower Confidence)

- **Consider event emitter pattern for TmuxConnector callbacks** - `src/implementations/tmux/tmux-connector.ts:135` (Confidence: 65%) — The current callback-per-spawn model means each session gets its callbacks at spawn time, stored in `ActiveSession`. An alternative is an EventEmitter pattern where the connector emits typed events (`output`, `exit`, `stale`) keyed by taskId, allowing late-binding of listeners. However, the callback model is simpler and well-tested here.

- **`injectEnvironment` swallows errors silently** - `src/implementations/tmux/tmux-session-manager.ts:139-141` (Confidence: 70%) — The `injectEnvironment` private method executes the env-injection command and discards the result. The comment says "best-effort" which is a valid choice, but the caller has no way to know if env injection failed. For an infrastructure layer that downstream workers depend on, silent failures in environment setup could cause hard-to-debug task failures. A logged warning would improve observability.

- **Constants in types.ts could be a separate constants.ts** - `src/implementations/tmux/types.ts:219-255` (Confidence: 62%) — The types.ts file mixes pure type definitions (interfaces, type aliases) with runtime constants (regex patterns, numeric limits). Separating into `types.ts` (zero runtime) and `constants.ts` (runtime values) would enforce a clearer boundary, though the current structure is functional and not harmful.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 0 | - |
| Should Fix | - | 0 | 2 | - |
| Pre-existing | - | - | 0 | 0 |

**Architecture Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

## Rationale

The tmux abstraction layer demonstrates strong architectural fundamentals:

**Strengths**:
- Clean dependency direction — all imports point inward to `core/`, never outward or sideways
- Consistent DI pattern — all three lower-level modules accept injectable deps via constructor
- Well-defined layer boundaries — types.ts (contracts) -> validator (prerequisites) -> session-manager (primitives) -> hooks (script gen) -> connector (orchestration)
- Result type consistency — every fallible operation returns `Result<T, AutobeatError>`, no exceptions thrown
- Interface segregation for collaborators — `TmuxSessionManager`, `TmuxHooks`, `TmuxValidator` are all narrow, focused interfaces
- No circular dependencies — import graph is a strict DAG
- Barrel re-exports separate type-only from runtime — `index.ts` uses `export type` for interfaces

**Conditions for approval**:
1. Add a `TmuxConnectorPort` interface in types.ts (HIGH — infrastructure contract that consumers will depend on)
2. Acknowledge that SRP pressure on the connector is acceptable for v1 but should be decomposed if staleness or message-ordering logic grows independently
