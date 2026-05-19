# Performance Review Report

**Branch**: feat/v1.4.0-reliability-eval-redesign -> main
**PR**: #136
**Base SHA**: 33abbb78c6c566480ef474d5b98d20087051a929
**Date**: 2026-04-15 10:23

## Executive Summary

The diff is a behavior-preserving refactor of the loop-handler / evaluator stack plus
hardening of the schedule executor PID file acquisition. Quantitative call-graph
comparison against the base SHA shows **no new DB fetches, no new sync I/O in hot paths,
no polling-interval changes, and one positive performance change** (eliminated a
redundant `loops` row UPDATE on the success path via the new `finishLoop()` helper).

The user-supplied hypothesis that `refetchAfterAgentEval` "adds 2 repo calls" is
**incorrect**: the same two repo calls (`findById` + `findIterationByTaskId`) existed
inline in `handleTaskTerminal` before the refactor — they were merely extracted into a
named helper. Per-iteration `findIterationByTaskId` call count is unchanged (3 calls
in agent-eval mode, same as before).

## Issues in Your Changes (BLOCKING)

### CRITICAL
None.

### HIGH
None.

### MEDIUM
None.

### LOW
None.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`startIdleCheckLoop` async setInterval callback can overlap on slow DB** — `src/cli/commands/schedule-executor.ts:195-202`
**Confidence**: 82%
- Problem: `setInterval(async () => { await checkActiveSchedules(...) }, intervalMs)` does not
  prevent overlapping invocations if `checkActiveSchedules` ever exceeds `intervalMs`. With
  `IDLE_CHECK_INTERVAL_MS = 5 * 60 * 1000` (5 min) and a single indexed query
  (`schedules.status` is indexed via `idx_schedules_status`, confirmed at
  `src/implementations/database.ts:468`), overlap is essentially impossible in practice,
  so this is informational. The pattern itself is fragile if the interval is ever shortened
  (e.g., a future tuning to 1 min combined with WAL contention) or if the query gains a JOIN.
- Note: This is a refactor of pre-existing code (the inline `setInterval` block previously
  at lines 156-175 had the same pattern). Promoted from "Pre-existing" to "Should Fix"
  because the helper extraction makes it the natural place to add overlap protection
  without re-touching the call site.
- Fix: Add a guard ref to the helper:
  ```typescript
  export function startIdleCheckLoop(...): NodeJS.Timeout {
    let inFlight = false;
    return setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const hasActiveResult = await checkActiveSchedules(scheduleRepo);
        if (hasActiveResult.ok && !hasActiveResult.value) {
          warn('Schedule executor: no active schedules — exiting');
          onIdle();
        }
      } finally {
        inFlight = false;
      }
    }, intervalMs);
  }
  ```

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`loadAgentConfig()` performs sync `readFileSync` + `JSON.parse` on every spawn** — `src/implementations/base-agent-adapter.ts:155`
**Confidence**: 88%
- Problem: Every worker spawn synchronously reads `~/.autobeat/config.json` and parses it
  (see `src/core/configuration.ts:177-178`). The PR's signature refactor (`SpawnOptions`)
  does not change this — but the inline comment at base-agent-adapter.ts:154 acknowledges it:
  *"Load agent config once — passed to resolveAuth, resolveBaseUrl, resolveModel to avoid
  redundant readFileSync + JSON.parse calls per spawn"*. The optimization was applied
  within a single `spawn()` call but not across calls.
- Impact: Spawning N workers performs N synchronous disk reads on the event loop. For
  scheduled pipelines or loops with high task throughput, this is non-trivial. Empty config
  files still pay the open + read + parse cost.
- Note: Not in scope for this PR — flagged as informational because the refactored
  `spawn()` signature would have been a natural place to also lift `loadAgentConfig()` to
  a memoized constructor field. Defer to a follow-up.
- Fix (separate PR): Cache the parsed `AgentConfig` per provider in the adapter constructor
  or memoize `loadAgentConfig()` at module level with optional `mtime`-based invalidation.

