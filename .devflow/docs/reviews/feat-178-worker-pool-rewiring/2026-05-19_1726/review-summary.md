# Code Review Summary

**Branch**: feat/178-worker-pool-rewiring -> main
**Date**: 2026-05-19_1726
**Reviewers**: 11 (security, architecture, performance, complexity, consistency, regression, testing, reliability, typescript, database, documentation)

---

## Merge Recommendation: CHANGES_REQUESTED

**Critical blockers**: 1 (failing test)
**High-severity blockers**: 11 across 6 reviewers
**Should-fix issues**: 8 across 5 reviewers

The tmux worker pool migration is architecturally sound with strong security awareness and well-bounded reliability patterns. However, **two regression race conditions and four input validation gaps must be fixed before merge**. One test is actively failing and must pass. After fixes, this PR is approvable.

---

## Issue Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW | Total |
|----------|----------|------|--------|-----|-------|
| **Blocking** (Your Changes) | 1 | 11 | 5 | 0 | **17** |
| **Should Fix** (Code You Touched) | 0 | 0 | 8 | 0 | **8** |
| **Pre-existing** | 0 | 0 | 5 | 0 | **5** |

---

## Blocking Issues (Must Fix Before Merge)

### CRITICAL

**Test failure: `buildTmuxCommand.test.ts:422` expects error, implementation returns ok** — Testing
- **File**: `tests/unit/implementations/build-tmux-command.test.ts:422`
- **Problem**: `ProcessSpawnerAdapter.buildTmuxCommand()` changed from returning `err()` to `ok()`, but test still asserts `result.ok === false`. Test is currently failing when run (`npm run test:implementations`).
- **Fix**: Update test to assert `result.ok === true` and validate the returned config shape.
- **Confidence**: 100%

---

### HIGH — Input Validation & Type Safety (7 issues from 4 reviewers)

**1. `sendControlKeys` lacks input validation — Shell injection vulnerability**
- **File**: `src/implementations/tmux/tmux-session-manager.ts:239`
- **Severity**: HIGH (Currently safe — only caller is hardcoded `'C-c'`, but public interface is unsafe)
- **Problem**: Constructs shell command with unquoted `${keys}` parameter. Unlike `sendKeys()` which uses literal mode and escaping, `sendControlKeys()` intentionally skips both. If a future caller passes user-controlled data, command injection is possible (e.g., `C-c; rm -rf /`).
- **Fix**: Add allowlist of known tmux control key names (`'C-c'`, `'C-d'`, `'C-z'`, `'C-\\'`, `'Enter'`, `'Escape'`). Validate parameter against allowlist before constructing command.
- **Confidence**: 85% (Security) | 95% (TypeScript suggests branded type)

**2. `TmuxConnectorPort.spawn()` uses `any` instead of `unknown` for config**
- **File**: `src/core/tmux-types.ts:92`
- **Problem**: Port interface uses `any` (disables all type checking) instead of `unknown` (requires type assertion at boundary). JSDoc at line 82 says "uses `unknown`" but code is `any` — documentation/code mismatch. This makes the port contract unenforceable for callers.
- **Fix**: Change to `unknown` and move type assertion from port to concrete implementation boundary (TmuxConnector class). This preserves layer separation while keeping `any` out of the public interface.
- **Confidence**: 95% (TypeScript) | 85% (Architecture)

**3. `ProcessSpawnerAdapter.buildTmuxCommand` returns double-cast `as unknown as TmuxSpawnConfig`**
- **File**: `src/implementations/process-spawner-adapter.ts:60`
- **Problem**: Fabricated config object bypasses all structural checks via `as unknown as`. If `TmuxSpawnConfig` gains required fields, this will silently produce an incomplete config at runtime. The cast hides type mismatches.
- **Fix**: Use `Partial<TmuxSpawnConfig>` with single `as TmuxSpawnConfig` cast. Add comment that this is test-only adapter. Or ensure this adapter is only used with mock connector that ignores config.
- **Confidence**: 90% (TypeScript) | 85% (Consistency)

**4. `fs.watch` cast to `any` in bootstrap**
- **File**: `src/bootstrap.ts:529`
- **Problem**: Uses `fs.watch as any` because overloads don't match `WatchFn` structurally. The `any` disables type checking at composition root.
- **Fix**: Define narrow adapter function that matches `WatchFn` exactly, or use targeted `as WatchFn` instead of `as any`.
- **Confidence**: 85% (TypeScript)

