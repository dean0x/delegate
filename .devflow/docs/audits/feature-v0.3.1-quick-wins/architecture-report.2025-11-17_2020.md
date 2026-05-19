# Architecture Audit Report

**Branch**: feature/v0.3.1-quick-wins
**Base**: main
**Date**: 2025-11-17 20:20:00
**Auditor**: Claude Code Architecture Specialist

---

## Executive Summary

This branch introduces **security hardening** and **atomic transaction support** for the dependency system. The changes add input validation limits (max 100 dependencies per task, max 100 chain depth) and atomic batch operations for adding multiple dependencies.

**Overall Assessment**: APPROVED WITH CONDITIONS

**Architecture Score**: 8.5/10

**Key Strengths**:
- Excellent use of Result pattern throughout
- Strong TOCTOU protection via synchronous transactions
- Proper dependency injection maintained
- No state mutations (immutable pattern preserved)
- Comprehensive validation with clear error messages

**Key Concerns**:
- One BLOCKING issue: `visited` set allocated but never used in `getMaxDepth()`
- Several HIGH priority issues in code organization and algorithm efficiency

---

## Issues in Your Changes (BLOCKING)

### CRITICAL: Unused Variable Allocation

**File**: `/workspace/delegate/src/core/dependency-graph.ts`
**Lines**: 375-425 (new code)
**Severity**: CRITICAL

**Issue**: The `getMaxDepth()` method allocates a `visited` Set on line 378 but never uses it:

```typescript
getMaxDepth(taskId: TaskId): Result<number> {
  const taskIdStr = taskId as string;
  const memo = new Map<string, number>();
  const visited = new Set<string>();  // <-- ALLOCATED BUT NEVER USED

  const calculateDepth = (node: string, currentPath: Set<string>): number => {
    // ...uses currentPath and memo, but never uses visited
  };
}
```

**Root Cause**: The algorithm uses `currentPath` for cycle detection and `memo` for memoization. The `visited` set appears to be a copy-paste artifact from other DFS methods (`detectCycleDFS`, `getAllDependencies`) that DO need a visited set because they don't use memoization.

**Why This Is CRITICAL**:
1. Memory waste: Every call allocates an unused Set
2. Code confusion: Misleads future maintainers about the algorithm
3. Suggests incomplete refactoring or misunderstanding of the algorithm
4. In a pure functional module, dead code is a red flag

**Fix**:
```typescript
getMaxDepth(taskId: TaskId): Result<number> {
  const taskIdStr = taskId as string;
  const memo = new Map<string, number>();
  // REMOVED: const visited = new Set<string>(); // Not needed - memo handles visited tracking

  const calculateDepth = (node: string, currentPath: Set<string>): number => {
    // Existing implementation is correct
  };
}
```

**Recommendation**: BLOCKING - Remove the unused `visited` set before merge.

---

### HIGH: Algorithm Redundancy in Cycle Detection

**File**: `/workspace/delegate/src/core/dependency-graph.ts`
**Lines**: 384-388
**Severity**: HIGH

**Issue**: The `calculateDepth()` inner function performs defensive cycle detection using `currentPath`, but this is redundant:

```typescript
const calculateDepth = (node: string, currentPath: Set<string>): number => {
  // Check for cycle (shouldn't happen in valid DAG, but defensive)
  if (currentPath.has(node)) {
    return 0;  // <-- Returns 0 on cycle, silently masking corruption
  }
```

**Problems**:
1. **Silent failure**: Returns 0 instead of error, violating Result pattern
2. **Redundant validation**: Graph already validated as DAG before this method is called
3. **Misleading comment**: "defensive" programming that hides bugs is anti-pattern
4. **Inconsistent with architecture**: Pure algorithms shouldn't have defensive checks that mask corruption

**Architecture Principle Violated**:
The codebase follows "fail fast" principle with explicit Result types. Defensive checks that return default values (0) violate this principle.

**Better Approach**:
```typescript
const calculateDepth = (node: string, currentPath: Set<string>): number => {
  // ARCHITECTURE: Graph is guaranteed to be a DAG by construction
  // If cycle detected here, it's a critical bug, not user error
  if (currentPath.has(node)) {
    throw new Error(`INVARIANT VIOLATION: Cycle detected in DAG at node ${node}`);
  }
```

**Recommendation**: HIGH - Either remove the check (trust the DAG invariant) OR convert to assertion that throws on violation.

