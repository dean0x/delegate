# Tests Review Report

**Branch**: fix/cli-naming-consistency -> main
**Date**: 2026-03-24
**PR**: #117

## Issues in Your Changes (BLOCKING)

### CRITICAL

_None_

### HIGH

_None_

### MEDIUM

**Missing mutual exclusion test for `--minimize`/`--maximize` in schedule `--loop` context** - `tests/unit/cli.test.ts`
**Confidence**: 85%
- Problem: The `parseLoopCreateArgs` tests include a test for rejecting both `--minimize` and `--maximize` simultaneously (line 2918), but the `CLI - Schedule --loop flag` describe block has no corresponding test. The production code in `parseScheduleLoopFlags()` (`src/cli/commands/schedule.ts:139-141`) does validate this case (`if (loopMinimize && loopMaximize) return err(...)`) but it is untested for the schedule path.
- Impact: The mutual exclusion validation in the schedule parser could regress without test coverage catching it.
- Fix: Add a test to the `CLI - Schedule --loop flag` describe block:
```typescript
it('should reject --loop with both --minimize and --maximize', () => {
  const result = parseScheduleCreateArgs([
    '--loop', '--eval', 'echo 42', '--minimize', '--maximize', '--cron', '0 9 * * *',
  ]);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toContain('Cannot specify both --minimize and --maximize');
});
```

## Issues in Code You Touched (Should Fix)

_None_

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`getHelpText()` test helper omits loop commands section** - `tests/unit/cli.test.ts:2222`
**Confidence**: 82%
- Problem: The `getHelpText()` helper string used in the `CLI - Help Text Coverage` tests only covers Task, Schedule, Pipeline, and Configuration sections. The Loop Commands section (including `loop status`, `--checkpoint`, `--minimize|--maximize`) is entirely absent from the test helper, meaning there is no help text assertion for any loop subcommand.
- Impact: Help text regressions in the loop section would go undetected. This was pre-existing before this PR (the loop section was never added to the test helper).

## Suggestions (Lower Confidence)

- **Missing `--maximize` happy-path test in schedule context** - `tests/unit/cli.test.ts` (Confidence: 65%) -- The schedule `--loop` tests only verify `--minimize` for the optimize strategy happy path but never test `--maximize`. A complementary test would increase confidence in both flag paths.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Tests Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Rationale

The test changes are well-executed mechanical renames that correctly mirror the production code changes:

1. **Rename consistency is thorough**: All references to `--direction`, `--continue-context`, `schedule get`, `loop get`, `GetSchedule`, `simulateGetSchedule`, and `shouldFailGetSchedule` have been updated across both test files with zero stale references remaining.

2. **New test added for mutual exclusion**: The PR correctly adds a new test (`should reject both --minimize and --maximize`) for `parseLoopCreateArgs` covering the new validation path that replaces the old `--direction` value validation.

3. **Test-production parity maintained**: The test helper functions (`simulateScheduleStatusCommand`, `simulateScheduleStatus`) correctly reflect the renamed production functions, and assertions match the updated error messages.

4. **One minor gap**: The schedule `--loop` flag section lacks a parallel mutual exclusion test for `--minimize`/`--maximize`, despite the production code having this validation. This is a MEDIUM-severity gap because the same logic is tested through the loop path, but best practice is to test each parser independently.

The condition for approval is adding the missing mutual exclusion test for the schedule `--loop` parser.
