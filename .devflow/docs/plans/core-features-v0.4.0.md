# Core Features Planning: v0.4.0

**Created**: 2025-10-15
**Status**: Planning Phase
**Target Release**: v0.4.0
**Objective**: Enable production-ready workflow automation

---

## Executive Summary

Three critical features identified as blockers for production use:
1. **Task Dependencies** - DAG-based workflow orchestration
2. **Task Resumption** - Resume failed/interrupted tasks using Claude sessions
3. **Task Scheduling** - Time-based task execution (cron-like)

**Recommended Order**: Dependencies → Resumption → Scheduling
**Total Timeline**: 6 weeks
**Risk Level**: Medium (resumption has unknown complexity)

---

## Feature 1: Task Dependencies 🔗

### Overview

Enable DAG (Directed Acyclic Graph) based task dependencies where Task B waits for Task A to complete before executing.

### User Value: ⭐⭐⭐⭐⭐ (Critical)

**Use Cases**:
- Sequential workflows: Build → Test → Deploy
- Parallel workflows: Multiple tests depend on single build
- Complex pipelines: Multi-stage CI/CD workflows
- Conditional execution: Only deploy if tests pass

**Example**:
```typescript
// Build → Test → Deploy chain
const buildTask = await taskManager.delegate({
  prompt: "npm run build"
});

const testTask = await taskManager.delegate({
  prompt: "npm test",
  dependsOn: [buildTask.id]  // NEW: Waits for build
});

const deployTask = await taskManager.delegate({
  prompt: "Deploy to staging",
  dependsOn: [testTask.id]   // NEW: Waits for tests
});

// testTask starts only after buildTask completes
// deployTask starts only after testTask succeeds
```

### Complexity: ⚙️⚙️⚙️ (Medium)

**Well-understood CS problem** - Similar to:
- Make/Bazel build systems
- Airflow/Luigi workflow engines
- Task schedulers (Celery, Bull)

**Core Algorithms**:
1. **Cycle Detection**: DFS-based cycle detection (prevent circular dependencies)
2. **Topological Sort**: Determine execution order
3. **Graph Traversal**: BFS/DFS for dependency resolution

### Technical Design

#### 1. Domain Model Changes

**Task Interface** (`src/core/domain.ts`):
```typescript
export interface Task {
  // ... existing fields
  dependsOn: readonly TaskId[];           // Tasks this depends on
  blockedBy: readonly TaskId[];           // Tasks blocking this (derived)
  dependents: readonly TaskId[];          // Tasks depending on this (derived)
  dependencyState: DependencyState;       // NEW
}

export type DependencyState =
  | 'independent'      // No dependencies
  | 'blocked'          // Waiting for dependencies
  | 'ready'            // All dependencies met
  | 'dependency_failed' // One or more dependencies failed
  | 'orphaned';        // Dependency was deleted

export interface DelegateRequest {
  // ... existing fields
  dependsOn?: TaskId[];  // NEW: Optional dependencies
}
```

#### 2. Database Schema

**New Table**: `task_dependencies`
```sql
CREATE TABLE task_dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  depends_on_task_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,           -- When dependency was resolved
  resolution TEXT NOT NULL,      -- 'completed' | 'failed' | 'cancelled'
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (depends_on_task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  UNIQUE(task_id, depends_on_task_id)
);

CREATE INDEX idx_task_dependencies_task_id ON task_dependencies(task_id);
CREATE INDEX idx_task_dependencies_depends_on ON task_dependencies(depends_on_task_id);
```

#### 3. Event-Driven Architecture

**New Events** (`src/core/events/events.ts`):
```typescript
export interface TaskDependencyAddedEvent extends BaseEvent {
  type: 'TaskDependencyAdded';
  taskId: TaskId;
  dependsOn: TaskId;
}

export interface TaskDependencyResolvedEvent extends BaseEvent {
  type: 'TaskDependencyResolved';
  taskId: TaskId;                // Task that was waiting
  resolvedDependency: TaskId;    // Dependency that completed
  resolution: 'completed' | 'failed' | 'cancelled';
  allDependenciesResolved: boolean;
}

export interface TaskUnblockedEvent extends BaseEvent {
  type: 'TaskUnblocked';
  taskId: TaskId;
  // Emitted when all dependencies are resolved and task is ready to run
}

export interface TaskDependencyFailedEvent extends BaseEvent {
  type: 'TaskDependencyFailed';
  taskId: TaskId;
  failedDependency: TaskId;
  // Propagate failure to dependent tasks
}
```

