# Architecture Review Report

**Branch**: chore/v060-tech-debt -> main
**Date**: 2026-03-20
**Commits**: 5 (8f77d44, 7254a63, 4ec4e3d, 056bac9, c1c2861)

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

### MEDIUM

**Dead `Config` interface left in core/interfaces.ts** - `src/core/interfaces.ts:351`
**Confidence**: 95%
- Problem: The `getConfig()` adapter function in `bootstrap.ts` was removed (commit c1c2861), along with its `Config` import. However, the `Config` interface definition at `src/core/interfaces.ts:351-359` remains exported even though nothing imports it. This is dead code in the core layer -- a module that exists solely to define domain abstractions should not contain unused exports.
- Impact: Dead interfaces in core accumulate over time and mislead contributors into thinking they are part of the active architecture. The `Config` interface was a bridge between the old `Configuration` type and various consumers, and its removal was the stated goal of commit c1c2861 ("remove unused Config adapter and cleanup comments").
- Fix: Delete the `Config` interface from `src/core/interfaces.ts` (lines 349-359):
```typescript
// DELETE this block:
/**
 * Configuration
 */
export interface Config {
  readonly maxOutputBuffer: number;
  readonly taskTimeout: number;
  readonly cpuCoresReserved: number;
  readonly memoryReserve: number;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  readonly maxListenersPerEvent?: number;
  readonly maxTotalSubscriptions?: number;
}
```

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **BootstrapMode flag derivation test duplicates implementation logic** - `tests/integration/service-initialization.test.ts:387-398` (Confidence: 65%) -- The test recalculates the boolean flags from mode strings using the same expressions as `bootstrap()`, then asserts they match expected values. This tests the derivation formula in isolation but does not verify that `bootstrap()` actually uses those flags correctly (e.g., that `mode: 'cli'` really skips recovery). A behavioral integration test that bootstraps with each mode and asserts on observable side effects (e.g., recovery ran or not) would provide stronger guarantees, though the current approach is reasonable for a fast unit-style check.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Architecture Score**: 9/10
**Recommendation**: APPROVED_WITH_CONDITIONS

## Architecture Assessment

This PR executes three well-scoped tech debt cleanups. Each change improves the architecture:

### 1. OutputRepository interface moved to core/interfaces.ts (#101)
**Verdict: Correct**. This fixes a Dependency Inversion Principle violation. Previously, service-layer modules (`task-manager.ts`, `process-connector.ts`) and the implementation layer (`event-driven-worker-pool.ts`) imported the `OutputRepository` interface from `implementations/output-repository.ts` -- a concrete module. Now all imports point to `core/interfaces.ts`, which is the canonical location for all repository abstractions. The dependency direction is clean: core defines the interface, implementations provide concrete classes, services depend only on the abstraction.

### 2. BootstrapOptions boolean flags replaced with BootstrapMode enum (#104)
**Verdict: Correct**. Three independent booleans (`skipResourceMonitoring`, `skipScheduleExecutor`, `skipRecovery`) represented an implicit state machine with only 3 valid combinations out of 8 possible. The `BootstrapMode` enum (`'server' | 'cli' | 'run'`) makes the valid states explicit and eliminates invalid flag combinations. The flag derivation logic at bootstrap entry is easy to audit and well-documented. Callers (`run.ts`, `services.ts`) are now simpler: `{ mode: 'run' }` vs `{ skipScheduleExecutor: true, skipResourceMonitoring: true }`.

### 3. ScheduleExecutor FAIL policy wrapped in synchronous transaction (#83)
**Verdict: Correct**. This fixes a real atomicity bug where `update()` (cancel schedule) could succeed but `recordExecution()` (audit trail) could fail, leaving the schedule cancelled with no record of why. The fix uses `TransactionRunner.runInTransaction()` with synchronous `updateSync` and `recordExecutionSync` methods from `SyncScheduleOperations`. Key architectural points:
- **Dependency direction is correct**: `ScheduleExecutor` (service layer) depends on `TransactionRunner` (core interface), not on `Database` (implementation).
- **Interface Segregation**: Uses `ScheduleRepository & SyncScheduleOperations` intersection type rather than a monolithic interface.
- **Test coverage**: The rollback test (`schedule-executor.test.ts:367`) verifies atomicity by sabotaging `recordExecutionSync` and asserting that the schedule remains ACTIVE with no execution history.

### Condition for Approval

Remove the dead `Config` interface from `src/core/interfaces.ts`. This is the only remaining artifact of the cleanup that commit c1c2861 was intended to complete.
