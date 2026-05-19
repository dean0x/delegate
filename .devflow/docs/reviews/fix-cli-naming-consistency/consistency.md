# Consistency Review Report

**Branch**: fix/cli-naming-consistency -> main
**Date**: 2026-03-24
**PR**: #117

## Issues in Your Changes (BLOCKING)

### HIGH

**Missed MCP tool rename in README.md** - `README.md:81`
**Confidence**: 95%
- Problem: The MCP Tools table at README.md line 81 still references `GetSchedule` (both the tool name and the example call). Every other occurrence of `GetSchedule` across source, tests, docs, CLAUDE.md, CHANGELOG, and release notes was renamed to `ScheduleStatus`, but this table entry was missed.
- Fix:
  ```markdown
  # Line 81 — change:
  | **GetSchedule** | Get schedule details and execution history | `GetSchedule({ scheduleId })` |
  # to:
  | **ScheduleStatus** | Get schedule details and execution history | `ScheduleStatus({ scheduleId })` |
  ```

## Issues in Code You Touched (Should Fix)

No issues found.

## Pre-existing Issues (Not Blocking)

No issues found.

## Suggestions (Lower Confidence)

No suggestions.

## Detailed Consistency Analysis

### Rename 1: `--direction` -> `--minimize`/`--maximize` (boolean flags)

| Area | Renamed | Verified |
|------|---------|----------|
| `src/cli/commands/loop.ts` parser | Yes | All `--direction` references removed, `--minimize`/`--maximize` boolean flags added |
| `src/cli/commands/schedule.ts` parser | Yes | `parseScheduleLoopFlags()` and `parseScheduleCreateArgs()` both updated |
| `src/cli/commands/help.ts` | Yes | Help text shows `--minimize\|--maximize` |
| Error messages (loop.ts) | Yes | 5 error messages updated to reference new flags |
| Error messages (schedule.ts) | Yes | 3 error messages updated to reference new flags |
| Tests (cli.test.ts) | Yes | All test descriptions, assertions, and argument arrays updated |
| Docs (FEATURES.md, release notes) | Yes | Updated |
| New validation: mutual exclusion | Yes | Both parsers reject `--minimize` + `--maximize` together, with new test |
| Internal field `evalDirection` | Unchanged | Correctly preserved -- internal API unaffected |

### Rename 2: `--continue-context` -> `--checkpoint`

| Area | Renamed | Verified |
|------|---------|----------|
| `src/cli/commands/loop.ts` parser | Yes | Flag name changed, internal variable `continueContext` preserved |
| `src/cli/commands/schedule.ts` parser | Yes | Both `parseScheduleLoopFlags()` and skip-list in `parseScheduleCreateArgs()` updated |
| `src/cli/commands/help.ts` | Yes | Help text updated with accurate description |
| Tests (cli.test.ts) | Yes | Test descriptions and argument arrays updated |
| Skip-list in schedule.ts | Yes | Boolean flag correctly handled (no `next` consumption) |

### Rename 3: `get` -> `status` subcommand (CLI + MCP)

| Area | Renamed | Verified |
|------|---------|----------|
| `src/cli/commands/schedule.ts` | Yes | `scheduleGet` -> `scheduleStatus`, subcommand routing, usage strings, error messages |
| `src/cli/commands/loop.ts` | Yes | `handleLoopGet` -> `handleLoopStatus`, subcommand routing, usage strings |
| `src/cli/commands/help.ts` | Yes | Both schedule and loop help sections |
| `src/cli/read-only-context.ts` | Yes | Comment updated |
| `src/cli/services.ts` | Yes | Comment updated |
| `src/adapters/mcp-adapter.ts` | Yes | `GetScheduleSchema` -> `ScheduleStatusSchema`, `handleGetSchedule` -> `handleScheduleStatus`, tool name in listing, case handler |
| Tests (cli.test.ts) | Yes | Describe blocks, helper functions, assertions |
| Tests (mcp-adapter.test.ts) | Yes | Describe blocks, mock fields, helper functions |
| CLAUDE.md MCP tool list | Yes | Updated, also adds `PauseLoop`, `ResumeLoop`, `ScheduleLoop` |
| README.md CLI table (line 107) | Yes | `beat schedule status` |
| README.md MCP table (line 81) | **NO** | Still says `GetSchedule` -- **BLOCKING** |
| CHANGELOG.md | Yes | All 3 sections updated |
| docs/FEATURES.md | Yes | All 7 occurrences updated |
| docs/ROADMAP.md | Yes | Updated |
| Release notes (v0.4.0, v0.6.0, v0.7.0) | Yes | All updated |

### Naming Pattern Consistency (MCP Tools)

The rename from `GetSchedule` to `ScheduleStatus` improves consistency with `TaskStatus` and `LoopStatus`:

| Domain | "Get info" tool | Pattern |
|--------|----------------|---------|
| Task | `TaskStatus` | `{Domain}Status` |
| Schedule | `ScheduleStatus` (was `GetSchedule`) | `{Domain}Status` |
| Loop | `LoopStatus` | `{Domain}Status` |

This is a clear improvement. The old `GetSchedule` was the only tool using the `Get{Domain}` pattern, while `TaskStatus` and `LoopStatus` both used `{Domain}Status`. The rename aligns all three.

### CLI Subcommand Consistency

The rename from `get` to `status` aligns with the top-level task command:

| Domain | "Get info" subcommand |
|--------|-----------------------|
| Task | `beat status <id>` |
| Schedule | `beat schedule status <id>` (was `get`) |
| Loop | `beat loop status <id>` (was `get`) |

Consistent across all three domains now.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | - | 0 | 0 |

**Consistency Score**: 9/10
**Recommendation**: CHANGES_REQUESTED

The PR is a thorough and well-executed mechanical rename across 16 files. The three renames (`--direction` to `--minimize`/`--maximize`, `--continue-context` to `--checkpoint`, and `get` to `status`) are applied consistently across source code, tests, and documentation with one exception: README.md line 81 still references `GetSchedule` in the MCP tools table. Once that single missed reference is fixed, this is a clean APPROVED.
