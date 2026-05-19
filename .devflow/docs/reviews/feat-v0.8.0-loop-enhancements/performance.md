# Performance Review Report

**Branch**: feat/v0.8.0-loop-enhancements -> main
**Date**: 2026-03-23
**Commits**: 5 (7bfdefd..eb1389d)

## Issues in Your Changes (BLOCKING)

### HIGH

**Sequential git process spawning in `captureGitState` blocks loop creation** - `src/utils/git-state.ts:28-67`
**Confidence**: 85%
- Problem: `captureGitState()` sequentially spawns 3 child processes (`git rev-parse --abbrev-ref HEAD`, `git rev-parse HEAD`, `git status --porcelain`). This is called during `createLoop()` in `loop-manager.ts:187` on every loop creation when `gitBranch` is set. Each `execFile` call incurs process spawn overhead (~5-15ms each), totaling ~15-45ms of sequential I/O per loop creation. The first two git commands (`rev-parse --abbrev-ref HEAD` and `rev-parse HEAD`) are independent and could run in parallel.
- Fix: Run the independent git commands in parallel using `Promise.all`:
```typescript
const [branchResult, shaResult] = await Promise.all([
  execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], execOpts).catch(() => null),
  execFileAsync('git', ['rev-parse', 'HEAD'], execOpts).catch(() => null),
]);
if (!branchResult || !shaResult) return ok(null);
const branch = branchResult.stdout.trim();
const commitSha = shaResult.stdout.trim();
// Then run git status --porcelain (depends on repo being valid)
```
This reduces 3 sequential spawns to 2 sequential steps (parallel pair + status), saving ~5-15ms per call.

**Git operations (`createAndCheckoutBranch`, `captureGitDiff`) on event-driven hot path** - `src/services/handlers/loop-handler.ts:528`, `src/services/handlers/loop-handler.ts:1003`
**Confidence**: 82%
- Problem: Two git child process spawns occur in the loop handler's iteration lifecycle: `createAndCheckoutBranch()` at iteration start (line 528) and `captureGitDiff()` at iteration completion (line 1003). These are `execFile` calls that block the Node.js event loop's cooperative scheduling while the process spawn syscall executes. Since the loop handler runs inside event handlers that process the EventBus, a slow git operation (e.g., large repo, NFS, or cold disk cache) delays all other event processing until completion. For a pipeline loop with many iterations, this compounds.
- Fix: The graceful degradation pattern (already present -- failures are logged and execution continues) is good. However, consider adding a timeout to the git operations to prevent indefinite blocking:
```typescript
await execFileAsync('git', args, { cwd: workingDirectory, timeout: 10000 });
```
This prevents a hung git process (e.g., remote ref resolution, lock contention) from blocking the event loop indefinitely. The `execFile` call already returns a Promise, but without a timeout, a deadlocked git process would hang forever.

### MEDIUM

**Force-pause pipeline task cancellation is sequential** - `src/services/handlers/loop-handler.ts:422-430`
**Confidence**: 82%
- Problem: When force-pausing a pipeline loop iteration, each pipeline task cancellation event is emitted sequentially in a `for` loop:
```typescript
for (const ptId of latestIteration.pipelineTaskIds) {
  if (ptId === latestIteration.taskId) continue;
  await this.eventBus.emit('TaskCancellationRequested', { ... });
}
```
With a pipeline of up to 20 steps (per schema `maxItems: 20`), this issues up to 19 sequential event emissions. Each emission may trigger async handlers, making this O(n) in pipeline size.
- Fix: Use `Promise.all` for independent cancellation emissions:
```typescript
const cancelPromises = latestIteration.pipelineTaskIds
  .filter(ptId => ptId !== latestIteration.taskId)
  .map(ptId => this.eventBus.emit('TaskCancellationRequested', {
    taskId: ptId,
    reason: `Loop ${loopId} force paused`,
  }));
await Promise.all(cancelPromises);
```

**Schedule cancellation cascade emits loop cancellations sequentially** - `src/services/handlers/schedule-handler.ts:730-742`
**Confidence**: 80%
- Problem: When cancelling a schedule with `loopConfig`, active loops are cancelled one at a time in a `for` loop:
```typescript
for (const loop of activeLoops) {
  const cancelResult = await this.eventBus.emit('LoopCancelled', { ... });
}
```
In practice, only one active loop per schedule should exist (due to collision detection), so this is low-impact currently. However, if collision detection fails or multiple paused loops accumulate, this becomes sequential.
- Fix: Use `Promise.all` for concurrent cancellation, or document that at most 1 active loop exists per schedule to clarify the performance invariant.

## Issues in Code You Touched (Should Fix)

_No issues found in this category._

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`clearRunningScheduleByTask` uses linear scan** - `src/services/schedule-executor.ts:171-178`
**Confidence**: 80%
- Problem: This method iterates all entries in `runningSchedules` map to find a matching taskId/loopId. With loop lifecycle events now also calling this method (lines 145, 149), the map is scanned on every LoopCompleted and LoopCancelled event in addition to TaskCompleted/Failed/Cancelled/Timeout. The map is keyed by scheduleId but searched by value (taskId), making it O(n) per terminal event.
- Fix: Maintain a reverse map (`taskId -> scheduleId`) for O(1) lookup, or accept this as a low-N optimization given the typical schedule count.

## Suggestions (Lower Confidence)

- **`captureGitState` spawns unnecessary `git status` for branch validation** - `src/services/loop-manager.ts:187` (Confidence: 65%) -- The loop manager only needs `branch` from `captureGitState`, but the function also runs `git status --porcelain` which is the most expensive git command. A lighter-weight function that only checks `rev-parse` would reduce creation latency.

- **In-memory maps (`taskToLoop`, `pipelineTasks`, `cooldownTimers`) lack size bounds** - `src/services/handlers/loop-handler.ts:49-51` (Confidence: 70%) -- These maps grow with active loops/tasks and are cleaned up on completion, but a runaway loop creation pattern (e.g., cron-triggered loops without collision detection failures) could grow them unboundedly. Not a practical concern given collision detection, but a defensive `maxSize` check would harden against edge cases.

- **`handleLoopPaused` force path does not clean up `taskToLoop` entries** - `src/services/handlers/loop-handler.ts:366-444` (Confidence: 75%) -- When force-pausing, task cancellation events are emitted but the `taskToLoop` map entries for the cancelled tasks are not cleaned up immediately. The entries will be cleaned up when `TaskCancelled` events fire, but there is a window where stale entries exist. The `handleLoopCancelled` path (line 328-333) explicitly cleans up `taskToLoop`; the pause path does not.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Performance Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The v0.8.0 changes introduce git operations (child process spawns) into the event-driven hot path, which is the primary performance concern. The sequential `captureGitState` with 3 process spawns and the lack of timeouts on git operations are the most actionable items. Database access patterns are well-indexed (the new `idx_loops_schedule_id` index covers the `findByScheduleId` query). The in-memory map management is adequate for expected workloads. The sequential event emissions during force-pause and schedule cancellation are bounded by pipeline size (max 20) and active loop count (typically 1), making them acceptable with a note to parallelize if these bounds change.
