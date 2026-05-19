# Performance Audit Report

**Branch**: fix/issue-28-graph-corruption-shallow-copy
**Base**: main
**Date**: 2025-11-28 08:37
**Files Analyzed**: 6
**Lines Changed**: ~180 (additions + modifications)

---

## Executive Summary

This branch addresses Issue #28 (graph corruption due to shallow copy) and adds "settling worker" tracking to the resource monitor. The changes are primarily correctness fixes, not performance optimizations. However, one change introduces a measurable performance regression that must be evaluated.

**Key Findings:**
- The deep copy fix in `wouldCreateCycle()` introduces O(V) overhead per cycle check - this is the correct trade-off for correctness
- The settling worker tracking adds minimal overhead (array filter per spawn check)
- Configuration change from 50ms to 1000ms spawn delay significantly impacts worker responsiveness

---

## Issues in Your Changes (Category 1)

### HIGH - Performance Regression in wouldCreateCycle()

**File**: `/workspace/delegate/src/core/dependency-graph.ts:253-255`
**Line Status**: ADDED in this branch

**Problem**: Deep copy of graph Map creates O(V + E) overhead on every cycle check

**Code**:
```typescript
// Before (shallow - BUGGY):
const tempGraph = new Map(this.graph);

// After (deep - CORRECT but slower):
const tempGraph = new Map(
  Array.from(this.graph.entries()).map(([k, v]) => [k, new Set(v)])
);
```

**Analysis**:
- `Array.from()` iterates all entries: O(V)
- `new Set(v)` copies each Set: O(E/V) per Set, O(E) total
- Total: O(V + E) per cycle check

**Impact Assessment**:
- For small graphs (< 100 nodes): **Negligible** - microseconds
- For medium graphs (100-1000 nodes): **Acceptable** - low milliseconds
- For large graphs (> 1000 nodes): **Measurable** - could be 10-50ms

**Verdict**: **NOT BLOCKING**

This is the correct fix. The shallow copy bug caused graph corruption, which is far worse than the performance overhead. Cycle detection happens only when adding dependencies - not in hot paths. The trade-off is justified.

**Optimization Opportunity** (future work):
If performance becomes an issue with large graphs, consider:
1. Path-based cycle detection without copying (traverse existing graph + virtual edge)
2. Lazy evaluation with early termination
3. Incremental cycle detection algorithms

---

### LOW - Array Filter on Every Spawn Check

**File**: `/workspace/delegate/src/implementations/resource-monitor.ts:81-84`
**Line Status**: ADDED in this branch

**Code**:
```typescript
const now = Date.now();
this.recentSpawnTimestamps = this.recentSpawnTimestamps.filter(
  t => now - t < this.SETTLING_WINDOW_MS
);
```

**Analysis**:
- Array filter is O(N) where N = number of settling workers
- In practice, N is limited by `maxWorkers` (typically < 20)
- Creates new array on every call (minor GC pressure)

**Impact**: **Negligible**
- Worst case: ~20 iterations, microseconds
- Called only when checking spawn eligibility, not in tight loops

**Verdict**: **NOT BLOCKING** - No action needed

---

### MEDIUM - Configuration Change: 50ms to 1000ms Spawn Delay

**File**: `/workspace/delegate/src/core/configuration.ts:29,66`
**Line Status**: MODIFIED in this branch

**Code**:
```typescript
// Before:
minSpawnDelayMs: z.number().min(10).max(10000).default(50)

// After:
minSpawnDelayMs: z.number().min(10).max(30000).default(1000)
```

**Analysis**:
This is a 20x increase in minimum spawn delay. Combined with the 15-second settling window, this could significantly slow down initial worker scaling.

**Impact**:
- **Burst workload scenario**: If 10 tasks arrive simultaneously, workers now scale up at 1/second instead of 20/second
- **Cold start latency**: First worker: immediate, second worker: +1s, third: +2s, etc.
- **Responsiveness**: System takes longer to reach optimal parallelism

**Trade-offs**:
- PRO: Prevents over-spawning before load average reflects new workers
- CON: Slower scaling response to sudden workload increases

**Verdict**: **SHOULD EVALUATE** - Not a bug, but a significant behavioral change that may impact user experience depending on workload patterns.

**Recommendation**: Document this change in release notes and consider making it configurable per-deployment.

---

## Issues in Code You Touched (Category 2)

### No Issues Found

The modifications in `worker-handler.ts` (adding `recordSpawn()` call) are minimal and add negligible overhead.

---

## Pre-existing Performance Issues (Category 3)

### MEDIUM - getMaxDepth() Recursion Without Memoization Across Calls

**File**: `/workspace/delegate/src/core/dependency-graph.ts:545-588`
**Line Status**: NOT CHANGED - pre-existing

**Code**:
```typescript
getMaxDepth(taskId: TaskId): number {
  const memo = new Map<string, number>();
  // ... recursive DFS with memo
}
```

**Problem**: Memo is local to each call. If `getMaxDepth()` is called multiple times for different tasks, work is repeated.

**Impact**: Low (method doesn't appear to be in hot path)

**Recommendation**: If this becomes a hot path, consider caching at class level with invalidation on graph mutations.

---

### LOW - topologicalSort() Runs Full Cycle Check First

**File**: `/workspace/delegate/src/core/dependency-graph.ts:454-466`
**Line Status**: NOT CHANGED - pre-existing

**Code**:
```typescript
topologicalSort(): Result<readonly TaskId[]> {
  const cycleCheck = this.hasCycle();  // Full O(V+E) DFS
  // ... then Kahn's algorithm O(V+E)
}
```

**Problem**: Two full graph traversals when one would suffice (Kahn's algorithm can detect cycles during execution).

**Impact**: Low - topological sort is rarely called

---

## Summary

| Category | Severity | Count |
|----------|----------|-------|
| Your Changes | HIGH | 1 (justified correctness fix) |
| Your Changes | MEDIUM | 1 (config change - behavioral) |
| Your Changes | LOW | 1 (array filter - negligible) |
| Code You Touched | - | 0 |
| Pre-existing | MEDIUM | 1 |
| Pre-existing | LOW | 1 |

**Performance Score**: 8/10

The performance regressions are justified by correctness fixes. The deep copy overhead is necessary to prevent graph corruption. The spawn delay increase is a policy decision rather than a bug.

---

## Merge Recommendation

**APPROVED WITH CONDITIONS**

1. **The deep copy fix is correct** - The O(V+E) overhead is acceptable for correctness. Graph corruption is a data integrity issue that far outweighs the performance cost.

2. **Document the spawn delay change** - The 50ms to 1000ms increase is a significant behavioral change. Add to release notes so users understand the scaling behavior change.

3. **Consider benchmarks** - For graphs with > 1000 dependencies, consider adding performance tests to track regression over time.

---

## Optimization Priority

**Nothing required before merge.**

**Future work (separate PRs):**
1. Consider path-based cycle detection that doesn't require graph copying
2. Class-level memoization for `getMaxDepth()` if it becomes a hot path
3. Performance tests for dependency graph operations at scale