**5. `SAFE_PATH_REGEX` rejects paths with spaces (common on macOS)**
- **File**: `src/implementations/tmux/types.ts:278`
- **Problem**: Regex `/^(?!.*\.\.)([a-zA-Z0-9/_.\-]+)$/` does not allow spaces. Users with spaces in `AUTOBEAT_DATA_DIR` or `cwd` get "unsafe path" error. Security intent (prevent metacharacters) is correct, but character class is overly restrictive. Spaces are safe inside single quotes (which all tmux commands use).
- **Fix**: Add space to character class: `/^(?!.*\.\.)([a-zA-Z0-9/_.\- ]+)$/`
- **Confidence**: 82% (Security)

**6. `options.taskId ?? 'task-unknown'` cast to `TaskId` without validation**
- **File**: `src/implementations/process-spawner-adapter.ts:50`
- **Problem**: If `options.taskId` is undefined, fallback string `'task-unknown'` is cast to branded `TaskId` type. Creates a fake branded value that could propagate into DB and events. Violates the purpose of branded types.
- **Fix**: Either require `taskId` on adapter input or return error when missing.
- **Confidence**: 80% (TypeScript)

**7. JSDoc mismatch: says "uses `unknown`" but code uses `any`**
- **File**: `src/core/tmux-types.ts:82-92`
- **Problem**: Line 82 JSDoc says `unknown`, line 92 code says `any`. Misleading documentation.
- **Fix**: Update JSDoc to match actual type.
- **Confidence**: 92% (Consistency)

---

### HIGH — Race Conditions & Duplicate Handling (4 issues from 2 reviewers)

**8. Double `cleanupWorkerState()` during `kill()` + `onExit` race**
- **File**: `src/implementations/event-driven-worker-pool.ts:279, 609-613`
- **Problem**: `kill()` sends C-c (line 237), then polls `isAlive()` asynchronously (lines 251-260). During the async window, tmux session dies and `onExit` callback fires, calling `cleanupWorkerState()` and setting `completionHandled = true`. After poll loop exits, `kill()` calls `cleanupWorkerState()` a second time (line 279). Result: worker count double-decrements, redundant DB unregister.
- **Impact**: Worker count becomes negative/inaccurate. ResourceMonitor allows more workers than limit.
- **Fix**: Make `cleanupWorkerState()` idempotent by checking `this.workers.has(workerId)` before decrementing:
```typescript
private cleanupWorkerState(workerId: WorkerId, taskId: TaskId): void {
  if (!this.workers.has(workerId)) return; // Already cleaned up
  // ... rest of code
}
```
- **Confidence**: 92% (Regression)

**9. Duplicate event emission on timeout (`TaskFailed` + `TaskTimeout`)**
- **File**: `src/implementations/event-driven-worker-pool.ts:669-673`
- **Problem**: `handleWorkerTimeout()` calls `this.kill(workerId)` which triggers `onExit` callback that emits `TaskFailed` or `TaskCompleted`. Then `handleWorkerTimeout()` emits `TaskTimeout` on the same task. Single timeout produces two events.
- **Impact**: Task marked FAILED by first event, then receives `TaskTimeout` on already-terminal task. Inconsistent with documented behavior.
- **Fix**: Set `worker.completionHandled = true` before calling `this.kill()`:
```typescript
private async handleWorkerTimeout(taskId: TaskId, timeoutMs: number): Promise<void> {
  const worker = this.workers.get(workerId);
  if (!worker) return;
  worker.completionHandled = true; // Prevent onExit from emitting
  await this.kill(workerId);
  await this.eventBus.emit('TaskTimeout', {...});
}
```
- **Confidence**: 85% (Regression)

---

### HIGH — Performance & System Reliability (5 issues from 2 reviewers)

**10. Unbounded `spawnSync` timeout in `tmuxExec()` — can freeze entire event loop**
- **File**: `src/bootstrap.ts:508-511`
- **Problem**: Shared `tmuxExec` function uses `spawnSync(cmd, { shell: true, encoding: 'utf8' })` with no timeout. If tmux server hangs (deadlocked socket, etc.), any tmux operation blocks the entire Node.js event loop indefinitely. Every worker operation (spawn, kill, isAlive, etc.) goes through this function.
- **Impact**: CRITICAL reliability issue. Single hung tmux server freezes the entire application.
- **Fix**: Add timeout to spawnSync:
```typescript
const tmuxExec: ExecFn = (cmd) => {
  const result = spawnSync(cmd, { shell: true, encoding: 'utf8', timeout: 10_000 });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status ?? -1 };
};
```
- **Confidence**: 90% (Reliability)

