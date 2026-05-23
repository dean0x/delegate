# Code Review Summary

**Branch**: feat/180-phase-5-bootstrap-usage-parsing-cleanup -> main
**Date**: 2026-05-23
**Review Cycle**: 2

## Merge Recommendation: CHANGES_REQUESTED

**Reason**: Five HIGH-severity blocking issues must be resolved before merge. Four issues are HIGH (single reviewers or narrow consensus) that represent real functional regressions and type-safety violations. The double `as unknown as` cast for env stripping is flagged by 4/9 reviewers (85% confidence) and multiple approaches to fix are documented. The persistent session reuse lifecycle bugs are HIGH with 82% confidence and prevent the feature from working correctly. The orphaned worker state and callback interference is a 90% confidence CRITICAL reliability issue.

---

## Issue Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 5 | 6 | 0 |
| Should Fix | 0 | 0 | 6 | 0 |
| Pre-existing | 0 | 0 | 3 | 0 |

**Total Issues**: 20 (5 blocking, 6 should-fix, 3 informational, 6 pre-existing)

---

## Convergence Status

### Highly Convergent Issues (4+ reviewers)

| Issue | Reviewers | Confidence | Assessment |
|-------|-----------|------------|------------|
| Double `as unknown as` cast for env stripping | Architecture, Complexity, Consistency, TypeScript (4/9) | 85% | BLOCKING — Type safety violated, bypasses entire type boundary. Fix is straightforward: add `env` field to `TmuxSpawnCoreConfig` or use targeted intersection type. |
| Persistent session reuse may never execute in real lifecycle | Regression (1/9) | 82% | HIGH BLOCKING — Worker state cleaned up on completion before reuse can happen; tests call spawn back-to-back but real event-driven flow processes completion events first. Feature is currently dead code. |
| Orphaned worker state after sendKeys failure | Reliability (1/9) | 90% | HIGH BLOCKING — When `reuseSession` mutates state and then sendKeys fails, old worker timers become orphaned and can interfere with fresh spawn via stale callbacks. Affects correctness and reliability. |

### Moderate Convergence (2-3 reviewers)

| Issue | Reviewers | Confidence | Assessment |
|-------|-----------|------------|------------|
| Function parameter consolidation (spawnAndDeliverPrompt) | Complexity (1/9) | 85% | HIGH — 6 parameters, fifth is service objects; threshhold is 5+. Consolidate into context object. |
| Repeated teardown pattern (finalize+dispose+exit) | Complexity (1/9) | 82% | HIGH — 3 occurrences; extract `exitOnFailure` helper to reduce duplication. |
| Dead method `updateInteractiveOrchestrationPid` | Regression (1/9) | 85% | HIGH SHOULD-FIX — No callers; removes cognitive load. Remove from interface and implementation. |
| Flushing/heartbeat/timeout not restarted after reuse | Regression (1/9) | 82% | HIGH SHOULD-FIX — Session stops timers in completion flow but reuse path doesn't restart them. Output flushing, heartbeat, timeout all non-functional after iteration 1. |
| Handler function length and scope creep | Complexity (1/9) | 82% | MEDIUM SHOULD-FIX — `handleOrchestrateInteractive` is 176 lines; extract Phase 4 SIGINT+attach block to reduce to ~120 lines. |

### Single-Reviewer Issues (1 reviewer)

| Issue | Reviewer | Confidence | Assessment |
|-------|----------|------------|------------|
| Missing test for sendKeys failure in reuseSession | Testing (1/9) | 82% | MEDIUM BLOCKING — Two failure paths tested (`setEnvironment` fails), but `sendKeys` failure after successful env update is untested. |
| Flush interval stale entry not cleaned on reuse | Reliability (1/9) | 82% | MEDIUM SHOULD-FIX — `flushingInProgress` set retains old task ID after reuse; delete it to avoid spurious state conflicts. |
| WorkerState widens readonly to mutable | Architecture, TypeScript (2/9) | 82-83% | MEDIUM SHOULD-FIX — `taskId` and `task` should be replaced on reuse rather than mutated in place. LSP violation. |

---

## Blocking Issues

### CRITICAL

None.

### HIGH

#### 1. Persistent Session Reuse Dead Code (82% confidence)
**File**: `src/implementations/event-driven-worker-pool.ts:357-366`
**Reviewer**: Regression
**Status**: BLOCKING — Feature cannot work in real event-driven flow

