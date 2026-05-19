# Regression Review Report

**Branch**: fix/cli-naming-consistency -> main
**Date**: 2026-03-24
**Commit**: c2537f8 fix(cli): standardize CLI naming -- --minimize/--maximize, --checkpoint, status subcommand

## Issues in Your Changes (BLOCKING)

### HIGH

**Missed rename: `GetSchedule` still referenced in README.md MCP tools table** - `README.md:81`
**Confidence**: 98%
- Problem: The MCP tools table in README.md still lists `GetSchedule` as the tool name and `GetSchedule({ scheduleId })` in the usage column. Every other reference across 16 files (CHANGELOG, CLAUDE.md, FEATURES.md, release notes, source code, tests) was correctly updated to `ScheduleStatus`, but this single table row was missed.
- Impact: Users consulting the README will call `GetSchedule` which no longer exists as an MCP tool name, causing tool-not-found errors. This is the most visible documentation surface (first thing users see).
- Fix:
```markdown
# Line 81 — change from:
| **GetSchedule** | Get schedule details and execution history | `GetSchedule({ scheduleId })` |

# To:
| **ScheduleStatus** | Get schedule details and execution history | `ScheduleStatus({ scheduleId })` |
```

## Issues in Code You Touched (Should Fix)

No issues found.

## Pre-existing Issues (Not Blocking)

No issues found.

## Suggestions (Lower Confidence)

No suggestions.

## Regression Checklist

- [x] No exports removed without deprecation (internal method `getSchedule` on schedule-manager preserved; only external CLI/MCP surface renamed)
- [x] Return types backward compatible (no return type changes)
- [x] Default values unchanged (no defaults modified)
- [x] Side effects preserved (events, logging untouched)
- [x] All consumers of changed code updated -- **EXCEPT** README.md line 81
- [x] Migration complete across codebase -- **EXCEPT** README.md line 81
- [x] CLI options correctly renamed (`--direction` -> `--minimize`/`--maximize`, `--continue-context` -> `--checkpoint`, `get` -> `status`)
- [x] Commit message matches implementation (3 renames all implemented)
- [x] Breaking changes documented in CHANGELOG
- [x] New edge case covered: mutual exclusion test for `--minimize` + `--maximize` added
- [x] Boolean flag skip-logic in `parseScheduleCreateArgs` correctly excludes `--minimize`, `--maximize`, `--checkpoint` from value consumption
- [x] Internal service method names (`getSchedule`, `scheduleService.getSchedule`) correctly preserved (only external surface renamed)
- [x] Test helper functions renamed consistently (`simulateGetSchedule` -> `simulateScheduleStatus`, `simulateScheduleGetCommand` -> `simulateScheduleStatusCommand`)
- [x] Help text assertions updated (`schedule get` -> `schedule status`)
- [x] Test descriptions updated to match new flag names
- [x] No stale `'get'` subcommand dispatchers in schedule.ts or loop.ts

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | - | 0 | 0 |

**Regression Score**: 9/10
**Recommendation**: CHANGES_REQUESTED

The rename is thorough and well-executed across 16 files with good test coverage for new validation paths. One stale `GetSchedule` reference in README.md line 81 (MCP tools table) needs to be updated to `ScheduleStatus` before merge. After that fix, this is a clean APPROVED.
