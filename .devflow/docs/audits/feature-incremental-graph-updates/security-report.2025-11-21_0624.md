# Security Audit Report

**Branch**: feature/incremental-graph-updates
**Base**: main
**Date**: 2025-11-21 06:24:00
**Files Analyzed**: 9
**Lines Changed**: +880 / -286

---

## Executive Summary

This branch refactors the dependency management system to use incremental in-memory graph updates instead of rebuilding from database on each operation. The architecture change moves business logic (cycle detection) from repository to handler layer.

**Critical Finding**: The refactoring **removed depth chain validation** from the repository but **did not add it to the handler**, creating a Denial of Service (DoS) vulnerability.

---

## Category 1: Issues in Your Changes (BLOCKING)

These vulnerabilities were introduced in lines you added or modified.

### HIGH: Missing Dependency Chain Depth Validation (DoS Vulnerability)

**File**: `/workspace/delegate/src/services/handlers/dependency-handler.ts` (lines 102-137)
**Also**: `/workspace/delegate/src/implementations/dependency-repository.ts` (removed from lines 219-246)

**Vulnerability**: The refactoring removed `MAX_DEPENDENCY_CHAIN_DEPTH` validation from the repository but did NOT add equivalent validation to the handler. This removes a security control that prevents stack overflow attacks.

**Previous Protection** (removed in this PR):
```typescript
// REMOVED FROM dependency-repository.ts:
// SECURITY: Check dependency chain depth to prevent stack overflow
let maxDependencyDepth = 0;
for (const depId of dependsOn) {
  const depIdDepth = graph.getMaxDepth(depId);
  if (depIdDepth > maxDependencyDepth) {
    maxDependencyDepth = depIdDepth;
  }
}

const resultingDepth = 1 + maxDependencyDepth;
if (resultingDepth > SQLiteDependencyRepository.MAX_DEPENDENCY_CHAIN_DEPTH) {
  throw new DelegateError(
    ErrorCode.INVALID_OPERATION,
    `Cannot add dependencies: would create dependency chain depth of ${resultingDepth} (maximum ${SQLiteDependencyRepository.MAX_DEPENDENCY_CHAIN_DEPTH})`
  );
}
```

**Current Handler Code** (missing depth check):
```typescript
// src/services/handlers/dependency-handler.ts:102-137
// Only performs cycle detection, NO depth validation:
for (const depId of task.dependsOn) {
  const cycleCheck = this.graph.wouldCreateCycle(task.id, depId);
  // ... handles cycle only
}
// All cycle checks passed - persist to database
const addResult = await this.dependencyRepo.addDependencies(task.id, task.dependsOn);
```

**Attack Scenario**:
1. Attacker creates a chain of 1000+ tasks: T1 -> T2 -> T3 -> ... -> T1000
2. Without depth validation, all dependencies are accepted
3. Operations that traverse the graph (topological sort, getAllDependencies, getMaxDepth) may cause:
   - Stack overflow from deep recursion
   - Excessive memory consumption
   - CPU exhaustion during DFS traversal

**Impact**: Denial of Service - system can be made unresponsive by creating excessively deep dependency chains.

**Severity**: HIGH (DoS vector, breaks existing security control)

**Remediation**:
Add depth validation to `DependencyHandler.handleTaskDelegated()`:

```typescript
// After cycle detection, before persisting:
const MAX_DEPTH = 100; // Match repository constant

for (const depId of task.dependsOn) {
  const depth = this.graph.getMaxDepth(depId);
  const resultingDepth = 1 + depth;
  if (resultingDepth > MAX_DEPTH) {
    const error = new DelegateError(
      ErrorCode.INVALID_OPERATION,
      `Cannot add dependency: would create chain depth of ${resultingDepth} (max ${MAX_DEPTH})`,
      { taskId: task.id, dependsOnTaskId: depId, depth: resultingDepth }
    );
    return err(error);
  }
}
```

**Standard**: OWASP A04:2021 - Insecure Design

---

### MEDIUM: Graph-Database Synchronization Gap on Delete Operations

**File**: `/workspace/delegate/src/implementations/dependency-repository.ts` (lines 531-546)
**File**: `/workspace/delegate/src/services/handlers/dependency-handler.ts` (no removeEdge/removeTask calls)

**Vulnerability**: The repository's `deleteDependencies()` method removes dependencies from the database but the handler does NOT update its in-memory graph. This creates a state desynchronization.

