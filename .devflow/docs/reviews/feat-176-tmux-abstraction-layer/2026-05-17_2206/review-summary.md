# Code Review Summary

**Branch**: feat/176-tmux-abstraction-layer → main  
**Date**: 2026-05-17  
**Reviewers**: 9 (security, architecture, performance, complexity, consistency, testing, regression, reliability, typescript)

---

## Merge Recommendation: DO_NOT_MERGE

**CRITICAL REASON**: Multiple HIGH-severity issues in your changes require fixes before merge, including a security vulnerability in the communication block and architectural race conditions.

---

## Reviewer Summary

| Reviewer | Score | Recommendation | Issues |
|----------|-------|-----------------|--------|
| Security | 7/10 | CHANGES_REQUESTED | 1 HIGH, 1 MEDIUM blocking; 3 medium suggestions |
| Architecture | 8/10 | CHANGES_REQUESTED | 2 HIGH, 2 MEDIUM blocking; 2 low suggestions |
| Performance | 8/10 | APPROVED | 2 HIGH architectural observations (acceptable), 1 MEDIUM should-fix |
| Complexity | 7/10 | APPROVED_WITH_CONDITIONS | 2 HIGH, 2 MEDIUM blocking (straightforward fixes) |
| Consistency | 8/10 | APPROVED_WITH_CONDITIONS | 2 MEDIUM blocking; 3 low suggestions |
| Testing | 7/10 | CHANGES_REQUESTED | 3 HIGH, 2 MEDIUM blocking; 3 low suggestions |
| Regression | 9/10 | APPROVED | No blocking issues; 3 low suggestions |
| Reliability | 7/10 | CHANGES_REQUESTED | 2 HIGH, 2 MEDIUM blocking; 3 low suggestions |
| TypeScript | 9/10 | APPROVED_WITH_CONDITIONS | 1 MEDIUM blocking; 3 low suggestions |

---

## Issue Summary by Category

### Blocking Issues (Category 1: Issues in Your Changes)

| Severity | Count | Details |
|----------|-------|---------|
| CRITICAL | 0 | — |
| HIGH | **7** | Security (1), Architecture (2), Testing (3), Reliability (2) |
| MEDIUM | **8** | Security (1), Architecture (2), Complexity (2), Consistency (2), Testing (2), TypeScript (1) |
| **Total Blocking** | **15** | **Must fix before merge** |

### Should-Fix Issues (Category 2: Code You Touched)

| Severity | Count | Details |
|----------|-------|---------|
| HIGH | 0 | — |
| MEDIUM | **2** | Performance (1), Testing (1) |
| **Total Should-Fix** | **2** | Recommended but lower priority than blocking |

### Pre-existing Issues (Category 3)

| Severity | Count |
|----------|-------|
| All | **0** |

---

## Blocking Issues (Must Fix)

### ⚠️ HIGH-SEVERITY BLOCKERS

#### 1. Security: Unescaped JSON payload in shell command
**Location**: `src/implementations/tmux/tmux-hooks.ts:54`  
**Confidence**: 85%

Problem: The communication block reads JSON from `$RESULT_FILE` into `$PAYLOAD` and passes it to `tmux send-keys -l "$PAYLOAD"`. Since `$PAYLOAD` is double-quoted, the shell interprets variables and command substitution (e.g., `$(whoami)`) before tmux sees the string. A crafted agent output could execute arbitrary commands.

Example: JSON `{"content":"run $(whoami)"}` becomes executable shell in the double-quoted context.

**Fix**: Use pipe to avoid shell expansion:
```bash
cat "$RESULT_FILE" | tmux load-buffer -b beat-payload -
tmux paste-buffer -b beat-payload -t "${t}"
tmux delete-buffer -b beat-payload
```

---

#### 2. Architecture: destroy() deletes session directory before killing tmux session
**Location**: `src/implementations/tmux/tmux-connector.ts:198`  
**Confidence**: 90%

