# Release Notes - v0.3.1

**Release Date:** 2025-12-01
**Previous Version:** 0.3.0
**Release Type:** Patch (Bug fixes, security improvements, performance optimizations)

---

## Summary

This patch release focuses on **security hardening**, **performance optimizations**, and **critical bug fixes** for the task dependency system introduced in v0.3.0.

### Highlights

- **CRITICAL FIX**: Graph corruption bug in cycle detection that could cause unpredictable task execution
- **Security**: Input validation limits prevent DoS attacks on dependency system
- **Performance**: Settling workers tracking prevents spawn burst overload
- **Reliability**: Atomic multi-dependency transactions ensure data consistency

---

## Security Fixes

### CRITICAL: Graph Corruption Fix (Issue #28)

Deep copy in `wouldCreateCycle()` prevents dependency graph corruption.

**Problem**: Shallow copy (`new Map(this.graph)`) corrupted the dependency graph because Set values remained as references. Cycle detection could permanently add edges to the graph, causing unpredictable task execution.

**Solution**: Proper deep copy implementation:
```typescript
new Map(Array.from(this.graph.entries()).map(([k, v]) => [k, new Set(v)]))
```

### npm audit vulnerabilities fixed

Resolved 3 security issues:
- **HIGH**: glob CLI command injection (GHSA-5j98-mcp5-4vw2)
- **MODERATE**: body-parser denial of service (GHSA-wqch-xfxh-vrr4)
- **MODERATE**: vite path traversal on Windows (GHSA-93m4-6634-74q7)

### Input Validation Limits (Issue #12)

Security hardening for dependency system:
- Maximum 100 dependencies per task to prevent DoS attacks
- Maximum 100 dependency chain depth to prevent stack overflow
- Clear error messages with current counts and limits
- Validation enforced at repository level for consistency

### Configuration Validation Logging

No longer silently falls back to defaults when environment variables fail validation.

---

## Performance Improvements

### Settling Workers Tracking

Prevents spawn burst overload during high-load scenarios:
- Load average is a 1-minute rolling average that doesn't reflect recent spawns
- New `recordSpawn()` tracks workers in 15-second settling window
- Projects resource usage including workers not yet reflected in metrics
- Increased `minSpawnDelayMs` from 50ms to 1000ms for additional protection

### Batch Dependency Resolution

10x speedup for dependency resolution operations (Issue #10).

### Incremental Graph Updates

Eliminated O(N) `findAll()` calls with incremental graph updates (Issue #13).

---

## Bug Fixes

- **Command Injection**: Fixed potential security vulnerabilities in git operations
- **Test Reliability**: Fixed flaky tests with proper mocking
- **Parameter Consistency**: Aligned CLI and MCP tool parameters

---

## Technical Improvements

- **Type safety**: Replaced `any` type with `Worker` in `getWorkerStats()` return type
- **Test compatibility**: Added `recordSpawn()` to TestResourceMonitor

### Atomic Multi-Dependency Transactions (Issue #11)

Data consistency improvements:
- New `addDependencies()` batch method with atomic all-or-nothing semantics
- Transaction rollback on any validation failure (cycle detection, duplicate, task not found)
- Prevents partial dependency state in database
- DependencyHandler updated to use atomic batch operations

### Chain Depth Calculation

New `DependencyGraph.getMaxDepth()` algorithm:
- DFS with memoization for O(V+E) complexity
- Handles diamond-shaped graphs efficiently
- Used for security validation of chain depth limits

---

## Test Coverage

- **5 new tests** for settling workers tracking in ResourceMonitor
- **3 regression tests** for graph immutability after cycle checks
- **18 tests** for v0.3.1 security and consistency improvements:
  - 11 tests for atomic batch dependency operations (rollback, validation)
  - 3 tests for max dependencies per task validation (100 limit)
  - 1 test for max chain depth validation (100 limit)
  - 7 tests for DependencyGraph.getMaxDepth() algorithm

---

## Documentation Updates

- Updated `docs/architecture/TASK_ARCHITECTURE.md` with correct deep copy pattern
- Fixed stale line numbers in `docs/TASK-DEPENDENCIES.md` (wouldCreateCycle at line 240)
- Fixed outdated version references and comments throughout codebase

---

## Commits Included

```
fe6ad81 docs: fix outdated version references and comments (#34)
cb3da65 fix: tech debt cleanup - DRY utilities, performance optimizations, and documentation fixes (#33)
a924484 fix(tests): use inclusive bounds in packet loss rate assertion
1d35db1 fix(core): deep copy in wouldCreateCycle() prevents graph corruption + settling workers tracking (#32)
bcc8314 docs: update architecture docs for factory pattern (#30)
5e69695 fix: address code review feedback from incremental graph updates PR (#29)
c44fccc perf: Incremental Graph Updates - Eliminate O(N) findAll() Calls (#13) (#27)
e2fe6a2 perf: batch dependency resolution for 10x speedup (#10) (#26)
83de98d feat: v0.3.1 Quick Wins - Atomic Transactions & Input Validation (#23)
09a04e0 chore: documentation housekeeping and organization (#22)
```

---

## Upgrade Instructions

### From v0.3.0

This is a drop-in replacement. No migration required.

```bash
npm install -g backbeat@0.3.1
```

### Breaking Changes

None. This is a fully backward-compatible patch release.

---

## Links

- [Full Changelog](../../CHANGELOG.md)
- [Task Dependencies Documentation](../TASK-DEPENDENCIES.md)
- [Architecture Documentation](../architecture/)
- [GitHub Issues](https://github.com/dean0x/delegate/issues)
