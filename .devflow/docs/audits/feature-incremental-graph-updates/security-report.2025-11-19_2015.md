# Security Audit Report

**Branch**: feature/incremental-graph-updates
**Base**: main
**Date**: 2025-11-19 20:15:00
**Files Analyzed**: 3
**Lines Changed**: +397 / -22

---

## Executive Summary

This audit analyzed the incremental graph update performance optimization that adds `addEdge()`, `removeEdge()`, and `removeTask()` methods to `DependencyGraph` and replaces the nullable cached graph pattern with an always-initialized graph in `SQLiteDependencyRepository`.

**Key Findings:**
- **CRITICAL**: State synchronization vulnerability in concurrent scenarios
- **HIGH**: Missing validation allows graph corruption
- **MEDIUM**: Race conditions in multi-threaded environments
- Several pre-existing issues in touched code

**Overall Security Score**: 6/10

**Merge Recommendation**: REVIEW REQUIRED - Critical state synchronization issue must be addressed

---

## Issues in Your Changes (BLOCKING)

These vulnerabilities were introduced in lines you added or modified in this branch.

### CRITICAL: Graph-Database Desynchronization in Transaction Rollback

**File**: `src/implementations/dependency-repository.ts:284` (line ADDED)
**Severity**: CRITICAL
**Standard**: OWASP A04:2021 - Insecure Design

**Vulnerability**: 
The incremental graph update `this.graph.addEdge(taskId, depId)` is called INSIDE the transaction function but BEFORE the transaction completes. If the transaction fails or rolls back after the graph update, the in-memory graph becomes desynchronized from the database state, allowing invalid dependency relationships.

**Attack Scenario**:
1. Attacker creates dependency that passes cycle validation
2. Concurrent operation causes transaction to fail/rollback
3. Graph retains the edge but database does not
4. Future cycle detection checks against corrupted graph state
5. Attacker can now add cycles that bypass DAG validation

**Code (Lines 277-285)**:
```typescript
for (const depId of dependsOn) {
  const result = this.addDependencyStmt.run(taskId, depId, createdAt);
  const row = this.getDependencyByIdStmt.get(result.lastInsertRowid) as Record<string, any>;
  createdDependencies.push(this.rowToDependency(row));

  // PERFORMANCE: Update graph incrementally (O(1)) instead of invalidating cache
  // Eliminates expensive findAll() calls on next dependency addition
  this.graph.addEdge(taskId, depId);  // VULNERABILITY: Called before transaction commits
}

return createdDependencies;
```

**Fix**: Move graph updates OUTSIDE the transaction to execute only after successful commit:
```typescript
// In dependency-repository.ts
async addDependencies(taskId: TaskId, dependsOn: readonly TaskId[]): Promise<Result<readonly TaskDependency[]>> {
  // ... validation ...
  
  const addDependenciesTransaction = this.db.transaction((taskId: TaskId, dependsOn: readonly TaskId[]) => {
    // ... all validation and database operations ...
    
    for (const depId of dependsOn) {
      const result = this.addDependencyStmt.run(taskId, depId, createdAt);
      const row = this.getDependencyByIdStmt.get(result.lastInsertRowid) as Record<string, any>;
      createdDependencies.push(this.rowToDependency(row));
      
      // DO NOT update graph here - transaction may still rollback
    }
    
    return createdDependencies;
  });

  // Execute transaction
  const result = tryCatch(
    () => addDependenciesTransaction(taskId, dependsOn),
    (error) => { /* error handling */ }
  );
  
  // ONLY update graph after successful commit
  if (result.ok) {
    for (const depId of dependsOn) {
      this.graph.addEdge(taskId, depId);
    }
  }
  
  return result;
}
```

**Impact**: 
- Allows bypassing DAG cycle detection
- Can cause deadlocks in task execution
- Corrupts dependency tracking state
- Violates ACID properties

---

### HIGH: Missing Input Validation in Public Graph Methods

**File**: `src/core/dependency-graph.ts:77-79, 96-111, 127-153` (lines ADDED)
**Severity**: HIGH
**Standard**: CWE-20 - Improper Input Validation

**Vulnerability**: 
The new public methods `addEdge()`, `removeEdge()`, and `removeTask()` do not validate input parameters. They directly cast `TaskId` to string and perform operations without checking for null, undefined, empty strings, or malicious input.

