# Resolution Summary

**Branch**: feat/180-phase-5-bootstrap-usage-parsing-cleanup -> main
**Date**: 2026-05-23
**Review**: .devflow/docs/reviews/feat-180-phase-5-bootstrap-usage-parsing-cleanup/2026-05-23_1303
**Command**: /resolve

## Decisions Citations

- avoids PF-001 — batch-1 (B1-timer-leak, B1-non-atomic-db, B1-reuse-length, B1-suggestion-taskidref), batch-2 (B2-b14-b15-tests, B2-suggestion-stale-workerid, B2-suggestion-sendkeys-counting), batch-3 (B3-residual-teardown, B3-missing-error-handler, B3-suggestion-destroy-repeat), batch-4 (all 4 false positives justified)
- avoids PF-002 — batch-4 (B4-suggestion-pid-coverage: removed method had zero consumers, no migration path needed)

## Statistics
| Metric | Value |
|--------|-------|
| Total Issues | 18 |
| Fixed | 10 |
| False Positive | 6 |
| Deferred | 1 |
| Blocked | 0 |
| Pre-existing (not actionable) | 1 |

## Fixed Issues
| Issue | File:Line | Commit |
|-------|-----------|--------|
| B1-timer-leak: Clear existing timers before restarting in reuseSession else branch | event-driven-worker-pool.ts:503-520 | 621a429 |
| B1-non-atomic-db: Add updateTaskId atomic transaction to WorkerRepository | event-driven-worker-pool.ts:469-492, worker-repository.ts, interfaces.ts | 621a429 |
| B1-reuse-length: Extract reRegisterWorkerForReuse and remapExistingWorkerForReuse | event-driven-worker-pool.ts:366-528 | 621a429 |
| B1-suggestion-taskidref: Add clarifying comment on shared mutable TaskIdRef | event-driven-worker-pool.ts:122-127 | 621a429 |
| B3-residual-teardown: Extract failWithOrchestration helper for post-create phase | orchestrate-interactive.ts:452-456 | c4e6bf6 |
| B3-missing-error-handler: Add error handler on tmux attach-session spawn | orchestrate-interactive.ts:335 | c4e6bf6 |
| B3-suggestion-destroy-repeat: Guard destroy to fire exactly once on sigintCount===2 | orchestrate-interactive.ts:312-316 | c4e6bf6 |
| B2-b14-b15-tests: Add B1-4 and B1-5 dedicated regression tests | event-driven-worker-pool.test.ts | bddb348 |
| B2-suggestion-stale-workerid: Update entry.workerId after re-registration, fix B1-2 cleanup | event-driven-worker-pool.ts:122,506 | bddb348 |
| B2-suggestion-sendkeys-counting: Refactor B1-2 test to use mockReturnValueOnce chain | event-driven-worker-pool.test.ts:1229 | bddb348 |

## False Positives
| Issue | File:Line | Reasoning |
|-------|-----------|-----------|
| B2-suggestion-null-sentinel | event-driven-worker-pool.ts:371 | Result<Worker \| null> sentinel is deliberate design, documented in JSDoc, consistently handled at call sites. Discriminated union adds no safety at 68% confidence. |
| B2-suggestion-simulate-fields | event-driven-worker-pool.test.ts:383-388 | AC-7 tests already include sequence and timestamp fields — issue premise doesn't match current code. |
| B4-no-attach-tests | orchestrate-interactive.ts:300-382 | Calls process.exit on all paths — unit testing structurally impractical. DECISION comment at line 298 documents this. Established CLI pattern. |
| B4-suggestion-attach-length | orchestrate-interactive.ts:300-382 | 65% confidence style suggestion. Well-structured with labeled sections. No concrete defect. |
| B4-suggestion-pid-coverage | interactive-orchestrator.test.ts:deleted 589-707 | Removed method had zero consumers. Removing tests for removed API is correct. ESRCH and session_name paths exercise live cancel edge cases. |
| B4-suggestion-never-narrowing | orchestrate-interactive.ts:300,480 | Reviewer concluded "no action needed." Promise<never> is correct. Unreachable catch block is cosmetic. |

## Deferred to Tech Debt
| Issue | File:Line | Risk Factor |
|-------|-----------|-------------|
| B1-pre-existing-length | event-driven-worker-pool.ts (whole file, 1140+ lines) | Extracting PersistentSessionManager requires moving 5+ tightly coupled private fields across class boundary. Full architectural redesign, not a safe refactor. Pre-existing across cycles 1-3. |

## Blocked
(none)

## Pre-existing (Not Actionable)
| Issue | File:Line | Note |
|-------|-----------|------|
| B3-suggestion-failwith-sigs | orchestrate-interactive.ts:134,199 | Two failWith closures have different signatures due to different lifecycle phases and cleanup requirements. Scoped closures are contextually appropriate. |
