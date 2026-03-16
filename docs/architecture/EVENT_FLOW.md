# Event Flow Architecture

Backbeat uses a **hybrid event-driven architecture** where commands (state changes) flow through a central EventBus and queries use direct repository access. This document explains the event flows for common operations.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         EventBus (Central Hub)                   │
│                                                                   │
│  • Fire-and-forget: emit()                                      │
│  • Request-response: request() + respond()                      │
│  • Correlation IDs for tracking                                 │
│  • Handler profiling (warns if >100ms)                          │
└─────────────────────────────────────────────────────────────────┘
                              ▲ │
        ┌─────────────────────┘ └─────────────────────┐
        │                                              │
   ┌────▼────┐  ┌──────────┐  ┌──────────┐
   │ Persist │  │  Queue   │  │  Worker  │
   │ Handler │  │ Handler  │  │ Handler  │
   └─────────┘  └──────────┘  └──────────┘
        │            │              │
        ▼            ▼              ▼
   [Database]   [Task Queue]  [Worker Pool]
```

## Event Types

### Command Events (Fire-and-Forget)
- `TaskDelegated` - New task submitted
- `TaskQueued` - Task added to queue
- `TaskStarted` - Worker spawned for task
- `TaskCompleted` - Task finished successfully
- `TaskFailed` - Task execution failed
- `TaskCancelled` - Task cancelled by user
- `OutputCaptured` - Worker output received

### Queries (Direct Repository Access)
Queries bypass the EventBus and call repositories directly:
- Task status lookups via `TaskRepository.findById()`
- Task logs via `OutputCapture.getOutput()`
- Task listing via `TaskRepository.findAllUnbounded()`

## Common Event Flows

### 1. Task Delegation Flow

```
User/MCP Client
    │
    ▼
┌───────────────────────────────────────────────────────────────┐
│ 1. TaskManager.delegate()                                      │
│    • Validates input                                           │
│    • Creates Task object                                       │
│    • Emits: TaskDelegated                                      │
└───────────────────────────────────────────────────────────────┘
    │
    ▼
┌───────────────────────────────────────────────────────────────┐
│ 2. PersistenceHandler.handleTaskDelegated()                   │
│    • Saves task to database                                    │
│    • Calls QueueHandler.enqueueIfReady() directly             │
└───────────────────────────────────────────────────────────────┘
    │
    ▼
┌───────────────────────────────────────────────────────────────┐
│ 3. QueueHandler.enqueueIfReady()                              │
│    • Checks dependency status (skip if blocked)               │
│    • Adds task to priority queue                               │
│    • Emits: TaskQueued                                         │
└───────────────────────────────────────────────────────────────┘
    │
    ▼
┌───────────────────────────────────────────────────────────────┐
│ 4. WorkerHandler.handleTaskQueued()                           │
│    • Checks resources (canSpawnWorker)                         │
│    • Enforces 10s spawn delay (burst protection)               │
│    • Dequeues task directly via TaskQueue.dequeue()            │
│    • Spawns worker process                                     │
│    • Emits: TaskStarted                                        │
└───────────────────────────────────────────────────────────────┘
    │
    ▼
┌───────────────────────────────────────────────────────────────┐
│ 5. PersistenceHandler.handleTaskStarted()                     │
│    • Updates task status to RUNNING                            │
│    • Records worker ID and start time                          │
└───────────────────────────────────────────────────────────────┘
```

### 2. Task Completion Flow

```
Worker Process (claude-code)
    │
    ▼ (process exits)
┌───────────────────────────────────────────────────────────────┐
│ 1. WorkerPool.onWorkerExit()                                  │
│    • Captures exit code                                        │
│    • Looks up task via TaskRepository (direct access)         │
└───────────────────────────────────────────────────────────────┘
    │
    ▼
┌───────────────────────────────────────────────────────────────┐
│ 2. WorkerHandler.onWorkerComplete()                           │
│    • Determines success/failure from exit code                 │
│    • Emits: TaskCompleted OR TaskFailed                        │
│    • Decrements worker count                                   │
└───────────────────────────────────────────────────────────────┘
    │
    ▼
