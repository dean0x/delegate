# Complexity Review Report

**Branch**: chore/tech-debt-sweep -> main
**Date**: 2026-03-20
**PR**: #109

## Issues in Your Changes (BLOCKING)

### CRITICAL

No critical issues found.

### HIGH

No high-severity issues found.

## Issues in Code You Touched (Should Fix)

No issues found.

## Pre-existing Issues (Not Blocking)

### HIGH

**`scheduleCreate` function length exceeds 50-line threshold (189 lines)** - `src/cli/commands/schedule.ts:61-249`
**Confidence**: 92%
- Problem: The `scheduleCreate` function spans 189 lines with a manually-written argument parser (lines 77-153) containing 15+ branches in a single for-loop. Cyclomatic complexity of the arg-parsing section alone is approximately 17 (each `if/else if` branch). The PR reduced some complexity here by replacing if/else Result blocks with `exitOnError` calls, but the function remains well above the 50-line critical threshold.
- Fix: Extract the argument-parsing loop into a dedicated function (e.g., `parseScheduleArgs`) that returns a typed options object. This would cut `scheduleCreate` roughly in half and isolate the parsing logic for independent testing.

## Suggestions (Lower Confidence)

- **Duplicate detail-formatting pattern** - `src/cli/commands/schedule.ts:199-207` and `src/cli/commands/schedule.ts:242-247` (Confidence: 65%) -- The pipeline-created and schedule-created success paths both build a `details` array with similar fields (type, status, cron, nextRunAt, agent). A shared `formatScheduleDetails` helper could consolidate this.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 1 | 0 | 0 |

**Complexity Score**: 8/10
**Recommendation**: APPROVED

## Notes

This PR is a net complexity reduction. Key improvements:

1. **exitOnError / exitOnNull helpers** (`src/cli/services.ts:15-37`): Two well-designed guard functions (cyclomatic complexity ~2 each) that replace 12+ repetitive if/else Result-handling blocks across 4 files. Each call site drops from 5 lines to 1.

2. **registerWorker extraction** (`src/implementations/event-driven-worker-pool.ts:211-248`): Clean extraction of worker registration logic from `spawn()`, reducing `spawn()`'s cyclomatic complexity by approximately 2 and improving readability of the main spawn flow.

3. **Net line reduction**: -47 lines across the codebase (143 added, 190 removed), with no new complexity introduced.

4. **Missing return types added**: `scheduleCancel`, `schedulePause`, `scheduleResume`, and `scheduleCreate` now have explicit `Promise<void>` return types, improving type clarity.

The only complexity concern is pre-existing: the `scheduleCreate` arg-parsing loop, which this PR did not introduce and cannot reasonably be expected to address in a tech-debt sweep commit.
