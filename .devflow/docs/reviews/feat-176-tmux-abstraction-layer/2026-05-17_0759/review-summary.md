# Code Review Summary

**Branch**: feat/176-tmux-abstraction-layer -> main  
**Date**: 2026-05-17  
**Incremental**: 6 commits since last review (1bec153be5..40f9537)

## Merge Recommendation: CHANGES_REQUESTED

**Primary Blockers**: 4 critical/high-severity issues must be resolved before merge:
1. **P0 Unhandled promise rejection** from async `handleMessageFile` fire-and-forget call — process crash risk
2. **P1 Map mutation during iteration** in staleness check — iterator corruption risk
3. **P1 cleanup() Result discarded** (4 call sites) — resource leak with no observability
4. **P1 Mock watcher missing `.on()`** — watcher error handlers untested

All other findings are medium/low severity and should be addressed in this PR (complexity, consistency, test gaps).

---

## Deduplicated Issue Summary

| Severity | Blocking | Should-Fix | Pre-existing | Total |
|----------|----------|-----------|-------------|-------|
| CRITICAL | 0 | 0 | 0 | 0 |
| HIGH | 4 | 0 | 0 | 4 |
| MEDIUM | 6 | 3 | 2 | 11 |
| LOW | 0 | 0 | 1 | 1 |
| **Total** | **10** | **3** | **3** | **16** |

---

## Blocking Issues (Must Fix Before Merge)

### P0 — Unhandled Promise Rejection from Async `handleMessageFile`
**Reviewers**: Regression, Performance, Reliability  
**Severity**: HIGH (process crash risk in Node.js 18+)  
**File**: `src/implementations/tmux/tmux-connector.ts:310`  
**Confidence**: 85% (flagged by 3 reviewers)

**Problem**: `handleMessageFile` changed from sync to async (returns `Promise<void>`) but is called fire-and-forget from a setTimeout callback (line 310). If the promise rejects after the internal try/catch block (e.g., `callbacks.onOutput()` throws, or `deliverPendingMessages` throws), the rejection becomes unhandled. In Node.js 18+ with default settings, unhandled rejections terminate the process.

**Fix**:
```typescript
const timer = setTimeout(() => {
  session.debounceTimers.delete(filename);
  this.handleMessageFile(path.join(messagesDir, filename), session, callbacks).catch((err) => {
    this.deps.logger.warn('Unhandled error in message handler', {
      filePath: path.join(messagesDir, filename),
      error: err instanceof Error ? err.message : String(err),
    });
  });
}, DEBOUNCE_MS);
```

---

### P1 — Concurrent Map Mutation During Staleness Check Iteration
**Reviewers**: Performance, Reliability  
**Severity**: HIGH  
**File**: `src/implementations/tmux/tmux-connector.ts:375-392`  
**Confidence**: 92% (flagged by 2 reviewers, consistent analysis)

**Problem**: `runSharedStalenessCheck` iterates `this.activeSessions` with `for...of` (line 375). Inside the loop, `triggerExit` calls `this.activeSessions.delete(taskId)` (line 574), mutating the map during iteration. While the ES6 spec technically allows deleting the current entry, this pattern is fragile for reliability:
- When multiple sessions go stale in the same tick, iterator behavior becomes complex
- If `triggerExit` callbacks call `spawn()` synchronously (re-entrant), the iterator and timer state corrupt
- Future refactors that change iteration order will silently break

**Fix**:
```typescript
private runSharedStalenessCheck(): void {
  if (this.activeSessions.size === 0) return;

  const listResult = this.deps.sessionManager.listSessions();
  if (!listResult.ok) { /* ... */ return; }

  const aliveSessions = new Set<string>(listResult.value.map((s) => s.name));
  const now = Date.now();

  // Snapshot to avoid concurrent-modification issues
  const stale: Array<[string, ActiveSession]> = [];

  for (const [taskId, session] of this.activeSessions) {
    if (session.exited) continue;
    if (aliveSessions.has(session.handle.sessionName)) {
      session.lastAliveCheck = now;
    } else {
      const silentMs = now - session.lastAliveCheck;
      if (silentMs >= session.stalenessConfig.maxSilenceMs) {
        stale.push([taskId, session]);
      }
    }
  }

  // Process exits after iteration
  for (const [taskId, session] of stale) {
    this.triggerExit(taskId, session, null, 'STALE', session.callbacks);
  }
}
```

---

### P1 — cleanup() Result Silently Discarded (4 Call Sites)
**Reviewers**: Architecture, Consistency, TypeScript  
**Severity**: HIGH  
**Files**: `src/implementations/tmux/tmux-connector.ts:185`, `218`, `255`, `576`  
**Confidence**: 90% (flagged by 3 reviewers)

**Problem**: `TmuxHooks.cleanup()` returns `Result<void, AutobeatError>` but all 4 call sites discard the return value with no logging or error handling. This violates the project's "Always use Result types" principle — if a method returns a Result, the caller must handle both success and failure arms. The `rmSync({ recursive: true, force: true })` operation can fail silently with no diagnostic trace, leaking disk space in long-running servers. The connector already handles `destroySession()` errors correctly (lines 249-254), creating an inconsistent pattern.

