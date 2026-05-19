# Performance Review Report

**Branch**: fix-git-integration -> main
**Date**: 2026-03-25

## Issues in Your Changes (BLOCKING)

### HIGH

**Sequential git process spawns in `commitAllChanges` -- 4 serial `execFile` calls per successful iteration** - `src/utils/git-state.ts:331-355`
**Confidence**: 88%
- Problem: `commitAllChanges()` spawns up to 4 sequential child processes: `git add -A`, `git diff --cached --quiet`, `git commit -m`, and `git rev-parse HEAD`. Each `execFileAsync` incurs process-spawn overhead (fork/exec). This runs on every successful (pass/keep) iteration via `commitAndCaptureDiff()`, so the cumulative cost grows linearly with iteration count.
- Impact: For a loop with 50 successful iterations, this is up to 200 sequential process spawns just for the commit path, plus 1 more for `captureGitDiff` and 1 for `getCurrentCommitSha` in `setupGitForIteration` -- totaling ~300 process spawns. Each spawn typically costs 5-20ms on macOS, adding 1.5-6 seconds across a full loop run. These are inherently sequential (each depends on the prior), so `Promise.all` is not applicable.
- Fix: The final `git rev-parse HEAD` after commit could be eliminated by parsing the commit output directly (`git commit` prints `[branch SHA] message` to stdout). This saves one process spawn per successful iteration:
  ```typescript
  // After git commit, parse SHA from stdout instead of separate rev-parse
  const commitOutput = await execFileAsync('git', ['commit', '-m', message, '--'], execOpts);
  const match = commitOutput.stdout.match(/\[[\w/.-]+ ([a-f0-9]+)\]/);
  if (match) return ok(match[1]);
  // fallback to rev-parse if parsing fails
  const shaResult = await execFileAsync('git', ['rev-parse', 'HEAD'], execOpts);
  return ok(shaResult.stdout.trim());
  ```

### MEDIUM

