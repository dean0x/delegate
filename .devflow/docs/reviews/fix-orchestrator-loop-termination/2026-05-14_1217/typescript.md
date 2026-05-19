# TypeScript Review Report

**Branch**: fix/orchestrator-loop-termination -> main
**Date**: 2026-05-14

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

**Redundant `stateFilePath` coercion: `string | undefined` parameter immediately coerced with `|| undefined`** - `src/services/orchestration-manager.ts:357`
**Confidence**: 85%
- Problem: `buildFinalPrompts` accepts `stateFilePath: string | undefined`, and the caller at line 232 passes `''` (empty string). Inside, line 357 coerces with `stateFilePath: stateFilePath || undefined`. This double-representation (empty string at call site, falsy coercion inside) creates a leaky abstraction where the parameter type says `string | undefined` but the function body actually relies on truthiness to distinguish "no state file" from "has state file". A future caller passing `undefined` directly would work, but one passing `'/path'` for a valid path would also work, making the empty-string intermediate value a confusing artifact of the call site.
- Fix: Either make the parameter `stateFilePath?: string` (optional, callers pass `undefined` directly instead of `''`) OR keep the `string` type and rely on the prompt builder's existing falsy check. The current mix of both patterns reduces clarity. Preferred minimal fix at the call site:
  ```typescript
  // orchestration-manager.ts:232 — pass undefined instead of empty string
  '',
  // becomes:
  undefined,
  ```
  This aligns with the parameter type `string | undefined` and removes the need for the `|| undefined` coercion at line 357.

### MEDIUM

**`as never` type assertion in test mock hides type incompatibility** - `tests/unit/services/handlers/loop-handler.test.ts:2533`
**Confidence**: 82%
- Problem: `new Error('git not found') as never` casts the error to `never` to satisfy the mock return type. This suppresses TypeScript's check that the error type matches `AutobeatError`. While it works at runtime (the code only checks `.ok`), `as never` is a type-system escape hatch that could mask real incompatibilities if the `Result` error type changes. The test should construct a mock of the correct type.
- Fix: Use a properly typed error that matches the Result type:
  ```typescript
  vi.mocked(getRecentGitLog).mockResolvedValue({
    ok: false,
    error: new AutobeatError(ErrorCode.SYSTEM_ERROR, 'git not found'),
  });
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`Orchestration.stateFilePath` is `string` (non-optional) but now holds `''` for agent eval mode** - `src/core/domain.ts:790`, `src/implementations/orchestration-repository.ts:38`, `src/services/orchestration-manager.ts:179`
**Confidence**: 83%
- Problem: The `Orchestration` interface declares `readonly stateFilePath: string` (line 790). The Zod schema was relaxed from `.min(1)` to `.string()` (line 38) to allow empty strings. The orchestration manager now passes `''` (line 179). This means the type system treats `stateFilePath` as always present (it's not optional), but the runtime value is semantically "absent" when it's `''`. Consumers that check `orch.stateFilePath` with a truthiness guard will work, but any consumer that assumes a non-empty string (e.g., reads the file) will fail silently or throw.
- Fix: Consider using `stateFilePath?: string` (optional) on the `Orchestration` type and storing `NULL` in the database for agent eval mode, rather than overloading empty string as "absent". This makes the optionality explicit in the type system. If the empty-string approach is intentional for DB compatibility, add a JSDoc comment on the `Orchestration.stateFilePath` field documenting that empty string means "no state file (agent eval mode)".

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Binary search calls `Buffer.byteLength(lines.slice(0, mid).join('\n'))` on each iteration** - `src/services/handlers/loop-handler.ts:1711` (Confidence: 65%) -- The binary search correctly bounds iterations to O(log n), but each probe allocates a new array via `slice` and a new string via `join`. For a 4KB budget this is negligible, but a prefix-sum approach would be O(n) total allocation with O(log n) lookups. Low priority given the small data size.

- **`parseGitDiffChangedLines` accepts `string | undefined | null` but callers always pass `string | undefined`** - `src/services/handlers/loop-handler.ts:76` (Confidence: 62%) -- The `null` in the union is defensive but `gitDiffSummary` on `LoopIteration` is typed as `string | undefined`, never `null`. The extra `null` handling is harmless but slightly misleading about the actual input domain.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**TypeScript Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The TypeScript patterns in this PR are generally solid. The new code uses `Result` types consistently, validates inputs at boundaries (e.g., `getRecentGitLog` rejects non-positive counts), avoids `any` types, and has good null/undefined handling. The binary search has a provable upper bound. The convergence detection uses proper type narrowing.

The main TypeScript-specific concerns are: (1) the `stateFilePath` empty-string-as-absent pattern creates a semantic gap between the type (`string`) and the runtime meaning ("no file") that would be better expressed as `string | undefined` or `?: string`; and (2) the `as never` cast in tests is a type escape hatch that should use the correct error type. Neither is blocking for merge, but both should be addressed.
