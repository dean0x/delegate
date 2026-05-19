---
feature: tmux-infrastructure
name: Tmux Abstraction Layer
description: "Use when working on the tmux abstraction layer (Phase 1 of the tmux migration epic), wiring TmuxConnector into agent adapters (Phase 2) or WorkerPool (Phase 3), or extending agent support via TmuxAgentType. Keywords: tmux, abstraction, connector, hooks, session manager, validator, sentinel, debounce, flush, agent type, jq, wrapper script, sequence ordering, TmuxAgentType."
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
created: 2026-05-17
updated: 2026-05-19
---

# Tmux Abstraction Layer

## Overview

This is Phase 1 of the v1.6.0 worker migration epic (#175). It introduces a four-class abstraction stack (`TmuxValidator` → `TmuxSessionManager` → `TmuxHooks` → `TmuxConnector`) that replaces `-p` child-process spawning with tmux sessions. The layer is a pure infrastructure module with no dependencies on domain events, repositories, or handlers.

The agent-type integration gap (Phase 2 prerequisite) is now resolved: `TmuxSpawnConfig` carries `agent: TmuxAgentType` and `TmuxConnector.spawn()` passes it through to wrapper generation. Phase 2 (wiring into agent adapters) and Phase 3 (WorkerPool rewiring) are the remaining steps. For the full architecture, data flow, spawn sequence, and wiring guide see the `tmux-runtime` feature knowledge entry.

## System Context

The layer lives at `src/implementations/tmux/` and is exported via a barrel at `index.ts`. It depends only on `src/core/result.ts`, `src/core/errors.ts`, and `src/core/interfaces.ts`. Integration with WorkerPool (Phase 3) and agent adapters (Phase 2) is not yet wired — `TmuxConnector` is currently unconsumed by higher-level code.

## Component Architecture

Four classes with a strict one-directional dependency hierarchy (no cycles). `TmuxConnector` is the sole public entry point:

```
TmuxConnector          ← only class callers use directly
  ├─ TmuxValidator     ← validates tmux >= 3.0 AND jq presence (success cached for process lifetime)
  ├─ TmuxHooks         ← wrapper script + session directory generation
  └─ TmuxSessionManager ← low-level tmux CLI facade (sync ExecFn)
```

All four classes accept their collaborators via constructor injection. No singletons, no module-level state.

### Interface/implementation split

`types.ts` defines four `*Port` dependency interfaces (`TmuxHooksPort`, `TmuxSessionManagerPort`, `TmuxValidatorPort`, `TmuxConnectorPort`) that the concrete classes implement. `TmuxConnector` depends only on the `*Port` interfaces — it never imports the concrete classes directly. This means unit tests inject lightweight test doubles without any mocking framework.

The barrel (`index.ts`) exports both sides: `*Port` interfaces for type annotations, concrete classes (`TmuxConnector`, `TmuxHooks`, `TmuxSessionManager`, `TmuxValidator`) for construction, and shell utilities (`escapeForSingleQuotes`, `singleQuoteToken`). Always import from the barrel, not from individual files.

### Agent type

`TmuxAgentType` is a type alias defined in `types.ts`:

```ts
export type TmuxAgentType = Extract<AgentProvider, 'claude' | 'codex'>;
```

This constrains the union at the type level — adding `'gemini'` to the tmux layer means updating this `Extract` call AND adding a corresponding `buildTmuxArgs()` branch in the agent adapter. The wrapper script itself needs no changes; it is fully agent-agnostic.

`TmuxSpawnConfig.agent` and `WrapperConfig.agent` both use `TmuxAgentType`. `TmuxConnector.spawn()` passes both `config.agent` and `config.agentArgs` to `hooks.generateWrapper()`. The wrapper script (`buildWrapperScript`) does not branch on agent type — it runs `{agentCommand} {agentArgs}` verbatim. All agent differentiation comes from `agentArgs` (e.g. `--output-format stream-json` for Claude, `--full-auto` for Codex). The `agent` field in `WrapperConfig` is forwarded for typing and future use.

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

`TmuxConnector` maintains a single shared `setInterval` that calls `listSessions()` once per tick and checks all active sessions. This avoids O(N) concurrent `isAlive` syscalls. The timer starts on first spawn and stops when `activeSessions` empties. Per-session `maxSilenceMs` and `lastAliveCheck` remain per-session for independent stale detection. A skip-if-same-interval optimization prevents O(N) timer teardown/recreate when multiple sessions share the same `checkIntervalMs` (e.g. a pipeline launching 10 tasks back-to-back).

## Integration Patterns

### Wiring for Phase 2 / Phase 3

The agent-type prerequisite is already complete. When connecting `TmuxConnector` into agent adapters or WorkerPool, the main additions needed are:

1. Construct `TmuxConnector` with the four injected deps (see the `tmux-runtime` feature knowledge entry for the wiring code example)
2. Pass `agent: TmuxAgentType` and `agentArgs: readonly string[]` in `TmuxSpawnConfig` — the connector forwards both to `hooks.generateWrapper()`. `agentArgs` is the sole differentiation mechanism in the generated script (e.g. `['--output-format', 'stream-json']` for Claude, `['--full-auto']` for Codex); the wrapper template itself is agent-agnostic

`readdirSync` and `readFileSync` are injectable (default to their `fs` equivalents) and should be stubbed in unit tests. `readFile` (async) is used for the hot-path message handler and should also be stubbed.

### Session lifecycle ownership

`TmuxConnector` owns the active session map and all watcher/timer handles. Callers are responsible for:
- Calling `dispose()` on process shutdown (`SIGTERM`/`SIGINT`) — flushes and closes ALL active sessions
- Calling `TmuxHooks.cleanup(taskId, sessionsDir)` after task completion — removes the session directory tree (not done automatically by `destroy()`)

### Reading session environment

`TmuxSessionManagerPort.getSessionEnvironment(name, varName)` retrieves a single env var from a live session via `tmux show-environment`. The method is on the **interface** and is available to any code typed against `TmuxSessionManagerPort`.

## Anti-Patterns

- **Adding Gemini support only in `TmuxAgentType`** — updating `Extract<AgentProvider, 'claude' | 'codex'>` without also adding a `buildTmuxArgs()` branch in the agent adapter silently produces incorrect `agentArgs` for the new agent type. The wrapper script itself is agent-agnostic and needs no change.
- **Calling `flushPendingFiles()` from within `onOutput`** — the re-entrancy guard (`session.flushing`) prevents an infinite loop, but the guard silently skips the nested flush. If `onOutput` triggers `destroy()`, the guard ensures safety; do not introduce additional flush call sites that bypass the guard.
- **Bypassing the `isOutputMessage` type guard** — `handleMessageFile` and `flushPendingFiles` both validate parsed JSON through `isOutputMessage` before inserting into `pendingMessages`. Do not cast directly to `OutputMessage` without this guard; the `type` field is a literal union and an invalid value would cause silent downstream issues.

## Gotchas

- **`TmuxSpawnConfig` does not extend `WrapperConfig`** — despite overlapping fields (`taskId`, `sessionsDir`, `agent`), these are separate types. `TmuxConnector.spawn()` maps between them manually when calling `hooks.generateWrapper()`.
- **Validator caches only success** — `TmuxValidator.validate()` caches successful results for the process lifetime, but failed results are NOT cached. A missing jq or old tmux causes the validation to re-run on every `spawn()` call until the environment is fixed.
- **`TmuxAgentType` does not include `'gemini'`** — `Extract<AgentProvider, 'claude' | 'codex'>` explicitly excludes Gemini. Adding it requires updating both the `Extract` arguments and `buildWrapperScript`'s agent-type branching.
- **fs.watch watcher degradation is silent in spawn()** — if either watcher fails to start (rare, platform-specific), `spawn()` succeeds with no error. Sentinel and output delivery then depend entirely on the staleness fallback. This is documented behavior, not a bug.
- **`flushPendingFiles()` reads the disk synchronously** — on exit it calls `readdirSync` and `readFileSync`. These are blocking calls on the event loop. In production this is acceptable (exit path); do not move the flush into hot message-delivery paths. The hot-path message handler uses `readFile` (async) via `TmuxConnectorDeps.readFile`.
- **Terminal defaults are wide (220 × 50)** — `TmuxSessionManager` defaults to 220 columns × 50 rows. Override via `TmuxSessionConfig.width` / `height` if the spawned agent wraps output at a narrower terminal width.
- **Gap-filling resets `nextExpectedSeq` to the lowest available, not to `lastDeliveredSeq + 1`** — after the safety cap fires, some sequence numbers between `lastDeliveredSeq` and the first available pending message are permanently skipped. This is the intended behavior; if messages at those sequence numbers do arrive later they will be dropped by the `lastDeliveredSeq` watermark check.
- **Duplicate `taskId` spawn is rejected** — `TmuxConnector.spawn()` checks `activeSessions` before proceeding; a duplicate `taskId` returns `tmuxSessionFailed` immediately to prevent orphaning the first session's watchers and timers.

## Key Files

- `src/implementations/tmux/tmux-connector.ts` — public entry point; `flushPendingFiles()` is the exit-flush mechanism; `ActiveSession` stores `messagesDir`, `callbacks`, `nextExpectedSeq`, and `flushing` for the flush and delivery logic; dual-gate session cap (in-memory + tmux-level)
- `src/implementations/tmux/tmux-hooks.ts` — wrapper script generation; jq is a hard requirement (`exit 127` if absent); `buildCommunicationBlock` handles inter-session forwarding; `SESSION_NAME_REGEX` guards injection in communication targets
- `src/implementations/tmux/tmux-session-manager.ts` — low-level tmux CLI facade; `getSessionEnvironment` is on the `TmuxSessionManagerPort` interface; auto-injects `AUTOBEAT_TASK_ID` and `AUTOBEAT_SPAWN_TIME` into every session
- `src/implementations/tmux/tmux-validator.ts` — validates tmux >= 3.0 AND jq availability at spawn time; only success results are cached for the process lifetime (failures retry)
- `src/implementations/tmux/tmux-shell-utils.ts` — `escapeForSingleQuotes` and `singleQuoteToken` utilities; used internally by hooks and session manager; re-exported from barrel
- `src/implementations/tmux/types.ts` — `TmuxAgentType`, `TmuxSpawnConfig`, `WrapperConfig`, and all `*Port` interfaces; `TmuxInfo` includes `jqPath`; constants `SESSION_NAME_REGEX`, `TASK_ID_REGEX`, `SAFE_PATH_REGEX`, `MAX_CONCURRENT_SESSIONS`
- `src/implementations/tmux/index.ts` — barrel export; import from here; exports `*Port` interfaces, concrete classes, shell utilities, and all constants
- `src/core/errors.ts` — `TMUX_*` error factories (`tmuxSessionFailed`, `tmuxValidationFailed`, `tmuxHookFailed`, `tmuxSendKeysFailed`); use these, never construct `AutobeatError` directly

## Related

- Feature knowledge: `tmux-runtime` — full architecture, spawn sequence diagram, wiring code example, complete gotchas list, and error code table. Read that entry first for a new-developer orientation.
- PF-001 (don't defer code review issues) — the two previously documented bugs (debounce message loss, broken jq fallback) and the agent-type hardcoding were code-review findings; all are now resolved in-branch, consistent with PF-001.
- PF-002 (no backward-compat for unreleased features) — `TmuxSpawnConfig` and `TmuxAgentType` additions are breaking changes to an unreleased API; no migration shim is needed.
- `src/core/result.ts` — Result type; all public methods return `Result<T, AutobeatError>`