**Fix**: Log a warning on failure at all 4 call sites:
```typescript
const cleanupResult = this.deps.hooks.cleanup(session.handle.taskId, session.handle.sessionsDir);
if (!cleanupResult.ok) {
  this.deps.logger.warn('cleanup failed', {
    taskId: session.handle.taskId,
    error: cleanupResult.error.message,
  });
}
```

---

### P1 — Mock Watcher Missing `.on()` Method
**Reviewers**: Architecture, Testing, TypeScript  
**Severity**: HIGH  
**File**: `tests/unit/implementations/tmux/tmux-connector.test.ts:74-75`  
**Confidence**: 90% (flagged by 3 reviewers)

**Problem**: `makeWatchMock()` returns watcher objects as `{ close: vi.fn() }` but production code (lines 282, 316 in connector) calls `.on('error', handler)` to register error handlers. Since these calls are inside try/catch blocks, the TypeError is silently caught with no test failure. The new watcher error degradation path (a key behavioral addition in this diff) has zero unit test coverage. All tests run in degraded mode without knowing it.

**Fix**: Add `.on` method to both mock watchers:
```typescript
const sentinelWatcher = { close: vi.fn(), on: vi.fn() };
const messageWatcher = { close: vi.fn(), on: vi.fn() };
```

And add a test to verify the error handler path fires:
```typescript
it('logs warning when sentinel watcher emits error event', async () => {
  const { watch, sentinelWatcher } = makeWatchMock();
  const logger = makeLogger();
  const connector = new TmuxConnector({ ... });
  await connector.spawn(BASE_CONFIG, { onOutput: vi.fn(), onExit: vi.fn() });
  // Fire the error handler registered via sentinelWatcher.on('error', ...)
  const errorHandler = (sentinelWatcher.on as ReturnType<typeof vi.fn>).mock.calls
    .find(([event]) => event === 'error')?.[1];
  errorHandler?.(new Error('watch EACCES'));
  expect(logger.warn).toHaveBeenCalledWith(
    expect.stringContaining('Sentinel watcher error'),
    expect.any(Object),
  );
  connector.dispose();
});
```

---

## Should-Fix Issues (High Priority, Address in This PR)

### Complexity: 3 Functions Exceed 50-Line Threshold
**Reviewer**: Complexity  
**Severity**: MEDIUM  

1. **`spawn()` — 71 lines** (`tmux-connector.ts:132-202`)  
   Extract `buildActiveSession()` factory to ~50 lines.

2. **`startWatchers()` — 62 lines** (`tmux-connector.ts:265-326`)  
   Extract `startSentinelWatcher()` and `startMessagesWatcher()` helpers to ~25 lines each.

3. **`flushPendingFiles()` — 54 lines** (`tmux-connector.ts:417-470`)  
   Extract `forceDeliverRemaining()` to handle out-of-order remainders.

**File-Level Concern**: `tmux-connector.ts` at 603 lines exceeds 500-line threshold. The staleness subsystem (~50 lines) and message delivery subsystem (~100 lines) could be extracted into separate collaborators.

---

### Consistency: Missing Exports & Stale Comments

1. **`SAFE_PATH_REGEX` not exported** (file: `tmux-hooks.ts:35`)  
   Move to `types.ts` alongside other validation regexes (`TASK_ID_REGEX`, `SESSION_NAME_REGEX`) and re-export from `index.ts`.

2. **`TASK_ID_REGEX` not re-exported from barrel** (file: `index.ts`)  
   Add to re-export block alongside other constants.

3. **Stale JSDoc comment** (file: `tmux-hooks.ts:10`)  
   Says "double-quoted" but code now uses single-quotes (security fix). Update to: "The SESSIONS_DIR path is single-quoted to prevent variable interpolation."

4. **Tests use `await` on synchronous `spawn()`** (files: `tmux-connector.test.ts`, 30+ call sites)  
   Remove `await` or make `spawn` async if intended. Currently misleads readers about async behavior.

---

### Reliability: Timer Floor & Drift

1. **No floor on `checkIntervalMs`** (`tmux-connector.ts:343-348`)  
   A caller passing `{ checkIntervalMs: 0 }` would create a tight loop. Add runtime guard:
   ```typescript
   const MIN_CHECK_INTERVAL_MS = 1000;
   this.sharedStalenessTimer = setInterval(
     () => this.runSharedStalenessCheck(),
     Math.max(minInterval, MIN_CHECK_INTERVAL_MS)
   );
   ```

2. **Shared timer not restarted on session exit** (`tmux-connector.ts:559-578`)  
   When a session with minimum `checkIntervalMs` exits, remaining sessions continue polling at the old rate. Call `restartSharedStalenessTimer()` after delete in `triggerExit` and `destroy`.

---

## Pre-existing Issues (Informational Only)