┌───────────────────────────────────────────────────────────────┐
│ 3. PersistenceHandler.handleTaskCompleted/Failed()            │
│    • Updates task status (COMPLETED/FAILED)                    │
│    • Records completion time and exit code                     │
└───────────────────────────────────────────────────────────────┘
```

### 3. Task Cancellation Flow

```
User Request
    │
    ▼
┌───────────────────────────────────────────────────────────────┐
│ 1. TaskManager.cancel()                                        │
│    • Validates task ID                                         │
│    • Emits: TaskCancellationRequested                          │
└───────────────────────────────────────────────────────────────┘
    │
    ├────▶ QueueHandler.handleTaskCancellation()
    │      • Removes from queue if queued
    │
    └────▶ WorkerHandler.handleTaskCancellation()
           │
           ▼
       ┌────────────────────────────────────────────┐
       │ TaskRepository.findById(taskId)            │
       │ • Gets task to find worker ID              │
       └────────────────────────────────────────────┘
           │
           ▼
       ┌────────────────────────────────────────────┐
       │ WorkerPool.kill(workerId)                   │
       │ • Sends SIGTERM to process                 │
       │ • 5s grace period, then SIGKILL            │
       └────────────────────────────────────────────┘
           │
           ▼
       ┌────────────────────────────────────────────┐
       │ Emits: TaskCancelled                        │
       └────────────────────────────────────────────┘
           │
           ▼
       ┌────────────────────────────────────────────┐
       │ PersistenceHandler.handleTaskCancelled()    │
       │ • Updates task status to CANCELLED          │
       └────────────────────────────────────────────┘
```

### 4. Recovery Flow (Server Restart)

```
Server Startup
    │
    ▼
┌───────────────────────────────────────────────────────────────┐
│ 1. RecoveryManager.recover()                                   │
│    • Queries database for non-terminal tasks                   │
└───────────────────────────────────────────────────────────────┘
    │
    ▼
┌───────────────────────────────────────────────────────────────┐
│ 2. Handle QUEUED tasks                                         │
│    • Safety check: not already in queue                        │
│    • Enqueue task                                              │
│    • Emits: TaskQueued                                         │
└───────────────────────────────────────────────────────────────┘
    │
    ▼
┌───────────────────────────────────────────────────────────────┐
│ 3. Handle RUNNING tasks (STALE DETECTION)                     │
│                                                                 │
│  IF task age > 30 minutes (STALE):                            │
│    • Mark as FAILED (exit code -1)                            │
│    • Log: "Marked stale crashed task as failed"              │
│                                                                 │
│  IF task age < 30 minutes (RECENT):                           │
│    • Re-queue for recovery                                     │
│    • Emits: TaskQueued                                         │
│    • Log: "Re-queued recent running task for recovery"       │
│                                                                 │
│  WHY: Prevents fork-bomb on restart from old tasks            │
│       See: RecoveryManager JSDoc for incident details          │
└───────────────────────────────────────────────────────────────┘
    │
    ▼
┌───────────────────────────────────────────────────────────────┐
│ 4. WorkerHandler.handleTaskQueued()                           │
│    • Enforces 10s spawn delay between workers                 │
│    • Prevents burst spawning during recovery                   │
│    • See: WorkerHandler JSDoc for fork-bomb prevention        │
└───────────────────────────────────────────────────────────────┘
```

## Request-Response Pattern Details

The EventBus supports request-response using correlation IDs. After Phase 1 simplification,
queries use direct repository access instead of request-response events. The pattern remains
available in the EventBus interface for future use.

```typescript
// Request-response via EventBus (correlation ID pattern)
const result = await eventBus.request<SomeEvent, ResponseType>(
  'SomeEvent',
  { /* payload */ }
);
// Internally generates correlationId, handler responds via eventBus.respond()

// Post-simplification: queries go direct
const task = await taskRepo.findById(taskId);
```

## Performance Monitoring

The EventBus automatically profiles all handlers:

- **Slow Handler Warning**: Logs warning if handler takes >100ms
- **Metrics Logged**:
  - Total duration for all handlers
  - Per-handler execution time
  - Count of slow handlers
- **Debug Logs**: Full timing data for investigation

Example output:
```
WARN: Slow event handler detected {
  eventType: 'TaskDelegated',
  handlerIndex: 2,
  duration: 250,
  threshold: 100
}