**11. Per-worker `isAlive()` check in heartbeat blocks event loop every 30s**
- **File**: `src/implementations/event-driven-worker-pool.ts:570`
- **Problem**: `setupHeartbeatForWorker()` runs every 30s and calls `tmuxConnector.isAlive(worker.handle)`, which calls `spawnSync('tmux has-session ...')`. This blocks event loop for 5-20ms per worker. Redundant with TmuxConnector's shared staleness timer that already performs efficient liveness checks (one `listSessions()` call for all sessions).
- **Impact**: Unnecessary double blocking syscall load. With 10 workers, blocks event loop for 100ms every 30s.
- **Fix**: Remove the redundant per-worker `isAlive()` check. TmuxConnector's shared staleness timer already detects dead sessions efficiently.
- **Confidence**: 90% (Performance)

---

## Should-Fix Issues (Code You Touched)

### MEDIUM — Missing Test Coverage (2 issues from Testing reviewer)

**12. No tests for RecoveryManager tmux liveness paths**
- **File**: `src/services/recovery-manager.ts:100-112, 169-176, 427-446`
- **Problem**: RecoveryManager gained 75 lines implementing tmux-aware recovery (`isTmuxSessionAlive()`, tmux-specific branching in `cleanDeadWorkerRegistrations()` and `recoverRunningTasks()`). These are critical crash-detection paths. Zero tmux test cases exist in recovery-manager test file.
- **Test Scenarios Needed**:
  - Worker with `pid=0` and valid `sessionName` where session is alive (should skip recovery)
  - Worker with `pid=0` and valid `sessionName` where session is dead (should fail task)
  - Worker with `pid=0` and no `sessionName` (should fail task)
  - Worker with `pid=0` and no `tmuxSessionManager` injected (fallback to false)
- **Confidence**: 95% (Testing)

**13. Missing timeout behavior tests for tmux worker pool**
- **File**: `tests/unit/implementations/event-driven-worker-pool.test.ts`
- **Problem**: Implementation has `handleWorkerTimeout()` and `setupTimeoutForWorker()` for timeout handling. Zero timeout test cases in new test suite. Old test also lacked this. Critical path (tasks hanging forever) is untested.
- **Test Scenarios Needed**: Task exceeding timeout triggers `kill()` and emits `TaskTimeout`
- **Confidence**: 85% (Testing)

### MEDIUM — Dead Code & Inconsistency (3 issues from 2 reviewers)

**14. Dead code: `ProcessConnector` is orphaned**
- **File**: `src/services/process-connector.ts`
- **Problem**: No longer imported by any source file. Functionality reimplemented inline in worker pool. Class exists but has zero consumers. Dead code increases maintenance burden.
- **Fix**: Delete the file. Update comment in `usage-capture-handler.ts` that references the non-existent integration.
- **Confidence**: 95% (Regression)

**15. Event emission pattern changed from `await` to fire-and-forget without DECISION comment**
- **File**: `src/implementations/event-driven-worker-pool.ts:623-633`
- **Problem**: `handleWorkerCompletion` changed from `async` (with `await this.eventBus.emit()`) to synchronous with fire-and-forget `.emit().catch()`. Entire codebase uses `await emit()` consistently. This introduces pattern divergence without explanation.
- **Fix**: Add DECISION comment explaining why fire-and-forget is required (likely: `handleWorkerCompletion` called from sync `onExit` callback; making callback async would risk re-ordering with other cleanup paths):
```typescript
// DECISION: Fire-and-forget emit — this method is called synchronously from
// the tmux onExit callback (via flushOutput().finally()). Awaiting would require
// making the entire callback chain async, which risks re-ordering with other
// synchronous cleanup paths. Errors are logged and do not lose task completion.
```
- **Confidence**: 85% (Consistency)

