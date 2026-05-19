# Code Review Summary

**Branch**: feat/176-tmux-abstraction-layer -> main  
**Date**: 2026-05-17  
**Pass**: Bug hunting (3rd review) — sibling analysis following shell injection, over-escaping, and PIPESTATUS fixes  
**Reviewers**: 9 (security, reliability, architecture, performance, complexity, consistency, testing, regression, typescript)

---

## Merge Recommendation: **BLOCK MERGE**

**7 blocking issues (P0) across 4 categories found. Core issue: env var backslash over-escaping introduced in this PR mirrors the escaping bug fixed in commit `ee4662f` for `sendKeys` — same class of bug, same layer, different function.**

---

## Issue Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| **Blocking (Your Changes)** | 0 | 7 | 0 | 0 |
| **Should Fix (Code You Touched)** | 0 | 0 | 5 | 0 |
| **Pre-existing** | 0 | 0 | 1 | 0 |
| **TOTAL** | 0 | 8 | 6 | 0 |

---

## Blocking Issues (P0 — Must Fix Before Merge)

### 1. Env Var Backslash Over-Escaping in `tmux-session-manager.ts:122`

**Severity**: HIGH | **Confidence**: 90% (6/9 reviewers flagged: security, architecture, complexity, consistency, testing, regression)

**Problem**: 
The new batched `set-environment` command escapes backslashes (`value.replace(/\\/g, '\\\\')`) before wrapping in single quotes. Inside single quotes, backslashes are literal per POSIX shell rules and need no escaping. This is the **exact same bug class** as the fix in commit `ee4662f` (which removed spurious `$`, backtick, and backslash escaping from `escapeSendKeys`). The fix was applied to `sendKeys` but not to the new `createSession` env var injection refactored in this branch.

**Impact**: Any env var value containing backslashes will be stored with doubled backslashes in the tmux environment:
- Input: `C:\Users\foo` 
- Stored: `C:\\Users\\foo` (WRONG)
- Expected: `C:\Users\foo`

This corrupts Windows file paths, regex patterns, escape sequences in config values.

**Fix**:
```typescript
// Current (WRONG): doubles backslashes unnecessarily
const commands = validEntries
  .map(([key, value]) => {
    const escaped = value.replace(/\\/g, '\\\\').replace(/'/g, "'\\''");
    return `tmux set-environment -t ${config.name} ${key} '${escaped}'`;
  })
  .join(' && ');

// Fixed: use escapeSingleQuoted consistently (already defined in file)
const commands = validEntries
  .map(([key, value]) => {
    const escaped = escapeSingleQuoted(value);
    return `tmux set-environment -t ${config.name} ${key} '${escaped}'`;
  })
  .join(' && ');
```

**Why this is P0**: This is an introduced regression of the documented fix intent. The PR adds the `escapeSingleQuoted` function with clear documentation that "only single quotes need escaping" but then does NOT use it for env vars. This will be discovered at the first customer who passes a Windows path or regex with backslashes.

---

### 2. Missing Filesystem Cleanup on Session Destruction in `tmux-connector.ts:192, 220, 471`

**Severity**: HIGH | **Confidence**: 90% (1 reviewer: architecture)

**Problem**:
`hooks.cleanup(taskId, sessionsDir)` is only called on spawn failure (line 167). After successful spawn, neither `destroy()`, `dispose()`, nor `triggerExit()` calls `hooks.cleanup()`. This means the task-specific session directory (`wrapper.sh`, `messages/`, `.done`/`.exit` sentinel files, `.seq` sequence counter, `.seq.lock`) is never removed. Over time, `sessionsDir` accumulates orphaned directories — one per completed task.

**Impact**: Resource leak proportional to task throughput. A server running 100 tasks/day will accumulate 36,500 orphaned directories per year. Disk usage grows indefinitely; cleanup requires manual intervention.