Problem: `destroy()` calls `loggedCleanup()` (which deletes the session directory) **before** `sessionManager.destroySession()` (which kills the tmux process). The wrapper script still writing to the now-deleted directory causes I/O errors and may fail silently without writing the sentinel, masking the real exit code.

**Compare**: `dispose()` correctly kills the session first (line 230), then cleans up.

**Fix**: Reorder to match `dispose()`:
```typescript
this.deps.sessionManager.destroySession(handle.sessionName);
// Clean up session directory AFTER the tmux process is killed
this.loggedCleanup('destroy', handle.taskId, handle.sessionsDir);
```

---

#### 3. Architecture: Hardcoded `agent: 'claude'` bypasses multi-agent support
**Location**: `src/implementations/tmux/tmux-connector.ts:143`  
**Confidence**: 85%

Problem: `spawn()` hardcodes `agent: 'claude'` when calling `hooks.generateWrapper()`. The project supports Claude, Codex, and Gemini agents (per CLAUDE.md v0.5.0). `TmuxSpawnConfig` has no `agent` field, so the caller cannot specify which agent type is being spawned.

**Fix**: Add `agent` field to `TmuxSpawnConfig`:
```typescript
export interface TmuxSpawnConfig extends TmuxSessionConfig {
  taskId: string;
  sessionsDir: string;
  agent: 'claude' | 'codex';
  staleness?: Partial<StalenessConfig>;
}
// In spawn():
agent: config.agent,
```

---

#### 4. Testing: handleSentinel unreadable sentinel file produces wrong exit code
**Location**: `src/implementations/tmux/tmux-connector.ts:538`  
**Confidence**: 90%

Problem: When `readFileSync` throws (catch at line 533), `code` stays `null`. For `.exit`, `code ?? 1` returns 1 which happens to be correct, but when the sentinel contains non-numeric content, `parseInt` returns `NaN`, `isNaN(code)` resets to `null`, and the error path is never tested.

**Fix**: Add tests for these edge cases:
```typescript
it('.exit sentinel with unreadable file defaults to exit code 1', () => {
  const readFileSync = vi.fn().mockImplementation(() => { throw new Error('ENOENT'); });
  expect(onExit).toHaveBeenCalledWith(1, undefined);
});

it('.exit sentinel with non-numeric content defaults to exit code 1', () => {
  const readFileSync = vi.fn().mockReturnValue('error text');
  expect(onExit).toHaveBeenCalledWith(1, undefined);
});
```

---

#### 5. Testing: handleMessageFile session-exited-during-async-read untested
**Location**: `src/implementations/tmux/tmux-connector.ts:549-550`  
**Confidence**: 85%

Problem: After the async `readFileFn` call, there is a re-check `if (session.exited) return;` (line 550). This guards against a critical race condition where the session exits during the async gap. **No test covers this path.** A future refactor could remove this guard without any test failing.

**Fix**: Add a test that triggers exit during async read to verify the guard is necessary and correct.

---

#### 6. Testing: listSessions parse error with malformed lines
**Location**: `src/implementations/tmux/tmux-session-manager.ts:214`  
**Confidence**: 82%

Problem: `listSessions()` skips lines with `parts.length < 5`, but there is no test that verifies malformed lines are actually skipped. A future refactor could accidentally remove the guard and introduce a crash on malformed input.

**Fix**: Add a test with malformed tmux output containing fewer than 5 colon-separated parts.

---

#### 7. Reliability: Wrapper script `flock` unavailable on macOS
**Location**: `src/implementations/tmux/tmux-hooks.ts:84`  
**Confidence**: 90%

Problem: The wrapper script uses `flock -x 200 2>/dev/null || true` for atomic sequence increments. `flock` is Linux-only; on macOS it silently fails (via `|| true`), leaving the sequence counter unprotected. This is a latent correctness bug: concurrent `next_seq()` calls could produce duplicate or skipped sequence numbers, leading to message reordering or loss.