**Attack Scenario**:
1. Caller passes `null`, `undefined`, or `""` as TaskId
2. Graph operations proceed with invalid keys
3. Graph state becomes corrupted with empty/invalid nodes
4. Subsequent cycle detection fails or produces incorrect results
5. System accepts invalid task dependencies

**Code (Line 77-79)**:
```typescript
addEdge(taskId: TaskId, dependsOnTaskId: TaskId): void {
  this.addEdgeInternal(taskId, dependsOnTaskId);  // No validation
}
```

**Code (Line 96-111)**:
```typescript
removeEdge(taskId: TaskId, dependsOnTaskId: TaskId): void {
  const taskIdStr = taskId as string;
  const dependsOnStr = dependsOnTaskId as string;
  
  // No validation - empty strings, null, undefined allowed
  const deps = this.graph.get(taskIdStr);
  if (deps) {
    deps.delete(dependsOnStr);
  }
  // ...
}
```

**Fix**: Add input validation to all public methods:
```typescript
private validateTaskId(taskId: TaskId, paramName: string): void {
  if (!taskId || typeof taskId !== 'string' || taskId.trim() === '') {
    throw new DelegateError(
      ErrorCode.INVALID_OPERATION,
      `Invalid ${paramName}: must be non-empty string`
    );
  }
}

addEdge(taskId: TaskId, dependsOnTaskId: TaskId): void {
  this.validateTaskId(taskId, 'taskId');
  this.validateTaskId(dependsOnTaskId, 'dependsOnTaskId');
  this.addEdgeInternal(taskId, dependsOnTaskId);
}

removeEdge(taskId: TaskId, dependsOnTaskId: TaskId): void {
  this.validateTaskId(taskId, 'taskId');
  this.validateTaskId(dependsOnTaskId, 'dependsOnTaskId');
  
  const taskIdStr = taskId as string;
  const dependsOnStr = dependsOnTaskId as string;
  
  const deps = this.graph.get(taskIdStr);
  if (deps) {
    deps.delete(dependsOnStr);
  }
  
  const reverseDeps = this.reverseGraph.get(dependsOnStr);
  if (reverseDeps) {
    reverseDeps.delete(taskIdStr);
  }
}

removeTask(taskId: TaskId): void {
  this.validateTaskId(taskId, 'taskId');
  
  const taskIdStr = taskId as string;
  // ... rest of implementation
}
```

**Impact**:
- Graph corruption with invalid nodes
- Incorrect cycle detection results
- Potential null pointer exceptions in graph traversal
- Data integrity violations

---

### MEDIUM: Race Condition in Graph Initialization

**File**: `src/implementations/dependency-repository.ts:104-106` (lines ADDED)
**Severity**: MEDIUM
**Standard**: CWE-362 - Concurrent Execution using Shared Resource with Improper Synchronization

**Vulnerability**: 
The graph is initialized synchronously in the constructor using `findAllStmt.all()`. If another thread or process adds dependencies between reading the data and constructing the `DependencyGraph`, the graph will be missing those dependencies.

**Attack Scenario**:
1. Process A creates `SQLiteDependencyRepository` and reads all dependencies
2. Process B (via another MCP connection) adds a new dependency
3. Process A constructs graph without Process B's dependency
4. Process A's cycle detection is incomplete
5. Process B adds another dependency that creates a cycle (undetected by Process A)

**Code (Lines 102-106)**:
```typescript
// PERFORMANCE: Initialize graph once from database
// Subsequent operations use incremental updates instead of rebuilding
const allDepsRows = this.findAllStmt.all() as Record<string, any>[];
const allDeps = allDepsRows.map(row => this.rowToDependency(row));
this.graph = new DependencyGraph(allDeps);
```

**Fix**: Use a database lock or atomic snapshot:
```typescript
constructor(database: Database) {
  this.db = database.getDatabase();
  
  // ... prepare statements ...
  
  // SECURITY: Initialize graph with database lock to prevent TOCTOU
  const initGraph = this.db.transaction(() => {
    const allDepsRows = this.findAllStmt.all() as Record<string, any>[];
    return allDepsRows.map(row => this.rowToDependency(row));
  });
  
  const allDeps = initGraph();
  this.graph = new DependencyGraph(allDeps);
}
```