**Repository Code** (database update only):
```typescript
// src/implementations/dependency-repository.ts:531-546
async deleteDependencies(taskId: TaskId): Promise<Result<void>> {
  return tryCatchAsync(
    async () => {
      // Delete from database (removes edges, NOT the task node itself)
      this.deleteDependenciesStmt.run(taskId, taskId);

      // NOTE: Graph updates removed
      // ARCHITECTURE: DependencyHandler now owns graph and handles updates via events
    },
    // ...
  );
}
```

**Handler Code** (no corresponding graph update):
- Handler subscribes to: `TaskDelegated`, `TaskCompleted`, `TaskFailed`, `TaskCancelled`, `TaskTimeout`
- Handler does NOT subscribe to any deletion event
- New `graph.removeEdge()` and `graph.removeTask()` methods exist but are never called

**Attack Scenario**:
1. Tasks A->B->C are created (dependencies in DB and graph)
2. Task B is deleted via `deleteDependencies(taskB.id)`
3. Database removes B's edges, but in-memory graph still contains them
4. New task D requests `dependsOn: [taskA.id]`
5. Cycle detection uses stale graph data and may:
   - Allow cycles that should be blocked
   - Block valid dependencies due to phantom edges

**Impact**: 
- False positives: Valid dependencies rejected
- False negatives: Invalid cycles potentially allowed (security impact)
- Memory leak: Phantom nodes never cleaned up

**Severity**: MEDIUM (data integrity issue, potential for bypassing cycle detection)

**Remediation**:
1. Create `TaskDeleted` event that handlers can subscribe to
2. In `DependencyHandler`, subscribe to deletion events and call `graph.removeTask()`
3. Or: Add `removeTaskFromGraph()` method that repository calls directly

```typescript
// In DependencyHandler.setup():
eventBus.subscribe('TaskDeleted', this.handleTaskDeleted.bind(this)),

// New handler:
private async handleTaskDeleted(event: TaskDeletedEvent): Promise<void> {
  this.graph.removeTask(event.taskId);
  this.logger.debug('Graph updated: task removed', { taskId: event.taskId });
}
```

**Standard**: CWE-662 - Improper Synchronization

---

### LOW: Potential TOCTOU Window in Handler Cycle Detection

**File**: `/workspace/delegate/src/services/handlers/dependency-handler.ts` (lines 102-176)

**Vulnerability**: The handler performs cycle detection on the in-memory graph, then separately persists to database. If another handler instance or concurrent request modifies the database between these operations, the graph and database may diverge.

**Code Pattern**:
```typescript
// Step 1: Check cycle on in-memory graph (line 105)
const cycleCheck = this.graph.wouldCreateCycle(task.id, depId);

// ... potential race window ...

// Step 2: Persist to database (line 141) - separate transaction
const addResult = await this.dependencyRepo.addDependencies(task.id, task.dependsOn);

// Step 3: Update in-memory graph (lines 170-176)
for (const dependency of addResult.value) {
  this.graph.addEdge(dependency.taskId, dependency.dependsOnTaskId);
}
```

**Mitigating Factors**:
- Single-threaded Node.js event loop limits true parallelism
- Repository uses synchronous SQLite transactions internally
- Graph updates happen in same event loop tick as database response

**Impact**: In high-concurrency scenarios, graph state may temporarily diverge from database. The previous implementation had cycle detection inside the synchronous database transaction, providing stronger atomicity.

**Severity**: LOW (mitigated by Node.js event loop, but weaker than previous design)

**Recommendation**: Document this architectural trade-off. Consider adding a periodic graph reconciliation or full rebuild mechanism.

---

## Category 2: Issues in Code You Touched (SHOULD FIX)

These vulnerabilities exist in code you modified but didn't introduce.

### MEDIUM: Unused Security Constants

**File**: `/workspace/delegate/src/implementations/dependency-repository.ts` (lines 17-18)

**Issue**: Security constants remain defined but one is no longer enforced:

```typescript
export class SQLiteDependencyRepository implements DependencyRepository {
  // SECURITY: Hard limits to prevent DoS attacks and stack overflow
  private static readonly MAX_DEPENDENCIES_PER_TASK = 100;  // Still enforced line 167
  private static readonly MAX_DEPENDENCY_CHAIN_DEPTH = 100; // NO LONGER ENFORCED
```

**Impact**: 
- Misleading code comments suggest protection exists when it doesn't
- Future maintainers may assume depth checking is active

