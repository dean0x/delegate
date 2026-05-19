# Regression Review Report

**Branch**: feat/103-extract-schedule-parser -> main
**Date**: 2026-03-22

## Issues in Your Changes (BLOCKING)

### CRITICAL

No critical issues found.

### HIGH

No high issues found.

### MEDIUM

**Missing pipeline usage hint in empty-prompt error path** - `src/cli/commands/schedule.ts:149`
**Confidence**: 85%
- Problem: The original `scheduleCreate` function emitted two lines when no prompt was provided in non-pipeline mode: an error with the usage string, and a `ui.info()` hint showing the pipeline syntax (`Pipeline: beat schedule create --pipeline --step "lint" --step "test" --cron "0 9 * * *"`). The extracted `parseScheduleCreateArgs` only returns the error string. The `ui.info()` pipeline hint is lost. Users who forget the prompt no longer see the pipeline alternative usage hint.
- Fix: Either include the pipeline hint text in the error string returned by `parseScheduleCreateArgs`, or handle it in the `scheduleCreate` caller after detecting this specific error. Simplest approach:
```typescript
// In parseScheduleCreateArgs, line 149:
if (!isPipeline && !prompt) {
  return err('Usage: beat schedule create <prompt> --cron "..." | --at "..." [options]\n  Pipeline: beat schedule create --pipeline --step "lint" --step "test" --cron "0 9 * * *"');
}
```

## Issues in Code You Touched (Should Fix)

No issues found.

## Pre-existing Issues (Not Blocking)

No issues found.

## Suggestions (Lower Confidence)

- **Test helper `simulateScheduleCreate` passes `priority` as raw string** - `tests/unit/cli.test.ts:2512` (Confidence: 65%) -- The test helper passes `args.priority` (a string like `'P0'`) directly to `service.createSchedule()`, whereas the production `scheduleCreate` converts via `Priority[args.priority]`. This works today because `Priority.P0 === 'P0'` (string enum), but if Priority values ever diverge from their keys, the test would silently pass while production behavior differs.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Regression Score**: 9/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Detailed Analysis

**What this PR does**: Extracts the argument parsing logic from the `scheduleCreate` CLI handler into a pure, exported function `parseScheduleCreateArgs` that returns `Result<ParsedScheduleCreateArgs, string>`. This separates parsing/validation from side effects (`ui.error`, `process.exit`). The `handleScheduleCommand` orchestrator and all other subcommand handlers are preserved identically.

**Regression checklist**:
- [x] No exports removed without deprecation -- `handleScheduleCommand` remains exported; new export `parseScheduleCreateArgs` added
- [x] Return types backward compatible -- `handleScheduleCommand` signature unchanged
- [x] Default values unchanged
- [x] Side effects preserved -- `ui.error`/`process.exit(1)` still called in `scheduleCreate` for parse errors; `ui.info` pipeline warning still present for pipeline-with-prompt case
- [x] All consumers of changed code updated -- only consumer (`src/cli.ts`) imports `handleScheduleCommand`, which is unchanged
- [x] Migration complete -- test helpers updated to use `parseScheduleCreateArgs` and `buildScheduleCreateArgs`; old `validateScheduleCreateInput`/`validatePipelineCreateInput` removed from tests
- [x] CLI options preserved -- all flags (`--cron`, `--at`, `--type`, `--timezone`, `--missed-run-policy`, `--priority`/`-p`, `--working-directory`/`-w`, `--max-runs`, `--expires-at`, `--after`, `--agent`/`-a`, `--pipeline`, `--step`) are preserved
- [x] Commit message matches implementation -- "extract parseScheduleCreateArgs pure function" accurately describes the change
- [x] Tests updated -- 25 new pure-function tests added; 4 old tests that used removed helpers were migrated/replaced
- [ ] Minor: pipeline usage hint dropped from empty-prompt error (MEDIUM severity above)

**Type inference refactoring**: The ternary `cronExpression ? 'cron' : scheduledAt ? 'one_time' : undefined` was replaced with explicit `if/else` blocks -- semantically identical, no regression.

**process.exit(0) consolidation**: The original `scheduleCreate` called `process.exit(0)` at the end of both the pipeline and single-task branches. The refactored version uses `return` in the pipeline branch and falls through in the single-task branch; `handleScheduleCommand` calls `process.exit(0)` after the switch, preserving identical behavior.

**Test count**: 233 CLI tests pass (up from ~208 on main), confirming no regressions.
