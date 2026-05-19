# Contract Alignment Review: TmuxConnector <-> WorkerPool

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17
**Reviewer Focus**: Phase #178 readiness -- does TmuxConnector's interface satisfy what EventDrivenWorkerPool will need?

## Summary

TmuxConnector provides a well-designed push-based session lifecycle that covers the core spawn/destroy/output/exit contract. However, there are **5 gaps** between what EventDrivenWorkerPool currently expects and what TmuxConnector exposes. Two are blocking (require design work before phase #178 can start), two are moderate (solvable during #178 with adapter code), and one is trivially bridgeable.

## Current WorkerPool Interface

`EventDrivenWorkerPool` (src/implementations/event-driven-worker-pool.ts) implements the `WorkerPool` interface and depends on these capabilities:

### Spawn Path
1. **AgentRegistry.get(provider)** -> `AgentAdapter` (strategy pattern per agent)
2. **AgentAdapter.spawn(options)** -> `Result<{ process: ChildProcess; pid: number }>` -- returns a `ChildProcess` handle and PID
3. **ProcessConnector.connect(childProcess, taskId, onExit)** -- pipes stdout/stderr to `OutputCapture`, sets up periodic flush to `OutputRepository`, handles exit callback
4. **WorkerState** stores: `process: ChildProcess`, `task: Task`, `cleanupFn`, `timeoutTimer`, `heartbeatTimer`

### Kill Path
1. **ProcessConnector.prepareForKill(taskId)** -- stops periodic flushing, does final output flush
2. **worker.process.kill('SIGTERM')** -- direct POSIX signal via ChildProcess handle
3. **setTimeout + SIGKILL** -- force-kill after 5s if still alive
4. **cleanupWorkerState** -- remove from maps, unregister from DB, call adapter cleanup

### Output Path
1. **ProcessConnector** reads `stdout`/`stderr` streams from `ChildProcess`
2. Feeds lines into **OutputCapture.capture(taskId, type, data)**
3. Periodic **flushOutput** writes accumulated output from OutputCapture to OutputRepository
4. On exit: final flush -> clear buffer -> signal completion

### Health/Heartbeat Path
1. **setupHeartbeatForWorker** -- 30s interval, calls `workerRepository.updateHeartbeat(workerId)`
2. Worker identification by **PID** (`WorkerId = "worker-{pid}"`)
3. Cross-process stale detection via PID-check + heartbeat timestamp

### Event Integration
1. On exit code 0 -> `eventBus.emit('TaskCompleted', { taskId, exitCode, duration })`
2. On exit code != 0 -> `eventBus.emit('TaskFailed', { taskId, exitCode, error })`
3. Timeout -> `eventBus.emit('TaskTimeout', { taskId, error })`

## TmuxConnector Public API

`TmuxConnectorPort` (src/implementations/tmux/types.ts):

```typescript
interface TmuxConnectorPort {
  spawn(config: TmuxSpawnConfig, callbacks: SpawnCallbacks): Result<TmuxHandle, AutobeatError>;
  destroy(handle: TmuxHandle): Result<void, AutobeatError>;
  sendKeys(handle: TmuxHandle, keys: string): Result<void, AutobeatError>;
  isAlive(handle: TmuxHandle): Result<boolean, AutobeatError>;
  getActiveHandles(): TmuxHandle[];
  dispose(): void;
}
```

### SpawnCallbacks (push-based events)
```typescript
interface SpawnCallbacks {
  onOutput: (msg: OutputMessage) => void;
  onExit: (code: number | null, signal?: string) => void;
}
```

### OutputMessage (structured JSON, not raw stream)
```typescript
interface OutputMessage {
  sequence: number;
  timestamp: string;
  type: 'stdout' | 'stderr' | 'result';
  content: string;
}
```

### TmuxHandle (returned from spawn)
```typescript
interface TmuxHandle {
  sessionName: string;
  taskId: string;
  sessionsDir: string;
}
```

### Key Characteristics
- **Synchronous spawn** -- `Result<TmuxHandle>`, not `Promise<Result<...>>`
- **No ChildProcess** -- returns opaque `TmuxHandle`, not a `ChildProcess` object
- **No PID** -- `TmuxHandle` has no PID field; tmux sessions are identified by session name
- **Push-based output** -- `onOutput` callback with structured `OutputMessage`, not raw `stdout`/`stderr` streams
- **Push-based exit** -- `onExit` callback with exit code + optional signal string
- **Built-in staleness detection** -- configurable per-session, fires `onExit(null, 'STALE')`
- **Built-in sequence ordering** -- messages delivered in-order with gap-filling buffer

## Gap Analysis

### [BLOCKING] GAP-1: No PID for Worker Identity and DB Registration

- **WorkerPool needs**: A numeric PID from spawn to construct `WorkerId("worker-{pid}")`, register in `workerRepository`, and use for cross-process stale detection.
- **TmuxConnector provides**: `TmuxHandle` with `sessionName` and `taskId` -- no PID field.
- **Gap**: tmux sessions do not expose a single stable PID. The tmux server PID is shared across sessions. The wrapper script's shell PID is accessible via `tmux display-message -p '#{pane_pid}'` but this is ephemeral.
- **Impact**: WorkerId construction, DB registration schema (`workers.pid`, `workers.ownerPid`), and PID-based crash recovery all depend on PID. This is the most fundamental identity mismatch.
- **Effort**: **Significant**. Requires:
  1. Either add a `pid` field to `TmuxHandle` (retrieved via `tmux display-message` after session creation) OR change worker identity from PID-based to session-name-based.
  2. Migration v27 (already planned in #179) adds `tmux_session` column to workers table.
  3. `WorkerId` construction must change from `"worker-{pid}"` to `"worker-{sessionName}"` or similar.
  4. Recovery manager's PID-based kill logic must switch to `tmux kill-session`.
- **Recommendation**: Phase #177 (agent adapter migration) should define how `TmuxHandle` maps to the `WorkerRegistration` model. Phase #178 then rewires based on that mapping.

### [BLOCKING] GAP-2: Output Capture Architecture Mismatch

- **WorkerPool needs**: Raw `stdout`/`stderr` streams piped into `OutputCapture.capture(taskId, 'stdout'|'stderr', data: string)`, which accumulates lines into `TaskOutput { stdout: string[], stderr: string[], totalSize: number }`. `ProcessConnector` then periodically flushes to `OutputRepository`.
- **TmuxConnector provides**: Structured `OutputMessage { sequence, timestamp, type, content }` delivered via `onOutput` callback. The wrapper script captures `2>&1` (stderr merged into stdout), so all messages arrive as `type: 'stdout'`.
- **Gap**: Two-level mismatch:
  1. **Format**: TmuxConnector delivers structured JSON messages; OutputCapture expects raw string data. The `OutputMessage.content` field contains the text, but the sequence/timestamp metadata would be discarded.
  2. **stderr separation**: The wrapper merges stderr into stdout (`2>&1`). OutputCapture tracks stdout and stderr independently. All tmux output arrives as `type: 'stdout'`.
  3. **Flush model**: ProcessConnector owns the periodic flush cycle (5s interval with backpressure guard). TmuxConnector already delivers messages in real-time -- there is no buffer to flush. The periodic flush in ProcessConnector becomes unnecessary.
- **Impact**: Phase #178 needs a new `TmuxOutputBridge` (or equivalent) that:
  - Receives `OutputMessage` via `onOutput` callback
  - Extracts `content`, feeds it into `OutputCapture.capture(taskId, msg.type, msg.content)`
  - Alternatively, bypasses `OutputCapture` entirely and writes directly to `OutputRepository.append()`
- **Effort**: **Moderate to Significant**. The bridge itself is straightforward (~50 lines), but the question is whether OutputCapture should be preserved (for in-memory reads from the dashboard) or replaced. This is a design decision for #178.
- **Recommendation**: Design the output bridging strategy before starting #178 implementation. Options: (A) thin adapter `OutputMessage -> OutputCapture.capture()`, (B) new `TmuxOutputCapture` that natively consumes `OutputMessage`, (C) write directly to `OutputRepository` and remove `OutputCapture` from the hot path.

### [GAP] GAP-3: No ChildProcess Handle for Signal-Based Kill

- **WorkerPool needs**: `worker.process.kill('SIGTERM')` followed by `worker.process.kill('SIGKILL')` for force-kill after 5s timeout.
- **TmuxConnector provides**: `destroy(handle)` which calls `sessionManager.destroySession(sessionName)` -- this sends `tmux kill-session -t {name}`.
- **Gap**: No SIGTERM/SIGKILL escalation path. `tmux kill-session` immediately terminates the session (equivalent to SIGKILL, not SIGTERM). There is no graceful shutdown period.
- **Impact**: Agents that handle SIGTERM for cleanup (e.g., saving state) will not get the chance. However, in practice Claude Code does not handle SIGTERM gracefully in `-p` mode either, so the behavioral change may be acceptable.
- **Effort**: **Moderate**. Options:
  1. Accept `tmux kill-session` as equivalent to force-kill (simplest, likely acceptable).
  2. Add a `sendSignal(handle, signal)` method to TmuxConnectorPort that uses `tmux send-keys -t {name} '' C-c` for SIGINT or retrieves the pane PID and sends SIGTERM. This is more complex but preserves the graceful shutdown window.
- **Recommendation**: Accept option 1 for v1.6.0. `destroy()` is already the kill path. Add a comment documenting the behavioral difference. If graceful shutdown becomes needed, add `sendSignal()` in a follow-up.

### [GAP] GAP-4: AgentAdapter.spawn() Returns ChildProcess, Not TmuxHandle

- **WorkerPool needs**: `AgentAdapter.spawn(options)` returning `Result<{ process: ChildProcess; pid: number }>`. The ChildProcess is stored in `WorkerState` and used for kill and stream attachment.
- **TmuxConnector provides**: `spawn(config: TmuxSpawnConfig, callbacks: SpawnCallbacks)` returning `Result<TmuxHandle>`. Completely different signature and return type.
- **Gap**: The `AgentAdapter` interface (src/core/agents.ts) returns `ChildProcess` -- phase #178 must either:
  1. Change the `AgentAdapter` interface to be runtime-polymorphic (return `ChildProcess | TmuxHandle`), OR
  2. Introduce a new `TmuxAgentAdapter` interface that returns `TmuxHandle`, and make WorkerPool generic over the adapter type, OR
  3. Make the adapters call TmuxConnector internally and present a unified facade to WorkerPool.
- **Impact**: This is the primary integration seam. The current architecture tightly couples WorkerPool to `ChildProcess`. Phase #177 (Agent Adapter Migration) is expected to add `buildTmuxCommand()` to adapters, but the return type question needs resolution.
- **Effort**: **Moderate**. Per the migration plan, #177 adds `buildTmuxCommand()` which returns CLI args for the tmux wrapper. The adapter no longer spawns -- it provides configuration. WorkerPool calls TmuxConnector.spawn() directly with the adapter's configuration. This eliminates the ChildProcess from the WorkerPool path entirely.
- **Recommendation**: Phase #177 should change the adapter contract from "spawn and return ChildProcess" to "provide spawn configuration" (command, args, env). Phase #178 then uses TmuxConnector.spawn() directly.

### [OK] Capability: Session Destruction / Kill

- **WorkerPool needs**: Kill a specific worker by workerId.
- **TmuxConnector provides**: `destroy(handle: TmuxHandle)` -- idempotent, flushes pending output, kills tmux session, cleans up watchers and filesystem.
- **Gap**: None. `destroy()` covers the kill use case. The handle-based API maps naturally to taskId-based lookup.
- **Effort**: Trivial -- WorkerPool maps `workerId -> taskId -> TmuxHandle` and calls `destroy()`.

### [OK] Capability: Exit Notification with Exit Code

- **WorkerPool needs**: Exit code from the agent process to determine TaskCompleted (code 0) vs TaskFailed (code != 0).
- **TmuxConnector provides**: `onExit(code: number | null, signal?: string)` via SpawnCallbacks. Code is parsed from the sentinel file. `.done` sentinel = exit 0, `.exit` sentinel = the actual exit code.
- **Gap**: Minor -- `code` can be `null` when staleness fires or sentinel is unreadable. WorkerPool's `handleWorkerCompletion` uses `exitCode ?? 0` as default, which would incorrectly treat stale sessions as successful. The `signal` field ('STALE') provides disambiguation.
- **Effort**: Trivial -- phase #178 handler should check `signal === 'STALE'` and treat as failure (exit code 1 or emit TaskFailed directly).

### [OK] Capability: Heartbeat / Health Check

- **WorkerPool needs**: Periodic heartbeat to update DB timestamp for stale-worker detection.
- **TmuxConnector provides**: Built-in staleness detection via `listSessions()` polling + per-session `maxSilenceMs` threshold. Also exposes `isAlive(handle)` for point-in-time checks.
- **Gap**: Different mechanism but equivalent purpose. TmuxConnector's staleness is internal (fires `onExit(null, 'STALE')`). WorkerPool's heartbeat is external (writes to DB for cross-process visibility).
- **Effort**: Trivial -- phase #178 can keep the DB heartbeat timer (call `isAlive()` or just update timestamp unconditionally) alongside TmuxConnector's internal staleness. They serve complementary purposes: DB heartbeat for cross-process recovery, TmuxConnector staleness for in-process detection.

### [OK] Capability: Graceful Shutdown (killAll / dispose)

- **WorkerPool needs**: `killAll()` to terminate all workers on shutdown.
- **TmuxConnector provides**: `dispose()` which destroys ALL active sessions, flushes output, cleans up watchers and filesystem.
- **Gap**: None. `dispose()` is the equivalent of `killAll()`.
- **Effort**: Trivial.

### [OK] Capability: Send Input (Interactive Mode)

- **WorkerPool needs**: Not currently used for background workers, but phase #178 mentions interactive mode.
- **TmuxConnector provides**: `sendKeys(handle, keys)` -- sends literal keystrokes to the tmux pane stdin.
- **Gap**: None for background workers. For interactive mode, `sendKeys` provides the required capability.
- **Effort**: N/A for phase #178 background workers.

### [OK] Capability: Query Active Sessions

- **WorkerPool needs**: `getWorker()`, `getWorkers()`, `getWorkerCount()`, `getWorkerForTask()`.
- **TmuxConnector provides**: `getActiveHandles()` returns all active `TmuxHandle[]`.
- **Gap**: None. The in-memory `activeSessions` map and `getActiveHandles()` provide the data. WorkerPool maintains its own `workers` map keyed by WorkerId -- this mapping layer stays in WorkerPool.
- **Effort**: Trivial.

### [OK] Capability: Task Timeout

- **WorkerPool needs**: Per-task timeout that triggers kill after N ms.
- **TmuxConnector provides**: No built-in timeout, but staleness config has `maxSilenceMs`.
- **Gap**: `maxSilenceMs` is not the same as task timeout -- it detects crashes, not long-running tasks. Task timeout must remain in WorkerPool (as it is today: `setTimeout` that calls `kill()`).
- **Effort**: None -- timeout stays in WorkerPool, unchanged. It calls `destroy()` instead of `process.kill()`.

## Migration Dependency Chain

```
Phase #176 (this PR)         Phase #177                    Phase #178
TmuxConnectorPort    --->    Agent adapters gain           WorkerPool rewired:
  spawn/destroy/etc          buildTmuxCommand()            - ChildProcess removed
                             Drop Gemini                   - TmuxConnector injected
                             Return config, not process    - TmuxOutputBridge added
                                                           - WorkerId from sessionName
                                                           - destroy() replaces kill()
```

## Overall Assessment

- **Ready for phase #178**: PARTIAL
- **Blocking gaps (must resolve before #178)**:
  1. **GAP-1**: Worker identity -- PID vs session-name. Requires migration v27 design + WorkerId change.
  2. **GAP-2**: Output capture architecture -- OutputMessage vs raw streams. Requires bridge design decision.
- **Non-blocking gaps (solvable during #178)**:
  3. **GAP-3**: No SIGTERM escalation -- accept `destroy()` as force-kill equivalent.
  4. **GAP-4**: AgentAdapter return type -- resolved by #177 changing adapters to configuration providers.
- **Well-aligned capabilities**: Session destruction, exit notification, staleness/heartbeat, shutdown, active session query, input sending, task timeout.

## Recommendations

1. **Before starting #178**, resolve the two blocking design questions:
   - Decide: session-name-based worker identity or retrieve PID from tmux? (Recommendation: session-name-based, aligns with tmux-native model.)
   - Decide: OutputCapture adapter, new TmuxOutputCapture, or direct OutputRepository writes? (Recommendation: thin adapter that feeds `OutputMessage.content` into `OutputCapture.capture()` -- lowest disruption.)

2. **Phase #177 should change AgentAdapter** from "spawn and return ChildProcess" to "provide TmuxSpawnConfig" so that phase #178 has a clean integration point.

3. **TmuxConnectorPort is well-designed** for the consumer's needs. No changes to the TmuxConnector itself are required -- all bridging belongs in the WorkerPool/adapter layer.

4. **Add GAP-1 and GAP-2 as explicit acceptance criteria** on the phase #178 issue to ensure they are addressed during planning, not discovered during implementation.