**16. `ProcessSpawnerAdapter.buildTmuxCommand` violates `AgentAdapter` JSDoc contract**
- **File**: `src/implementations/process-spawner-adapter.ts:47-62`
- **Problem**: JSDoc at `src/core/agents.ts:324` explicitly states "Adapters that do not support tmux must return `err(INVALID_OPERATION)`". PR changed ProcessSpawnerAdapter to return `ok()` with fabricated config, violating the documented contract.
- **Fix**: Update `AgentAdapter.buildTmuxCommand` JSDoc to reflect new behavior ("Test adapters may return stub config"), and remove stale ARCHITECTURE comment about moving TmuxSpawnConfig to core (Phase 3 decided to keep it in implementations).
- **Confidence**: 95% (Consistency)

### MEDIUM — Orchestration Liveness Gap (1 issue from 2 reviewers)

**17. Orchestration zombie detection does not check tmux session liveness**
- **File**: `src/services/orchestration-liveness.ts:68`
- **Problem**: `checkOrchestrationLiveness()` traces `orchestration -> loop -> iteration -> task -> worker -> isProcessAlive(ownerPid)`. For tmux workers (pid=0), `ownerPid` is the bootstrap process PID. While server is running, all tmux workers appear "live" even if their tmux session crashed. `cleanDeadWorkerRegistrations()` correctly handles this with `isTmuxSessionAlive()`, but orchestration zombie detection does not. Behavior drift between two recovery paths.
- **Impact**: RUNNING orchestration with dead tmux session shows as "live" in dashboard until next server restart.
- **Fix**: Update `LivenessDeps` to include optional `isTmuxSessionAlive` checker and handle tmux workers in `checkOrchestrationLiveness()`:
```typescript
const isTmuxWorker = worker.pid === 0;
if (isTmuxWorker) {
  if (!worker.sessionName || !deps.isTmuxSessionAlive) return 'unknown';
  return deps.isTmuxSessionAlive(worker.sessionName) ? 'live' : 'dead';
}
return deps.isProcessAlive(worker.ownerPid) ? 'live' : 'dead';
```
- **Confidence**: 85% (Database, Regression)

---

## Complexity Issues (Not Blocking But Should Address)

### HIGH

**18. `spawn()` method exceeds function length threshold (114 lines)**
- **File**: `src/implementations/event-driven-worker-pool.ts:92-205`
- **Confidence**: 85%
- **Recommendation**: Extract steps 6-10 (tmux spawn, register, setup timeout/heartbeat/flushing) into private helper like `launchAndRegister()`. Complexity review marked APPROVED_WITH_CONDITIONS on this.

**19. `kill()` method exceeds function length threshold (79 lines)**
- **File**: `src/implementations/event-driven-worker-pool.ts:207-285`
- **Confidence**: 82%
- **Recommendation**: Extract graceful shutdown sequence (steps 2-5: check alive, send Ctrl-C, poll, force-destroy) into helper like `gracefulShutdownSession()`.

**20. Duplicated tmux/PID liveness branching pattern (2 occurrences)**
- **File**: `src/services/recovery-manager.ts:172-176, 428-432`
- **Confidence**: 88%
- **Recommendation**: Extract nested ternary into single private method `isWorkerAlive(reg)`. Complexity review marked APPROVED_WITH_CONDITIONS on this.

---

## Documentation Issues (Not Blocking But Important)

### HIGH

**21. CLAUDE.md missing `src/core/tmux-types.ts` in File Locations table**
- **File**: `CLAUDE.md:270-315`
- **Problem**: New core-layer module with port interfaces not listed. Developers looking for tmux port contracts won't find them.
- **Fix**: Add row: `| Tmux port interfaces | src/core/tmux-types.ts |`
- **Confidence**: 95%

**22. CLAUDE.md testing section references stale mock names (MockProcessSpawner)**
- **File**: `CLAUDE.md:232`
- **Problem**: After tmux migration, tests use `MockTmuxConnector`, not `MockProcessSpawner`.
- **Fix**: Update: "all tests use mocks (MockWorkerPool, MockTmuxConnector)"
- **Confidence**: 88%

**23. CLAUDE.md architecture notes missing tmux/worker pool model**
- **File**: `CLAUDE.md:50-64`
- **Problem**: No mention of how workers are now tmux sessions, not child processes. Fundamental architectural change.
- **Fix**: Add brief note about tmux-based workers, session names, C-c graceful kill, and requirement for tmux >= 3.0.
- **Confidence**: 85%

