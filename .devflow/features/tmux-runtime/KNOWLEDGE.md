---
feature: tmux-runtime
name: Tmux Runtime Layer
description: "Use when implementing tmux-based worker processes, adding new agent types to the tmux runtime, debugging session lifecycle or output capture, tracing the pre-exit flush mechanism, or understanding the fs.watch sentinel completion pattern. Keywords: tmux, session, worker, spawn, wrapper, sentinel, staleness, fs.watch, send-keys, output capture, jq, flushPendingFiles, readdirSync, persistent, setup shim, core/tmux-types."
category: architecture
directories: [src/implementations/tmux/, tests/unit/implementations/tmux/, tests/integration/tmux/]
referencedFiles:
  - src/implementations/tmux/types.ts
  - src/implementations/tmux/tmux-validator.ts
  - src/implementations/tmux/tmux-session-manager.ts
  - src/implementations/tmux/tmux-hooks.ts
  - src/implementations/tmux/tmux-connector.ts
  - src/implementations/tmux/index.ts
  - src/core/errors.ts
  - src/core/tmux-types.ts
created: 2026-05-16
updated: 2026-05-24
---

# Tmux Runtime Layer

## Overview

This is the foundation of the v1.6.0 worker migration from `-p` (child process) spawning to tmux sessions. Phases 1–5 of the migration epic (#175) are complete and on main. Phase 6 (channel domain persistence) is in progress.

The layer provides a four-class abstraction stack: `TmuxValidator` → `TmuxSessionManager` → `TmuxHooks` → `TmuxConnector`. Each class has a single responsibility and all dependencies are injected, making every layer independently testable.

The layer introduces push-based completion detection. Rather than polling for task completion, a bash wrapper script writes a sentinel file (`.done` or `.exit`) when the agent exits. `TmuxConnector` watches for these sentinels via `fs.watch` and fires a callback — no polling loop anywhere in the hot path. Agent output is captured to per-task JSON message files and delivered in sequence order to an `onOutput` callback.

**Persistent session mode** (Phase 5): When `TmuxSpawnCoreConfig.persistent=true`, the connector uses a setup shim instead of a wrapper pipeline. The agent runs interactively (no `--print`), the session survives across loop iterations, and WorkerPool updates `AUTOBEAT_TASK_ID` via `setEnvironment()` on each reuse.

## System Context

The tmux layer lives at `src/implementations/tmux/` and is exported as a barrel from `index.ts`. It depends on `src/core/result.ts` (Result type), `src/core/errors.ts` (error factory functions and `AutobeatError`), `src/core/interfaces.ts` (Logger), and `src/core/tmux-types.ts` (consumer-facing port interfaces). It has no dependencies on domain events, repositories, or handlers — it is a pure infrastructure layer.

**`src/core/tmux-types.ts`** was introduced in Phase 3 to break the circular dependency between the core layer and the implementations layer. It defines the public port interfaces (`TmuxConnectorPort`, `TmuxSessionManagerCorePort`), the handle (`TmuxHandle`), and the minimal spawn config (`TmuxSpawnCoreConfig`) used at core-layer boundaries. `src/implementations/tmux/types.ts` re-exports these for backward compatibility — callers that already import from `tmux/types.ts` continue to work without changes.

## Component Architecture

The four classes form a strict dependency hierarchy (no cycles):

```
TmuxConnector          ← orchestrator; owns lifecycle + watchers + staleness
  ├─ TmuxValidator     ← validates tmux >= 3.0 (cached)
  ├─ TmuxHooks         ← generates wrapper script / setup shim + session directory tree
  └─ TmuxSessionManager ← low-level tmux CLI facade
```

`TmuxConnector` is the only class callers need directly. The others are injected via `TmuxConnectorDeps`.

### TmuxValidator

Validates that **both** tmux (>= 3.0) and **jq** are installed. **Only successful** validation results are cached for the process lifetime — failed results retry on every `spawn()` call (so that adding jq to PATH or upgrading tmux fixes the environment without restarting). The validation runs `tmux -V` and `command -v jq` once on success, then returns the cached `Result<TmuxInfo>`.

Validation sequence: (1) run `tmux -V` and check exit status, (2) parse the version string numerically, (3) compare against `MIN_MAJOR=3 / MIN_MINOR=0`, (4) run `command -v jq` and check exit status. If any step fails, `TMUX_VALIDATION_FAILED` is returned immediately and the result is **not** cached.

`TmuxInfo` carries the results of both checks: `version` (e.g. `"3.4"`), `path` (`"tmux"`), and `jqPath` (the resolved path to the jq binary). The `jqPath` field exists so callers can verify jq availability at a glance without re-running `command -v jq`.

Version parsing handles all known tmux version string formats: `"tmux 3.4"`, `"tmux 3.4a"`, `"tmux next-3.5"`, `"tmux 3.10"`. The comparison is numeric, not lexicographic, so `3.10 > 3.9`.

### TmuxSessionManager

A synchronous facade over the tmux CLI (create/destroy/sendKeys/sendControlKeys/isAlive/list/getSessionEnvironment/setSessionEnvironment). All methods accept an injected `ExecFn` (synchronous `spawnSync` wrapper) — this is intentional to keep the caller in control of async boundaries and to simplify testing.

Key behaviors:
- Session names are validated against `SESSION_NAME_REGEX` (`/^beat-[a-z0-9-]+$/`) before every operation.
- `createSession` enforces a concurrent session cap (default: `MAX_CONCURRENT_SESSIONS = 20`).
- `createSession` auto-injects `AUTOBEAT_TASK_ID` and `AUTOBEAT_SPAWN_TIME` environment variables. Auto-vars win on conflict with caller-provided env. Env var keys are validated against `/^[A-Za-z_][A-Za-z0-9_]*$/` (POSIX portable names) before injection — invalid keys are **silently skipped**.
- `destroySession` and `listSessions` are idempotent on "session not found" — both return `ok` when tmux reports no server or no matching session.
- `sendKeys` uses `-l` (literal mode) plus shell-level escaping of `\`, `'`, `$`, and backticks to prevent injection.
- `sendControlKeys` sends control key sequences (e.g. `C-c`) **without** `-l` (literal mode). This is a separate method to make the intent explicit at every call site — passing `C-c` via `sendKeys` would send the literal string "C-c" rather than triggering Ctrl+C (SIGINT).
- `getSessionEnvironment(name, varName)` validates `varName` against the same POSIX regex before executing the tmux command. An invalid `varName` returns `TMUX_SESSION_FAILED` without executing any shell command.
- `setSessionEnvironment(name, varName, value)` is the counterpart to `getSessionEnvironment`. Used by WorkerPool to update `AUTOBEAT_TASK_ID` on persistent session reuse (Phase 5).

### TmuxHooks

Generates the session directory tree (`{sessionsDir}/{taskId}/messages/`) and either a **wrapper script** (non-persistent mode) or a **setup shim** (persistent mode). Both methods create session directories with `0o700` (owner-only) permissions.

**`generateWrapper(config: WrapperConfig): Result<WrapperManifest>`** — non-persistent mode:
1. Runs the agent, capturing stdout line by line
2. Writes each line as an atomic JSON message file (`{SEQ:05d}-stdout.json`, renamed from `.tmp`)
3. Atomically writes `.done` (exit 0) or `.exit` (exit != 0) when the agent finishes
4. Optionally forwards the final result JSON to named tmux targets (communication block)

Returns a `WrapperManifest` with all artifact paths (`wrapperPath`, `sentinelPath`, `messagesDir`, `seqFilePath`).

**`generateSetupShim(config: SetupShimConfig): Result<SetupShimManifest>`** — persistent mode:
Initialises the messages directory and sequence counter file, then `exec`s the agent interactively (no `--print`). Output is captured via the Stop hook mechanism, not the wrapper pipeline. The shim script does not write sentinels — completion detection for persistent sessions is handled by the WorkerPool / LoopHandler layer. Returns `SetupShimManifest` with `shimPath`, `sessionDir`, and `messagesDir`.

The generated wrapper script includes a **defense-in-depth jq guard** at its first executable line:
```bash
command -v jq >/dev/null 2>&1 || { echo "FATAL: jq is required but not found in PATH" >&2; exit 127; }
```
This fires if jq disappears between `TmuxValidator.validate()` time and session start. An exit 127 from the wrapper produces a `.exit` sentinel with code 127, so the failure surfaces to `onExit` rather than silently dropping all output.

Communication targets in `WrapperConfig.communicationTargets` are validated against `SESSION_NAME_REGEX` inside `buildCommunicationBlock`. **Invalid target names are silently dropped** — no error is returned and the wrapper script is still generated. This is a security guard against shell injection, not a bug.

### TmuxConnector

The high-level orchestrator. `TmuxConnectorDeps` accepts two optional injectable filesystem deps:
- `readFileSync` — used by `handleSentinel`, `handleMessageFile`, and `flushPendingFiles`
- `readdirSync` — used exclusively by `flushPendingFiles` to enumerate undelivered messages

Both default to their `fs` equivalents and should only be overridden in tests to avoid real disk I/O.

`spawn()` executes this sequence:

1. Validate tmux (`TmuxValidator.validate()`)
2. Generate wrapper + session dir OR setup shim (`persistent=true`) via `TmuxHooks`
3. Start `fs.watch` on the session dir (**before** session launch — race elimination)
4. Start `fs.watch` on the messages dir
5. Create the tmux session running `wrapperPath` or `shimPath`
6. Start the shared staleness timer (`setInterval`)

The watcher-before-session ordering is a hard invariant (see JSDoc DESIGN DECISION). Reversing it creates a race where a fast-exiting agent writes sentinels before the watcher is registered.

Both `fs.watch` calls (steps 3 and 4) are wrapped in try/catch. If either watcher fails to start (e.g., the directory does not yet exist on some platforms), the connector logs a warning and continues — sentinel detection degrades gracefully rather than failing the `spawn()` call outright.

**New methods on `TmuxConnector` (Phase 3–5)**:
- `sendControlKeys(handle, keys)` — delegates to `sessionManager.sendControlKeys()` without literal mode flag
- `setEnvironment(handle, varName, value)` — delegates to `sessionManager.setSessionEnvironment()`; used by WorkerPool on persistent session reuse
- `getActiveHandles()` — returns all active `TmuxHandle` values; used by RecoveryManager

## Component Interactions

### Spawn sequence (happy path)

```
caller.spawn(rawConfig: TmuxSpawnCoreConfig, { onOutput, onExit })
  │
  ├─ validator.validate()          → Result<TmuxInfo>  (cached after first SUCCESS)
  │
  ├─ if persistent:
  │    hooks.generateSetupShim()   → Result<SetupShimManifest>
  │    createSession(shimPath)
  │
  └─ if !persistent:
       hooks.generateWrapper(...)  → Result<WrapperManifest>
       createSession(wrapperPath)
  │
  ├─ fs.watch(sessionDir)          → sentinelWatcher   (try/catch — degrades gracefully)
  ├─ fs.watch(messagesDir)         → messagesWatcher   (try/catch — degrades gracefully)
  ├─ sessionManager.createSession(...)
  │                                → Result<TmuxSessionResult>
  ├─ restartSharedStalenessTimer()
  └─ ok(handle)

[agent runs in tmux, wrapper writes messages + sentinel]

fs.watch fires on .done / .exit
  └─ handleSentinel → triggerExit → callbacks.onExit(code)

fs.watch fires on {seq}-stdout.json
  └─ handleMessageFile → ordered delivery → callbacks.onOutput(msg)
```

### Pre-exit flush

All exit paths — `triggerExit` (sentinel/staleness), `destroy`, and `dispose` — call `flushPendingFiles(session)` before closing watchers. `flushPendingFiles`:

1. Cancels all pending debounce timers (since we're reading from disk directly)
2. Calls `readdirSync` on the messages directory to enumerate all `.json` files
3. Reads and parses each file, inserting unseen messages into `pendingMessages`
4. Drains `pendingMessages` in sequence order via `deliverPendingMessages`
5. Force-delivers any remaining out-of-order messages (no more will arrive after exit)

A **re-entrancy guard** (`session.flushing`) prevents an infinite loop when `onOutput` triggers `destroy()` mid-flush. If `flushPendingFiles` is already in progress, the second call returns immediately.

This mechanism ensures that messages written within the 50ms debounce window before exit are not silently dropped.

### Output ordering

Messages are delivered in `sequence` order, not `fs.watch` arrival order. The connector buffers out-of-order messages in `pendingMessages: Map<number, OutputMessage>` and drains them in sequence as gaps fill. If the pending buffer exceeds `MAX_PENDING_MESSAGES = 100`, the connector skips to the lowest buffered sequence to prevent unbounded memory growth. This is a safety cap, not normal behavior.

### Staleness detection

A **shared `setInterval`** runs every `checkIntervalMs` (default: 30s) and checks ALL active sessions in one `listSessions()` call — avoiding O(N) concurrent `isAlive` syscalls. The timer starts on first spawn and stops when `activeSessions` empties. Per-session `maxSilenceMs` and `lastAliveCheck` remain per-session for independent stale detection.

If a session's `isAlive` is confirmed false for longer than `maxSilenceMs` (default: 60s), the connector fires `onExit(null, 'STALE')`. A transient `isAlive` exec error does **not** advance the staleness clock — only a confirmed-dead response (`ok(false)`) triggers stale detection.

### Persistent session reuse (Phase 5)

When `TmuxSpawnCoreConfig.persistent=true`, the connector spawns the agent using `generateSetupShim()` and registers the handle. WorkerPool (`event-driven-worker-pool.ts`) stores the handle in `persistentSessions: Map<persistentSessionKey, PersistentSessionEntry>`. On subsequent loop iterations, WorkerPool calls `connector.setEnvironment(handle, 'AUTOBEAT_TASK_ID', newTaskId)` to reroute output attribution before delegating work via `sendKeys`.

## Integration Patterns

### Wiring TmuxConnector

The caller constructs all four classes and passes them as `TmuxConnectorDeps`. `readFileSync` and `readdirSync` are optional (default to their `fs` equivalents) and should be injected in tests to avoid real disk I/O:

```typescript
const exec: ExecFn = (cmd) => {
  const result = spawnSync(cmd, { shell: true, encoding: 'utf8' });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status ?? -1 };
};

const connector = new TmuxConnector({
  validator: new TmuxValidator({ exec }),
  sessionManager: new TmuxSessionManager({ exec }),
  hooks: new TmuxHooks({
    writeFile: (p, c, opts) => fs.writeFileSync(p, c, { mode: opts.mode }),
    mkdirSync: (p, opts) => fs.mkdirSync(p, opts),
    rmSync: (p, opts) => fs.rmSync(p, opts),
  }),
  logger,
  watch: fs.watch,
  // readFileSync: myMockReadFileSync,  ← inject in tests to avoid real disk reads
  // readdirSync: myMockReaddirSync,    ← inject in tests to control flush enumeration
});
```

`TmuxHooks` receives `writeFile`, `mkdirSync`, and `rmSync` separately rather than the full `fs` module — enabling fine-grained mocking in tests without a filesystem stub.

### Error codes and factories

All four error factories live in `src/core/errors.ts` and return `AutobeatError`:

| Factory | ErrorCode | When |
|---|---|---|
| `tmuxValidationFailed` | `TMUX_VALIDATION_FAILED` | tmux missing or version < 3.0 |
| `tmuxSessionFailed(op, ...)` | `TMUX_SESSION_FAILED` | create/destroy/list/getSessionEnvironment failures |
| `tmuxHookFailed(op, ...)` | `TMUX_HOOK_FAILED` | wrapper/shim generation or cleanup failures |
| `tmuxSendKeysFailed` | `TMUX_SEND_KEYS_FAILED` | send-keys failure |

Always use the factory functions — never construct `AutobeatError` directly with tmux error codes.

### Destroy and cleanup

`TmuxConnector.destroy(handle)` closes watchers, cancels timers, flushes pending messages, removes the session from `activeSessions`, then calls `sessionManager.destroySession`. `dispose()` does the same for ALL active sessions — call it on process shutdown (`SIGTERM`/`SIGINT`).

`TmuxHooks.cleanup(taskId, sessionsDir)` removes the session directory tree (`rmSync recursive`). It is called automatically on `spawn` failure but NOT by `destroy` — callers are responsible for post-completion cleanup. `TmuxConnector` calls `loggedCleanup()` (which wraps `hooks.cleanup()`) on `spawn` failure, `destroy`, and `dispose`.

## Constraints

- **Session names**: must match `SESSION_NAME_REGEX` (`/^beat-[a-z0-9-]+$/`). This is enforced before every operation. Constructing names from `SESSION_NAME_PREFIX + taskId` is the standard approach.
- **Concurrent sessions**: capped at `MAX_CONCURRENT_SESSIONS = 20` (configurable via `TmuxSessionManager` constructor). Exceeding this returns `TMUX_SESSION_FAILED`.
- **Agent type in WrapperConfig**: `WrapperConfig.agent` accepts `'claude' | 'codex'` only — not all Autobeat agent types. Phase 1 generates a single wrapper script pattern; adding a new agent type requires updating `buildWrapperScript` to handle agent-specific invocation differences.
- **Env var keys**: `createSession` and `getSessionEnvironment` both validate key names against `/^[A-Za-z_][A-Za-z0-9_]*$/`. In `createSession`, keys that fail validation are silently skipped. In `getSessionEnvironment`, an invalid `varName` returns an error immediately.
- **Platform**: the wrapper script uses `flock`, `jq`, and `date` — all standard on Linux/macOS but not on Windows. This layer is Unix-only. `jq` is validated at spawn time by `TmuxValidator`; a missing `jq` fails validation before any session is created. The wrapper also has a runtime guard (`exit 127`) as a defense-in-depth measure.
- **File permissions**: session dirs and scripts are `0o700` (owner-only). The agent process and the Autobeat server must run as the same OS user.
- **Communication block security**: `agentCommand` and `agentArgs` in `WrapperConfig` are validated against `SAFE_PATH_REGEX` / single-quote-escaped before embedding. `communicationTargets` are validated against `SESSION_NAME_REGEX`; invalid targets are silently dropped.

## Anti-Patterns

- **Reconstructing artifact paths manually** — always use `WrapperManifest` or `SetupShimManifest` fields. Hardcoding paths bypasses the single source of truth.
- **Starting fs.watch after createSession** — the sentinel watcher MUST be started before the tmux session launches. A fast-exiting agent will write the sentinel before a late watcher registers. The ordering in `spawn()` is load-bearing.
- **Throwing inside TmuxHooks deps** — `TmuxHooks` wraps all filesystem calls in try/catch and converts exceptions to `Result.err`. The injected `writeFile`, `mkdirSync`, `rmSync` functions should throw on failure (Node.js default) so the wrapper catches them correctly. Do not swallow errors in the dep implementations.
- **Calling `TmuxHooks.cleanup` without first closing watchers** — deleting the session directory while `fs.watch` is active on it can produce spurious watcher errors on some platforms. Always `destroy(handle)` before cleanup.
- **Abandoning a session without calling `destroy(handle)`** — `destroy` flushes all pending messages before closing. Orphaning an `ActiveSession` without calling `destroy` silently discards any output buffered in the debounce window. Always call `destroy` or `dispose` on shutdown paths.
- **Using TmuxSessionManager.sendKeys for control sequences** — `sendKeys` uses `-l` (literal mode). For control key sequences like `C-c`, use `sendControlKeys` (no literal mode) or `connector.sendControlKeys(handle, 'C-c')`.
- **Importing from individual tmux files** — always import from the barrel (`src/implementations/tmux/index.ts`). Do not import directly from `tmux-connector.ts`, `tmux-hooks.ts`, etc.

## Gotchas

- **`destroySession` idempotency covers "no server running"** — if no tmux server is running at all, `tmux kill-session` exits non-zero with a "no server running" message. The session manager treats this as success. Do not interpret an `ok` result from `destroySession` as proof the session existed.
- **`listSessions` filters to `beat-*` only** — `SESSION_NAME_REGEX` is applied to each row. Non-autobeat tmux sessions are silently dropped. The concurrent-session cap counts only beat-* sessions.
- **Env var injection is best-effort** — `createSession` injects env vars after the session is created. If `tmux set-environment` fails, the session is NOT rolled back. `AUTOBEAT_TASK_ID` and `AUTOBEAT_SPAWN_TIME` are injected; they override any caller-supplied key with the same name.
- **`TmuxHandle.sessionsDir` from `createSession` is empty string** — `TmuxSessionManager.createSession` returns a handle with `sessionsDir: ''`. `TmuxConnector.spawn` fills this in from `config.sessionsDir` before returning. Callers should only use handles returned from `TmuxConnector`.
- **50ms debounce on message files** — `fs.watch` can fire twice for a single file write on some platforms (write + close events). Messages written within the debounce window at exit time are protected by `flushPendingFiles`, which reads from disk directly before closing — so the debounce can only delay, never drop, messages.
- **Staleness timer vs. sentinel** — if both the sentinel watcher and the staleness timer fire at nearly the same time, `triggerExit` is guarded by `session.exited` (set-once). Only the first to fire will invoke `onExit`. The second is silently discarded.
- **Wrapper script uses `PIPESTATUS[0]`** — capturing the agent's exit code through a pipe requires `PIPESTATUS` (bash-specific). The wrapper script has `#!/bin/bash` and `set -euo pipefail`. Do not substitute `/bin/sh`.
- **Watcher graceful degradation** — both `fs.watch` calls in `spawn()` are wrapped in try/catch. A watcher that fails to start logs a warning but does NOT fail the `spawn()` call. In this case, sentinel and output delivery will not work until the staleness timer fires.
- **Validator caches only success** — a missing jq or old tmux causes validation to re-run on every `spawn()` call until the environment is fixed.
- **TmuxSpawnConfig does not extend TmuxSpawnCoreConfig in the port** — `TmuxConnector.spawn()` accepts `TmuxSpawnCoreConfig` (the core-layer minimal type) and casts it to `TmuxSpawnConfig` (the implementation-layer richer type) at the implementation boundary. The cast is safe because `EventDrivenWorkerPool` constructs the config with all required fields.
- **Duplicate `taskId` spawn is rejected** — `TmuxConnector.spawn()` checks `activeSessions` before proceeding; a duplicate `taskId` returns `tmuxSessionFailed` immediately to prevent orphaning the first session's watchers and timers.
- **Communication targets are silently validated and dropped** — `buildCommunicationBlock` filters `communicationTargets` against `SESSION_NAME_REGEX`. Any target that doesn't match is silently removed from the generated script. If all targets fail validation, the communication block is omitted entirely. No error is returned by `generateWrapper` in this case.

## Key Files

- `src/core/tmux-types.ts` — consumer-facing port interfaces (`TmuxConnectorPort`, `TmuxSessionManagerCorePort`), `TmuxHandle`, `TmuxSpawnCoreConfig`, `OutputMessage`, `SpawnCallbacks`; read this first to understand the core-layer contracts
- `src/implementations/tmux/types.ts` — all interfaces, type aliases, and constants; re-exports from `core/tmux-types.ts` for backward compat; read this for the full implementation-layer type surface
- `src/implementations/tmux/tmux-connector.ts` — the public API; owns the watcher lifecycle, spawn sequence, persistent session mode, `setEnvironment`, `sendControlKeys`, `getActiveHandles`
- `src/implementations/tmux/tmux-hooks.ts` — wrapper script generator AND setup shim generator; `buildWrapperScript` and `buildSetupShim` are the bash templates; `buildCommunicationBlock` handles inter-session forwarding
- `src/implementations/tmux/tmux-session-manager.ts` — low-level tmux CLI facade; `escapeSendKeys`, `validateSessionName`, `setSessionEnvironment` enforce security invariants
- `src/implementations/tmux/tmux-validator.ts` — version check with success-only process-lifetime caching; validates both tmux AND jq
- `src/implementations/tmux/index.ts` — barrel export; import from here, not from individual files
- `src/core/errors.ts` — `TMUX_*` error codes and factory functions

## Related

- Feature knowledge: `tmux-infrastructure` — companion entry covering agent-type integration, `TmuxAgentType`, `ActiveSession` internals, and the Phase 2/3 wiring guide
- `src/core/result.ts` — Result type used throughout; `ok`/`err` are the only constructors
- `src/core/interfaces.ts` — Logger interface injected into TmuxConnector
- `src/implementations/event-driven-worker-pool.ts` — Phase 3 consumer; uses `TmuxConnectorPort`, persistent session reuse via `setEnvironment`
- `src/services/handlers/loop-handler.ts` — Phase 5 integration; manages `persistentSessionKey` on loop iterations