**Fix** (Option A - simpler, documents single-writer assumption):
```bash
next_seq() {
  # DESIGN: Single writer (one pipeline per wrapper), no lock needed.
  SEQ=$(cat "$SEQ_FILE" 2>/dev/null || echo 0)
  SEQ=$((SEQ + 1))
  echo $SEQ > "$SEQ_FILE"
  printf "%05d" $SEQ
}
```

**Fix** (Option B - cross-platform, if multi-writer support needed):
Use `mkdir` for atomic lock (works on macOS + Linux).

---

#### 8. Reliability: destroy() forwards to sessionManager for untracked handles
**Location**: `src/implementations/tmux/tmux-connector.ts:200`  
**Confidence**: 85%

Problem: When `destroy(handle)` is called with a handle not in `activeSessions`, the method still calls `this.deps.sessionManager.destroySession(handle.sessionName)`. In multi-connector scenarios, this can destroy another connector's session.

**Fix**: Return early if session is not tracked:
```typescript
destroy(handle: TmuxHandle): Result<void, AutobeatError> {
  const session = this.activeSessions.get(handle.taskId);
  if (!session) {
    return ok(undefined);
  }
  // ... rest of method
}
```

---

### MEDIUM-SEVERITY BLOCKERS

#### 9. Security: width/height interpolated without type validation
**Location**: `src/implementations/tmux/tmux-session-manager.ts:88-93`  
**Confidence**: 82%

Problem: `config.width` and `config.height` are typed as `number | undefined` but are interpolated directly into a shell command. TypeScript types are erased at runtime. If a caller passes non-numeric values (e.g., `NaN`, `Infinity`), they are embedded raw in the shell command.

**Fix**: Add explicit runtime validation before embedding:
```typescript
const width = config.width ?? DEFAULT_WIDTH;
const height = config.height ?? DEFAULT_HEIGHT;
if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
  return err(tmuxSessionFailed('create', `Invalid dimensions: ${width}x${height}`));
}
```

---

#### 10. Security: cleanup() does not validate taskId/sessionsDir
**Location**: `src/implementations/tmux/tmux-hooks.ts:181-189`  
**Confidence**: 82%

Problem: `generateWrapper()` validates `taskId` and `sessionsDir` before using them, but `cleanup()` does not. If `cleanup()` is called directly with crafted values containing path traversal, combined with `recursive: true, force: true`, could delete unintended directories.

**Fix**: Add validation at the top of `cleanup()`:
```typescript
cleanup(taskId: string, sessionsDir: string): Result<void, AutobeatError> {
  if (!TASK_ID_REGEX.test(taskId)) {
    return err(tmuxHookFailed('cleanup', `invalid taskId: ${taskId}`, { taskId }));
  }
  if (!SAFE_PATH_REGEX.test(sessionsDir)) {
    return err(tmuxHookFailed('cleanup', `unsafe sessionsDir: ${sessionsDir}`, { sessionsDir }));
  }
  // ... rest of method
}
```

---

#### 11. Architecture: getSessionEnvironment not on TmuxSessionManager interface
**Location**: `src/implementations/tmux/tmux-session-manager.ts:237`  
**Confidence**: 85%

Problem: `DefaultTmuxSessionManager.getSessionEnvironment()` is a public method with unit and integration tests, but it is not declared on the `TmuxSessionManager` interface. Consumers using the interface type cannot call this method without a downcast.

**Fix**: Add to `TmuxSessionManager` interface in `types.ts`:
```typescript
export interface TmuxSessionManager {
  createSession(config: TmuxSessionConfig): Result<TmuxSessionResult, AutobeatError>;
  destroySession(name: string): Result<void, AutobeatError>;
  sendKeys(name: string, keys: string): Result<void, AutobeatError>;
  isAlive(name: string): Result<boolean, AutobeatError>;
  listSessions(): Result<TmuxSessionInfo[], AutobeatError>;
  getSessionEnvironment(name: string, varName: string): Result<string | undefined, AutobeatError>;
}
```