**Note**: SQLite in WAL mode provides some isolation, but this depends on configuration. Better-sqlite3's synchronous transactions should provide snapshot isolation.

**Impact**:
- Incomplete graph initialization
- Missing dependencies in cycle detection
- Race condition window during initialization

---

### MEDIUM: No Rollback Handling in deleteDependencies

**File**: `src/implementations/dependency-repository.ts:588-592` (lines MODIFIED)
**Severity**: MEDIUM
**Standard**: OWASP A04:2021 - Insecure Design

**Vulnerability**: 
Similar to the addDependencies issue, `graph.removeTask()` is called immediately after the delete statement runs, but if an error occurs in the error handler or if the statement execution fails partway through, the graph update happens anyway.

**Attack Scenario**:
1. Delete operation partially completes (deletes some but not all dependencies)
2. Operation throws error
3. Graph update `removeTask()` executes anyway in the try block
4. Graph state doesn't match database state
5. Future operations use incorrect graph

**Code (Lines 586-592)**:
```typescript
async deleteDependencies(taskId: TaskId): Promise<Result<void>> {
  return tryCatchAsync(
    async () => {
      this.deleteDependenciesStmt.run(taskId, taskId);

      // PERFORMANCE: Update graph incrementally instead of invalidating cache
      // Removes all edges where task is source or target (O(E) where E = edges for this task)
      this.graph.removeTask(taskId);  // VULNERABILITY: No rollback if error occurs
    },
    (error) => new DelegateError(
      ErrorCode.SYSTEM_ERROR,
      `Failed to delete dependencies: ${error}`,
      { taskId }
    )
  );
}
```

**Fix**: Verify operation success before updating graph:
```typescript
async deleteDependencies(taskId: TaskId): Promise<Result<void>> {
  return tryCatchAsync(
    async () => {
      const result = this.deleteDependenciesStmt.run(taskId, taskId);
      
      // Only update graph if delete actually happened
      if (result.changes > 0) {
        this.graph.removeTask(taskId);
      }
    },
    (error) => new DelegateError(
      ErrorCode.SYSTEM_ERROR,
      `Failed to delete dependencies: ${error}`,
      { taskId }
    )
  );
}
```

**Impact**:
- Graph-database desynchronization on errors
- Incorrect dependency state after failed deletes
- Data integrity violations

---

## Issues in Code You Touched (Should Fix)

These vulnerabilities exist in code you modified or functions you updated. Consider fixing while working on this area.

### HIGH: No Atomicity Guarantee for Graph Operations

**File**: `src/core/dependency-graph.ts:127-153` (removeTask method you added)
**Severity**: HIGH
**Standard**: CWE-662 - Improper Synchronization

**Vulnerability**: 
The `removeTask()` method performs multiple mutations (deleting from `graph`, deleting from `reverseGraph`, updating Sets) without atomicity. If an exception occurs mid-operation, the graph ends up in an inconsistent state with partial deletions.

**Context**: 
You added this method in this PR. The underlying graph structure is mutable (Map of Sets), and the removeTask operation is not atomic.

**Recommendation**: 
Implement transactional semantics or make operations idempotent:

```typescript
removeTask(taskId: TaskId): void {
  const taskIdStr = taskId as string;
  
  // Collect all operations first (read phase)
  const outgoing = this.graph.get(taskIdStr);
  const incoming = this.reverseGraph.get(taskIdStr);
  
  const reverseDepsToUpdate: Array<{ dep: string, reverseDeps: Set<string> }> = [];
  const depsToUpdate: Array<{ dependent: string, deps: Set<string> }> = [];
  
  if (outgoing) {
    for (const dep of outgoing) {
      const reverseDeps = this.reverseGraph.get(dep);
      if (reverseDeps) {
        reverseDepsToUpdate.push({ dep, reverseDeps });
      }
    }
  }
  
  if (incoming) {
    for (const dependent of incoming) {
      const deps = this.graph.get(dependent);
      if (deps) {
        depsToUpdate.push({ dependent, deps });
      }
    }
  }
  
  // Apply all mutations (write phase)
  // If exception occurs here, at least we've validated everything first
  for (const { reverseDeps } of reverseDepsToUpdate) {
    reverseDeps.delete(taskIdStr);
  }
  
  for (const { deps } of depsToUpdate) {
    deps.delete(taskIdStr);
  }
  
  this.graph.delete(taskIdStr);
  this.reverseGraph.delete(taskIdStr);
}
```

