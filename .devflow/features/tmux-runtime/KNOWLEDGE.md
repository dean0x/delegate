---
feature: tmux-runtime
name: Tmux Runtime Layer
description: "Use when implementing tmux-based worker processes, adding new agent types to the tmux runtime, debugging session lifecycle or output capture, or understanding the fs.watch sentinel completion pattern. Keywords: tmux, session, worker, spawn, wrapper, sentinel, staleness, fs.watch, send-keys, output capture."
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
created: 2026-05-16
updated: 2026-05-18
---

# Tmux Runtime Layer

## Overview

This is Phase 1 of the v1.6.0 worker migration from `-p` (child process) spawning to tmux sessions. It provides a four-class abstraction stack: `TmuxValidator` → `TmuxSessionManager` → `TmuxHooks` → `TmuxConnector`. Each class has a single responsibility and all dependencies are injected, making every layer independently testable.

The layer introduces push-based completion detection. Rather than polling for task completion, a bash wrapper script writes a sentinel file (`.done` or `.exit`) when the agent exits. `TmuxConnector` watches for these sentinels via `fs.watch` and fires a callback — no polling loop anywhere in the hot path. Agent output is captured to per-task JSON message files and delivered in sequence order to an `onOutput` callback.

## System Context

The tmux layer lives at `src/implementations/tmux/` and is exported as a barrel from `index.ts`. It depends on `src/core/result.ts` (Result type), `src/core/errors.ts` (error factory functions and `AutobeatError`), and `src/core/interfaces.ts` (Logger). It has no dependencies on domain events, repositories, or handlers — it is a pure infrastructure layer.

## Component Architecture

The four classes form a strict dependency hierarchy (no cycles):

```
TmuxConnector          ← orchestrator; owns lifecycle + watchers + staleness
  ├─ TmuxValidator     ← validates tmux >= 3.0 (cached)
  ├─ TmuxHooks         ← generates wrapper script + session directory tree
  └─ TmuxSessionManager ← low-level tmux CLI facade
```

`TmuxConnector` is the only class callers need directly. The others are injected via `TmuxConnectorDeps`.

### TmuxValidator

Validates that **both** tmux (>= 3.0) and **jq** are installed. The validation result is **cached for the process lifetime** — it runs `tmux -V` and `command -v jq` once, then returns the cached `Result<TmuxInfo>` on every subsequent call. This is intentional (see JSDoc DESIGN DECISION): binaries do not change while a process is running.

Validation sequence: (1) run `tmux -V` and check exit status, (2) parse the version string numerically, (3) compare against `MIN_MAJOR=3 / MIN_MINOR=0`, (4) run `command -v jq` and check exit status. If any step fails, `TMUX_VALIDATION_FAILED` is returned immediately.

`TmuxInfo` carries the results of both checks: `version` (e.g. `"3.4"`), `path` (`"tmux"`), and `jqPath` (the resolved path to the jq binary). The `jqPath` field exists so callers can verify jq availability at a glance without re-running `command -v jq`.

Version parsing handles all known tmux version string formats: `"tmux 3.4"`, `"tmux 3.4a"`, `"tmux next-3.5"`, `"tmux 3.10"`. The comparison is numeric, not lexicographic, so `3.10 > 3.9`.

### TmuxSessionManager

A synchronous facade over the tmux CLI (create/destroy/sendKeys/isAlive/list/getSessionEnvironment). All methods accept an injected `ExecFn` (synchronous `spawnSync` wrapper) — this is intentional to keep the caller in control of async boundaries and to simplify testing.

Key behaviors:
- Session names are validated against `SESSION_NAME_REGEX` (`/^beat-[a-z0-9-]+$/`) before every operation.
- `createSession` enforces a concurrent session cap (default: `MAX_CONCURRENT_SESSIONS = 20`).
- `createSession` auto-injects `AUTOBEAT_TASK_ID` and `AUTOBEAT_SPAWN_TIME` environment variables. Auto-vars win on conflict with caller-provided env. Env var keys are validated against `/^[A-Za-z_][A-Za-z0-9_]*$/` (POSIX portable names) before injection — invalid keys are **silently skipped**.
- `destroySession` and `listSessions` are idempotent on "session not found" — both return `ok` when tmux reports no server or no matching session.
- `sendKeys` uses `-l` (literal mode) plus shell-level escaping of `\`, `'`, `$`, and backticks to prevent injection.
- `getSessionEnvironment(name, varName)` validates `varName` against the same POSIX regex before executing the tmux command. An invalid `varName` returns `TMUX_SESSION_FAILED` without executing any shell command.

