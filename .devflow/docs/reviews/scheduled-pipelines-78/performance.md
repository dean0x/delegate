# Performance Review Report

**Branch**: feat/scheduled-pipelines-78 -> main
**Date**: 2026-03-11
**PR**: #80

## Issues in Your Changes (BLOCKING)

### HIGH

**Sequential task save + event emit in pipeline trigger loop** - `/Users/dean/Sandbox/claudine/src/services/handlers/schedule-handler.ts:349-398`
- Problem: `handlePipelineTrigger` creates tasks in a sequential `for` loop, calling `this.taskRepo.save(task)` one at a time. With up to 20 pipeline steps, this means up to 20 sequential database writes. Each iteration also depends on the previous task's ID for the dependency chain, so full parallelization is not possible, but the saves could be batched into a single SQLite transaction.
- Impact: For a 20-step pipeline, this executes 20 separate SQLite INSERT statements, each with its own implicit transaction. SQLite WAL mode means each write acquires and releases a write lock individually. Batching into a single transaction would reduce I/O overhead by ~10-15x for larger pipelines.
- Fix: Wrap the task creation loop in a single transaction. Since the task creation is pure (deterministic IDs via `createTask`), all tasks can be created first, then saved in a batch:
  ```typescript
  // Create all tasks first (pure, no I/O)
  const tasks: Task[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const dependsOn: TaskId[] = [];
    if (i === 0 && step0DependsOn) dependsOn.push(...step0DependsOn);
    if (i > 0) dependsOn.push(tasks[i - 1].id);
    tasks.push(createTask({
      prompt: step.prompt,
      priority: step.priority ?? defaults.priority,
      workingDirectory: step.workingDirectory ?? defaults.workingDirectory,
      agent: step.agent ?? defaults.agent,
      dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
    }));
  }
  // Then save all in a single transaction (requires saveBatch on TaskRepository)
  const saveResult = await this.taskRepo.saveBatch(tasks);
  ```
  Note: This would require adding a `saveBatch` method to the TaskRepository interface. Alternatively, the handler could use a lower-level transaction wrapper.

**Sequential event emission for pipeline tasks** - `/Users/dean/Sandbox/claudine/src/services/handlers/schedule-handler.ts:418-428`
- Problem: After saving all pipeline tasks, `TaskDelegated` events are emitted sequentially in a `for` loop with `await`. For a 20-step pipeline, this serializes 20 event emissions.
- Impact: Each `await this.eventBus.emit('TaskDelegated', { task })` triggers synchronous handler processing (DependencyHandler, PersistenceHandler, QueueHandler). For a 20-step pipeline where only step 0 (or none) are unblocked, the subsequent steps will all be processed through the full handler chain only to be blocked. This is wasted work per iteration.
- Fix: Since only step 0 might be immediately runnable (steps 1-19 are all dependency-blocked), the event emissions could use `Promise.all` for the blocked steps or at minimum batch them:
  ```typescript
  // Emit all TaskDelegated events in parallel
  // Event handlers are idempotent and each task is independent
  await Promise.all(
    savedTasks.map((task) => this.eventBus.emit('TaskDelegated', { task }))
  );
  ```
  However, note this depends on whether the EventBus handlers are safe for concurrent invocation. The current sequential approach is safer but slower. If parallelism is not safe, this should be documented as an intentional trade-off.

### MEDIUM

**Sequential task cancellation in pipeline cleanup** - `/Users/dean/Sandbox/claudine/src/services/handlers/schedule-handler.ts:380-387`
- Problem: When a pipeline task save fails partway through, cleanup cancels already-saved tasks one at a time in a sequential loop.
- Impact: For a failure at step 19, this would issue 18 sequential UPDATE statements. This is an error path so it is less critical, but batching would be more efficient.
- Fix: Use a single UPDATE statement with an IN clause:
  ```typescript
  // Single batch cancel instead of N individual updates
  const taskIds = savedTasks.map(t => t.id);
  await this.taskRepo.updateBatch(taskIds, { status: TaskStatus.CANCELLED });
  ```

**Sequential task cancellation in cancelSchedule** - `/Users/dean/Sandbox/claudine/src/services/schedule-manager.ts:264-276`
- Problem: When `cancelTasks` is true, tasks from the latest pipeline execution are cancelled one at a time via sequential event emissions.
- Impact: For a 20-step pipeline, this emits 20 `TaskCancellationRequested` events sequentially. Each event triggers handler processing.
- Fix: These event emissions are independent and could be parallelized:
  ```typescript
  await Promise.all(
    taskIds.map((taskId) =>
      this.eventBus.emit('TaskCancellationRequested', {
        taskId,
        reason: `Schedule ${scheduleId} cancelled`,
      })
    )
  );
  ```

**Repeated JSON.stringify of pipelineSteps on every schedule update** - `/Users/dean/Sandbox/claudine/src/implementations/schedule-repository.ts:304-322`
- Problem: The `update()` method does a read-modify-write: it fetches the existing schedule via `findById` (which parses JSON), merges updates, then re-serializes the entire schedule back to the database -- including re-serializing `pipelineSteps` and `taskTemplate` even when they have not changed.
- Impact: For frequent schedule updates (every trigger increments `runCount` and updates `lastRunAt`/`nextRunAt`), this unnecessarily parses and re-serializes JSON blobs that do not change. The `pipelineSteps` JSON can be up to ~80KB for 20 steps with max-length prompts.
- Fix: This is a pre-existing architectural pattern (read-modify-write for all updates), but the new `pipelineSteps` field makes it more impactful. Consider a targeted UPDATE statement that only touches the changed columns:
  ```sql
  UPDATE schedules SET run_count = ?, last_run_at = ?, next_run_at = ?, status = ?, updated_at = ?
  WHERE id = ?
  ```
  This would avoid the findById + full re-serialize round-trip for the common "post-trigger update" path.

