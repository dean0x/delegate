# Delegate Limitations Roadmap

## Current Limitations Analysis

Based on the README and codebase analysis, here are the key limitations that need to be addressed:

### Critical Limitations
1. **No Task Persistence** - Tasks don't survive server restarts
2. **Timeout Not Enforced** - 30-minute timeout is configured but not implemented
3. **Output Buffer Overflow** - 10MB limit exists but overflow handling is unclear

### Feature Gaps
4. **No Task Dependencies** - Can't define task execution order
5. **Limited Metrics** - No resource usage tracking per task

## Implementation Plan

### Phase 1: Task Persistence (Priority 1)
**Problem:** Tasks are stored in memory only, lost on restart
**Impact:** Prevents production use, no crash recovery

#### Implementation Details:
- **Database:** SQLite with `better-sqlite3` for simplicity and performance
- **Architecture:** Repository pattern for clean separation
- **Enabled by Default:** No configuration needed
- **Smart Defaults:** Auto-selects appropriate system directory
- **Components:**
  ```typescript
  interface TaskRepository {
    save(task: Task): Promise<Result<void>>
    update(id: TaskId, update: TaskUpdate): Promise<Result<void>>
    findById(id: TaskId): Promise<Result<Task | null>>
    findAll(): Promise<Result<Task[]>>
    findByStatus(status: TaskStatus): Promise<Result<Task[]>>
  }
  ```

#### Database Schema:
```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  working_directory TEXT,
  use_worktree BOOLEAN DEFAULT 0,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  worker_id TEXT,
  exit_code INTEGER,
  dependencies TEXT -- JSON array
);

CREATE TABLE task_output (
  task_id TEXT PRIMARY KEY,
  stdout TEXT,
  stderr TEXT,
  total_size INTEGER,
  file_path TEXT, -- For large outputs
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_priority ON tasks(priority);
```

#### Recovery Strategy:
1. On startup, load all non-terminal tasks
2. Re-queue QUEUED tasks to TaskQueue
3. Mark RUNNING tasks as FAILED (crashed during execution)
4. Restore output buffers from database/files

### Phase 2: Timeout Enforcement (Priority 2)
**Problem:** Tasks can run indefinitely
**Impact:** Resource exhaustion, stuck workers

#### Implementation Details:
- Add timeout tracking to `WorkerPool`
- Per-task configurable timeout with max limit
- Graceful termination with SIGTERM, then SIGKILL

```typescript
interface TimeoutConfig {
  defaultTimeout: number;  // 30 minutes
  maxTimeout: number;      // 2 hours
  warningThreshold: 0.9;   // Warn at 90% of timeout
}
```

#### Worker Pool Changes:
```typescript
class AutoscalingWorkerPool {
  private timeouts = new Map<WorkerId, NodeJS.Timeout>();
  
  async spawn(task: Task): Promise<Result<Worker>> {
    // ... existing spawn logic
    
    // Set timeout
    const timeout = task.timeout || this.config.defaultTimeout;
    const timeoutHandle = setTimeout(() => {
      this.handleTimeout(worker.id, task.id);
    }, timeout);
    
    this.timeouts.set(worker.id, timeoutHandle);
  }
  
  private async handleTimeout(workerId: WorkerId, taskId: TaskId) {
    this.logger.warn('Task timeout reached', { workerId, taskId });
    
    // Try graceful shutdown first
    process.kill(pid, 'SIGTERM');
    
    // Force kill after grace period
    setTimeout(() => {
      if (this.workers.has(workerId)) {
        process.kill(pid, 'SIGKILL');
      }
    }, 5000);
  }
}
```

### Phase 3: Output Buffer Management (Priority 3)
**Problem:** Large outputs can exceed memory limits
**Impact:** OOM crashes, lost output

#### Implementation Details:
- Stream to disk when buffer exceeds threshold
- Compress old outputs
- Automatic cleanup policy

```typescript
interface OutputStrategy {
  bufferThreshold: number;     // 1MB in memory
  fileThreshold: number;       // 100MB max file
  compressionAge: number;      // Compress after 1 hour
  retentionPeriod: number;     // Delete after 7 days
}
```

#### File-Based Storage:
```typescript
class FileBackedOutputCapture implements OutputCapture {
  private buffers = new Map<TaskId, Buffer>();
  private files = new Map<TaskId, string>();
  
  append(taskId: TaskId, data: string, stream: 'stdout' | 'stderr') {
    const size = Buffer.byteLength(data);
    
    if (this.shouldUseFile(taskId, size)) {
      this.writeToFile(taskId, data, stream);
    } else {
      this.appendToBuffer(taskId, data, stream);
    }
  }
}
```

### Phase 4: Task Dependencies (Priority 4)
**Problem:** Can't define task execution order
**Impact:** Limited to independent tasks only

