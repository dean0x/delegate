# Architecture Review Report

**Branch**: feat/dashboard-redesign-v1.3.0 -> main
**Date**: 2026-04-11 22:00
**Diff command**: `git diff main...HEAD`
**Scope**: 97 files, ~12.5k insertions
**Pitfalls file**: `.memory/knowledge/pitfalls.md` — 0 active pitfalls (no overlap to flag)

## Issues in Your Changes (BLOCKING)

### CRITICAL

_None._ The new event-driven plumbing (UsageCaptureHandler), new repository (UsageRepository), and the orchestration cancel cascade all stay inside the established architecture (Result types, DI, event handlers, no leaks of infrastructure into domain).

### HIGH

**Single-Responsibility violation: `useKeyboard` hook is now a 1,091-line god module spanning four navigation modes** — `src/cli/dashboard/use-keyboard.ts:1-1091`
**Confidence**: 95%

- Problem: A single file/hook now contains:
  - `handleDetailKeys` (lines 173-300) for entity detail
  - `handleWorkspaceKeys` (lines 319-593) for workspace mode
  - `handleMainKeys` (lines 624-1005) for the main panel grid (with another nested mode for `activityFocused`)
  - `useKeyboard` shell (lines 1018-1091) plus several helper tables

  Each handler reaches into a 12-field `KeyHandlerParams` (mutations, dataRef, workspaceNav, setView, setNav, setWorkspaceNav, refreshNow, …). The single-mode handlers each independently re-implement cancel/delete dispatch over four entity kinds; the diff under `c` and `d` keys is duplicated three times (workspace nav vs. workspace grid vs. main panel vs. activity feed), with subtle variations (e.g., the nav-cancel calls `cancelOrchestration(..., { cancelAttributedTasks: true })` while the main-panel cancel does not). That divergence is the kind of bug SRP exists to prevent.

  `KeyHandlerParams` carrying both `nav` and `setNav`, plus `workspaceNav`/`setWorkspaceNav`, plus `mutations`, plus `dataRef` is a textbook "data clump" smell — five reasons to change in one container, and it changes whenever any of the four keyboard modes change.

  CLAUDE.md global guidance lists "Can you explain the design to junior developer in 2 minutes?" as a quality gate. With three handler functions, four entity kinds, two focus areas in workspace, and two focus modes in main, the answer is no.

- Fix: Split per view mode into sibling files and dispatch in `useKeyboard`:
  - `src/cli/dashboard/keyboard/use-detail-keys.ts`
  - `src/cli/dashboard/keyboard/use-workspace-keys.ts`
  - `src/cli/dashboard/keyboard/use-main-keys.ts`
  - `src/cli/dashboard/keyboard/dispatch-cancel.ts` and `dispatch-delete.ts` — single source of truth for the four-way switch on entity kind. Both the activity-feed handler and the main-panel handler should call into the same dispatcher. That eliminates the silent inconsistency where activity-row cancel cascades attributed tasks but main-panel cancel does not.
  - Promote the `Identifiable`/`getPanelItems`/`filteredLength`/`clamp` helpers to `keyboard/helpers.ts`.

  This would also let `use-keyboard.test.tsx` (1,331 lines!) split into per-mode test files.

**Hidden behavioral difference between activity-row cancel and main-panel cancel — same key, different cascade semantics** — `src/cli/dashboard/use-keyboard.ts:735-767, 897-933`
**Confidence**: 92%

- Problem: Pressing `c` on an orchestration row in the **activity feed** (line 745) calls `cancelOrchestration(id, reason, { cancelAttributedTasks: true })` so attributed sub-tasks are cancelled. Pressing `c` on an orchestration row in the **main orchestrations panel** (line 914) calls `cancelOrchestration(selectedItem.id, reason)` with no options, which silently relies on the service default. The service-side default in `OrchestrationManagerService.cancelOrchestration` (line 396) is `opts?.cancelAttributedTasks !== false` — i.e., the same behavior — so the runtime result happens to be identical today, but the call sites encode different intent and a future change to the default will break only one of them.

  This is a Don't-Repeat-Yourself / Tell-Don't-Ask violation made worse by being invisible: the two key handlers express the same user intent through different APIs, and the inconsistency is one git commit away from becoming a real bug.

- Fix: Centralise the cancel intent in a single helper, e.g., `cancelEntityFromDashboard(mutations, kind, id)` and call it from both sites. Pass `cancelAttributedTasks: true` explicitly in both, or omit in both — pick one and stop relying on a hidden service default at one of the two call sites.

