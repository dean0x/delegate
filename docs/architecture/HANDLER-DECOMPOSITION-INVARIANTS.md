# Handler Decomposition Invariants

> This document captures critical invariants that MUST be preserved when decomposing `processNextTask()` and `handleTaskDelegated()` methods.

## Coverage Analysis (Pre-Decomposition)

### WorkerHandler
- **Statement Coverage**: 82.44%
- **Branch Coverage**: 80.48%
- **Uncovered Lines**: 360-364, 386-389 (catch blocks in completion/timeout handlers)

### DependencyHandler
- **Statement Coverage**: 77%
- **Branch Coverage**: 70.58%
- **Uncovered Lines**: 428-432, 441-446 (error paths in dependency resolution)

---

## processNextTask() Invariants

Location: `src/services/handlers/worker-handler.ts:377-438`

### Spawn Serialization (CRITICAL - Added 2025-12-06)

**WHY THIS EXISTS:**
The spawn delay check (`lastSpawnTime`) had a TOCTOU (Time-of-Check Time-of-Use) race condition:
- Multiple `processNextTask()` calls could pass the delay check simultaneously
- `lastSpawnTime` was only updated AFTER spawn completed
- This allowed burst spawning during recovery or batch task submission

**HOW IT WORKS:**
All spawn logic runs inside `withSpawnLock()` - a promise-chain mutex that ensures only one `processNextTask()` executes at a time.

```typescript
private async processNextTask(): Promise<void> {
  await this.withSpawnLock(async () => {
    // All checks and spawn happen atomically here
  });
}
```

**INVARIANTS:**
- At most ONE spawn operation runs at any time (no overlap)
- Subsequent callers wait for the previous to complete
- After lock release, callers see updated `lastSpawnTime`
- Lock is ALWAYS released, even on errors (try/finally)

### Ordering Invariants (CRITICAL)

1. **Spawn delay check FIRST** - Must happen before any other operation
   - Prevents fork bombs by enforcing minimum delay between spawns
   - On violation: schedule retry via setTimeout, return early
   - **Now protected by spawn lock** - check happens inside serialized section

2. **Resource check SECOND** - Before getting task from queue
   - Prevents spawning when system is overloaded
   - On failure: apply backoff, return early

3. **Get task THIRD** - Via NextTaskQuery event
   - Returns null if queue empty
   - On empty/error: return early (no task to process)

4. **TaskStarting event BEFORE spawn**
   - Notifies system that task processing is beginning
   - On emit failure: requeue task, return early

5. **Worker spawn AFTER TaskStarting**
   - Actual process creation
   - On failure: emit RequeueTask AND TaskFailed, return early

6. **Post-spawn updates AFTER successful spawn**
   - `lastSpawnTime = Date.now()` - for throttling
   - `resourceMonitor.incrementWorkerCount()` - track active workers
   - `resourceMonitor.recordSpawn()` - track settling workers
   - Emit `TaskStarted` event

### Error Handling Invariants

- Catch block logs error but does NOT rethrow (prevents cascade failures)
- Failed spawns result in BOTH RequeueTask AND TaskFailed events
- TaskStarting failure results in requeue WITHOUT TaskFailed

### State Invariants

- `lastSpawnTime` only updated on successful spawn
- `resourceMonitor` counts only updated on successful spawn
- No partial state: either full success or clean failure

---

## handleTaskDelegated() Invariants

Location: `src/services/handlers/dependency-handler.ts:293-348`

### Ordering Invariants (CRITICAL)

1. **Skip check FIRST** - If no dependencies, return immediately
   - `if (!task.dependsOn || task.dependsOn.length === 0)` - early exit

2. **All validations run in PARALLEL** - via Promise.all
   - Cycle detection per dependency
   - Depth limit check per dependency
   - Returns first failure found (fail-fast reporting)

3. **Database write AFTER all validations pass**
   - `dependencyRepo.addDependencies()` - atomic batch insert
   - On failure: emit TaskDependencyFailed, return error

4. **Graph update AFTER successful database write**
   - `this.graph.addEdge()` for each dependency
   - Graph update failure is logged but continues (recovery on restart)

5. **Events emitted AFTER graph update**
   - `TaskDependencyAdded` for each dependency

### Validation Invariants

- Cycle detection uses `this.graph.wouldCreateCycle()` - O(V+E) in-memory
- Depth check uses `this.graph.getMaxDepth()` - O(V+E) with internal memoization for diamond patterns
- `MAX_DEPENDENCY_CHAIN_DEPTH = 100` - prevents DoS via deep chains

### Error Type Handling

- `type: 'system'` - unexpected error (logged as error)
- `type: 'cycle'` - DAG violation (logged as warning)
- `type: 'depth'` - chain too deep (logged as warning)

### Atomicity Invariants

- All-or-nothing: either ALL dependencies added or NONE
- On any validation failure: emit TaskDependencyFailed with first failure
- Database transaction ensures no partial writes

### Graph-Database Consistency

- Graph is updated ONLY after successful DB write
- If graph update fails after DB write: log error, continue
- Recovery path: handler re-initializes graph from DB on restart

---

## Decomposition Guidelines

### Safe Extraction Patterns

1. **Extract validation logic** - Pure functions, no side effects
   ```typescript
   // Safe: Pure validation
   private validateDependency(taskId: TaskId, depId: TaskId): ValidationResult
   ```

2. **Extract event emission** - Isolated side effect
   ```typescript
   // Safe: Single responsibility
   private async emitSpawnEvents(worker: Worker, taskId: TaskId): Promise<void>
   ```

3. **Extract resource checks** - Query-only operation
   ```typescript
   // Safe: Read-only
   private async canProcessTask(): Promise<boolean>
   ```

### Dangerous Extraction Patterns (AVOID)

1. **DO NOT split atomic sequences** - Keep related operations together
   ```typescript
   // DANGEROUS: Splits validation from persistence
   async validateThenPersist() // BAD - loses atomicity
   ```

2. **DO NOT separate state updates** - Keep post-success updates together
   ```typescript
   // DANGEROUS: Partial state update possible
   updateSpawnTime(); // If this succeeds
   updateWorkerCount(); // But this fails - inconsistent state
   ```

### Testing After Each Extraction

After extracting each method:
1. Run existing tests - must all pass
2. Verify coverage didn't decrease
3. Check that extracted method is called exactly where original code was

---

## Characterization Tests Needed

### WorkerHandler Gaps

1. **TaskStarting emission failure** - Verify task is requeued ✅ (Added)
2. **Concurrent spawn attempts** - Verify serialization prevents overlap ✅ (Added 2025-12-06)
3. **Resource constraint during processing** - Verify backoff applied ✅ (Added)

### DependencyHandler Gaps

1. **isBlocked check failure** - Verify error logged, continues to next
2. **Task not found after unblock** - Verify error logged, continues
3. **Subscription failure during setup** - Verify error propagated

---

## Verification Checklist

Before merging decomposition:

- [ ] All existing tests pass
- [ ] Coverage >= pre-decomposition levels
- [ ] No new `any` types introduced
- [ ] Ordering invariants preserved (review PR diff)
- [ ] Atomicity invariants preserved
- [ ] Error handling paths unchanged
- [ ] No new mutable state introduced