---

### HIGH: Missing Type Safety for Magic Numbers

**File**: `/workspace/delegate/src/implementations/dependency-repository.ts`
**Lines**: 162-167, 185-190, 250-255
**Severity**: HIGH

**Issue**: Magic numbers `100` are hardcoded in three places without type-safe constants:

```typescript
// Line 162
if (dependsOn.length > 100) {
  return err(new DelegateError(
    ErrorCode.INVALID_OPERATION,
    `Cannot add ${dependsOn.length} dependencies: task cannot have more than 100 dependencies`
  ));
}

// Line 185
if (existingDepsCount + dependsOn.length > 100) {
  // ...message mentions 100
}

// Line 250
if (resultingDepth > 100) {
  // ...message mentions 100
}
```

**Problems**:
1. **Maintainability**: Changing limits requires updating 6 locations (3 checks + 3 error messages)
2. **Type safety**: No compile-time enforcement that all locations are updated
3. **Configuration**: These should be configurable, not hardcoded
4. **Testing**: Tests also hardcode these values, creating coupling

**Architecture Principle Violated**:
The Config interface exists for exactly this purpose (see `src/core/interfaces.ts` lines 167-175), but these limits aren't included.

**Correct Approach**:
```typescript
// In src/core/interfaces.ts
export interface Config {
  readonly maxOutputBuffer: number;
  readonly taskTimeout: number;
  readonly cpuCoresReserved: number;
  readonly memoryReserve: number;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  readonly maxListenersPerEvent?: number;
  readonly maxTotalSubscriptions?: number;
  
  // ADD THESE:
  readonly maxDependenciesPerTask: number;  // Default: 100
  readonly maxDependencyChainDepth: number; // Default: 100
}

// In dependency-repository.ts constructor
constructor(database: Database, private readonly config: Config) {
  // Use config.maxDependenciesPerTask throughout
}
```

**Recommendation**: HIGH - Extract to Config interface for type safety and configurability.

---

## Issues in Code You Touched (Should Fix)

### MEDIUM: Code Duplication in addDependency()

**File**: `/workspace/delegate/src/implementations/dependency-repository.ts`
**Lines**: 112-124
**Severity**: MEDIUM

**Issue**: The refactored `addDependency()` delegates to `addDependencies()`, which is good, but the comments claim this "eliminates duplicate validation logic":

```typescript
async addDependency(taskId: TaskId, dependsOnTaskId: TaskId): Promise<Result<TaskDependency>> {
  // REFACTOR: Delegate to addDependencies() to eliminate duplicate validation logic
  // This centralizes all validation (task existence, cycle detection, depth check, etc.)
  // in a single location, improving maintainability and consistency
  const batchResult = await this.addDependencies(taskId, [dependsOnTaskId]);

  if (!batchResult.ok) {
    return batchResult;
  }

  // Extract the single dependency from the batch result
  return ok(batchResult.value[0]);
}
```

**Analysis**: This IS the correct pattern and follows DRY principle well. However:

**Minor Issues**:
1. **Array allocation overhead**: Creates single-element array for every single-dependency call
2. **Type narrowing**: Result type changes from `Result<TaskDependency>` to `Result<readonly TaskDependency[]>` then back
3. **Error messages**: Batch error messages might be confusing for single-dependency calls (e.g., "One or more dependencies already exist" when only one was provided)

**Trade-off Analysis**:
- **Pro**: DRY principle, single source of truth for validation
- **Con**: Performance overhead for common case (single dependency)
- **Verdict**: The refactor is GOOD, but could be optimized

**Better Approach** (if performance matters):
```typescript
// Keep both implementations but extract shared validation
private validateDependency(taskId: TaskId, dependsOnTaskId: TaskId, graph: DependencyGraph): Result<void> {
  // Shared validation logic
}

async addDependency(...): Promise<Result<TaskDependency>> {
  // Optimized single-item path
}

async addDependencies(...): Promise<Result<readonly TaskDependency[]>> {
  // Batch path using shared validation
}
```

**Recommendation**: OPTIONAL - Current approach is acceptable, but consider performance optimization if this is a hot path.

---

### MEDIUM: Transaction Error Handling Loses Context

**File**: `/workspace/delegate/src/implementations/dependency-repository.ts`
**Lines**: 274-299
**Severity**: MEDIUM

