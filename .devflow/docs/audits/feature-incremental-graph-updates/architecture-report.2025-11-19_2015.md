# Architecture Audit Report

**Branch**: feature/incremental-graph-updates  
**Base**: main  
**Date**: 2025-11-19 20:15:00  
**Auditor**: Claude Code Architecture Specialist

---

## Executive Summary

This branch changes DependencyGraph from a **cache-invalidation pattern** to an **incremental update pattern**. The change is architecturally sound and aligns with the project's performance optimization goals. However, there are **CRITICAL architecture violations** where the implementation bypasses the event-driven architecture documented in the project.

**Key Finding**: The dependency repository directly mutates the in-memory graph without emitting events, violating the pure event-driven architecture pattern that is a core principle of this codebase.

**Files Changed**:
- `src/core/dependency-graph.ts` (+93 lines)
- `src/implementations/dependency-repository.ts` (+22 lines, -22 lines modified)
- `tests/unit/core/dependency-graph.test.ts` (+282 lines)

---

## Red Flag Issues in Your Changes (BLOCKING)

### 1. CRITICAL: Event-Driven Architecture Violation

**Severity**: HIGH  
**File**: `src/implementations/dependency-repository.ts:284`  
**Line Added**: `this.graph.addEdge(taskId, depId);`

**Description**:
The dependency repository directly mutates the in-memory graph state without going through the EventBus. According to `docs/architecture/EVENT_FLOW.md` and the project's CLAUDE.md, this is a **pure event-driven architecture** where "all components communicate through a central EventBus" and "ALL operations go through events."

**Current Implementation (WRONG)**:
```typescript
// Line 284 in dependency-repository.ts
this.graph.addEdge(taskId, depId);  // Direct mutation - bypasses events!
```

**What Happens**:
1. Repository adds dependency to database
2. Repository directly updates graph (NO EVENT)
3. DependencyHandler listens for `TaskDependencyAdded` event
4. DependencyHandler invalidates its OWN cache (line 91 in dependency-handler.ts)
5. TWO SEPARATE GRAPHS exist: one in repository, one in handler

**Architecture Conflict**:
- DependencyHandler has `graphCache` (lines 25, 68-85 in dependency-handler.ts)
- DependencyRepository now has `graph` (line 38 in dependency-repository.ts)
- Both caches will diverge when events are missed or ordering changes

**Recommended Fix**:
Remove the in-memory graph from the repository entirely. The repository should ONLY persist to database and emit events. The DependencyHandler should own the graph and update it incrementally when events are received.

```typescript
// CORRECT PATTERN: Repository emits event, handler updates graph

// In dependency-repository.ts (addDependencies):
for (const depId of dependsOn) {
  const result = this.addDependencyStmt.run(taskId, depId, createdAt);
  const row = this.getDependencyByIdStmt.get(result.lastInsertRowid) as Record<string, any>;
  createdDependencies.push(this.rowToDependency(row));
  
  // DON'T update graph here - emit event instead
  // The event will be handled by DependencyHandler which owns the graph
}

// In dependency-handler.ts:
private async handleDependencyAdded(event: TaskDependencyAddedEvent): Promise<void> {
  // Update handler's graph incrementally
  if (!this.graphCache) {
    this.graphCache = await this.buildGraph();
  }
  this.graphCache.addEdge(event.taskId, event.dependsOnTaskId);
}
```

**Why This Matters**:
1. **Consistency**: Single source of truth for graph state
2. **Testability**: Events can be mocked/intercepted for testing
3. **Observability**: All state changes visible in event log
4. **Architecture Compliance**: Follows documented pure event-driven pattern

---

### 2. CRITICAL: Duplicate Graph State Ownership

**Severity**: HIGH  
**File**: `src/implementations/dependency-repository.ts:38`  
**Line Added**: `private readonly graph: DependencyGraph;`

**Description**:
The repository now owns a persistent graph instance, but DependencyHandler ALSO owns a graph cache (line 25: `private graphCache: DependencyGraph | null = null`). This creates two independent sources of truth.

**Evidence of Conflict**:
```typescript
// dependency-repository.ts:38
private readonly graph: DependencyGraph;  // Repository's graph

// dependency-handler.ts:25
private graphCache: DependencyGraph | null = null;  // Handler's graph
```

**When They Diverge**:
- Handler's graph is invalidated on `TaskDependencyAdded` event (line 91)
- Repository's graph is updated synchronously during database transaction
- If events are processed async or batched, graphs will have different states

**Recommended Fix**:
Remove graph ownership from repository. Repository should be a **pure data layer** with no business logic or caching.

