# TypeScript Review Report

**Branch**: feat/read-only-cli-90 -> main
**Date**: 2026-03-18

## Issues in Your Changes (BLOCKING)

### HIGH

**Missing type-only imports for interfaces** - `src/cli/read-only-context.ts:16,19`
- Problem: `ScheduleRepository`, `TaskRepository`, and `OutputRepository` are imported as value imports but are only used as type annotations in the `ReadOnlyContext` interface. `ScheduleRepository` and `TaskRepository` come from `interfaces.ts` (pure type exports), and `OutputRepository` is co-located with `SQLiteOutputRepository` in `output-repository.ts` but is only used as a type in this file.
- Impact: Without `verbatimModuleSyntax` enabled in tsconfig (it is not currently enabled), this has no runtime effect. However, it violates the TypeScript skill checklist item "Type-only imports for types" and makes intent unclear to readers -- are these interfaces used as values (runtime) or only as types (compile-time)?
- Fix: Use `import type` for interface-only imports:
  ```typescript
  import type { ScheduleRepository, TaskRepository } from '../core/interfaces.js';
  import type { OutputRepository } from '../implementations/output-repository.js';
  import { SQLiteOutputRepository } from '../implementations/output-repository.js';
  ```

**Unused import: `ReadOnlyContext` in test file** - `tests/unit/read-only-context.test.ts:5`
- Problem: `ReadOnlyContext` is imported as a value import but is never used as a type annotation or value anywhere in the test file. It only appears in the `describe('ReadOnlyContext', ...)` string, which is not a type usage.
- Impact: Dead import increases cognitive load and suggests the type might be needed when it is not. Could confuse future maintainers.
- Fix: Remove the unused import:
  ```typescript
  import { createReadOnlyContext } from '../../src/cli/read-only-context.js';
  ```

### MEDIUM

**Unnecessary type assertion removes `readonly`** - `src/cli/commands/status.ts:66`
- Problem: `result.value as Task[]` casts `readonly Task[]` (from `findAllUnbounded()`) to mutable `Task[]`. In the old code this cast was needed because `taskManager.getStatus()` returned `Result<Task | readonly Task[]>` (a union), requiring disambiguation. After the refactor to `findAllUnbounded()`, the return type is already `Result<readonly Task[]>`, making the cast unnecessary.
- Impact: The cast silently removes the `readonly` modifier, which goes against the immutability principle. While no mutation happens in this `for...of` loop, the cast could mask future bugs if someone later mutates `result.value`.
- Fix: Remove the type assertion -- `for...of` works on `readonly` arrays:
  ```typescript
  for (const task of result.value) {
  ```

**Non-null assertions in test file** - `tests/unit/read-only-context.test.ts:56-57,135-136`
- Problem: Lines use `findResult.value!.prompt` and `outputResult.value!.stdout` with non-null assertions. While each is preceded by `expect(findResult.value).not.toBeNull()`, the TypeScript compiler does not narrow types based on Vitest assertions, so the `!` assertion is technically bypassing the type checker.
- Impact: Low risk in tests since the preceding assertion will fail first, but this is an anti-pattern per the TypeScript skill ("Non-null abuse"). The codebase uses the `if (!result.ok) return` guard pattern elsewhere in the same file, which is the correct approach.
- Fix: Add a null guard before the assertion block:
  ```typescript
  const task = findResult.value;
  if (!task) return;
  expect(task.prompt).toBe('test read-only context');
  expect(task.status).toBe(TaskStatus.QUEUED);
  ```

**No database cleanup in CLI commands using ReadOnlyContext** - `src/cli/commands/logs.ts`, `src/cli/commands/status.ts`, `src/cli/commands/schedule.ts`
- Problem: Commands create a `ReadOnlyContext` (which opens a `Database` connection) but never call `ctx.database.close()`. The test file correctly calls `ctx.database.close()` in every test case, establishing the expected pattern. The CLI commands rely on `process.exit()` to clean up.
- Impact: Low -- SQLite connections are cleaned up by the OS on process exit, and these are CLI commands that always exit immediately. However, this diverges from the cleanup pattern established by the tests and could cause issues if these functions are ever called in a non-exiting context (e.g., testing, REPL, or long-running process).
- Fix: Consider adding cleanup in a `finally` block, or document that `process.exit()` handles cleanup:
  ```typescript
  // In logs.ts - already has try/catch:
  try {
    const ctx = withReadOnlyContext(s);
    try {
      // ... existing logic ...
    } finally {
      ctx.database.close();
    }
  } catch (error) { ... }
  ```
  Alternatively, add a comment explaining the intentional reliance on `process.exit()`.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Unsafe type assertion for ScheduleStatus lookup** - `src/cli/commands/schedule.ts:276-279`
- Problem: `status as keyof typeof ScheduleStatus` and `statusEnum.toUpperCase() as keyof typeof ScheduleStatus` perform unchecked type assertions. If a user passes `--status invalid`, the code will attempt `ScheduleStatus['INVALID']` which returns `undefined`, then passes `undefined` to `repo.findByStatus()`.
- Impact: This is a pre-existing pattern from the old `service.listSchedules()` call, but the refactor preserved it without adding runtime validation. Since `findByStatus` now goes directly to the repository (bypassing the service layer's potential validation), unvalidated status values could cause unexpected behavior.
- Fix: Add runtime validation before the lookup:
  ```typescript
  const { ScheduleStatus } = await import('../../core/domain.js');
  const validStatuses = Object.keys(ScheduleStatus);
  if (status && !validStatuses.includes(status.toUpperCase())) {
    ui.error(`Invalid status: ${status}. Valid: ${validStatuses.join(', ')}`);
    process.exit(1);
  }
  ```

## Pre-existing Issues (Not Blocking)

### LOW

**`errorMessage` function uses `unknown` correctly** - `src/cli/services.ts:9-11`
- The `errorMessage` helper properly handles `unknown` catch values with `instanceof` check. This is good TypeScript practice and consistent with the skill's guidance.

**No `verbatimModuleSyntax` in tsconfig** - `tsconfig.json`
- The project does not enable `verbatimModuleSyntax`, which means the compiler silently drops type-only imports at emit time regardless of syntax used. Enabling it would enforce `import type` discipline across the codebase.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 3 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 2 |

**TypeScript Score**: 7/10

The code follows strong TypeScript patterns overall: proper use of `Result<T>` discriminated unions, no `any` types, correct null-checking with early returns, and proper generic usage through repository interfaces. The main gaps are around import hygiene (type-only imports for interfaces), a leftover type assertion that weakens `readonly`, and non-null assertions in tests where null guards would be cleaner.

**Recommendation**: APPROVED_WITH_CONDITIONS

Conditions:
1. Fix the type-only imports in `read-only-context.ts` (HIGH)
2. Remove the unused `ReadOnlyContext` import from the test file (HIGH)
3. Remove the unnecessary `as Task[]` cast in `status.ts:66` (MEDIUM -- quick fix)