**Alternative**: Make graph immutable and return new graph instance, but this conflicts with the performance goals of this PR.

---

### HIGH: Private graph Field Breaks Immutability Contract

**File**: `src/implementations/dependency-repository.ts:38` (line MODIFIED)
**Severity**: HIGH
**Standard**: Architectural Violation

**Vulnerability**: 
The graph field is marked `readonly` but holds a mutable `DependencyGraph` object. The DependencyGraph's internal Maps/Sets can be mutated. This violates the immutability principles stated in CLAUDE.md and creates opportunities for uncontrolled state mutations.

**Context**: 
You changed from `cachedGraph: DependencyGraph | null` to `readonly graph: DependencyGraph`. The readonly keyword only prevents reassignment, not mutation of the object's internals.

**Recommendation**: 
Either:
1. Make DependencyGraph truly immutable (return new instances on mutations)
2. Add defensive copying mechanisms
3. Document that this is an exception to immutability with clear justification

```typescript
// Option 1: Document the exception
// ARCHITECTURE EXCEPTION: Mutable graph for performance
// JUSTIFICATION: Incremental updates provide 70-80% latency reduction
// TRADE-OFF: Violates immutability principle but synchronized with database transactions
// MITIGATION: All mutations happen within database transaction boundaries
private readonly graph: DependencyGraph;
```

**Impact**:
- Architectural inconsistency
- Harder to reason about state changes
- Potential for unintended mutations

---

### MEDIUM: No Validation of Graph Consistency After Updates

**File**: `src/implementations/dependency-repository.ts:284, 592` (lines MODIFIED)
**Severity**: MEDIUM
**Standard**: OWASP A08:2021 - Software and Data Integrity Failures

**Vulnerability**: 
After performing incremental graph updates, there's no validation that the graph still matches the database state. Over time, bugs or race conditions could cause drift between graph and database without detection.

**Context**: 
You added incremental updates but removed the cache invalidation safety mechanism that forced periodic reloading from database.

**Recommendation**: 
Add periodic consistency checks or integrity validation:

```typescript
// Add to SQLiteDependencyRepository
private lastConsistencyCheck = Date.now();
private readonly CONSISTENCY_CHECK_INTERVAL = 60000; // 1 minute

private async validateGraphConsistency(): Promise<void> {
  const now = Date.now();
  if (now - this.lastConsistencyCheck < this.CONSISTENCY_CHECK_INTERVAL) {
    return;
  }
  
  this.lastConsistencyCheck = now;
  
  // Rebuild graph from database and compare
  const allDepsRows = this.findAllStmt.all() as Record<string, any>[];
  const allDeps = allDepsRows.map(row => this.rowToDependency(row));
  const freshGraph = new DependencyGraph(allDeps);
  
  // Compare sizes as a basic sanity check
  if (this.graph.size() !== freshGraph.size()) {
    console.error(`Graph inconsistency detected: memory=${this.graph.size()}, database=${freshGraph.size()}`);
    // Could throw error or rebuild graph here
  }
}

// Call before critical operations
async addDependencies(taskId: TaskId, dependsOn: readonly TaskId[]): Promise<Result<readonly TaskDependency[]>> {
  await this.validateGraphConsistency();
  // ... rest of method
}
```

---

## Pre-existing Issues Found (Not Blocking)

These vulnerabilities exist in files you reviewed but are unrelated to your changes.

### MEDIUM: Type Casting Without Validation

**File**: `src/core/dependency-graph.ts:38` (pre-existing, untouched)
**Severity**: MEDIUM
**Standard**: CWE-704 - Incorrect Type Conversion

**Vulnerability**: 
Throughout `DependencyGraph`, TaskId branded types are cast to string using `as string` without validation. If TaskId type guards are bypassed elsewhere in the codebase, invalid values could reach graph operations.

**Code (Line 38-39)**:
```typescript
private addEdgeInternal(taskId: TaskId, dependsOnTaskId: TaskId): void {
  const taskIdStr = taskId as string;  // No validation
  const dependsOnStr = dependsOnTaskId as string;  // No validation
  // ...
}
```