```typescript
// Repository: ONLY database operations
class SQLiteDependencyRepository {
  // NO GRAPH - just database operations
  async addDependencies(taskId, dependsOn) {
    // Validate in database, persist, return
    // Cycle detection should use handler's graph via event
  }
}

// Handler: OWNS the graph and updates it incrementally
class DependencyHandler {
  private graph: DependencyGraph;  // Single source of truth
  
  async handleDependencyAdded(event) {
    this.graph.addEdge(event.taskId, event.dependsOnTaskId);
  }
}
```

---

### 3. HIGH: Cycle Detection Before Event Emission

**Severity**: MEDIUM  
**File**: `src/implementations/dependency-repository.ts:235`  
**Line Modified**: `const cycleCheck = this.graph.wouldCreateCycle(taskId, depId);`

**Description**:
Cycle detection happens in the repository using its local graph BEFORE the dependency is persisted and BEFORE events are emitted. This breaks the event-driven flow where validation should happen in handlers.

**Current Flow (WRONG)**:
```
Repository.addDependencies()
  → Check cycle using repository's graph (line 235)
  → Persist to database (line 278)
  → Update repository's graph (line 284)
  → Return to DependencyHandler
  → Handler emits TaskDependencyAdded event (line 148)
  → Handler invalidates its own cache (line 91)
```

**Correct Event-Driven Flow**:
```
Repository.addDependencies()
  → Validate task existence
  → Persist to database (optimistic - assume no cycle)
  → Return success
  
DependencyHandler.handleTaskDelegated()
  → Check cycle using handler's graph BEFORE calling repository
  → Call repository if valid
  → Update handler's graph incrementally on success
  → Emit TaskDependencyAdded event
```

**Why This Matters**:
Validation logic should live in handlers (business logic layer), not repositories (data access layer). This maintains proper separation of concerns and makes the code more testable.

---

## Warning Issues in Code You Touched (SHOULD FIX)

### 4. MEDIUM: Missing Error Handling for Graph Mutations

**Severity**: MEDIUM  
**File**: `src/implementations/dependency-repository.ts:284, 592`  
**Lines Added**: 
- Line 284: `this.graph.addEdge(taskId, depId);`
- Line 592: `this.graph.removeTask(taskId);`

**Description**:
The graph mutation methods (`addEdge`, `removeTask`, `removeEdge`) are void functions that cannot fail. If graph operations fail (e.g., memory issues), there's no way to handle or report errors.

**Risk**:
Graph state could become inconsistent with database state if mutations fail silently.

**Recommended Fix**:
Return Result types from graph mutation methods:

```typescript
// In dependency-graph.ts
addEdge(taskId: TaskId, dependsOnTaskId: TaskId): Result<void> {
  return tryCatch(
    () => {
      this.addEdgeInternal(taskId, dependsOnTaskId);
    },
    (error) => new DelegateError(
      ErrorCode.SYSTEM_ERROR,
      `Failed to add edge to graph: ${error}`
    )
  );
}
```

---

### 5. MEDIUM: Graph Initialized in Constructor with Synchronous Database Call

**Severity**: MEDIUM  
**File**: `src/implementations/dependency-repository.ts:104-106`  
**Lines Added**:
```typescript
const allDepsRows = this.findAllStmt.all() as Record<string, any>[];
const allDeps = allDepsRows.map(row => this.rowToDependency(row));
this.graph = new DependencyGraph(allDeps);
```

**Description**:
The constructor performs a synchronous full-table scan (`findAllStmt.all()`) on initialization. This violates the principle that constructors should be lightweight and not perform I/O operations.

**Problems**:
1. Constructor can't return errors (throws instead)
2. No way to handle database failures gracefully
3. Blocks initialization if table is large
4. Makes testing harder (requires real database in constructor)

**Recommended Fix**:
Use lazy initialization or async factory pattern:

```typescript
class SQLiteDependencyRepository {
  private graph: DependencyGraph | null = null;

  private async ensureGraph(): Promise<Result<DependencyGraph>> {
    if (this.graph) {
      return ok(this.graph);
    }

    const allDepsResult = await this.findAll();
    if (!allDepsResult.ok) {
      return allDepsResult;
    }

    this.graph = new DependencyGraph(allDepsResult.value);
    return ok(this.graph);
  }

  async addDependencies(...) {
    const graphResult = await this.ensureGraph();
    if (!graphResult.ok) return graphResult;
    
    // Use graphResult.value for validation
  }
}
```

---

### 6. LOW: Inconsistent Documentation

**Severity**: LOW  
**File**: `src/implementations/dependency-repository.ts:35-37`  
**Lines Added**:
```typescript
// PERFORMANCE: Maintain in-memory dependency graph with incremental updates
// ARCHITECTURE: Graph is initialized once from database and kept in sync with mutations
// Eliminates O(N) findAll() calls on every dependency addition (70-80% latency reduction)
```