**Issue**: The transaction error handling preserves DelegateError but loses stack trace context:

```typescript
return tryCatch(
  () => addDependenciesTransaction(taskId, dependsOn),
  (error) => {
    // Preserve semantic DelegateError types
    if (error instanceof DelegateError) {
      return error;  // <-- Stack trace from transaction is lost
    }

    // Handle UNIQUE constraint violation
    if (error instanceof Error && error.message.includes('UNIQUE constraint')) {
      return new DelegateError(
        ErrorCode.INVALID_OPERATION,
        `One or more dependencies already exist for task: ${taskId}`,
        { taskId, dependsOn }
      );
    }

    // Unknown errors become SYSTEM_ERROR
    return new DelegateError(
      ErrorCode.SYSTEM_ERROR,
      `Failed to add dependencies: ${error}`,
      { taskId, dependsOn }
    );
  }
);
```

**Problem**:
When a DelegateError is thrown inside the transaction (e.g., cycle detection, task not found), the error is returned as-is. This loses the original stack trace from where the error was thrown, making debugging harder.

**Better Approach**:
```typescript
return tryCatch(
  () => addDependenciesTransaction(taskId, dependsOn),
  (error) => {
    if (error instanceof DelegateError) {
      // Preserve original error but add transaction context
      return new DelegateError(
        error.code,
        error.message,
        { ...error.context, transactionOperation: 'addDependencies', taskId, dependsOn },
        error // Pass original as cause
      );
    }
    // ...rest of error handling
  }
);
```

**Recommendation**: MEDIUM - Enhance error handling to preserve stack traces while adding transaction context.

---

### MEDIUM: Cache Invalidation Timing Issue

**File**: `/workspace/delegate/src/implementations/dependency-repository.ts`
**Lines**: 268-269
**Severity**: MEDIUM

**Issue**: Cache invalidation happens INSIDE the transaction BEFORE the function returns:

```typescript
const addDependenciesTransaction = this.db.transaction((taskId: TaskId, dependsOn: readonly TaskId[]) => {
  // ...validation and insertion...

  // PERFORMANCE: Invalidate cache after successful batch insertion
  this.cachedGraph = null;  // <-- Inside transaction

  return createdDependencies;
});
```

**Problem**:
This is a **state mutation inside a transaction function**. While it works with better-sqlite3's synchronous transactions, it violates functional programming principles:

1. **Side effects in transaction**: Transaction functions should be pure (only database operations)
2. **Inconsistent timing**: Cache is invalidated before `tryCatch` wrapper, so if error handling fails, cache is still invalidated
3. **Testing complexity**: Harder to test transaction logic in isolation

**Better Approach**:
```typescript
const result = tryCatch(
  () => addDependenciesTransaction(taskId, dependsOn),
  (error) => { /* error handling */ }
);

// Invalidate cache AFTER successful transaction
if (result.ok) {
  this.cachedGraph = null;
}

return result;
```

**Recommendation**: MEDIUM - Move cache invalidation outside transaction for cleaner separation of concerns.

---

### LOW: Inconsistent JSDoc Style

**File**: `/workspace/delegate/src/implementations/dependency-repository.ts`
**Lines**: 126-150
**Severity**: LOW

**Issue**: The new `addDependencies()` method has excellent JSDoc, but it's more verbose than other methods in the file:

```typescript
/**
 * Add multiple dependencies atomically in a single transaction
 *
 * Uses synchronous better-sqlite3 transaction for atomicity.
 * All dependencies succeed or all fail together (no partial state).
 * Performs cycle detection for each proposed dependency before persisting any.
 *
 * @param taskId - The task that depends on other tasks
 * @param dependsOn - Array of task IDs to depend on
 * @returns Result containing array of created TaskDependency objects or error if:
 *   - Any dependency would create a cycle (ErrorCode.INVALID_OPERATION)
 *   - Any dependency already exists (ErrorCode.INVALID_OPERATION)
 *   - Any task doesn't exist (ErrorCode.TASK_NOT_FOUND)
 *   - Empty array provided (ErrorCode.INVALID_OPERATION)
 *
 * @example
 * ```typescript
 * const result = await dependencyRepo.addDependencies(taskC.id, [taskA.id, taskB.id]);
 * if (!result.ok) {
 *   console.error('Failed to add dependencies:', result.error.message);
 * } else {
 *   console.log(`Added ${result.value.length} dependencies atomically`);
 * }
 * ```
 */
```

