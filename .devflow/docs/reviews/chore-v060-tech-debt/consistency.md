# Consistency Review Report

**Branch**: chore/v060-tech-debt -> main
**Date**: 2026-03-20
**Commits**: 5 (8f77d44, 7254a63, 4ec4e3d, 056bac9, c1c2861)

## Issues in Your Changes (BLOCKING)

### CRITICAL

_None_

### HIGH

_None_

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Dead `Config` interface left behind after removing its only consumer** - `src/core/interfaces.ts:351`
**Confidence**: 90%
- Problem: The `getConfig()` adapter in `bootstrap.ts` was the sole consumer of the `Config` interface. This PR correctly removed the `getConfig()` function and the `Config` import from `bootstrap.ts`, but the `Config` interface itself (lines 351-359) was left in `core/interfaces.ts`. No file in the codebase imports or references this interface. It is now dead code in the canonical interfaces file.
- Impact: Developers may assume `Config` is the correct type to use for configuration (it maps `timeout` to `taskTimeout`, etc.) instead of `Configuration` from `core/configuration.ts`. This creates confusion about which config type to depend on.
- Fix: Remove the `Config` interface from `core/interfaces.ts`:
  ```typescript
  // DELETE lines 348-359 in src/core/interfaces.ts:
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

## Pre-existing Issues (Not Blocking)

_None_

## Suggestions (Lower Confidence)

- **BootstrapMode flag derivation test duplicates implementation logic** - `tests/integration/service-initialization.test.ts:393-396` (Confidence: 65%) -- The test re-derives flags using the same boolean expressions as `bootstrap.ts` rather than testing bootstrap behavior through the container. This tests the derivation formula, not the actual bootstrap outcome. A behavioral test (e.g., verifying that `mode: 'cli'` produces a container without a ScheduleExecutor) would be more robust. However, this is a pragmatic choice to avoid bootstrapping for each mode, which is reasonable.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | - |
| Should Fix | - | 0 | 1 | - |
| Pre-existing | - | - | 0 | 0 |

**Consistency Score**: 9/10
**Recommendation**: APPROVED_WITH_CONDITIONS

## Detailed Analysis

### Issue #101: OutputRepository interface move to core/interfaces.ts

**Verdict: Consistent.** The move follows the established pattern precisely:
- All other repository interfaces (`TaskRepository`, `DependencyRepository`, `ScheduleRepository`, `CheckpointRepository`, `WorkerRepository`) are defined in `core/interfaces.ts`
- The docstring uses the same `Pattern: Repository pattern` convention as other interfaces
- The implementation file (`output-repository.ts`) now imports from `core/interfaces.ts`, matching all other repositories
- All 6 consumer files were updated to import from `core/interfaces` instead of the implementation module
- No re-export of the interface from the implementation file (clean separation)

### Issue #104: BootstrapMode enum replacing boolean flags

**Verdict: Consistent.** The refactoring follows strong patterns:
- Three ad-hoc booleans (`skipResourceMonitoring`, `skipScheduleExecutor`, `skipRecovery`) replaced by a single discriminated `BootstrapMode` string union (`'server' | 'cli' | 'run'`)
- The type is defined adjacent to `BootstrapOptions` (co-located, easy to find)
- The derivation logic at the top of `bootstrap()` makes the mode-to-flag mapping explicit and centralized
- All 3 call sites (`cli/services.ts`, `cli/commands/run.ts`, and integration tests) were updated
- Log messages now use `mode=${mode}` consistently instead of per-flag names
- The `resourceMonitor` DI option was preserved (tests inject `TestResourceMonitor`)
- Old boolean flags were fully removed from `BootstrapOptions` -- no partial migration

One subtle behavior change: integration tests that previously used `skipResourceMonitoring: true` without specifying other flags now use `resourceMonitor: new TestResourceMonitor()` instead. Since `mode` defaults to `'server'`, this means recovery and executor now run in those tests (previously they ran too, since the old defaults were `false`). The behavior is actually unchanged -- the test refactoring just removes a now-invalid flag. Correct.

### Issue #83: Transaction wrapping for ScheduleExecutor FAIL policy

**Verdict: Consistent.** The transaction pattern matches `ScheduleHandler` exactly:
- Same type signature: `ScheduleRepository & SyncScheduleOperations` + `TransactionRunner`
- Uses `this.database.runInTransaction(() => { ... })` wrapping synchronous operations
- Uses `updateSync()` and `recordExecutionSync()` (synchronous methods from `SyncScheduleOperations`)
- Error handling follows Result pattern: checks `txResult.ok`, logs error, breaks
- The new test (`should roll back schedule cancellation if execution recording fails`) validates atomicity by sabotaging `recordExecutionSync` mid-transaction
- Bootstrap was updated to inject `database` as `TransactionRunner` into `ScheduleExecutor.create()`
- All 4 test call sites for `ScheduleExecutor.create()` were updated with the new `database` parameter

### Cleanup commits

- **Import ordering (biome)**: Alphabetical import ordering applied consistently
- **Config adapter removal**: `getConfig()` helper and `Config` import correctly removed from bootstrap. The `Config` interface itself remains as dead code (see Should Fix above)
- **Comment cleanup**: Removed verbose JSDoc from `BootstrapOptions` fields -- consistent with the simpler style used elsewhere in the codebase (e.g., `ScheduleExecutorOptions` has no per-field JSDoc)