DEBUG: Event handlers completed {
  eventType: 'TaskDelegated',
  eventId: 'evt-123',
  handlerCount: 3,
  totalDuration: 267,
  slowHandlers: 1
}
```

## Critical Safeguards

### 1. Spawn Serialization (WorkerHandler)

The spawn protection system has **three layers** to prevent fork-bomb scenarios:

#### Layer 1: Spawn Lock (Mutex Serialization)

**Problem**: TOCTOU race condition - multiple `processNextTask()` calls could pass the delay check simultaneously before any updated `lastSpawnTime`.

**Solution**: Promise-chain mutex (`withSpawnLock()`) ensures only one spawn operation runs at a time.

```
Without lock (TOCTOU race):
  processNextTask #1 → delay OK? YES → spawning...
  processNextTask #2 → delay OK? YES → spawning... (race!)
  processNextTask #3 → delay OK? YES → spawning... (fork bomb!)

With lock (serialized):
  processNextTask #1 → acquire lock → delay OK? YES → spawn → release
  processNextTask #2 → wait for lock → delay OK? NO → skip
  processNextTask #3 → wait for lock → delay OK? NO → skip
```

**Code**: `src/services/handlers/worker-handler.ts:62` (spawnLock), `:225-237` (withSpawnLock)

#### Layer 2: 10-Second Spawn Delay

**Defense in depth**: Even with the lock, a minimum 10-second delay between spawns prevents rapid resource exhaustion.

```
Recovery with 5 queued tasks:
  t=0s:  Task #1 → spawn ✓
  t=1s:  Task #2 → delay not met → skip
  t=10s: Task #3 → spawn ✓
  t=20s: Task #4 → spawn ✓
```

**Code**: `src/services/handlers/worker-handler.ts:373-415` (processNextTask)

#### Layer 3: Resource Monitoring

**Pre-spawn validation**: Checks CPU and memory availability before each spawn attempt.

**Code**: `src/services/handlers/worker-handler.ts:242-285` (canSpawnWorker)

**Incident Reference**: 2025-12-06 TOCTOU race in spawn delay check

### 2. Stale Task Detection (RecoveryManager)

**Problem**: Crashed tasks stuck in RUNNING status cause fork-bomb on restart.

**Solution**: 30-minute threshold - old tasks marked FAILED, recent tasks re-queued.

```
Server restart with 10 RUNNING tasks:

