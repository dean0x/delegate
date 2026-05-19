# Complexity Review Report

**Branch**: feat/103-extract-schedule-parser -> main
**Date**: 2026-03-22
**PR**: #113

## Issues in Your Changes (BLOCKING)

### HIGH

**`parseScheduleCreateArgs` function length (137 lines) and cyclomatic complexity (~28)** - `src/cli/commands/schedule.ts:33`
**Confidence**: 82%
- Problem: The extracted function is 137 lines with approximately 28 decision points (14 `if/else if` branches in the main loop, each compounding with `&& next` conditions, plus 7 nested validation checks, plus 5 post-loop validation checks). This exceeds the "Warning" threshold on both function length (>50) and cyclomatic complexity (>10).
- Mitigating context: This is a CLI argument parser, a domain where if/else-if chains are a well-established idiom. The previous `scheduleCreate` function was 189 lines and mixed parsing with side effects (`ui.error` + `process.exit`), so this refactor is a net improvement in separation of concerns. The function is also now pure (returns `Result`) making it trivially testable, which the 25 new tests demonstrate.
- Fix: Consider extracting individual flag parsers into a lookup map or handler table to reduce the linear if/else-if chain. For example:

```typescript
type FlagHandler = (next: string, state: ParserState) => Result<void, string> | void;

const FLAG_HANDLERS: Record<string, FlagHandler> = {
  '--type': (next, state) => {
    if (next !== 'cron' && next !== 'one_time') return err('--type must be "cron" or "one_time"');
    state.scheduleType = next;
  },
  '--cron': (next, state) => { state.cronExpression = next; },
  // ...
};
```

This is a pattern improvement, not blocking. The current code works correctly and is well-tested.

**13 mutable `let` declarations at function top** - `src/cli/commands/schedule.ts:34-47`
**Confidence**: 80%
- Problem: The function opens with 13 mutable `let` variables, which creates a large mutable state surface. Each variable is independently nullable, creating a combinatorial space of possible states at any given point in the function.
- Mitigating context: This pattern is typical for imperative argument parsers. The function boundary (pure function returning `Result`) contains the mutation. The `ParsedScheduleCreateArgs` interface ensures the output is well-typed.
- Fix: A `ParserState` builder object or accumulator pattern would consolidate the mutable state, but this is a stylistic preference given the function already returns an immutable interface. Not blocking.

## Issues in Code You Touched (Should Fix)

No issues found.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`scheduleList` and `scheduleGet` repeat the imperative arg-parsing pattern** - `src/cli/commands/schedule.ts:284-391`
**Confidence**: 85%
- Problem: The same manual `for` loop + `if/else if` pattern for argument parsing appears in `scheduleList` (lines 284-327) and `scheduleGet` (lines 329-391). Now that `parseScheduleCreateArgs` demonstrates the pure-function extraction pattern, these could benefit from the same treatment.
- Note: These functions were not modified in this PR. Informational only.

## Suggestions (Lower Confidence)

- **Test helper duplication** - `tests/unit/cli.test.ts:2497-2582` (Confidence: 65%) -- `simulateScheduleCreatePipeline` builds its arg array with a manual if-chain similar to `buildScheduleCreateArgs` but is not consolidated with it. Could share a utility.

- **Repeated `if (!result.ok) return;` guard in tests** - `tests/unit/cli.test.ts` (Confidence: 62%) -- The pattern `expect(result.ok).toBe(true); if (!result.ok) return;` appears in every success-path test (10+ occurrences). A small assertion helper like `expectOk(result)` that returns the narrowed value would reduce repetition, though this is a common TypeScript narrowing idiom.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | - | 1 | 0 |

**Complexity Score**: 7/10

The refactor reduces overall complexity by separating a 189-line mixed-concern function into a 137-line pure parser and a 60-line orchestrator. The pure function is testable (25 new tests covering all branches) and returns `Result` instead of calling `process.exit`. The cyclomatic complexity of the parser function remains high (~28), but this is inherent to the problem domain (CLI argument parsing with many flags). The architectural improvement -- purity, testability, separation of concerns -- outweighs the raw metric.

**Recommendation**: APPROVED

The two HIGH findings are real measurements (function length and mutable state), but they are well-mitigated by the domain context (CLI parsing), the purity of the extracted function, and the comprehensive test coverage. No blocking issues prevent merge.
