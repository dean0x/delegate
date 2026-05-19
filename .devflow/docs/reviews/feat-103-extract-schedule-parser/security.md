# Security Review Report

**Branch**: feat/103-extract-schedule-parser -> main
**Date**: 2026-03-22
**PR**: #113

## Issues in Your Changes (BLOCKING)

### CRITICAL

No critical issues found.

### HIGH

No high-severity issues found.

### MEDIUM

No medium-severity issues found.

## Issues in Code You Touched (Should Fix)

No should-fix issues found.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**No validation on `--at` and `--expires-at` date strings in CLI parser** - `src/cli/commands/schedule.ts:63,94`
**Confidence**: 65%
- Problem: The `--at` and `--expires-at` flag values are accepted as raw strings with no format validation at the parsing boundary. An arbitrary string like `--at "not-a-date"` passes through the parser unchecked.
- Mitigated: The downstream `ScheduleManager.validateScheduleTiming()` (line 426-433) performs `Date.parse()` and rejects invalid datetime values with proper error messages. This is defense-in-depth working correctly. The risk is limited because the service layer catches it before any database write.
- Note: This is pre-existing behavior -- the original code also passed these strings through without validation at the CLI layer.

### LOW

**`ScheduleId` branded type is a passthrough cast with no runtime format validation** - `src/cli/commands/schedule.ts:245`
**Confidence**: 65%
- Problem: `afterScheduleId` from user input is wrapped in `ScheduleId()` which is just `id as ScheduleId` (domain.ts:16). Arbitrary strings pass through. However, downstream lookups use parameterized queries (`repo.findById()`), so this cannot produce injection.
- Note: This is a codebase-wide pattern (branded types without runtime validation), not introduced by this PR.

## Suggestions (Lower Confidence)

- **`parseInt` without radix parameter** - `src/cli/commands/schedule.ts:88` (Confidence: 60%) -- `parseInt(next)` should use `parseInt(next, 10)` to explicitly specify base-10 parsing, preventing edge cases with strings starting with `0x` or `0o`. However, the follow-up `isNaN(maxRuns) || maxRuns < 1` guard catches most problematic inputs, and this is a pre-existing pattern carried into the new function.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | - | 1 | 1 |

**Security Score**: 9/10
**Recommendation**: APPROVED

## Analysis Notes

This PR is a well-executed pure refactor that improves security posture by:

1. **Eliminates side effects from validation**: The old code called `ui.error()` + `process.exit(1)` inline during argument parsing. The new `parseScheduleCreateArgs()` is a pure function returning `Result<T, string>`, making validation testable and composable without process termination side effects.

2. **Input validation preserved**: All existing validation checks (type enumeration, priority enumeration, agent validation, flag conflict detection, path traversal via `validatePath()`, numeric bounds on `--max-runs`) are carried over faithfully.

3. **No new attack surface**: The refactor does not introduce any new user inputs, external calls, or data flows. It restructures existing logic without changing the trust boundary.

4. **Downstream defenses intact**: Date parsing (`scheduledAt`, `expiresAt`) continues to be validated by `ScheduleManager.validateScheduleTiming()`. Cron expressions are validated by `validateCronExpression()`. Working directory paths are validated by `validatePath()` with symlink resolution. All database operations use parameterized queries.

5. **No secrets, no injection vectors, no auth changes**: The diff contains no hardcoded credentials, no string interpolation into queries, no command execution, and no changes to authentication or authorization logic.
