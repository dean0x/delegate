# Complexity Review Report

**Branch**: feat/worker-coordination-89 -> main
**Date**: 2026-03-17
**PR**: #94
**Commits**: 7324e28 (feat: SQLite worker coordination), 0c496f3 (fix: self-review)

---

## Issues in Your Changes (BLOCKING)

### HIGH

**`recover()` method is 153 lines with 4 nesting levels** - `src/services/recovery-manager.ts:33-185`
- Problem: The `recover()` method handles three distinct recovery phases (dead worker cleanup, QUEUED task re-queue, RUNNING task PID check) in a single 153-line function. This exceeds the 50-line critical threshold by 3x. The "Phase 0" block (lines 37-63) introduces 4 levels of nesting: `if (allWorkers.ok) > for > if (!isProcessAlive) > if (!unregResult.ok)`.
- Impact: Hard to test individual recovery phases in isolation, hard to understand full control flow at a glance, and the method has ~10 decision points (cyclomatic complexity estimate: 12-15).
- Fix: Extract each phase into a named private method. This preserves the sequential ordering while making each phase independently readable and testable:
  ```typescript
  async recover(): Promise<Result<void>> {
    this.logger.info('Starting recovery process');
    this.cleanDeadWorkerRegistrations();
    await this.cleanupOldCompletedTasks();
    const queuedResult = await this.requeueQueuedTasks();
    const failedResult = await this.failCrashedRunningTasks();
    // ... summary log
    return ok(undefined);
  }

  private cleanDeadWorkerRegistrations(): void { /* Phase 0 logic */ }
  private async cleanupOldCompletedTasks(): Promise<void> { /* cleanup logic */ }
  private async requeueQueuedTasks(): Promise<{ count: number }> { /* queued logic */ }
  private async failCrashedRunningTasks(): Promise<{ count: number }> { /* running logic */ }
  ```

**`spawn()` method is 99 lines with sequential guard-check-register-connect pattern** - `src/implementations/event-driven-worker-pool.ts:43-141`
- Problem: The `spawn()` method grew from ~80 lines to 99 lines with the addition of DB registration and rollback logic (lines 108-123). It now has 8 early-return/error paths and handles agent resolution, resource checking, process spawning, DB registration with rollback, timeout setup, and output connection all in one method.
- Impact: Each new cross-cutting concern (like the DB registration) adds another error path and cleanup responsibility, making it harder to verify correctness.
- Fix: Consider extracting the DB registration + rollback into a helper that returns a Result, or grouping the post-spawn setup (DB register, timeout, output connect) into a `finalizeWorkerSetup` method:
  ```typescript
  private finalizeWorkerSetup(worker: WorkerState, task: Task, childProcess: ChildProcess): Result<void> {
    const regResult = this.registerWorkerInDb(worker, task);
    if (!regResult.ok) {
      childProcess.kill('SIGTERM');
      this.workers.delete(worker.id);
      this.taskToWorker.delete(task.id);
      return err(regResult.error);
    }
    this.setupTimeoutForWorker(worker);
    this.processConnector.connect(childProcess, task.id, (exitCode) => {
      this.handleWorkerCompletion(task.id, exitCode ?? 0);
    });
    return ok(undefined);
  }
  ```

### MEDIUM

**`canSpawnWorker()` has 5 sequential resource checks with duplicated logging patterns** - `src/implementations/resource-monitor.ts:83-172`
- Problem: 90-line method with 5 separate resource checks (global DB count, CPU cores, memory, load average, success), each with its own logging block. The logging objects are verbose (6-8 fields each), inflating the method length well beyond its logical complexity.
- Impact: The actual decision logic is simple (5 sequential boolean gates), but the verbose logging makes it appear more complex than it is. Adding a 6th check would push this further.
- Fix: This is a stylistic observation. The method follows a clear linear pattern (check, log, return false). No immediate refactoring needed, but consider a helper pattern if more checks are added:
  ```typescript
  private checkResource(name: string, condition: boolean, context: Record<string, unknown>): boolean {
    if (!condition) {
      this.logger?.debug(`Cannot spawn: ${name}`, context);
    }
    return condition;
  }
  ```

**`EventDrivenWorkerPool` constructor takes 7 parameters** - `src/implementations/event-driven-worker-pool.ts:31-41`
- Problem: The constructor grew from 5 to 7 parameters with the addition of `workerRepository` and `outputRepository`. This is at the upper end of the "warning" range (5+) per complexity guidelines.
- Impact: More parameters make construction sites harder to maintain (see the 7-arg call in `bootstrap.ts:337-345`). Two of the parameters (`outputCapture`, `outputRepository`) are immediately passed to `ProcessConnector` and never used directly.
- Fix: Since `outputCapture` and `outputRepository` are only used to construct the `ProcessConnector`, consider accepting an already-constructed `ProcessConnector` instead:
  ```typescript
  constructor(
    agentRegistry: AgentRegistry,
    monitor: ResourceMonitor,
    logger: Logger,
    eventBus: EventBus,
    processConnector: ProcessConnector,  // Pre-constructed
    workerRepository: WorkerRepository,
  ) { ... }
  ```
  This reduces to 6 parameters and makes the dependency clearer. The `ProcessConnector` construction moves to `bootstrap.ts`.

