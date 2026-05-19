# TypeScript Review Report

**Branch**: chore/tech-debt-sweep -> main
**Date**: 2026-03-20

## Issues in Your Changes (BLOCKING)

### CRITICAL

No critical issues found.

### HIGH

No high-severity issues found.

### MEDIUM

No medium-severity issues found.

## Issues in Code You Touched (Should Fix)

No should-fix issues found.

## Pre-existing Issues (Not Blocking)

No critical pre-existing issues in changed files.

## Suggestions (Lower Confidence)

- **Discarded `exitOnNull` return value** - `src/cli/commands/logs.ts:17` (Confidence: 65%) -- The return value of `exitOnNull(task, ...)` is discarded, leaving `task` typed as `Task | null`. The variable is not used afterward so this is not a bug, but capturing the return (as done in `status.ts:17`) would be more consistent and prevents future regressions if someone later references `task`.

- **Hardcoded stop message in `exitOnError`** - `src/cli/services.ts:17` (Confidence: 60%) -- `exitOnError` hardcodes the spinner stop message to `'Failed'`, while `exitOnNull` exposes a `stopMsg` parameter with a default. A `stopMsg` parameter on `exitOnError` would allow call sites like `withReadOnlyContext` to customize the message (e.g., `'Initialization failed'` as the original code used).

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | - | 0 | 0 |

**TypeScript Score**: 9/10
**Recommendation**: APPROVED

### Analysis Summary

This PR is a clean refactoring that extracts two CLI guard helpers (`exitOnError`, `exitOnNull`) from repeated inline Result/null-check boilerplate across CLI command files. The TypeScript quality is strong:

**Type Safety**
- `exitOnError<T>` correctly infers `T` from `Result<T>` and returns the unwrapped value after the `process.exit(1)` branch (which returns `never`).
- `exitOnNull<T>` correctly narrows `T | null | undefined` to `T` via the same `process.exit(1)` pattern.
- All narrowing relies on `process.exit(): never` from `@types/node`, which the compiler honors.
- `tsc --noEmit` passes cleanly with zero errors in changed files.

**Best Practices Observed**
- No `any` types introduced.
- No unsafe type assertions (`as` casts) or non-null assertions (`!`).
- `import type` used correctly for `Result`, `Spinner`, `ReadOnlyContext`, `Container`, `ScheduleService`, `TaskManager`.
- All new functions have explicit return type annotations (`T`, `Promise<void>`).
- Previously missing return type annotations on `scheduleCreate`, `scheduleCancel`, `schedulePause`, `scheduleResume` are now added (`: Promise<void>`).
- `registerWorker` in `event-driven-worker-pool.ts` has correct `Result<WorkerState>` return type, compatible with the parent `spawn()` method's `Result<Worker>` via structural subtyping.

**Net Effect**
- ~47 lines removed (190 -> 143), zero type safety regressions.
- Consistent Result unwrapping pattern across all CLI commands.
- Generic helper functions are properly constrained and reusable.