### TmuxHooks

Generates the session directory tree (`{sessionsDir}/{taskId}/messages/`) and a bash wrapper script (`wrapper.sh`). The wrapper:
1. Runs the agent, capturing stdout line by line
2. Writes each line as an atomic JSON message file (`{SEQ:05d}-stdout.json`, renamed from `.tmp`)
3. Atomically writes `.done` (exit 0) or `.exit` (exit != 0) when the agent finishes
4. Optionally forwards the final result JSON to named tmux targets (communication block)

All session directories and scripts are created with `0o700` (owner-only) permissions.

The `generateWrapper` method returns a `WrapperManifest` — a struct with all artifact paths (`wrapperPath`, `sentinelPath`, `messagesDir`, `seqFilePath`). Callers should not reconstruct these paths manually.

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
2. Generate wrapper + session dir (`TmuxHooks.generateWrapper()`)
3. Start `fs.watch` on the session dir (**before** session launch — race elimination)
4. Start `fs.watch` on the messages dir
5. Create the tmux session running `wrapper.sh`
6. Start the staleness timer (`setInterval`)

The watcher-before-session ordering is a hard invariant (see JSDoc DESIGN DECISION). Reversing it creates a race where a fast-exiting agent writes sentinels before the watcher is registered.

Both `fs.watch` calls (steps 3 and 4) are wrapped in try/catch. If either watcher fails to start (e.g., the directory does not yet exist on some platforms), the connector logs a warning and continues — sentinel detection degrades gracefully rather than failing the `spawn()` call outright.

## Component Interactions

### Spawn sequence (happy path)

```
caller.spawn(config, { onOutput, onExit })
  │
  ├─ validator.validate()          → Result<TmuxInfo>  (cached after first call)
  ├─ hooks.generateWrapper(...)    → Result<WrapperManifest>
  ├─ fs.watch(sessionDir)          → sentinelWatcher   (try/catch — degrades gracefully)
  ├─ fs.watch(messagesDir)         → messagesWatcher   (try/catch — degrades gracefully)
  ├─ sessionManager.createSession({...config, command: wrapperPath})
  │                                → Result<TmuxHandle>
  ├─ setInterval(stalenessCheck)
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

The staleness timer (`setInterval`) runs every `checkIntervalMs` (default: 30s). If `sessionManager.isAlive()` returns false for longer than `maxSilenceMs` (default: 60s), the connector fires `onExit(null, 'STALE')` and stops the timer. Staleness acts as a safety net for agent crashes that don't produce a sentinel (e.g., `kill -9`).

A transient `isAlive` exec error (the `Result` is `err`) does **not** advance or reset the staleness clock — only a confirmed-dead response (`ok(false)`) triggers stale detection.

## Integration Patterns

### Wiring TmuxConnector

The caller constructs all four classes and passes them as `TmuxConnectorDeps`. `readFileSync` is an optional fifth dep — inject it in tests to avoid real filesystem reads:

```typescript
// Required wiring: inject all deps. readFileSync is optional (defaults to fs.readFileSync).
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

Key takeaways: `TmuxHooks` receives `writeFile`, `mkdirSync`, and `rmSync` separately rather than the full `fs` module — enabling fine-grained mocking in tests without a filesystem stub. `readFileSync` is used in `handleSentinel`, `handleMessageFile`, and `flushPendingFiles`; `readdirSync` is used only in `flushPendingFiles`. Injecting both in tests avoids real disk I/O for output-delivery and flush assertions.

### Error codes and factories

All four error factories live in `src/core/errors.ts` and return `AutobeatError`:

