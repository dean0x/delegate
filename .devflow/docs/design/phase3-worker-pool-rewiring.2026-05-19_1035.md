# Phase 3: Worker Pool Rewiring — Implementation Plan

## Context

Autobeat's worker pool currently spawns agents via `ProcessConnector` (child processes with piped stdio). Anthropic is metering programmatic Claude usage starting June 15, 2026. Phase 3 replaces the entire process-spawning model with tmux-based session management inside `EventDrivenWorkerPool`.

**Phases 1-2 are merged**: tmux abstraction layer (#176) and agent adapter migration (#177). Phase 3 is the critical rewiring that makes workers actually run in tmux sessions.

**Issue**: #178 — 10 acceptance criteria, all specific and testable.

## Gap Analysis Summary

7 blocking gaps identified and resolved in this plan:
- B1: `Worker.pid` has no tmux semantic → store 0 as sentinel
- B2: RecoveryManager PID liveness breaks → add session-based check (minimal scope)
- B3: `sessionsDir` has no source → add to Configuration + bootstrap
- B4: `TmuxConnectorPort` in wrong layer → move to `core/tmux-types.ts`
- B5: Output routing unspecified → onOutput → OutputCapture.capture() + final flush before completion
- B6: Kill semantics mismatch → sendControlKeys(C-c) → poll 5s → destroy
- B7: Bootstrap wiring missing → register full tmux component chain

6 additional gaps found in deep review:
- G1: Final flush before completion — onExit must flush + clear OutputCapture before TaskCompleted/TaskFailed event
- G2: Double-completion guard — `completionHandled` flag in worker pool prevents race between onExit and kill()
- G3: Backpressure guard on periodic flush — `flushingInProgress` Set prevents overlapping flushes
- G4: sendKeys literal mode — `-l` flag sends "C-c" as text, not Ctrl+C; `sendControlKeys` is critical
- G5: SESSION_NAME_REGEX/TASK_ID_REGEX latent mismatch — UUIDs work, but underscores in TASK_ID_REGEX aren't allowed in SESSION_NAME_REGEX; document
- G6: Shutdown hooks already exist — `src/index.ts:86` calls `killAll()` on SIGINT/SIGTERM; no new hook needed

## Design Decisions (User-Confirmed)

1. **Heartbeat** → DB write + isAlive check. 30s interval writes heartbeat AND calls `tmuxConnector.isAlive()`. If session is dead, triggers `handleWorkerCompletion()` immediately (belt and suspenders alongside TmuxConnector staleness timer).
2. **Shutdown** → Existing `killAll()` in `src/index.ts` is sufficient. Phase 3 adds `tmuxConnector.dispose()` at end of `killAll()` as safety net.
3. **Recovery scope** → Minimal: add `TmuxSessionManagerPort` dep, session liveness check when `sessionName` is populated. Full recovery rewrite deferred to Phase 4.

## Implementation Steps

### Step 1: DB Migration v29 + Domain Type Update

Add `session_name TEXT` column to `workers` table. Add `sessionName?: string` to `WorkerRegistration` domain type. Update worker repository to persist/retrieve the new field.

**Files:**
- `src/implementations/database.ts` — migration v29: `ALTER TABLE workers ADD COLUMN session_name TEXT` + index
- `src/core/domain.ts:152-160` — add `readonly sessionName?: string` to WorkerRegistration
- `src/implementations/worker-repository.ts` — schema, INSERT, row mapping

**Tests (RED first):**
- `tests/unit/implementations/worker-repository.test.ts` — persist/retrieve sessionName, handle null from pre-Phase 3 rows

### Step 2: Add `sessionsDir` to Configuration

Add optional `sessionsDir` field to ConfigurationSchema. Bootstrap computes default as `path.join(dataDir, 'sessions')` and registers it in the container.

**Files:**
- `src/core/configuration.ts:~40` — add `sessionsDir: z.string().optional()`
- `src/bootstrap.ts` — compute default from DB path parent dir, register as container value
- `src/implementations/database.ts` — add `getPath(): string` if missing (returns `this.dbPath`)

### Step 3: Move Consumer-Facing Tmux Types to Core + sendControlKeys

Create `src/core/tmux-types.ts` with types that core-layer code needs:
- `TmuxConnectorPort`, `TmuxHandle`, `TmuxSpawnConfig`, `SpawnCallbacks`, `OutputMessage`, `TmuxSessionManagerPort`

Re-export from `src/implementations/tmux/types.ts` for backward compatibility. Update `agents.ts` import path.

Internal types (`WrapperConfig`, `WrapperManifest`, `StalenessConfig`, `WatchFn`, `ExecFn`, etc.) stay in `tmux/types.ts`.

**New method: `sendControlKeys`** — Add to both `TmuxConnectorPort` and `TmuxSessionManagerPort`. Sends keys WITHOUT `-l` (literal mode), needed for Ctrl+C in kill flow. Critical because existing `sendKeys` uses `-l`, which would send the literal text "C-c" instead of the control character.

```typescript
// TmuxSessionManagerPort
sendControlKeys(name: string, keys: string): Result<void, AutobeatError>;
// Implementation: tmux send-keys -t '${name}' ${keys}  (no -l flag)

// TmuxConnectorPort
sendControlKeys(handle: TmuxHandle, keys: string): Result<void, AutobeatError>;
// Delegates to sessionManager.sendControlKeys(handle.sessionName, keys)
```

**Files:**
- `src/core/tmux-types.ts` — NEW file
- `src/implementations/tmux/types.ts` — re-export moved types, add sendControlKeys to ports
- `src/implementations/tmux/tmux-session-manager.ts` — implement sendControlKeys (same as sendKeys but without `-l`)
- `src/implementations/tmux/tmux-connector.ts` — implement sendControlKeys (delegate to session manager)
- `src/core/agents.ts:15` — update import path + remove TEMPORARY comment
- `tests/unit/implementations/tmux/tmux-session-manager.test.ts` — test sendControlKeys
- `tests/unit/implementations/tmux/tmux-connector.test.ts` — test sendControlKeys

### Step 4: Rewrite WorkerState + EventDrivenWorkerPoolDeps

**WorkerState changes:**
- `process: ChildProcess` → `handle: TmuxHandle`
- Add `flushInterval?: NodeJS.Timeout` (replaces ProcessConnector's flush)
- Add `completionHandled: boolean` — guards against double completion (G2)

**EventDrivenWorkerPoolDeps changes:**
- Add `tmuxConnector: TmuxConnectorPort` (injected, fixes DI violation)
- Add `sessionsDir: string`
- Keep `outputCapture`, `outputRepository`, `outputFlushIntervalMs` (for output routing)
- Remove `ProcessConnector` construction from constructor

**New private methods:**

`createCallbacks(taskId)` — builds `SpawnCallbacks`:
```typescript
private createCallbacks(taskId: TaskId): SpawnCallbacks {
  return {
    onOutput: (msg: OutputMessage) => {
      // Map 'result' to 'stdout' (OutputCapture only accepts 'stdout' | 'stderr')
      const captureType: 'stdout' | 'stderr' = msg.type === 'stderr' ? 'stderr' : 'stdout';
      this.outputCapture.capture(taskId, captureType, msg.content);
    },
    onExit: (code: number | null, _signal?: string) => {
      // G1: Final flush BEFORE completion event (mirrors ProcessConnector.safeOnExit)
      this.stopFlushing(taskId);
      this.flushOutput(taskId)
        .catch((e) => this.logger.error('Final flush failed', toError(e), { taskId }))
        .finally(() => {
          this.outputCapture.clear(taskId); // Free buffer memory
          this.handleWorkerCompletion(taskId, code ?? 0);
        });
    },
  };
}
```

Output flush methods with backpressure guard (G3):
```typescript
private readonly flushingInProgress = new Set<TaskId>();

private startFlushing(worker: WorkerState): void {
  const interval = setInterval(() => {
    if (this.flushingInProgress.has(worker.taskId)) return; // G3: backpressure
    this.flushingInProgress.add(worker.taskId);
    this.flushOutput(worker.taskId)
      .catch((e) => this.logger.error('Periodic flush failed', toError(e), { taskId: worker.taskId }))
      .finally(() => this.flushingInProgress.delete(worker.taskId));
  }, this.outputFlushIntervalMs);
  interval.unref();
  worker.flushInterval = interval;
}

private stopFlushing(taskIdOrWorker: TaskId | WorkerState): void {
  // Clear interval + remove from backpressure set
}

private async flushOutput(taskId: TaskId): Promise<void> {
  const outputResult = this.outputCapture.getOutput(taskId);
  if (!outputResult.ok || outputResult.value.totalSize === 0) return;
  await this.outputRepository.save(taskId, outputResult.value);
}
```

**Remove imports:** `ChildProcess` from `child_process`, `ProcessConnector` from `services/`
**Add imports:** `TmuxConnectorPort`, `TmuxHandle`, `OutputMessage` from `core/tmux-types`

**File:** `src/implementations/event-driven-worker-pool.ts`

### Step 5: Rewrite spawn() + registerWorker()

**New spawn flow (10 steps):**
1. Guard: task.agent must be set
2. Resource check: monitor.canSpawnWorker()
3. Resolve adapter: agentRegistry.get(agentProvider)
4. Build tmux config: `adapter.buildTmuxCommand({ ...options, sessionsDir })`
5. Create callbacks: `this.createCallbacks(task.id)`
6. Spawn session: `tmuxConnector.spawn(config, callbacks)`
7. Register worker: `registerWorker(task, handle, agentProvider, cleanupFn)`
8. Setup timeout + heartbeat
9. Start flushing
10. Send prompt: `tmuxConnector.sendKeys(handle, prompt + '\n')`

On sendKeys failure at step 10: destroy session, cleanup worker state, return error.

**registerWorker() changes:**
- WorkerId: `worker-beat-${task.id}` (AC #3)
- Worker.pid: 0 (sentinel — tmux sessions have no single meaningful PID)
- WorkerRegistration: pid=0, ownerPid=process.pid, sessionName=handle.sessionName
- Rollback on UNIQUE violation: `tmuxConnector.destroy(handle)` instead of `childProcess.kill('SIGTERM')`

**File:** `src/implementations/event-driven-worker-pool.ts`

### Step 6: Rewrite kill() + killAll() + cleanup + heartbeat

**kill() — AC #4 three-step sequence:**
1. Clear timeout, stop flushing, final flush
2. Check isAlive — if dead, skip to cleanup
3. `tmuxConnector.sendControlKeys(handle, 'C-c')` — graceful interrupt
4. Poll `isAlive()` every 250ms for up to 5s (max 20 iterations — bounded loop)
5. If still alive: `tmuxConnector.destroy(handle)` — force kill
6. `cleanupWorkerState()` — DB unregister, adapter cleanup, decrement monitor

**Double-completion guard (G2):** `handleWorkerCompletion` checks `worker.completionHandled` flag. If already true, log and return. Set true before proceeding. Prevents race between onExit callback and explicit kill() calling cleanupWorkerState.

**killAll():**
- `Promise.allSettled` over individual `kill()` calls (unchanged pattern)
- After all kills: `tmuxConnector.dispose()` as safety net (catches orphaned sessions)

**cleanupWorkerState():**
- Clear heartbeat timer + flush interval
- Delete from maps, decrement monitor
- Unregister from DB
- Call adapter cleanupFn if present (system prompt temp files)
- TmuxConnector.destroy() already calls hooks.cleanup() internally for wrapper/session dir

**Heartbeat (user-confirmed: DB write + isAlive):**
```typescript
private setupHeartbeatForWorker(worker: WorkerState): void {
  const timer = setInterval(() => {
    // 1. Write heartbeat to DB (for RecoveryManager)
    this.workerRepository.updateHeartbeat(worker.id);
    // 2. Check tmux session liveness (AC #5)
    const aliveResult = this.tmuxConnector.isAlive(worker.handle);
    if (aliveResult.ok && !aliveResult.value) {
      this.logger.warn('Heartbeat detected dead tmux session', {
        workerId: worker.id, taskId: worker.taskId,
        sessionName: worker.handle.sessionName,
      });
      this.handleWorkerCompletion(worker.taskId, 1);
    }
  }, 30_000);
  timer.unref();
  worker.heartbeatTimer = timer;
}
```

**File:** `src/implementations/event-driven-worker-pool.ts`

### Step 7: Update RecoveryManager (Minimal Scope)

Add optional `TmuxSessionManagerPort` dependency. When a worker registration has `sessionName` populated, use `sessionManager.isAlive(sessionName)` as secondary liveness check (alongside existing ownerPid check). Full recovery rewrite deferred to Phase 4.

Flow:
- ownerPid dead → clean up (existing, unchanged)
- ownerPid alive + sessionName populated + session dead → clean up (new)
- No sessionName → skip session check (backward compat with pre-Phase 3 rows)

**Files:**
- `src/services/recovery-manager.ts` — add `tmuxSessionManager?: TmuxSessionManagerPort` dep, update cleanDeadWorkerRegistrations
- `src/services/orchestration-liveness.ts` — add session check to liveness chain (if applicable)

### Step 8: Wire Tmux Components in Bootstrap

Register in order: TmuxValidator → TmuxSessionManager → TmuxHooks → TmuxConnector. All singletons.

Eager validation: in server/run modes (not CLI), validate tmux at startup. Missing tmux binary = fail-fast error with actionable message.

Update workerPool registration to inject `tmuxConnector` + `sessionsDir`.
Update recoveryManager registration to inject `tmuxSessionManager`.

**Surviving components (not touched):**
- `AgentAdapter.spawn()` — still used by interactive orchestrator (`beat orchestrate --foreground`)
- `AgentAdapter.spawnInteractive()` — still used by interactive orchestrator
- `ProcessConnector` — file remains, just no longer imported by worker pool
- `ProcessSpawnerAdapter` — test shim remains
- AC #10 is scoped to worker pool file only

**File:** `src/bootstrap.ts`

### Step 9: Rewrite Worker Pool Tests

Full rewrite of test file. Create `MockTmuxConnector` with helpers:
- `_simulateExit(taskId, code)` — triggers onExit callback
- `_simulateOutput(taskId, msg)` — triggers onOutput callback
- All port methods are vi.fn() returning ok()

Update CLAUDE.md: document migration v29 in Database section.

**Files:**
- `tests/unit/implementations/event-driven-worker-pool.test.ts` — full rewrite
- Integration tests: guard with `hasTmux` check
- `CLAUDE.md` — add migration v29 documentation

---

## Acceptance Criteria (Structured)

### Functional Requirements

| ID | Criterion | Verification Method |
|----|-----------|-------------------|
| AC-1 | EventDrivenWorkerPool uses TmuxConnectorPort instead of ProcessConnector | Typecheck: no `ProcessConnector` import in file. Unit test: spawn() calls tmuxConnector.spawn() |
| AC-2 | WorkerState has `handle: TmuxHandle` instead of `process: ChildProcess` | Typecheck: no `ChildProcess` import. Unit test: worker.handle.sessionName is set |
| AC-3 | Worker ID follows `worker-beat-{taskId}` format | Unit test: `spawn()` returns worker with id matching pattern. Regex assertion |
| AC-4 | Kill sends C-c via `sendControlKeys`, waits up to 5s, then force-destroys | Unit test: verify sendControlKeys called, then isAlive polled, then destroy called after timeout |
| AC-5 | Heartbeat calls `isAlive()` every 30s; triggers cleanup if session dead | Unit test with fake timers: advance 30s, verify isAlive called, mock dead → verify handleWorkerCompletion |
| AC-6 | Spawn flow: buildTmuxCommand → spawn → register → sendKeys(prompt) | Unit test: verify call sequence on mock. Verify prompt delivered via sendKeys not spawn args |
| AC-7 | Output flows: onOutput → OutputCapture.capture() with correct type mapping | Unit test: simulate OutputMessage with type 'result', verify capture called with 'stdout'. Same for 'stderr' |
| AC-8 | onExit callback fires → final flush → outputCapture.clear → handleWorkerCompletion | Unit test: simulate exit, verify flush called before TaskCompleted event emission |
| AC-9 | killAll() destroys all sessions + calls tmuxConnector.dispose() | Unit test: 3 workers spawned, killAll(), verify all destroyed, dispose called |
| AC-10 | No `ChildProcess` or `ProcessConnector` references in event-driven-worker-pool.ts | Grep assertion: `grep -c 'ChildProcess\|ProcessConnector' src/implementations/event-driven-worker-pool.ts` = 0 |

### API Contract Requirements

| ID | Contract | Verification |
|----|----------|-------------|
| API-1 | `WorkerPool` interface unchanged (spawn, kill, killAll, getWorker, getWorkers, getWorkerCount, getWorkerForTask) | Typecheck: EventDrivenWorkerPool still implements WorkerPool |
| API-2 | `Worker.pid` = 0 for tmux workers (type stays `number`, no breaking change) | Unit test: spawned worker has pid === 0 |
| API-3 | `WorkerRegistration.sessionName` is optional string (backward compat) | Unit test: register with sessionName, verify DB round-trip. Verify null for pre-Phase 3 rows |
| API-4 | `EventDrivenWorkerPoolDeps` requires `tmuxConnector` and `sessionsDir` | Typecheck: compile error if omitted from deps |
| API-5 | `TmuxConnectorPort` moved to `core/tmux-types.ts`, re-exported from `tmux/types.ts` | Import test: both paths resolve to same type. Typecheck passes |
| API-6 | `sendControlKeys` added to TmuxConnectorPort and TmuxSessionManagerPort | Typecheck: method exists on interface. Unit test: sends without `-l` flag |
| API-7 | `OutputCapture.capture()` interface unchanged — no new methods or params | Typecheck: no changes to OutputCapture interface |
| API-8 | `AgentAdapter.spawn()` and `AgentAdapter.spawnInteractive()` unchanged | Typecheck: interactive orchestrator still compiles |

### Edge Case & Reliability Requirements

| ID | Scenario | Verification |
|----|----------|-------------|
| EC-1 | Double completion: onExit fires after kill() already cleaned up | Unit test: simulate kill + delayed onExit, verify no crash, no double event emission |
| EC-2 | sendKeys failure during spawn step 10 | Unit test: mock sendKeys to return err, verify session destroyed and worker cleaned up |
| EC-3 | Register UNIQUE violation (duplicate task) | Unit test: mock register to return err, verify tmuxConnector.destroy() called (not childProcess.kill) |
| EC-4 | Kill on already-dead session | Unit test: mock isAlive to return false, verify sendControlKeys NOT called, cleanup still runs |
| EC-5 | Periodic flush backpressure | Unit test: mock flushOutput to be slow, advance timer twice, verify second flush skipped |
| EC-6 | Graceful shutdown with no workers | Unit test: killAll() on empty pool returns ok, dispose still called |
| EC-7 | OutputMessage with type 'result' | Unit test: onOutput routes to outputCapture.capture(taskId, 'stdout', content) |
| EC-8 | onExit with null code (DESTROYED/STALE signal) | Unit test: onExit(null, 'DESTROYED') → handleWorkerCompletion(taskId, 0) |
| EC-9 | Heartbeat detects dead session | Unit test: heartbeat fires, isAlive returns false, verify handleWorkerCompletion called with exit code 1 |
| EC-10 | Recovery: pre-Phase 3 worker rows (no sessionName) | Unit test: RecoveryManager skips session check, falls back to ownerPid check |

### Performance Requirements

| ID | Requirement | Verification |
|----|------------|-------------|
| PERF-1 | Kill polling bounded at 20 iterations (5s / 250ms) | Code review: while loop has explicit counter. Unit test: verify max 20 isAlive calls |
| PERF-2 | Heartbeat isAlive is one `tmux has-session` call (< 50ms typical) | Benchmark: measure isAlive latency in integration test |
| PERF-3 | Periodic flush backpressure prevents concurrent DB writes | Unit test: EC-5 above |
| PERF-4 | killAll parallelism preserved (Promise.allSettled) | Code review: same pattern as before |
| PERF-5 | No unbounded loops or recursive calls | Code review: all loops have explicit max-iteration guards |

---

## Test Plan

### Unit Tests — event-driven-worker-pool.test.ts (Full Rewrite)

**Mock Infrastructure:**
```typescript
// MockTmuxConnector: vi.fn() for all TmuxConnectorPort methods
// _simulateExit(taskId, code) — triggers stored onExit callback
// _simulateOutput(taskId, msg) — triggers stored onOutput callback
// Reuse: createMockLogger(), createMockWorkerRepository(), createMockOutputRepository() from fixtures
```

**Test Categories (30+ test cases):**

1. **Spawn success path** (5 tests)
   - Happy path: returns Worker with correct id, pid=0, taskId
   - WorkerId format: `worker-beat-{taskId}` regex match
   - Spawn sequence: buildTmuxCommand → spawn → register → sendKeys verified via mock call order
   - sessionName persisted in WorkerRegistration
   - flushInterval and heartbeatTimer started

2. **Spawn failure paths** (5 tests)
   - No agent assigned → WORKER_SPAWN_FAILED
   - Resource exhaustion → INSUFFICIENT_RESOURCES
   - Adapter buildTmuxCommand error → propagated
   - TmuxConnector.spawn error → propagated
   - sendKeys error → session destroyed, worker cleaned up, error returned

3. **Kill sequence** (5 tests)
   - sendControlKeys('C-c') called first (not sendKeys with '-l')
   - After 5s timeout: isAlive returns true → destroy called
   - After 2s: isAlive returns false → destroy NOT called
   - Already-dead session: sendControlKeys NOT called, cleanup still runs
   - Unknown worker → WORKER_NOT_FOUND error

4. **Completion via onExit** (5 tests)
   - Exit code 0 → TaskCompleted event emitted
   - Exit code non-zero → TaskFailed event emitted
   - Null code → maps to 0 (TaskCompleted)
   - Final flush called BEFORE event emission (flush → clear → event)
   - Double completion guard: second onExit call is no-op

5. **Output routing** (3 tests)
   - OutputMessage type 'stdout' → capture('stdout', content)
   - OutputMessage type 'stderr' → capture('stderr', content)
   - OutputMessage type 'result' → capture('stdout', content)

6. **Timeout** (3 tests)
   - Timeout fires → kill() called
   - Timeout cleared on natural completion
   - No timeout set for undefined/0/negative timeout values

7. **Heartbeat** (3 tests)
   - Fires at 30s interval, calls updateHeartbeat AND isAlive
   - Dead session detected → handleWorkerCompletion called
   - Timer cleared on kill/completion

8. **Flush lifecycle** (3 tests)
   - Started on spawn, stopped on kill
   - Final flush before kill event emission
   - Backpressure: concurrent flush skipped

9. **killAll + shutdown** (3 tests)
   - All workers killed in parallel
   - tmuxConnector.dispose() called after kills
   - Empty pool: returns ok, dispose still called

10. **Register rollback** (2 tests)
    - UNIQUE violation → destroy(handle) called (not SIGTERM)
    - Worker maps cleaned up on rollback

### Unit Tests — worker-repository.test.ts (Additions)

- Register with sessionName → round-trip retrieval
- Register without sessionName → null in DB, undefined in domain
- Pre-Phase 3 rows (no session_name column value) → backward compat

### Unit Tests — tmux-session-manager.test.ts (Additions)

- sendControlKeys: sends `tmux send-keys -t '...' C-c` WITHOUT `-l` flag
- sendControlKeys: validates session name
- sendControlKeys: returns error on failure

### Unit Tests — tmux-connector.test.ts (Additions)

- sendControlKeys: delegates to sessionManager.sendControlKeys
- sendControlKeys: validates handle

### Unit Tests — recovery-manager.test.ts (Additions)

- Worker with sessionName + dead session → cleaned up
- Worker with sessionName + alive session → kept
- Worker without sessionName → falls back to ownerPid check (unchanged)
- TmuxSessionManager not injected (optional dep) → skips session check

### Integration Tests — worker-pool-management.test.ts (Guarded)

```typescript
const hasTmux = spawnSync('which', ['tmux']).status === 0;
describe.skipIf(!hasTmux)('Worker pool with tmux', () => { ... });
```

- Spawn creates a real tmux session (visible via `tmux ls`)
- Kill sends C-c and session exits
- Server shutdown destroys all beat-* sessions

### Manual Verification Checklist

- [ ] `beat run "echo hello" --agent claude` creates tmux session visible in `tmux ls`
- [ ] `tmux ls` shows `beat-task-*` session during execution
- [ ] `beat cancel <taskId>` sends C-c, session exits gracefully within 5s
- [ ] Task output appears in `beat logs <taskId>` (output routing works)
- [ ] After server shutdown (`Ctrl+C`): `tmux ls` shows no `beat-*` sessions
- [ ] After server crash (kill -9): restart detects dead sessions via RecoveryManager
- [ ] `beat run` with `--system-prompt "..."` creates + cleans up temp file (adapter cleanup)
- [ ] Multiple concurrent tasks: each gets own tmux session, no interference

---

## Design Review Notes

- Kill polling loop: bounded at 20 iterations (5s / 250ms) — satisfies reliability rules
- `sendControlKeys` is new on two interfaces — needs tests in tmux-session-manager.test.ts and tmux-connector.test.ts
- `AgentAdapter.spawn()` and `ProcessConnector` survive — not touched, used by interactive orchestrator
- AC #10 scoped to worker pool file only — no ChildProcess/ProcessConnector imports remain there
- Final flush ordering mirrors ProcessConnector.safeOnExit: flush → clear → onExit (G1)
- Double-completion guard mirrors ProcessConnector.exitHandled flag (G2)
- Backpressure guard mirrors ProcessConnector.flushingInProgress Set (G3)
- SESSION_NAME_REGEX allows `[a-z0-9-]`, TASK_ID_REGEX allows `[a-z0-9_-]` — UUIDs have no underscores so this works, but document the latent mismatch (G5)

## Verification

```bash
# Type check
npm run typecheck

# Lint
npm run check

# Build
npm run build

# Grouped tests (safe in Claude Code)
npm run test:core && npm run test:handlers && npm run test:services && \
  npm run test:repositories && npm run test:adapters && \
  npm run test:implementations && npm run test:cli && \
  npm run test:integration

# Grep assertion (AC #10)
grep -c 'ChildProcess\|ProcessConnector' src/implementations/event-driven-worker-pool.ts
# Expected: 0

# Manual verification
beat run "echo hello" --agent claude  # Should create tmux session
tmux ls                                # Should show beat-task-* session
beat cancel <taskId>                   # Should send C-c, session exits
# After server shutdown:
tmux ls                                # Should show no beat-* sessions
```

## PR Description Guidance

**Problem Being Solved**: Workers run as child processes (piped stdio), which will be metered starting June 15. Tmux sessions avoid this metering model and enable richer agent interaction.

**Key Changes**: EventDrivenWorkerPool uses injected TmuxConnectorPort. Workers identified by tmux session name, not PID. Kill sequence is C-c → grace period → force-destroy. Output routing preserved through existing OutputCapture interface. Heartbeat detects dead sessions via isAlive().

**Breaking Changes**: WorkerRegistration.pid is 0 for tmux workers. WorkerId format changed from `worker-{pid}` to `worker-beat-{taskId}`. EventDrivenWorkerPoolDeps interface changed (tmuxConnector + sessionsDir added). Requires tmux >= 3.0 installed.

**Reviewer Focus Areas**:
1. `kill()` polling loop — bounded at 20 iterations, uses `sendControlKeys` (not `sendKeys`)
2. Output routing — onOutput callback maps OutputMessage types correctly, final flush before completion event
3. Recovery manager — session-based liveness alongside PID checks, minimal scope
4. Bootstrap — tmux validation is eager in server/run modes, fail-fast on missing tmux
5. Double-completion guard — prevents race between onExit and kill() paths

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| tmux not installed on CI | Medium | Test failure | Guard integration tests with `hasTmux`; unit tests use MockTmuxConnector |
| sendControlKeys race with sentinel watcher | Low | Double completion | `completionHandled` flag in handleWorkerCompletion (G2) |
| Output loss on fast exit | Low | Incomplete logs | Final flush in onExit before TaskCompleted (G1); TmuxConnector flushes pending files before onExit |
| Session leak on server crash | Medium | Orphaned sessions | RecoveryManager detects via session liveness check on restart |
| Long prompt exceeds tmux paste buffer | Low | Truncated prompt | tmux send-keys with `-l` handles long strings; monitor for issues |
| Kill polling spawns 20 processes | Low | Brief CPU spike | Bounded at 20; parallelism via killAll is same as before |
| SESSION_NAME_REGEX rejects underscored task IDs | Very Low | Spawn failure | Task IDs are UUIDs (no underscores); document latent mismatch |