**`connect()` method has a nested async chain in `safeOnExit`** - `src/services/process-connector.ts:23-93`
- Problem: The `safeOnExit` closure (lines 26-43) chains `.then().catch().finally()` inside a synchronous callback. While functionally correct, it creates a 3-level async chain within a closure within a method (72 lines total).
- Impact: The promise chain inside a closure is harder to follow than the rest of the codebase's `async/await` style. The `onExit` callback is delayed until the promise chain settles, which is intentional but non-obvious.
- Fix: This is a borderline case. The promise chain exists because `safeOnExit` is called from synchronous event handlers (`process.on('exit')`) where `await` is not available. The approach is correct for the constraint. A doc comment on the closure explaining why it uses promise chains instead of await would help readability.

### LOW

**`TaskManagerService` constructor grew to 7 parameters** - `src/services/task-manager.ts:33-42`
- Problem: The addition of `outputRepository` brings the constructor to 7 parameters (including the optional `checkpointRepo`).
- Impact: Same concern as `EventDrivenWorkerPool` -- 7 parameters is at the upper warning threshold.
- Fix: Acceptable for now since `outputRepository` is used directly in `getLogs()`. If more dependencies are added, consider a config/dependencies object pattern.

---

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Duplicate dead-worker cleanup logic in `recover()`** - `src/services/recovery-manager.ts:37-63` and `src/services/recovery-manager.ts:144-174`
- Problem: Phase 0 (lines 37-63) iterates all workers and marks dead ones as FAILED. Then the RUNNING task loop (lines 144-174) does the same PID-alive check per task via `findByTaskId`. If Phase 0 already cleaned up dead workers and marked their tasks as FAILED, those tasks should no longer appear as RUNNING in the `runningResult`. The overlap means some tasks may be processed twice (once in Phase 0 via worker iteration, once in the RUNNING loop via task iteration).
- Impact: Not a correctness bug (double-marking as FAILED is idempotent), but it adds confusion about which code path is authoritative. It also means the RUNNING loop does redundant `findByTaskId` queries for tasks already handled.
- Fix: Either (a) remove Phase 0 and let the RUNNING loop handle everything (simpler), or (b) fetch `runningResult` AFTER Phase 0 completes so already-failed tasks are excluded. Option (b) is a one-line reorder.

---

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`resource-monitor.ts` is 426 lines with two classes** - `src/implementations/resource-monitor.ts`
- Problem: File contains both `SystemResourceMonitor` (production) and `TestResourceMonitor` (test double) in the same file. The test double alone is ~110 lines with many setter methods.
- Fix: Move `TestResourceMonitor` to `tests/fixtures/test-doubles.ts` where other test doubles live. This would bring the production file to ~310 lines.

**`task-manager.ts` is 433 lines** - `src/services/task-manager.ts`
- Problem: Approaching the 500-line "critical" file length threshold. The `resume()` method and `buildEnrichedPrompt()` together are ~130 lines.
- Fix: No immediate action needed, but monitor growth. If more task operations are added, consider splitting read operations (`getStatus`, `getLogs`) from write operations (`delegate`, `cancel`, `retry`, `resume`).

### LOW

**Magic number: 500ms flush interval** - `src/services/process-connector.ts:70-74`
- Problem: The periodic flush interval `500` is a magic number with no named constant or configuration option.
- Fix: Extract to a named constant: `private static readonly FLUSH_INTERVAL_MS = 500;`

**Magic number: 5000ms force-kill timeout** - `src/implementations/event-driven-worker-pool.ts:171-175`
- Problem: The force-kill timeout `5000` is a magic number.
- Fix: Extract to a named constant: `private static readonly FORCE_KILL_TIMEOUT_MS = 5000;`

---

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 1 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 2 | 2 |

**Complexity Score**: 6/10

The new code follows good patterns overall: `cleanupWorkerState()` extraction reduces duplication, the `WorkerRepository` methods are small and focused, and the `ProcessConnector` flush/stop lifecycle is clean. The main complexity concerns are the `recover()` method length (153 lines, should be split into phases) and the `spawn()` method growth (99 lines with 8 error paths). Constructor parameter counts are at warning thresholds (7 params in two classes) but still manageable.

**Recommendation**: CHANGES_REQUESTED

The two HIGH-severity items (recover() at 153 lines and spawn() at 99 lines) should be addressed before merge. Both are straightforward extract-method refactorings that reduce cognitive load without changing behavior. The MEDIUM items are recommended but not blocking.