**Description**:
Documentation claims this is an "ARCHITECTURE" decision, but it actually contradicts the documented architecture in `docs/architecture/EVENT_FLOW.md` which states the system uses "pure event-driven architecture."

**Recommended Fix**:
Update comment to acknowledge the trade-off:

```typescript
// PERFORMANCE OPTIMIZATION: In-memory graph cache with incremental updates
// NOTE: This bypasses event-driven architecture for performance (70-80% latency reduction)
// TRADE-OFF: Creates dual ownership with DependencyHandler's graph cache
// TODO: Refactor to event-driven incremental updates (move graph to handler)
```

---

## Informational Pre-existing Issues (NOT BLOCKING)

### 7. INFO: DependencyHandler Already Has Caching Logic

**Severity**: INFO  
**File**: `src/services/handlers/dependency-handler.ts:25, 68-85`  
**Pre-existing Code**:

```typescript
// Line 25
private graphCache: DependencyGraph | null = null;

// Lines 68-85
private async getGraph(): Promise<Result<DependencyGraph>> {
  if (this.graphCache) {
    this.logger.debug('Using cached dependency graph');
    return ok(this.graphCache);
  }

  this.logger.debug('Building fresh dependency graph');
  const allDepsResult = await this.dependencyRepo.findAll();
  if (!allDepsResult.ok) {
    return allDepsResult;
  }

  this.graphCache = new DependencyGraph(allDepsResult.value);
  return ok(this.graphCache);
}
```

**Observation**:
The handler already implements cache-invalidation pattern. Your changes add the SAME pattern in the repository, creating duplicate caching layers.

**Recommendation**:
Instead of adding caching to repository, enhance the handler's caching to use incremental updates:

```typescript
// In DependencyHandler
private async handleDependencyAdded(event: TaskDependencyAddedEvent) {
  // Incrementally update handler's cache instead of invalidating
  if (this.graphCache) {
    this.graphCache.addEdge(event.taskId, event.dependsOnTaskId);
  } else {
    // Lazy-load graph on first use
    this.graphCache = await this.buildGraph();
  }
}
```

---

### 8. INFO: Tests Don't Cover Event Integration

**Severity**: INFO  
**File**: `tests/unit/core/dependency-graph.test.ts`  
**Lines Added**: 282 test lines

**Observation**:
The new tests thoroughly validate graph operations in isolation but don't test integration with the event-driven architecture. Specifically missing:

1. Tests verifying graph updates happen AFTER events are emitted
2. Tests checking graph consistency between repository and handler
3. Integration tests for event flow with incremental updates

**Recommendation**:
Add integration tests in `tests/integration/` that verify:

```typescript
describe('Incremental Graph Updates - Event Integration', () => {
  it('should update handler graph when TaskDependencyAdded event fires', async () => {
    // Add dependency via repository
    await depRepo.addDependency(taskA, taskB);
    
    // Verify event was emitted
    expect(eventBus.emit).toHaveBeenCalledWith('TaskDependencyAdded', ...);
    
    // Verify handler's graph was updated
    const handlerGraph = await dependencyHandler.getGraph();
    expect(handlerGraph.hasEdge(taskA, taskB)).toBe(true);
  });
});
```

---

## Summary

### Your Changes (Lines Added/Modified)

**Critical Issues**:
- 1 HIGH: Event-driven architecture violation (direct graph mutation)
- 1 HIGH: Duplicate graph ownership (repository + handler)
- 1 MEDIUM: Cycle detection in wrong layer (should be in handler)

**Should Fix**:
- 1 MEDIUM: Missing error handling for graph mutations
- 1 MEDIUM: Synchronous database I/O in constructor
- 1 LOW: Inconsistent documentation

### Code You Touched

**Should Fix**:
- None (existing code in dependency-repository.ts follows patterns)

### Pre-existing Issues

**Informational**:
- Handler already has caching logic (opportunity to consolidate)
- Tests don't cover event integration (test coverage gap)

---

## Architecture Score

**6/10** - Good performance optimization, poor architecture compliance

**Breakdown**:
- **Performance**: +3 (70-80% latency reduction is excellent)
- **Correctness**: +2 (logic is correct, tests comprehensive)
- **Architecture**: -3 (violates event-driven architecture)
- **Maintainability**: -1 (duplicate graph ownership)
- **Best Practices**: +1 (good use of Result types, immutability)

---

## Merge Recommendation

**REVIEW REQUIRED** - Do not merge without addressing architecture violations