**Analysis**: This is actually GOOD documentation, but it's inconsistent with the rest of the file. Compare to other methods which have shorter docs.

**Recommendation**: LOW - Either enhance other method docs to match this quality OR simplify this doc to match file convention. Consistency matters.

---

### LOW: Logging Granularity in DependencyHandler

**File**: `/workspace/delegate/src/services/handlers/dependency-handler.ts`
**Lines**: 109-143
**Severity**: LOW

**Issue**: The refactored `handleTaskDelegated()` method logs at INFO level for every task:

```typescript
this.logger.info('Processing dependencies for new task', {
  taskId: task.id,
  dependencyCount: task.dependsOn.length,
  dependencies: task.dependsOn
});

// ...later...

this.logger.info('All dependencies added atomically', {
  taskId: task.id,
  count: addResult.value.length,
  dependencyIds: addResult.value.map(d => d.id)
});
```

**Problem**:
In a high-throughput system with many tasks, INFO-level logging for every task creates noise. This should be DEBUG level, with INFO reserved for errors or significant events.

**Better Approach**:
```typescript
this.logger.debug('Processing dependencies for new task', { /* ... */ });

// Keep INFO for errors:
this.logger.error('Failed to add dependencies', addResult.error, { /* ... */ });
```

**Recommendation**: LOW - Downgrade routine success logging to DEBUG level to reduce noise in production.

---

## Pre-existing Issues (Not Blocking)

### INFO: Graph Caching Strategy Could Be Improved

**Files**: 
- `/workspace/delegate/src/implementations/dependency-repository.ts` (lines 30-32, 216-222)
- `/workspace/delegate/src/services/handlers/dependency-handler.ts` (lines 23-24, 66-84)

**Severity**: INFO

**Issue**: Two separate caches exist for the dependency graph:

1. **DependencyRepository cache** (line 32): `private cachedGraph: DependencyGraph | null = null;`
2. **DependencyHandler cache** (line 24): `private graphCache: DependencyGraph | null = null;`

**Analysis**:
- Repository cache is used for cycle detection during `addDependencies()`
- Handler cache is used for... nothing in the new code (old code used it for pre-insertion validation)

**Finding**: The handler-level cache is now **dead code** after the refactor. The handler no longer performs cycle detection (correctly delegated to repository), so `getGraph()` method (lines 66-84) is never called.

**Recommendation**: INFO - Remove handler-level caching in future refactor. The repository-level cache is sufficient.

---

### INFO: Missing Transaction Retry Logic

**File**: `/workspace/delegate/src/implementations/dependency-repository.ts`
**Lines**: 169-273
**Severity**: INFO

**Issue**: SQLite transactions can fail with `SQLITE_BUSY` if database is locked. Current implementation doesn't retry:

```typescript
const addDependenciesTransaction = this.db.transaction((taskId: TaskId, dependsOn: readonly TaskId[]) => {
  // ...no retry logic...
});
```

**Analysis**:
The `better-sqlite3` library returns `SQLITE_BUSY` if another transaction holds a lock. For production systems, transactions should retry with exponential backoff.

**Mitigation**: SQLite WAL mode (already enabled per CLAUDE.md) reduces lock contention, making this less critical.

**Recommendation**: INFO - Consider adding transaction retry wrapper for production robustness. Not blocking for current PR.

---

### INFO: Depth Calculation Could Use DP Instead of DFS

**File**: `/workspace/delegate/src/core/dependency-graph.ts`
**Lines**: 375-425
**Severity**: INFO

**Issue**: The `getMaxDepth()` algorithm uses DFS with memoization (top-down dynamic programming). For DAGs, bottom-up DP is more efficient:

**Current Approach** (Top-down DFS + memoization):
- Time: O(V + E) with memoization
- Space: O(V) for memo + O(depth) for recursion stack
- Pros: Simple, correct
- Cons: Recursion stack can overflow on deep chains (>100 depth)

**Alternative Approach** (Bottom-up DP with topological sort):
```typescript
getMaxDepth(taskId: TaskId): Result<number> {
  // 1. Topological sort (O(V + E))
  const sortResult = this.topologicalSort();
  if (!sortResult.ok) return sortResult;
  
  // 2. Bottom-up DP (O(V + E))
  const depth = new Map<string, number>();
  for (const node of sortResult.value) {
    const deps = this.graph.get(node) || new Set();
    depth.set(node, deps.size === 0 ? 0 : 1 + Math.max(...Array.from(deps).map(d => depth.get(d) || 0)));
  }
  
  return ok(depth.get(taskId as string) || 0);
}
```

