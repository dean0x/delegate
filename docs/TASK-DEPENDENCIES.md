# Task Dependencies

Backbeat supports task dependencies through a DAG (Directed Acyclic Graph) based dependency system. Tasks can depend on other tasks, and Backbeat ensures that dependent tasks only execute after their dependencies have completed.

## Architecture

### Overview

The task dependency system is built on these core components:

1. **DependencyRepository** - Persists and queries task dependencies
2. **DependencyGraph** - Validates dependency DAG and detects cycles
3. **DependencyHandler** - Event handler that manages dependency lifecycle
4. **QueueHandler** - Modified to be dependency-aware (blocks tasks with unresolved dependencies)

### Session Continuation (`continueFrom`)

Tasks can use the `continueFrom` field to receive checkpoint context from a completed dependency. When set, the dependent task's prompt is automatically enriched with the dependency's output summary, git state, and error information before execution.

```typescript
// Build task runs first
const build = await taskManager.delegate({
  prompt: 'npm run build',
  priority: Priority.P1
});

// Test task receives build's checkpoint context in its prompt
const test = await taskManager.delegate({
  prompt: 'npm test',
  dependsOn: [build.value.id],
  continueFrom: build.value.id
});
```

**Key behaviors:**
- `continueFrom` must reference a task in the `dependsOn` list (auto-added if missing)
- Uses subscribe-first pattern with 5-second timeout for race-safe checkpoint retrieval
- Supports chains: A→B→C where B receives A's context, and C receives B's (which includes A's)

**CLI:**
```bash
beat run "npm test" --depends-on task-abc123 --continue-from task-abc123
```

### Dependency-Aware Queueing

**Key Principle**: Tasks are only enqueued when all dependencies are resolved.

```
┌──────────────┐
│  Task Created│
└──────┬───────┘
       │
       ▼
┌──────────────┐
│Has Dependencies?│──No──▶┌─────────┐
└──────┬───────┘          │ Enqueue │
       │Yes               └─────────┘
       ▼
┌──────────────┐
│Check if Blocked│
└──────┬───────┘
       │
       ├─Blocked──▶┌──────────────┐
       │           │Wait for Event│
       │           └──────────────┘
       │
       └─Not Blocked──▶┌─────────┐
                       │ Enqueue │
                       └─────────┘
```

When a dependency completes:
1. `DependencyHandler` resolves the dependency
2. Checks if dependent task is now unblocked
3. Emits `TaskUnblocked` event
4. `QueueHandler` receives event and enqueues the task

### Event Flow

```
TaskDelegated
  │
  ├─▶ DependencyHandler.handleTaskDelegated()
  │     └─▶ Validates DAG (cycle detection)
  │     └─▶ Persists dependencies
  │
  └─▶ TaskPersisted
        │
        └─▶ QueueHandler.handleTaskPersisted()
              └─▶ Checks if task is blocked
                    ├─ Blocked: Skip enqueueing
                    └─ Not Blocked: Enqueue task

TaskCompleted/Failed/Cancelled
  │
  └─▶ DependencyHandler.handleTaskCompleted()
        └─▶ Resolves dependencies
        └─▶ Checks dependent tasks
              └─▶ If unblocked: Emits TaskUnblocked
                    │
                    └─▶ QueueHandler.handleTaskUnblocked()
                          └─▶ Enqueues unblocked task
```

### DAG Validation

The system uses Depth-First Search (DFS) to detect cycles before adding dependencies:

```typescript
// Pseudo-code for cycle detection
wouldCreateCycle(taskId, dependsOnTaskId):
  graph = buildGraph(existingDependencies)

  // Check if adding this edge would create a cycle
  if canReach(dependsOnTaskId, taskId, graph):
    return true  // Cycle detected!

  return false
```

**Examples:**
- ✅ `A → B → C` (valid chain)
- ✅ `A → B, A → C, B → D, C → D` (valid diamond pattern)
- ❌ `A → B → C → A` (cycle - rejected)
- ❌ `A → A` (self-dependency - rejected)

## API Reference

### Task Manager

#### `delegate(options)`

Delegate a new task with optional dependencies.

```typescript
interface TaskOptions {
  prompt: string;
  priority?: Priority;
  dependsOn?: TaskId[];  // Array of task IDs this task depends on
  // ... other options
}

// Example
await taskManager.delegate({
  prompt: 'Run tests',
  priority: Priority.P1,
  dependsOn: ['build-task-id']
});
```

### Dependency Repository

#### `addDependency(taskId, dependsOnTaskId)`

Add a dependency relationship between two tasks.

```typescript
const result = await dependencyRepo.addDependency(
  'task-b' as TaskId,
  'task-a' as TaskId
);

if (result.ok) {
  console.log('Dependency added:', result.value);
} else {
  console.error('Failed:', result.error.message);
}
```

**Returns:**
- `Result<TaskDependency>` with created dependency
- Error if cycle would be created or dependency already exists

#### `getDependencies(taskId)`

Get all tasks that a given task depends on.

```typescript
const result = await dependencyRepo.getDependencies('task-b' as TaskId);

if (result.ok) {
  for (const dep of result.value) {
    console.log(`Task ${dep.taskId} depends on ${dep.dependsOnTaskId}`);
    console.log(`Resolution: ${dep.resolution}`); // 'pending' | 'completed' | 'failed' | 'cancelled'
  }
}
```

#### `getDependents(taskId)`

Get all tasks that depend on a given task.

```typescript
const result = await dependencyRepo.getDependents('task-a' as TaskId);

if (result.ok) {
  console.log(`${result.value.length} tasks depend on task-a`);
}
```

#### `isBlocked(taskId)`

Check if a task is blocked by unresolved dependencies.

```typescript
const result = await dependencyRepo.isBlocked('task-b' as TaskId);

if (result.ok) {
  if (result.value) {
    console.log('Task is blocked - waiting for dependencies');
  } else {
    console.log('Task is ready to execute');
  }
}
```

**Note:** A task is considered blocked if it has ANY dependencies with `resolution = 'pending'`.

#### `resolveDependency(taskId, dependsOnTaskId, resolution)`

Resolve a dependency with a specific resolution state.

```typescript
await dependencyRepo.resolveDependency(
  'task-b' as TaskId,
  'task-a' as TaskId,
  'completed'  // or 'failed' | 'cancelled'
);
```

**Note:** This is typically called automatically by `DependencyHandler` when tasks complete/fail/are cancelled.

#### `getUnresolvedDependencies(taskId)`

Get only the unresolved (pending) dependencies for a task.

```typescript
const result = await dependencyRepo.getUnresolvedDependencies('task-c' as TaskId);

if (result.ok) {
  console.log(`Task has ${result.value.length} unresolved dependencies`);
}
```

#### `deleteDependencies(taskId)`

Delete all dependencies involving a task (both as dependent and dependency).

```typescript
await dependencyRepo.deleteDependencies('task-a' as TaskId);
```

**Use Cases:**
- Task cleanup
- Dependency graph modifications
- Task cancellation cascades

## Usage Examples

### Basic Dependency Chain

```typescript
// Create a build -> test -> deploy pipeline

const buildResult = await taskManager.delegate({
  prompt: 'npm run build',
  priority: Priority.P1
});

const testResult = await taskManager.delegate({
  prompt: 'npm test',
  priority: Priority.P1,
  dependsOn: [buildResult.value.id]
});

const deployResult = await taskManager.delegate({
  prompt: 'npm run deploy',
  priority: Priority.P0,
  dependsOn: [testResult.value.id]
});

// Execution order: build → test → deploy
```

### Multiple Dependencies

```typescript
// Task depends on multiple prerequisites

const lintResult = await taskManager.delegate({
  prompt: 'npm run lint',
  priority: Priority.P2
});

const formatResult = await taskManager.delegate({
  prompt: 'npm run format',
  priority: Priority.P2
});

const commitResult = await taskManager.delegate({
  prompt: 'git commit -m "Formatted and linted code"',
  priority: Priority.P1,
  dependsOn: [lintResult.value.id, formatResult.value.id]
});

// lint and format run in parallel
// commit waits for both to complete
```

### Diamond Pattern

```typescript
// Complex dependency graph:
//       A
//      / \
//     B   C
//      \ /
//       D

const taskA = await taskManager.delegate({
  prompt: 'Task A - base'
});

const taskB = await taskManager.delegate({
  prompt: 'Task B',
  dependsOn: [taskA.value.id]
});

const taskC = await taskManager.delegate({
  prompt: 'Task C',
  dependsOn: [taskA.value.id]
});

const taskD = await taskManager.delegate({
  prompt: 'Task D - final',
  dependsOn: [taskB.value.id, taskC.value.id]
});

// Execution:
// 1. A completes
// 2. B and C run in parallel
// 3. D waits for both B and C to complete
```

### Parallel Task Groups with Final Task

```typescript
// Run tests in parallel, then aggregate results

const unitTests = await taskManager.delegate({
  prompt: 'Run unit tests'
});

const integrationTests = await taskManager.delegate({
  prompt: 'Run integration tests'
});

const e2eTests = await taskManager.delegate({
  prompt: 'Run E2E tests'
});

const aggregateResults = await taskManager.delegate({
  prompt: 'Aggregate test results and generate report',
  dependsOn: [
    unitTests.value.id,
    integrationTests.value.id,
    e2eTests.value.id
  ]
});

// All tests run in parallel
// Report generation waits for all tests
```

### Error Handling

```typescript
// Dependencies can fail or be cancelled

const dbMigration = await taskManager.delegate({
  prompt: 'Run database migrations'
});

const seedData = await taskManager.delegate({
  prompt: 'Seed database',
  dependsOn: [dbMigration.value.id]
});

// If dbMigration fails:
// 1. Dependency is resolved as 'failed'
// 2. seedData is no longer blocked (isBlocked returns false)
// 3. seedData can execute (you may want to check dependency resolution states)

// To check dependency resolution:
const deps = await dependencyRepo.getDependencies(seedData.value.id);
if (deps.ok) {
  const allSucceeded = deps.value.every(dep => dep.resolution === 'completed');
  if (!allSucceeded) {
    console.log('Some dependencies failed - task may want to abort');
  }
}
```

## Database Schema

```sql
CREATE TABLE task_dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  depends_on_task_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolution TEXT NOT NULL DEFAULT 'pending',
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (depends_on_task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  UNIQUE(task_id, depends_on_task_id)
);

-- Indexes for performance
CREATE INDEX idx_task_dependencies_task_id ON task_dependencies(task_id);
CREATE INDEX idx_task_dependencies_depends_on ON task_dependencies(depends_on_task_id);
CREATE INDEX idx_task_dependencies_resolution ON task_dependencies(resolution);
```

### TaskDependency Type

```typescript
interface TaskDependency {
  id: number;
  taskId: TaskId;
  dependsOnTaskId: TaskId;
  createdAt: number;
  resolvedAt: number | null;
  resolution: 'pending' | 'completed' | 'failed' | 'cancelled';
}
```

## Best Practices

### 1. Keep Dependency Chains Shallow

❌ **Avoid:**
```typescript
// 10-level deep chain
A → B → C → D → E → F → G → H → I → J
```

✅ **Prefer:**
```typescript
// Parallel execution with final aggregation
A, B, C, D run in parallel → Aggregate results
```

### 2. Use Priority Wisely

```typescript
// High-priority tasks should have high-priority dependencies
await taskManager.delegate({
  prompt: 'Critical deployment',
  priority: Priority.P0,
  dependsOn: [buildTaskId]  // Make sure build is also P0 or P1
});
```

### 3. Handle Dependency Failures

#### Current Behavior (v0.3.0)

**Important:** When a dependency fails or is cancelled, the dependent task is **unblocked** but **not automatically failed or cancelled**.

**Resolution Flow:**

```
Task A fails/is cancelled
  ↓
Dependency resolved as 'failed' or 'cancelled'
  ↓
Task B (depends on A) becomes unblocked (isBlocked = false)
  ↓
Task B is enqueued and can execute
  ↓
Task B should check dependency resolution states before proceeding
```

**Example:**

```typescript
// Task A is the dependency
const taskA = await taskManager.delegate({
  prompt: 'Database migration'
});

// Task B depends on Task A
const taskB = await taskManager.delegate({
  prompt: 'Seed data',
  dependsOn: [taskA.id]
});

// If Task A fails:
// 1. Dependency is marked as resolution='failed'
// 2. Task B becomes unblocked (isBlocked returns false)
// 3. Task B is enqueued and will start executing
// 4. Task B SHOULD check dependency states before proceeding

// Recommended pattern for Task B:
const deps = await dependencyRepo.getDependencies(taskB.id);
if (deps.ok) {
  const failedDeps = deps.value.filter(d => d.resolution === 'failed');
  const cancelledDeps = deps.value.filter(d => d.resolution === 'cancelled');

  if (failedDeps.length > 0 || cancelledDeps.length > 0) {
    // Option 1: Fail the task
    throw new Error(`Dependencies failed: ${failedDeps.map(d => d.dependsOnTaskId).join(', ')}`);

    // Option 2: Skip execution and log warning
    console.warn('Skipping task due to failed dependencies');
    return;

    // Option 3: Continue anyway (if task can handle partial results)
    console.warn('Proceeding despite failed dependencies');
  }
}
```

#### Design Rationale

The current behavior (unblock but don't auto-fail) was chosen for flexibility:

**Advantages:**
- ✅ Tasks can inspect dependency resolution states and make decisions
- ✅ Some tasks may be able to proceed despite failed dependencies (e.g., "best effort" tasks)
- ✅ Prevents cascading failures when only partial results are needed

**Disadvantages:**
- ⚠️ Tasks may execute when they shouldn't if resolution checks are forgotten
- ⚠️ Requires explicit handling in each task's code

#### Future Consideration (v0.4.0)

We may add configurable dependency failure strategies:

```typescript
// Proposed future API (not yet implemented)
await taskManager.delegate({
  prompt: 'Task B',
  dependsOn: [taskA.id],
  onDependencyFailure: 'auto-fail'  // or 'auto-cancel', 'continue', 'manual'
});
```

**Track this in**: [GitHub Issue #TBD - Dependency Failure Strategies]

#### Cancelled Dependency Propagation

**Current Behavior:** Cancelling a task does **not** automatically cancel its dependents.

```typescript
// Task C depends on Task A
await taskManager.cancel(taskA.id);

// Task C is NOT automatically cancelled
// Task C becomes unblocked (dependency resolved as 'cancelled')
// Task C will be enqueued and can execute
```

**Workaround for Cascading Cancellation:**

```typescript
// Manual cascade cancellation
async function cancelWithDependents(taskId: TaskId) {
  // Get all dependent tasks
  const dependents = await dependencyRepo.getDependents(taskId);

  if (dependents.ok) {
    // Cancel the original task
    await taskManager.cancel(taskId);

    // Recursively cancel all dependents
    for (const dep of dependents.value) {
      await cancelWithDependents(dep.taskId);
    }
  }
}
```

#### Recommendation

**For production use**, always check dependency resolution states:

```typescript
// At the start of every task that has dependencies:
async function executeTask(taskId: TaskId) {
  // 1. Check dependencies
  const deps = await dependencyRepo.getDependencies(taskId);

  if (deps.ok && deps.value.length > 0) {
    // 2. Verify all dependencies completed successfully
    const allSucceeded = deps.value.every(d => d.resolution === 'completed');

    if (!allSucceeded) {
      const failedDeps = deps.value.filter(d => d.resolution !== 'completed');
      throw new Error(
        `Cannot execute: ${failedDeps.length} dependencies did not complete successfully`
      );
    }
  }

  // 3. Proceed with task execution
  // ...
}
```

### 4. Avoid Circular Dependencies

The system will reject cycles, but design your workflows to avoid them:

❌ **Invalid:**
```
A depends on B
B depends on C
C depends on A  // Cycle!
```

✅ **Valid:**
```
A depends on nothing (base task)
B depends on A
C depends on B
```

### 5. Clean Up Dependencies

When tasks are no longer needed, clean up their dependencies:

```typescript
await dependencyRepo.deleteDependencies(obsoleteTaskId);
```

## Performance Considerations

1. **Prepared Statements**: All database operations use prepared statements for efficiency

2. **Indexes**: Dependencies are indexed on `task_id`, `depends_on_task_id`, and `resolution`

3. **Event-Driven**: All operations are event-driven to avoid blocking

4. **Batch Operations**: For bulk dependency operations, consider wrapping in a transaction:

```typescript
const sqliteDb = database.getDatabase();
const addMany = sqliteDb.transaction(async () => {
  for (const dep of dependencies) {
    await dependencyRepo.addDependency(dep.taskId, dep.dependsOnTaskId);
  }
});

addMany();
```

## Limitations

1. **No Conditional Dependencies**: Dependencies are binary - a task either depends on another or it doesn't. There's no support for conditional dependencies (e.g., "depend on A only if X is true").

2. **Static Dependency Graph**: Dependencies must be defined when the task is created. You cannot add dependencies to an already-running task.

3. **Resolution States**: Once a dependency is resolved (completed/failed/cancelled), it cannot be changed back to pending.

4. **No Dependency Timeout**: If a dependency never completes, the dependent task will wait indefinitely. Consider implementing task timeouts at the application level.

## Troubleshooting

### Task Not Executing

1. **Check if task is blocked:**
```typescript
const blocked = await dependencyRepo.isBlocked(taskId);
console.log('Task blocked:', blocked.value);
```

2. **Check unresolved dependencies:**
```typescript
const unresolved = await dependencyRepo.getUnresolvedDependencies(taskId);
console.log('Unresolved dependencies:', unresolved.value);
```

3. **Check if dependencies completed:**
```typescript
const deps = await dependencyRepo.getDependencies(taskId);
for (const dep of deps.value) {
  console.log(`Dependency ${dep.dependsOnTaskId}: ${dep.resolution}`);
}
```

### Cycle Detection False Positives

If you're getting cycle detection errors but believe your graph is acyclic:

1. **Visualize the dependency graph:**
```typescript
// Use findAllUnbounded() to see ALL dependencies (findAll() returns max 100)
const allDeps = await dependencyRepo.findAllUnbounded();
console.log('All dependencies:', allDeps.value);
```

2. **Check for transitive dependencies:**
   - If A → B and B → C, you cannot add C → A

### Performance Issues

If dependency operations are slow:

1. **Check database size:** `SELECT COUNT(*) FROM task_dependencies`

2. **Verify indexes exist:** Check that the three indexes are present

3. **Clean up old dependencies:** Periodically delete dependencies for completed tasks

## Implementation Details

### File Locations

- **Repository**: `src/implementations/dependency-repository.ts`
- **Handler**: `src/services/handlers/dependency-handler.ts`
- **Graph**: `src/core/dependency-graph.ts`
- **Queue Integration**: `src/services/handlers/queue-handler.ts`
- **Events**: `src/core/events/events.ts`
- **Integration Tests**: `tests/integration/task-dependencies.test.ts`
- **Unit Tests**: `tests/unit/implementations/dependency-repository.test.ts`
- **Graph Tests**: `tests/unit/core/dependency-graph.test.ts`

### Code References

- Cycle detection: `wouldCreateCycle()` in `src/core/dependency-graph.ts`
- Dependency-aware queueing: `handleTaskPersisted()` in `src/services/handlers/queue-handler.ts`
- Dependency resolution: `resolveDependencies()` in `src/services/handlers/dependency-handler.ts`
- Task unblocking: `handleTaskUnblocked()` in `src/services/handlers/queue-handler.ts`
