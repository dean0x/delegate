# Task Retry Mechanism for Interrupted Tasks

## Problem Statement

When Delegate is restarted or crashes, running tasks are marked as FAILED with exit code -1, and they're never retried. This means legitimate tasks fail permanently due to infrastructure issues rather than actual task problems.

### Current Behavior
- Recovery Manager marks RUNNING tasks as FAILED with exit code -1
- These failed tasks are never retried
- No distinction between infrastructure failures and task failures
- Tasks interrupted by Delegate restarts are lost

## Existing Recovery Mechanisms

### 1. Recovery Manager (`/workspace/delegate/src/services/recovery-manager.ts`)
- Re-queues QUEUED tasks on startup
- Marks RUNNING tasks as FAILED with exit code -1 (crash indicator)
- Cleans up old tasks (7+ days)
- **Does NOT retry failed tasks**

### 2. Graceful Shutdown (`/workspace/delegate/src/index.ts:67-86`)
- Handles SIGINT and SIGTERM
- Stops autoscaling
- Kills all workers
- **Does NOT persist running task state before shutdown**

### 3. Retry Logic (`/workspace/delegate/src/utils/retry.ts`)
- Exists for git operations and API calls
- **NOT applied to task execution itself**

## What's Missing

1. **No Task Retry on Failure** - Failed tasks stay failed forever
2. **No Graceful Task Persistence** - Running tasks aren't saved as "interrupted" before shutdown
3. **No Crash vs Normal Failure Distinction** - Exit code -1 means crash, but we don't act on it
4. **No Attempt Counter** - No tracking of how many times a task has been tried

## Proposed Solution

### 1. Add Task Retry Mechanism
- Add `attemptCount` and `maxAttempts` fields to Task domain model
- Default `maxAttempts = 3` for tasks (configurable)
- Only retry tasks that failed with exit code -1 (crash/interruption)
- Don't retry tasks that failed normally (exit codes > 0)

### 2. Improve Graceful Shutdown
- Before killing workers, mark running tasks as "INTERRUPTED" instead of letting recovery mark them as FAILED
- Save task progress/state to allow better recovery
- Give workers time to complete (e.g., 30 seconds grace period)

### 3. Enhanced Recovery Logic
- On startup, check for INTERRUPTED or FAILED-with-code-(-1) tasks
- If `attemptCount < maxAttempts`, re-queue them with incremented attempt count
- If max attempts reached, mark as permanently FAILED

### 4. Add Task Lifecycle Events
- Emit `TaskInterrupted` event for graceful shutdown scenarios
- Emit `TaskRetrying` event when re-queuing failed tasks
- Track retry history in task metadata

## Implementation Steps

### Step 1: Update Domain Model (`src/core/domain.ts`)
```typescript
export interface Task {
  // ... existing fields
  readonly attemptCount: number;      // default: 1
  readonly maxAttempts: number;       // default: 3
  readonly lastFailureReason?: string;
  readonly retryHistory?: Array<{
    attemptNumber: number;
    failedAt: number;
    exitCode: number;
    reason: string;
  }>;
}
```

### Step 2: Enhance Recovery Manager (`src/services/recovery-manager.ts`)
```typescript
// Check for crashed tasks that can be retried
const crashedTasks = await this.repository.findByStatus(TaskStatus.FAILED);
for (const task of crashedTasks) {
  if (task.exitCode === -1 && task.attemptCount < task.maxAttempts) {
    // Re-queue with incremented attempt count
    const updatedTask = {
      ...task,
      status: TaskStatus.QUEUED,
      attemptCount: task.attemptCount + 1,
      exitCode: undefined,
      completedAt: undefined
    };
    
    await this.repository.update(task.id, updatedTask);
    this.queue.enqueue(updatedTask);
    
    await this.eventBus.emit('TaskRetrying', {
      taskId: task.id,
      attemptCount: updatedTask.attemptCount,
      maxAttempts: task.maxAttempts
    });
  }
}
```