**Recommendation**: 
Add runtime type checking at the boundary:
```typescript
private validateAndConvert(taskId: TaskId): string {
  if (typeof taskId !== 'string' || !taskId.trim()) {
    throw new DelegateError(
      ErrorCode.INVALID_OPERATION,
      'Invalid TaskId: must be non-empty string'
    );
  }
  return taskId as string;
}
```

**Reason not blocking**: This is a pre-existing pattern throughout the file, unrelated to your incremental update changes.

---

### MEDIUM: No Maximum Graph Size Limit

**File**: `src/core/dependency-graph.ts:24-32` (constructor, pre-existing)
**Severity**: MEDIUM
**Standard**: CWE-770 - Allocation of Resources Without Limits

**Vulnerability**: 
The `DependencyGraph` constructor accepts any size dependency array and builds potentially unbounded Maps. An attacker could create excessive dependencies to cause memory exhaustion.

**Code (Lines 24-32)**:
```typescript
constructor(dependencies: readonly TaskDependency[] = []) {
  this.graph = new Map();
  this.reverseGraph = new Map();

  // Build graph from dependency list
  for (const dep of dependencies) {
    this.addEdgeInternal(dep.taskId, dep.dependsOnTaskId);
  }
}
```

**Recommendation**: 
Add size limits:
```typescript
private static readonly MAX_GRAPH_SIZE = 10000; // nodes

constructor(dependencies: readonly TaskDependency[] = []) {
  if (dependencies.length > DependencyGraph.MAX_GRAPH_SIZE) {
    throw new DelegateError(
      ErrorCode.INVALID_OPERATION,
      `Cannot create graph: exceeds maximum size of ${DependencyGraph.MAX_GRAPH_SIZE} dependencies`
    );
  }
  
  this.graph = new Map();
  this.reverseGraph = new Map();

  for (const dep of dependencies) {
    this.addEdgeInternal(dep.taskId, dep.dependsOnTaskId);
  }
}
```

**Reason not blocking**: Pre-existing issue. `SQLiteDependencyRepository` does have `MAX_DEPENDENCIES_PER_TASK = 100`, but no total dependency limit.

---

### LOW: Missing Bounds Checking in wouldCreateCycle

**File**: `src/core/dependency-graph.ts:178` (pre-existing, untouched)
**Severity**: LOW
**Standard**: CWE-834 - Excessive Iteration

**Vulnerability**: 
The `wouldCreateCycle()` method creates a temporary graph by shallow-copying the entire graph Map. For very large graphs, this could cause memory pressure. Additionally, there's no depth limit on the DFS traversal.

**Code (Lines 177-184)**:
```typescript
// Create temporary graph with the proposed edge
const tempGraph = new Map(this.graph);  // Shallow copy entire graph

// Add proposed edge to temp graph
if (!tempGraph.has(taskIdStr)) {
  tempGraph.set(taskIdStr, new Set());
}
tempGraph.get(taskIdStr)!.add(dependsOnStr);
```

**Recommendation**: 
Consider copy-on-write or just traverse without copying:
```typescript
// Instead of creating tempGraph, just check if adding edge creates cycle
// by checking if dependsOnTaskId can reach taskId in current graph
const visited = new Set<string>();
const recursionStack = new Set<string>();

// Simulate adding the edge by checking if dependsOnTaskId -> ... -> taskId path exists
const wouldCycle = this.canReach(dependsOnStr, taskIdStr, visited, recursionStack);
return ok(wouldCycle);
```

**Reason not blocking**: Pre-existing algorithm, works correctly for graphs under `MAX_DEPENDENCY_CHAIN_DEPTH = 100`.

---

### LOW: Error Messages Expose Internal State

**File**: `src/implementations/dependency-repository.ts:244` (pre-existing, touched)
**Severity**: LOW
**Standard**: CWE-209 - Generation of Error Message Containing Sensitive Information

**Vulnerability**: 
Error messages expose internal task IDs directly to users/logs without sanitization. In some contexts, task IDs might be considered sensitive.

**Code (Line 242-245)**:
```typescript
if (cycleCheck.value) {
  throw new DelegateError(
    ErrorCode.INVALID_OPERATION,
    `Cannot add dependency: would create cycle (${taskId} -> ${depId})`
  );
}
```

**Recommendation**: 
Use generic error messages or sanitize IDs:
```typescript
throw new DelegateError(
  ErrorCode.INVALID_OPERATION,
  'Cannot add dependency: would create cycle',
  { taskId, depId }  // Keep details in metadata for logging, not user-facing message
);
```