**New Handler**: `DependencyHandler` (`src/services/handlers/dependency-handler.ts`)
```typescript
export class DependencyHandler extends BaseEventHandler {
  constructor(
    private readonly repository: TaskRepository,
    private readonly dependencyRepository: DependencyRepository,
    private readonly eventBus: EventBus,
    logger: Logger
  ) {
    super(logger, 'DependencyHandler');
  }

  async setup(eventBus: EventBus): Promise<Result<void>> {
    const subscriptions = [
      eventBus.subscribe('TaskDelegated', this.handleTaskDelegated.bind(this)),
      eventBus.subscribe('TaskCompleted', this.handleTaskCompleted.bind(this)),
      eventBus.subscribe('TaskFailed', this.handleTaskFailed.bind(this)),
      eventBus.subscribe('TaskCancelled', this.handleTaskCancelled.bind(this))
    ];
    // Check subscriptions...
    return ok(undefined);
  }

  private async handleTaskDelegated(event: TaskDelegatedEvent): Promise<void> {
    const task = event.task;

    // If task has dependencies, validate and store them
    if (task.dependsOn && task.dependsOn.length > 0) {
      // 1. Validate dependencies exist
      // 2. Check for cycles
      // 3. Store in dependency table
      // 4. Update task state to 'blocked' if dependencies not all resolved
      // 5. Emit TaskDependencyAdded events
    }
  }

  private async handleTaskCompleted(event: TaskCompletedEvent): Promise<void> {
    // 1. Find all tasks that depend on this completed task
    // 2. Mark this dependency as resolved
    // 3. Check if all dependencies are now resolved
    // 4. If yes, emit TaskUnblocked event
    // 5. Emit TaskDependencyResolved events
  }

  private async handleTaskFailed(event: TaskFailedEvent): Promise<void> {
    // 1. Find all tasks that depend on this failed task
    // 2. Emit TaskDependencyFailed for each dependent
    // 3. Mark dependents as 'dependency_failed' (don't run them)
  }
}
```

#### 4. Dependency Repository

**New Repository**: `DependencyRepository` (`src/implementations/dependency-repository.ts`)
```typescript
export interface DependencyRepository {
  addDependency(taskId: TaskId, dependsOn: TaskId): Promise<Result<void>>;
  getDependencies(taskId: TaskId): Promise<Result<readonly TaskId[]>>;
  getDependents(taskId: TaskId): Promise<Result<readonly TaskId[]>>;
  resolveDependency(taskId: TaskId, dependsOn: TaskId, resolution: string): Promise<Result<void>>;
  areAllDependenciesResolved(taskId: TaskId): Promise<Result<boolean>>;
  checkForCycles(taskId: TaskId, dependsOn: TaskId): Promise<Result<boolean>>;
}
```

#### 5. Cycle Detection Algorithm

**Implementation** (`src/services/dependency-graph.ts`):
```typescript
export class DependencyGraph {
  /**
   * Detect cycles using DFS
   * Returns true if adding edge (taskId -> dependsOn) creates a cycle
   */
  async hasCycle(
    taskId: TaskId,
    dependsOn: TaskId,
    repository: DependencyRepository
  ): Promise<Result<boolean>> {
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    async function dfs(current: TaskId): Promise<boolean> {
      if (recursionStack.has(current)) return true;  // Cycle detected
      if (visited.has(current)) return false;

      visited.add(current);
      recursionStack.add(current);

      const deps = await repository.getDependencies(current);
      if (!deps.ok) return false;

      for (const dep of deps.value) {
        if (await dfs(dep)) return true;
      }

      recursionStack.delete(current);
      return false;
    }

    // Check if adding this edge creates a cycle
    // by checking if dependsOn can reach taskId
    return ok(await dfs(dependsOn));
  }
}
```

### Implementation Phases

#### Phase 1: Core Infrastructure (2-3 days)
- [ ] Add `task_dependencies` database table
- [ ] Implement `DependencyRepository`
- [ ] Add dependency fields to `Task` interface
- [ ] Update `createTask()` to accept `dependsOn`

#### Phase 2: Cycle Detection (1 day)
- [ ] Implement `DependencyGraph` class
- [ ] Add cycle detection algorithm (DFS)
- [ ] Unit tests for cycle detection

#### Phase 3: Event Handler (1-2 days)
- [ ] Implement `DependencyHandler`
- [ ] Handle `TaskDelegated` → store dependencies, check cycles
- [ ] Handle `TaskCompleted` → resolve dependencies, unblock tasks
- [ ] Handle `TaskFailed` → propagate failures
- [ ] Wire up in `bootstrap.ts`