**Analysis**: Current recursive approach is fine for max depth 100. If depth limit increases, consider iterative DP.

**Recommendation**: INFO - Current implementation is acceptable. Document max depth limit of 100 to prevent stack overflow.

---

## Summary

### Your Changes (Lines Added/Modified in This Branch)

**Critical Issues**: 1
- Unused `visited` variable allocation in `getMaxDepth()`

**High Issues**: 2
- Redundant cycle detection in `calculateDepth()` with silent failure
- Magic numbers (100) hardcoded instead of using Config interface

**Medium Issues**: 0

**Total Blocking/High Issues**: 3

---

### Code You Touched (Functions/Modules Modified)

**Medium Issues**: 3
- Array allocation overhead in `addDependency()` delegation
- Transaction error handling loses stack trace context
- Cache invalidation happens inside transaction

**Low Issues**: 2
- Inconsistent JSDoc verbosity
- INFO-level logging creates noise

**Total Should-Fix Issues**: 5

---

### Pre-existing Issues (Files Reviewed But Not Modified)

**Info Issues**: 3
- Duplicate graph caching (handler-level cache is dead code)
- Missing transaction retry logic for SQLITE_BUSY
- Alternative DP algorithm could be more efficient

**Total Informational Issues**: 3

---

## Architecture Score Breakdown

**Criteria** | **Score** | **Notes**
------------ | --------- | ---------
Result Pattern Usage | 10/10 | Perfect - all methods return Result types
Dependency Injection | 10/10 | All dependencies injected, no direct instantiation
Immutability | 9/10 | -1: Cache mutation inside transaction
Type Safety | 7/10 | -3: Magic numbers not type-safe constants
Error Handling | 8/10 | -2: Stack traces lost in error propagation
Separation of Concerns | 9/10 | -1: Cache invalidation mixed with transaction logic
Code Duplication | 9/10 | -1: Minor duplication in validation
Documentation | 9/10 | -1: Inconsistent JSDoc style
Testing | 10/10 | Comprehensive tests for all new functionality
Performance | 8/10 | -2: Algorithm has minor inefficiencies

**Overall Architecture Score**: 8.5/10

---

## Merge Recommendation

**Status**: APPROVED WITH CONDITIONS

**Blocking Issues** (Must fix before merge):
1. Remove unused `visited` variable in `getMaxDepth()` (line 378)
2. Fix or remove redundant cycle detection in `calculateDepth()` (lines 384-388)
3. Extract magic number 100 to Config interface

**Recommended Fixes** (Should fix while here):
4. Move cache invalidation outside transaction
5. Enhance error handling to preserve stack traces
6. Downgrade routine logging from INFO to DEBUG

**Future Refactoring** (Separate PR):
7. Remove dead handler-level graph cache
8. Add transaction retry logic
9. Consider iterative DP algorithm if depth limit increases

---

## Detailed File Analysis

### src/core/dependency-graph.ts

**Lines Changed**: 353-426 (73 new lines)
**Impact**: NEW PUBLIC METHOD

**Changes**:
- Added `getMaxDepth(taskId)` method for calculating maximum dependency chain depth
- Algorithm: DFS with memoization for O(V+E) complexity
- Used for security validation (prevent chains > 100 deep)

**Architecture Compliance**:
- ✅ Returns Result type
- ✅ Pure function (no side effects)
- ✅ Well documented with JSDoc and examples
- ❌ Unused variable allocation (`visited`)
- ❌ Redundant defensive cycle check with silent failure

**Test Coverage**: 7 new tests covering linear chains, diamond graphs, deep chains (101 tasks), and memoization performance

---

### src/core/interfaces.ts

**Lines Changed**: 110-115 (7 new lines)
**Impact**: INTERFACE EXTENSION (BREAKING CHANGE)

**Changes**:
- Added `addDependencies(taskId, dependsOn)` method to DependencyRepository interface
- Enables atomic batch operations for adding multiple dependencies