- When a loop iteration completes, `onExit` fires `handleWorkerCompletion` → `cleanupWorkerState` removes worker from `this.workers` and `this.taskToWorker`.
- Loop handler processes `TaskCompleted`, creates new task, calls `spawn()`.
- By the time `reuseSession()` runs, `this.workers.get(workerId)` returns `undefined` — worker already cleaned.
- Function falls through to fresh spawn, making persistent session reuse dead code in real lifecycle.
- Tests call `spawn(task2)` immediately after `spawn(task1)` without simulating task1 completion, so tests pass but feature doesn't work.

**Fix**: Re-register worker in `this.workers` and `this.taskToWorker` when the WorkerState is missing but the tmux handle is alive. Or skip `cleanupWorkerState` for persistent sessions and let reuse re-animate the state. Or call `registerWorker()` internally in `reuseSession()` when existing state is missing.

#### 2. Orphaned Worker State After sendKeys Failure (90% confidence)
**File**: `src/implementations/event-driven-worker-pool.ts:387-396`
**Reviewer**: Reliability
**Status**: BLOCKING — Critical state corruption and callback interference

- `reuseSession()` mutates worker state (lines 373-385: `taskToWorker`, `taskIdRef`, `taskId`, `task`, `completionHandled`) **before** calling `sendKeys` on line 388.
- If `sendKeys` fails, `cleanupPersistentSession(key)` is called but the old `WorkerState` is NOT cleaned up from `this.workers` or its timers cleared.
- Old worker becomes an orphan:
  1. Its heartbeat timer fires every 30s, calling `workerRepository.updateHeartbeat()` for an unregistered worker, leaking resources.
  2. Destroyed session's `onExit` callback reads `taskIdRef.current` (now pointing to NEW task), resolves to new worker via `taskToWorker`, stops new worker's flush interval and heartbeat, calls `handleWorkerCompletion` with new task ID — potentially emitting spurious `TaskCompleted` or `TaskFailed` for the new task before it finishes.

**Fix**: Before returning `ok(null)` from sendKeys failure path, call `cleanupWorkerState(workerId, task.id)` to clear timers and remove from maps before destroying the session.

#### 3. Double `as unknown as` Cast Bypasses Type Safety (85% confidence)
**Files**: `src/cli/commands/orchestrate-interactive.ts:219-224`
**Reviewers**: Architecture, Complexity, Consistency, TypeScript (4/9)
**Status**: BLOCKING — Type-safety violation, silent runtime coupling

- Uses `rawTmuxConfig as unknown as { env?: Record<string, string> }` to access `env`, then casts back to `TmuxSpawnCoreConfig`.
- Only occurrence of `as unknown as` in `src/` directory — introduces non-standard pattern.
- If `TmuxSpawnCoreConfig` or its implementation-layer extension changes shape (rename `env`, change structure), code silently breaks at runtime with no compiler warning.
- Comment acknowledges type boundary is "intentionally opaque" but code bypasses it entirely.

