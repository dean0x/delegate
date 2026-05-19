# TypeScript Review Report

**Branch**: feat/103-extract-schedule-parser -> main
**Date**: 2026-03-22

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Non-null assertions (`!`) bypass type safety** - `src/cli/commands/schedule.ts:252`, `src/cli/commands/schedule.ts:271`
**Confidence**: 82%
- Problem: Two non-null assertions are used on `args.pipelineSteps!` (line 252) and `args.prompt!` (line 271). While both are logically safe due to prior validation in `parseScheduleCreateArgs` (pipeline mode guarantees `pipelineSteps` has items; non-pipeline mode guarantees `prompt` is set), the type system cannot verify this because the `ParsedScheduleCreateArgs` interface uses optional types (`prompt?: string`, `pipelineSteps?: readonly string[]`) rather than discriminated unions.
- Fix: Use a discriminated union to make these states type-safe. This eliminates non-null assertions entirely:
  ```typescript
  type ParsedScheduleCreateArgs = {
    readonly scheduleType: 'cron' | 'one_time';
    readonly cronExpression?: string;
    readonly scheduledAt?: string;
    readonly timezone?: string;
    readonly missedRunPolicy?: 'skip' | 'catchup' | 'fail';
    readonly priority?: 'P0' | 'P1' | 'P2';
    readonly workingDirectory?: string;
    readonly maxRuns?: number;
    readonly expiresAt?: string;
    readonly afterScheduleId?: string;
    readonly agent?: AgentProvider;
  } & (
    | { readonly isPipeline: true; readonly pipelineSteps: readonly string[]; readonly prompt?: string }
    | { readonly isPipeline: false; readonly prompt: string; readonly pipelineSteps?: undefined }
  );
  ```
  Then `args.pipelineSteps` and `args.prompt` narrow automatically after checking `args.isPipeline`.

**Type assertions (`as`) after validation** - `src/cli/commands/schedule.ts:72`, `src/cli/commands/schedule.ts:78`
**Confidence**: 80%
- Problem: `next as 'skip' | 'catchup' | 'fail'` and `next as 'P0' | 'P1' | 'P2'` are used after runtime `includes()` checks. The `includes()` call does not narrow `string` to the literal union in TypeScript, so `as` is needed. This is a known TypeScript limitation and the pattern is safe here, but there is a cleaner alternative.
- Fix: Use a type guard function to get proper narrowing without `as`:
  ```typescript
  function isValidPolicy(v: string): v is 'skip' | 'catchup' | 'fail' {
    return v === 'skip' || v === 'catchup' || v === 'fail';
  }
  function isValidPriority(v: string): v is 'P0' | 'P1' | 'P2' {
    return v === 'P0' || v === 'P1' || v === 'P2';
  }
  ```
  Then: `if (!isValidPolicy(next)) return err(...)` followed by `missedRunPolicy = next;` -- no cast needed.

## Issues in Code You Touched (Should Fix)

### LOW

**`parseInt` without explicit radix** - `src/cli/commands/schedule.ts:88`
**Confidence**: 85%
- Problem: `parseInt(next)` does not specify a radix. While modern engines default to base-10 for decimal strings, ESLint `radix` rule and best practice recommend always providing `10` explicitly to avoid ambiguity (e.g., leading-zero strings in older contexts).
- Fix: `parseInt(next, 10)` -- though this line existed before the refactor (pre-existing at line 120 on main), it is now inside new code (the extracted `parseScheduleCreateArgs` function), so it is worth cleaning up.

## Pre-existing Issues (Not Blocking)

### LOW

**Dynamic `import()` in tests instead of static import** - `tests/unit/cli.test.ts:1052-1057`, `tests/unit/cli.test.ts:2500`, `tests/unit/cli.test.ts:2547`
**Confidence**: 80%
- Problem: `parseScheduleCreateArgs` is a pure, synchronous function with no side effects. It is imported dynamically via `await import(...)` in `beforeAll` and inside helper functions. Since the function has no module-level side effects that need deferral, a static `import { parseScheduleCreateArgs } from '../../src/cli/commands/schedule'` at the top of the file would be simpler and provide better type-checking at module resolution time. The dynamic import pattern is already in use elsewhere in this test file (likely for modules with side effects), but applying it to a pure parser is unnecessary.
- Fix: Add a static import alongside the existing imports:
  ```typescript
  import { parseScheduleCreateArgs } from '../../src/cli/commands/schedule';
  ```
  Remove the `let` declaration, `beforeAll` block, and inline `await import(...)` calls.

**`ParsedScheduleCreateArgs` interface not exported** - `src/cli/commands/schedule.ts:13`
**Confidence**: 80%
- Problem: The `ParsedScheduleCreateArgs` interface is not exported, but the function `parseScheduleCreateArgs` that returns `Result<ParsedScheduleCreateArgs, string>` is exported. Consumers (including tests) cannot reference the type directly. TypeScript infers it from `result.value`, so it works, but explicit typing of variables holding this result requires the type to be exported.
- Fix: Add `export` to the interface declaration: `export interface ParsedScheduleCreateArgs`.

## Suggestions (Lower Confidence)

- **Missing `--working-directory` / `-w` shorthand test** - `tests/unit/cli.test.ts` (Confidence: 65%) -- The `-w` shorthand for `--working-directory` is supported in the parser but not tested independently (only `--working-directory` is used in the "all optional flags" test).

- **`expiresAt` string not validated** - `src/cli/commands/schedule.ts:94` (Confidence: 60%) -- The `--expires-at` value is accepted as a raw string without any ISO date format validation, unlike other flags that have validation. This could surface as a confusing downstream error.

- **Duplicated `ScheduleType` / `MissedRunPolicy` mapping** - `tests/unit/cli.test.ts:2504-2510`, `tests/unit/cli.test.ts:2560-2566` (Confidence: 70%) -- The mapping from parsed string values to domain enums (`toMissedRunPolicy`, `ScheduleType.CRON`, etc.) is repeated in both `simulateScheduleCreate` and `simulateScheduleCreatePipeline` test helpers. This mirrors the same duplication avoidance the PR achieved in production code with `baseOptions`, but the test helpers did not get the same treatment.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 1 |
| Pre-existing | 0 | 0 | 0 | 2 |

**TypeScript Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The refactoring is well-executed: extracting a pure function with `Result<T, E>` return type from side-effectful CLI code is a strong improvement for testability and follows project conventions. The `ParsedScheduleCreateArgs` interface uses `readonly` properties correctly and the overall type design is solid. The two MEDIUM findings (non-null assertions and type assertions) are safe at runtime but could be eliminated with discriminated unions and type guards respectively -- both patterns the codebase already embraces elsewhere.

Conditions:
1. Consider adopting a discriminated union for `ParsedScheduleCreateArgs` to eliminate the two `!` assertions (MEDIUM).
2. Consider replacing `as` casts with type guard functions for `missedRunPolicy` and `priority` validation (MEDIUM).
