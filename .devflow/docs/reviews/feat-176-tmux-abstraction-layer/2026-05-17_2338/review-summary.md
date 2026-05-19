# Code Review Summary

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17
**Reviews**: 7 focus areas (Integration Boundaries, Contract Alignment, Security, Reliability, Architecture, Testing, TypeScript)

---

## Merge Recommendation: **CHANGES_REQUESTED**

The tmux abstraction layer is **architecturally sound** with strong security and reliability fundamentals. However, **4 blocking issues must be resolved before merge**:

1. **TmuxConnectorPort missing from barrel exports** (HIGH) — Phase #178 consumers cannot depend on the port interface
2. **agentCommand not validated/escaped in bash script** (HIGH) — injection risk via shell metacharacters
3. **agentArgs not escaped in bash script** (HIGH) — argument injection risk
4. **destroy() does not call onExit** (HIGH) — tasks could remain stuck in RUNNING state

Additionally, **4 medium-priority should-fixes** should be addressed before merge to avoid technical debt in Phase #178.

---

## Issue Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| **Blocking** | 0 | 4 | 4 | 0 |
| **Should Fix** | 0 | 0 | 4 | 0 |
| **Pre-existing** | 0 | 0 | 0 | 0 |
| **Lower Confidence** | 0 | 0 | 0 | 7 |

**Total**: 8 blocking (4 HIGH), 4 should-fix (MEDIUM), 7 suggestions (LOW)

---

## Blocking Issues (Must Fix Before Merge)

### [HIGH] TmuxConnectorPort missing from barrel exports

