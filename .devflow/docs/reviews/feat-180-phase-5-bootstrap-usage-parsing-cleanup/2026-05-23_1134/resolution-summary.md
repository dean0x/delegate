# Resolution Summary

**Branch**: feat/180-phase-5-bootstrap-usage-parsing-cleanup -> main
**Date**: 2026-05-23
**Review**: .devflow/docs/reviews/feat-180-phase-5-bootstrap-usage-parsing-cleanup/2026-05-23_1134
**Command**: /resolve

## Decisions Citations

- avoids PF-001 — batch-1 (B1-1, B1-2, B1-3, B1-4, B1-5), batch-2 (B2-1, B2-4), batch-3 (B3-1, B3-2, B3-3, B3-4, B3-5), batch-4 (B4-1, B4-2), batch-5 (B5-1, B5-2, B5-3)
- avoids PF-002 — batch-5 (B5-2: zero external consumers, clean break)

## Statistics
| Metric | Value |
|--------|-------|
| Total Issues | 20 |
| Fixed | 17 |
| False Positive | 2 |
| Deferred | 0 |
| Blocked | 0 |
| Pre-existing (not actionable) | 3 |

## Fixed Issues
| Issue | File:Line | Commit |
|-------|-----------|--------|
| B1-1: Persistent session reuse dead code — workers cleaned up before next spawn | event-driven-worker-pool.ts:357-366 | 4f6fe92 |
| B1-2: Orphaned worker state after sendKeys failure | event-driven-worker-pool.ts:387-396 | 4f6fe92, 7206076 |
| B1-3: Flushing/heartbeat/timeout not restarted after reuse | event-driven-worker-pool.ts:310-406 | 4f6fe92 |
| B1-4: flushingInProgress stale entries on reuse | event-driven-worker-pool.ts:723-736 | 4f6fe92 |
| B1-5: Worker DB re-registration missing on reuse | event-driven-worker-pool.ts:355-397 | 4f6fe92 |
| B2-1: spawn() 4-level nesting → tryReuseSession extraction | event-driven-worker-pool.ts:234-261 | cc33784 |
| B2-4: WorkerState missing @internal JSDoc | event-driven-worker-pool.ts:79-82 | cc33784 |
| B3-1: Double `as unknown` cast → env added to TmuxSpawnCoreConfig | orchestrate-interactive.ts:219-225, tmux-types.ts:74 | ec5870a |
| B3-2: 6 positional params → SpawnPromptContext object | orchestrate-interactive.ts:181-188 | ec5870a |
| B3-3: Duplicated finalize+dispose+exit → failWith helper | orchestrate-interactive.ts:200-270 | ec5870a |
| B3-4: Misleading nullable return type → Promise<SpawnedSession> | orchestrate-interactive.ts:181-274 | ec5870a |
| B3-5: resolveContainerDeps repeated dispose+exit → failWith helper | orchestrate-interactive.ts:133-162 | ec5870a |
| B4-1: handleOrchestrateInteractive 176→108 lines → attachAndFinalize | orchestrate-interactive.ts:280-456 | ccdb0f1 |
| B4-2: Magic number 2000ms → EXIT_CALLBACK_DEADLINE_MS constant | orchestrate-interactive.ts:427 | ccdb0f1 |
| B5-1: JSDoc line length 108→80 chars | interfaces.ts:904 | 4f6fe92 |
| B5-2: Dead method updateInteractiveOrchestrationPid removed | interfaces.ts:893 | 4f6fe92 |
| B5-3: Clarifying comments on _simulateOutput test helper | worker-pool.test.ts:1003,1025,1053,1055 | 4f6fe92 |

## False Positives
| Issue | File:Line | Reasoning |
|-------|-----------|-----------|
| B2-2: Missing sendKeys failure test | worker-pool.test.ts:868 | Test already added in Batch 1 (B1-2 regression test). Full sendKeys failure path covered. |
| B2-3: Redundant Object spread `{...config, persistent: true}` | event-driven-worker-pool.ts:266 | Correct immutable pattern — produces new config without mutating the original. Follows project's immutability-by-default principle. |

## Deferred to Tech Debt
(none)

## Blocked
(none)

## Pre-existing (Not Actionable)
| Issue | File:Line | Note |
|-------|-----------|------|
| event-driven-worker-pool.ts is 1021 lines | event-driven-worker-pool.ts | Past 500-line threshold; persistent session logic could be extracted to PersistentSessionManager |
| No unit tests for buildSetupShim defense-in-depth | tmux-hooks.ts:170-174 | TmuxHooks module has zero test coverage |
| No unit tests for orchestrate-interactive extracted functions | orchestrate-interactive.ts:105-274 | CLI functions call process.exit, difficult to unit test |
