# Architecture Review Report

**Branch**: feat/103-extract-schedule-parser -> main
**Date**: 2026-03-22
**PR**: #113

## Issues in Your Changes (BLOCKING)

### CRITICAL

No critical issues found.

### HIGH

No high-severity issues found.

### MEDIUM

**Non-null assertions mask type information that the parser guarantees** - `src/cli/commands/schedule.ts:252,271`
**Confidence**: 82%
- Problem: `args.pipelineSteps!` (line 252) and `args.prompt!` (line 271) use non-null assertions. The `ParsedScheduleCreateArgs` interface declares `prompt?: string` and `pipelineSteps?: readonly string[]` as optional, even though the parser guarantees `prompt` is defined when `isPipeline === false` and `pipelineSteps` is defined when `isPipeline === true`. This forces consumers to use `!` assertions, losing the type-level proof that the parser provides.
- Fix: Use a discriminated union so TypeScript enforces the invariant:
```typescript
type ParsedScheduleCreateArgs =
  | {
      readonly isPipeline: true;
      readonly prompt?: string; // optional, ignored in pipeline mode
      readonly pipelineSteps: readonly string[];
      // ...shared fields
    }
  | {
      readonly isPipeline: false;
      readonly prompt: string;
      readonly pipelineSteps?: undefined;
      // ...shared fields
    };
```
This eliminates both `!` assertions and makes the contract self-documenting. This is the same pattern `loop.ts` would benefit from but does not currently use -- so it is not a regression, but it is a missed opportunity to establish a stronger pattern while extracting.

## Issues in Code You Touched (Should Fix)

No should-fix issues found.

## Pre-existing Issues (Not Blocking)

No critical pre-existing issues found.

## Suggestions (Lower Confidence)

- **Duplicated option-mapping logic between `scheduleCreate` and test helpers** - `tests/unit/cli.test.ts:2497,2544` (Confidence: 72%) -- The `baseOptions` construction in `scheduleCreate` (mapping string enums to domain types via `Priority[...]`, `ScheduleId(...)`, `toMissedRunPolicy(...)`) is duplicated in the test helper `simulateScheduleCreatePipeline`. If the mapping changes in production code, the test helper could diverge. Consider extracting a shared `toScheduleOptions(parsed: ParsedScheduleCreateArgs)` mapper that both the CLI handler and tests use.

- **`parseScheduleCreateArgs` lives in a CLI command file but is a pure domain parser** - `src/cli/commands/schedule.ts:33` (Confidence: 65%) -- The function has zero UI dependencies (no `ui.*`, no `process.exit`). It could live in a dedicated `src/cli/parsers/` module or `src/utils/` to make its purity more discoverable and to enable reuse from the MCP adapter layer without importing CLI command modules. This mirrors the project's existing pattern of `src/utils/validation.ts` and `src/utils/format.ts` for pure utilities. However, the current placement follows the `loop.ts` precedent, so this is a matter of future direction rather than a defect.

- **`handleScheduleCommand` still uses `process.exit(0)` after successful mutation subcommands** - `src/cli/commands/schedule.ts:220` (Confidence: 60%) -- The loop command handler (`handleLoopCommand`) uses `return` for control flow in list/get/cancel and only calls `process.exit(0)` from `handleLoopCreate`. The schedule handler exits from `handleScheduleCommand` itself. This is a minor inconsistency in control flow patterns across CLI commands, not introduced by this PR.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Architecture Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

## Rationale

This is a well-executed extraction that follows the established pattern from `loop.ts` (`parseLoopCreateArgs`). The key architectural improvements are:

1. **SRP adherence**: Parsing/validation is cleanly separated from side effects (`ui.error`, `process.exit`). The new `parseScheduleCreateArgs` is a pure function returning `Result<T, string>`, making it independently testable without mocking `process.exit` or UI calls.

2. **Consistent pattern**: The extracted function mirrors the structure, naming convention (`parse*CreateArgs`), and return type (`Result<ParsedInterface, string>`) already established by `parseLoopCreateArgs` in `loop.ts`.

3. **DRY improvement**: The `baseOptions` construction in `scheduleCreate` eliminates the previously duplicated option-mapping between single-task and pipeline branches.

4. **Test quality**: Tests exercise the pure parser directly with 24 focused test cases covering all flag combinations, validation errors, and edge cases. The integration tests (`simulateScheduleCreate`, `simulateScheduleCreatePipeline`) now route through the real parser, eliminating the previous `validateScheduleCreateInput` / `validatePipelineCreateInput` test-only duplicates.

The single MEDIUM finding (non-null assertions) is a minor type-safety gap. The parser logic guarantees the invariants, but the type system does not encode them. A discriminated union would close this gap. This is not blocking because the runtime behavior is correct and the `!` assertions are guarded by the preceding `if (args.isPipeline)` branch.