- **Source**: Architecture, TypeScript
- **Location**: `src/implementations/tmux/index.ts:17-35`
- **Confidence**: 95%
- **Description**: The `TmuxConnectorPort` interface (the port that Phase #178 WorkerPool should depend on) is defined in `types.ts` but NOT re-exported from the barrel. Phase #178 will need to either bypass the barrel or patch it post-merge — an avoidable churn commit.
- **Impact**: Phase #178 coupling violation; forces non-standard import paths for consumers.
- **Fix**: Add `TmuxConnectorPort` (and `TmuxAgentType`) to type-only exports in `index.ts`:
  ```typescript
  export type {
    TmuxConnectorPort,
    TmuxAgentType,
    // ... rest
  } from './types.js';
  ```

---

### [HIGH] agentCommand embedded in bash script without validation or escaping

- **Source**: Security
- **Location**: `src/implementations/tmux/tmux-hooks.ts:123`
- **Confidence**: 90%
- **Description**: `config.agentCommand` is interpolated directly into the generated wrapper bash script (`${config.agentCommand} ${agentArgs} 2>&1 | ...`) with zero validation or escaping. While `taskId` and `sessionsDir` are validated against regex, `agentCommand` has no guard. A value containing shell metacharacters (`;`, `$(...)`, backticks, `&&`) would execute arbitrary code.
- **Current mitigation**: `agentCommand` comes from internal agent adapter configuration and `agentArgs` is hardcoded to `[]`. However, defense-in-depth requires the boundary to validate, not trust upstream.
- **Impact**: Arbitrary code execution inside the tmux session if a future caller passes user-influenced data.
- **Fix**: Either validate `agentCommand` with a regex (e.g., `SAFE_COMMAND_REGEX = /^[a-zA-Z0-9/_.\-]+$/`), or single-quote and escape the command:
  ```typescript
  const escapedCmd = `'${config.agentCommand.replace(/'/g, "'\\''")}'`;
  // ... in buildWrapperScript():
  ${escapedCmd} ${escapedArgs} 2>&1 | while IFS= read -r line; do
  ```

---

### [HIGH] agentArgs joined without escaping allows argument injection

- **Source**: Security
- **Location**: `src/implementations/tmux/tmux-hooks.ts:90`
- **Confidence**: 85%
- **Description**: `config.agentArgs.join(' ')` concatenates arguments with spaces and interpolates directly into bash. If any argument contains spaces, quotes, or shell metacharacters, the shell will split and interpret them. Currently `agentArgs` is hardcoded to `[]`, but the interface accepts `string[]` without validation.
- **Attack vector**: A future caller passing `agentArgs: ["--flag'; rm -rf /; echo '"]` would inject arbitrary commands.
- **Fix**: Each argument should be individually single-quoted and escaped:
  ```typescript
  const agentArgs = config.agentArgs.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
  ```

---

### [HIGH] destroy() does not call onExit — tasks may remain stuck in RUNNING

- **Source**: Reliability
- **Location**: `src/implementations/tmux/tmux-connector.ts:224-241`
- **Confidence**: 90%
- **Description**: `destroy()` sets `session.exited = true`, flushes messages, closes watchers, kills the tmux session, and cleans up — but it **never calls `session.callbacks.onExit()`**. Compare with `dispose()` (line 277) which explicitly calls `onExit(null, 'SHUTDOWN')`, and `triggerExit()` which calls `onExit(code, signal)`. If a caller uses `destroy()` to externally terminate a session (e.g., user cancellation), the task will never receive an exit notification and may remain stuck in RUNNING state indefinitely.
- **Impact**: Tasks terminated via `destroy()` never transition out of RUNNING state. Upstream task lifecycle depends on the `onExit` callback to mark the task as completed/failed.
- **Fix**: Add an `onExit` callback invocation in `destroy()` after cleanup:
  ```typescript
  // After loggedCleanup, before return:
  session.callbacks.onExit(null, 'DESTROYED');
  return destroyResult;
  ```
  Or document the omission as intentional with a JSDoc `@design` comment explaining why `destroy()` is silent and callers handle state transitions themselves.

---

## Should-Fix Issues (Recommended Before Merge)

### [MEDIUM] Sentinel watcher does not debounce — double-fire can invoke triggerExit twice

- **Source**: Reliability
- **Location**: `src/implementations/tmux/tmux-connector.ts:335-360`
- **Confidence**: 82%
- **Description**: The messages watcher applies a 50ms debounce for platform double-fire events, but the sentinel watcher has no debounce. On macOS, `fs.watch()` frequently fires twice for a single file creation. The second call is protected by the `session.exited` guard in `handleSentinel()`, so it returns early. However, this relies on synchronous execution — a future async change would break the guard.
- **Impact**: Currently safe but fragile against future changes.
- **Fix**: Add explicit debounce or a `sentinelProcessed: boolean` flag to make the invariant explicit (not just relying on synchronous execution).

---

### [MEDIUM] Unbounded pendingMessages growth window between MAX_PENDING_MESSAGES checks

- **Source**: Reliability
- **Location**: `src/implementations/tmux/tmux-connector.ts:620-637`
- **Confidence**: 80%
- **Description**: `MAX_PENDING_MESSAGES` cap (100) is checked only after a message is added. Each debounced callback runs independently and adds one entry before checking the cap. In burst scenarios, 200+ debounced callbacks could all resolve between event loop ticks, temporarily holding 200+ entries before any cap check fires.
- **Impact**: Temporary memory spike during burst output (acceptable trade-off).
- **Fix**: This is an acceptable trade-off for the current design. **Document** the transient overshoot behavior with a code comment.

---

### [MEDIUM] destroy() returns error before loggedCleanup but session deleted from activeSessions

- **Source**: Reliability
- **Location**: `src/implementations/tmux/tmux-connector.ts:238-240`
- **Confidence**: 82%
- **Description**: If `destroySession()` returns an error, the error is returned immediately on line 240 — but `loggedCleanup()` on line 239 still runs (correct). However, the session is deleted from `activeSessions` on line 233 before the `destroySession` error path. On a retry, `activeSessions.get(handle.taskId)` returns `undefined`, so destroy() returns `ok(undefined)` without retrying the tmux kill. The orphaned tmux session persists until staleness detection (if other sessions are active) or process exit.
- **Impact**: Orphaned tmux sessions with no reclaim mechanism if no other sessions are active.
- **Fix**: Consider not deleting from `activeSessions` until `destroySession` succeeds, or keeping a separate "pendingDestroy" set, or documenting that `destroy()` is best-effort and callers should not retry.

---

### [MEDIUM] dispose() swallows exceptions from flushPendingFiles — skips remaining sessions

- **Source**: Reliability
- **Location**: `src/implementations/tmux/tmux-connector.ts:258-279`
- **Confidence**: 80%
- **Description**: `dispose()` iterates over sessions and calls `flushPendingFiles()`, `closeSession()` for each. If any single session's teardown throws (e.g., `readFileSync` throws, `onOutput` callback throws), the exception propagates and terminates the loop, leaving remaining sessions un-flushed, un-destroyed, and without `onExit` notifications.
- **Impact**: If any session's teardown throws, all subsequent sessions leak watchers, tmux sessions are not killed, and tasks remain stuck in RUNNING.
- **Fix**: Wrap each iteration in a try/catch:
  ```typescript
  for (const session of sessions) {
    try {
      session.exited = true;
      this.flushPendingFiles(session);
      this.closeSession(session);
      // ... destroySession, loggedCleanup, onExit ...
    } catch (e) {
      this.deps.logger.error('Dispose: unexpected error cleaning up session', {
        sessionName: session.handle.sessionName,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  ```

---

### [MEDIUM] cwd parameter not validated against SAFE_PATH_REGEX

- **Source**: Security
- **Location**: `src/implementations/tmux/tmux-session-manager.ts:97`
- **Confidence**: 82%
- **Description**: The `config.cwd` field is embedded in the shell command via `escapeSingleQuoted()` (which prevents single-quote breakout), but unlike `sessionsDir`, `cwd` is not validated against `SAFE_PATH_REGEX`. This is defense-in-depth only — `escapeSingleQuoted` is sufficient to prevent shell injection from within single quotes.
- **Impact**: Low. Risk limited to `cwd` values with newlines/null bytes (unlikely; tmux may reject them).
- **Fix**: Add `SAFE_PATH_REGEX` validation for `cwd` in `createSession()` for consistency.

---

### [MEDIUM] TmuxInfo.path always returns literal 'tmux' instead of resolved path

- **Source**: Architecture
- **Location**: `src/implementations/tmux/tmux-validator.ts:104`
- **Confidence**: 85%
- **Description**: The `TmuxInfo` interface documents `path: string` as "Path to the tmux binary," but `DefaultTmuxValidator.runValidation()` always returns the literal string `'tmux'` instead of resolving the actual binary path. By contrast, `jqPath` is correctly resolved from `command -v jq`. This is a contract violation — callers expecting an absolute path will get a search-path-dependent string.
- **Impact on Phase #5**: If bootstrap uses `TmuxInfo.path` to spawn tmux, it would work incidentally (PATH resolution) but the contract is violated.
- **Fix**: Resolve the tmux path:
  ```typescript
  const tmuxPathResult = this.deps.exec('command -v tmux');
  const tmuxPath = tmuxPathResult.status === 0 ? tmuxPathResult.stdout.trim() : 'tmux';
  return ok({ version, path: tmuxPath, jqPath });
  ```

---

## Testing Coverage Gaps (Informational)

5 HIGH-confidence test coverage gaps identified (no tests exist):

| Gap | File | Impact | Suggested Test |
|-----|------|--------|-----------------|
| `isOutputMessage` missing field rejection | tmux-connector.ts:59-69 | Malformed messages pass type guard | Unit test with `null`, string, missing sequence/content |
| Validator retry-after-failure path | tmux-validator.ts:54-62 | No regression test for error caching exemption | Mock exec: fail then succeed, assert re-run |
| `handleMessageFile` with invalid JSON structure | tmux-connector.ts:614-616 | Warning message path untested | Fire `{ "foo": "bar" }`, assert warn log |
| `flushPendingFiles` with unreadable single file | tmux-connector.ts:552-559 | Corrupt file during flush silently skipped | 3 files, middle one throws, assert 1+3 delivered |
| `dispose()` calls `onExit` for EACH session | tmux-connector.ts:277 | Multi-session shutdown may lose exit notifications | Spawn 2 sessions, call dispose, assert both onExit received |

These gaps do not block merge but represent high-value additions for regression confidence.

---

## Cross-Cutting Themes

### 1. **Missing Barrel Export** (flagged by 2 reviewers)
Both Architecture and TypeScript reviewers flagged `TmuxConnectorPort` missing from `index.ts`. This is the single most important fix for Phase #178 readiness.

### 2. **Security at Boundaries** (flagged by Security reviewer)
Three input-validation issues (agentCommand, agentArgs, cwd) all involve boundary validation. The module demonstrates strong overall security awareness (`TASK_ID_REGEX`, `SAFE_PATH_REGEX`, `escapeSingleQuoted()`), but the script-generation boundary relies on internal-only usage. Defensive fixes are straightforward.

### 3. **Lifecycle Notification Contracts** (flagged by 2 reviewers)
Two findings concern `onExit` callbacks: `destroy()` not calling `onExit` (Reliability) and `dispose()` potentially skipping sessions on exception (Reliability). Both arise from the push-based callback model.

### 4. **Phase #178 Integration** (flagged by Contract Alignment)
The Contract Alignment review identified 2 blocking design gaps for Phase #178:
- **GAP-1**: Worker identity mapping (PID vs session-name)
- **GAP-2**: Output capture bridging (OutputMessage vs raw streams)

These are noted in the contract-alignment report but do NOT block this PR — they are design questions for Phase #178 planning. TmuxConnector's interface is well-designed; the gaps are in how WorkerPool will consume it.

---

## What's Solid

### Strong Fundamentals

1. **Architecture**: Clean layering (types → low-level modules → orchestrator → barrel). Dependency direction correct throughout. Interface segregation excellent (`TmuxConnectorPort` is 6 methods, `TmuxSessionManager` is 6 methods).

2. **Security**: Strong input validation at all boundaries (`TASK_ID_REGEX`, `SAFE_PATH_REGEX`, `SESSION_NAME_REGEX`, `escapeSingleQuoted()`, file permissions `0o700`, environment key validation). The 3 flagged issues are edge cases where boundaries need tightening.

3. **Reliability**: Bounded iteration, `MAX_PENDING_MESSAGES` cap, `MIN_CHECK_INTERVAL_MS` floor, re-entrancy guards, idempotent destroy, graceful degradation when watchers fail, double-fire protection via `session.exited` flag.

4. **Type Safety**: Zero `any` types, all public methods explicitly return `Result<T, AutobeatError>`, safe `as` usage, proper type-only imports, type-safe discriminated unions.

5. **Testing**: 145+ tests (64 connector, 34 session-manager, 33 hooks, 14 validator) covering happy paths, error paths, and concurrency. Test suite is solid; gaps are primarily secondary branches and edge cases.

6. **Integration Readiness**: `TmuxConnectorPort` interface is clean and exposes the right capabilities (spawn, destroy, isAlive, sendKeys, getActiveHandles, dispose). No changes to TmuxConnector itself required for Phase #178 — all bridging belongs in WorkerPool/adapter layer.

---

## Merge Path

### Required (Before Merge)
1. Add `TmuxConnectorPort` + `TmuxAgentType` to barrel exports (5 min)
2. Validate/escape `agentCommand` in bash script (10 min)
3. Escape `agentArgs` in bash script (5 min)
4. Add `onExit` callback to `destroy()` or document why it's silent (5 min)

**Total effort**: ~25 minutes of targeted fixes.

### Recommended (Before Merge, Lower Priority)
1. Add debounce or explicit flag to sentinel watcher (defensive) — 5 min
2. Wrap `dispose()` loop in try/catch (crash resilience) — 10 min
3. Add `SAFE_PATH_REGEX` validation for `cwd` (consistency) — 5 min
4. Resolve `TmuxInfo.path` with `command -v tmux` (contract compliance) — 5 min

**Total effort**: ~25 minutes.

**Combined**: 50 minutes of high-confidence fixes resolves all blocking and should-fix issues.

### Can Defer (Post-Merge)
- Test coverage gaps (5 high-value additions, but not critical regressions)
- Suggestions marked "lower confidence" (documentation, edge cases, future-proofing)
- Phase #178 design questions (GAP-1, GAP-2) — part of #178 planning

---

## Reviewer Scores

| Focus | Score | Verdict |
|-------|-------|---------|
| Architecture | 8/10 | Well-designed, 1 HIGH (barrel export) |
| Security | 7/10 | Strong boundaries, 2 HIGH (agentCommand/agentArgs), 2 MEDIUM |
| Reliability | 7/10 | Strong fundamentals, 1 HIGH (destroy onExit), 3 MEDIUM |
| Integration | Partial | 2 BLOCKING design gaps for Phase #178, but not this PR's problem |
| Testing | 7/10 | Solid suite, 5 HIGH coverage gaps (informational only) |
| TypeScript | 8/10 | Excellent discipline, 1 HIGH (barrel export), 1 MEDIUM (type coupling) |
| Contract Alignment | Detailed | Identified gaps for Phase #178 planning (not blockers) |

---

## Summary

**Status**: CHANGES_REQUESTED (4 blocking, 4 should-fix issues)

**Effort to merge**: 50 minutes of targeted fixes (25 min blocking, 25 min recommended)

**Risk if shipped as-is**: 
- HIGH: Phase #178 consumers cannot import `TmuxConnectorPort` from barrel
- HIGH: Shell injection risk if future code passes user-influenced `agentCommand`/`agentArgs`
- HIGH: Tasks could remain stuck in RUNNING if sessions destroyed externally
- MEDIUM: Multiple edge cases in error handling (`dispose` exception swallowing, orphaned sessions, missing validation)

**Post-merge trajectory**: After fixes, ready for Phase #178 integration planning. The architecture is sound; Phase #178 must resolve the 2 design gaps (worker identity, output bridging) before implementation.
