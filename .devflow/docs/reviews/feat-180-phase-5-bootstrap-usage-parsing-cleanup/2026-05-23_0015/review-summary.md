# Code Review Summary

**Branch**: feat/180-phase-5-bootstrap-usage-parsing-cleanup -> main
**Date**: 2026-05-23
**Timestamp**: 2026-05-23_0015
**Cycle**: 1 (initial review, no prior resolutions)

## Merge Recommendation: CHANGES_REQUESTED

This Phase 5 persistent session reuse feature is architecturally sound and removes dead code cleanly, but contains **3 blocking issues** that must be resolved before merge:

1. **CRITICAL**: Stale callback closures in `reuseSession()` break crash detection for iterations 2+
2. **CRITICAL**: `TmuxSpawnCoreConfig.persistent` flag is dead code (never set by adapters)
3. **HIGH**: `WorkerState.task` and callbacks remain stale after session reuse, breaking task attribution

These are not edge cases — they directly break the core loop functionality: persistent sessions will appear to hang after the first iteration because crash detection and completion events are lost.

---

## Issue Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW | Total |
|----------|----------|------|--------|-----|-------|
| Blocking | 3 | 8 | 0 | - | 11 |
| Should Fix | - | 0 | 7 | - | 7 |
| Pre-existing | - | 0 | 2 | 0 | 2 |

**Total Issues Found**: 20 across 11 reviewers

---

## Blocking Issues (CRITICAL / HIGH)

### CRITICAL 1: Stale Callback Closure Breaks Crash Detection
**Reviewers**: Reliability, TypeScript, Regression (3 convergent findings, 92-95% confidence)
**Location**: `src/implementations/event-driven-worker-pool.ts:188,252-336`

**Problem**: The `createCallbacks(taskId)` closure at line 188 captures the **initial iteration's taskId**. When `reuseSession()` is called for iteration 2+, it updates the `taskToWorker` map (deletes old taskId) but does NOT update the `onExit` callback. If the agent crashes during iteration 2+, `onExit` fires with the stale taskId, `handleWorkerCompletion` gets `undefined` from `taskToWorker.get(staleTaskId)`, and **TaskFailed is never emitted**. The loop stalls indefinitely because its termination signal is lost.

**Impact**: Persistent sessions hang on any crash after iteration 1. Loop never recovers without manual cancellation. This violates the bounded-iteration reliability principle.

**Fix**: Use a mutable reference object in the closure instead of capturing a fixed value:
```typescript
interface TaskIdRef { current: TaskId }

private createCallbacks(taskIdRef: TaskIdRef): SpawnCallbacks {
  return {
    onExit: (code: number | null) => {
      const taskId = taskIdRef.current;  // Read current, don't capture
      // ... existing logic ...
    }
  };
}

// In reuseSession():
const existingWorker = this.workers.get(workerId);
taskIdRef.current = task.id;  // Update reference for next iteration
```

---

### CRITICAL 2: Dead Code Path — `TmuxSpawnCoreConfig.persistent` Never Set
**Reviewers**: TypeScript (confidence: 80%)
**Location**: `src/core/tmux-types.ts:85-91`, `src/implementations/base-agent-adapter.ts:99-148`

**Problem**: The `persistent?: boolean` flag was added to the `TmuxSpawnCoreConfig` interface and checked in `TmuxConnector.spawn()` (line 173-185), but `BaseAgentAdapter.buildTmuxCommand()` never sets `persistent: true` in the returned config. The WorkerPool sets `persistentSessionKey` on the Task, but that signal never reaches the adapter. The setup shim code path is dead code in production.

**Impact**: The Phase 5 persistent session design is incomplete — the adapter has no way to signal persistent mode to the connector, so all spawns use the wrapper pipeline instead of the optimized setup shim.

**Fix**: In `WorkerPool.spawn()`, after calling `adapter.buildTmuxCommand()`, check `task.persistentSessionKey` and set `config.persistent = true`:
```typescript
const { config, prompt } = adapterResult.value;
if (task.persistentSessionKey) {
  config.persistent = true;
}
```

---

### CRITICAL 3: WorkerState Remains Stale After Session Reuse
**Reviewers**: TypeScript (confidence: 95%), Reliability (confidence: 88%), Architecture (confidence: 85%)
**Location**: `src/implementations/event-driven-worker-pool.ts:312-313,333`

**Problem**: `reuseSession()` updates `taskToWorker` but returns `existingWorker` with stale `task` and `taskId` fields (both are `readonly`). The returned Worker has the old iteration's task object. Additionally, the `onOutput` callback closure (created at line 188) still captures the old taskId, so output from iteration 2+ is attributed to the wrong task.