| Issue | File | Impact | Action |
|-------|------|--------|--------|
| `SAFE_PATH_REGEX` allows relative paths and `..` segments | `tmux-hooks.ts:35` | Path traversal defense-in-depth | Track separately (security hardening) |
| `flushPendingFiles` unbounded file reads | `tmux-connector.ts:417-470` | Exit path only, unlikely in practice | Track separately (robustness) |
| `getSessionEnvironment` missing from interface | `types.ts:189-196` | Implementation-specific, tests already downcast | Track separately (API completeness) |

---

## Test Gaps (Priority 2 — Must Complete)

1. **Missing positive staleness path** (`tmux-connector.test.ts`)  
   No test for when `listSessions` returns the session (confirms alive), `lastAliveCheck` resets, and STALE does NOT fire.

2. **Missing `hooks.cleanup()` call assertions** (`tmux-connector.test.ts`)  
   No test verifies `cleanup()` is called in `destroy()`, `dispose()`, or `triggerExit()` paths.

3. **Timing-sensitive tests** (`tmux-connector.test.ts:448,478,502,542-546,572,624,724,862`)  
   9 tests use `await sleep(N)` with real timers. Async `readFile` adds timing variable. Replace with `vi.waitFor()` for non-flaky assertions.

---

## Positive Findings

**What reviewers praised:**

1. **Shared staleness timer** — O(N) per-session `isAlive` syscalls reduced to O(1) `listSessions()` call per tick. Excellent performance improvement with proper interface addition.

2. **Input validation at boundary** — `TASK_ID_REGEX` and `SAFE_PATH_REGEX` correctly validate at parse boundary. Single-quoting of paths in generated scripts is solid security hardening.

3. **Async hot-path read** — Moving `handleMessageFile` from sync to async is architecturally sound; avoids blocking event loop while keeping flush path (exit-time) synchronous.

4. **Layer separation preserved** — Four-class stack (Validator → SessionManager → Hooks → Connector) maintains strict dependency direction with all deps injected. No new circular dependencies.

5. **DRY refactoring** — `deliverSingle` extraction eliminates duplicated watermark logic shared by ordered and force-flush paths. Correct SRP application.

6. **Test quality** — 41 unit tests + 16 integration tests provide strong coverage. Tests validate behavior (not implementation), use proper DI throughout, clean mock structure.

---

## Action Plan (Ordered by Severity)

### Phase 1: Critical Fixes (Must Merge With)
1. Add `.catch()` to `handleMessageFile` fire-and-forget call (line 310)
2. Fix Map mutation during iteration in `runSharedStalenessCheck` (snapshot approach)
3. Log cleanup failures at 4 call sites (185, 218, 255, 576)
4. Add `.on: vi.fn()` to mock watchers in `makeWatchMock()`

### Phase 2: High-Priority Refactoring (Before Merge)
5. Extract 3 functions exceeding 50-line threshold (`spawn`, `startWatchers`, `flushPendingFiles`)
6. Move `SAFE_PATH_REGEX` to `types.ts` and re-export
7. Re-export `TASK_ID_REGEX` from `index.ts`
8. Update stale JSDoc comment in `tmux-hooks.ts:10`
9. Add floor guard on `checkIntervalMs`
10. Restart shared timer on session exit

### Phase 3: Test Coverage (Before Merge)
11. Add test for positive staleness path (session alive, no STALE)
12. Add assertions that `cleanup()` is called in exit paths
13. Convert timing-sensitive tests from `sleep()` to `vi.waitFor()`
14. Add test for watcher error handler degradation path

### Phase 4: Nice-to-Have (Optional Post-Merge)
- Extract staleness and message delivery subsystems into collaborators
- Add max-length constraint to `TASK_ID_REGEX` for path safety
- Document `SAFE_PATH_REGEX` intent (rejects spaces for security hardening)

---

## Summary Table

| Category | CRITICAL | HIGH | MEDIUM | LOW | Total |
|----------|----------|------|--------|-----|-------|
| **Blocking** | 0 | 4 | 0 | 0 | **4** |
| **Should-Fix** | 0 | 0 | 9 | 0 | **9** |
| **Pre-existing** | 0 | 0 | 3 | 0 | **3** |
| **Total** | **0** | **4** | **12** | **0** | **16** |

**Scores by Focus**:
- Architecture: 8/10 (2 blocking issues, well-layered otherwise)
- Performance: 8/10 (shared timer is excellent; map mutation needs fix)
- Reliability: 7/10 (unhandled promise, timer drift, mutation risk)
- Complexity: 7/10 (3 functions near threshold, file approaching 600 lines)
- Consistency: 7/10 (exports incomplete, one stale comment, `await` on sync)
- Security: 8/10 (validation solid; `cleanup()` lacks defense-in-depth)
- Testing: 7/10 (strong coverage but gaps on new paths like watcher errors)
- TypeScript: 8/10 (proper Result types, good interfaces; mock `.on()` missing)
- Regression: 9/10 (only 1 MEDIUM — unhandled promise, rest clean)

**Overall**: This incremental diff represents solid architectural improvements (shared timer, async reads, input validation) but has 4 high-severity issues that must be resolved before merge: unhandled promise rejection (process crash), map mutation during iteration (iterator corruption), discarded cleanup Results (silent failures), and untested watcher error handlers. With these fixes applied, the code is merge-ready.
