---
feature: tmux-infrastructure
name: Tmux Abstraction Layer
description: "Use when working on the tmux abstraction layer, wiring TmuxConnector into agent adapters (Phase 2) or WorkerPool (Phase 3), extending agent support via TmuxAgentType, or understanding the core/tmux-types.ts port boundary. Keywords: tmux, abstraction, connector, hooks, session manager, validator, sentinel, debounce, flush, agent type, jq, wrapper script, setup shim, persistent, sequence ordering, TmuxAgentType, TmuxSpawnCoreConfig, TmuxConnectorPort, core/tmux-types."
category: architecture
directories:
  - src/implementations/tmux/
  - tests/unit/implementations/tmux/
  - tests/integration/tmux/
referencedFiles:
  - src/implementations/tmux/types.ts
  - src/implementations/tmux/tmux-connector.ts
  - src/implementations/tmux/tmux-hooks.ts
  - src/implementations/tmux/tmux-session-manager.ts
  - src/implementations/tmux/tmux-validator.ts
  - src/implementations/tmux/tmux-shell-utils.ts
  - src/implementations/tmux/index.ts
  - src/core/errors.ts
  - src/core/tmux-types.ts
created: 2026-05-17
updated: 2026-05-24
---

# Tmux Abstraction Layer

## Overview