### LOW

**Pipeline `TaskDelegated` events emitted sequentially in a `for` loop** — `src/services/handlers/loop-handler.ts:811-825`
**Confidence**: 76%
- Problem: `for (let i = 0; i < tasks.length; i++) { await this.eventBus.emit('TaskDelegated', { task: tasks[i] }); }`
  serializes N event emissions when they could be parallelized via `Promise.all`. With
  pipeline lengths typically ≤ 5 steps, this is a micro-optimization.
- Note: Pre-existing code (lines unchanged in this PR — only surrounding tx logic moved).
  Listed for completeness; no action required.
- Fix (deferred): `await Promise.all(tasks.map(t => this.eventBus.emit('TaskDelegated', { task: t })));`

## Suggestions (Lower Confidence)

- **`buildEvalPromptBase` adds an extra serialized `findIterationByTaskId` per agent-eval iteration vs. theoretical optimum** - `src/services/eval-prompt-builder.ts:51` (Confidence: 65%) — `handleTaskTerminal` already loaded the iteration at loop-handler.ts:236, then passed `taskId` to `evaluate()`, which causes `buildEvalPromptBase` to re-fetch it for `preIterationCommitSha`. Could thread the iteration through `evaluate(loop, iteration)` instead. The extra call is cheap (cached prepared statement, indexed lookup) and matches the pre-PR behavior, but the helper extraction makes the duplication newly visible.

## Verification of User-Provided Hot Spots

| Concern | Status | Evidence |
|---------|--------|----------|
| `refetchAfterAgentEval` adds 2 repo calls — was there only 1 before? | **Same as before (2 calls)** | Old `handleTaskTerminal` (lines 293-330 in base) had inline `findById` + `findIterationByTaskId` = 2 calls. New helper has identical 2 calls. |
| Duplicate git-diff fetching across 3 evaluators now deduped in `buildEvalPromptBase` | **Source-level dedup only — no runtime change** | Per loop iteration only ONE evaluator runs (CompositeExitConditionEvaluator routes by `evalType`). Per-iteration `findIterationByTaskId` count unchanged at 1 (per evaluator invocation). |
| `startIdleCheckLoop` polling interval | **Unchanged at 5 min** | `IDLE_CHECK_INTERVAL_MS = 5 * 60 * 1000` (line 253). Query is indexed (`idx_schedules_status`). |
| New synchronous I/O in hot paths | **None** | New sync I/O (`mkdirSync`, `openSync`, `writeSync`, `closeSync`, `unlinkSync`) is in `acquirePidFile()` — runs **once at executor startup**, not per-task. |

## Positive Performance Findings

- **`finishLoop()` extraction eliminates a redundant `loops` row UPDATE on the success path** — `src/services/handlers/loop-handler.ts:911-912, 1146-1197`. Previously `completeLoop()` was called after the transaction had already written `LoopStatus.COMPLETED`, causing a double-write. The new `finishLoop()` skips the redundant `loopRepo.update()` call. Net win: 1 fewer `loops` UPDATE per successful loop completion.
- **`handleStopDecision()` extraction** — `src/services/handlers/loop-handler.ts:1241-1282` — eliminates ~25 lines of duplicated transaction logic between RETRY and OPTIMIZE strategies. No call-count change, but reduces SQL prepare cache pressure if the queries diverged in the future.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | 0 |
| Should Fix | - | 0 | 1 | 0 |
| Pre-existing | - | - | 1 | 1 |

**Performance Score**: 9 / 10
**Recommendation**: APPROVED

This refactor is performance-neutral to slightly positive. The only finding in the
"Should Fix" category is a defensive hardening suggestion (overlap guard on the 5-min
idle-check interval) that is not currently exploitable. Two pre-existing issues
(`loadAgentConfig` per-spawn sync I/O, sequential pipeline event emission) are noted
for follow-up but are out of scope for a behavior-preserving cleanup PR.