**Architecture Compliance**:
- ✅ Returns Result type
- ✅ Uses readonly arrays for immutability
- ✅ Clear JSDoc explaining atomicity semantics
- ✅ Backward compatible (addDependency still exists)

**Breaking Change Analysis**: NOT BREAKING - New method added, existing methods unchanged

---

### src/implementations/dependency-repository.ts

**Lines Changed**: 112-299 (188 lines modified, ~100 new)
**Impact**: MAJOR REFACTOR

**Changes**:
- Refactored `addDependency()` to delegate to new `addDependencies()` method
- Implemented `addDependencies()` with atomic transaction semantics
- Added validation: max 100 dependencies per task, max 100 chain depth
- Added security hardening against DoS attacks

**Architecture Compliance**:
- ✅ All operations use Result pattern
- ✅ TOCTOU protection via synchronous transactions
- ✅ Comprehensive error handling with semantic error codes
- ✅ Cache invalidation for consistency
- ❌ Magic numbers instead of Config constants
- ❌ Cache mutation inside transaction
- ⚠️ Stack traces lost in error propagation

**Security Improvements**:
- Max 100 dependencies per task (prevents DoS)
- Max 100 chain depth (prevents stack overflow)
- Atomic transactions (prevents partial state)

**Test Coverage**: 11 new tests for atomic batch operations, rollback scenarios, validation limits

---

### src/services/handlers/dependency-handler.ts

**Lines Changed**: 94-155 (62 lines modified)
**Impact**: SIMPLIFICATION

**Changes**:
- Removed manual cycle detection loop (delegated to repository)
- Simplified `handleTaskDelegated()` to call `addDependencies()` directly
- Changed from sequential single-dependency adds to atomic batch add
- Improved logging to show dependency IDs after successful batch

**Architecture Compliance**:
- ✅ Proper separation of concerns (handler delegates to repository)
- ✅ Event-driven pattern maintained
- ✅ Error handling via Result pattern
- ⚠️ INFO-level logging for routine operations (should be DEBUG)

**Code Quality**: IMPROVED - Removed 30 lines of validation logic by delegating to repository layer

---

## Recommendations by Priority

### BLOCKING (Must fix before merge)

1. **Remove unused `visited` variable**
   - File: `src/core/dependency-graph.ts:378`
   - Change: Delete line `const visited = new Set<string>();`
   - Estimated effort: 1 minute

2. **Fix redundant cycle detection**
   - File: `src/core/dependency-graph.ts:384-388`
   - Change: Either remove check OR throw Error instead of returning 0
   - Estimated effort: 5 minutes

3. **Extract magic numbers to Config**
   - Files: `src/core/interfaces.ts`, `src/implementations/dependency-repository.ts`
   - Change: Add `maxDependenciesPerTask` and `maxDependencyChainDepth` to Config interface
   - Estimated effort: 15 minutes

### HIGH (Should fix while you're here)

4. **Move cache invalidation outside transaction**
   - File: `src/implementations/dependency-repository.ts:268-269`
   - Change: Move `this.cachedGraph = null` to after `tryCatch` wrapper
   - Estimated effort: 5 minutes

5. **Preserve stack traces in error handling**
   - File: `src/implementations/dependency-repository.ts:274-299`
   - Change: Enhance DelegateError to accept `cause` parameter
   - Estimated effort: 10 minutes

6. **Downgrade routine logging to DEBUG**
   - File: `src/services/handlers/dependency-handler.ts:109,138`
   - Change: Change `logger.info()` to `logger.debug()` for success cases
   - Estimated effort: 2 minutes

### OPTIONAL (Future PRs)

7. Remove dead handler-level cache
8. Add transaction retry logic
9. Consider iterative DP algorithm

---

## Conclusion

This branch delivers valuable **security hardening** and **atomic transaction** improvements to the dependency system. The code follows architectural principles well (Result pattern, dependency injection, immutability) but has **3 blocking issues** that must be addressed before merge.

The most critical issue is the unused `visited` variable, which suggests incomplete refactoring. The magic numbers should be extracted to the Config interface for type safety and configurability.

After addressing blocking issues, this PR will significantly improve the robustness and security of the task dependency system.

**Final Verdict**: APPROVED WITH CONDITIONS - Fix 3 blocking issues, merge recommended.

---

**Report Generated**: 2025-11-17 20:20:00
**Audit Scope**: 4 files, 330 lines changed
**Test Coverage**: 18 new tests (all passing)
