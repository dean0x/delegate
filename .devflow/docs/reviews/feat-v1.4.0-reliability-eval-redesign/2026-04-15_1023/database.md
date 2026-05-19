# Database Review Report

**Branch**: feat/v1.4.0-reliability-eval-redesign -> main
**Base SHA**: 33abbb78c6c566480ef474d5b98d20087051a929
**PR**: #136
**Date**: 2026-04-15 10:23

## Scope

Incremental review against the prior review baseline (commit `33abbb7`). Focuses on database
mutations introduced by the eval-redesign / reliability work in this slice:

- `src/implementations/database.ts` (migrations v21, v22 added)
- `src/implementations/loop-repository.ts` (Zod schema tightening for eval columns + `jsonSchema` round-trip)
- `src/services/handlers/loop-handler.ts` (transactional `handleStopDecision`, `finishLoop` split, `refetchAfterAgentEval`)

Verifies:
1. Transactions correctly scoped (no async I/O inside `runInTransaction` callbacks).
2. No synchronous file/network I/O smuggled in from new helpers.
3. No new TOCTOU races in stop-decision persistence.
4. No index lookups degraded by the v22 table recreation.
5. CHECK constraints sound and backward-compatible.

## Issues in Your Changes (BLOCKING)

### CRITICAL

_None._

### HIGH

_None._

### MEDIUM

_None._

### LOW

_None._

## Issues in Code You Touched (Should Fix)

_None — the changes are tight._

Notable strengths worth recording:

- Migration v22's CHECK on `eval_type` (`'feedforward' | 'judge' | 'schema'`) and `judge_agent`
  (`'claude' | 'codex' | 'gemini'`) correctly mirrors the application-layer Zod enum tightening
  in `loop-repository.ts`, providing real defense-in-depth at the storage boundary.
- The `INSERT INTO loops_new (col-list) SELECT col-list FROM loops` pattern uses explicit column
  lists in both clauses with matching order — eliminates the silent column-shift class of bug
  that bites unqualified `SELECT *` migrations.
- All three loops indexes (`idx_loops_status`, `idx_loops_schedule_id`, `idx_loops_updated_at`)
  are recreated after the table rename. The v20 dashboard polling index survives migration v22.
- Every `runInTransaction` call site in `loop-handler.ts` (lines 269, 562, 695, 769, 886, 1261,
  1303, 1606, 1841) uses a synchronous arrow function. No `await`, no Promise return, no
  filesystem or network I/O inside the transaction body. `handleIterationGitOutcome` is invoked
  *before* the `runInTransaction` call, so git work cannot stall a SQLite write lock.
- `handleStopDecision` correctly atomic: iteration update + loop status both committed in a
  single SQLite transaction. Failure path falls back to `completeLoop(... FAILED, ...)` which
  performs its own update — no partial commit possible.
- The `finishLoop` / `completeLoop` split correctly eliminates the prior double-write of the
  loop status row when a transaction had already set the terminal status. JSDoc explicitly
  documents the contract.
- `refetchAfterAgentEval` preserves the stale-state guard semantics (loop or iteration
  transitioned during slow agent eval). The extracted helper does not introduce a new TOCTOU
  window — the original code already had a window between re-fetch and write, and the helper
  does not lengthen it.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`eval_mode` lacks DB-level CHECK constraint** — `src/implementations/database.ts:751,879`
**Confidence**: 90%
- Problem: `eval_mode TEXT NOT NULL DEFAULT 'shell'` was added in v15 and carried into the v22
  recreation without a CHECK constraint, even though v22 explicitly added CHECKs for the sibling
  eval columns (`eval_type`, `judge_agent`). The Zod schema validates `eval_mode` at the
  application boundary via `z.nativeEnum(EvalMode)`, but a misbehaving writer (e.g., a future
  migration backfill or external script) could persist invalid values.
- Impact: Inconsistent defense-in-depth posture. Application reads would throw a Zod parse error
  rather than fail at write time, making root-cause attribution harder.
- Note: Pre-existing across migrations v15 → v22; the v22 recreation was a natural opportunity
  to add the CHECK but did not. Not blocking — fixable in a future migration without urgency.

### LOW

**Stop-decision write does not re-check loop status inside transaction** —
`src/services/handlers/loop-handler.ts:1253-1281` (also lines 858-913)
**Confidence**: 70%
- Problem: `handleStopDecision` writes `status: LoopStatus.COMPLETED` to the loop row using a
  potentially stale `loop` value. The early guard at line 224 filters non-RUNNING/PAUSED loops,
  and agent-eval mode re-fetches via `refetchAfterAgentEval`. For shell-eval mode (the common
  case), there's no re-fetch between the entry guard and the transactional write. A concurrent
  cancel/pause emitting between guard and `runInTransaction` would be silently overwritten by
  the COMPLETED status.
- Impact: Theoretical only. Shell eval completes in milliseconds and the EventBus is single-
  threaded per Node.js event loop. The race window is essentially closed in practice; flagged
  for transparency rather than action.
- Note: Symmetric to existing patterns (`handleRetryResult`, `handleOptimizeResult`) — not a
  regression. Categorized as pre-existing because the same staleness window exists in the
  pre-refactor code.

## Suggestions (Lower Confidence)

_None within the database focus area._

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 1 | 1 |

**Database Score**: 9/10
**Recommendation**: APPROVED

The incremental database changes are well-engineered. Migration v22 is correctly authored
(explicit column lists, all indexes recreated, CHECK constraints aligned with Zod enums).
The transactional refactor in `loop-handler.ts` correctly atomizes stop-decision persistence
without introducing new TOCTOU exposure or smuggling async I/O into transaction bodies. The
`finishLoop` / `completeLoop` separation removes a documented double-write. The single
pre-existing observation (no CHECK on `eval_mode`) is non-blocking and best addressed in a
future cleanup migration.
