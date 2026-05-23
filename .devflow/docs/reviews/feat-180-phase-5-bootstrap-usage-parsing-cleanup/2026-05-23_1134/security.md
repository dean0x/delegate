# Security Review Report

**Branch**: feat/180-phase-5-bootstrap-usage-parsing-cleanup -> main
**Date**: 2026-05-23

## Issues in Your Changes (BLOCKING)

### CRITICAL
(none)

### HIGH
(none)

## Issues in Code You Touched (Should Fix)
(none)

## Pre-existing Issues (Not Blocking)
(none)

## Suggestions (Lower Confidence)
(none)

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Security Score**: 9/10
**Recommendation**: APPROVED

## Analysis Notes

### Changes Reviewed

1. **`src/cli/commands/orchestrate-interactive.ts`** — Refactored interactive orchestrator to use tmux sessions. Extracted `validateTmux()`, `resolveContainerDeps()`, and `spawnAndDeliverPrompt()` functions.

2. **`src/implementations/event-driven-worker-pool.ts`** — Introduced `TaskIdRef` mutable reference pattern for persistent session reuse across loop iterations. Updated `createCallbacks()`, `reuseSession()`, `registerWorker()`, and `launchAndRegister()`.

3. **`src/implementations/tmux/tmux-hooks.ts`** — Added defense-in-depth `SAFE_PATH_REGEX` validation in `buildSetupShim()`.

4. **`src/core/interfaces.ts`** — Updated JSDoc comments for Phase 5 tmux migration.

5. **`src/implementations/base-agent-adapter.ts`** — Minor comment fix (spawn -> buildTmuxCommand reference).

6. **`tests/helpers/test-factories.ts`** — Added `cleanupPersistentSession` mock to `MockFactory.workerPool`.

7. **`tests/unit/implementations/event-driven-worker-pool.test.ts`** — Added regression tests for TaskIdRef, completionHandled reset, and reuse fallback.

8. **`tests/unit/translation/proxy/bootstrap-proxy-integration.test.ts`** — Injected mock tmux connector in bootstrap integration tests.

### Security Controls Verified

- **Shell injection (A03)**: `validateTmux()` uses `spawnSync(cmd, { shell: true })` but the TmuxValidator only passes hardcoded commands (`tmux -V`, `command -v jq`, `command -v tmux`). No user input reaches these invocations. The `nodeSpawn('tmux', ['attach-session', '-t', handle.sessionName])` call uses array arguments (not shell), and session names are validated against `SESSION_NAME_REGEX = /^beat-[a-z0-9-]+$/`. Safe.

- **Command injection in tmux-hooks (A03)**: The new `buildSetupShim()` defense-in-depth validation re-checks `config.agentCommand` against `SAFE_PATH_REGEX = /^(?!.*\.\.)([a-zA-Z0-9/_. \-]+)$/` before embedding it in the exec line. Arguments are individually single-quoted via `singleQuoteToken()`. The `agentCommand` is used unquoted in the `exec` line, but `SAFE_PATH_REGEX` constrains it to safe characters only. This is a net improvement — the outer validation already existed, and the inner validation is a welcome defense-in-depth addition.

- **Type boundary bypass (env stripping)**: The `as unknown as { env?: Record<string, string> }` cast in `spawnAndDeliverPrompt()` accesses the `env` field from a wider implementation type through the narrow `TmuxSpawnCoreConfig` interface. This is a type-level escape, not a security bypass. The operation only filters out `AUTOBEAT_WORKER` from the environment — a defensive, narrowing operation. No new capabilities are granted.

- **Secrets handling (A02)**: No hardcoded credentials, API keys, or tokens introduced. The `resolveAuth()` path continues to use `process.env` lookups and config-file loaded keys. Environment variables are properly stripped via `envPrefixesToStrip` and `envExactMatchesToStrip` before spawning child processes.

- **Error message exposure (A09)**: Error messages output via `ui.error()` include `.error.message` from Result types. These are developer-facing CLI messages (not web-exposed), containing operational context like "Failed to get tmux connector" — appropriate for a local CLI tool.

- **TOCTOU in persistent session reuse**: The `reuseInProgress` Set provides per-key concurrency guard against double-reuse races. The `isAlive()` check before reuse has an inherent TOCTOU window (session could die between check and sendKeys), but the code handles this gracefully — failures fall through to fresh spawn via `ok(null)` sentinel rather than propagating errors.

- **Mutable shared state (TaskIdRef)**: The `TaskIdRef` pattern introduces shared mutable state between callbacks and the worker pool. This is intentional and well-documented — the callbacks read `taskIdRef.current`, and only `reuseSession()` writes to it, protected by the `reuseInProgress` concurrency guard. The `completionHandled` flag reset on reuse prevents stale guard state from silently dropping completion events.

### Decisions Applied

Both PF-001 and PF-002 were reviewed and are not applicable to this security review — no issues were deferred, and no migration paths for unpublished features were proposed.
