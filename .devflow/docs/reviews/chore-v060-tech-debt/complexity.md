# Complexity Review Report

**Branch**: chore/v060-tech-debt -> main
**Date**: 2026-03-20
**PR**: #107

## Issues in Your Changes (BLOCKING)

### CRITICAL

_No critical complexity issues found._

### HIGH

_No high-severity complexity issues found._

## Issues in Code You Touched (Should Fix)

_No should-fix complexity issues found._

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`bootstrap()` function exceeds recommended length** - `src/bootstrap.ts:118-469`
**Confidence**: 85%
- Problem: The `bootstrap()` function is 351 lines long (118-469), well above the 50-line critical threshold and the 200-line critical severity guideline. This is a pre-existing concern that was NOT introduced by this PR -- the function existed before and this PR actually *reduced* its length by removing the `getConfig()` helper (14 lines) and simplifying boolean flag handling.
- Impact: Long functions are harder to understand, test, and maintain. New developers must read hundreds of lines to understand the wiring logic.
- Note: This is a DI composition root, which is an accepted exception pattern for long functions. The function is linear (no deep nesting or high cyclomatic complexity), consisting of sequential `registerSingleton` calls. Still worth noting for future decomposition.

**`interfaces.ts` exceeds recommended file length** - `src/core/interfaces.ts` (504 lines)
**Confidence**: 82%
- Problem: The file is 504 lines, exceeding the 500-line warning threshold. The PR added the `OutputRepository` interface (11 lines) to this file as part of issue #101 (consolidating repo interfaces into core), which pushed it slightly over the threshold.
- Impact: Large interface files become harder to navigate. However, this file is a central type definition file and each interface is small and focused -- this is an acceptable pattern for a "barrel" interfaces file.
- Note: No immediate action needed. Consider splitting into domain-specific interface files if this continues to grow beyond ~600 lines.

## Suggestions (Lower Confidence)

_No suggestions. All findings are above the 80% confidence threshold or below the 60% threshold._

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 2 | 0 |

**Complexity Score**: 9/10
**Recommendation**: APPROVED

## Analysis Notes

This PR is a **complexity-reducing** change across all three issues:

### Issue #104: BootstrapMode enum replaces boolean flags
- **Before**: 3 independent boolean flags (`skipResourceMonitoring`, `skipScheduleExecutor`, `skipRecovery`) with 8 possible combinations, most of which were invalid.
- **After**: Single `BootstrapMode` enum (`'server' | 'cli' | 'run'`) with 3 valid configurations derived deterministically at the top of `bootstrap()`.
- **Complexity impact**: Reduces cyclomatic complexity of the public API. Callers no longer need to understand which boolean combinations are valid. The derivation logic (lines 119-122) is a clean 3-line mapping that is immediately understandable.
- **Test coverage**: New `it.each` test validates all 3 mode-to-flag derivations.

### Issue #101: OutputRepository interface moved to core/interfaces.ts
- **Before**: `OutputRepository` interface defined in `src/implementations/output-repository.ts`, causing consumers to import from an implementation file.
- **After**: Interface lives in `core/interfaces.ts` alongside all other repository interfaces.
- **Complexity impact**: Eliminates a cross-layer import pattern (core/services importing from implementations). Import statements across 6 files are simplified to import from a single canonical location. This is a pure organizational improvement with zero behavioral change.

### Issue #83: ScheduleExecutor FAIL policy wrapped in transaction
- **Before**: Two separate async operations (`scheduleRepo.update()` then `scheduleRepo.recordExecution()`) with independent error handling, creating a partial-failure window.
- **After**: Single synchronous transaction wrapping `updateSync()` + `recordExecutionSync()` with atomic rollback.
- **Complexity impact**: The new code has fewer decision paths (one `if (!txResult.ok)` vs. two separate error checks). The transaction block is 12 lines with nesting depth of 2 (switch case + transaction callback) -- well within acceptable limits. The constructor gains one parameter (`database: TransactionRunner`), bringing it to 5 parameters -- at the warning threshold but acceptable for a service class with DI.
- **Test coverage**: New test verifies rollback behavior on mid-transaction failure.

### Overall Assessment

All three changes reduce or maintain complexity:
- Boolean flag combinations: 8 -> 3 valid states
- Cross-layer imports: eliminated
- Error handling paths in FAIL policy: 2 independent -> 1 atomic
- No new deep nesting, no new long functions, no new magic values
- Constructor parameters remain within acceptable range (5 for ScheduleExecutor)