#### Implementation Details:
- Directed Acyclic Graph (DAG) for dependencies
- Cycle detection
- Topological sorting for execution order

```typescript
interface TaskDependencies {
  readonly dependencies: TaskId[];  // Tasks that must complete first
  readonly dependents: TaskId[];    // Tasks waiting for this one
}

class DependencyGraph {
  canExecute(taskId: TaskId): boolean
  addDependency(from: TaskId, to: TaskId): Result<void>
  removeDependency(from: TaskId, to: TaskId): Result<void>
  detectCycle(taskId: TaskId): boolean
  getExecutionOrder(): TaskId[]
}
```

#### Queue Integration:
```typescript
class DependencyAwareQueue extends PriorityTaskQueue {
  private graph = new DependencyGraph();
  
  dequeue(): Result<Task | null> {
    // Find highest priority task with satisfied dependencies
    const tasks = this.getAllSorted();
    
    for (const task of tasks) {
      if (this.graph.canExecute(task.id)) {
        return this.remove(task.id);
      }
    }
    
    return ok(null);
  }
}
```

### Phase 5: Enhanced Metrics (Priority 5)
**Problem:** No visibility into resource usage
**Impact:** Can't optimize or debug performance

#### Implementation Details:
- Per-task resource tracking
- System health metrics
- Historical data for analysis

```typescript
interface TaskMetrics {
  readonly taskId: TaskId;
  readonly cpuTime: number;        // CPU seconds used
  readonly peakMemory: number;      // Max memory bytes
  readonly avgMemory: number;       // Average memory
  readonly ioOperations: number;    // File I/O count
  readonly duration: number;        // Wall clock time
}

interface SystemMetrics {
  readonly timestamp: number;
  readonly activeTasks: number;
  readonly queuedTasks: number;
  readonly totalCompleted: number;
  readonly totalFailed: number;
  readonly avgTaskDuration: number;
  readonly systemCpu: number;
  readonly systemMemory: number;
}
```

## Implementation Strategy

### Step 1: Add Persistence (Primary Storage)
1. Add SQLite dependency
2. Create repository implementations
3. Replace in-memory storage with SQLite
4. Implement startup recovery
5. Test thoroughly with database as primary storage

### Step 2: Add Timeout Enforcement
1. Add timeout configuration
2. Implement timeout handling in WorkerPool
3. Add per-task timeout option
4. Test timeout scenarios

### Step 3: Feature Rollout
1. Ship each feature when complete
2. No feature flags needed (pristine project)
3. Gather feedback from early users
4. Iterate based on real-world usage

## Timeline Estimate

### Phase 1: Persistence (1 week)
- Day 1-2: Database setup and schema
- Day 3-4: Repository implementation
- Day 5-6: Integration and testing
- Day 7: Documentation and release

### Phase 2: Timeout (3 days)
- Day 1: Timeout implementation
- Day 2: Graceful shutdown handling
- Day 3: Testing and release

### Phase 3: Output Management (3 days)
- Day 1: File-based storage
- Day 2: Compression and cleanup
- Day 3: Testing and release

### Phase 4: Dependencies (1 week)
- Day 1-2: DAG implementation
- Day 3-4: Queue integration
- Day 5-6: API and testing
- Day 7: Documentation and release

### Phase 5: Metrics (3 days)
- Day 1: Resource tracking
- Day 2: Metrics aggregation
- Day 3: API and release

## Success Criteria

### Phase 1 Success:
- Tasks persist across restarts
- No data loss on crash
- Startup time < 5 seconds with 1000 tasks

### Phase 2 Success:
- No runaway tasks
- Clean timeout handling
- Configurable per-task

### Phase 3 Success:
- Handle 1GB+ outputs
- No OOM with large outputs
- Automatic cleanup working

### Phase 4 Success:
- Complex workflows possible
- Cycle detection working
- Correct execution order

### Phase 5 Success:
- Full resource visibility
- Performance optimization possible
- Historical analysis available

## Risk Mitigation

### Risk: SQLite Performance
**Mitigation:** Use WAL mode, prepared statements, connection pooling

### Risk: Database Corruption
**Mitigation:** Regular backups, WAL mode, integrity checks

### Risk: Complexity Growth
**Mitigation:** Keep SOLID principles, maintain test coverage, modular design

### Risk: Resource Overhead
**Mitigation:** Lazy loading, efficient queries, caching layer

## Next Steps

1. **Immediate:** Start Phase 1 (Persistence) - most critical
2. **This Week:** Complete persistence and timeout
3. **Next Week:** Output management and dependencies
4. **Month End:** Full feature set with metrics

## Notes

- Maintain backward compatibility where possible
- Each phase should be independently releasable
- Focus on production readiness over features
- Keep the "no configuration required" philosophy