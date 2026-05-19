# TypeScript Review Report

**Branch**: chore/v060-tech-debt -> main
**Date**: 2026-03-20

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Dead exported `Config` interface after removing its only consumer** - `src/core/interfaces.ts:351`
**Confidence**: 90%
- Problem: The `getConfig()` helper in `bootstrap.ts` was the sole consumer of the `Config` interface from `core/interfaces.ts`. This branch removed `getConfig()` and its `Config` import, but did not remove the `Config` interface itself. It is now exported dead code — no file imports it.
- Fix: Remove the `Config` interface (lines 348-359) from `src/core/interfaces.ts`. It has been fully superseded by `Configuration` from `src/core/configuration.ts`.

```typescript
// Remove these lines from src/core/interfaces.ts:
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

### MEDIUM

**BootstrapMode flag derivation test duplicates production logic instead of testing it** - `tests/integration/service-initialization.test.ts:387-398`
**Confidence**: 85%
- Problem: The `BootstrapMode flag derivation` test re-implements the mode-to-flags derivation logic locally (`const skipResourceMonitoring = mode === 'run'` etc.) and asserts against a hardcoded expectations table. This tests a copy of the logic, not the actual bootstrap function. If the derivation in `bootstrap()` changes (e.g., 'run' mode starts skipping recovery too), this test would still pass with stale expectations, defeating its purpose.
- Fix: Either (a) extract the derivation into a named pure function (e.g., `deriveModeFlags(mode: BootstrapMode)`) exported from `bootstrap.ts` and test that directly, or (b) test the behavior through bootstrap itself by passing `{ mode: 'cli' }` and verifying the container does not contain a `scheduleExecutor`. Option (a) is simpler:

```typescript
// In src/bootstrap.ts — extract the derivation
export function deriveModeFlags(mode: BootstrapMode) {
  return {
    skipResourceMonitoring: mode === 'run',
    skipScheduleExecutor: mode === 'cli' || mode === 'run',
    skipRecovery: mode === 'cli',
  };
}

// In the test — import and test the real function
import { deriveModeFlags } from '../../src/bootstrap.js';

it.each([
  ['server', { skipResourceMonitoring: false, skipScheduleExecutor: false, skipRecovery: false }],
  ['cli',    { skipResourceMonitoring: false, skipScheduleExecutor: true,  skipRecovery: true  }],
  ['run',    { skipResourceMonitoring: true,  skipScheduleExecutor: true,  skipRecovery: false }],
] as const)('mode "%s" produces correct flags', (mode, expected) => {
  expect(deriveModeFlags(mode)).toEqual(expected);
});
```

## Pre-existing Issues (Not Blocking)

No pre-existing issues found.

## Suggestions (Lower Confidence)

- **Inline type assertion `as import(...).Logger`** - `tests/integration/task-scheduling.test.ts:249,312,526,586` (Confidence: 65%) -- The inline `as import('../../src/core/interfaces.js').Logger` pattern is verbose and unusual. A top-level import of `Logger` type would be cleaner and avoids the inline type assertion. These lines were not changed in this branch, so this is informational only.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**TypeScript Score**: 9/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Overall Assessment

This is a clean tech debt cleanup with strong TypeScript practices:

1. **OutputRepository interface move (#101)**: Correctly relocates the interface from `src/implementations/output-repository.ts` to `src/core/interfaces.ts`, following the established pattern that all repository interfaces live in core. All import sites (6 files) updated consistently. No `any` types, no unsafe assertions.

2. **BootstrapMode enum (#104)**: Well-designed discriminated union type (`'server' | 'cli' | 'run'`) replaces three ad-hoc boolean flags. The mode-to-flags derivation at the top of `bootstrap()` is clear and centralized. Call sites in `cli/services.ts` and `cli/commands/run.ts` are simplified. JSDoc on `BootstrapMode` documents each variant's semantics.

3. **Transaction wrapping for FAIL policy (#83)**: Correctly introduces `TransactionRunner` and `SyncScheduleOperations` intersection type (`ScheduleRepository & SyncScheduleOperations`) to give `ScheduleExecutor` access to both async and sync repository methods. The transaction wraps both `updateSync` and `recordExecutionSync` atomically. Event emission correctly happens after the transaction commits. The rollback test is well-structured.

The two conditions are minor: remove the now-dead `Config` interface and consider fixing the flag derivation test to test the actual production function rather than a local copy.