**`useDashboardData` hook (UI layer) reaches directly into a service-layer utility (`checkOrchestrationLiveness`) and into 7+ repositories** — `src/cli/dashboard/use-dashboard-data.ts:16, 89-189, 197-236, 246-310`
**Confidence**: 88%

- Problem: The hook imports `checkOrchestrationLiveness` from `src/services/orchestration-liveness.ts`. Liveness tracing is a service concern (orchestration → loop → iteration → task → worker → PID-check). The dashboard is now coupled directly to that service utility *and* to seven repositories (`taskRepository`, `loopRepository`, `scheduleRepository`, `orchestrationRepository`, `usageRepository`, plus `workerRepository`, `outputRepository`).

  This is a Clean Architecture / hexagonal layering violation in spirit:
  - The hook imports a service helper (`orchestration-liveness`) that itself depends on three repositories. The dashboard now reaches three layers deep.
  - The hook duplicates `RecoveryManager.isProcessAlive` (lines 49-56) — same `process.kill(pid, 0)` + EPERM logic in two places. The shared utility (`checkOrchestrationLiveness`) was extracted exactly to avoid drift, but the PID-check predicate was *not* extracted alongside it, undoing half the benefit.
  - `fetchAllData`/`fetchMetricsExtras`/`fetchWorkspaceExtras`/`fetchDetailExtra` aggregate ten queries, status counts, liveness checks, activity feed merging, and pagination math directly inside a React hook file. This is service-layer responsibility hosted in `cli/dashboard/`.

- Fix:
  1. Extract `isProcessAlive` to `src/utils/process-liveness.ts` and have both `RecoveryManager` and `checkOrchestrationLiveness` consume it. This locks in the "single source of truth" the v1.3.0 commit message claims.
  2. Introduce a `DashboardQueryService` (`src/services/dashboard-query-service.ts`) that owns all aggregate fetches: `getMainSnapshot()`, `getWorkspaceSnapshot(orchId)`, `getDetailExtras(view)`, `getOrchestrationLiveness(list)`. The hook becomes a thin polling wrapper that calls one of those three methods. The dashboard then no longer depends on individual repositories directly — it depends on a single service interface.
  3. Move `buildActivityFeed`, `buildEntityCounts`, and the metrics extras zip-up into that service.

  This is a deeper refactor than the others on this list, but it pays for itself the next time another consumer (e.g., a JSON `beat status` endpoint) needs the same aggregated data.

**`OrchestrationManagerService` SRP creep: cancel cascade introduces a second responsibility (sub-task lifecycle) into the orchestration service** — `src/services/orchestration-manager.ts:417-452, 49-77`
**Confidence**: 82%

- Problem: `OrchestrationManagerService` was previously responsible for orchestration CRUD + loop lifecycle delegation. v1.3.0 adds:
  - `cancelAttributedTasks(id, reason)` (lines 421-452) — iterates queued/running tasks and calls `taskManager.cancel` per item.
  - Optional `taskRepository` and `taskManager` deps (lines 56-57) marked "Optional" specifically to avoid breaking existing constructions.

  The "optional dep so we don't break the API" pattern signals that the cascade behavior is grafted on top of the original responsibility rather than being intrinsic to it. Two reasons to change in one class: orchestration lifecycle, and "what to do with attributed tasks when an orchestration ends." The latter will only grow (cancel cascade today, completion fan-in tomorrow, retry cascade after that).

  Additionally, `cancelAttributedTasks` cancels tasks **sequentially** in a `for` loop (line 442). At max default (50 attributed tasks per page) on an orchestration with many running children, this serializes the worst-case dashboard cancel response. This is also a layering oddity: the orchestration *service* is now imperatively reaching into the task manager rather than emitting an event (`OrchestrationCancelled`) that a listener (e.g., a hypothetical `AttributedTaskCancellationHandler`) consumes. The codebase's iron law from CLAUDE.md is "Commands flow through EventBus." This new code reads the bus event but the cascade itself bypasses it.

- Fix (one of two paths, not both):
  1. **Event-driven**: Add a small `AttributedTaskCancellationHandler` (or fold into an existing handler) that subscribes to `OrchestrationCancelled` and performs the cascade. `OrchestrationManagerService` only emits and never imports `TaskManager`. This is the architecturally clean answer and matches the codebase's iron law.
  2. **Service composition** (less invasive): Extract `OrchestrationCascadeService` with `cancelAttributedTasks(orchId)` and inject *that* into `OrchestrationManagerService`. Use `Promise.all` for concurrent cancellation — the service side does not need to be sequential.

  Either path eliminates the optional-dep tell.