**`getResetTargetSha` fetches up to 100 iterations to find a single row** - `src/services/handlers/loop-handler.ts:1224-1238`
**Confidence**: 85%
- Problem: `getResetTargetSha()` calls `this.loopRepo.getIterations(loop.id, 100)` then does a linear `.find()` to locate the iteration matching `loop.bestIterationId`. This fetches and Zod-parses up to 100 rows (each requiring `JSON.parse` for `pipeline_task_ids`) when only 1 row is needed. Runs on every failed/discarded iteration in optimize mode.
- Impact: For optimize loops with many iterations, this is unnecessarily wasteful. A targeted query by iteration number would be O(1) via indexed lookup vs O(n) fetch-and-scan. The Zod parsing per row amplifies the overhead.
- Fix: Add a repository method to fetch a single iteration by loop ID and iteration number, or store `bestIterationGitCommitSha` directly on the loop domain object:
  ```typescript
  // Option A: targeted query (preferred, avoids schema change)
  private async getResetTargetSha(loop: Loop): Promise<string | undefined> {
    if (loop.strategy === LoopStrategy.OPTIMIZE && loop.bestIterationId !== undefined) {
      // New repo method: findIterationByNumber(loopId, iterationNumber)
      const iterResult = await this.loopRepo.findIterationByNumber(loop.id, loop.bestIterationId);
      if (iterResult.ok && iterResult.value?.gitCommitSha) {
        return iterResult.value.gitCommitSha;
      }
    }
    return loop.gitStartCommitSha;
  }
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Double `captureGitState` invocation when `gitBranch` is provided** - `src/services/loop-manager.ts:178-231`
**Confidence**: 82%
- Problem: When `request.gitBranch` is set, `validateCreateRequest()` (line 180) calls `captureGitState()` spawning 3 git processes to validate the repo exists. Then `createLoop()` (line 229) calls `captureLoopGitContext()` which internally calls `captureGitState()` again -- spawning 3 more identical git processes. The same git state is captured twice.
- Impact: 6 sequential process spawns instead of 3 for git-enabled loop creation. This is a one-time cost per loop creation so the absolute impact is small (~60-120ms), but it is clearly redundant work.
- Fix: Either cache the git state from validation and pass it to `createLoop`, or have `validateCreateRequest` return the git context it already captured:
  ```typescript
  // Option: have validateCreateRequest return the captured git state
  async validateCreateRequest(request: LoopCreateRequest): Promise<Result<{ gitState?: GitState }>> {
    // ... existing validation ...
    if (request.gitBranch) {
      const gitStateResult = await captureGitState(validatedDir);
      // ... validate ...
      return ok({ gitState: gitStateResult.value });
    }
    return ok({});
  }
  // Then in createLoop, reuse the returned gitState instead of calling captureLoopGitContext again
  ```

**`captureGitState` runs 3 sequential processes; `captureLoopGitContext` discards the `dirtyFiles` result** - `src/utils/git-state.ts:119-171, 301-319`
**Confidence**: 80%
- Problem: `captureLoopGitContext()` delegates to `captureGitState()` which spawns 3 sequential git processes: `rev-parse --abbrev-ref HEAD`, `rev-parse HEAD`, and `git status --porcelain`. The caller only needs `branch` and `commitSha` -- the `dirtyFiles` result from `git status --porcelain` is never used and is discarded. The `git status --porcelain` command can be expensive in large repositories (it scans the entire working tree).
- Impact: One unnecessary `git status --porcelain` call per loop creation. In repos with thousands of files this can take 100ms+. Given this only runs once at loop creation (not per iteration), the practical impact is LOW to MEDIUM.
- Fix: Create a lightweight variant that skips the status check, or accept the cost since it runs only once per loop:
  ```typescript
  // Lightweight: only capture branch + SHA
  export async function captureLoopGitContext(workingDirectory: string, gitBranch?: string): Promise<Result<LoopGitContext>> {
    const shaResult = await getCurrentCommitSha(workingDirectory);
    if (!shaResult.ok) return ok({}); // Not a git repo or error
    const branch = gitBranch
      ? (await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workingDirectory, timeout: GIT_TIMEOUT_MS })).stdout.trim()
      : undefined;
    return ok({ gitBaseBranch: branch, gitStartCommitSha: shaResult.value });
  }
  ```

## Pre-existing Issues (Not Blocking)

### MEDIUM

**All git operations share the same 30s timeout regardless of expected duration** - `src/utils/git-state.ts:14`
**Confidence**: 80%
- Problem: `GIT_TIMEOUT_MS = 30_000` is used uniformly for all operations -- from sub-millisecond `git rev-parse HEAD` to potentially slow `git add -A` and `git clean -fd`. Lightweight commands should fail faster on pathological infrastructure issues (NFS hangs, locked index); heavy commands may legitimately need more time.
- Fix: Introduce tiered timeouts. Not blocking because the current 30s is a reasonable middle ground for all operations.

## Suggestions (Lower Confidence)

- **Git operation accumulation across many iterations** - `src/services/handlers/loop-handler.ts:531-580` (Confidence: 72%) -- For a git-enabled loop, each iteration spawns at minimum 1 git process (`getCurrentCommitSha` in `setupGitForIteration`) plus 4-6 more at completion (commit + diff or reset + clean). Over many iterations (e.g., optimize loops with maxIterations=100), this totals 500-700 child processes. Monitor whether this becomes a bottleneck in production.

- **`resetToCommit` runs `git clean -fd` unconditionally** - `src/utils/git-state.ts:407-410` (Confidence: 65%) -- After `git reset --hard`, `git clean -fd` is always run even if there are no untracked files. For large repos `git clean` scans the entire tree. Could check `git status --porcelain` first, but that adds another process spawn, so the net benefit is unclear.

- **`git add -A` stages the entire working tree per iteration** - `src/utils/git-state.ts:339` (Confidence: 60%) -- In monorepos, `git add -A` walks the entire tree. Since this runs per successful iteration, it could add up. Accept as correct behavior since the loop's working directory scope is already constrained.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Performance Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The commit-per-iteration design is a significant performance improvement over the previous branch-per-iteration approach (which spawned additional git processes for branch creation on every iteration). The sequential git process spawning pattern is inherent to the git operational model -- you must stage before checking, commit before getting the SHA. The overall design is sound with graceful degradation, 30s timeouts as safety nets, and Result-based error handling throughout.

Two actionable improvements before or shortly after merge:
1. **`getResetTargetSha`** should use a targeted iteration lookup instead of fetching 100 rows (quick win, most impactful for optimize loops).
2. **Double `captureGitState`** in `LoopManagerService.createLoop` when `gitBranch` is provided can be eliminated by reusing the result from validation.

Neither issue is severe enough to block merge.