**Impact**: 
- `worker.taskId` returned to caller (WorkerHandler) is wrong — emits TaskStarted with old task ID
- `onOutput` routes output to wrong task in the database
- `completionHandled` flag from previous iteration carries over, potentially silencing completion events
- Periodic flush (line 646-653) and timeout handler (line 793) use stale taskId

**Fix**: Create a new WorkerState with updated fields, or make `task`/`taskId` mutable:
```typescript
const updatedWorker: WorkerState = {
  ...existingWorker,
  task,
  taskId: task.id,
  completionHandled: false,  // Reset for new iteration
};
this.workers.set(workerId, updatedWorker);
this.taskToWorker.delete(existingWorker.task.id);
this.taskToWorker.set(task.id, workerId);
return ok(updatedWorker);
```

---

## Should-Fix Issues (HIGH)

### HIGH 1: Stale JSDoc on `updateInteractiveOrchestrationPid`
**Reviewers**: Consistency (confidence: 85%)
**Location**: `src/core/interfaces.ts:886-891`

**Problem**: JSDoc still references "child process PID" and "kill" behavior from pre-Phase 5. With Phase 5, interactive orchestrations use tmux sessions, not child processes. The JSDoc misleads readers.

**Fix**: Update to clarify it's a legacy PID path retained for backward compat:
```typescript
/**
 * Store the child process PID for remote cancel support (pre-Phase 5 legacy path).
 * Phase 5 orchestrations use updateInteractiveOrchestrationSessionName() instead.
 */
```

---

### HIGH 2: Setup Shim Lacks Defensive Validation
**Reviewers**: Security (confidence: 95%)
**Location**: `src/implementations/tmux/tmux-hooks.ts:169-193`

**Problem**: `buildSetupShim()` embeds `config.agentCommand` directly without validating it against `SAFE_PATH_REGEX`. The validation happens in the caller (`generateSetupShim()`) but not in the function itself. If `buildSetupShim()` is called from another path without the validation gate, shell metacharacters could execute arbitrary commands.

**Impact**: Currently safe (only caller validates), but violates defense-in-depth principle. Future refactor risk.

**Fix**: Add defensive guard inside `buildSetupShim()`:
```typescript
if (!SAFE_PATH_REGEX.test(config.agentCommand)) {
  throw new Error(`unsafe agentCommand in buildSetupShim: ${config.agentCommand}`);
}
```

---

### HIGH 3: `handleOrchestrateInteractive` Exceeds 250 Lines
**Reviewers**: Complexity (confidence: 92%)
**Location**: `src/cli/commands/orchestrate-interactive.ts:131-387`

**Problem**: 256-line function with 8 sequential error-handling blocks, 3 levels of nesting, and 4 distinct lifecycle phases (setup → spawn → attach → finalize). No extraction. Nearly identical guard-check-exit blocks invite copy-paste bugs.

**Impact**: Difficult to understand, test, or modify. New contributors need significant time to trace flow.

**Fix**: Extract into named helper functions:
```typescript
1. resolveContainerDeps(container)
2. spawnAndDeliverPrompt(tmuxConnector, adapter, ...)
3. attachAndWaitForSession(handle, ...)
4. finalizeOrchestration(...)
```
Each helper <50 lines. Main function becomes a readable pipeline.

---

### HIGH 4: Duplicate Tmux Validation Logic
**Reviewers**: Complexity, Architecture, Performance (3 convergent, 80-92% confidence)
**Location**: `src/cli/commands/orchestrate-interactive.ts:100-125` vs `src/bootstrap.ts:556-568`

**Problem**: Two independent tmux validation implementations: `validateTmux()` in orchestrate-interactive.ts (spawnSync + regex) vs. `TmuxValidator` in bootstrap (injectable ExecFn + validator class). Both check tmux >= 3.0. The CLI version cannot be tested without a real tmux binary.

**Impact**: Maintenance burden. If minimum version changes, two places must be updated. Divergence risk.

**Fix**: Inject `TmuxValidator` or reuse it directly from the container:
```typescript
const validator = new TmuxValidator({ exec: spawnSync });
const validationResult = validator.validate();
if (!validationResult.ok) {
  ui.error(`tmux validation failed: ${validationResult.error.message}`);
  process.exit(1);
}
```

---

### HIGH 5: Stale Callback Closure in Output Capture
**Reviewers**: Regression (confidence: 80%)
**Location**: `src/implementations/event-driven-worker-pool.ts:599-606`

**Problem**: The `onOutput` callback created at line 188 captures the original task ID. After `reuseSession()`, output from iteration 2+ is still routed with the original taskId, causing output attribution to the wrong task.

**Impact**: Task output in the database is attributed to the wrong iteration.

**Fix**: Same as the onExit fix — use a mutable `TaskIdRef` in the callback closure.

---