### MEDIUM

**`UsageCaptureHandler` and `OrchestrationCancelled` create a hidden second event-driven ordering rule** — `src/services/handlers/usage-capture-handler.ts:75-157`, `src/services/orchestration-manager.ts:402`
**Confidence**: 80%

- Problem: The handler relies on the comment at line 105: "ProcessConnector flush is guaranteed complete before TaskCompleted." That guarantee lives in `event-driven-worker-pool.ts` and `process-connector.ts`. There is no test in `tests/integration/` that asserts the flush-before-emit ordering and no static guard. If `EventDrivenWorkerPool.handleWorkerCompletion` or `ProcessConnector` ever changes to emit `TaskCompleted` before fully draining the output buffer, `UsageCaptureHandler` will silently drop usage records (the parser will return `null` because the `{"type":"result"}` marker is in unflushed bytes). The handler uses `logger.warn` for *every* failure path (lines 87, 108, 124, 142) — best-effort silence.

  The dependency is real and load-bearing but invisible from the handler code. This is a temporal coupling between two distant components.

- Fix:
  1. Add an integration test in `tests/integration/usage-capture-flush-ordering.test.ts` that simulates a Claude run with the result JSON in the *last* output chunk and asserts a usage row is persisted.
  2. Add a comment block to `EventDrivenWorkerPool.handleWorkerCompletion` (and to `ProcessConnector.handleExit` if applicable) calling out that `UsageCaptureHandler` depends on the flush-before-emit ordering. Cross-link the two files explicitly so the next maintainer of either side sees the contract.

**`use-task-output-stream.ts` mixes 5 concerns inside a single 372-line hook** — `src/cli/dashboard/use-task-output-stream.ts`
**Confidence**: 80%

- Problem: The hook combines:
  - ANSI stripping (`stripAnsi`)
  - Line splitting (`mergeOutputLines`)
  - Delta parsing with byte-vs-char arithmetic (lines 124-144) — note the "We work in byte offsets — convert byte offset to char offset" comment plus a `Buffer.byteLength` round-trip in the hot path
  - Ring-buffer trimming with overflow accounting
  - React state coordination (taskIds → streamsRef Map, terminal-fetched set, version counter, fetching ref, closing ref)
  - Polling cadence gating per task status

  The pure functions are exported and unit-tested separately, which is good. But they live in the same file as the React hook, so the file's reason-to-change set is huge. Moreover, the byte/char delta logic is duplicated in spirit with `linesByteSize` mentioned in MEMORY.md ("Shared linesByteSize utility — Extracted from duplication"). New duplication of nearly the same byte-arithmetic pattern is exactly what that prior decision was meant to prevent.

- Fix: Extract the pure helpers + the delta-parser to `src/cli/dashboard/output-stream-buffer.ts` (no React imports), and reduce the hook to a thin polling/state shell. The "shouldPollThisTick" cadence logic could go in the same buffer module since it's also pure. Hook becomes ~120 lines.

**Re-export oddities in `core/interfaces.ts`** — `src/core/interfaces.ts:end-of-file`
**Confidence**: 85%

- Problem: At the end of `interfaces.ts` (after the new `UsageRepository` interface) you re-export `ActivityEntry`, `OrchestratorChild`, and `TaskUsage` from `domain.js`:

  ```ts
  // Re-export for convenience (consumers can import from interfaces instead of domain)
  export type { ActivityEntry, OrchestratorChild, TaskUsage };
  ```

  This blurs a layer boundary that the rest of the codebase keeps clean: `interfaces.ts` is for ports (DI contracts); `domain.ts` is the model. Re-exporting domain types from `interfaces.ts` "for convenience" means consumers won't know whether to import from `domain.js` or `interfaces.js`, and over time you'll get half the codebase using each path. Two import sources for the same type is a recipe for circular dependencies once one of them touches the other module.

- Fix: Drop the re-export. Consumers can import from `domain.js` like every other domain type. If you really want a `core/index.ts` barrel to re-export everything, that's a separate (acceptable) pattern.

**`use-keyboard.ts` uses an object-shaped `returnTo` for orchestration drill-through but a string for everything else — discriminated union split across two files** — `src/cli/dashboard/types.ts:63-107` and consumed in `src/cli/dashboard/use-keyboard.ts:182-243`
**Confidence**: 78%