### LOW

**Zod validation on every rowToSchedule for pipeline_steps** - `/Users/dean/Sandbox/claudine/src/implementations/schedule-repository.ts:497-506`
- Problem: Every call to `rowToSchedule` parses and validates `pipeline_steps` JSON through `PipelineStepsSchema.parse()`. This includes Zod's full validation (min/max array length, string min length, enum checks).
- Impact: Minimal for typical usage -- `findDue()` returns a small number of schedules per tick. But for `findAll()` with many pipeline schedules, this adds overhead. Zod validation is ~10-100x slower than raw JSON.parse.
- Fix: Consider caching parsed pipeline steps or using a lightweight parse (JSON.parse only) after the initial save validation has already verified the data. The data was validated on write, so re-validating on every read is defense-in-depth but has a cost.

**Synthetic prompt construction with string concatenation** - `/Users/dean/Sandbox/claudine/src/services/schedule-manager.ts:385-388`
- Problem: The `syntheticPrompt` is built by mapping, substring-ing, and joining all steps. For 20 steps with 4000-char prompts, this creates multiple intermediate strings.
- Impact: Negligible -- this runs once at schedule creation time, not on every trigger. The `substring(0, 40)` truncation keeps it small.
- Fix: No action needed. This is a non-issue in practice.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**N+1 pattern in dependency cascade check** - `/Users/dean/Sandbox/claudine/src/services/handlers/dependency-handler.ts:581-599`
- Problem: In `resolveDependencies`, after batch resolution, each dependent task that becomes unblocked triggers a `getDependencies(dep.taskId)` call to check for failed/cancelled dependencies. This is a new database query per unblocked task.
- Impact: For a 20-step linear pipeline where step 0 fails, all 19 downstream tasks will have their dependencies resolved. Each one triggers `isBlocked()` (line 573) plus `getDependencies()` (line 584) -- that is 38 additional queries for a single failure cascade. With the new pipeline feature generating more linear chains, this pattern will be hit more frequently.
- Fix: The batch resolution already knows the resolution status. The cascade check could be folded into the resolution logic by checking the resolution parameter directly:
  ```typescript
  if (!isBlockedResult.value) {
    // If the resolution that triggered this was 'failed' or 'cancelled',
    // we know at least one dependency is failed/cancelled
    if (resolution === 'failed' || resolution === 'cancelled') {
      await this.eventBus.emit('TaskCancellationRequested', {
        taskId: dep.taskId,
        reason: `Dependency ${completedTaskId} ${resolution}`,
      });
      continue;
    }
    // ... existing unblock logic
  }
  ```
  This eliminates the `getDependencies()` call entirely for the cascade path. The only edge case is if a task has multiple dependencies where some completed and some failed -- but the `isBlocked()` check already handles that (if any dependency is still pending, the task remains blocked).

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Read-modify-write pattern in schedule update** - `/Users/dean/Sandbox/claudine/src/implementations/schedule-repository.ts:282-326`
- Problem: Every `update()` call does `findById` + merge + full write. This means every schedule trigger (which updates `runCount`, `lastRunAt`, `nextRunAt`) performs a full row read, JSON parse of `task_template` and `pipeline_steps`, object merge, re-serialize, and full row write.
- Impact: On a busy cron schedule triggering every minute, this is 1440 unnecessary JSON parse/serialize cycles per day per schedule. With pipeline_steps, the JSON payload is larger.
- Fix: Add a targeted `updateFields()` method that only updates specific columns without reading the full row first.

### LOW

**findDue query returns full rows including pipeline_steps JSON** - `/Users/dean/Sandbox/claudine/src/implementations/schedule-repository.ts:208-212`
- Problem: The `findDue` query uses `SELECT *`, which returns the `pipeline_steps` TEXT column even though the scheduler tick only needs to decide whether to trigger. The actual pipeline steps are only needed inside `handlePipelineTrigger`, which re-fetches the schedule anyway (via `handleScheduleTriggered`).
- Impact: Minimal -- the scheduler tick fetches a small number of due schedules. But `pipeline_steps` could be a large JSON blob (up to ~80KB for 20 steps with max prompts). SELECT * is a known anti-pattern for tables with large TEXT/BLOB columns.
- Fix: No immediate action needed. If pipeline schedules become numerous, consider a projection query for `findDue` that excludes `pipeline_steps`.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 2 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 1 |

**Performance Score**: 7/10

The code is well-structured with good separation of concerns. The main performance concerns are around sequential I/O in the pipeline trigger path (up to 20 sequential DB writes + 20 sequential event emissions per trigger). These are bounded by the 20-step pipeline limit, so they will not cause unbounded degradation, but they represent a 10-20x improvement opportunity for larger pipelines. The QueueHandler fast-path optimization (line 68, skipping `isBlocked()` for tasks created with dependencies) is a smart performance improvement that eliminates a real race condition.

**Recommendation**: APPROVED_WITH_CONDITIONS

Conditions:
1. The sequential task save loop in `handlePipelineTrigger` should be wrapped in a single SQLite transaction to avoid per-write transaction overhead. This is the highest-impact change.
2. The N+1 `getDependencies()` call in the dependency cascade path should be optimized since pipeline chains will exercise this path frequently.

The remaining items (parallel event emission, cleanup batching, Zod validation caching) are optimization opportunities that can be addressed in follow-up work.