#### Phase 4: Queue Integration (1 day)
- [ ] Update `QueueHandler` to skip blocked tasks
- [ ] Emit `TaskUnblocked` → `TaskQueued` when dependencies resolve
- [ ] Handle `dependency_failed` tasks (don't queue them)

#### Phase 5: Testing (2 days)
- [ ] Unit tests: Cycle detection, graph operations
- [ ] Integration tests: Simple chain (A→B→C)
- [ ] Integration tests: Diamond dependency (A→B,C; B,C→D)
- [ ] Integration tests: Failure propagation
- [ ] Edge cases: Deleted dependencies, circular refs

#### Phase 6: Documentation (1 day)
- [ ] API documentation
- [ ] Architecture documentation (`EVENT_FLOW.md`)
- [ ] Usage examples
- [ ] Migration guide

**Total Effort**: **6-7 days (1 week)**

### API Surface

**TaskManager** (`src/core/interfaces.ts`):
```typescript
interface TaskManager {
  // Existing methods...

  // NEW: Delegate with dependencies
  delegate(request: DelegateRequest): Promise<Result<Task>>;
  // request.dependsOn?: TaskId[]

  // NEW: Query dependency graph
  getDependencies(taskId: TaskId): Promise<Result<readonly TaskId[]>>;
  getDependents(taskId: TaskId): Promise<Result<readonly TaskId[]>>;
  getDependencyTree(taskId: TaskId): Promise<Result<DependencyTree>>;
}

interface DependencyTree {
  task: Task;
  dependencies: DependencyTree[];
  dependents: DependencyTree[];
}
```

### Error Handling

**New Error Types**:
- `CIRCULAR_DEPENDENCY` - Cycle detected
- `DEPENDENCY_NOT_FOUND` - Referenced task doesn't exist
- `DEPENDENCY_FAILED` - Upstream task failed
- `ORPHANED_DEPENDENCY` - Dependency was deleted

### Migration Strategy

**Backwards Compatibility**: ✅ Fully compatible
- Existing tasks work unchanged (no dependencies)
- `dependsOn` is optional in `DelegateRequest`
- Database migration adds new table (doesn't modify existing)

### Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Complex dependency graphs cause performance issues | Medium | Index on dependency table, cache graph computations |
| Cycle detection false positives | High | Extensive testing, manual override API |
| Dependency deletion causes orphaned tasks | Low | ON DELETE CASCADE in database, emit warnings |
| Race condition in dependency resolution | Medium | Use database transactions for atomic updates |

### Success Metrics

- [ ] Can create simple chain: A → B → C
- [ ] Can create parallel: A → B,C; B,C → D
- [ ] Cycle detection prevents invalid graphs
- [ ] Task B doesn't start until Task A completes
- [ ] Task B marked `dependency_failed` if Task A fails
- [ ] Performance: < 100ms overhead for dependency resolution

---

## Feature 2: Task Resumption 🔄

### Overview

Resume failed or interrupted tasks using Claude session continuation, preserving conversation history and partial work.

### User Value: ⭐⭐⭐⭐⭐ (Critical)

**Use Cases**:
- Task fails midway → Resume from failure point, don't restart
- Server crashes during task → Recover partial work
- Network interruption → Continue where left off
- Long-running tasks → Checkpoint periodically

**Example**:
```typescript
// Task fails after completing 60% of work
const result = await taskManager.delegate({
  prompt: "Refactor entire codebase"
});

// result.ok = false (task failed)

// Resume from last checkpoint or failure point
const resumeResult = await taskManager.resumeTask(result.task.id, {
  from: 'last-checkpoint',  // or 'failure-point'
  preserveHistory: true
});

// Claude continues with:
// - Previous conversation context
// - Partial file changes detected
// - Work already completed
```

### Complexity: ⚙️⚙️⚙️⚙️⚙️ (HIGH)

**Complex state reconstruction problem** - Similar to:
- Database transaction recovery
- VM snapshotting/migration
- Version control merge resolution

**Major Challenges**:
1. **Claude API Session Support** 🚨 - Unknown if API supports this
2. **Conversation State Serialization** - How to preserve tool calls, file edits?
3. **Git State Detection** - What files changed? What was committed?
4. **External Changes** - User edited files while task was paused
5. **Checkpoint Granularity** - How often? What triggers checkpoint?
6. **Merge Conflicts** - Task changes vs external changes

### Critical Unknowns 🚨

**MUST RESEARCH BEFORE IMPLEMENTATION**:

1. **Does Claude API support session continuation?**
   - Can we preserve conversation context?
   - Can we serialize/deserialize message history?
   - What's the maximum conversation length?

2. **How to handle tool calls?**
   - If task executed 50 tool calls, can we resume from call #51?
   - Do we replay history or inject context?

3. **Git worktree state complexity**:
   - Uncommitted changes detection
   - Partial commits recovery
   - External edits since task started
   - Merge conflict resolution

**Decision Gate**: Spend 2-3 days researching these before committing to full implementation

### Technical Design (Conceptual)

#### 1. Session Storage

**New Table**: `task_sessions`
```sql
CREATE TABLE task_sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  checkpoint_number INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  conversation_history TEXT NOT NULL,  -- JSON: Claude messages
  tool_calls TEXT NOT NULL,            -- JSON: Tool call history
  git_state TEXT NOT NULL,             -- JSON: File changes, commits
  metadata TEXT,                        -- JSON: Additional state
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX idx_task_sessions_task_id ON task_sessions(task_id);
```

#### 2. Checkpoint Mechanism

**Trigger Points**:
- Every N tool calls (e.g., every 10 calls)
- Every N minutes (e.g., every 5 minutes)
- Before high-risk operations (git commit, file delete)
- On user request (manual checkpoint)

**What to Capture**:
```typescript
interface TaskCheckpoint {
  checkpointId: string;
  taskId: TaskId;
  checkpointNumber: number;
  timestamp: number;

  conversationHistory: Message[];      // Claude messages
  toolCalls: ToolCall[];               // All tool calls so far

  gitState: {
    workingDirectory: string;
    branch: string;
    uncommittedChanges: FileChange[];
    commits: Commit[];
  };

  metadata: {
    percentComplete?: number;
    lastSuccessfulOperation?: string;
  };
}
```

#### 3. Resumption Flow

**Process**:
1. **Load Latest Checkpoint**
   - Retrieve last successful checkpoint from database
   - Or use failure point if no checkpoints exist

2. **Detect External Changes**
   - Compare git state at checkpoint vs current state
   - Identify conflicts: task changed file X, but X now different

3. **Reconstruct Context**
   - **Option A**: Replay conversation history to Claude
   - **Option B**: Summarize progress + inject context
   - **Option C**: Fresh start with context injection

4. **Resume Execution**
   - Continue from checkpoint
   - Claude receives: "You were working on X, here's what you did..."

#### 4. Git State Management

**Challenges**:
```typescript
// Scenario: Task was editing src/app.ts when it failed
// Problem: User also edited src/app.ts during downtime
// Solution: ?

interface GitStateReconciliation {
  checkpointState: FileChange[];      // Task's changes at checkpoint
  currentState: FileChange[];         // Files now

  conflicts: Array<{
    file: string;
    checkpointContent: string;
    currentContent: string;
    resolution: 'use_checkpoint' | 'use_current' | 'merge' | 'ask_user';
  }>;
}
```

**Possible Strategies**:
- **Strict Mode**: Fail resumption if any files changed externally
- **Merge Mode**: Auto-merge if possible, fail if conflicts
- **Override Mode**: Task's checkpoint wins (dangerous)
- **Interactive Mode**: Ask user to resolve conflicts

### Implementation Phases (Tentative)

#### Phase 0: Research (2-3 days) 🚨 **CRITICAL**
- [ ] Research Claude API session continuation capabilities
- [ ] Prototype conversation serialization/deserialization
- [ ] Test git state detection with real worktrees
- [ ] **Decision**: Feasible or not? Full/partial/skip?

#### Phase 1: Checkpoint Infrastructure (3-4 days)
- [ ] Add `task_sessions` table
- [ ] Implement `SessionRepository`
- [ ] Create checkpoint mechanism (periodic + trigger-based)
- [ ] Store conversation history, tool calls

#### Phase 2: Git State Capture (2-3 days)
- [ ] Implement git state snapshot
- [ ] Detect uncommitted changes
- [ ] Track partial commits
- [ ] Store file diffs

#### Phase 3: Resumption Logic (4-5 days)
- [ ] Load checkpoint from database
- [ ] Detect external changes (git diff)
- [ ] Reconstruct Claude context
- [ ] Resume execution
- [ ] Handle failures gracefully

#### Phase 4: Conflict Resolution (2-3 days)
- [ ] Implement merge strategies
- [ ] User-facing conflict resolution API
- [ ] Test edge cases

#### Phase 5: Testing (3-4 days)
- [ ] Unit tests: Checkpoint save/load
- [ ] Integration tests: Simple resumption
- [ ] Integration tests: With external changes
- [ ] Integration tests: Conflict scenarios
- [ ] Edge cases: Multiple checkpoints, corrupted state

#### Phase 6: Documentation (1-2 days)
- [ ] API documentation
- [ ] Architecture docs (session storage)
- [ ] Usage guide with examples
- [ ] Troubleshooting guide

**Total Effort**: **14-20 days (3-4 weeks)** if feasible

### API Surface

**TaskManager**:
```typescript
interface TaskManager {
  // NEW: Resume failed task
  resumeTask(
    taskId: TaskId,
    options?: ResumeOptions
  ): Promise<Result<Task>>;

  // NEW: Manual checkpoint
  checkpointTask(taskId: TaskId): Promise<Result<Checkpoint>>;

  // NEW: List checkpoints
  getCheckpoints(taskId: TaskId): Promise<Result<readonly Checkpoint[]>>;
}

interface ResumeOptions {
  from?: 'last-checkpoint' | 'failure-point' | 'checkpoint-id';
  checkpointId?: string;
  preserveHistory?: boolean;      // Include full conversation history
  conflictResolution?: 'fail' | 'merge' | 'override';
}
```

### Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Claude API doesn't support session continuation | **CRITICAL** | Research before implementation, fallback to "retry with context" |
| Conversation history too large to serialize | High | Summarize old history, keep only recent N messages |
| Git state conflicts unsolvable | High | Strict mode by default, require clean state |
| Checkpoint storage explodes database | Medium | Cleanup old checkpoints, configurable retention |
| Resume fails more often than helps | High | Extensive testing, clear failure modes |

### Success Metrics

- [ ] Can resume task from checkpoint within 30 seconds
- [ ] Resumption success rate > 80% (no external changes)
- [ ] Checkpoint overhead < 5% of task runtime
- [ ] Clear error messages for irrecoverable states
- [ ] No data loss during interruption

### Decision Points

**After Research Phase (Days 2-3)**:

**Go Decision Criteria**:
- ✅ Claude API supports session continuation (or acceptable workaround exists)
- ✅ Conversation serialization is feasible
- ✅ Git state detection is reliable
- ✅ Estimated effort is < 4 weeks

**No-Go Criteria**:
- ❌ Claude API doesn't support sessions → **Descope to "retry with context"** (simpler)
- ❌ Git conflicts are unsolvable → **Descope to "require clean state"**
- ❌ Too complex (> 4 weeks) → **Defer to v0.5.0**

**Fallback Option**: Implement simpler "retry with context injection"
- No checkpoints, no state storage
- Just retry task with context: "Previous attempt failed at step X with error Y. Files changed: Z."
- **Effort**: 1 week instead of 4 weeks
- **Value**: Still better than complete restart

---

## Feature 3: Task Scheduling ⏰

### Overview

Execute tasks at specific times or recurring intervals using cron-like scheduling.

### User Value: ⭐⭐⭐ (Nice-to-have)

**Use Cases**:
- Periodic maintenance: "Run daily backups at 2am"
- Recurring workflows: "Generate weekly reports every Monday"
- Delayed execution: "Deploy to production tomorrow at 8am"
- Time-zone aware scheduling

**Example**:
```typescript
// Daily backup at 2am
await taskManager.scheduleTask({
  schedule: '0 2 * * *',  // Cron syntax
  task: { prompt: "Backup database to S3" }
});

// Weekly report (with dependencies)
await taskManager.scheduleTask({
  schedule: '0 9 * * MON',
  task: {
    prompt: "Generate weekly analytics report",
    dependsOn: [dataCollectionTaskId]  // Integrates with dependencies!
  }
});

// One-time delayed execution
await taskManager.scheduleTask({
  schedule: '2025-10-16T08:00:00Z',  // ISO timestamp
  task: { prompt: "Deploy to production" },
  recurring: false
});
```

### Complexity: ⚙️⚙️ (Medium-Low)

**Well-understood scheduling problem** - Similar to:
- Cron (Unix task scheduler)
- Node-schedule, node-cron libraries
- Task queues (Bull, BullMQ)

**Core Components**:
1. **Cron Parser** - Use existing library (cron-parser)
2. **Timer Management** - Track next execution time
3. **Missed Run Handling** - Server was down, catch up?
4. **Time Zone Support** - Convert UTC to local/specified zone

### Technical Design

#### 1. Domain Model

**Scheduled Task**:
```typescript
export interface ScheduledTask {
  id: ScheduledTaskId;
  schedule: string;                // Cron expression or ISO timestamp
  taskRequest: DelegateRequest;    // What to execute
  recurring: boolean;              // One-time or repeating
  timezone?: string;               // IANA timezone (e.g., 'America/New_York')
  enabled: boolean;                // Can pause/resume

  nextRunTime: number;             // Timestamp of next execution
  lastRunTime?: number;            // When it last ran
  lastTaskId?: TaskId;             // Most recent task created

  metadata: {
    createdAt: number;
    createdBy?: string;
    missedRunPolicy: 'skip' | 'catchup' | 'fail';
  };
}
```

#### 2. Database Schema

**New Table**: `scheduled_tasks`
```sql
CREATE TABLE scheduled_tasks (
  id TEXT PRIMARY KEY,
  schedule TEXT NOT NULL,             -- Cron or ISO timestamp
  task_request TEXT NOT NULL,         -- JSON: DelegateRequest
  recurring INTEGER NOT NULL,         -- Boolean
  timezone TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_time INTEGER NOT NULL,
  last_run_time INTEGER,
  last_task_id TEXT,
  missed_run_policy TEXT NOT NULL DEFAULT 'skip',
  metadata TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (last_task_id) REFERENCES tasks(id) ON DELETE SET NULL
);

CREATE INDEX idx_scheduled_tasks_next_run ON scheduled_tasks(next_run_time, enabled);
```

**New Table**: `schedule_history`
```sql
CREATE TABLE schedule_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scheduled_task_id TEXT NOT NULL,
  executed_at INTEGER NOT NULL,
  task_id TEXT,                        -- Task that was created
  success INTEGER NOT NULL,            -- Boolean
  error TEXT,                          -- If failed to schedule
  FOREIGN KEY (scheduled_task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
);

CREATE INDEX idx_schedule_history_scheduled_task ON schedule_history(scheduled_task_id);
```

#### 3. Scheduler Service

**Implementation** (`src/services/scheduler.ts`):
```typescript
export class SchedulerService {
  private timer?: NodeJS.Timeout;
  private readonly checkIntervalMs = 60000;  // Check every minute

  constructor(
    private readonly scheduledTaskRepository: ScheduledTaskRepository,
    private readonly taskManager: TaskManager,
    private readonly eventBus: EventBus,
    private readonly logger: Logger
  ) {}

  async start(): Promise<Result<void>> {
    this.logger.info('Starting scheduler');
    await this.checkAndExecuteDueTasks();

    // Check every minute for due tasks
    this.timer = setInterval(() => {
      this.checkAndExecuteDueTasks().catch(err => {
        this.logger.error('Scheduler check failed', err);
      });
    }, this.checkIntervalMs);

    return ok(undefined);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async checkAndExecuteDueTasks(): Promise<void> {
    const now = Date.now();

    // Get all scheduled tasks due for execution
    const dueTasksResult = await this.scheduledTaskRepository.getDueTasks(now);
    if (!dueTasksResult.ok) return;

    for (const scheduledTask of dueTasksResult.value) {
      await this.executeScheduledTask(scheduledTask);
    }
  }

  private async executeScheduledTask(scheduledTask: ScheduledTask): Promise<void> {
    this.logger.info('Executing scheduled task', {
      scheduleId: scheduledTask.id,
      schedule: scheduledTask.schedule
    });

    // Delegate the task
    const taskResult = await this.taskManager.delegate(scheduledTask.taskRequest);

    if (taskResult.ok) {
      // Update scheduled task
      await this.scheduledTaskRepository.recordExecution(
        scheduledTask.id,
        taskResult.value.id,
        true
      );

      // Calculate next run time (for recurring tasks)
      if (scheduledTask.recurring) {
        const nextRun = this.calculateNextRun(scheduledTask.schedule, scheduledTask.timezone);
        await this.scheduledTaskRepository.updateNextRunTime(scheduledTask.id, nextRun);
      } else {
        // One-time task, disable it
        await this.scheduledTaskRepository.disable(scheduledTask.id);
      }

      // Emit event
      await this.eventBus.emit('ScheduledTaskExecuted', {
        scheduledTaskId: scheduledTask.id,
        taskId: taskResult.value.id
      });
    } else {
      // Failed to delegate
      this.logger.error('Failed to execute scheduled task', taskResult.error);
      await this.scheduledTaskRepository.recordExecution(
        scheduledTask.id,
        null,
        false,
        taskResult.error.message
      );
    }
  }

  private calculateNextRun(schedule: string, timezone?: string): number {
    const parser = require('cron-parser');
    const interval = parser.parseExpression(schedule, {
      currentDate: new Date(),
      tz: timezone
    });
    return interval.next().getTime();
  }
}
```

#### 4. Event-Driven Integration

**New Events**:
```typescript
export interface TaskScheduledEvent extends BaseEvent {
  type: 'TaskScheduled';
  scheduledTaskId: ScheduledTaskId;
  schedule: string;
  nextRunTime: number;
}

export interface ScheduledTaskExecutedEvent extends BaseEvent {
  type: 'ScheduledTaskExecuted';
  scheduledTaskId: ScheduledTaskId;
  taskId: TaskId;
}

export interface ScheduledTaskMissedEvent extends BaseEvent {
  type: 'ScheduledTaskMissed';
  scheduledTaskId: ScheduledTaskId;
  missedTime: number;
  policy: 'skip' | 'catchup' | 'fail';
}
```

### Implementation Phases

#### Phase 1: Core Scheduling (2 days)
- [ ] Add `scheduled_tasks` and `schedule_history` tables
- [ ] Implement `ScheduledTaskRepository`
- [ ] Implement `SchedulerService` with cron parsing
- [ ] Basic timer-based execution

#### Phase 2: Cron Expression Support (1 day)
- [ ] Integrate `cron-parser` library
- [ ] Support standard cron syntax
- [ ] Calculate next run times
- [ ] Time zone conversion

#### Phase 3: Missed Run Handling (1 day)
- [ ] Detect missed runs (server downtime)
- [ ] Implement policies: skip, catchup, fail
- [ ] Emit `ScheduledTaskMissed` events

#### Phase 4: API Integration (1 day)
- [ ] Add `scheduleTask()` to TaskManager
- [ ] Add `updateSchedule()`, `cancelSchedule()`, `pauseSchedule()`
- [ ] Wire up in bootstrap.ts

#### Phase 5: Testing (1-2 days)
- [ ] Unit tests: Cron parsing, next run calculation
- [ ] Integration tests: Task execution at scheduled time
- [ ] Integration tests: Recurring tasks
- [ ] Edge cases: Time zones, DST transitions

#### Phase 6: Documentation (1 day)
- [ ] API documentation with cron examples
- [ ] Usage guide
- [ ] Time zone handling guide

**Total Effort**: **4-6 days (1 week)**

### API Surface

**TaskManager**:
```typescript
interface TaskManager {
  // NEW: Schedule task
  scheduleTask(options: ScheduleOptions): Promise<Result<ScheduledTask>>;

  // NEW: Manage scheduled tasks
  updateSchedule(id: ScheduledTaskId, updates: Partial<ScheduledTask>): Promise<Result<void>>;
  cancelSchedule(id: ScheduledTaskId): Promise<Result<void>>;
  pauseSchedule(id: ScheduledTaskId): Promise<Result<void>>;
  resumeSchedule(id: ScheduledTaskId): Promise<Result<void>>;

  // NEW: Query scheduled tasks
  getScheduledTask(id: ScheduledTaskId): Promise<Result<ScheduledTask>>;
  listScheduledTasks(): Promise<Result<readonly ScheduledTask[]>>;
  getScheduleHistory(id: ScheduledTaskId): Promise<Result<readonly ScheduleExecution[]>>;
}

interface ScheduleOptions {
  schedule: string;                    // Cron or ISO timestamp
  task: DelegateRequest;               // What to execute
  recurring?: boolean;                 // Default: true for cron, false for timestamp
  timezone?: string;                   // IANA timezone
  missedRunPolicy?: 'skip' | 'catchup' | 'fail';
}
```

### Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Scheduler misses tasks (timer drift) | Medium | Check every minute, use database as source of truth |
| Time zone edge cases (DST) | Low | Use `cron-parser` library (handles DST) |
| Missed runs after server restart | Medium | Implement catchup policy, detect on startup |
| Infinite scheduling bugs (bad cron) | Low | Validate cron expressions, add safety limits |

### Success Metrics

- [ ] Can schedule task with cron expression
- [ ] Task executes within 1 minute of scheduled time
- [ ] Recurring tasks repeat correctly
- [ ] Missed runs handled per policy
- [ ] Time zones work correctly (test with multiple zones)

### Dependencies on Other Features

**Integrates with Task Dependencies**:
```typescript
// Scheduled task with dependencies
scheduleTask({
  schedule: '0 2 * * *',
  task: {
    prompt: "Deploy to production",
    dependsOn: [testTaskId]  // Only deploy if tests pass
  }
});
```

If dependencies are implemented, scheduled tasks can depend on other tasks!

---

## Implementation Strategy

### Recommended Order

**Phase 1: Task Dependencies** (Week 1)
- Known complexity, low risk
- Immediate production value
- Foundation for other features

**Phase 2: Task Resumption** (Weeks 2-5)
- Research first (2-3 days)
- **Decision gate**: Go/no-go based on feasibility
- High value but high risk

**Phase 3: Task Scheduling** (Week 6)
- Standard problem, known solutions
- Polish feature
- Integrates with dependencies

### Timeline

```
Week 1: [=== Dependencies ===]
        └─ MVP functional, start using tool

Week 2: [Research Resumption]
        └─ Decision: Full / Partial / Skip

Week 3-5: [=== Resumption Implementation ===] (if feasible)
          └─ OR [=== Scheduling ===] (if resumption blocked)

Week 6: [=== Scheduling ===]
        └─ OR [Polish & Bug Fixes]

TOTAL: 6 weeks
```

### Decision Gates

**Gate 1** (End of Week 1): Dependencies Complete?
- ✅ YES → Proceed to resumption research
- ❌ NO → Extend dependencies, delay resumption

**Gate 2** (End of Week 2): Resumption Feasible?
- ✅ YES → Proceed with full implementation (3-4 weeks)
- ⚠️ PARTIAL → Implement "retry with context" (1 week)
- ❌ NO → Skip to scheduling

**Gate 3** (End of Week 5): Resumption Complete?
- ✅ YES → Add scheduling (Week 6)
- ❌ NO → Bug fixes, defer scheduling to v0.5.0

### Risk Mitigation

**High Risk: Task Resumption**
- Research before committing (2-3 days)
- Have fallback: "retry with context" (simpler, 1 week)
- Can skip entirely if not feasible

**Medium Risk: Dependencies**
- Well-understood algorithms
- Extensive testing for edge cases
- Incremental implementation (MVP first)

**Low Risk: Scheduling**
- Use existing libraries (cron-parser)
- Standard patterns
- Can defer if timeline slips

---

## Open Questions

### For User Decision

1. **Priority Confirmation**:
   - Agree with Dependencies → Resumption → Scheduling order?
   - Or prefer different priority?

2. **Timeline Flexibility**:
   - Is 6 weeks acceptable?
   - Need faster delivery? (Can do MVP versions)

3. **Resumption Scope**:
   - Okay with researching feasibility before committing?
   - Acceptable to fallback to simpler "retry with context" if full resumption too complex?

4. **Feature Completeness**:
   - Want full-featured implementations?
   - Or MVP versions we iterate on?

### Technical Research Needed

1. **Claude API Session Support**:
   - Does API support conversation continuation?
   - How to serialize/deserialize messages?
   - Maximum conversation length?

2. **Git Worktree State**:
   - Reliable detection of uncommitted changes?
   - Conflict resolution strategies?
   - Performance impact of frequent checkpoints?

3. **Dependency Graph Performance**:
   - How complex can graphs get before perf issues?
   - Need caching/indexing strategies?

---

## Success Criteria (v0.4.0)

### Must Have
- [ ] Task dependencies working (simple chains: A→B→C)
- [ ] Dependency failure propagation
- [ ] No circular dependency bugs

### Should Have
- [ ] Task resumption (full or "retry with context" fallback)
- [ ] Checkpoint mechanism (if full resumption)
- [ ] Scheduled tasks with cron syntax

### Nice to Have
- [ ] Complex dependency graphs (diamond, parallel)
- [ ] Dependency visualization
- [ ] Advanced scheduling (time zones, missed runs)

---

## Next Steps

1. **User Approval**:
   - Review this plan
   - Confirm priorities and timeline
   - Approve starting with Dependencies

2. **Begin Implementation**:
   - Create branch: `feat/task-dependencies`
   - Start Phase 1: Core Infrastructure
   - Target: Week 1 completion

3. **Parallel Research**:
   - While building dependencies, research Claude API for resumption
   - Document findings
   - Make go/no-go decision by end of Week 2

---

## Related Documents

- [Roadmap](../../docs/ROADMAP.md)
- [Architecture: Event Flow](../../docs/architecture/EVENT_FLOW.md)
- [Tech Debt: EventBus Type Casting](../../docs/tech-debt/eventbus-type-casting.md)

---

**Status**: Awaiting user approval to proceed
**Next Action**: Start Task Dependencies implementation (Phase 1)
