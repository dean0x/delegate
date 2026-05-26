# Regression Review Report

**Branch**: feat/181-channel-domain-persistence -> main
**Date**: 2026-05-24
**Commits**: 837d32b, 676a57a (2 commits)

## Issues in Your Changes (BLOCKING)

### MEDIUM

**test:implementations does not exclude channel-repository.test.ts** - `package.json:31`
**Confidence**: 95%
- Problem: The `test:repositories` script explicitly lists `channel-repository.test.ts`. However, the `test:implementations` script runs all files under `tests/unit/implementations/` and only excludes the other repository test files (dependency, task, database, checkpoint, output, worker, loop). Since `channel-repository.test.ts` is not excluded, it runs in both `test:repositories` and `test:implementations` during `test:all`. This doubles execution time for those 40 tests and breaks the established partitioning pattern where each test file runs in exactly one group.
- Fix: Add `--exclude='**/channel-repository.test.ts'` to the `test:implementations` script in `package.json`:
  ```json
  "test:implementations": "NODE_OPTIONS='--max-old-space-size=2048' vitest run tests/unit/implementations --exclude='**/dependency-repository.test.ts' --exclude='**/task-repository.test.ts' --exclude='**/database.test.ts' --exclude='**/checkpoint-repository.test.ts' --exclude='**/output-repository.test.ts' --exclude='**/worker-repository.test.ts' --exclude='**/loop-repository.test.ts' --exclude='**/channel-repository.test.ts' --exclude='**/tmux/**' --no-file-parallelism",
  ```

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **createChannel throws instead of returning Result** - `src/core/domain.ts:1095` (Confidence: 65%) -- The `createChannel` and member-name validation paths use `throw new AutobeatError(...)`. This is the only `throw` in `domain.ts`. All other factory functions (`createTask`, `createSchedule`, `createLoop`, `createPipeline`) return plain objects without throwing. The project's CLAUDE.md states "Always use Result types - Never throw errors in business logic." However, this is new code with no callers yet, so no regression per se -- flagging as a pattern deviation for awareness.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Regression Score**: 9/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Conditions
1. Add `--exclude='**/channel-repository.test.ts'` to `test:implementations` script to maintain the test partitioning invariant.

### What Was Verified (No Issues Found)
- **No removed exports**: All existing exports in `domain.ts`, `events.ts`, `interfaces.ts` are preserved. Only additive changes.
- **No changed signatures**: No existing function signatures were modified. The `AutobeatEvent` union was extended (not narrowed) with 6 new channel event types -- safe for all consumers since the event bus uses opt-in subscription (no exhaustive switch).
- **No broken consumers**: The import change in `domain.ts` (adding `ErrorCode` to the existing `AutobeatError` import) is purely additive.
- **Migration v31 non-destructive**: Creates new tables (`channels`, `channel_members`) without modifying any existing tables. Existing migrations and data paths are unaffected.
- **Bootstrap registration is additive**: The new `channelRepository` singleton is registered after existing repositories, does not alter any existing registration, and is not consumed by any existing component.
- **Commit messages match implementation**: Both commits accurately describe what was added. No partial implementations or missing claimed features.
- **Test suites pass**: `test:repositories` (276 tests) and `test:core` (378 tests) both pass with zero failures.
- **No new TODOs**: No incomplete work markers introduced.
- **avoids PF-002**: New tables and types have zero users -- clean forward approach is correct, no migration paths needed.
