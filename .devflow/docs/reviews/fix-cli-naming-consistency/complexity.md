# Complexity Review Report

**Branch**: fix/cli-naming-consistency -> main
**Date**: 2026-03-24

## Issues in Your Changes (BLOCKING)

### CRITICAL

No critical complexity issues found.

### HIGH

No high-severity complexity issues found.

### MEDIUM

**Flag-skipping guard clause has growing boolean complexity** - `src/cli/commands/schedule.ts:267`
**Confidence**: 82%
- Problem: The condition that determines which flags are boolean (don't consume the next arg) is now a 3-term negation chain: `arg !== '--checkpoint' && arg !== '--minimize' && arg !== '--maximize'`. This is an exclusion list within a larger inclusion list (11 flags in the `if` on line 252-264). When new boolean flags are added, developers must remember to update *both* the outer `if` (to recognize the flag) and the inner `if` (to exclude it from value consumption). This dual-update requirement is a maintenance trap.
- Fix: Invert the logic to use an allowlist of value-consuming flags instead of an exclusion list of boolean flags. This makes the intent clearer and reduces the chance of forgetting to update one of the two lists:
  ```typescript
  // Instead of excluding boolean flags from value consumption:
  const VALUE_FLAGS = new Set(['--until', '--eval', '--strategy', '--max-iterations', '--max-failures', '--cooldown', '--eval-timeout', '--git-branch']);
  if (VALUE_FLAGS.has(arg) && next && !next.startsWith('-')) {
    i++;
  }
  ```

## Issues in Code You Touched (Should Fix)

No should-fix issues found.

## Pre-existing Issues (Not Blocking)

**Duplicated direction-flag validation logic across two parsers** - `src/cli/commands/loop.ts:145-157`, `src/cli/commands/schedule.ts:138-146`
**Confidence**: 80%
- Problem: The `--minimize`/`--maximize` mutual exclusion check and ternary resolution to `'minimize' | 'maximize' | undefined` is duplicated nearly verbatim in both `parseLoopCreateArgs()` and `parseScheduleLoopFlags()`. The subsequent `isOptimize && !direction` / `!isOptimize && direction` validation is also duplicated between `loop.ts:153-157` and `schedule.ts:319-324`. This is 4 blocks of near-identical logic.
- Impact: If direction semantics change (e.g., adding a third strategy direction), two files must be updated in lockstep.
- Fix: Extract a shared `resolveDirectionFlags(minimize: boolean, maximize: boolean): Result<'minimize' | 'maximize' | undefined, string>` utility and a `validateDirectionForStrategy(isOptimize: boolean, direction: ...) : Result<void, string>` helper.

**`parseScheduleCreateArgs` remains a long function** - `src/cli/commands/schedule.ts:166-398`
**Confidence**: 80%
- Problem: At 233 lines, `parseScheduleCreateArgs` is well above the 50-line critical threshold from the complexity metrics. The function handles schedule-specific flags, loop-specific flag forwarding, type inference, loop validation, pipeline validation, and result construction all in one body. The `parseScheduleLoopFlags` extraction helped, but the parent function is still large.
- Impact: High cognitive load for anyone modifying schedule argument parsing. New flags increase both the main `for` loop and the flag-skip guard.
- Fix: Consider further extraction -- e.g., pull the "Infer type from --cron / --at" validation (lines 287-302) and "Loop mode" validation (lines 305-360) into named helper functions.

## Suggestions (Lower Confidence)

- **Ternary chain for direction resolution is mildly hard to scan** - `src/cli/commands/loop.ts:148-152` (Confidence: 65%) -- The nested ternary `minimizeFlag ? 'minimize' : maximizeFlag ? 'maximize' : undefined` requires parsing three branches. A simple `if/else if/else` or a lookup map would read more linearly, though this is a minor style preference.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 2 | 0 |

**Complexity Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The PR is a mechanical rename with one non-trivial structural change: converting `--direction <value>` (a single value flag) into two boolean flags (`--minimize`/`--maximize`). This change is well-implemented with proper mutual-exclusion validation and corresponding test coverage (including a new test for the `--minimize && --maximize` rejection case). The only actionable complexity concern in the changed lines is the growing boolean-exclusion guard in the flag-skipping logic of `parseScheduleCreateArgs`, which should be addressed before the exclusion list grows further. Pre-existing function length and duplication are informational -- reasonable targets for a future tech-debt pass.