**24. CLAUDE.md missing EventDrivenWorkerPool in File Locations table**
- **File**: `CLAUDE.md:270-315`
- **Problem**: Second-largest implementation file, central to worker subsystem, absent from table.
- **Fix**: Add row: `| Worker pool | src/implementations/event-driven-worker-pool.ts |`
- **Confidence**: 82%

---

## Pre-existing Issues (Noted But Not Blocking)

| Issue | Reviewer | Severity | Note |
|-------|----------|----------|------|
| `tmux-connector.ts` file length (897 lines) | Complexity | HIGH | Well-structured internally; consider extracting message delivery pipeline in future PR |
| `bootstrap()` function length (541 lines) | Complexity | HIGH | Pre-existing; consider extracting tmux wiring block in future PR |
| `recovery.recover()` fire-and-forget in bootstrap | Reliability | MEDIUM | Pre-existing; add `.catch()` handler |
| `AgentAdapter` retains process-based methods | Architecture | MEDIUM | Planned follow-up; tech debt tracking |
| Orchestration liveness comment references PID-only model | Documentation | MEDIUM | Pre-existing; update at release |

---

## Summary by Reviewer

| Reviewer | CRITICAL | HIGH | MEDIUM | Recommendation |
|----------|----------|------|--------|-----------------|
| Testing | 1 | 2 | 1 | CHANGES_REQUESTED |
| Security | 0 | 1 | 1 | CHANGES_REQUESTED |
| Regression | 0 | 2 | 2 | CHANGES_REQUESTED |
| Reliability | 0 | 2 | 2 | CHANGES_REQUESTED |
| TypeScript | 0 | 3 | 2 | CHANGES_REQUESTED |
| Architecture | 0 | 2 | 3 | CHANGES_REQUESTED |
| Performance | 0 | 2 | 2 | CHANGES_REQUESTED |
| Consistency | 0 | 2 | 2 | CHANGES_REQUESTED |
| Complexity | 0 | 2 | 2 | APPROVED_WITH_CONDITIONS |
| Database | 0 | 1 | 0 | CHANGES_REQUESTED |
| Documentation | 0 | 3 | 3 | CHANGES_REQUESTED |

---

## Action Plan

### Priority 1: Fix Before Merge (Blocking)
1. **Update failing test** — `build-tmux-command.test.ts:422`
2. **Add control key validation** — `sendControlKeys()` allowlist
3. **Fix type safety** — `TmuxConnectorPort.spawn()` use `unknown` instead of `any`
4. **Add timeout to tmuxExec** — prevent event loop freeze
5. **Remove redundant isAlive check** — heartbeat liveness check
6. **Make cleanupWorkerState idempotent** — guard double-cleanup race
7. **Guard TaskTimeout emission** — set `completionHandled` before kill

### Priority 2: Should Fix While Here
8. Add RecoveryManager tmux liveness test cases
9. Add timeout behavior test cases
10. Delete `ProcessConnector` dead code
11. Add DECISION comment to `handleWorkerCompletion`
12. Update `AgentAdapter` JSDoc contract
13. Add tmux session liveness to orchestration zombie check
14. Update CLAUDE.md (4 doc issues)

### Priority 3: Complexity Extractions (Recommended)
15. Extract `spawn()` rollback steps into `launchAndRegister()` helper
16. Extract `kill()` shutdown sequence into `gracefulShutdownSession()` helper
17. Extract duplicated liveness logic into `isWorkerAlive(reg)` method

---

## Confidence & Convergence

**Issues flagged by multiple reviewers** (high confidence):
- `sendControlKeys` validation: Security + TypeScript (2)
- `TmuxConnectorPort.spawn()` `any` type: Security + Architecture + TypeScript (3)
- `ProcessSpawnerAdapter` double-cast: Security + TypeScript + Consistency + Reliability (4)
- Double `cleanupWorkerState`: Regression + Performance + Reliability (3)
- Duplicate event emission: Regression + Architecture + Performance (3)
- Unbounded `spawnSync` timeout: Performance + Reliability (2)
- RecoveryManager tmux liveness gap: Testing + Regression + Database + Documentation (4)
- Orchestration liveness gap: Reliability + Database (2)

**No reviewer disagreement.** All 11 reviewers identified genuine issues. The PR is well-written overall but requires targeted fixes to several security/reliability/correctness gaps before merge.

