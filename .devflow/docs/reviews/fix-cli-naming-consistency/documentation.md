# Documentation Review Report

**Branch**: fix/cli-naming-consistency -> main
**Date**: 2026-03-24
**PR**: #117

## Scope

This PR performs 3 mechanical CLI naming renames:
1. `--direction minimize|maximize` replaced by `--minimize` / `--maximize` boolean flags
2. `--continue-context` replaced by `--checkpoint`
3. `get` subcommand replaced by `status` (both CLI and MCP: `GetSchedule` -> `ScheduleStatus`)

16 files changed. Documentation files reviewed: CHANGELOG.md, CLAUDE.md, README.md, docs/FEATURES.md, docs/ROADMAP.md, docs/releases/RELEASE_NOTES_v0.4.0.md, docs/releases/RELEASE_NOTES_v0.6.0.md, docs/releases/RELEASE_NOTES_v0.7.0.md, src/cli/commands/help.ts.

---

## Issues in Your Changes (BLOCKING)

### HIGH

**Missed rename: `GetSchedule` in README.md MCP tools table** - `README.md:81`
**Confidence**: 98%
- Problem: The MCP tools table in README.md still references `GetSchedule` at line 81. The CLI commands table lower in README (line 108) was correctly updated to `schedule status`, and all other documentation files were updated to `ScheduleStatus`, but this single MCP tools table entry was missed.
- Impact: The README is the primary user-facing document. A user looking at the MCP tools table will see `GetSchedule` and try to use it, but the tool has been renamed to `ScheduleStatus`. This directly contradicts the code.
- Fix: Change line 81 from:
  ```
  | **GetSchedule** | Get schedule details and execution history | `GetSchedule({ scheduleId })` |
  ```
  to:
  ```
  | **ScheduleStatus** | Get schedule details and execution history | `ScheduleStatus({ scheduleId })` |
  ```

---

## Issues in Code You Touched (Should Fix)

### MEDIUM

**CLAUDE.md MCP tools list adds `PauseLoop`, `ResumeLoop`, `ScheduleLoop` but README MCP tools table omits them** - `CLAUDE.md:141`, `README.md:70-89`
**Confidence**: 82%
- Problem: This PR updated CLAUDE.md to add `PauseLoop`, `ResumeLoop`, `ScheduleLoop` to the MCP tools list (these tools exist in the codebase since v0.8.0 but were never listed). However, the README MCP tools table -- which was also touched in this PR -- still omits these three tools. This creates a documentation inconsistency between CLAUDE.md and README.md, both of which were modified in this PR.
- Impact: The two canonical tool lists now disagree: CLAUDE.md lists 19 tools, README.md lists 16.
- Fix: Add the three missing tools to the README MCP tools table after the `CancelLoop` row:
  ```
  | **PauseLoop** | Pause a running loop (resumable) | `PauseLoop({ loopId })` |
  | **ResumeLoop** | Resume a paused loop | `ResumeLoop({ loopId })` |
  | **ScheduleLoop** | Schedule a recurring loop | `ScheduleLoop({ loopId, cronExpression: "..." })` |
  ```

---

## Pre-existing Issues (Not Blocking)

No pre-existing documentation issues at CRITICAL severity were found in the reviewed files.

---

## Suggestions (Lower Confidence)

- **README MCP tools table missing `RetryTask` tool** - `README.md:70-89` (Confidence: 65%) -- The CLI commands table lists `beat retry` but the MCP tools table has `RetryTask` present. Meanwhile the CLAUDE.md also omits `RetryTask` from its list. Possibly intentional if `RetryTask` was removed, but worth verifying.

---

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | - | 1 | - | - |
| Should Fix | - | - | 1 | - |
| Pre-existing | - | - | - | - |

**Documentation Score**: 8/10
**Recommendation**: CHANGES_REQUESTED

### Rationale

This is a well-executed mechanical rename across documentation. All 8 documentation files were updated for the 3 naming changes, and the help.ts output was brought into alignment with the parser. The CHANGELOG entries, release notes, and feature docs are all internally consistent.

The single blocking issue is a missed rename of `GetSchedule` -> `ScheduleStatus` in the README MCP tools table (line 81). This is the most visible documentation surface for users and must be fixed. The should-fix issue (CLAUDE.md vs README tool list parity for 3 new loop tools) is a consistency gap introduced by this PR expanding the CLAUDE.md list without also expanding the README table.

Both issues are trivial one-line fixes.