---

#### 12. Architecture: triggerExit does not kill tmux session on STALE detection
**Location**: `src/implementations/tmux/tmux-connector.ts:438-439`  
**Confidence**: 80%

Problem: When staleness timer fires and the session is not in `listSessions()`, `triggerExit` cleans up internal state but never calls `sessionManager.destroySession()`. A session could be stale (no output) but still alive (agent hung, not crashed), leaving an orphaned tmux process running indefinitely.

**Fix**: Call `sessionManager.destroySession()` in `triggerExit`:
```typescript
private triggerExit(...): void {
  if (session.exited) return;
  session.exited = true;
  this.flushPendingFiles(session);
  this.closeSession(session);
  this.activeSessions.delete(taskId);
  if (!skipTimerRestart) {
    this.restartSharedStalenessTimer();
  }
  this.deps.sessionManager.destroySession(session.handle.sessionName);
  this.loggedCleanup('triggerExit', taskId, session.handle.sessionsDir);
  callbacks.onExit(code, signal);
}
```

---

#### 13. Complexity: createSession() exceeds 50-line threshold
**Location**: `src/implementations/tmux/tmux-session-manager.ts:72-129`  
**Confidence**: 85%

Problem: This method handles three distinct concerns: (1) session creation, (2) auto-variable construction, (3) env-var injection. The 58-line length exceeds threshold. The env-var injection block (lines 105-126) is an independent concern that should be extracted.

**Fix**: Extract env-var injection into a private `injectEnvironment()` method, bringing `createSession()` to ~36 lines.

---

#### 14. Complexity: buildWrapperScript() exceeds 50-line threshold
**Location**: `src/implementations/tmux/tmux-hooks.ts:68-121`  
**Confidence**: 82%

Problem: This 54-line function is slightly above threshold. While bash template literals resist decomposition, extracting the stable `next_seq()` function block into a named constant would bring it to ~45 lines.

**Fix**: Extract the `next_seq()` bash function block into `const NEXT_SEQ_FUNCTION`.

---

#### 15. Consistency: Mid-file imports in types.ts deviate from codebase convention
**Location**: `src/implementations/tmux/types.ts:181-182`  
**Confidence**: 90%

Problem: Imports appear at lines 181-182, after 177 lines of type definitions. Every other file in the codebase places all imports at the top.

**Fix**: Move imports to the top of the file, immediately after the module docstring.

---

#### 16. Testing: handleMessageFile catch-path (readFile rejection) untested
**Location**: `src/implementations/tmux/tmux-connector.ts:344-350`  
**Confidence**: 85%

Problem: When `readFile` rejects with an error (not returns bad content, but actually throws/rejects), the outer `.catch()` at line 344 logs a warning. No test verifies this path fires the warning log.

**Fix**: Add a test where `readFile` rejects with an error (e.g., `ENOENT`).

---

#### 17. Testing: TmuxHooks.cleanup error return path untested
**Location**: `src/implementations/tmux/tmux-hooks.ts:183-187`  
**Confidence**: 82%

Problem: The `cleanup()` catch block at line 183-187 handles exceptions from `rmSync`. Only the happy path is tested. A regression in error wrapping could go undetected.

**Fix**: Add a test where `rmSync` throws an error.

---

#### 18. Testing: destroySession error path weakly tested
**Location**: `src/implementations/tmux/tmux-session-manager.ts:141-152`  
**Confidence**: 80%

Problem: The error branch where `result.status !== 0` and output does NOT match "session not found" patterns has no unit test. A real tmux error (e.g., "server exited unexpectedly") would hit the untested branch.

**Fix**: Add a test that returns a real tmux error message.

---

#### 19. Reliability: dispose() does not call onExit for active sessions
**Location**: `src/implementations/tmux/tmux-connector.ts:218-237`  
**Confidence**: 85%