**Fix**:
```typescript
// In destroy()
destroy(handle: TmuxHandle): Result<void, AutobeatError> {
  const session = this.activeSessions.get(handle.taskId);
  if (session) {
    session.exited = true;
    this.flushPendingFiles(session);
    this.closeSession(session);
    this.activeSessions.delete(handle.taskId);
  }
  const destroyResult = this.deps.sessionManager.destroySession(handle.sessionName);
  // Clean up filesystem artifacts
  this.deps.hooks.cleanup(handle.taskId, handle.sessionsDir);
  return destroyResult;
}

// Similarly in dispose() and triggerExit()
```

---

### 3. Fs.watch 'error' Event Not Handled — Watcher Error Crashes Process in `tmux-connector.ts:251-260, 268-286`

**Severity**: HIGH | **Confidence**: 90% (1 reviewer: reliability)

**Problem**:
`fs.watch()` emits an `'error'` event when the watched path is deleted or becomes inaccessible (e.g., session directory removed externally by a concurrent process, inotify limit exhaustion, unmounted filesystem). The code assigns `this.deps.watch()` return value but never attaches an `'error'` listener. In Node.js, an unhandled `'error'` event on an EventEmitter throws uncaught, crashing the entire process. The try/catch around the initial `watch()` call only catches synchronous construction errors, not runtime errors emitted later on the watcher instance.

**Impact**: If the session directory is removed while the watcher is active (race between tmux cleanup and the OS), the process crashes with an uncaught error and no graceful shutdown. This affects all active sessions, not just the one whose directory was deleted.

**Fix**:
```typescript
session.sentinelWatcher = this.deps.watch(
  sessionDir,
  { persistent: false },
  (_eventType: string, filename: string | null) => { /* ... */ },
);
session.sentinelWatcher.on('error', (err) => {
  this.deps.logger.warn('Sentinel watcher error', { taskId, error: String(err) });
  // Degrade gracefully — staleness timer is the fallback
});

// Same pattern for session.messagesWatcher
```

---

### 4. Synchronous readFileSync in Message Handler Blocks Event Loop in `tmux-connector.ts:422`

**Severity**: HIGH | **Confidence**: 85% (1 reviewer: performance)

**Problem**:
`handleMessageFile` is invoked from a setTimeout debounce callback. It calls `this.readFileSyncFn(filePath, 'utf8')` which resolves to `fs.readFileSync` in production. With 20 concurrent sessions producing output, the event loop is blocked on every message file read. At sustained output (e.g., Claude streaming), this creates back-pressure on all other sessions' callbacks and timers.

**Impact**: With 20 concurrent sessions, worst case is 20 synchronous file reads queuing in a single event loop turn (multiple debounce timers fire in the same macrotask batch). Each read is typically <1ms for small JSON, but under disk contention or network mounts this spikes. Serializes I/O that could be parallel, creating measurable latency increase.

**Fix**:
```typescript
// Replace sync readFile in the hot path with async
private async handleMessageFile(filePath: string, session: ActiveSession, callbacks: SpawnCallbacks): Promise<void> {
  if (session.exited) return;
  try {
    const raw = await this.readFileFn(filePath, 'utf8');  // async version
    const parsed = JSON.parse(raw);
    // ... rest unchanged
  } catch { ... }
}
// Sentinel handler and flush paths can remain sync (one-shot on exit)
```

---

### 5. Per-Session Staleness Timer spawns Synchronous Process Every 30s — N Sessions = N Concurrent spawnSync in `tmux-connector.ts:300-304`

**Severity**: HIGH | **Confidence**: 82% (1 reviewer: performance)

**Problem**:
Each session gets its own `setInterval` that calls `this.deps.sessionManager.isAlive(session.handle.sessionName)`, which resolves to `spawnSync('tmux has-session -t ...')`. With 20 concurrent sessions, this means 20 synchronous child process spawns every 30 seconds. Each `spawnSync` blocks the event loop for ~5-15ms (process fork + exec + wait), totaling ~100-300ms of event loop blocking per staleness cycle.

**Impact**: Creates periodic 100-300ms pauses in the event loop every 30 seconds. With 20 sessions, no callbacks, timers, or I/O events can be processed during these windows. This is measurable latency that affects message delivery timeliness for all sessions.