| Factory | ErrorCode | When |
|---|---|---|
| `tmuxValidationFailed` | `TMUX_VALIDATION_FAILED` | tmux missing or version < 3.0 |
| `tmuxSessionFailed(op, ...)` | `TMUX_SESSION_FAILED` | create/destroy/list/getSessionEnvironment failures |
| `tmuxHookFailed(op, ...)` | `TMUX_HOOK_FAILED` | wrapper generation or cleanup failures |
| `tmuxSendKeysFailed` | `TMUX_SEND_KEYS_FAILED` | send-keys failure |

Always use the factory functions — never construct `AutobeatError` directly with tmux error codes.

### Destroy and cleanup

`TmuxConnector.destroy(handle)` closes watchers, cancels timers, removes the session from `activeSessions`, then calls `sessionManager.destroySession`. `dispose()` does the same for ALL active sessions — call it on process shutdown (`SIGTERM`/`SIGINT`).

`TmuxHooks.cleanup(taskId, sessionsDir)` removes the session directory tree (`rmSync recursive`). It is called automatically on `spawn` failure but NOT by `destroy` — callers are responsible for post-completion cleanup.

## Constraints

- **Session names**: must match `SESSION_NAME_REGEX` (`/^beat-[a-z0-9-]+$/`). This is enforced before every operation. Constructing names from `SESSION_NAME_PREFIX + taskId` is the standard approach.
- **Concurrent sessions**: capped at `MAX_CONCURRENT_SESSIONS = 20` (configurable via `TmuxSessionManager` constructor). Exceeding this returns `TMUX_SESSION_FAILED`.
- **Agent type in WrapperConfig**: `WrapperConfig.agent` accepts `'claude' | 'codex'` only — not all Autobeat agent types. Phase 1 generates a single wrapper script pattern; adding a new agent type requires updating `buildWrapperScript` to handle agent-specific invocation differences.
- **Env var keys**: `createSession` and `getSessionEnvironment` both validate key names against `/^[A-Za-z_][A-Za-z0-9_]*$/`. In `createSession`, keys that fail validation are silently skipped. In `getSessionEnvironment`, an invalid `varName` returns an error immediately.
- **Platform**: the wrapper script uses `flock`, `jq`, and `date` — all standard on Linux/macOS but not on Windows. This layer is Unix-only. `jq` is validated at spawn time by `TmuxValidator` (see TmuxValidator section); a missing `jq` fails validation before any session is created. The wrapper also has a runtime guard (`exit 127`) as a defense-in-depth measure.
- **File permissions**: session dirs and scripts are `0o700` (owner-only). The agent process and the Autobeat server must run as the same OS user.
- **Communication block security**: `agentCommand` and `agentArgs` in `WrapperConfig` are embedded in the generated script without escaping. Callers must ensure these come from trusted configuration, not user input.

## Anti-Patterns

- **Reconstructing artifact paths manually** — always use `WrapperManifest` fields. The session dir layout is `{sessionsDir}/{taskId}/`, messages are in `{sessionsDir}/{taskId}/messages/`, sentinels in `{sessionsDir}/{taskId}/`. Hardcoding these paths bypasses the single source of truth.
- **Starting fs.watch after createSession** — the sentinel watcher MUST be started before the tmux session launches. A fast-exiting agent will write the sentinel before a late watcher registers. The ordering in `spawn()` is load-bearing.
- **Throwing inside TmuxHooks deps** — `TmuxHooks` wraps all filesystem calls in try/catch and converts exceptions to `Result.err`. The injected `writeFile`, `mkdirSync`, `rmSync` functions should throw on failure (Node.js default) so the wrapper catches them correctly. Do not swallow errors in the dep implementations.
- **Calling `TmuxHooks.cleanup` without first closing watchers** — deleting the session directory while `fs.watch` is active on it can produce spurious watcher errors on some platforms. Always `destroy(handle)` before cleanup.
- **Abandoning a session without calling `destroy(handle)`** — `destroy` now flushes all pending messages before closing. Orphaning an `ActiveSession` without calling `destroy` silently discards any output buffered in the debounce window. Always call `destroy` or `dispose` on shutdown paths.
- **Using TmuxSessionManager.sendKeys for structured inter-process messages** — `sendKeys` delivers raw keystrokes to the tmux pane's stdin. For structured message passing between sessions, use the `communicationTargets` field in `WrapperConfig` to generate a communication block in the wrapper script.