Problem: `dispose()` flushes and destroys sessions but never calls `callbacks.onExit()` for any active sessions. Callers waiting for an exit signal (to update task state) will never receive it during process shutdown. Tasks may remain stuck in RUNNING state in the database.

**Fix**: Call `callbacks.onExit(null, 'SHUTDOWN')` for each session during dispose, so callers can transition task state.

---

#### 20. Reliability: spawn() with duplicate taskId silently overwrites existing session
**Location**: `src/implementations/tmux/tmux-connector.ts:175`  
**Confidence**: 82%

Problem: If `spawn()` is called twice with the same `taskId`, the previous `ActiveSession` entry is silently overwritten. The first session's watchers, debounce timers, and pending messages are orphaned — never closed, never flushed. File descriptor leak.

**Fix**: Check for duplicate taskId and return an error:
```typescript
spawn(config: TmuxSpawnConfig, callbacks: SpawnCallbacks): Result<TmuxHandle, AutobeatError> {
  if (this.activeSessions.has(config.taskId)) {
    return err(tmuxSessionFailed('spawn', `Session already active for taskId: ${config.taskId}`, {
      taskId: config.taskId,
    }));
  }
  // ... rest of spawn
}
```

---

#### 21. Reliability: Wrapper script does not write sentinel if jq crashes
**Location**: `src/implementations/tmux/tmux-hooks.ts:98-105`  
**Confidence**: 80%

Problem: If `jq` is killed mid-execution or if the `mv` command fails (filesystem full), the atomic write pattern breaks — the `.tmp` file exists but the final `.json` file never appears. The `fs.watch` on the messages directory never fires for that sequence number, creating a permanent gap. The connector handles this via `MAX_PENDING_MESSAGES` overflow, but 100 missing messages accumulate before recovery.

**Fix**: Add a trap to ensure the sentinel is always written, even on unexpected script termination:
```bash
cleanup() {
  local exit_code=$?
  if [ ! -f "$SESSIONS_DIR/.done" ] && [ ! -f "$SESSIONS_DIR/.exit" ]; then
    echo "$exit_code" > "$SESSIONS_DIR/.exit.tmp"
    mv "$SESSIONS_DIR/.exit.tmp" "$SESSIONS_DIR/.exit" 2>/dev/null || true
  fi
}
trap cleanup EXIT
```

---

#### 22. TypeScript: parseInt results not validated for NaN in listSessions
**Location**: `tmux-session-manager.ts:222-226`  
**Confidence**: 85%

Problem: `parseInt` can return `NaN` if the tmux format string contains unexpected data. The resulting `TmuxSessionInfo` objects would have `NaN` fields typed as `number`, silently propagating invalid state.

**Fix**: Add NaN validation after parsing:
```typescript
const created = parseInt(createdStr, 10);
const width = parseInt(widthStr, 10);
const height = parseInt(heightStr, 10);
if (isNaN(created) || isNaN(width) || isNaN(height)) continue;

sessions.push({
  name,
  created,
  attached: attachedStr === '1',
  width,
  height,
});
```

---

## Should-Fix Issues (Category 2)

#### 23. Performance: forceDeliverRemaining sorts pendingMessages on every flush
**Location**: `src/implementations/tmux/tmux-connector.ts:513-520`  
**Confidence**: 80%

Problem: This O(n log n) operation sorts up to 100 pending messages. With the `MAX_PENDING_MESSAGES` cap, the worst case is trivial (sorting 100 entries is sub-microsecond).

**Assessment**: No fix needed. The cap effectively bounds this operation. Documented for completeness.

---

#### 24. Testing: Multiple concurrent sessions with different staleness configs untested
**Location**: `src/implementations/tmux/tmux-connector.ts:384-390`  
**Confidence**: 80%

Problem: The minimum `checkIntervalMs` selection logic across multiple sessions is not tested. A test spawning two sessions with different intervals should verify the timer uses the minimum.