Phases 1–5 of the v1.6.0 worker migration epic (#175) are complete and merged to main. Phase 6 (channel domain persistence) is in progress on `feat/181-channel-domain-persistence`.

This entry covers the **structural design** of the tmux abstraction layer — the type architecture, port interfaces, agent-type integration, `ActiveSession` internals, and the core/implementation boundary split. For the full spawn sequence, error code table, and hands-on wiring guide, see the companion `tmux-runtime` knowledge entry.

## Phase Status

| Phase | Description | Status |
|---|---|---|
| 1 | Four-class tmux abstraction (TmuxValidator, TmuxSessionManager, TmuxHooks, TmuxConnector) | Complete (main) |
| 2 | Agent adapter integration (Claude, Codex — `buildTmuxCommand`) | Complete (main) |
| 3 | WorkerPool rewiring to TmuxConnectorPort; core/tmux-types.ts introduced | Complete (main) |
| 4 | Session-based recovery and orphan cleanup (RecoveryManager) | Complete (main) |
| 5 | Bootstrap, usage parsing, cleanup; persistent session mode | Complete (main) |
| 6 | Channel domain persistence (multi-agent sessions) | In progress (#181) |

## Layer Architecture: core vs. implementation split

### `src/core/tmux-types.ts` (Phase 3 addition)

Introduced to break the circular dependency between `core/agents.ts` (AgentAdapter return types) and `src/implementations/tmux/types.ts` (TmuxSpawnConfig). Defines the **consumer-facing contracts** only:

- `TmuxHandle` — handle to a live session; returned from `spawn()`; passed back to `destroy`/`sendKeys`/etc.
- `OutputMessage` — single output message written by the wrapper script (`sequence`, `timestamp`, `type`, `content`)
- `SpawnCallbacks` — `onOutput` and `onExit` callbacks
- `TmuxSpawnCoreConfig` — minimal spawn config at the port boundary (fields core consumers need; see below)
- `TmuxSessionManagerCorePort` — minimal session manager interface for RecoveryManager (`isAlive`, `sendControlKeys`, `listSessions`, `destroySession`)
- `TmuxConnectorPort` — full connector interface used by EventDrivenWorkerPool (`spawn`, `destroy`, `sendKeys`, `sendControlKeys`, `isAlive`, `setEnvironment`, `getActiveHandles`, `dispose`)

`src/implementations/tmux/types.ts` **re-exports** all of the above from `core/tmux-types.ts` for backward compatibility — existing callers importing from `tmux/types.ts` continue to work without changes.

### `TmuxSpawnCoreConfig` (core-layer minimal spawn config)

Fields defined at the port boundary so core consumers can construct configs without importing from the implementations layer:

```ts
interface TmuxSpawnCoreConfig {
  taskId: TaskId;
  sessionsDir: string;
  name: string;          // session name (beat-* prefix)
  command: string;       // agent executable
  agentArgs: readonly string[];
  env?: Record<string, string>;
  persistent?: boolean;  // Phase 5: persistent session mode
}
```

`TmuxSpawnConfig` (in `src/implementations/tmux/types.ts`) extends `TmuxSpawnCoreConfig` and adds `agent: TmuxAgentType`, `staleness?: Partial<StalenessConfig>`. `TmuxConnector.spawn()` accepts `TmuxSpawnCoreConfig` (the port type) and casts it to `TmuxSpawnConfig` at the implementation boundary.

### `TmuxConnectorPort` (Phase 3–5 additions)

The port interface grew across phases. Current methods:

```ts
interface TmuxConnectorPort {
  spawn(config: TmuxSpawnCoreConfig, callbacks: SpawnCallbacks): Result<TmuxHandle, AutobeatError>;
  destroy(handle: TmuxHandle): Result<void, AutobeatError>;
  sendKeys(handle: TmuxHandle, keys: string): Result<void, AutobeatError>;
  sendControlKeys(handle: TmuxHandle, keys: string): Result<void, AutobeatError>;  // Phase 3
  isAlive(handle: TmuxHandle): Result<boolean, AutobeatError>;
  setEnvironment(handle: TmuxHandle, varName: string, value: string): Result<void, AutobeatError>;  // Phase 5
  getActiveHandles(): TmuxHandle[];  // Phase 3
  dispose(): void;
}
```

`sendControlKeys` was added in Phase 3 — sends control sequences (e.g. `C-c`) without the `-l` literal flag. `setEnvironment` was added in Phase 5 for persistent session reuse — WorkerPool calls it to update `AUTOBEAT_TASK_ID` before delegating a new loop iteration to the same session. `getActiveHandles` was added in Phase 3 for RecoveryManager to enumerate live sessions.

## Component Architecture

Four classes with a strict one-directional dependency hierarchy (no cycles). `TmuxConnector` is the sole public entry point:

```
TmuxConnector          ← only class callers use directly
  ├─ TmuxValidator     ← validates tmux >= 3.0 AND jq presence (success cached for process lifetime)
  ├─ TmuxHooks         ← wrapper script + setup shim generation; session directory lifecycle
  └─ TmuxSessionManager ← low-level tmux CLI facade (sync ExecFn)
```

All four classes accept their collaborators via constructor injection. No singletons, no module-level state.

### Interface/implementation split

`types.ts` defines four `*Port` dependency interfaces (`TmuxHooksPort`, `TmuxSessionManagerPort`, `TmuxValidatorPort`, and `TmuxConnectorPort` from core) that the concrete classes implement. `TmuxConnector` depends only on the `*Port` interfaces — it never imports the concrete classes directly. Unit tests inject lightweight test doubles without any mocking framework.

The barrel (`index.ts`) exports both sides: `*Port` interfaces for type annotations, concrete classes (`TmuxConnector`, `TmuxHooks`, `TmuxSessionManager`, `TmuxValidator`) for construction, and shell utilities (`escapeForSingleQuotes`, `singleQuoteToken`). Always import from the barrel, not from individual files.

### Agent type

`TmuxAgentType` is a type alias defined in `types.ts`:

```ts
export type TmuxAgentType = Extract<AgentProvider, 'claude' | 'codex'>;
```

This constrains the union at the type level. `TmuxSpawnConfig.agent` and `WrapperConfig.agent` both use `TmuxAgentType`. `TmuxConnector.spawn()` passes both `config.agent` and `config.agentArgs` to `hooks.generateWrapper()`. The wrapper script (`buildWrapperScript`) does not branch on agent type — it runs `{agentCommand} {agentArgs}` verbatim. All agent differentiation comes from `agentArgs` (e.g. `['--output-format', 'stream-json']` for Claude, `['--full-auto']` for Codex). The `agent` field in `WrapperConfig` is forwarded for typing and future use.

**Adding a new agent type**: Update `Extract<AgentProvider, 'claude' | 'codex'>` to include the new type AND add a `buildTmuxArgs()` branch in the agent adapter (`src/adapters/`). The wrapper template itself is agent-agnostic and needs no change.

### TmuxHooksPort additions (Phase 5)

```ts
interface TmuxHooksPort {
  generateWrapper(config: WrapperConfig): Result<WrapperManifest, AutobeatError>;
  generateSetupShim(config: SetupShimConfig): Result<SetupShimManifest, AutobeatError>;  // Phase 5
  cleanup(taskId: TaskId, sessionsDir: string): Result<void, AutobeatError>;
}
```

`generateSetupShim` was added for persistent session mode. The shim initialises the messages directory and sequence counter, then `exec`s the agent interactively (no `--print`). It returns `SetupShimManifest` with `shimPath`, `sessionDir`, `messagesDir`. The shim does NOT write sentinels — completion detection for persistent sessions is managed by WorkerPool / LoopHandler.

### TmuxSessionManagerPort additions (Phase 5)

```ts
// Added in Phase 5 to the full TmuxSessionManagerPort:
setSessionEnvironment(name: string, varName: string, value: string): Result<void, AutobeatError>;
```

Used by `TmuxConnector.setEnvironment()` to update `AUTOBEAT_TASK_ID` in a running persistent session. Not on `TmuxSessionManagerCorePort` (the minimal core-layer interface).

### ActiveSession internal state

`TmuxConnector` maintains an `ActiveSession` per task in `activeSessions: Map<string, ActiveSession>`. Key fields:

- `pendingMessages: Map<number, OutputMessage>` — buffer for out-of-order sequence-numbered messages
- `nextExpectedSeq: number` — next sequence number the delivery loop expects (starts at 1)
- `lastDeliveredSeq: number` — monotonic watermark preventing duplicate delivery
- `debounceTimers: Map<string, ReturnType<typeof setTimeout>>` — 50ms debounce per filename
- `messagesDir: string` — stored for disk-read flush on exit
- `callbacks: SpawnCallbacks` — stored for use by `flushPendingFiles()` (not just passed as parameters)
- `flushing: boolean` — re-entrancy guard for `flushPendingFiles()`

The delivery algorithm uses `nextExpectedSeq` to walk consecutive messages out of `pendingMessages`, and `lastDeliveredSeq` as a monotonic watermark so forced-delivery during flush cannot re-deliver already-seen messages. Both fields are necessary: `nextExpectedSeq` advances the walk; `lastDeliveredSeq` guards against duplicates when the gap-filling safety cap resets `nextExpectedSeq`.

### Pending message gap-filling safety cap

If `pendingMessages` grows past `MAX_PENDING_MESSAGES = 100` (a permanent gap caused by a dropped or never-written message file), `handleMessageFile` resets `nextExpectedSeq` to the lowest sequence currently in the buffer and re-runs the delivery loop. If the buffer remains above `MAX_PENDING_MESSAGES / 2` after the reset, `forceDeliverRemaining` drains it immediately — this breaks pathological oscillation patterns near the cap. A warning is logged with the skipped `nextExpectedSeq` value.

### Exit flush mechanism

All exit paths call `flushPendingFiles()` before tearing down watchers. This was added to fix the debounce-window message loss that occurred when an agent exited within 50ms of its last output. The flush:

1. Cancels all in-flight debounce timers (clears `debounceTimers`)
2. Reads all `.json` files from the messages directory synchronously via `readdirSync`
3. Parses and inserts them into `pendingMessages` if not already delivered
4. Delivers consecutive messages in order (via `deliverPendingMessages`), then force-delivers any remaining out-of-order messages via `forceDeliverRemaining`

`flushPendingFiles()` is called by `triggerExit()`, `destroy()`, and `dispose()`. The `flushing` guard prevents infinite loops when `onOutput` triggers `destroy()`.

### jq validation

`TmuxValidator.validate()` checks both tmux version AND jq availability (`command -v jq`) in a single call. **Only successful validations are cached** for the process lifetime — a failed validation is retried on the next `spawn()` call. If jq is absent at the time of a `spawn()` call, `validate()` returns an error and the session is not spawned; a subsequent call after jq is added to PATH will succeed. The wrapper script also carries a defense-in-depth check that exits 127 if jq disappears at runtime after validation passed (e.g. PATH change).

### Auto-injected environment variables

`TmuxSessionManager.createSession()` automatically injects two environment variables into every new session after spawn (via `tmux set-environment`):

- `AUTOBEAT_TASK_ID` — derived from the session name by stripping the `beat-` prefix
- `AUTOBEAT_SPAWN_TIME` — ISO 8601 timestamp at spawn time

Caller-provided `env` values are injected first; these auto-vars are injected second and win on conflict. Injection is best-effort — a failure does not roll back the session.

### Shared staleness timer

`TmuxConnector` maintains a single shared `setInterval` that calls `listSessions()` once per tick and checks all active sessions. This avoids O(N) concurrent `isAlive` syscalls. The timer starts on first spawn and stops when `activeSessions` empties. Per-session `maxSilenceMs` and `lastAliveCheck` remain per-session for independent stale detection.

### Persistent session reuse (Phase 5)

`EventDrivenWorkerPool` stores persistent session handles in `persistentSessions: Map<string, PersistentSessionEntry>` keyed by `persistentSessionKey` (e.g. `"loop-{loopId}"`). On each loop iteration reuse, WorkerPool calls `connector.setEnvironment(handle, 'AUTOBEAT_TASK_ID', newTaskId)` before delegating work. When a loop completes or fails, LoopHandler calls WorkerPool to destroy the persistent session, which calls `connector.destroy(handle)`.

## Integration Patterns

### Wiring for Phase 2 / Phase 3

The agent-type prerequisite is already complete. When connecting `TmuxConnector` into agent adapters or WorkerPool, the main additions needed are:

1. Construct `TmuxConnector` with the four injected deps (see the `tmux-runtime` feature knowledge entry for the wiring code example)
2. Pass `agent: TmuxAgentType` and `agentArgs: readonly string[]` in the config built from `TmuxSpawnCoreConfig` — the connector forwards both to `hooks.generateWrapper()`. `agentArgs` is the sole differentiation mechanism in the generated script (e.g. `['--output-format', 'stream-json']` for Claude, `['--full-auto']` for Codex)

`readdirSync` and `readFileSync` are injectable (default to their `fs` equivalents) and should be stubbed in unit tests. `readFile` (async) is used for the hot-path message handler and should also be stubbed.

### Session lifecycle ownership

`TmuxConnector` owns the active session map and all watcher/timer handles. Callers are responsible for:
- Calling `dispose()` on process shutdown (`SIGTERM`/`SIGINT`) — flushes and closes ALL active sessions
- Calling `TmuxHooks.cleanup(taskId, sessionsDir)` after task completion — removes the session directory tree (done automatically by `TmuxConnector.loggedCleanup()` on `spawn` failure, `destroy`, and `dispose`)

### Reading/writing session environment

`TmuxSessionManagerPort.getSessionEnvironment(name, varName)` retrieves a single env var from a live session via `tmux show-environment`.
`TmuxSessionManagerPort.setSessionEnvironment(name, varName, value)` sets an env var via `tmux set-environment`. Both are on the full `TmuxSessionManagerPort` interface. At the connector level, use `connector.setEnvironment(handle, varName, value)`.

## Anti-Patterns

- **Adding a new agent type only in `TmuxAgentType`** — updating `Extract<AgentProvider, 'claude' | 'codex'>` without also adding a `buildTmuxArgs()` branch in the agent adapter silently produces incorrect `agentArgs` for the new agent type. The wrapper script itself is agent-agnostic and needs no change.
- **Calling `flushPendingFiles()` from within `onOutput`** — the re-entrancy guard (`session.flushing`) prevents an infinite loop, but the guard silently skips the nested flush. If `onOutput` triggers `destroy()`, the guard ensures safety; do not introduce additional flush call sites that bypass the guard.
- **Bypassing the `isOutputMessage` type guard** — `handleMessageFile` and `flushPendingFiles` both validate parsed JSON through `isOutputMessage` before inserting into `pendingMessages`. Do not cast directly to `OutputMessage` without this guard; the `type` field is a literal union and an invalid value would cause silent downstream issues.
- **Using `TmuxSessionManagerCorePort` where `TmuxSessionManagerPort` is needed** — the core-layer interface omits `createSession`, `sendKeys`, `getSessionEnvironment`, `setSessionEnvironment`. Only use `TmuxSessionManagerCorePort` for RecoveryManager and other core-layer consumers.
- **Forgetting to import from `core/tmux-types.ts` for core-layer consumers** — code in `src/core/` or `src/services/` that needs `TmuxConnectorPort` or `TmuxHandle` must import from `../../core/tmux-types.js`, not from the implementations layer.

## Gotchas

- **`TmuxSpawnConfig` does not extend `TmuxSpawnCoreConfig` in the port** — `TmuxConnector.spawn()` accepts `TmuxSpawnCoreConfig` (the core-layer minimal type) and casts it to `TmuxSpawnConfig` (the implementation-layer richer type) at the implementation boundary. The cast is safe because `EventDrivenWorkerPool` constructs the config with all required fields.
- **Validator caches only success** — `TmuxValidator.validate()` caches successful results for the process lifetime, but failed results are NOT cached. A missing jq or old tmux causes the validation to re-run on every `spawn()` call until the environment is fixed.
- **`TmuxAgentType` does not include `'gemini'`** — `Extract<AgentProvider, 'claude' | 'codex'>` explicitly excludes Gemini. Adding it requires updating both the `Extract` arguments and the agent adapter's `buildTmuxArgs()`.
- **fs.watch watcher degradation is silent in spawn()** — if either watcher fails to start (rare, platform-specific), `spawn()` succeeds with no error. Sentinel and output delivery then depend entirely on the staleness fallback. This is documented behavior, not a bug.
- **`flushPendingFiles()` reads the disk synchronously** — on exit it calls `readdirSync` and `readFileSync`. These are blocking calls on the event loop. In production this is acceptable (exit path); do not move the flush into hot message-delivery paths. The hot-path message handler uses `readFile` (async) via `TmuxConnectorDeps.readFile`.
- **Terminal defaults are wide (220 x 50)** — `TmuxSessionManager` defaults to 220 columns x 50 rows. Override via `TmuxSessionConfig.width` / `height` if the spawned agent wraps output at a narrower terminal width.
- **Gap-filling resets `nextExpectedSeq` to the lowest available, not to `lastDeliveredSeq + 1`** — after the safety cap fires, some sequence numbers between `lastDeliveredSeq` and the first available pending message are permanently skipped. This is intended; if messages at those sequence numbers arrive later they will be dropped by the `lastDeliveredSeq` watermark check.
- **Duplicate `taskId` spawn is rejected** — `TmuxConnector.spawn()` checks `activeSessions` before proceeding; a duplicate `taskId` returns `tmuxSessionFailed` immediately to prevent orphaning the first session's watchers and timers.
- **`SetupShimConfig` and `WrapperConfig` are independent types** — `generateSetupShim` and `generateWrapper` take different config shapes. `SetupShimConfig` has no `communicationTargets`, `communicationMode`, or `returnAddress` fields. Do not pass a `WrapperConfig` to `generateSetupShim`.

## Key Files

- `src/core/tmux-types.ts` — consumer-facing port interfaces; `TmuxConnectorPort`, `TmuxSessionManagerCorePort`, `TmuxHandle`, `TmuxSpawnCoreConfig`, `OutputMessage`, `SpawnCallbacks`; import from here for core-layer consumers
- `src/implementations/tmux/tmux-connector.ts` — public entry point; `flushPendingFiles()` is the exit-flush mechanism; `ActiveSession` stores `messagesDir`, `callbacks`, `nextExpectedSeq`, and `flushing` for the flush and delivery logic; `setEnvironment`, `sendControlKeys`, `getActiveHandles` were added in Phases 3/5
- `src/implementations/tmux/tmux-hooks.ts` — wrapper script generation AND setup shim generation; jq is a hard requirement (`exit 127` if absent); `buildCommunicationBlock` handles inter-session forwarding; `SESSION_NAME_REGEX` guards injection in communication targets
- `src/implementations/tmux/tmux-session-manager.ts` — low-level tmux CLI facade; `getSessionEnvironment` and `setSessionEnvironment` are on the `TmuxSessionManagerPort` interface; auto-injects `AUTOBEAT_TASK_ID` and `AUTOBEAT_SPAWN_TIME` into every session
- `src/implementations/tmux/tmux-validator.ts` — validates tmux >= 3.0 AND jq availability at spawn time; only success results are cached for the process lifetime (failures retry)
- `src/implementations/tmux/tmux-shell-utils.ts` — `escapeForSingleQuotes` and `singleQuoteToken` utilities; used internally by hooks and session manager; re-exported from barrel
- `src/implementations/tmux/types.ts` — `TmuxAgentType`, `TmuxSpawnConfig`, `WrapperConfig`, `SetupShimConfig`, `SetupShimManifest`, and all `*Port` interfaces; re-exports `TmuxConnectorPort`, `TmuxHandle`, `OutputMessage`, `SpawnCallbacks`, `TmuxSpawnCoreConfig` from `core/tmux-types.ts`
- `src/implementations/tmux/index.ts` — barrel export; import from here; exports `*Port` interfaces, concrete classes, shell utilities, and all constants
- `src/core/errors.ts` — `TMUX_*` error factories (`tmuxSessionFailed`, `tmuxValidationFailed`, `tmuxHookFailed`, `tmuxSendKeysFailed`); use these, never construct `AutobeatError` directly

## Related

- Feature knowledge: `tmux-runtime` — full architecture, spawn sequence diagram, wiring code example, complete gotchas list, and error code table. Read that entry first for a new-developer orientation.
- `src/implementations/event-driven-worker-pool.ts` — Phase 3/5 consumer; uses `TmuxConnectorPort`, persistent session reuse (`setEnvironment`)
- `src/services/handlers/loop-handler.ts` — Phase 5 integration; manages `persistentSessionKey` on loop iterations and destroys persistent sessions on loop completion
- `src/cli/commands/orchestrate-interactive.ts` — uses `sendControlKeys` for interactive orchestrator cancellation
- `src/core/result.ts` — Result type; all public methods return `Result<T, AutobeatError>`
