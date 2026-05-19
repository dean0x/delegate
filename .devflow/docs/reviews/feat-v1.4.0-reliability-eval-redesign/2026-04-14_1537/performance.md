# Performance Review Report

**Branch**: feat/v1.4.0-reliability-eval-redesign -> main
**Date**: 2026-04-14T15:37

## Issues in Your Changes (BLOCKING)

### HIGH

**Judge evaluator runs two sequential agent tasks per iteration** - `src/services/judge-exit-condition-evaluator.ts:88-104`
**Confidence**: 85%
- Problem: The judge eval strategy spawns two sequential agent tasks per loop iteration: phase 1 (eval agent for findings) and phase 2 (judge agent for decision). Each task involves process spawn, agent execution, and output retrieval. For a loop with 10 iterations, this doubles the wall-clock eval time compared to single-agent modes (schema or the prior agent evaluator). The two phases are inherently sequential (phase 2 needs phase 1 output), so they cannot be parallelized.
- Fix: This is an intentional architectural trade-off (two-phase separation enables different agents for eval vs. judge). No code fix needed, but the performance implication should be documented in the MCP instructions or loop creation validation so users understand the cost:
  ```typescript
  // In mcp-instructions.ts, under "Agent eval sub-strategies":
  // - evalType: "judge" ... NOTE: runs two agent tasks per iteration (eval + judge), roughly doubling eval time
  ```

**Feedback accumulation queries up to 11 iterations per `enrichPromptWithCheckpoint` call** - `src/services/handlers/loop-handler.ts:1445-1497`
**Confidence**: 82%
- Problem: The previous implementation fetched 2 iterations (current + previous). The new implementation fetches 11 iterations (`getIterations(loop.id, 11, 0)`) to accumulate up to 10 feedback entries. This is a 5.5x increase in rows fetched from SQLite per iteration start. For loops using `!freshContext` (the trigger condition), every iteration start now does a larger DB read. The `idx_loop_iterations_loop_iteration` index covers this query, so the increase is from O(1) index seek returning 2 rows to O(1) index seek returning 11 rows -- moderate but not negligible when combined with the subsequent checkpoint lookup and string assembly.
- Fix: The 11-row fetch is bounded and indexed, so the absolute cost is small. However, the 8KB feedback accumulation loop at lines 1488-1495 uses `entry.length` (character count) to approximate byte cost while the constant is named `MAX_FEEDBACK_BYTES` (8192). For ASCII this is equivalent, but multi-byte characters could overshoot:
  ```typescript
  // Line 1492: use Buffer.byteLength for accurate byte counting if the cap is truly byte-based
  if (totalBytes + Buffer.byteLength(entry) > MAX_FEEDBACK_BYTES) break;
  ```

### MEDIUM

**Default timeout changed from 30 min to 0 (disabled) -- tasks can run indefinitely** - `src/core/configuration.ts:20`
**Confidence**: 88%
- Problem: `timeout` default changed from `1800000` (30 min) to `0` (disabled). The `setupTimeoutForWorker` method in `event-driven-worker-pool.ts:309-310` correctly skips timeout setup when `timeoutMs <= 0`, so no timer is set. This means every task now runs with no timeout unless one is explicitly provided. While the comment explains that "tasks run 2.5+ hours; timeout was killing them", removing the safety net entirely means a hung agent process will consume a worker slot forever -- no automatic cleanup.
- Fix: Consider keeping a high default (e.g., 4 hours = 14400000) rather than 0 to prevent indefinite resource consumption from genuinely stuck processes:
  ```typescript
  timeout: z.number().min(0).max(86400000).default(14400000), // Default: 4hr safety net
  ```

**`readFileSync` in schedule executor PID path** - `src/cli/commands/schedule-executor.ts:36`
**Confidence**: 80%
- Problem: `readExecutorPid()` uses `fs.readFileSync` to read the PID file. This runs in the CLI hot path when `ensureScheduleExecutorRunning()` is called after every schedule create/resume (lines 504, 526, 543, 703). Synchronous I/O blocks the event loop. For a single small file read this is negligible, but the function is called on every schedule mutation.
- Fix: The file is tiny (a PID number) and reads are infrequent (only on create/resume), so the practical impact is minimal. This is acceptable for a CLI path. No change required unless schedule mutations become high-frequency.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Two `stdout.join('')` calls in structured output parsers create temporary large strings** - `src/services/agent-exit-condition-evaluator.ts:230`, `src/services/judge-exit-condition-evaluator.ts:319`
**Confidence**: 80%
- Problem: Both `tryParseStructuredOutput` methods join all stdout chunks into a single string, then search for the last `{"type":"result"` marker. If an agent produces large output (hundreds of KB), this creates a large temporary string. The `lastIndexOf` then scans backward through it.
- Fix: Since Claude's structured output result marker appears at the end, search the last few chunks first rather than joining everything:
  ```typescript
  // Optimization: search backward through chunks before joining all
  for (let i = stdout.length - 1; i >= 0; i--) {
    const idx = stdout[i].lastIndexOf(marker);
    if (idx !== -1) {
      const suffix = stdout.slice(i).join('').slice(idx);
      // ... parse suffix
    }
  }
  ```
  However, this is only relevant for very large outputs. Current approach is acceptable for typical eval agent responses.

## Pre-existing Issues (Not Blocking)

_No CRITICAL pre-existing performance issues detected in changed files._

## Suggestions (Lower Confidence)

- **Heartbeat timer per worker adds 1 DB write every 30s per active worker** - `src/implementations/event-driven-worker-pool.ts:352-357` (Confidence: 70%) -- With many concurrent workers (e.g., 10+), this creates sustained write pressure on the SQLite WAL. The `timer.unref()` prevents blocking exit, which is good. Monitor in production whether 30s is too aggressive for high-concurrency deployments.

- **`ensureScheduleExecutorRunning` spawns a full `bootstrap({ mode: 'server' })` process** - `src/cli/commands/schedule-executor.ts:142` (Confidence: 65%) -- Every schedule create/resume checks PID liveness and potentially spawns a new Node.js process running full server bootstrap. The startup cost is one-time and amortized, but a stale PID file that falsely reports "alive" (PID reuse by OS) could leave users without a running executor.

- **`evalResponse` stored as unbounded TEXT in loop_iterations** - `src/implementations/loop-repository.ts:469` (Confidence: 62%) -- The `evalResponse` field stores raw agent JSON output with no size limit. Over many iterations, this could bloat the `loop_iterations` table. The `MAX_FEEDBACK_LENGTH` cap (16KB) applies to feedback but not to evalResponse.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Performance Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The PR introduces no critical performance regressions. The two HIGH findings (sequential two-phase judge eval and increased iteration fetch) are architectural trade-offs with bounded cost, not bugs. The disabled default timeout (MEDIUM) is the most actionable item -- consider a high default instead of 0 to retain a safety net against indefinitely hung processes. The heartbeat mechanism is well-designed with `unref()` and cached prepared statements (PF-004 pitfall addressed). The feedback accumulation uses a sensible 8KB cap. Overall, the performance profile is acceptable for the feature scope.