- Problem: `DetailReturnTarget` is a four-shape union: `'main'` | `'workspace'` | `{ kind: 'orchestrations', entityId, originalReturnTo }`. Only the **tasks** detail variant uses `DetailReturnTarget`; loops/schedules/orchestrations are restricted to the two strings. The narrow form is correct for those cases, but readers of the code now must look up the exact kind to know what `returnTo` shapes are legal.

  Inside `handleDetailKeys`, the logic at lines 184-196 unpacks the variant with `typeof returnTo === 'object'` — TypeScript discrimination on shape rather than `kind`. The discriminant exists (`returnTo.kind === 'orchestrations'`) but is checked after `typeof`, which is unidiomatic.

- Fix: Make all four detail variants share the same `DetailReturnTarget` type (uniform interface). Deletion: `LoopId`/`ScheduleId`/`OrchestratorId` detail views simply never set `returnTo` to the object form because the keyboard handlers don't construct it for them. This makes the discriminated union genuinely discriminated by `kind`, not by JS `typeof`.

## Issues in Code You Touched (Should Fix)

**`Bootstrap`'s eager handler-wiring sanity check duplicates handler registration logic and uses string-based cross-checking** — `src/bootstrap.ts:419-464`
**Confidence**: 82%

- Problem: After `setupEventHandlers`, bootstrap performs a defensive sanity check that no critical event has zero subscribers (`'LoopCreated', 'TaskQueued', 'LoopCompleted'`). The string list lives in two places: here, and the `subscribeToEvents` methods inside each handler. Adding a new critical event means updating this list manually. The pattern violates DRY and is silently fragile — a misspelled event name passes the check.

  Also note: the cast `container.get<InMemoryEventBus>('eventBus')` couples bootstrap to a concrete implementation in order to read `getSubscriberCount`. The `EventBus` interface should expose subscriber counts (or a `verifySubscriptions(criticalEvents)` method) so this code can talk to the abstraction.

- Fix: Move `getSubscriberCount` (or a higher-level `verifyHasSubscribers(eventName)`) into the `EventBus` interface in `src/core/events/event-bus.ts`. Have each handler declare its critical events via a static field (`static CRITICAL_EVENTS = [...]`) and have `setupEventHandlers` aggregate them, then run the verify pass. No string list lives outside its handler.

**`fetchAllData` runs `checkOrchestrationLiveness` sequentially in a `for` loop over RUNNING orchestrations** — `src/cli/dashboard/use-dashboard-data.ts:139-157`
**Confidence**: 88%

- Problem: Each liveness check makes 3 DB round trips (loop iterations, task lookup, worker findByTaskId) plus a `process.kill(pid, 0)` syscall. With 10 RUNNING orchestrations the sequential loop blocks the polling fetch by ~30 round trips on every 1-second tick. The hook also runs *inside* the React render path because `useDashboardData` is mounted at the root.

  This is the same SRP/coupling issue as the bigger fetch-all-data finding above, but flagged separately because the sequential `for...of` over async work is a concrete performance bug introduced by this PR.

- Fix: `await Promise.all(runningOrchs.map(checkOrchestrationLiveness))`. Same defensive try/catch surrounding each promise as today. Combined with extracting the whole thing to `DashboardQueryService` (HIGH finding above), this becomes a one-liner.

**Recovery manager phase 1d (`failZombieRunningOrchestrations`) is a 7th cleanup phase that pushes recovery toward a god class** — `src/services/recovery-manager.ts:227-273`
**Confidence**: 75%

- Problem: `RecoveryManager.recover()` is up to 9 phases (Phase 0, 1, 1b, 1c, 1d, 2, 3 plus the worker registration walk inside Phase 0). `RecoveryManager` is now responsible for: dead-worker cleanup, task GC, loop GC, orchestration GC, zombie orchestration detection, queued task recovery, running task recovery. Seven distinct reasons to change. The constructor takes 8 deps (`taskRepo`, `queue`, `eventBus`, `logger`, `workerRepo`, `dependencyRepo`, `loopRepo?`, `orchestrationRepo?`) — the global guideline `*Manager` warning sign at 7+ params is now tripped.

  The new phase imports `checkOrchestrationLiveness` and `OrchestratorStatus`, `updateOrchestration`. Each new entity has so far required adding a sibling phase. v1.4.0 will likely add a "checkpoint cleanup" or "usage cleanup" phase, then we're at 8.