**Required Before Merge**:
1. **Remove graph from repository** - Move to handler only
2. **Implement event-driven incremental updates** - Handler updates graph on events
3. **Move cycle detection to handler** - Repository should be pure data layer

**Optional Improvements**:
4. Add Result types to graph mutation methods
5. Use lazy initialization instead of constructor I/O
6. Add integration tests for event flow

---

## Recommended Refactor Path

### Step 1: Move Graph Ownership to Handler

```typescript
// dependency-handler.ts
private graph: DependencyGraph;  // Not null, always initialized

constructor(depRepo, taskRepo, logger) {
  super(logger, 'DependencyHandler');
  this.graph = new DependencyGraph();  // Empty graph initially
}

async setup(eventBus: EventBus) {
  // Load graph on startup
  const allDepsResult = await this.dependencyRepo.findAll();
  if (allDepsResult.ok) {
    this.graph = new DependencyGraph(allDepsResult.value);
  }
  
  // Subscribe to events for incremental updates
  eventBus.subscribe('TaskDependencyAdded', this.handleDependencyAdded.bind(this));
}

private async handleDependencyAdded(event: TaskDependencyAddedEvent) {
  // Incremental update (O(1))
  this.graph.addEdge(event.taskId, event.dependsOnTaskId);
}
```

### Step 2: Repository Becomes Pure Data Layer

```typescript
// dependency-repository.ts
class SQLiteDependencyRepository {
  // NO GRAPH - just database operations
  
  async addDependencies(taskId, dependsOn) {
    // Only database operations and basic validation
    // No cycle detection here - that's handler's job
    return tryCatch(() => {
      this.db.transaction(() => {
        for (const depId of dependsOn) {
          this.addDependencyStmt.run(taskId, depId, Date.now());
        }
      })();
    });
  }
}
```

### Step 3: Handler Validates Before Repository

```typescript
// dependency-handler.ts
async handleTaskDelegated(event: TaskDelegatedEvent) {
  const task = event.task;
  
  if (!task.dependsOn || task.dependsOn.length === 0) {
    return ok(undefined);
  }
  
  // VALIDATE using handler's graph BEFORE calling repository
  for (const depId of task.dependsOn) {
    const cycleCheck = this.graph.wouldCreateCycle(task.id, depId);
    if (cycleCheck.value) {
      return err(new DelegateError(
        ErrorCode.INVALID_OPERATION,
        `Cannot add dependency: would create cycle`
      ));
    }
  }
  
  // Repository call (validation already done)
  const addResult = await this.dependencyRepo.addDependencies(task.id, task.dependsOn);
  
  if (addResult.ok) {
    // Update graph incrementally
    for (const depId of task.dependsOn) {
      this.graph.addEdge(task.id, depId);
    }
    
    // Emit events
    for (const depId of task.dependsOn) {
      await this.eventBus.emit('TaskDependencyAdded', {
        taskId: task.id,
        dependsOnTaskId: depId
      });
    }
  }
  
  return addResult;
}
```

---

## Additional Context

### Project Architecture Principles (from CLAUDE.md)

1. **Event-driven architecture**: "All components communicate via EventBus - no direct state management"
2. **Result types**: "Always use Result types - Never throw errors in business logic"
3. **Dependency injection**: "Inject dependencies - Makes testing trivial"
4. **No fake solutions**: "Never hardcode responses or data to simulate working functionality"

### Violated Principles

Your changes violate principle #1 by introducing direct state management (graph mutation) outside the event bus. This is a **fundamental architecture violation** that must be fixed before merge.

### Performance vs Architecture Trade-off

While the performance improvement (70-80% latency reduction) is valuable, it should NOT come at the cost of violating core architecture principles. The correct solution is to achieve the same performance within the event-driven architecture by:

1. Moving graph ownership to handler
2. Using incremental updates on event reception
3. Keeping repository as pure data layer

This achieves the same O(1) incremental updates while maintaining architectural consistency.

---

## Conclusion

The implementation demonstrates solid algorithm understanding and achieves excellent performance improvements. However, it fundamentally violates the project's pure event-driven architecture by:

1. Creating duplicate graph ownership across layers
2. Performing direct state mutations outside event flow
3. Mixing business logic (cycle detection) into data layer

**Recommendation**: Refactor to move graph ownership entirely to DependencyHandler and update it incrementally via events. This achieves the same performance benefits while maintaining architectural integrity.

**Timeline Estimate**: 4-6 hours to refactor properly with tests.

---

**Report Generated**: 2025-11-19 20:15:00  
**Audit Tool**: Claude Code Architecture Specialist v4.5  
**Next Review**: After addressing BLOCKING issues