### Step 3: Improve Shutdown Handler (`src/index.ts`)
```typescript
const shutdown = async (signal: string) => {
  logger.info(`Received ${signal}, initiating graceful shutdown`);
  
  // Mark running tasks as INTERRUPTED
  const workerPoolResult = container?.get('workerPool');
  if (workerPoolResult?.ok) {
    const pool = workerPoolResult.value as WorkerPool;
    const runningTasks = pool.getRunningTasks();
    
    for (const taskId of runningTasks) {
      await repository.update(taskId, {
        status: 'INTERRUPTED',
        interruptedAt: Date.now()
      });
    }
    
    // Give workers grace period to complete
    logger.info('Waiting for workers to complete (30s grace period)');
    await Promise.race([
      pool.waitForCompletion(),
      new Promise(resolve => setTimeout(resolve, 30000))
    ]);
    
    // Now kill remaining workers
    await pool.killAll();
  }
  
  // ... rest of shutdown
};
```

### Step 4: Update Task Repository (`src/implementations/task-repository.ts`)
```typescript
// Add to database schema
this.db.exec(`
  ALTER TABLE tasks 
  ADD COLUMN attempt_count INTEGER DEFAULT 1,
  ADD COLUMN max_attempts INTEGER DEFAULT 3,
  ADD COLUMN last_failure_reason TEXT,
  ADD COLUMN retry_history TEXT
`);
```

### Step 5: Add Configuration (`src/core/configuration.ts`)
```typescript
export interface Configuration {
  // ... existing fields
  taskMaxAttempts: number;        // default: 3
  shutdownGracePeriod: number;    // default: 30000ms
}

// Environment variables
TASK_MAX_ATTEMPTS=3
SHUTDOWN_GRACE_PERIOD=30000
```

## Benefits

1. **Automatic Recovery** - Tasks interrupted by Delegate restarts will automatically retry
2. **Smart Retry Logic** - Distinguishes between infrastructure failures (retriable) and task failures (not retriable)
3. **Visibility** - Provides visibility into retry attempts and history
4. **Prevents Loops** - Max attempts limit prevents infinite retry loops
5. **Graceful Handling** - Better handling of shutdown scenarios

## Testing Strategy

### Unit Tests
- Test retry logic with different exit codes
- Test attempt counting and max attempts limiting
- Test retry history tracking

### Integration Tests
- Test recovery after simulated crash
- Test graceful shutdown with running tasks
- Test re-queueing of interrupted tasks
- Test max attempts enforcement

### Scenarios to Test
1. Task fails with exit code 1 (normal failure) - should NOT retry
2. Task fails with exit code -1 (crash) - should retry
3. Task reaches max attempts - should stay failed
4. Graceful shutdown during task execution - should mark as interrupted
5. Recovery after crash - should re-queue interrupted tasks

## Migration Path

1. Add new columns to existing database (with defaults)
2. Update domain models with backward compatibility
3. Deploy new recovery logic (will handle both old and new tasks)
4. Monitor retry behavior in production
5. Adjust max attempts based on observed patterns

## Configuration Examples

### Conservative (fewer retries)
```env
TASK_MAX_ATTEMPTS=2
SHUTDOWN_GRACE_PERIOD=15000
```

### Aggressive (more retries, longer grace)
```env
TASK_MAX_ATTEMPTS=5
SHUTDOWN_GRACE_PERIOD=60000
```

### Per-Task Override
```typescript
await delegate.DelegateTask({
  prompt: "critical task",
  maxAttempts: 10  // Override for important tasks
});
```

## Monitoring and Observability

### Metrics to Track
- Retry rate (tasks retried / total tasks)
- Success rate after retry
- Average attempts before success
- Tasks hitting max attempts limit

### Log Events
- `TaskRetrying` - Task being retried after failure
- `TaskMaxAttemptsReached` - Task permanently failed
- `TaskInterrupted` - Task interrupted by shutdown
- `TaskRecovered` - Task successfully completed after retry

## Future Enhancements

1. **Exponential Backoff** - Delay between retry attempts
2. **Smart Retry** - Different retry strategies based on failure type
3. **Partial Progress** - Save and restore task progress
4. **Retry Policies** - Configurable retry policies per task type
5. **Circuit Breaker** - Stop retrying if system is unhealthy