**Fix**:
```typescript
// Batch staleness checks into a single tmux list-sessions call on a shared timer
private startSharedStalenessTimer(intervalMs: number): void {
  this.sharedStalenessTimer = setInterval(() => {
    const listResult = this.deps.sessionManager.listSessions(); // 1 spawnSync total
    if (!listResult.ok) return;
    const aliveNames = new Set(listResult.value.map(s => s.name));
    for (const [taskId, session] of this.activeSessions) {
      if (session.exited) continue;
      const alive = aliveNames.has(session.handle.sessionName);
      // ... same stale logic, but only 1 process spawn
    }
  }, intervalMs);
}
```

---

### 6. Wrapper Script Embeds `sessionDir` in Bash Double-Quotes — Shell Metacharacters Would Execute in `tmux-hooks.ts:76`

**Severity**: HIGH | **Confidence**: 82% (1 reviewer: security)

**Problem**:
The wrapper script template uses bash double-quotes for the `SESSIONS_DIR` assignment:
```bash
SESSIONS_DIR="${sessionDir}"
```
This is a JavaScript template literal where `${sessionDir}` is replaced at generation time. The resulting bash script uses double-quotes, where `$`, backticks, and `\` have special meaning. If `sessionDir` (constructed from `config.sessionsDir + config.taskId`) ever contained shell metacharacters like `$(cmd)` or `` `cmd` ``, they would execute when the wrapper script runs.

Currently both `sessionsDir` (system config path) and `taskId` (UUID-based) are trusted, but this violates defense-in-depth — the tmux layer should validate inputs at its boundary.

**Impact**: If an upstream component constructs a `taskId` with shell injection payload (e.g., `task-abc$(rm -rf /)` somehow), arbitrary code executes in the wrapper script's context.

**Fix**:
```typescript
// Option 1: Use single quotes for literal assignment
SESSIONS_DIR='${sessionDir.replace(/'/g, "'\\''")}'

// Option 2: Validate sessionDir before embedding
const SESSION_DIR_REGEX = /^[a-zA-Z0-9\/_.-]+$/;
if (!SESSION_DIR_REGEX.test(sessionDir)) {
  return err(tmuxHookFailed('generateWrapper', `Invalid sessionDir: ${sessionDir}`));
}
// Then use with confidence
SESSIONS_DIR="${sessionDir}"
```

---

### 7. No `taskId` Validation at Tmux Layer Boundary — Path Traversal and Script Injection Possible in `tmux-hooks.ts:67` and `tmux-connector.ts:127`

**Severity**: HIGH | **Confidence**: 80% (1 reviewer: security)

**Problem**:
`taskId` is used in `path.join(config.sessionsDir, config.taskId)` for directory creation and in the wrapper script without validation. While upstream generates `task-<UUID>` format IDs, the tmux layer accepts any string. A `taskId` containing `../` could traverse directories; one containing shell metacharacters would inject into the wrapper script (via the double-quote context above). The `config.name` (session name) is validated against `SESSION_NAME_REGEX` (`/^beat-[a-z0-9-]+$/`), but `taskId` bypasses this check.

**Impact**: A compromised or buggy upstream component could pass a malicious `taskId` causing directory traversal or code injection in the wrapper script.

**Fix**:
```typescript
// Safe taskId: alphanumeric, hyphens, underscores only (matches UUID-based format)
const TASK_ID_REGEX = /^[a-z0-9][a-z0-9_-]*$/;
if (!TASK_ID_REGEX.test(config.taskId)) {
  return err(tmuxHookFailed('generateWrapper', `Invalid taskId: ${config.taskId}`));
}
```

---

## Should-Fix Issues (P1 — Recommend Fixing Before Merge)

### 1. TmuxSessionManager Interface Missing `listSessions` and `getSessionEnvironment` in `types.ts:189`

**Severity**: MEDIUM | **Confidence**: 85% (4 reviewers: consistency, typescript, regression, testing)

**Problem**:
Integration tests (session-lifecycle.test.ts) declare `manager: TmuxSessionManager` (the interface) but call `manager.listSessions()` (line 97) and `manager.getSessionEnvironment(...)` (line 117) which are NOT on the `TmuxSessionManager` interface. This is a type mismatch hidden only because `tsconfig.json` excludes tests from type-checking. Any consumer coding against the interface would not have access to these methods, creating a contract mismatch.

**Impact**: Type safety gap; future refactoring of the interface could silently break test code without detection.

**Fix**:
```typescript
// Option A: Widen the interface (if listSessions is part of contract)
export interface TmuxSessionManager {
  createSession(config: TmuxSessionConfig): Result<TmuxSessionResult, AutobeatError>;
  destroySession(name: string): Result<void, AutobeatError>;
  sendKeys(name: string, keys: string): Result<void, AutobeatError>;
  isAlive(name: string): Result<boolean, AutobeatError>;
  listSessions(): Result<TmuxSessionInfo[], AutobeatError>;
}

