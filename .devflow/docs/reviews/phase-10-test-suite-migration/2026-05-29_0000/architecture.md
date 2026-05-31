# Architecture Review Report

**Branch**: main (284f5a0 vs 5d169d8)
**Date**: 2026-05-29
**Focus**: Phase 10 test suite migration -- dead code removal, mock fidelity fix, deduplication, test:channels script

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Test file duplication across test groups** - `package.json:20,22,27,29,34,37`
**Confidence**: 90%
- Problem: The new `test:channels` group (line 34) aggregates channel-related test files that already exist in other groups (`test:services`, `test:handlers`, `test:repositories`, `test:cli`). When `test:all` (line 20) runs both `test:services` and `test:channels`, it executes `channel-manager.test.ts` and `channel-router.test.ts` twice. The full overlap is 7 out of 9 files:
  - `channel-manager.test.ts` -- in `test:services` AND `test:channels`
  - `channel-router.test.ts` -- in `test:services` AND `test:channels`
  - `channel-handler.test.ts` -- in `test:handlers` AND `test:channels`
  - `channel-message-persistence-handler.test.ts` -- in `test:handlers` AND `test:channels`
  - `channel-repository.test.ts` -- in `test:repositories` AND `test:channels`
  - `channel.test.ts` -- in `test:cli` AND `test:channels`
  - `msg.test.ts` -- in `test:cli` AND `test:channels`
- Impact: `npm run test:all` runs 7 test files twice, wasting CI time and memory. This also creates a maintenance burden -- adding a new channel test file requires updating two groups. The project's memory constraints (documented in CLAUDE.md) make redundant test execution particularly costly.
- Fix: Choose one of two strategies:
  - (A) **Additive-only**: `test:channels` keeps only the 2 files not already in another group (`channel-detail.test.tsx`, `use-channel-pane-preview.test.ts`) and serves as a convenience alias. The other 7 stay in their layer-based homes.
  - (B) **Extract**: Remove all channel test files from `test:services`, `test:handlers`, `test:repositories`, and `test:cli`, and have `test:channels` be the sole owner. This is cleaner but changes the semantics of existing groups (layer-based to feature-excluding-channels).
  - Strategy (A) is recommended -- it preserves the existing layer-based group semantics while `test:channels` serves as a cross-cutting convenience group. The two dashboard test files should be added to `test:dashboard` as well, if not already there.

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none -- the changes are cleanly scoped to test infrastructure)

## Suggestions (Lower Confidence)

- **Mock type fidelity gap in test-data.ts `createMockEventBus`** - `tests/fixtures/test-data.ts:57` (Confidence: 65%) -- The `createMockEventBus` in test-data.ts has a different interface shape (missing `off`, has `removeAllListeners`) than the canonical `createMockEventBus` in mocks.ts. This is a pre-existing duplication, but the Phase 10 cleanup was an opportunity to consolidate. May be worth tracking.

- **`test:channels` not added to Pre-Release Validation in CLAUDE.md section 4** - `CLAUDE.md:143` (Confidence: 70%) -- While `test:channels` was added to the validation command chain, the `test` safeguard warning message (line 19 of package.json) lists `test:channels` but the CLAUDE.md "Pre-Release Validation" section already has it (line 143). However, the `test` warning message no longer lists `test:scheduling`, `test:checkpoints`, `test:error-scenarios`, `test:orchestration`, or `test:translation` -- these are in `test:all` but not in the warning help text. The warning is already incomplete as a reference, so this is informational only.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | - | 0 | 0 | 0 |
| Pre-existing | - | - | 0 | 0 |

**Architecture Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The changes are architecturally sound. Dead code removal (`createMockChildProcess`, `createMockStream`, `createMockWorkerPool`, `createMockResourceMonitor` from test-data.ts) is verified clean -- zero remaining references. The shared `createMockTmuxConnector` now correctly respects `config.name` (falling back to `beat-${config.taskId}`), aligning mock fidelity with the real `TmuxSpawnCoreConfig` interface (applies ADR-001 -- channel names map to tmux session names). The deduplication of the inline mock in `channel-manager.test.ts` into the shared fixture is a proper DRY improvement that reduces maintenance surface.

The one condition is the test file duplication in `test:channels` vs existing groups (7/9 files appear in two groups), which wastes CI resources and creates a dual-maintenance burden. This should be resolved before the next release.
