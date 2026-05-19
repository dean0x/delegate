# Regression Review Report

**Branch**: fix/orchestrator-loop-termination -> main
**Date**: 2026-05-14

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Inconsistent state file guidance between snippet builder and systemPrompt** - `src/services/orchestrator-prompt.ts:124-132` vs `src/services/orchestrator-prompt.ts:227-234`
**Confidence**: 82%
- Problem: `buildStateManagementInstructions()` (used by `scaffoldCustomOrchestrator`) now says "Optionally update the state file" and "The system evaluates your output to determine completion" (lines 126-128), but the `buildOrchestratorPrompt()` resilience section for with-state-file paths still says "Always write the state file BEFORE exiting -- the system reads it to determine if the goal is complete" (lines 231-232). Users who scaffold a custom orchestrator via `InitCustomOrchestrator` get the snippet-builder text saying writing is optional, while the full prompt builder still mandates it. This is a behavioral drift between two code paths that historically stayed in sync. The existing drift-detection tests (orchestrator-prompt-snippets.test.ts) were weakened in this PR (status: "complete" and status: "failed" markers removed from the shared-marker checks at lines 200-206), so the test suite no longer catches this divergence.
- Fix: Decide on one semantic: either the state file write is optional (agent evaluates output) or mandatory (system reads it). If optional for both paths, update the `resilienceSection` in `buildOrchestratorPrompt()` to match the snippet builder. If mandatory only for scaffold users, document the distinction explicitly.

**Compensation tests now vacuously pass for state file cleanup assertions** - `tests/integration/orchestration-lifecycle.test.ts:207` and `tests/integration/orchestration-lifecycle.test.ts:239`
**Confidence**: 85%
- Problem: Two integration tests titled "state file removed" (lines 181 and 213) assert `expect(existsSync(failedOrch.stateFilePath)).toBe(false)`. Since `stateFilePath` is now `''` (empty string), `existsSync('')` always returns `false` regardless of what happens -- the assertion passes vacuously. The test description says "orch row marked FAILED, state file removed" but no state file is created or removed anymore. The compensation `cleanupFiles()` call was also removed from `createOrchestration()`, so the cleanup path is now dead code for this flow. These tests no longer validate compensation behavior -- they validate nothing meaningful about file cleanup.
- Fix: Update test descriptions to reflect "no state file for agent eval mode". Replace the vacuous `existsSync` assertion with a meaningful assertion, for example verifying that `stateFilePath` is empty (`expect(failedOrch.stateFilePath).toBe('')`). Alternatively, add a test for the interactive orchestration path (which still uses state files) to ensure compensation cleanup still works there.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Dead code: `setupStateFiles` is no longer called from `createOrchestration` but remains in the class** - `src/services/orchestration-manager.ts:99-146`
**Confidence**: 80%
- Problem: The `setupStateFiles()` private method (lines 99-146) is now only called by `createInteractiveOrchestration()` (line 380). The `createOrchestration()` method no longer calls it -- it passes `''` as stateFilePath directly. The method's JSDoc (lines 96-98) still describes it as used by the orchestration creation path ("Set up orchestration state directory, state file, and optionally the exit condition script"). The `withExitScript: boolean` parameter and the `writeExitConditionScript` call inside are unused by the sole remaining caller (interactive mode passes `false`). This dead parameter path increases maintenance burden without serving any consumer.
- Fix: Either (a) remove the `withExitScript` parameter and the exit-condition-script code path from `setupStateFiles` since its only consumer passes `false`, or (b) add a comment clarifying it is retained for `scaffoldCustomOrchestrator` compatibility. The scaffold lives in `orchestrator-scaffold.ts` and manages its own file setup, so option (a) is likely correct. *avoids PF-001* -- surfacing this rather than deferring to a future PR.

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Scaffold generates unused exitConditionScript** - `src/core/orchestrator-scaffold.ts:114-115` (Confidence: 65%) -- The scaffold still creates a state file and exit condition script (lines 114-115), returns them in the result object, but the `suggestedCommand` (line 118) no longer references `--until` with the exit condition. Users who follow the `suggestedCommand` will never use these artifacts. The scaffold test at line 123-136 explicitly tests this dual behavior, suggesting it is intentional (the artifacts are for users who want to customize further). However, users who copy-paste the `suggestedCommand` verbatim will have orphan files on disk.

- **Binary search truncation computes `Buffer.byteLength` of `lines.slice(0, mid).join('\n')` on each iteration** - `src/services/handlers/loop-handler.ts:1711` (Confidence: 70%) -- While the iteration count is O(log n), each `slice + join` is O(mid) and `Buffer.byteLength` is also O(mid). The total work is O(n log n) as documented, but a prefix-sum approach would reduce to O(n). The 4KB cap makes this academic for real-world inputs, but the commit message specifically highlights this as a performance improvement -- worth noting for precision.

- **`checkConvergence` queries iterations on every `recordAndContinue` call** - `src/services/handlers/loop-handler.ts:1211-1213` (Confidence: 62%) -- `checkConvergence()` runs a DB query (`getIterations`) on every non-terminal iteration result, even for non-git loops with no OPTIMIZE strategy where neither convergence signal can fire. The early-return at line 1216 (`completed.length < CONVERGENCE_MIN_ITERATIONS`) mitigates the cost for early iterations, but for long-running loops this adds a DB query per iteration that will always return false.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Regression Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The core behavioral change (switching from shell exit condition to agent eval mode) is well-implemented and the new convergence detection and git context injection features have thorough test coverage. No exports were removed, no files were deleted, and the return types are backward-compatible. The two BLOCKING MEDIUM issues are about test fidelity (compensation tests now vacuously pass) and prompt instruction drift between two code paths that historically stayed in sync. Neither introduces a runtime bug, but both reduce the safety net that catches future regressions -- which is the core concern for a regression review.