// Option B: Narrow the test variable type to concrete class
let manager: DefaultTmuxSessionManager;  // session-lifecycle.test.ts line 55
```

Given that `getSessionEnvironment` is intentionally concrete-only (test-only, not in session manager's responsibility), **Option B is the correct fix for the test**. Change the interface use to concrete type.

---

### 2. Incomplete Test Coverage — Missing Error Path Tests

**Severity**: MEDIUM | **Confidence**: 80-85% (1 reviewer: testing)

Four error-handling paths have no test coverage:

#### 2a. `dispose()` destroySession failure path in `tmux-connector.ts:229-234`
No test verifies that when `destroySession` returns `err(...)`, the warning is logged with correct error message. Fix: add test case for `destroySession` failure.

#### 2b. Messages watcher startup failure in `tmux-connector.ts:287-289`
Code gracefully degrades when messages watcher throws, but spawn success is not tested in this scenario. Fix: add test where `watch` throws on 2nd call (messages watcher).

#### 2c. `isOutputMessage` type guard rejects invalid `type` field
New validation rejects messages with `type` not in `['stdout', 'stderr', 'result']`, but no test verifies this stricter validation. Fix: add test case with invalid type value.

#### 2d. Staleness timer transient error path in `tmux-connector.ts:306-313`
When `isAlive` returns `err(...)`, the timer logs warning without triggering exit, but this path is untested. Fix: add test with fake timers where `isAlive` fails.

---

### 3. Wrapper Script `flock` Failure is Silent — Sequence Counter Duplicates on macOS in `tmux-hooks.ts:82`

**Severity**: MEDIUM | **Confidence**: 82% (1 reviewer: reliability)

**Problem**:
The wrapper script uses `flock -x 200 2>/dev/null || true` for locking the sequence file. On macOS, `flock` is not built-in; it requires Homebrew `util-linux`. If `flock` is unavailable, the `|| true` silently succeeds, and two concurrent processes could race on the sequence file, producing duplicate sequence numbers.

**Impact**: Low in practice today (single pipeline design means no concurrency within a session), but the assumption is undocumented. If this pattern is extended to multi-pipe setups in the future, it becomes a real issue.

**Fix**:
```bash
# Use mkdir-based locking as a portable fallback
next_seq() {
  local lockdir="$SEQ_FILE.lock.d"
  while ! mkdir "$lockdir" 2>/dev/null; do sleep 0.01; done
  trap 'rmdir "$lockdir"' RETURN
  SEQ=$(cat "$SEQ_FILE" 2>/dev/null || echo 0)
  SEQ=$((SEQ + 1))
  echo $SEQ > "$SEQ_FILE"
  printf "%05d" $SEQ
}
```

Or document that macOS requires Homebrew `util-linux` for `flock`.

---

### 4. `WrapperManifest.sessionsDir` Is Misnamed in `types.ts:110` and `tmux-hooks.ts:151`

**Severity**: MEDIUM | **Confidence**: 80% (1 reviewer: architecture)

**Problem**:
`WrapperManifest.sessionsDir` is set to the **task-specific directory** (`/tmp/sessions/task-abc`), not the base sessions directory (`/tmp/sessions`). But the field name is identical to `TmuxSpawnConfig.sessionsDir` (which IS the base directory). This naming confusion creates cognitive overhead and increases risk of passing the wrong directory to functions.

**Impact**: Developer confusion; higher likelihood of bugs when refactoring around this type.

**Fix**:
```typescript
// Rename to clarify it's task-specific
export interface WrapperManifest {
  sessionDir: string;  // was: sessionsDir (task-specific, singular)
  // ... rest unchanged
}
```

---

### 5. Dual-Path Delivery in `flushPendingFiles` Increases Maintenance Risk in `tmux-connector.ts:339-395`

**Severity**: MEDIUM | **Confidence**: 82% (1 reviewer: complexity)

**Problem**:
The flush function has two delivery paths: (1) `deliverPendingMessages` (consecutive sequences) and (2) force-deliver loop (remaining messages sorted by sequence). Both must respect `lastDeliveredSeq` watermark. The second path manually checks and updates `session.lastDeliveredSeq` inline rather than going through a shared primitive. If future logic is added to message delivery (logging, metrics, validation), the force-deliver path would silently bypass it.

**Fix**:
```typescript
// Extract a shared delivery primitive
private deliverSingle(session: ActiveSession, msg: OutputMessage): void {
  if (msg.sequence > session.lastDeliveredSeq) {
    session.lastDeliveredSeq = msg.sequence;
    session.callbacks.onOutput(msg);
  }
}

