# Regression Review Report

**Branch**: chore/tech-debt-sweep -> main
**Date**: 2026-03-20
**PR**: #109

## Issues in Your Changes (BLOCKING)

### CRITICAL

No critical issues found.

### HIGH

No high issues found.

### MEDIUM

**Spinner stop message changed from "Initialization failed" to "Failed"** - `src/cli/services.ts:17`
**Confidence**: 90%
- Problem: The original `withReadOnlyContext()` called `s?.stop('Initialization failed')` and the original `withServices()` called `s?.stop('Initialization failed')` on all three failure branches. The new `exitOnError()` helper uses a hardcoded `s?.stop('Failed')` stop message. This changes the user-visible CLI spinner text on initialization failures from the descriptive "Initialization failed" to the generic "Failed".
- Impact: Users who fail to initialize will see a less informative spinner message. Not functionally breaking, but a subtle UX regression in error reporting quality.
- Fix: Add a `stopMsg` parameter to `exitOnError` (defaulting to `'Failed'`) so callers can pass context-specific messages, or accept the generic message as intentional simplification:
  ```typescript
  export function exitOnError<T>(
    result: Result<T>,
    s?: Spinner,
    prefix?: string,
    stopMsg = 'Failed',
  ): T {
    if (!result.ok) {
      s?.stop(stopMsg);
      ui.error(prefix ? `${prefix}: ${result.error.message}` : result.error.message);
      process.exit(1);
    }
    return result.value;
  }
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**No unit tests for new `exitOnError` / `exitOnNull` helper functions** - `src/cli/services.ts:15-37`
**Confidence**: 85%
- Problem: Two new exported helper functions (`exitOnError` and `exitOnNull`) were introduced with no corresponding unit tests. These functions are now critical path for every CLI command's error handling (used in `logs.ts`, `status.ts`, `schedule.ts`, and `services.ts` itself). The existing CLI tests (`tests/unit/cli.test.ts`) were not updated.
- Impact: If someone inadvertently modifies these helpers (e.g., removes the `process.exit(1)` call, changes the null check from `== null` to `=== null`), there would be no test to catch the regression. The helpers are small but have security-relevant behavior (they gate process exit on error).
- Fix: Add unit tests for `exitOnError` and `exitOnNull` covering: (1) success path returns unwrapped value, (2) error path calls `process.exit(1)`, (3) error path stops spinner with correct message, (4) `exitOnNull` handles both `null` and `undefined`.

### LOW

**Incomplete migration: 4 CLI command files still use inline Result checking** - `src/cli/commands/cancel.ts`, `resume.ts`, `pipeline.ts`, `run.ts`
**Confidence**: 80%
- Problem: The PR introduces `exitOnError`/`exitOnNull` helpers and migrates `logs.ts`, `status.ts`, and `schedule.ts` to use them, but `cancel.ts`, `resume.ts`, `pipeline.ts`, and `run.ts` still use the old inline `if (!result.ok) { ... process.exit(1) }` pattern. This creates an inconsistent codebase where some CLI commands use the helper and others do not.
- Impact: Not functionally breaking -- all commands still work. However, the inconsistency makes it harder for future contributors to know which pattern to follow and increases maintenance burden (two patterns for the same concern).
- Fix: Either migrate the remaining 4 files to use `exitOnError`/`exitOnNull` in this PR, or create a follow-up issue to complete the migration. Note that `run.ts` has a special case: it calls `container.dispose()` between the error check and exit, which would need to be handled differently (possibly with a cleanup callback parameter or a separate pattern).

## Pre-existing Issues (Not Blocking)

No pre-existing issues found.

## Suggestions (Lower Confidence)

- **`exitOnError` return type relies on `process.exit` being typed as `never`** - `src/cli/services.ts:15` (Confidence: 65%) -- TypeScript's control flow analysis depends on `process.exit` returning `never`. If a test environment stubs `process.exit` to not actually exit, the function will continue executing and return `undefined` as `T`, which could cause downstream issues in test scenarios. Consider adding an explicit `throw` after `process.exit(1)` as a safety net.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 1 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Regression Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The refactoring is structurally sound. The `registerWorker` extraction in `event-driven-worker-pool.ts` is a clean, behavior-preserving method extraction. The `exitOnError`/`exitOnNull` CLI helpers are a good DRY improvement that correctly preserves the error-then-exit semantics.

Conditions for approval:
1. Acknowledge the spinner message change ("Initialization failed" -> "Failed") as intentional, or restore the original message via a parameter.
2. Consider adding basic unit tests for the two new exported helpers, given they are now on the critical path for all CLI error handling.