**Recommendation**: Add a test spawning sessions with different staleness configs and verifying the timer fires at the minimum interval.

---

## Recommended Action Plan

### Phase 1: Security & Architecture (Must fix before review approval)
1. **Security (HIGH)**: Fix unescaped JSON payload in shell command (issue #1) — use pipe + load-buffer/paste-buffer pattern
2. **Architecture (HIGH)**: Reorder destroy() to kill session before cleanup (issue #2)
3. **Architecture (HIGH)**: Add `agent` field to `TmuxSpawnConfig` (issue #3)
4. **Reliability (HIGH)**: Fix wrapper script `flock` on macOS (issue #7) — document single-writer assumption
5. **Reliability (HIGH)**: Reject untracked handles in destroy() (issue #8)

### Phase 2: API Completeness & Type Safety
6. **Architecture (MEDIUM)**: Add `getSessionEnvironment` to interface (issue #11)
7. **Consistency (MEDIUM)**: Move imports to top of types.ts (issue #15)
8. **TypeScript (MEDIUM)**: Add NaN validation to parseInt results (issue #22)

### Phase 3: Reliability & Correctness
9. **Architecture (MEDIUM)**: Add destroySession call in triggerExit (issue #12)
10. **Reliability (MEDIUM)**: Call onExit callbacks in dispose() (issue #19)
11. **Reliability (MEDIUM)**: Guard against duplicate taskId in spawn() (issue #20)
12. **Reliability (MEDIUM)**: Add trap to ensure sentinel is written (issue #21)

### Phase 4: Validation & Error Handling
13. **Security (MEDIUM)**: Add validation to cleanup() (issue #10)
14. **Security (MEDIUM)**: Validate width/height before shell interpolation (issue #9)

### Phase 5: Code Quality & Testing
15. **Complexity (MEDIUM)**: Extract env-var injection from createSession (issue #13)
16. **Complexity (MEDIUM)**: Extract next_seq function block (issue #14)
17. **Testing**: Add missing edge-case tests (issues #4, #5, #6, #16, #17, #18)

---

## Summary Metrics

| Metric | Value |
|--------|-------|
| **Total Issues** | 24 |
| **Blocking (Category 1)** | 15 |
| **Should-Fix (Category 2)** | 2 |
| **Pre-existing (Category 3)** | 0 |
| **Average Reviewer Score** | 7.9/10 |
| **Merge Recommendation** | **DO_NOT_MERGE** |

---

## Notes

- **All blocking issues are in YOUR changes** — none are pre-existing. This is addressable.
- **Security reviewer** identified a command-injection vulnerability in the communication block (HIGH, #1) and two validation gaps (MEDIUM, #9-10). These are top priority.
- **Reliability reviewer** identified a macOS compatibility issue (#7) and session lifecycle bugs (#8, #12, #19, #20, #21) that could cause task state corruption in production.
- **Testing reviewer** found 6 edge-case paths with no test coverage — these are exactly where behavioral bugs hide.
- **Architecture reviewer** flagged three API design issues: hardcoded agent type (#3), missing interface method (#11), and session ordering race (#2).
- **No regressions found** — this is new code, so no existing functionality is broken.

---

## Quality Gates Status

- ✗ Security: 2 validation gaps, 1 command-injection vulnerability
- ✗ Architecture: 3 API design issues (missing interface, hardcoded values, wrong ordering)
- ✓ Performance: Acceptable (synchronous I/O is documented design choice for spawn/dispose)
- ✗ Complexity: 2 methods over 50-line threshold (straightforward extraction fixes)
- ✗ Consistency: Imports in wrong location, missing interface method
- ✗ Testing: 6 edge-case paths untested
- ✓ Regression: No breaking changes to existing code
- ✗ Reliability: 5 session lifecycle bugs that could corrupt task state
- ✗ TypeScript: 1 type safety gap (NaN validation)

**All quality gates must pass before merge.**
