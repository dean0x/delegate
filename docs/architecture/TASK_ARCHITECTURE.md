# Backbeat Task Dependency Architecture - Comprehensive Analysis

## Executive Summary

Backbeat has **already implemented a sophisticated task dependency system** (Phase 4) with:
- Directed Acyclic Graph (DAG) validation with cycle detection
- Event-driven dependency resolution
- Persistent task dependency relationships in SQLite
- Blocked task queuing (tasks don't execute until dependencies complete)
- Automatic unblocking when dependencies resolve

The system is **production-ready** but not yet fully integrated with CLI commands and MCP tools.

---

## 1. TASK DATA MODEL

### 1.1 Core Task Interface
**File**: `/workspace/backbeat/src/core/domain.ts` (Lines 28-82)

```typescript
export interface Task {
  readonly id: TaskId;
  readonly prompt: string;
  readonly status: TaskStatus;  // 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  readonly priority: Priority;   // P0 | P1 | P2
  
  // Dependency tracking fields (Lines 64-72):
  readonly dependsOn?: readonly TaskId[];           // Tasks this task depends on (blocking)
  readonly dependents?: readonly TaskId[];          // Tasks that depend on this task (blocked)
  readonly dependencyState?: 'blocked' | 'ready' | 'none'; // Computed dependency state
  
  // ... other fields (retry tracking, execution control, timestamps)
}
```

**Key Points**:
- `dependsOn`: Array of TaskId this task is blocked by (cannot run until these complete)
- `dependents`: Array of TaskId that are blocked waiting for this task
- `dependencyState`: Derived field indicating if task is blocked/ready/has no dependencies
- Fields are **read-only** (immutable by design)

### 1.2 TaskRequest Interface
**File**: `/workspace/backbeat/src/core/domain.ts` (Lines 108-138)

```typescript
export interface TaskRequest {
  readonly prompt: string;
  readonly priority?: Priority;
  // ...
  
  // Dependency tracking (Phase 4: Task Dependencies)
  // Array of task IDs this task depends on (must complete before this task can run)
  readonly dependsOn?: readonly TaskId[];
}
```

**Creation Factory**:
```typescript
export const createTask = (request: TaskRequest): Task => ({
  // ... other fields
  dependsOn: request.dependsOn,                                    // Line 190
  dependents: undefined,                                            // Populated by DependencyRepository
  dependencyState: request.dependsOn && request.dependsOn.length > 0 ? 'blocked' : 'none',
  // ...
});
```

---

## 2. TASK LIFECYCLE

### 2.1 Lifecycle States
**File**: `/workspace/backbeat/src/core/domain.ts` (Lines 20-26)

```typescript
enum TaskStatus {
  QUEUED = 'queued',      // Ready to run or blocked by dependencies
  RUNNING = 'running',    // Executing
  COMPLETED = 'completed', // Terminal state
  FAILED = 'failed',       // Terminal state
  CANCELLED = 'cancelled', // Terminal state
}
```

### 2.2 Lifecycle with Dependencies
The dependency system integrates at these lifecycle points:

1. **TaskDelegated** → Task created with `dependsOn` list
   - **Handler**: `DependencyHandler` (Lines 108-130)
   - **Action**: Validates dependencies for cycles, adds to dependency graph
   
2. **Task saved to database** → PersistenceHandler calls QueueHandler directly
   - **Handler**: `PersistenceHandler` → `QueueHandler.enqueueIfReady()`
   - **Action**: Checks if task is blocked; only enqueues if not blocked

3. **TaskQueued** → Task ready to execute (only if not blocked)
   - **Handler**: `WorkerHandler` spawns worker
   
4. **TaskCompleted/Failed/Cancelled** → Task terminal state
   - **Handler**: `DependencyHandler` (Lines 414-518)
   - **Action**: Resolves dependencies, emits `TaskUnblocked` for dependents

5. **TaskUnblocked** → Dependent tasks now ready (all dependencies met)
   - **Handler**: `QueueHandler` (Lines 288-345)
   - **Action**: Enqueues unblocked tasks for execution

### 2.3 Complete Flow Diagram

```
User delegates task with dependsOn=[task-A, task-B]
                    ↓
            [TaskDelegatedEvent]
                    ↓
      DependencyHandler checks for cycles (DAG validation)
                    ↓
      PersistenceHandler saves to DB
                    ↓
      PersistenceHandler → QueueHandler.enqueueIfReady(task)
                    ↓
      QueueHandler checks: isBlocked(task)?
                    ↓
          Is blocked? YES → Wait for TaskUnblocked
          Is blocked? NO → Enqueue for execution
                    ↓
            [TaskQueuedEvent]
                    ↓
        WorkerHandler spawns worker
                    ↓
    Task executes, then: TaskCompleted/Failed/Cancelled
                    ↓
      DependencyHandler resolves dependencies:
      - Gets all dependents (tasks waiting for this task)
      - Marks dependency as 'completed'/'failed'/'cancelled'
                    ↓
      For each dependent: isBlocked(dependent)?
      If not blocked → [TaskUnblockedEvent]
                    ↓
      QueueHandler enqueues unblocked task
```

---

## 3. EVENT SYSTEM FOR DEPENDENCIES

### 3.1 Dependency-Related Events
**File**: `/workspace/backbeat/src/core/events/events.ts` (Lines 184-213)

```typescript
// Event: A dependency was added to the graph
export interface TaskDependencyAddedEvent extends BaseEvent {
  type: 'TaskDependencyAdded';
  taskId: TaskId;
  dependsOnTaskId: TaskId;
}

// Event: A dependency was resolved (blocking task completed)
export interface TaskDependencyResolvedEvent extends BaseEvent {
  type: 'TaskDependencyResolved';
  taskId: TaskId;
  dependsOnTaskId: TaskId;
  resolution: 'completed' | 'failed' | 'cancelled'; // How blocking task resolved
}

// Event: A task is now unblocked (all dependencies resolved)
export interface TaskUnblockedEvent extends BaseEvent {
  type: 'TaskUnblocked';
  taskId: TaskId;
  task: Task;  // Full task included to prevent layer violations
}

// Event: A dependency failed (used for error tracking)
export interface TaskDependencyFailedEvent extends BaseEvent {
  type: 'TaskDependencyFailed';
  taskId: TaskId;
  failedDependencyId: TaskId;
  error: BackbeatError;
  requestedDependencies?: readonly TaskId[];  // All deps that were requested
}

```

### 3.2 Event Flow Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ DEPENDENCY HANDLER - Manages DAG & Dependency Resolution    │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  TaskDelegated → Adds dependencies + validates for cycles   │
│                 Emits: TaskDependencyAdded                  │
│                                                               │
│  TaskCompleted/Failed/Cancelled → Resolves dependencies     │
│                 Emits: TaskDependencyResolved               │
│                 Checks dependents → TaskUnblocked           │
│                                                               │
│  Emits: TaskDependencyFailed if cycle detected              │
└─────────────────────────────────────────────────────────────┘
        ↓
┌─────────────────────────────────────────────────────────────┐
│ QUEUE HANDLER - Manages Blocked/Ready Task Queueing         │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  enqueueIfReady(task) → Check: isBlocked(task)?             │
│    (called directly by PersistenceHandler after save)       │
│                 Not blocked → Enqueue                       │
│                 Blocked → Wait                              │
│                 Emits: TaskQueued                           │
│                                                               │
│  TaskUnblocked → Enqueue unblocked task                     │
│                 Emits: TaskQueued                           │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. DATABASE SCHEMA

### 4.1 Task Dependencies Table
**File**: `/workspace/backbeat/src/implementations/database.ts` (Lines 146-158)

```sql
CREATE TABLE IF NOT EXISTS task_dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  depends_on_task_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolution TEXT NOT NULL DEFAULT 'pending',  -- 'pending'|'completed'|'failed'|'cancelled'
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (depends_on_task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  UNIQUE(task_id, depends_on_task_id)
);
```

**Indexes for Performance**:
```sql
CREATE INDEX idx_task_dependencies_task_id ON task_dependencies(task_id);
CREATE INDEX idx_task_dependencies_depends_on ON task_dependencies(depends_on_task_id);
CREATE INDEX idx_task_dependencies_resolution ON task_dependencies(resolution);
CREATE INDEX idx_task_dependencies_blocked ON task_dependencies(task_id, resolution);
```

### 4.2 Relationship Model

```
tasks table:
┌─────────────────────────────────────┐
│ id (PK)                             │
│ prompt, status, priority, ...       │
└─────────────────────────────────────┘
         ↑                    ↑
         │                    │
         │ Foreign Key        │ Foreign Key
         │ (depends_on)       │ (task_id)
         │                    │
┌─────────────────────────────────────────────────┐
│ task_dependencies                               │
├─────────────────────────────────────────────────┤
│ id (PK)                                         │
│ task_id (FK to tasks)                          │
│ depends_on_task_id (FK to tasks)               │
│ created_at, resolved_at, resolution            │
│ UNIQUE(task_id, depends_on_task_id)            │
└─────────────────────────────────────────────────┘
```

**Resolution States** (enforced by CHECK constraint since v0.3.2):
- `'pending'`: Dependency not yet resolved (blocking task still running)
- `'completed'`: Blocking task completed successfully
- `'failed'`: Blocking task failed
- `'cancelled'`: Blocking task was cancelled

---

## 5. QUEUE IMPLEMENTATION WITH DEPENDENCY AWARENESS

### 5.1 Priority Task Queue
**File**: `/workspace/backbeat/src/implementations/task-queue.ts`

```typescript
export class PriorityTaskQueue implements TaskQueue {
  private readonly heap: Task[] = [];              // Min-heap for O(log n) ops
  private readonly taskIndex: Map<TaskId, number>; // O(1) lookup
  
  enqueue(task: Task): Result<void> {
    // Performance: O(log n) heap insertion
  }
  
  dequeue(): Result<Task | null> {
    // Get highest priority task
    // Performance: O(log n)
  }
}
```

**Performance Characteristics**:
- `enqueue()`: O(log n)
- `dequeue()`: O(log n)
- `remove()`: O(log n)
- `contains()`: O(1) with index

### 5.2 Dependency-Aware Queueing
**File**: `/workspace/backbeat/src/services/handlers/queue-handler.ts`

#### enqueueIfReady (called directly by PersistenceHandler)
```typescript
async enqueueIfReady(task: Task): Promise<Result<void>> {
  // Check if task is blocked by dependencies
  const isBlockedResult = await this.dependencyRepo.isBlocked(task.id);

  if (isBlockedResult.value) {
    // Task is blocked - do NOT enqueue yet
    logger.info('Task blocked by dependencies - waiting for TaskUnblocked event');
    return;
  }

  // Task is not blocked - safe to enqueue
  this.queue.enqueue(task);
  this.eventBus.emit('TaskQueued', { taskId, task });
}
```

#### TaskUnblocked Handler (Lines 288-345)
```typescript
private async handleTaskUnblocked(event: TaskUnblockedEvent): Promise<void> {
  // Task has all dependencies resolved - now queue it
  this.queue.enqueue(event.task);
  this.eventBus.emit('TaskQueued', { taskId, task });
}
```

**Key Pattern**: Tasks are held OUT of queue until all dependencies complete.

---

## 6. DEPENDENCY RESOLUTION SYSTEM

### 6.1 Dependency Repository
**File**: `/workspace/backbeat/src/implementations/dependency-repository.ts`

```typescript
export interface DependencyRepository {
  // Add a dependency with cycle detection
  addDependency(taskId: TaskId, dependsOnTaskId: TaskId): Promise<Result<TaskDependency>>;
  
  // Get all tasks this task depends on
  getDependencies(taskId: TaskId): Promise<Result<readonly TaskDependency[]>>;
  
  // Get all tasks that depend on this task
  getDependents(taskId: TaskId): Promise<Result<readonly TaskDependency[]>>;
  
  // Mark a dependency as resolved (when blocking task completes)
  resolveDependency(taskId, dependsOnTaskId, resolution): Promise<Result<void>>;
  
  // Get unresolved dependencies (still blocking)
  getUnresolvedDependencies(taskId: TaskId): Promise<Result<readonly TaskDependency[]>>;
  
  // Check if task is blocked (has unresolved dependencies)
  isBlocked(taskId: TaskId): Promise<Result<boolean>>;
}
```

#### Key Implementation: Cycle Detection
**File**: `/workspace/backbeat/src/implementations/dependency-repository.ts` (Lines 91-187)

```typescript
async addDependency(taskId: TaskId, dependsOnTaskId: TaskId): Promise<Result<TaskDependency>> {
  // Uses SQLite transaction for TOCTOU safety
  const addDependencyTransaction = this.db.transaction((taskId, dependsOnTaskId) => {
    // 1. Validate both tasks exist
    if (!taskExists(taskId)) throw TaskNotFound;
    if (!taskExists(dependsOnTaskId)) throw TaskNotFound;
    
    // 2. Check dependency already exists
    if (dependencyExists(taskId, dependsOnTaskId)) throw AlreadyExists;
    
    // 3. Build dependency graph from all dependencies
    const graph = new DependencyGraph(allDependencies);
    
    // 4. Check if adding this edge would create cycle
    const cycleCheck = graph.wouldCreateCycle(taskId, dependsOnTaskId);
    if (cycleCheck) throw CycleDetected;
    
    // 5. Insert dependency
    return this.addDependencyStmt.run(taskId, dependsOnTaskId, createdAt);
  });
}
```

**Atomicity**: Uses `db.transaction()` (synchronous) for true ACID compliance.

### 6.2 Dependency Handler - Resolution Flow
**File**: `/workspace/backbeat/src/services/handlers/dependency-handler.ts`

**DoS Prevention**: Handler enforces `MAX_DEPENDENCY_CHAIN_DEPTH = 100` to prevent deep dependency chains that could cause performance degradation or stack overflow during graph traversal.

#### Dependency Addition (Lines 293-348)
```typescript
private async handleTaskDelegated(event: TaskDelegatedEvent): Promise<void> {
  const task = event.task;

  if (!task.dependsOn || task.dependsOn.length === 0) {
    return;  // No dependencies
  }

  // Validate all dependencies in parallel (PERFORMANCE: Issue #14)
  const validationResults = await Promise.all(
    task.dependsOn.map(depId => this.validateSingleDependency(task.id, depId))
  );

  // Check for validation failures (fail-fast on first error)
  const failure = validationResults.find(r => r.error !== null);
  if (failure && failure.error) {
    await this.handleValidationFailure(task.id, task.dependsOn, failure);
    return err(failure.error);
  }

  // Persist to database (only after all validations pass)
  const addResult = await this.dependencyRepo.addDependencies(task.id, task.dependsOn);
  if (!addResult.ok) return addResult;

  // Update graph and emit success events
  this.updateGraphAfterPersistence(addResult.value);
  await this.emitDependencyAddedEvents(addResult.value);
}
```

#### Dependency Resolution (Lines 414-518)
```typescript
private async handleTaskCompleted(event: TaskCompletedEvent): Promise<void> {
  await this.resolveDependencies(event.taskId, 'completed');
}

private async resolveDependencies(
  completedTaskId: TaskId,
  resolution: 'completed' | 'failed' | 'cancelled'
): Promise<Result<void>> {
  // Get dependents BEFORE batch resolution for event emission
  const dependentsResult = await this.dependencyRepo.getDependents(completedTaskId);
  const dependents = dependentsResult.value;

  // PERFORMANCE: Batch resolve ALL dependencies in single UPDATE query (7-10× faster)
  await this.dependencyRepo.resolveDependenciesBatch(completedTaskId, resolution);

  // Emit resolution events and check for unblocked tasks
  for (const dep of dependents) {
    if (dep.resolution !== 'pending') continue;

    await this.eventBus.emit('TaskDependencyResolved', {
      taskId: dep.taskId,
      dependsOnTaskId: dep.dependsOnTaskId,
      resolution
    });

    // Check if this task is now unblocked
    const isBlockedResult = await this.dependencyRepo.isBlocked(dep.taskId);

    if (!isBlockedResult.value) {
      // Task is unblocked - fetch and emit event
      const taskResult = await this.taskRepo.findById(dep.taskId);
      await this.eventBus.emit('TaskUnblocked', {
        taskId: dep.taskId,
        task: taskResult.value
      });
    }
  }
}
```

---

## 7. DEPENDENCY GRAPH - CYCLE DETECTION

### 7.1 Dependency Graph Class
**File**: `/workspace/backbeat/src/core/dependency-graph.ts`

```typescript
export class DependencyGraph {
  // Adjacency list: taskId -> set of tasks it depends on
  private readonly graph: Map<string, Set<string>>;
  
  // Reverse adjacency list: taskId -> set of tasks that depend on it
  private readonly reverseGraph: Map<string, Set<string>>;
}
```

### 7.2 Cycle Detection Algorithm
**File**: `/workspace/backbeat/src/core/dependency-graph.ts` (Lines 339-433)

```typescript
wouldCreateCycle(taskId: TaskId, dependsOnTaskId: TaskId): Result<boolean> {
  // 1. Check self-dependency
  if (taskId === dependsOnTaskId) return ok(true);

  // 2. Create temporary graph with proposed edge (DEEP COPY required!)
  // Shallow copy (new Map(this.graph)) corrupts graph - Set values are references
  const tempGraph = new Map(
    Array.from(this.graph.entries()).map(([k, v]) => [k, new Set(v)])
  );
  tempGraph.get(taskId)!.add(dependsOnTaskId);
  
  // 3. Run DFS to detect cycle
  // A cycle exists if we can reach taskId from dependsOnTaskId
  const visited = new Set<string>();
  const recursionStack = new Set<string>();
  
  const hasCycle = this.detectCycleDFS(
    dependsOnTaskId,    // Start from the dependency
    tempGraph,
    visited,
    recursionStack,
    taskId              // Target to look for (if reached, cycle exists)
  );
  
  return ok(hasCycle);
}

private detectCycleDFS(
  node: string,
  graph: Map<string, Set<string>>,
  visited: Set<string>,
  recursionStack: Set<string>,
  target?: string
): boolean {
  // If we reached the target, cycle detected
  if (target && node === target) return true;
  
  // If node is in current path, we found a cycle
  if (recursionStack.has(node)) return true;
  
  // If already fully visited, no cycle from this path
  if (visited.has(node)) return false;
  
  // Mark as visited and add to current path
  visited.add(node);
  recursionStack.add(node);
  
  // Recurse through dependencies
  const dependencies = graph.get(node);
  for (const dep of dependencies || []) {
    if (this.detectCycleDFS(dep, graph, visited, recursionStack, target)) {
      return true;
    }
  }
  
  // Backtrack - remove from current path
  recursionStack.delete(node);
  
  return false;
}
```

**Algorithm Details**:
- **Time Complexity**: O(V + E) where V=tasks, E=dependencies
- **Space Complexity**: O(V)
- **Pattern**: DFS-based cycle detection with recursion stack
- **Atomicity**: Run inside database transaction for TOCTOU safety

### 7.3 Additional Graph Operations

```typescript
// Get all tasks this task depends on (transitive closure)
getAllDependencies(taskId: TaskId): Result<readonly TaskId[]>

// Get all tasks that depend on this task (transitive closure)
getAllDependents(taskId: TaskId): Result<readonly TaskId[]>

// Get direct dependencies only
getDirectDependencies(taskId: TaskId): Result<readonly TaskId[]>

// Topological sort: returns tasks in execution order
topologicalSort(): Result<readonly TaskId[]>
```

---

## 8. KEY ARCHITECTURAL PATTERNS

### 8.1 Result Type Pattern
**File**: `/workspace/backbeat/src/core/result.ts`

Never throws errors. All functions return `Result<T>`:

```typescript
type Result<T, E = Error> = 
  | { ok: true; value: T }
  | { ok: false; error: E };
```

**Usage in Dependencies**:
```typescript
// Always check .ok before accessing value
const result = await dependencyRepo.isBlocked(taskId);
if (!result.ok) {
  logger.error('Failed to check blocked status', result.error);
  return result;
}

if (result.value) {
  // Task is blocked
}
```

### 8.2 Immutability
All Task fields are `readonly`:
```typescript
export interface Task {
  readonly id: TaskId;
  readonly dependsOn?: readonly TaskId[];
  // ...
}
```

Creates new task when updating:
```typescript
const updatedTask = { ...task, status: TaskStatus.COMPLETED };
```

### 8.3 Dependency Injection
All components receive dependencies in constructor. For handlers requiring async initialization, use factory pattern:

```typescript
// Standard handler - constructor pattern
export class QueueHandler extends BaseEventHandler {
  constructor(
    private readonly queue: TaskQueue,
    logger: Logger
  ) { }
}

// Handler with async initialization - factory pattern
export class DependencyHandler extends BaseEventHandler {
  private constructor(
    private readonly dependencyRepo: DependencyRepository,
    private readonly taskRepo: TaskRepository,
    logger: Logger,
    eventBus: EventBus,
    graph: DependencyGraph
  ) {
    super(logger, 'DependencyHandler');
    this.eventBus = eventBus;
    this.graph = graph;
  }

  static async create(
    dependencyRepo: DependencyRepository,
    taskRepo: TaskRepository,
    logger: Logger,
    eventBus: EventBus
  ): Promise<Result<DependencyHandler>> {
    // Initialize dependency graph from database
    const allDeps = await dependencyRepo.findAll();
    if (!allDeps.ok) return allDeps;

    const graph = new DependencyGraph(allDeps.value);
    const handler = new DependencyHandler(
      dependencyRepo,
      taskRepo,
      logger,
      eventBus,
      graph
    );

    // Subscribe to events
    await handler.subscribeToEvents();

    return ok(handler);
  }
}

// Usage in bootstrap
const handlerResult = await DependencyHandler.create(
  dependencyRepo,
  taskRepo,
  logger,
  eventBus
);
if (!handlerResult.ok) return handlerResult;
const dependencyHandler = handlerResult.value;
```

**Why Factory Pattern?**
- Makes invalid states unrepresentable (graph always initialized)
- Eliminates definite assignment assertions (`graph!: DependencyGraph`)
- Follows Result pattern for async initialization
- Self-documenting API (can't accidentally use uninitialized handler)

### 8.4 Hybrid Event-Driven Architecture
Commands (state changes) flow through events; queries use direct repository access:
1. **Commands**: Fire-and-forget `emit()` for state changes (TaskDelegated, TaskCompleted, etc.)
2. **Queries**: Direct repository calls (`taskRepo.findById()`, `taskRepo.findAllUnbounded()`)
3. **Linearized triggers**: Direct handler calls where event indirection adds no value (e.g., `PersistenceHandler` calls `QueueHandler.enqueueIfReady()` directly after save)

---

## 9. FILE REFERENCE GUIDE

| Component | File Path | Key Lines |
|-----------|-----------|-----------|
| Task Domain Model | `/workspace/backbeat/src/core/domain.ts` | 28-82, 108-138, 162-199 |
| TaskRequest | `/workspace/backbeat/src/core/domain.ts` | 108-138 |
| TaskStatus Enum | `/workspace/backbeat/src/core/domain.ts` | 20-26 |
| Task Interfaces | `/workspace/backbeat/src/core/interfaces.ts` | 94-144 |
| Events | `/workspace/backbeat/src/core/events/events.ts` | 184-213, 237-276 |
| DependencyGraph | `/workspace/backbeat/src/core/dependency-graph.ts` | Full file |
| Cycle Detection | `/workspace/backbeat/src/core/dependency-graph.ts` | 73-162 |
| DependencyRepository | `/workspace/backbeat/src/implementations/dependency-repository.ts` | Full file |
| Database Schema | `/workspace/backbeat/src/implementations/database.ts` | 146-158 |
| DependencyHandler | `/workspace/backbeat/src/services/handlers/dependency-handler.ts` | Full file |
| QueueHandler | `/workspace/backbeat/src/services/handlers/queue-handler.ts` | 62-355 |
| PriorityTaskQueue | `/workspace/backbeat/src/implementations/task-queue.ts` | Full file |
| Result Type | `/workspace/backbeat/src/core/result.ts` | Full file |
| Errors | `/workspace/backbeat/src/core/errors.ts` | Full file |

---

## 10. WHAT'S MISSING / TODO

### 10.1 CLI Integration
- `beat run --depends-on <task-id1>,<task-id2> "command"`
- `beat status --show-dependencies`
- Visual dependency graph display

### 10.2 MCP Tool Integration
- `DelegateTaskWithDependencies` MCP tool
- Expose dependency query endpoints

### 10.3 Dependency Failure Handling
- Currently: If dependency fails, dependent task gets unblocked with 'failed' resolution
- TODO: Option to auto-fail dependent tasks instead of queuing them

### 10.4 Retry Tracking with Dependencies
- Retry tracking implemented separately (parentTaskId, retryOf)
- TODO: Integrate with dependency system (should retried task maintain dependencies?)

---

## 11. CURRENT STATE SUMMARY

**Status**: Task Dependencies (v0.3.0+) is **complete**

### What's Implemented:
- ✅ DAG-based dependency model with cycle detection
- ✅ Persistent storage in SQLite with batch resolution
- ✅ Event-driven dependency resolution
- ✅ Blocked task queueing (dependencies prevent execution)
- ✅ Automatic unblocking when dependencies complete
- ✅ Atomic operations (database transactions)
- ✅ Performance optimized (caching, batch operations, O(V+E) cycle detection)
- ✅ MCP `DelegateTask` tool supports `dependsOn` parameter
- ✅ TaskStatus shows dependency state (blocked/ready/none)
- ✅ Security limits (100 deps/task, 100 chain depth)

### Future Enhancements (not blocking):
- ⚠️ CLI commands for declaring dependencies (use MCP tool for now)
- ⚠️ Dependency visualization/querying endpoints
- ⚠️ Configurable dependency failure policies

---

## 12. IMPLEMENTATION GUIDELINES

When implementing task dependency features, follow these principles:

### Error Handling
Always use Result type, never throw:
```typescript
async addDependency(taskId, dependsOnTaskId): Promise<Result<TaskDependency>> {
  // ✅ GOOD
  if (!exists) return err(new BackbeatError(ErrorCode.TASK_NOT_FOUND, ...));
  
  // ❌ BAD
  if (!exists) throw new Error("Not found");
}
```

### Hybrid Pattern: Events vs Direct Access
Commands (state changes) use events; queries use direct repository access:
```typescript
// ✅ GOOD - Events for commands/state changes
this.eventBus.emit('TaskDependencyAdded', { taskId, dependsOnTaskId });

// ✅ GOOD - Direct repository access for reads/queries
const task = await this.taskRepo.findById(taskId);
const tasks = await this.taskRepo.findAllUnbounded();

// ✅ GOOD - Direct handler calls for linearized trigger chains
await this.queueHandler.enqueueIfReady(task);

// ❌ BAD - Events for simple queries (unnecessary indirection)
const task = await this.eventBus.request('GetTask', { taskId });
```

### Atomicity
Use database transactions for multi-step operations:
```typescript
// ✅ GOOD - Atomic
const result = this.db.transaction(() => {
  // All operations here are atomic
  this.checkTaskExists(taskId);
  this.checkDependencyWouldNotCreateCycle();
  this.insertDependency();
})();

// ❌ BAD - Race condition possible
this.checkTaskExists();
this.checkDependencyWouldNotCreateCycle();
this.insertDependency();
```

### Immutability
Never mutate task objects:
```typescript
// ✅ GOOD
const updated = { ...task, status: TaskStatus.COMPLETED };

// ❌ BAD
task.status = TaskStatus.COMPLETED;
```