Age > 30 min (7 tasks):  MARK AS FAILED (don't re-queue)
Age < 30 min (3 tasks):  RE-QUEUE (might be legitimate)

Result: Only 3 workers spawn instead of 10
```

**Code**: `src/services/recovery-manager.ts:88-175`

### 3. Handler Profiling (EventBus)

**Problem**: Slow handlers block event processing.

**Solution**: Automatic timing with warnings for handlers >100ms.

**Code**: `src/core/events/event-bus.ts:157-211`

## Event Handler Registration

Most handlers follow this standard pattern:

```typescript
class MyHandler extends BaseEventHandler {
  async setup(eventBus: EventBus): Promise<Result<void>> {
    const subscriptions = [
      eventBus.subscribe('EventType', this.handleEvent.bind(this))
    ];

    for (const result of subscriptions) {
      if (!result.ok) return result;
    }

    return ok(undefined);
  }

  private async handleEvent(event: EventType): Promise<void> {
    await this.handleEvent(event, async (evt) => {
      // Handler logic here
      return ok(undefined);
    });
  }
}
```

**Exception: Factory Pattern for Async Initialization**

Handlers requiring async initialization (e.g., loading data from database) use factory pattern instead:

```typescript
class DependencyHandler extends BaseEventHandler {
  private constructor(/* dependencies + initialized state */) {
    super(logger, 'DependencyHandler');
  }

  static async create(
    /* dependencies */
  ): Promise<Result<DependencyHandler>> {
    // Load initial state asynchronously
    const data = await repository.loadData();
    if (!data.ok) return data;

    // Create handler with initialized state
    const handler = new DependencyHandler(/* deps + state */);

    // Subscribe to events
    await handler.subscribeToEvents();

    return ok(handler);
  }
}

// Usage in bootstrap
const handlerResult = await DependencyHandler.create(/* deps */);
if (!handlerResult.ok) return handlerResult;
const handler = handlerResult.value;
```

**Why Factory Pattern?**
- Eliminates definite assignment assertions for async-initialized fields
- Makes invalid states unrepresentable (can't use handler before initialization)
- Follows Result pattern consistently
- Prevents TOCTOU issues by loading state before handler is active

## Centralized Handler Setup (v0.3.4+)

Handler creation and initialization is centralized in `src/services/handler-setup.ts` to improve maintainability and enable easy handler additions for v0.4.0.

### Two-Step Initialization Pattern

```typescript
// In bootstrap.ts - inside taskManager registration

// Step 1: Extract dependencies from container
const depsResult = extractHandlerDependencies(container);
if (!depsResult.ok) return depsResult;

// Step 2: Setup all handlers
const setupResult = await setupEventHandlers(depsResult.value);
if (!setupResult.ok) return setupResult;

// Step 3: Register for lifecycle management
const { registry, dependencyHandler } = setupResult.value;
container.registerValue('handlerRegistry', registry);
container.registerValue('dependencyHandler', dependencyHandler);
```

### Handler Types

| Pattern | Handlers | When to Use |
|---------|----------|-------------|
| **Standard** (via registry) | PersistenceHandler, QueueHandler, WorkerHandler | Synchronous initialization, uses `setup(eventBus)` |
| **Factory** (returned separately) | DependencyHandler, ScheduleHandler, CheckpointHandler | Requires async initialization (loading state from DB) |

### Adding New Handlers (v0.4.0+)

To add a new handler, modify only `src/services/handler-setup.ts`:

```typescript
// In setupEventHandlers() - add to standardHandlers array:
const standardHandlers = [
  // ... existing handlers ...

  // NEW: Task Resumption Handler for v0.4.0
  new TaskResumptionHandler(
    deps.taskRepository,
    eventBus,
    childLogger('TaskResumption')
  ),

  // NEW: Task Scheduling Handler for v0.4.0
  new TaskSchedulingHandler(
    deps.config,
    eventBus,
    childLogger('TaskScheduling')
  ),
];
```

No changes needed to `bootstrap.ts` - the registry handles initialization automatically.

### Benefits

1. **Single Location**: All handler creation in one file
2. **Testable**: `setupEventHandlers()` can be tested with mock dependencies
3. **Clear Dependencies**: `HandlerDependencies` interface documents requirements
4. **Unified Lifecycle**: Registry enables coordinated shutdown
5. **Separation of Concerns**: bootstrap.ts handles DI, handler-setup.ts handles event wiring

### Architecture Decision

**Why separate from bootstrap.ts?**

Before v0.3.4, bootstrap.ts was ~525 lines with handler creation mixed into DI registration. This made it difficult to:
- Add new handlers without touching complex bootstrap logic
- Test handler setup independently
- Understand the handler initialization order

The extraction reduces bootstrap.ts by ~28% and makes the handler setup pattern explicit and reusable.

## Debugging Event Flows

Enable debug logging to see full event flow:

```bash
LOG_LEVEL=debug beat mcp start
```

You'll see:
- Event emissions with IDs and timestamps
- Handler execution times
- Correlation IDs for request-response
- Slow handler warnings
- Full event payloads

## Architecture Benefits

1. **Loose Coupling**: Components don't know about each other
2. **Testability**: Mock EventBus for unit tests
3. **Observability**: All operations logged centrally
4. **Performance**: Automatic profiling catches slow handlers
5. **Reliability**: Request timeouts prevent hanging queries
6. **Safety**: Built-in safeguards prevent fork-bombs and race conditions

## Future Improvements

See removal criteria in:
- `WorkerHandler` spawn serialization - documented in `docs/architecture/HANDLER-DECOMPOSITION-INVARIANTS.md`
- `RecoveryManager` stale detection - see JSDoc in `src/services/recovery-manager.ts`

Only remove these safeguards if you implement the suggested alternatives.