**Recommendation**: 
Either:
1. Move `MAX_DEPENDENCY_CHAIN_DEPTH` to handler and enforce it there (preferred)
2. Remove the constant if intentionally not enforcing depth limits
3. Add deprecation comment explaining where validation moved

---

### LOW: Error Message Information Disclosure

**File**: `/workspace/delegate/src/services/handlers/dependency-handler.ts` (lines 115-119)

**Issue**: Error messages include task IDs which could leak internal identifiers in API responses:

```typescript
const error = new DelegateError(
  ErrorCode.INVALID_OPERATION,
  `Cannot add dependency: would create cycle (${task.id} -> ${depId})`,
  { taskId: task.id, dependsOnTaskId: depId }
);
```

**Impact**: Low - task IDs are UUIDs and not inherently sensitive, but verbose error messages can aid attackers in understanding system internals.

**Recommendation**: Consider generic user-facing messages with detailed logging:
```typescript
// User-facing
`Cannot add dependency: operation would create circular reference`
// Detailed logging (already done)
this.logger.warn('Cycle detected', { taskId: task.id, dependsOnTaskId: depId });
```

---

## Category 3: Pre-existing Issues (INFORMATIONAL)

These vulnerabilities exist in code unrelated to your changes.

### INFORMATIONAL: `dangerously-skip-permissions` in Process Spawner

**File**: `/workspace/delegate/src/implementations/process-spawner.ts` (line 24)

**Pre-existing Code**:
```typescript
this.baseArgs = Object.freeze(['--print', '--dangerously-skip-permissions', '--output-format', 'json']);
```

**Note**: This is by design for the Claude Code CLI integration. The spawned Claude Code instances operate in a sandboxed context. Not related to this PR.

---

### INFORMATIONAL: No Rate Limiting on Task Delegation

**Pre-existing**: The system lacks rate limiting on task creation, allowing rapid task creation that could exhaust resources.

**Note**: Not related to this PR. Consider for future security hardening.

---

## Summary

| Category | Severity | Count |
|----------|----------|-------|
| **Your Changes** | HIGH | 1 |
| **Your Changes** | MEDIUM | 1 |
| **Your Changes** | LOW | 1 |
| **Code You Touched** | MEDIUM | 1 |
| **Code You Touched** | LOW | 1 |
| **Pre-existing** | INFORMATIONAL | 2 |

**Security Score**: 5/10

The architectural refactoring is sound in principle (moving business logic to handler, pure data access in repository), but the migration was incomplete - depth validation was removed but not re-implemented.

---

## Merge Recommendation

**REVIEW REQUIRED** - Do not merge until HIGH issue is addressed.

### Fix Before Merge (BLOCKING):

1. **[HIGH] Add depth chain validation to DependencyHandler**
   - Use `graph.getMaxDepth()` before persisting dependencies
   - Reject chains exceeding `MAX_DEPENDENCY_CHAIN_DEPTH`
   - This restores the security control that was removed

### Fix While You're Here (RECOMMENDED):

2. **[MEDIUM] Add graph synchronization for delete operations**
   - Subscribe to deletion events
   - Call `graph.removeTask()` or `graph.removeEdge()` when tasks/dependencies are deleted

3. **[MEDIUM] Remove or relocate unused constant**
   - Either move `MAX_DEPENDENCY_CHAIN_DEPTH` to handler and use it
   - Or add comment explaining the intentional removal

### Future Work:

4. Consider periodic graph-database reconciliation mechanism
5. Add rate limiting for task creation (separate PR)

---

## Appendix: Changed Files Security Review

| File | Risk Level | Notes |
|------|------------|-------|
| `CLAUDE.md` | None | Documentation only |
| `package.json` | None | Test configuration, memory limits |
| `src/core/dependency-graph.ts` | **Low** | New methods well-validated, proper input checks |
| `src/implementations/dependency-repository.ts` | **High** | Removed security control without replacement |
| `src/services/handlers/dependency-handler.ts` | **Medium** | Missing depth validation, sync gap on delete |
| `tests/unit/core/dependency-graph.test.ts` | None | Test coverage |
| `tests/unit/implementations/dependency-repository.test.ts` | None | Test coverage |
| `tests/unit/services/handlers/dependency-handler.test.ts` | None | Test coverage |
| `vitest.config.ts` | None | Test configuration |

---

**Report Generated**: 2025-11-21 06:24:00 UTC
**Auditor**: Claude Code Security Audit
