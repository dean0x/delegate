# Consistency Review Report

**Branch**: feat/103-extract-schedule-parser -> main
**Date**: 2026-03-22

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Missing pipeline usage hint in error message** - `src/cli/commands/schedule.ts:150`
**Confidence**: 90%
- Problem: The original `scheduleCreate` function displayed a two-line error when no prompt was provided: the usage line plus a pipeline example (`ui.info('  Pipeline: beat schedule create --pipeline --step "lint" --step "test" --cron "0 9 * * *"')`). The refactored `parseScheduleCreateArgs` only returns the single-line error string via `return err('Usage: beat schedule create <prompt> --cron "..." | --at "..." [options]')`. The pipeline hint is silently dropped, reducing the helpfulness of the error output for users who may not know about the `--pipeline` flag.
- Fix: Either append the pipeline hint to the error string, or handle it at the call site in `scheduleCreate` after displaying the error:
```typescript
// Option A: Include in error message
return err(
  'Usage: beat schedule create <prompt> --cron "..." | --at "..." [options]\n' +
  '  Pipeline: beat schedule create --pipeline --step "lint" --step "test" --cron "0 9 * * *"'
);

// Option B: Handle at call site (after ui.error(parsed.error))
// Add: if (parsed.error.includes('Usage:')) ui.info('  Pipeline: ...');
```

**Inconsistent prompt field handling vs loop parser** - `src/cli/commands/schedule.ts:154`
**Confidence**: 82%
- Problem: The loop parser at `loop.ts:163` uses `prompt: isPipeline ? undefined : prompt` which explicitly sets `undefined` when in pipeline mode. The schedule parser uses `prompt: prompt || undefined` which is subtly different -- it converts empty string to `undefined` in all modes, including pipeline mode where `prompt` could be a non-empty string (positional words collected before `--pipeline`). The inconsistency means the schedule parser returns a prompt value in pipeline mode that the loop parser would suppress. While the call site handles this with the `args.isPipeline && args.prompt` warning, the two parsers should behave the same way for consistency.
- Fix: Match the loop parser pattern:
```typescript
return ok({
  prompt: isPipeline ? undefined : (prompt || undefined),
  // ... rest
});
```
Then handle the pipeline-with-prompt warning before calling the parser (or check `promptWords.length > 0` inside the parser and emit it as a separate field).

### LOW

**Missing `ARCHITECTURE:` JSDoc annotation** - `src/cli/commands/schedule.ts:30-32`
**Confidence**: 85%
- Problem: The `parseLoopCreateArgs` function in `loop.ts:30` has the JSDoc comment `ARCHITECTURE: Pure function -- no side effects, returns Result for testability`. The `parseScheduleCreateArgs` function in `schedule.ts:30-32` only has `Parse and validate schedule create arguments.` This is a minor inconsistency with the established pattern for pure parser functions in this codebase.
- Fix:
```typescript
/**
 * Parse and validate schedule create arguments.
 * ARCHITECTURE: Pure function -- no side effects, returns Result for testability
 */
```

## Issues in Code You Touched (Should Fix)

No issues found.

## Pre-existing Issues (Not Blocking)

No issues found.

## Suggestions (Lower Confidence)

- **`process.exit(0)` removal from `scheduleCreate` branches** - `src/cli/commands/schedule.ts:266` (Confidence: 65%) -- The original code had `process.exit(0)` at the end of both the pipeline and single-task branches in `scheduleCreate`. The refactored version uses `return` for the pipeline branch and falls through for the single-task branch, relying on the caller `handleScheduleCommand` to call `process.exit(0)`. This is correct and actually cleaner, but it is a different pattern from `pipeline.ts:72` which calls `process.exit(0)` directly. Not flagging as blocking since the schedule command correctly exits via its parent handler.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 1 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Consistency Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The refactoring is well-executed and closely mirrors the established pattern from `loop.ts` (`parseLoopCreateArgs`). The extraction of a pure `parseScheduleCreateArgs` function returning `Result<T, string>` is consistent with the project's architecture principles. The test coverage is thorough, using the real parser function instead of duplicated validation helpers. The two MEDIUM findings (dropped pipeline usage hint and prompt field handling divergence from the loop parser) are minor consistency gaps that should be addressed to keep the two parsers aligned.