**Reason not blocking**: Low risk, task IDs are UUIDs with no inherent sensitivity. Consider if using more structured identifiers.

---

## Summary

**Your Changes:**
- **CRITICAL**: 1 (MUST FIX - Transaction rollback desynchronization)
- **HIGH**: 2 (MUST FIX - Missing input validation, no validation of graph consistency)
- **MEDIUM**: 2 (MUST FIX - Race condition in initialization, no rollback handling)

**Code You Touched:**
- **HIGH**: 2 (SHOULD FIX - No atomicity guarantee, breaks immutability contract)
- **MEDIUM**: 1 (SHOULD FIX - No consistency validation)

**Pre-existing:**
- **MEDIUM**: 2 (OPTIONAL - Type casting, no max graph size)
- **LOW**: 2 (OPTIONAL - Bounds checking, error message exposure)

**Security Score**: 6/10

**Merge Recommendation**: REVIEW REQUIRED

This PR introduces a critical state synchronization vulnerability where graph updates happen inside transactions before commit. This could allow DAG cycle detection bypass through race conditions or rollbacks.

---

## Remediation Priority

**Fix before merge:**

1. **CRITICAL - Transaction Desynchronization** (dependency-repository.ts:284)
   - Move `graph.addEdge()` calls OUTSIDE transaction
   - Only update graph after successful commit
   - Add similar fix for `graph.removeTask()` in deleteDependencies

2. **HIGH - Missing Input Validation** (dependency-graph.ts:77, 96, 127)
   - Add `validateTaskId()` method
   - Validate all parameters in public methods
   - Reject null, undefined, empty strings

3. **HIGH - Race Condition in Initialization** (dependency-repository.ts:104)
   - Wrap graph initialization in transaction for snapshot isolation
   - Document SQLite isolation guarantees

4. **MEDIUM - No Rollback Handling** (dependency-repository.ts:592)
   - Check `result.changes` before updating graph
   - Ensure graph only updates on successful database operations

**Fix while you're here:**

1. **HIGH - Atomicity in removeTask** (dependency-graph.ts:127-153)
   - Refactor to two-phase operation (read then write)
   - Minimize mutation windows

2. **HIGH - Document Immutability Exception** (dependency-repository.ts:38)
   - Add clear ARCHITECTURE EXCEPTION comment
   - Justify mutable state for performance

3. **MEDIUM - Add Consistency Checks** (dependency-repository.ts)
   - Periodic validation of graph vs database
   - Detect and recover from drift

**Future work:**
- Consider adding integrity checks in test suite
- Document thread-safety guarantees
- Add circuit breaker for graph size limits
- Implement proper observability for graph state

---

## Testing Recommendations

Add these test cases before merge:

1. **Transaction Rollback Test**:
```typescript
it('should not update graph if transaction fails', async () => {
  // Inject failure after database insert but before transaction commits
  // Verify graph does not contain the edge
});
```

2. **Invalid Input Test**:
```typescript
it('should reject null/undefined/empty TaskIds', () => {
  const graph = new DependencyGraph();
  expect(() => graph.addEdge(null as any, TaskId('task-1'))).toThrow();
  expect(() => graph.addEdge(TaskId(''), TaskId('task-1'))).toThrow();
});
```

3. **Concurrent Initialization Test**:
```typescript
it('should handle concurrent dependency additions during initialization', async () => {
  // Create repo while another thread adds dependencies
  // Verify graph includes all dependencies
});
```

4. **Graph Consistency Test**:
```typescript
it('should maintain graph-database consistency after many operations', async () => {
  // Perform 1000 add/remove operations
  // Rebuild graph from database
  // Assert graphs are identical
});
```

---

## Conclusion

This PR provides significant performance improvements (70-80% latency reduction) through incremental graph updates, which is valuable. However, it introduces a critical security vulnerability around transaction safety that must be addressed before merge.

The core issue is that mutable state (the graph) is being updated inside database transactions before commit, creating windows for desynchronization. Moving graph updates outside transactions will fix the critical issue while preserving the performance benefits.

The additional input validation and consistency checking recommendations will make the implementation more robust and maintainable.

**Recommendation**: Address the CRITICAL and HIGH severity issues, add the suggested test cases, then re-review before merge.