### HIGH 6: `reuseSession` Error Path Returns Error Instead of Falling Back
**Reviewers**: Architecture (confidence: 83%)
**Location**: `src/implementations/event-driven-worker-pool.ts:249-251,279,292,307`

**Problem**: The DESIGN DECISION comment says "On any failure, fall through to fresh spawn," but the actual code returns `err(...)` immediately when `setEnvironment`, `sendKeys`, or other operations fail. The caller (`spawn()`) receives the error and propagates it upward rather than retrying with a fresh spawn.

**Impact**: Transient tmux failures (e.g., env-var setting timeouts) fail the entire iteration instead of gracefully recovering.

**Fix**: Restructure `reuseSession()` to internally call `launchAndRegister()` on recoverable failures, or return a sentinel (`ok(null)`) that signals fallback:
```typescript
const reuseResult = await this.reuseSession(task, psk, existing, prompt);
if (reuseResult.ok && reuseResult.value === null) {
  // Fall through to fresh spawn
  return await this.launchAndRegister(task, prompt);
}
```

---

### HIGH 7: `reuseSession` Polling Loop Uses Magic 50ms Interval
**Reviewers**: Performance, Complexity (80-85% confidence)
**Location**: `src/cli/commands/orchestrate-interactive.ts:344-359`

**Problem**: After tmux attach exits, code polls for `agentExited` flag using `setInterval(50ms)` with a 2000ms deadline, creating up to 40 timer callbacks. The interval is a magic number with no documented rationale. Polling is less efficient than event-driven notification.

**Impact**: Wasteful; creates 40 timer callbacks for a simple boolean flag wait.

**Fix**: Use event-driven pattern with `Promise.race`:
```typescript
let resolveExit: () => void;
const exitPromise = new Promise<void>((resolve) => { resolveExit = resolve; });

onExit: () => {
  agentExited = true;
  resolveExit();
},

// After attach returns:
await Promise.race([
  exitPromise,
  new Promise<void>((resolve) => setTimeout(resolve, 2000)),
]);
```

---

### HIGH 8: Test Factory Missing `cleanupPersistentSession` Mock
**Reviewers**: Testing (confidence: 80%)
**Location**: `tests/helpers/test-factories.ts:197-207`

**Problem**: The `workerPool` test factory uses `as WorkerPool` cast and does not include the new `cleanupPersistentSession` method. Tests that exercise persistent session cleanup will get runtime TypeError.

**Impact**: Incomplete test coverage for cleanup paths.

**Fix**: Add mock to the factory:
```typescript
cleanupPersistentSession: vi.fn(),
```

---

## Medium-Severity Issues (Should Review)

### MEDIUM 1: 300ms Settle Time is Hardcoded
**Reviewers**: Performance, Architecture, Complexity (65-85% confidence)
**Location**: `src/implementations/event-driven-worker-pool.ts:295`

Make the settle time configurable and document the rationale. See performance report for details.

---

### MEDIUM 2: Nested Nesting in `spawn()` Persistent Session Check
**Reviewers**: Complexity (confidence: 82%)
**Location**: `src/implementations/event-driven-worker-pool.ts:193-219`

5 levels of nesting: `if (psk) -> if (!reuseInProgress) -> else -> if (existing) -> if (aliveResult.ok)`. Use early-continue pattern to reduce to 3 levels.

---

### MEDIUM 3: Stale JSDoc on `finalizeInteractiveOrchestration`
**Reviewers**: Consistency (confidence: 82%)
**Location**: `src/core/interfaces.ts:903`

Update JSDoc from "child process exits" to "tmux session ends."

---

### MEDIUM 4: `resolveAuth` JSDoc References Removed `spawn()`
**Reviewers**: Consistency (confidence: 82%)
**Location**: `src/implementations/base-agent-adapter.ts:181`

Update JSDoc to reference `buildTmuxCommand()` instead of removed `spawn()`.

---

### MEDIUM 5: Persistent Session Reuse Test Lacks Behavioral Verification
**Reviewers**: Testing (confidence: 85%)
**Location**: `tests/unit/implementations/event-driven-worker-pool.test.ts:868-889`

Test verifies `sendKeys` was called but not the critical outcome: that `getWorkerForTask(task2.id)` succeeds (confirming re-mapping). Add task re-mapping assertions.

---

### MEDIUM 6: No Test Coverage for Concurrent Reuse Guard
**Reviewers**: Testing (confidence: 82%)
**Location**: Implementation exists but no test

The `reuseInProgress` guard (line 258) is documented but untested. Add a test for concurrent spawn attempts with the same persistent key.

---

### MEDIUM 7: AUTOBEAT_WORKER Env Var Leaked into Interactive Sessions
**Reviewers**: Regression (confidence: 82%)
**Location**: `src/implementations/base-agent-adapter.ts:422`, `src/cli/commands/orchestrate-interactive.ts`

