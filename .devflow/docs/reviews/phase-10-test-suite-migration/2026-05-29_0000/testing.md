# Testing Review Report

**Branch**: main (284f5a0 vs 5d169d8)
**Date**: 2026-05-29

## Issues in Your Changes (BLOCKING)

### HIGH

**test:channels duplicates all 9 files already covered by existing grouped scripts — test:all runs each file twice** - `package.json:20,34`
**Confidence**: 95%
- Problem: The new `test:channels` script (line 34) lists 9 test files. All 9 already appear in existing grouped scripts that `test:all` chains together:
  - `channel-manager.test.ts`, `channel-router.test.ts` are in `test:services` (line 22)
  - `channel-handler.test.ts`, `channel-message-persistence-handler.test.ts` are in `test:handlers` (line 27)
  - `channel-repository.test.ts` is in `test:repositories` (line 29)
  - `channel.test.ts`, `msg.test.ts` are in `test:cli` (line 37)
  - `channel-detail.test.tsx`, `use-channel-pane-preview.test.ts` are in `test:dashboard` (glob on `tests/unit/cli/dashboard`, line 28)
  Since `test:all` (line 20) chains `test:handlers && ... && test:services && ... && test:cli && ... && test:dashboard && ... && test:channels`, every channel test file runs twice in CI. This doubles CI wall-clock time for those files and wastes memory budget.
- Fix: Either (a) remove channel test files from their original scripts (`test:services`, `test:handlers`, `test:repositories`, `test:cli`, `test:dashboard`) so they only live in `test:channels`, or (b) add `--exclude` patterns for channel files in the original scripts (like `test:implementations` already does for `channel-repository.test.ts`). Option (a) is cleaner — consolidate all channel tests into `test:channels` and strip them from the 5 other scripts.

### MEDIUM

**Shared mock declares `name` as optional (`name?: string`) but real `TmuxSpawnCoreConfig` requires it (`name: string`)** - `tests/fixtures/mocks.ts:151`
**Confidence**: 85%
- Problem: The mock's `spawn` implementation types the config parameter as `{ taskId: string; sessionsDir: string; name?: string }`. In the real `TmuxSpawnCoreConfig` interface (`src/core/tmux-types.ts:80`), `name` is required: `readonly name: string`. The mock accepts calls without `name` and falls back to `beat-${config.taskId}`, silently masking any caller that forgets to pass `name`. This weakens the contract fidelity that the migration was specifically intended to improve.
- Fix: Change the type annotation in the mock to make `name` required, matching the real interface:
  ```typescript
  (config: { taskId: string; sessionsDir: string; name: string }, callbacks: SpawnCallbacks) => {
    const sessionName = config.name;
    // ...
  }
  ```
  Alternatively, type the mock parameter as `TmuxSpawnCoreConfig` directly (it already imports the type) to keep the mock signature in sync with the port contract. Non-channel callers that don't pass `name` would need to be updated (or exposed as latent bugs).

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Dead code removal may have stranded imports in downstream test files** - `tests/fixtures/test-data.ts`, `tests/fixtures/test-helpers.ts` (Confidence: 65%) — `createMockWorkerPool`, `createMockResourceMonitor` (from test-data.ts), `createMockChildProcess`, `createMockStream` (from test-helpers.ts) were deleted. The grep shows `createMockResourceMonitor` still exists in `tests/fixtures/mocks.ts` (different function, same name). Verify no test file imports the deleted functions from `test-data.ts` or `test-helpers.ts` — the build would catch this but it was not evident from the diff alone.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Testing Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The test:channels grouping script is a good organizational addition, but the double-execution of all 9 channel test files in `test:all` is a concrete problem that increases CI time and memory pressure. The mock fidelity mismatch (`name` optional vs required) partially undermines the stated goal of the migration (shared mock fidelity fix for `config.name` sessionName derivation). Both issues are straightforward to fix.
