# Code Review Summary

**Branch**: chore/v060-tech-debt -> main
**Date**: 2026-03-20
**Reports**: 9 reviewers (security, architecture, performance, complexity, consistency, regression, tests, typescript, documentation)

## Merge Recommendation: CHANGES_REQUESTED

This PR contains three well-scoped tech debt items (#101, #104, #83) with strong overall quality across all pillars. However, there is one HIGH-severity blocking issue in test coverage that must be addressed before merge, plus four MEDIUM-severity documentation/code cleanup items that should be fixed while making the blocking change.

---

## Issue Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW | Total |
|----------|----------|------|--------|-----|-------|
| Blocking | 0 | 1 | 4 | 0 | 5 |
| Should Fix | 0 | 0 | 1 | 0 | 1 |
| Pre-existing | 0 | 0 | 1 | 1 | 2 |

---

## Blocking Issues (Must Fix Before Merge)

### HIGH

**BootstrapMode flag derivation test re-implements source logic** - `tests/integration/service-initialization.test.ts:387-398`
**Confidence**: 85% (flagged by Tests, TypeScript reviewers)

- **Problem**: The test duplicates the mode-to-flags derivation logic locally, then asserts against hardcoded values. This tests a copy of the logic, not the actual bootstrap function. If someone changes the derivation in `bootstrap()`, this test continues to pass with stale expectations.
- **Severity**: HIGH - False sense of coverage defeats the purpose of the test
- **Fix**: Extract the derivation into a pure function and test the real function, not a copy:
  ```typescript
  // In src/bootstrap.ts
  export function deriveModeFlags(mode: BootstrapMode) {
    return {
      skipResourceMonitoring: mode === 'run',
      skipScheduleExecutor: mode === 'cli' || mode === 'run',
      skipRecovery: mode === 'cli',
    };
  }

  // In test
  import { deriveModeFlags } from '../../src/bootstrap.js';

  it.each([
    ['server', { skipResourceMonitoring: false, skipScheduleExecutor: false, skipRecovery: false }],
    ['cli',    { skipResourceMonitoring: false, skipScheduleExecutor: true,  skipRecovery: true  }],
    ['run',    { skipResourceMonitoring: true,  skipScheduleExecutor: true,  skipRecovery: false }],
  ] as const)('mode "%s" produces correct flags', (mode, expected) => {
    expect(deriveModeFlags(mode)).toEqual(expected);
  });
  ```

### MEDIUM (Conditions for Approval)

**Dead `Config` interface left after removing its only consumer** - `src/core/interfaces.ts:351-359`
**Confidence**: 90-95% (flagged by 4 reviewers: Architecture, Consistency, TypeScript, Regression)

- **Problem**: The `getConfig()` adapter function was removed (commit c1c2861), but the `Config` interface it consumed still exists in core/interfaces.ts. No file imports it. This is dead code in the core layer that misleads contributors.
- **Fix**: Delete the Config interface block from src/core/interfaces.ts:
  ```typescript
  // DELETE lines 348-359:
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

**BootstrapOptions JSDoc removed without equivalent on remaining fields** - `src/bootstrap.ts:39-43`
**Confidence**: 85% (flagged by Documentation)

- **Problem**: The original `BootstrapOptions` interface had per-property JSDoc for each field. The refactor to `BootstrapMode` removed the JSDoc on `processSpawner` and `resourceMonitor`, losing inline documentation about test doubles.
- **Fix**: Add brief JSDoc to the remaining DI fields:
  ```typescript
  export interface BootstrapOptions {
    mode?: BootstrapMode;
    /** Custom ProcessSpawner (e.g., NoOpProcessSpawner for tests) */
    processSpawner?: ProcessSpawner;
    /** Custom ResourceMonitor (e.g., TestResourceMonitor for tests) */
    resourceMonitor?: ResourceMonitor;
  }
  ```

**OutputRepository interface methods lack per-method JSDoc** - `src/core/interfaces.ts:471-476`
**Confidence**: 82% (flagged by Documentation)

- **Problem**: The `OutputRepository` interface was promoted to core/interfaces.ts alongside other well-documented repository interfaces. This is an opportunity to add method-level docs to bring it to the same standard as `ScheduleRepository`, `TaskRepository`, etc.
- **Fix**: Add brief JSDoc to each method:
  ```typescript
  export interface OutputRepository {
    /** Persist full output snapshot (stdout + stderr) */
    save(taskId: TaskId, output: TaskOutput): Promise<Result<void>>;
    /** Append incremental data to a stream */
    append(taskId: TaskId, stream: 'stdout' | 'stderr', data: string): Promise<Result<void>>;
    /** Retrieve stored output for a task */
    get(taskId: TaskId): Promise<Result<TaskOutput | null>>;
    /** Remove stored output for a task */
    delete(taskId: TaskId): Promise<Result<void>>;
  }
  ```

---

## Should-Fix Issues (Related to Your Changes)

### MEDIUM

**Rollback test does not verify ScheduleMissed event is suppressed** - `tests/unit/services/schedule-executor.test.ts:367-394`
**Confidence**: 82% (flagged by Tests)

- **Problem**: The new rollback test correctly verifies schedule status and execution history are rolled back. However, it does not assert that no `ScheduleMissed` event was emitted. The source code correctly suppresses the event on transaction failure, but the test does not validate this invariant. If someone reorders the code to emit before checking `txResult.ok`, this test passes while the system emits misleading events.
- **Fix**: Add event subscriber and assert zero emissions:
  ```typescript
  const missedEvents: unknown[] = [];
  eventBus.subscribe('ScheduleMissed', async (event: unknown) => {
    missedEvents.push(event);
  });

  await executor.triggerTick();
  await flushEventLoop();

  // ...existing assertions...
  expect(missedEvents).toHaveLength(0);
  ```

---

## What Went Well

### Strengths Across All Pillars

1. **Security** (9/10): Transaction wrapping for FAIL policy is a net security improvement, eliminating a data integrity race condition. BootstrapMode uses type-constrained values with safe defaults. No new attack surface, no secrets exposed.

2. **Architecture** (9/10): All three changes improve architecture:
   - OutputRepository interface move fixes Dependency Inversion Principle violation
   - BootstrapMode enum makes implicit state machine explicit
   - Transaction wrapping in ScheduleExecutor uses clean interface composition (TransactionRunner + SyncScheduleOperations)

3. **Performance** (9/10): All changes are performance-neutral or positive. Transaction wrapping reduces async boundaries and SQLite transaction overhead.

4. **Complexity** (9/10): PR reduces complexity:
   - Boolean flag combinations: 8 possible → 3 valid (enum eliminates invalid states)
   - Cross-layer imports: eliminated
   - Error handling paths: 2 independent → 1 atomic

5. **Consistency** (9/10): All changes follow established patterns:
   - OutputRepository move matches pattern of TaskRepository, DependencyRepository, etc.
   - BootstrapMode enum replacement is complete across all call sites
   - Transaction pattern matches ScheduleHandler exactly

6. **Regression** (9/10): Clean migrations with complete verification:
   - OutputRepository interface move: 0 remaining old imports, 6 files migrated
   - BootstrapMode enum: all 3 callers updated, behavioral equivalence verified
   - ScheduleExecutor transaction: intentional correctness improvement, not a regression

7. **Tests** (8/10): Good test coverage with one structural issue (the HIGH blocker). Excellent transaction rollback test. Integration tests updated cleanly.

8. **TypeScript** (9/10): Strong type safety. OutputRepository move follows DIP. BootstrapMode is well-designed discriminated union. Transaction wrapping uses clean intersection types.

---

## Pre-Existing Issues (Not Blocking)

These issues are informational only and do not block this PR:

**MEDIUM**: `bootstrap()` function exceeds 300 lines - `src/bootstrap.ts:118-469`
- Confidence: 85%
- Context: Pre-existing, not introduced by this PR. This is a DI composition root, an accepted exception pattern for long functions. The PR actually reduces length by removing `getConfig()` helper. No action needed for this PR.

**LOW**: ROADMAP.md v0.6.0 "Remaining" items not updated - `docs/ROADMAP.md:73-79`
- Confidence: 85%
- Context: Items #83, #101, #104 will be complete once this PR merges. Items #82, #84, #95 already merged in PR #106. Suggest updating roadmap after merge or during v0.6.0 release prep.

---

## Summary by Pillar

| Pillar | Score | Status | Notes |
|--------|-------|--------|-------|
| Security | 9/10 | ✅ APPROVED | Transaction wrapping improves data integrity. Type-constrained defaults. |
| Architecture | 9/10 | ⚠️ APPROVED_WITH_CONDITIONS | Remove dead Config interface. |
| Performance | 9/10 | ✅ APPROVED | Transaction wrapping reduces async boundaries. Zero regressions. |
| Complexity | 9/10 | ✅ APPROVED | Reduces boolean combinations and cross-layer imports. |
| Consistency | 9/10 | ⚠️ APPROVED_WITH_CONDITIONS | Remove dead Config interface. |
| Regression | 9/10 | ✅ APPROVED | Clean migrations, all consumers updated, behavioral equivalence verified. |
| Tests | 8/10 | ❌ CHANGES_REQUESTED | HIGH: BootstrapMode test duplicates logic. MEDIUM: rollback test missing event assertion. |
| TypeScript | 9/10 | ⚠️ APPROVED_WITH_CONDITIONS | Remove dead Config interface. Dedup test logic. |
| Documentation | 7/10 | ⚠️ APPROVED_WITH_CONDITIONS | Add JSDoc to BootstrapOptions fields and OutputRepository methods. |

**Overall Score**: 8.7/10

---

## Action Plan (Priority Order)

1. **Fix HIGH blocker** - Extract `deriveModeFlags()` function from `bootstrap()` and test the real function
2. **Remove dead Config interface** - Delete from src/core/interfaces.ts:348-359 (resolves 4 reviewer concerns)
3. **Add JSDoc documentation** - BootstrapOptions fields + OutputRepository methods (aligns documentation with architecture promotion)
4. **Add event assertion** - Rollback test should verify no ScheduleMissed event on transaction failure

**Estimated Time**: 20-30 minutes for all changes

After these fixes, the PR will have unanimous APPROVED recommendations across all 9 reviewers with zero blocking issues remaining.