**Fix**: 
- **Option 1**: Add `env` as optional field to `TmuxSpawnCoreConfig` (it's already populated by `buildTmuxCommand` at runtime)
- **Option 2**: Use targeted intersection type instead of double-cast through `unknown`:
  ```typescript
  interface TmuxConfigWithEnv extends TmuxSpawnCoreConfig {
    env?: Record<string, string>;
  }
  const configWithEnv = rawTmuxConfig as TmuxConfigWithEnv;
  const tmuxConfig: TmuxSpawnCoreConfig = configWithEnv.env
    ? { ...configWithEnv, env: Object.fromEntries(...) }
    : rawTmuxConfig;
  ```
- **Option 3**: Add method like `buildTmuxCommandForInteractive()` that returns config with `AUTOBEAT_WORKER` already stripped

#### 4. spawnAndDeliverPrompt Parameter Overload (85% confidence)
**File**: `src/cli/commands/orchestrate-interactive.ts:181-188`
**Reviewer**: Complexity
**Status**: BLOCKING — Parameter count exceeds complexity threshold

- Function takes 6 parameters: `tmuxConnector`, `adapter`, `orchestration`, `orchestrationService`, `container`, `params` (plus `userPrompt`, `systemPrompt`, `sessionsDir` inside params).
- Five of six are service-level objects unpacked from caller and passed individually.
- Complexity threshold for parameters is 5+.

**Fix**: Consolidate services into single context object:
```typescript
interface SpawnPromptContext {
  readonly tmuxConnector: TmuxConnectorPort;
  readonly adapter: AgentAdapter;
  readonly orchestration: Orchestration;
  readonly orchestrationService: OrchestrationService;
  readonly container: Container;
  readonly userPrompt: string;
  readonly systemPrompt: string | undefined;
  readonly sessionsDir: string;
}
```

#### 5. Repeated Finalize+Dispose+Exit Teardown (82% confidence)
**File**: `src/cli/commands/orchestrate-interactive.ts:200-206, 249-255, 263-270`
**Reviewer**: Complexity
**Status**: BLOCKING — Code duplication, maintenance risk

- Three error branches repeat identical 3-line teardown: `orchestrationService.finalizeInteractiveOrchestration(...)` + `container.dispose()` + `process.exit(1)`.
- Each copy is maintenance risk if teardown sequence changes.

**Fix**: Extract local helper:
```typescript
async function exitOnFailure(msg: string): never {
  ui.error(msg);
  await orchestrationService.finalizeInteractiveOrchestration(orchestration.id, {
    exitCode: null, cancelled: false,
  });
  await container.dispose();
  process.exit(1);
}
```

---

## Should-Fix Issues (Same File, Related to Changes)

### MEDIUM

#### 1. Flushing/Heartbeat/Timeout Not Restarted After Reuse (82% confidence)
**File**: `src/implementations/event-driven-worker-pool.ts:310-406`
**Reviewer**: Regression
**Status**: HIGH SHOULD-FIX

- When `reuseSession()` succeeds, caller returns immediately without `launchAndRegister()` which calls `startFlushing()`, `setupHeartbeatForWorker()`, `setupTimeoutForWorker()`.
- If previous iteration's completion already called `stopFlushing()` (normal flow), reused session has no output flushing, no heartbeat updates, no timeout enforcement.
- Output flushed only on exit, heartbeat stops (recovery manager may flag stale), timeouts not enforced for subsequent iterations.

**Fix**: After successful reuse block (line 383-385), restart timers:
```typescript
this.setupTimeoutForWorker(existingWorker);
this.setupHeartbeatForWorker(existingWorker);
this.startFlushing(existingWorker);
```

#### 2. Dead Method `updateInteractiveOrchestrationPid` (85% confidence)
**File**: `src/core/interfaces.ts:893`
**Reviewer**: Regression
**Status**: HIGH SHOULD-FIX

- Method documented as "pre-Phase 5 legacy path" but has zero callers.
- Interactive orchestrator exclusively uses `updateInteractiveOrchestrationSessionName`.
- Remains in `OrchestrationService` interface and `orchestration-manager.ts` implementation.
- Applies PF-001 (don't defer cleanup to future PR).

**Fix**: Remove `updateInteractiveOrchestrationPid` from interface and implementation. No external consumers (internal interface).

#### 3. WorkerState Widens Readonly to Mutable (82-83% confidence)
**File**: `src/implementations/event-driven-worker-pool.ts:77-84`
**Reviewers**: Architecture, TypeScript
**Status**: HIGH SHOULD-FIX

- `Worker.taskId` is readonly; `WorkerState` re-declares as mutable for `reuseSession()` to overwrite.
- Violates LSP — code holding `Worker` reference doesn't expect `taskId` to change after construction.
- `handleWorkerCompletion`, `handleWorkerTimeout`, etc. read `worker.taskId` and assume stability.

**Fix**: Keep `taskId` readonly. In `reuseSession()`, create new `WorkerState` object with updated fields and replace in `workers` map instead of mutating in place.

#### 4. Flush Interval Stale Entry Not Cleaned on Reuse (82% confidence)
**File**: `src/implementations/event-driven-worker-pool.ts:723-736`
**Reviewer**: Reliability
**Status**: MEDIUM SHOULD-FIX

- Flush interval closure reads `worker.taskId` on each tick (correctly picks up updated ID after reuse).
- `flushingInProgress` set keyed by `TaskId` is NOT cleaned up on reuse.
- If flush in-flight for old task ID when reuse changes `worker.taskId`, next tick uses new task ID which is not in set.

**Fix**: After updating task ID in `reuseSession()`, clean up stale entry:
```typescript
existingWorker.taskId = task.id;
this.flushingInProgress.delete(prevTaskId);
```

#### 5. Missing Test: sendKeys Failure Fallback (82% confidence)
**File**: `src/implementations/event-driven-worker-pool.ts:388-397`
**Reviewer**: Testing
**Status**: MEDIUM BLOCKING

- `reuseSession` has failure path when `sendKeys` fails after `/clear` and env updates succeed.
- Existing test only covers `setEnvironment` failure path.
- `sendKeys` failure after successful env update is untested.

**Fix**: Add test for sendKeys failure triggering session destruction and fresh spawn.

#### 6. Handler Function Length (82% confidence)
**File**: `src/cli/commands/orchestrate-interactive.ts:280-456`
**Reviewer**: Complexity
**Status**: MEDIUM SHOULD-FIX

- `handleOrchestrateInteractive` is 176 lines covering TTY check, tmux validation, bootstrap, orchestration creation, session spawning, SIGINT handling, attach, finalize, cleanup, exit (16 responsibilities).
- Phase 4 block (lines 370-449) covering SIGINT + attach + finalize could be extracted into `attachAndFinalize()`.

**Fix**: Extract Phase 4 to bring main handler under 120 lines.

---

## Pre-existing Issues (Not Blocking)

### MEDIUM

1. **`event-driven-worker-pool.ts` is 1021 lines** (Complexity, 90% confidence) — File exceeds 500-line critical threshold; consider extracting persistent session reuse logic into `PersistentSessionManager`.

2. **`resolveContainerDeps` calls `process.exit(1)` but return type is `| null`** (Consistency, 65% confidence) — `null` return is unreachable; type lie for callers.

3. **`spawnAndDeliverPrompt` has same `process.exit` + `null` return pattern** (TypeScript, 65% confidence) — Same issue; dead code at call site.

---

## Test Coverage Assessment

✅ **Strengths**:
- 7 new regression tests for persistent session reuse (stale closure, completionHandled reset, concurrent guard)
- `buildPersistentTask` helper keeps test setup clean
- MockFactory.workerPool correctly updated with `cleanupPersistentSession`
- Bootstrap proxy integration tests inject mock tmux connector

❌ **Gaps**:
- sendKeys failure after /clear success not tested (blocking)
- `buildSetupShim` defense-in-depth validation not tested (no tmux-hooks test file exists)
- Extracted functions (`validateTmux`, `resolveContainerDeps`, `spawnAndDeliverPrompt`) not unit tested

---

## Quality Assessment

| Dimension | Score | Notes |
|-----------|-------|-------|
| Architecture | 7/10 | Solid refactoring; HIGH blocker is leaky abstraction (double cast). TaskIdRef pattern well-designed. |
| Complexity | 7/10 | Reduced vs. pre-PR; parameter overload and 3x teardown duplication are fixable. |
| Consistency | 8/10 | Error handling and Result types solid; double cast introduces non-standard pattern. |
| Performance | 9/10 | Promise.race polling replacement is improvement; TaskIdRef avoids closure churn. |
| Regression | 6/10 | Dead code in lifecycle + timing issues with reuse/flushing significantly impact feature viability. |
| Reliability | 7/10 | Orphaned worker state is a serious reliability issue that requires pre-merge fix. |
| Security | 9/10 | No security issues; shell injection, secrets handling, TOCTOU all handled correctly. |
| Testing | 8/10 | Regression tests thorough; one blocking gap (sendKeys failure). |
| TypeScript | 7/10 | One HIGH blocking issue (double cast); rest solid. |

**Overall**: 7.2/10 — Well-intentioned feature with sound design patterns but significant blocking issues that prevent merge. The persistent session reuse feature is currently non-functional in the real event-driven lifecycle, and critical state corruption bugs must be resolved first.

---

## Action Plan

### Pre-merge (Must Fix)

1. **Fix persistent session lifecycle** — Re-register worker or skip cleanup for persistent sessions so reuse actually happens in real flow.
2. **Fix orphaned worker state** — Call `cleanupWorkerState` when sendKeys fails to prevent callback interference.
3. **Fix double-cast env stripping** — Add `env` field to `TmuxSpawnCoreConfig` or use targeted intersection type.
4. **Consolidate spawnAndDeliverPrompt parameters** — Move to context object pattern.
5. **Extract repeated teardown** — Create `exitOnFailure` helper.
6. **Add sendKeys failure test** — Cover both send paths in `reuseSession` error case.

### Strongly Recommended (Should Fix)

7. Restart flushing/heartbeat/timeout after reuse
8. Remove dead `updateInteractiveOrchestrationPid` method
9. Replace WorkerState mutable widening with new-object pattern
10. Clean up stale `flushingInProgress` entry on reuse
11. Extract Phase 4 SIGINT+attach block to reduce handler length

### Follow-up (Not Blocking)

- Extract persistent session logic into `PersistentSessionManager` class
- Add unit tests for extracted CLI functions
- Resolve pre-existing `| null` type lies in orchestrator handlers