- Fix: Extract phases into per-entity Recoverer objects: `WorkerRecoverer`, `TaskRecoverer`, `LoopRecoverer`, `OrchestrationRecoverer`. `RecoveryManager` becomes a coordinator that calls them in order. This is the same Strategy decomposition the codebase already uses for `ExitConditionEvaluator` (`ShellExitConditionEvaluator` + `AgentExitConditionEvaluator` composed by `CompositeExitConditionEvaluator`). The pattern is established; just apply it.

**`bootstrap.ts` registers handlers eagerly but `setupEventHandlers` returns 9 named handlers from a single function — large multi-purpose function** — `src/services/handler-setup.ts:219-442`
**Confidence**: 70%

- Problem: `setupEventHandlers` is now 224 lines, creates 9 distinct handlers, and on each failure must remember to call `registry.shutdown()` for cleanup. The cleanup pattern is repeated 4 times (lines 290, 316, 339, 374) — 5 if you count the orchestration/usage warnings that *don't* shutdown. Adding a new optional handler in v1.4.0 adds another 30 lines and another `if (!result.ok) { await registry.shutdown(); return err(...); }` block.

  The two optional-handler blocks (`OrchestrationHandler` lines 387-403, `UsageCaptureHandler` lines 409-426) follow the same template literally. That's not DRY.

- Fix: Introduce a small helper:
  ```ts
  async function createOptionalHandler<T>(
    name: string,
    factory: () => Promise<Result<T>>,
    setupLogger: Logger,
  ): Promise<T | undefined> { … }
  ```
  And a `createRequiredHandler` for the four required factory handlers. The body of `setupEventHandlers` collapses to ~80 lines of straight-line setup. This is also where you'd centralise the "register each created handler with a critical-events list" referenced in the bootstrap-sanity-check finding above.

**Missing dispose method on `UsageCaptureHandler`** — `src/services/handlers/usage-capture-handler.ts:28-158`
**Confidence**: 72%

- Problem: The handler subscribes to the EventBus in `subscribeToEvents()` (line 64) but never exposes an `unsubscribe`/`dispose` lifecycle method. Compare to `OrchestrationHandler`, `LoopHandler`, etc. which use the same factory pattern but the registry manages their teardown. `UsageCaptureHandler` is held only in `HandlerSetupResult.usageCaptureHandler` (set conditionally) and `bootstrap.ts` does **not** register it in the container at all (lines 442-443 only register `orchestrationHandler`). On `container.dispose()` the handler is leaked: its subscription to `TaskCompleted` keeps the EventBus from being GC'd, and any in-flight `captureUsage` after a fast restart can race with the closing DB.

  This is the same reason CheckpointHandler/LoopHandler use `BaseEventHandler.dispose` and are returned from `setupEventHandlers` so the lifecycle is owned somewhere.

- Fix: Either (a) register `usageCaptureHandler` in the container (matching the orchestrationHandler pattern at bootstrap.ts:441-443) **and** verify `dispose()` chains through `container.dispose()`, or (b) move `UsageCaptureHandler` into the standard registry (`registry.registerAll([...])`) so it shares the registry's lifecycle. Option (b) is cleaner now that the handler's subscription is mode-independent (CLAUDE.md DECISION 2026-04-10 already says all modes wire handlers).

## Pre-existing Issues (Not Blocking)

**`bootstrap.ts` factory functions throw inside `registerSingleton` callbacks instead of returning Result** — `src/bootstrap.ts:134-140` (pre-existing, comment dated 2025)
**Confidence**: 90%

- Problem: `getFromContainer` deliberately throws so factory closures stay synchronous, with the rationale that container `resolve()` catches and converts to Result. This is a justified architectural exception, but it's a Result-pattern hole at the bottom of every singleton factory. The codebase has lived with it; not flagging as blocking.

**`SQLiteOrchestrationRepository.getOrchestratorChildren` builds the SQL string inline inside the async method instead of via a prepared statement field** — `src/implementations/orchestration-repository.ts` v1.3.0 additions
**Confidence**: 80%

- Problem: Every other query in this repository uses a class-level `*Stmt` prepared statement. The new `getOrchestratorChildren` re-prepares the same SQL on every call inside `tryCatchAsync`. The CTE is non-trivial. better-sqlite3 caches prepared statements per `Database` so the cost may be amortised, but the *style* is now inconsistent with the rest of the file. Pre-existing in the sense that the rest of the file's style is the prior convention; the new method violates it.

- Fix: Hoist into `private readonly getOrchestratorChildrenStmt: SQLite.Statement` like every sibling.

## Suggestions (Lower Confidence)