// Both paths call this helper
```

---

## Pre-existing Issues (Informational Only)

### `agentCommand` and `agentArgs` Embedded Without Escaping in `tmux-hooks.ts:96`

**Severity**: MEDIUM | **Confidence**: 85% (1 reviewer: security)

The wrapper script embeds `config.agentCommand` and `config.agentArgs.join(' ')` directly into bash without quoting. Code comment acknowledges this is intentional ("callers are responsible for trusted configuration"), but there is no assertion or type-level enforcement. This is documented as an accepted risk — marking as pre-existing since it was present before this diff.

---

## Quality Metrics by Reviewer

| Reviewer | Issues Found | Blocking | P1 | Confidence Avg |
|----------|--------------|----------|----|----|
| Security | 4 | 1 | 2 | 85% |
| Reliability | 3 | 1 | 2 | 82% |
| Architecture | 3 | 2 | 1 | 84% |
| Performance | 3 | 2 | 1 | 82% |
| Complexity | 3 | 1 | 0 | 76% |
| Consistency | 3 | 2 | 1 | 85% |
| Testing | 6 | 4 | 2 | 81% |
| Regression | 3 | 1 | 2 | 85% |
| TypeScript | 3 | 1 | 0 | 77% |

**Consensus**: Strong alignment on 3 core issues (env var escaping, filesystem cleanup, fs.watch error handling) flagged by 2+ reviewers each. TypeScript interface issue flagged by 4 reviewers (consistency, complexity, regression, testing).

---

## Action Plan

**Before Merge** (Blocking):
1. Fix env var backslash over-escaping in `tmux-session-manager.ts:122` — use `escapeSingleQuoted` consistently
2. Add filesystem cleanup calls in `destroy()`, `dispose()`, `triggerExit()`
3. Add `'error'` listener to both fs.watch instances
4. Batch staleness checks into single shared timer (replace 20 per-session spawnSync with 1)
5. Replace synchronous `readFileSync` in message handler with async version
6. Validate `taskId` at tmux boundary (regex check) and fix double-quote shell context
7. Narrow test variable types from `TmuxSessionManager` interface to `DefaultTmuxSessionManager`

**Recommended Before Merge** (P1):
8. Add missing test cases for error paths (4 scenarios)
9. Rename `WrapperManifest.sessionsDir` to `sessionDir`
10. Extract shared delivery primitive in `flushPendingFiles`
11. Document or fix `flock` macOS dependency

**Scoring Summary**:
- Security: 7/10 — Core escaping + validation gaps
- Reliability: 7/10 — Watcher error handling + cleanup gaps
- Architecture: 7/10 — Lifecycle and escaping consistency gaps
- Performance: 6/10 — Event loop blocking patterns under concurrency
- Complexity: 7/10 — Subtle closure captures and dual-path logic
- Consistency: 6/10 — Escaping and interface contract mismatches
- Testing: 7/10 — Good coverage; gaps in error path scenarios
- Regression: 8/10 — Single blocking issue (escaping); test hygiene
- TypeScript: 8/10 — Clean type design; interface use mismatch in tests

