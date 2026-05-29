# Regression Review Report

**Branch**: main (284f5a0 vs 5d169d8)
**Date**: 2026-05-29
**Focus**: Phase 10 test suite migration — dead test infrastructure removal, shared mock updates, channel-manager test consolidation

## Issues in Your Changes (BLOCKING)

### HIGH

**test:channels script causes 9 test files to run twice in test:all** - `package.json:20,34`
**Confidence**: 90%
- Problem: The new `test:channels` script aggregates channel-related test files that already exist in other test groups (`test:services`, `test:handlers`, `test:repositories`, `test:cli`, `test:dashboard`). When `test:all` runs all groups sequentially, 9 test files execute twice:
  1. `channel-manager.test.ts` (test:services + test:channels)
  2. `channel-router.test.ts` (test:services + test:channels)
  3. `channel-handler.test.ts` (test:handlers + test:channels)
  4. `channel-message-persistence-handler.test.ts` (test:handlers + test:channels)
  5. `channel-repository.test.ts` (test:repositories + test:channels)
  6. `channel.test.ts` (test:cli + test:channels)
  7. `msg.test.ts` (test:cli + test:channels)
  8. `channel-detail.test.tsx` (test:dashboard + test:channels)
  9. `use-channel-pane-preview.test.ts` (test:dashboard + test:channels)
- Impact: Given the documented memory constraints ("Vitest workers accumulate memory across test files"), running 9 extra test files in `test:all` increases peak memory usage and extends CI runtime. CLAUDE.md documents that the full suite already "exhausts system resources even with low limits." This duplication worsens that problem.
- Fix: Either (a) remove channel test files from their original groups and consolidate into `test:channels` only, or (b) add `--exclude` patterns to the original groups (similar to how `test:implementations` excludes files in `test:repositories`), or (c) remove duplicated files from `test:channels` and keep it as an alias that only adds the files not already in other groups. Option (a) is cleanest:
  ```json
  "test:services": "... (remove channel-manager.test.ts and channel-router.test.ts) ...",
  "test:handlers": "... (remove channel-handler.test.ts and channel-message-persistence-handler.test.ts) ...",
  "test:repositories": "... (remove channel-repository.test.ts) ...",
  "test:cli": "... (remove channel.test.ts and msg.test.ts) ...",
  "test:dashboard": "... add explicit file list or --exclude for channel dashboard tests ..."
  ```

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Mock spawn signature uses optional `name?` while real interface requires `name`** - `tests/fixtures/mocks.ts:151` (Confidence: 65%) — The mock's `config` parameter types `name` as optional (`name?: string`) while the real `TmuxSpawnCoreConfig` interface requires it. This is defensive (fallback to `beat-${config.taskId}`) and matches how mocks typically work, but a strict signature would catch callers that forget to pass `name`. Low risk since all real callers are type-checked against `TmuxSpawnCoreConfig`.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | - | 0 | 0 |

**Regression Score**: 8/10
**Recommendation**: CHANGES_REQUESTED

### Rationale

The core migration work is sound:
- **Removed exports verified safe**: `createMockChildProcess`, `createMockStream`, `createMockWorkerPool`, `createMockResourceMonitor` have zero remaining consumers across the codebase. No regression from removal.
- **Shared mock spawn() change is backward-compatible**: The change from `beat-${config.taskId}` to `config.name ?? beat-${config.taskId}` preserves existing behavior because all current callers (worker pool tests) pass `config.name` as `beat-${taskId}`. The `config.name` value matches what was previously hardcoded.
- **Channel-manager test migration is correct**: The inline `createMockTmuxConnector` was properly replaced with the shared version from `mocks.ts`. The `_pastedContent` inspection was correctly replaced with `vi.mocked(tmuxConnector.pasteContent).mock.calls`. The `MockTmuxHandle` type was replaced with the proper `TmuxHandle` import.
- **CLAUDE.md and package.json documentation updated consistently**: The `test:channels` script is listed in the quick start, the pre-release validation, and the `test:all` chain.

The single blocking issue is the 9-file duplication in `test:all` which regresses CI memory usage. This is a mechanical fix.

### Decision Context

- `applies ADR-001` — Channel naming validation is not affected by this test migration; the mock changes preserve tmux session name derivation patterns.
- `avoids PF-004` — The rollback test (`rolls back spawned sessions when a later member spawn fails`) correctly uses the shared mock with proper `TmuxHandle` typing and `TaskId()` branding, maintaining the three-layer rollback pattern.