- **`use-keyboard.ts` workspace-mode `down arrow` clamp uses `Number.MAX_SAFE_INTEGER` as a sentinel** — `src/cli/dashboard/use-keyboard.ts:391` (Confidence: 65%) — when no orchestrations exist, the clamp is unbounded. Fine in practice (no list to scroll past) but the sentinel reads like a bug. Prefer an explicit guard `if (orchList.length === 0) return prev`.
- **`activity-feed.ts` constructs `new Date(timestamp)` per entry then re-sorts with `.getTime()`** — `src/cli/dashboard/activity-feed.ts:91-131` (Confidence: 60%) — wasteful for the polling-merge use case; sort by raw `updatedAt` numbers and only construct Dates once for display. This is style but the merge runs every 1s.
- **`fetchWorkspaceExtras` swallows errors with a bare `try/catch (...) { return {} }`** — `src/cli/dashboard/use-dashboard-data.ts:251-310` (Confidence: 65%) — defensible for "best-effort," but `result.ok` guards everywhere else in the file mean a *throwing* repository is the only path that hits this catch. The catch should at least set an error field on `DashboardData` so the user sees a degraded indicator instead of empty workspace.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 4 | 4 | - |
| Should Fix | - | 2 | 3 | - |
| Pre-existing | - | - | 2 | - |

**Architecture Score**: 6/10

**Strengths to keep**:
- The hybrid event-driven contract (commands via EventBus, queries via repos) is preserved everywhere new code touches the back end.
- `UsageCaptureHandler`, `UsageRepository`, and `parseClaudeUsage` are clean: Result types, factory pattern matching `CheckpointHandler`/`LoopHandler`, no throws in business logic, idempotent UPSERT.
- `OrchestrationHandler` registration in the container (bootstrap.ts:441-443, comment "fix the pre-existing oversight") is a good housekeeping cleanup.
- Extracting `checkOrchestrationLiveness` to a shared utility is the right call architecturally — both `RecoveryManager` and the dashboard depend on it. The follow-through (also extracting `isProcessAlive`) is incomplete.
- `layout.ts` is cleanly factored — pure functions, fully unit-testable, no React imports.
- The new domain types (`TaskUsage`, `OrchestratorChild`, `ActivityEntry`) are read-only value objects with no mutation surface — exactly the immutability requirement from CLAUDE.md.
- New types added to `interfaces.ts` (`UsageRepository`, `findUpdatedSince` extensions, `getOrchestratorChildren`, `updateIfStatus`) are coherent additions that follow existing repository conventions.

**Weaknesses to address before merge**:
- `useKeyboard` is now a 1,091-line god module containing 4 navigation modes plus duplicated cancel/delete dispatchers. Split into per-mode files and a shared dispatcher (HIGH).
- The activity-row vs main-panel cancel cascade discrepancy is one config change away from being a real bug (HIGH).
- The dashboard data hook directly imports a service utility and seven repositories — three layers deep. Introduce a `DashboardQueryService` to restore the boundary (HIGH).
- `OrchestrationManagerService` grew an "optional" `taskRepository`/`taskManager` deps to support cancel cascade. The optional-dep tell signals the responsibility doesn't belong here — extract to a handler that subscribes to `OrchestrationCancelled` (HIGH).
- `UsageCaptureHandler` is not registered in the container and has no dispose path — leaks subscription on shutdown (MEDIUM).
- `RecoveryManager` is now seven phases and 8 deps; apply the same Strategy decomposition the rest of the codebase already uses for evaluators (MEDIUM).

**Recommendation**: **CHANGES_REQUESTED**

The PR delivers a substantial dashboard redesign with mostly sound architecture in the new repositories, handlers, and domain types. The blocking issues are concentrated in `use-keyboard.ts` (god module + behavioral inconsistency), the dashboard data layer (skipping the service boundary), and the orchestration cancel cascade (placed in the wrong layer). All four HIGH findings have well-bounded fixes that do not require redesigning the feature — they require splitting files, adding a service, and moving one cascade into a handler. The MEDIUM findings (UsageCaptureHandler lifecycle, RecoveryManager bloat, handler-setup duplication) should land in the same PR to keep the architectural debt from compounding into v1.4.0.

The release notes (`docs/releases/RELEASE_NOTES_v1.3.0.md`) and the existing decision comments in code show genuine care has gone into the rollout — the issues here are about *where* concerns live, not whether the concerns are correct. With the four HIGH findings fixed, this is an APPROVED-quality PR.