## Gotchas

- **`destroySession` idempotency covers "no server running"** — if no tmux server is running at all, `tmux kill-session` exits non-zero with a "no server running" message. The session manager treats this as success. Do not interpret an `ok` result from `destroySession` as proof the session existed.
- **`listSessions` filters to `beat-*` only** — `SESSION_NAME_REGEX` is applied to each row. Non-autobeat tmux sessions are silently dropped. The concurrent-session cap counts only beat-* sessions.
- **Env var injection is best-effort** — `createSession` injects env vars after the session is created. If `tmux set-environment` fails, the session is NOT rolled back. `AUTOBEAT_TASK_ID` and `AUTOBEAT_SPAWN_TIME` are injected; they override any caller-supplied key with the same name.
- **`TmuxHandle.sessionsDir` from `createSession` is empty string** — `TmuxSessionManager.createSession` returns a handle with `sessionsDir: ''` because the session manager has no knowledge of the higher-level sessions directory. `TmuxConnector.spawn` fills this in from `config.sessionsDir` before returning. Callers should only use handles returned from `TmuxConnector`.
- **50ms debounce on message files** — `fs.watch` can fire twice for a single file write on some platforms (write + close events). The debounce window is 50ms. Handlers that need to process output in under 50ms will see delayed delivery. Messages written within the debounce window at exit time are protected by `flushPendingFiles`, which reads from disk directly before closing — so the debounce can only delay, never drop, messages.
- **Staleness timer vs. sentinel** — if both the sentinel watcher and the staleness timer fire at nearly the same time, `triggerExit` is guarded by `session.exited` (set-once). Only the first to fire will invoke `onExit`. The second is silently discarded.
- **Wrapper script uses `PIPESTATUS[0]`** — capturing the agent's exit code through a pipe requires `PIPESTATUS` (bash-specific). The wrapper script has `#!/bin/bash` and `set -euo pipefail`. Do not substitute `/bin/sh`.
- **Watcher graceful degradation** — both `fs.watch` calls in `spawn()` are wrapped in try/catch. A watcher that fails to start (e.g., the session directory hasn't been created yet on that platform) logs a warning but does NOT fail the `spawn()` call. In this case, sentinel and output delivery will not work until the watcher is re-attached or the staleness timer fires.
- **Communication targets are silently validated and dropped** — `buildCommunicationBlock` filters `communicationTargets` against `SESSION_NAME_REGEX`. Any target that doesn't match is silently removed from the generated script. If all targets fail validation, the communication block is omitted entirely. No error is returned by `generateWrapper` in this case.

## Key Files

- `src/implementations/tmux/types.ts` — all interfaces, type aliases, and constants; read this first when exploring the layer
- `src/implementations/tmux/tmux-connector.ts` — the public API; owns the watcher lifecycle and spawn sequence
- `src/implementations/tmux/tmux-hooks.ts` — wrapper script generator; the `buildWrapperScript` function is the template for the bash wrapper
- `src/implementations/tmux/tmux-session-manager.ts` — low-level tmux CLI facade; `escapeSendKeys` and `validateSessionName` enforce security invariants
- `src/implementations/tmux/tmux-validator.ts` — version check with process-lifetime caching
- `src/implementations/tmux/index.ts` — barrel export; import from here, not from individual files
- `src/core/errors.ts` — `TMUX_*` error codes and factory functions starting at line 100

## Related

- PF-001 (don't defer code review issues) — applies to security-critical patterns here: `escapeSendKeys`, session name validation, env var key validation, communication target filtering, and the `agentCommand`/`agentArgs` trust boundary in `WrapperConfig`
- PF-002 (don't add backward-compat for unpublished) — this is new infrastructure (v1.6.0, not yet released); no compatibility shims needed
- `src/core/result.ts` — Result type used throughout; `ok`/`err` are the only constructors
- `src/core/interfaces.ts` — Logger interface injected into TmuxConnector
- CLAUDE.md File Locations table — will be updated when higher-level tmux worker integration lands
