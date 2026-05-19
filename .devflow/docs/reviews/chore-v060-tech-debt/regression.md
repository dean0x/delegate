# Regression Review Report

**Branch**: chore/v060-tech-debt -> main
**Date**: 2026-03-20
**PR**: #107

## Issues in Your Changes (BLOCKING)

### CRITICAL

No critical regression issues found.

### HIGH

No high-severity regression issues found.

## Issues in Code You Touched (Should Fix)

No should-fix regression issues found.

## Pre-existing Issues (Not Blocking)

### LOW

**Dead `Config` interface in core/interfaces.ts** - `src/core/interfaces.ts:351`
**Confidence**: 85%
- Problem: The `Config` interface is still exported from `core/interfaces.ts` but has zero consumers after this PR removed the `getConfig()` adapter function from `bootstrap.ts` and the `Config` import. All bootstrap code uses `Configuration` from `core/configuration.ts` directly. The interface is now dead code.
- Fix: Remove the `Config` interface from `core/interfaces.ts` in a follow-up PR. This is a cleanup item, not a regression -- the interface was already transitioning out of use.

## Suggestions (Lower Confidence)

No suggestions.

## Regression Analysis

### 1. OutputRepository Interface Move (#101)
**Migration completeness**: COMPLETE (Confidence: 95%)
- Old import path (`from './implementations/output-repository'`) has zero remaining consumers
- New import path (`from './core/interfaces'`) is used by all 6 files that reference `OutputRepository`: `bootstrap.ts`, `event-driven-worker-pool.ts`, `process-connector.ts`, `task-manager.ts`, `cli/read-only-context.ts`, `tests/fixtures/mocks.ts`
- The `SQLiteOutputRepository` class still exports from `implementations/output-repository.ts` (correct -- only the interface moved)
- Interface signature is identical (4 methods: `save`, `append`, `get`, `delete`)

### 2. BootstrapMode Enum (#104)
**Behavioral equivalence**: VERIFIED (Confidence: 95%)

| Mode | skipResourceMonitoring | skipScheduleExecutor | skipRecovery |
|------|----------------------|---------------------|-------------|
| `server` | false | false | false |
| `cli` | false | true | true |
| `run` | true | true | false |

Verified against original callers:
- `run.ts` old: `{ skipScheduleExecutor: true, skipResourceMonitoring: true }` -> new: `{ mode: 'run' }` -- MATCHES
- `services.ts` old: `{ skipScheduleExecutor: true, skipRecovery: true }` -> new: `{ mode: 'cli' }` -- MATCHES
- Default (MCP server): no flags -> `mode: 'server'` -- MATCHES

Integration tests updated to use `resourceMonitor: new TestResourceMonitor()` instead of `skipResourceMonitoring: true`. This is safe because when `options.resourceMonitor` is provided, the factory returns it directly (line 293) before the `startMonitoring()` call (line 312), so monitoring is never started on test monitors.

New `BootstrapMode flag derivation` test in `service-initialization.test.ts` validates all three mode mappings.

### 3. ScheduleExecutor FAIL Policy Transaction (#83)
**Behavioral change**: INTENTIONAL IMPROVEMENT (Confidence: 95%)

Old behavior:
1. `update()` (async) -- cancel schedule
2. Emit `ScheduleMissed` event
3. `recordExecution()` (async) -- audit trail (failure logged but not blocking)

New behavior:
1. `runInTransaction()` (sync): `updateSync()` + `recordExecutionSync()` -- atomically cancel + record
2. If transaction fails: log error, break (no event emitted, schedule stays active)
3. If transaction succeeds: emit `ScheduleMissed` event

This is a correctness improvement, not a regression:
- Old: partial failure left schedule cancelled with no audit trail
- New: atomicity guarantees both operations succeed or both roll back
- Event emission now only occurs after confirmed database state change
- No production code subscribes to `ScheduleMissed` (only test assertions)
- New rollback test validates transaction atomicity

### 4. Removed Code
- `getConfig()` adapter function removed from `bootstrap.ts` -- was only used internally, `loadConfiguration()` is used directly
- `Config` import removed from `bootstrap.ts` -- no remaining consumers (see pre-existing issue above)
- JSDoc comments on `BootstrapOptions` fields simplified -- documentation reduction only, no API change
- `skipResourceMonitoring` comment in resource monitor factory simplified -- cosmetic

### 5. Signature Changes
- `ScheduleExecutor.create()`: added `database: TransactionRunner` parameter (3rd position, before `logger`)
  - All 6 call sites updated (1 bootstrap, 1 unit test setup, 4 integration test calls)
  - No remaining callers use old 3-arg signature
- `ScheduleExecutor` constructor: added `database: TransactionRunner` (private, internal only)

### 6. Export Verification
- No exports removed (only `OutputRepository` moved from implementation to core -- re-exported)
- `BootstrapMode` type: NEW export from `bootstrap.ts`
- `BootstrapOptions`: fields changed (3 booleans removed, 1 `mode` added) -- consumers updated

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | - | 0 | 1 |

**Regression Score**: 9/10
**Recommendation**: APPROVED

All three tech debt changes (#101, #104, #83) are clean refactors with complete migrations. No exports removed, no behavior regressions, all consumers updated. The ScheduleExecutor transaction change is an intentional correctness improvement with proper test coverage. Build passes cleanly, all tests pass (347 core + 119 services + 22 schedule-executor + 157 CLI + 59 integration = 704 tests verified).
