# TypeScript Review Report

**Branch**: feat/dashboard-visibility-overhaul -> main
**Date**: 2026-04-30T20:36

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

### MEDIUM

**Missing `closingRef.current` guard on getSize early-return path** - `src/cli/dashboard/use-task-output-stream.ts:398-406`
**Confidence**: 82%
- Problem: The `getSize` probe early-return path updates `streamsRef` and marks terminal tasks without checking `closingRef.current`. The `get()` path (line 410) correctly checks `if (closingRef.current) return;` before modifying state. If the component unmounts between the `getSize` await and the state update, this writes to a detached ref — not a crash, but inconsistent with the established safety pattern in the same function.
- Fix: Add `closingRef.current` check before line 399:
  ```typescript
  if (sizeResult.ok && sizeResult.value === prev.totalBytes && prev.lines.length > 0) {
    if (closingRef.current) return; // <-- add this
    const prevState = streamsRef.current.get(taskId) ?? INITIAL_STREAM_STATE;
    // ...
  }
  ```

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **`codePointSlice` negative `start` behavior undocumented** - `src/cli/dashboard/use-task-output-stream.ts:124` (Confidence: 62%) -- If `start` is negative, the function iterates the full string and returns `''`. The call site guards against this, but the function's JSDoc does not document the contract. A `@param` note or early return for `start < 0` would make the API self-documenting.

- **`sizeResult.value` type union check** - `src/cli/dashboard/use-task-output-stream.ts:398` (Confidence: 65%) -- The `OutputSize` type mentioned in the PR context was simplified to a raw `number` return from `getSize`. If the interface later returns a richer type (e.g., `{ totalBytes: number; rowCount: number }`), the `=== prev.totalBytes` comparison would break silently. A named `OutputSize` type alias (`type OutputSize = number`) in `interfaces.ts` would make intent explicit and allow future expansion with a single change point.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**TypeScript Score**: 9/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The TypeScript quality of these changes is strong:

- **Result type usage**: Consistent throughout. `getSize` returns `Promise<Result<number>>`, discriminated union narrowing (`sizeResult.ok`) is applied correctly before accessing `.value`. Follows project conventions.
- **Interface extension**: `getSize` added to `OutputRepository` in `interfaces.ts` with proper JSDoc. The `SQLiteOutputRepository` implementation satisfies the contract. Mock in `tests/fixtures/mocks.ts` updated. The partial mock in `cli.test.ts` uses `Pick<OutputRepository, 'get'>` which correctly excludes `getSize`.
- **Type guards and narrowing**: The `for (const _ of str)` iterator in `codePointLength` is correctly typed. The `ch.length` in `codePointSlice` leverages the `string` type of for-of iteration over strings. `prev.totalChars ?? 0` handles the optional field safely.
- **No `any` types**: All new code uses explicit types. The `as { total_size: number } | undefined` cast in `getSize` implementation is the minimum necessary for better-sqlite3's untyped `.get()` return.
- **Test type safety**: Test helper `makeOutputRepo` uses `Partial<OutputRepository>` spread with `as OutputRepository` — matches the existing pattern. `STREAM_INITIAL` in tests explicitly satisfies `OutputStreamState`.

The single MEDIUM finding (missing `closingRef` guard) is a minor consistency gap, not a correctness bug — writing to a detached ref is a no-op in practice. Condition for approval: acknowledge or address the `closingRef` consistency.