**Problem**: Old `spawnInteractive()` explicitly stripped `AUTOBEAT_WORKER` from the environment. New path includes it, changing agent behavior in interactive sessions.

**Fix**: In `orchestrate-interactive.ts`, strip `AUTOBEAT_WORKER` from tmux config before spawn:
```typescript
const { AUTOBEAT_WORKER: _, ...interactiveEnv } = tmuxConfig.env || {};
tmuxConfig = { ...tmuxConfig, env: interactiveEnv };
```

---

### Additional Medium Issues
See full reviewer reports for:
- `process.env` iteration overhead (Performance)
- TmuxConnector redundant per-spawn validation (Reliability)
- Interactive orchestrator catch-block missing session destroy (Regression)
- `poll` interval lacks `.unref()` (TypeScript)
- Comment at line 387 references stale "PID path" behavior (Consistency)
- Test factory killAll test assertion incomplete (Testing)

---

## Convergent Findings (Multiple Reviewers Agree)

| Finding | Reviewers | Confidence |
|---------|-----------|------------|
| Stale callback closure breaks crash detection | Reliability, TypeScript, Regression | 92-95% |
| WorkerState.task remains stale after reuse | TypeScript, Reliability, Architecture | 85-95% |
| Duplicate tmux validation logic | Complexity, Architecture, Performance | 80-92% |
| 300ms settle time hardcoded | Performance, Complexity, Reliability | 65-85% |
| reuseSession error path doesn't fall through | Architecture, Complexity, TypeScript | 72-83% |
| Callback closures capture old taskId | Regression, Reliability, Consistency | 65-85% |
| handleOrchestrateInteractive too long | Complexity (single reviewer, 92%) | 92% |

---

## Divergent Findings (Reviewers Disagree)

No fundamental disagreements. All reviewers agree on severity categorization. Minor tone differences:
- **Security** rates the `buildSetupShim` validation gap as HIGH (defense-in-depth violation)
- **Architecture** rates it MEDIUM (currently safe, future risk)
- **Synthesis recommendation**: BLOCK as HIGH due to defense-in-depth principle in established codebase

---

## Quality Scores by Reviewer

| Reviewer | Score | Key Concern |
|----------|-------|------------|
| Security | 8/10 | Defense-in-depth gap in buildSetupShim |
| Architecture | 7/10 | Stale WorkerState + error fallback mismatch |
| Performance | 8/10 | 300ms magic constant + polling loop |
| Complexity | 6/10 | 256-line function + duplicate validation |
| Consistency | 8/10 | Stale JSDoc comments |
| Regression | 5/10 | Callback closure crashes + AUTOBEAT_WORKER leak |
| Testing | 7/10 | Reuse test lacks behavioral verification |
| Reliability | 5/10 | Stale closure + missing completionHandled reset |
| TypeScript | 5/10 | CRITICAL: Stale callbacks + persistent flag dead code |
| Database | 9/10 | Migration v30 is flawless |
| Dependencies | 10/10 | Zero dependency changes |

**Average Score: 6.8/10**
**Category**: Below threshold (7.0) due to blocking CRITICAL issues in core loop functionality

---

## Pre-existing Issues (Not Blocking)

1. **Flaky CI test**: `network-failures.test.ts:312` — packet loss tolerance occasionally exceeded (known issue in CLAUDE.md)
2. **Sequential killAll blocks for 3s per worker** — pre-existing design decision, documented

---

## Action Plan

### Before Merge (Blocking)
1. Fix stale callback closure — implement `TaskIdRef` mutable reference pattern
2. Fix `TmuxSpawnCoreConfig.persistent` — set in WorkerPool when task has persistentSessionKey
3. Fix stale WorkerState — create updated instance with new task and reset completionHandled
4. Validate crash recovery — test that session crash during iteration 2+ properly emits TaskFailed
5. Strip `AUTOBEAT_WORKER` from interactive session env

### High Priority (Before Merge)
6. Add defensive validation to `buildSetupShim()`
7. Extract `handleOrchestrateInteractive` into lifecycle phases
8. Unify tmux validation (use TmuxValidator in CLI path)
9. Make 300ms settle time configurable
10. Fix nested nesting in `spawn()` persistent check
11. Add test for concurrent reuse guard
12. Update stale JSDoc comments (3 locations)

### Medium Priority (Next Release)
- Test coverage for reuseSession failure paths
- Test factory cleanup mock completeness
- Event-driven wait instead of polling

---

## Cycle Status

**Cycle 1: Initial Review**
- 11 reviewers completed
- 20 issues identified
- 3 CRITICAL blocking issues
- 8 HIGH blocking issues
- 7 MEDIUM should-fix issues
- 2 pre-existing informational issues

**Next Steps**: Developer addresses blocking issues, submits fixes, re-review before merge.
