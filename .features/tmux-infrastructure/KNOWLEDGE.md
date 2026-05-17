---
feature: tmux-infrastructure
name: Tmux Abstraction Layer
description: "Use when working on the tmux abstraction layer (Phase 1 of the tmux migration epic), wiring TmuxConnector into agent adapters (Phase 2) or WorkerPool (Phase 3), or extending agent support in WrapperConfig. Keywords: tmux, abstraction, connector, hooks, session manager, validator, sentinel, debounce, flush, agent type, jq, wrapper script, sequence ordering."
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
  - src/implementations/tmux/index.ts
  - src/core/errors.ts
created: 2026-05-17
updated: 2026-05-17
---

# Tmux Abstraction Layer

## Overview

This is Phase 1 of the v1.6.0 worker migration epic (#175). It introduces a four-class abstraction stack (`TmuxValidator` → `TmuxSessionManager` → `TmuxHooks` → `TmuxConnector`) that replaces `-p` child-process spawning with tmux sessions. The layer is a pure infrastructure module with no dependencies on domain events, repositories, or handlers.

Two previously documented bugs (debounce message loss on exit, broken jq fallback) are now resolved. One integration gap remains before Phase 2 lands. For the full architecture, data flow, spawn sequence, and wiring guide see the `tmux-runtime` feature knowledge entry.

## System Context

The layer lives at `src/implementations/tmux/` and is exported via a barrel at `index.ts`. It depends only on `src/core/result.ts`, `src/core/errors.ts`, and `src/core/interfaces.ts`. Integration with WorkerPool (Phase 3) and agent adapters (Phase 2) is not yet wired — `TmuxConnector` is currently unconsumed by higher-level code.

## Known Issues

### Integration Gap: Agent type is hardcoded to 'claude' in TmuxConnector

**Severity**: Medium — blocks Phase 2 (Codex/Gemini agent adapter integration).

`WrapperConfig.agent` accepts `'claude' | 'codex'` (per `types.ts`), and `TmuxHooks.buildWrapperScript` already differentiates wrapper behavior by agent type. However, `TmuxConnector.spawn()` passes `agent: 'claude'` unconditionally when calling `hooks.generateWrapper()`. The agent type is not propagated from `TmuxSpawnConfig` (which does not include an `agent` field) through to the wrapper.

Before Phase 2 wiring, `TmuxSpawnConfig` must grow an `agent` field (or `TmuxConnector` must accept it via another mechanism), and `spawn()` must pass it through.

## Component Architecture

Four classes with a strict one-directional dependency hierarchy (no cycles). `TmuxConnector` is the sole public entry point:

```
TmuxConnector          ← only class callers use directly
  ├─ TmuxValidator     ← validates tmux >= 3.0 AND jq presence (cached for process lifetime)
  ├─ TmuxHooks         ← wrapper script + session directory generation
  └─ TmuxSessionManager ← low-level tmux CLI facade (sync ExecFn)
```

All four classes accept their collaborators via constructor injection. No singletons, no module-level state.

### Interface/implementation split

`types.ts` defines three dependency interfaces (`TmuxHooks`, `TmuxSessionManager`, `TmuxValidator`) that the concrete `Default*` classes implement. `TmuxConnector` depends only on the interfaces — it never imports the `Default*` classes directly. This means unit tests inject lightweight test doubles without any mocking framework.

The barrel (`index.ts`) exports both sides: interfaces for type annotations, `Default*` classes for construction, and `TmuxConnector` for use. Always import from the barrel, not from individual files.

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

If `pendingMessages` grows past `MAX_PENDING_MESSAGES = 100` (a permanent gap caused by a dropped or never-written message file), `handleMessageFile` resets `nextExpectedSeq` to the lowest sequence currently in the buffer and re-runs the delivery loop. This prevents unbounded memory growth at the cost of skipping the gap. A warning is logged with the skipped `nextExpectedSeq` value.

### Exit flush mechanism

All exit paths call `flushPendingFiles()` before tearing down watchers. This was added to fix the debounce-window message loss that occurred when an agent exited within 50ms of its last output. The flush:

1. Cancels all in-flight debounce timers (clears `debounceTimers`)
2. Reads all `.json` files from the messages directory synchronously via `readdirSync`
3. Parses and inserts them into `pendingMessages` if not already delivered
4. Delivers consecutive messages in order (via `deliverPendingMessages`), then force-delivers any remaining out-of-order messages

`flushPendingFiles()` is called by `triggerExit()`, `destroy()`, and `dispose()`. The `flushing` guard prevents infinite loops when `onOutput` triggers `destroy()`.

### jq validation

`TmuxValidator.validate()` checks both tmux version AND jq availability (`command -v jq`) in a single cached call. If jq is absent, `validate()` returns an error immediately — the session is never spawned. The wrapper script also carries a defense-in-depth check that exits 127 if jq disappears at runtime after validation passed (e.g. PATH change).

### Auto-injected environment variables

`DefaultTmuxSessionManager.createSession()` automatically injects two environment variables into every new session after spawn (via `tmux set-environment`):

- `AUTOBEAT_TASK_ID` — derived from the session name by stripping the `beat-` prefix
- `AUTOBEAT_SPAWN_TIME` — ISO 8601 timestamp at spawn time

Caller-provided `env` values are injected first; these auto-vars are injected second and win on conflict. Injection is best-effort — a failure does not roll back the session.

## Integration Patterns

### Wiring for Phase 2 / Phase 3

When connecting `TmuxConnector` into agent adapters or WorkerPool, the minimal addition needed is:

1. Add `agent: 'claude' | 'codex'` to `TmuxSpawnConfig` (in `types.ts`)
2. Pass `agent` through `TmuxConnector.spawn()` → `hooks.generateWrapper()`

The connector itself is clean for injection — construct it with the four deps shown in the `tmux-runtime` feature knowledge entry. `readdirSync` is injectable (defaults to `fs.readdirSync`) and should be stubbed in unit tests.

### Session lifecycle ownership

`TmuxConnector` owns the active session map and all watcher/timer handles. Callers are responsible for:
- Calling `dispose()` on process shutdown (`SIGTERM`/`SIGINT`) — flushes and closes ALL active sessions
- Calling `TmuxHooks.cleanup(taskId, sessionsDir)` after task completion — removes the session directory tree (not done automatically by `destroy()`)

### Reading session environment

`DefaultTmuxSessionManager.getSessionEnvironment(name, varName)` retrieves a single env var from a live session via `tmux show-environment`. This method exists only on the **concrete class**, not on the `TmuxSessionManager` interface. Code that accepts the interface cannot call it — only code that holds a `DefaultTmuxSessionManager` reference directly.

## Anti-Patterns

- **Passing `agent: 'claude'` without checking the actual agent type** — the wrapper script behavior differs by agent. As soon as Codex or Gemini support is added, this produces wrong wrappers silently.
- **Calling `flushPendingFiles()` from within `onOutput`** — the re-entrancy guard (`session.flushing`) prevents an infinite loop, but the guard silently skips the nested flush. If `onOutput` triggers `destroy()`, the guard ensures safety; do not introduce additional flush call sites that bypass the guard.
- **Adding Gemini support only in `WrapperConfig.agent`** — the type union (`'claude' | 'codex'`) must also be updated in `buildWrapperScript`'s agent-type branching and in any Phase 2 adapter that sets `agent` on `TmuxSpawnConfig`.
- **Bypassing the `isOutputMessage` type guard** — `handleMessageFile` and `flushPendingFiles` both validate parsed JSON through `isOutputMessage` before inserting into `pendingMessages`. Do not cast directly to `OutputMessage` without this guard; the `type` field is a literal union and an invalid value would cause silent downstream issues.

## Gotchas

- **`WrapperConfig.agent` type does not include `'gemini'`** — the types file currently lists `'claude' | 'codex'` only. Adding Gemini support requires updating both the type union and `buildWrapperScript`.
- **`TmuxSpawnConfig` does not extend `WrapperConfig`** — despite overlapping fields (`taskId`, `sessionsDir`), these are separate types. `TmuxConnector.spawn()` maps between them manually. When adding `agent` to `TmuxSpawnConfig`, do not assume the two types will converge.
- **jq failure blocks all session spawning** — `TmuxValidator.validate()` is cached, so a single jq-absent environment will cause every `spawn()` call to fail with `tmuxValidationFailed` until the process restarts. This is intentional (fail fast), but means a missing jq on the PATH has broad impact.
- **fs.watch watcher degradation is silent in spawn()** — if either watcher fails to start (rare, platform-specific), `spawn()` succeeds with no error. Sentinel and output delivery then depend entirely on the staleness fallback. This is documented behavior, not a bug.
- **`flushPendingFiles()` reads the disk synchronously** — on exit it calls `readdirSyncFn` and `readFileSyncFn`. These are blocking calls on the event loop. In production this is acceptable (exit path); do not move the flush into hot message-delivery paths.
- **Terminal defaults are wide (220 × 50)** — `DefaultTmuxSessionManager` defaults to 220 columns × 50 rows. Override via `TmuxSessionConfig.width` / `height` if the spawned agent wraps output at a narrower terminal width.
- **`getSessionEnvironment` is concrete-class only** — it is NOT on the `TmuxSessionManager` interface. Code typed against the interface cannot call it. This is intentional (interface segregation), but easy to miss when reading the barrel exports.
- **Gap-filling resets `nextExpectedSeq` to the lowest available, not to `lastDeliveredSeq + 1`** — after the safety cap fires, some sequence numbers between `lastDeliveredSeq` and the first available pending message are permanently skipped. This is the intended behavior; if messages at those sequence numbers do arrive later they will be dropped by the `lastDeliveredSeq` watermark check.

## Key Files

- `src/implementations/tmux/tmux-connector.ts` — public entry point; `flushPendingFiles()` is the exit-flush mechanism; `ActiveSession` stores `messagesDir`, `callbacks`, `nextExpectedSeq`, and `flushing` for the flush and delivery logic
- `src/implementations/tmux/tmux-hooks.ts` — wrapper script generation; jq is a hard requirement (`exit 127` if absent); `buildCommunicationBlock` handles inter-session forwarding; `SESSION_NAME_REGEX` guards injection in communication targets
- `src/implementations/tmux/tmux-validator.ts` — validates tmux >= 3.0 AND jq availability at spawn time; result is cached for the process lifetime
- `src/implementations/tmux/types.ts` — `TmuxSpawnConfig` and `WrapperConfig` are the types to extend for Phase 2 agent wiring; `TmuxInfo` includes `jqPath`; `TmuxHooks`, `TmuxSessionManager`, `TmuxValidator` interfaces live here
- `src/implementations/tmux/index.ts` — barrel export; import from here; exports both interfaces and `Default*` concrete classes
- `src/core/errors.ts` — `TMUX_*` error factories; use these, never construct `AutobeatError` directly

## Related

- Feature knowledge: `tmux-runtime` — full architecture, spawn sequence diagram, wiring code example, complete gotchas list, and error code table. Read that entry first for a new-developer orientation.
- PF-001 (don't defer code review issues) — the two previously documented bugs were code-review findings; both are now resolved in-branch, consistent with PF-001.
- PF-002 (no backward-compat for unreleased features) — the `TmuxSpawnConfig` agent field addition is a breaking change to an unreleased API; no migration shim is needed.
- `src/core/result.ts` — Result type; all public methods return `Result<T, AutobeatError>`
