# TypeScript Review Report

**Branch**: fix/v060-correctness-bugs -> main
**Date**: 2026-03-19
**Commits**: 4 (18d7657, 6866844, 894d3f9, 3301a2e)

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Duplicated `linesSize` utility function** - `src/implementations/output-capture.ts:13` and `src/services/task-manager.ts:33`

- Problem: The identical `linesSize(lines: readonly string[]): number` function is defined as a module-private function in two separate files. Both files were modified in this PR, and the duplication was introduced by this PR.
- Impact: Maintenance risk -- if the calculation logic changes (e.g., to account for newline separators or byte-length), one copy may be updated without the other, causing a silent divergence. This is a DRY violation.
- Fix: Extract to a shared utility module:
  ```typescript
  // src/utils/output.ts
  /** Sum the character lengths of all lines in an array */
  export function linesSize(lines: readonly string[]): number {
    return lines.reduce((sum, line) => sum + line.length, 0);
  }
  ```
  Then import in both `output-capture.ts` and `task-manager.ts`.

---

**Measurement unit inconsistency: `totalSize` mixes bytes and characters** - `src/implementations/output-capture.ts:14` vs `src/implementations/output-capture.ts:51`

- Problem: During `capture()`, `totalSize` is accumulated using `Buffer.byteLength(data, 'utf8')` (line 51, line 74), which counts **bytes**. However, `linesSize()` (line 14) uses `string.length`, which counts **UTF-16 code units** (characters). When tail-slicing is applied, the recalculated `totalSize` (line 118-120) uses character-based `linesSize`, while the non-sliced path returns the byte-based `buffer.totalSize`. For ASCII-only content these are identical, but for multi-byte characters (e.g., emoji, CJK) the two metrics diverge.
- Impact: The `totalSize` field in `TaskOutput` has an inconsistent meaning depending on whether tail-slicing was applied. Consumers relying on `totalSize` for size comparisons or progress tracking could see a jump or drop in the reported value even if the actual content is identical. This is the more important concern with the new fix.
- Category: BLOCKING -- this inconsistency was introduced by the fix in this PR.
- Fix: Either consistently use character length everywhere (change line 51 to `data.length`), or consistently use byte length everywhere (change `linesSize` to use `Buffer.byteLength`). The choice depends on what `totalSize` semantically represents to downstream consumers. Given the `maxOutputBuffer` limit check uses byte-length, byte-length is likely the correct semantic:
  ```typescript
  function linesSize(lines: readonly string[]): number {
    return lines.reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8'), 0);
  }
  ```

### LOW

**Type assertion in `cancelSchedule` filter uses string literal instead of union member** - `src/services/schedule-manager.ts:185`

- Problem: The filter `(e) => e.status === 'triggered'` uses a raw string literal `'triggered'`. While TypeScript's control flow analysis will narrow this correctly (the `status` field is a union of string literals), referencing a constant or extracting the check to a named predicate would improve discoverability and refactoring safety.
- Impact: Minor. If the status union ever changes the string value, the compiler would catch it due to the typed field. No runtime risk.
- Fix: This is a stylistic preference, not blocking. No action required.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`TestOutputCapture.getOutput` uses different `totalSize` calculation than `BufferedOutputCapture`** - `src/implementations/output-capture.ts:213`

- Problem: `TestOutputCapture.getOutput()` always computes `totalSize` via `stdout.join('').length + stderr.join('').length` (characters, post-slice). Meanwhile, `BufferedOutputCapture.getOutput()` uses `buffer.totalSize` (bytes) for the non-sliced path, and character-based `linesSize()` for the sliced path. The two implementations of the same `OutputCapture` interface produce semantically different `totalSize` values for the same data.
- Impact: Tests using `TestOutputCapture` may pass with character-length assertions while production `BufferedOutputCapture` returns byte-length, masking bugs. Additionally, `join('')` is slightly less efficient than `reduce` for summing lengths.
- Fix: Align `TestOutputCapture` to use the same `linesSize` helper (once it's extracted to a shared utility), and decide on a consistent measurement unit across both implementations.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`getBufferSize` uses falsy coercion** - `src/implementations/output-capture.ts:138`

- Problem: `buffer?.totalSize || 0` uses `||` instead of `??`. If `totalSize` is legitimately `0`, `||` would return `0` anyway so it's functionally equivalent here, but `??` is the idiomatic TypeScript pattern for "default on nullish" and communicates intent more clearly.
- Fix: `return buffer?.totalSize ?? 0;`

### LOW

**Branded type constructors are identity functions with `as` casts** - `src/core/domain.ts:13-15`

- Problem: `TaskId`, `WorkerId`, `ScheduleId` are both a type and a value (constructor function) using the same name. The constructors use `as` casts (`id as TaskId`). This is a common branded type pattern in TypeScript, but the `as` casts bypass type checking. A safer alternative is a `brand()` utility with runtime validation.
- Impact: Minimal. This is an established project pattern and works correctly. Noting for completeness.

### LOW

**`noUnusedLocals` and `noUnusedParameters` are disabled** - `tsconfig.json:16-17`

- Problem: Both `noUnusedLocals` and `noUnusedParameters` are set to `false`. Enabling these helps catch dead code early and aligns with the project's strict-mode philosophy.
- Impact: Informational. This is a pre-existing configuration choice.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 1 |
| Should Fix | - | 0 | 1 | - |
| Pre-existing | - | - | 1 | 2 |

**TypeScript Score**: 7/10

The PR demonstrates good TypeScript practices overall: proper use of branded types (`TaskId`), `readonly` arrays in function signatures, `Result` types throughout, strict null checking, and explicit return types on all public methods. The `DependencyRepository` injection follows established DI patterns. The deductions are for the duplicated utility function (DRY violation) and the measurement-unit inconsistency in `totalSize` (bytes vs. characters), which is the most impactful finding -- it affects the correctness of the very bug fix this PR aims to deliver.

**Recommendation**: CHANGES_REQUESTED

The `totalSize` measurement inconsistency (bytes in `capture()`, characters in `linesSize()`) means the tail-slicing fix partially replaces one bug with another. For ASCII-only data (the common case), results are identical. For multi-byte content, `totalSize` will now be wrong in the opposite direction. This should be resolved before merge by choosing a single measurement unit consistently across both `capture()` and `linesSize()`. The duplicated `linesSize` function should be extracted to a shared utility to prevent future divergence.
