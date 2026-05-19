# Security Review Report

**Branch**: fix/v060-correctness-bugs -> main
**Date**: 2026-03-19
**Commits Reviewed**: 4 (18d7657, 6866844, 894d3f9, 3301a2e)

## Issues in Your Changes (BLOCKING)

No CRITICAL or HIGH security issues found in the changed lines.

### MEDIUM

**TOCTOU Window Between Dependency Check and Enqueue** - `src/services/recovery-manager.ts:166-180`
- Problem: In `recoverQueuedTasks`, there is a time gap between the `isBlocked()` check (line 166) and the subsequent `queue.enqueue()` call (line 180). During this window, a dependency could be resolved by another process, causing the task to be unblocked and enqueued elsewhere via the `TaskUnblocked` event path, resulting in a potential double-enqueue.
- Impact: A task could be enqueued twice if a dependency resolves between the `isBlocked` check returning `true` and the `continue` statement, or between returning `false` and the `enqueue` call. However, the existing `queue.contains()` guard at line 158 mitigates the former case. The latter case (blocked -> unblocked between check and enqueue) could lead to double processing, though the queue's own deduplication provides a safety net. This is a low-probability race during startup recovery only.
- Fix: The existing `queue.contains()` pre-check and the fact that recovery runs once at startup significantly reduce the window. This is an acceptable trade-off given the fail-safe comment on lines 163-165 already documents the design intent. No code change required, but consider adding a comment noting the TOCTOU window is mitigated by queue deduplication.
- Category: 1 (Your Changes)

## Issues in Code You Touched (Should Fix)

### MEDIUM

**No Rate Limiting on Recovery TaskFailed Event Emission** - `src/services/recovery-manager.ts:124-133, 266-275`
- Problem: When recovering crashed/dead tasks, the code emits `TaskFailed` events in a loop without any throttling. If a large number of tasks crashed simultaneously (e.g., server crash with many running tasks), this could trigger a burst of downstream event handler activity (dependency resolution, cascading cancellations) during startup.
- Impact: During recovery of many crashed tasks, the synchronous event emission loop could cause a thundering-herd effect in event handlers, potentially overwhelming the system during an already fragile recovery phase. This is a denial-of-service risk against the server's own recovery path.
- Fix: This is acceptable for the current scale (local MCP server, not a multi-tenant service). For future hardening, consider batching the `TaskFailed` emissions or adding a configurable concurrency limit during recovery. No immediate change required.
- Category: 2 (Code You Touched)

**Unbounded Execution History Fetch When Cancelling Schedule** - `src/services/schedule-manager.ts:183`
- Problem: The previous code called `getExecutionHistory(scheduleId, 1)` to fetch only the latest execution. The new code calls `getExecutionHistory(scheduleId)` without a limit, relying on the repository's DEFAULT_LIMIT of 100. While 100 is bounded, this is a significant increase from fetching 1 record.
- Impact: For schedules with many executions, this fetches up to 100 records when the intent is to find only active (`triggered`) ones. This is not a vulnerability but an efficiency concern. The DEFAULT_LIMIT of 100 prevents truly unbounded queries, so the actual security risk is minimal.
- Fix: No immediate action needed. The DEFAULT_LIMIT of 100 in `SQLiteScheduleRepository` acts as a safety net. If the number of active executions could grow large, consider adding a repository method to fetch only active executions directly via SQL filter rather than fetching all and filtering in application code.
- Category: 1 (Your Changes)

## Pre-existing Issues (Not Blocking)

### MEDIUM

**process.kill Used for PID Existence Check** - `src/services/recovery-manager.ts:26-37`
- Problem: `process.kill(pid, 0)` is used to check if a process is alive. Signal 0 is a standard existence check, but if `pid` were somehow manipulated (e.g., set to 0 or -1), it could signal process groups or the calling process itself.
- Impact: The `pid` comes from worker registrations in the SQLite database (the `ownerPid` column), which is populated by the server's own worker management code -- not user input. The risk of PID manipulation is extremely low in this architecture.
- Fix: Pre-existing pattern, no change needed. If future changes allow external PID input, add validation (`pid > 0 && Number.isInteger(pid)`).
- Category: 3 (Pre-existing)

### LOW

**Error Messages May Leak Internal State** - `src/services/recovery-manager.ts:126-127, 268`
- Problem: Error messages like `'Worker process died (dead PID detected)'` and `'Worker process crashed during execution'` are embedded in `AutobeatError` objects that flow through the event system. These messages could potentially surface in logs or API responses.
- Impact: In an MCP server context (local, single-user), this is informational. These messages contain no secrets or sensitive data -- they describe operational state. No security risk in the current deployment model.
- Fix: No change needed for current use case. If the server ever becomes multi-tenant, ensure error messages are sanitized before returning to users.
- Category: 3 (Pre-existing)

### LOW

**Output Capture Buffer Size Tracked as Character Length vs Byte Length** - `src/implementations/output-capture.ts:13-15`
- Problem: The new `linesSize()` function sums `line.length` (character count), while the existing `capture()` method uses `Buffer.byteLength(data, 'utf8')` for the buffer limit check. After tail-slicing, `totalSize` reflects character count, not byte count, creating an inconsistency.
- Impact: This is a correctness concern rather than a security issue. The `totalSize` field after tail-slicing will undercount for multi-byte UTF-8 strings. Since `totalSize` is used for display/informational purposes (not for security-critical buffer limit enforcement), the practical impact is minimal.
- Fix: Pre-existing design choice. The character-vs-byte inconsistency was introduced in this PR for the `linesSize` function but mirrors the `TestOutputCapture.getOutput()` pattern at line 213 which also uses `.length`. Consider documenting that `totalSize` is approximate after slicing.
- Category: 2 (Code You Touched, but informational)

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | - | 0 | 1 | 1 |
| Pre-existing | - | - | 1 | 1 |

**Security Score**: 8/10

The changes are well-structured bug fixes with proper error handling, Result type usage, and defensive coding patterns. No injection vectors, no hardcoded secrets, no authentication bypasses, no cryptographic weaknesses. The TOCTOU window in dependency checking is mitigated by existing queue deduplication. The event emission pattern during recovery is appropriate for the local single-user MCP server deployment model.

**Recommendation**: APPROVED

No blocking security issues. The MEDIUM findings are design trade-offs with adequate existing mitigations, not exploitable vulnerabilities. The code demonstrates good security hygiene: error results are checked consistently, events are emitted only after successful state transitions, and fail-safe defaults (skip enqueue on DB error) prevent tasks from entering invalid states.
