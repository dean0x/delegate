# Code Review Synthesis: fix-git-integration

**Branch**: fix/git-integration → main
**Date**: 2026-03-25
**PR**: #118
**Review Base**: 10 specialized reviewers (security, architecture, performance, complexity, consistency, regression, tests, database, dependencies, documentation)

---

## Merge Recommendation: CHANGES_REQUESTED

**Summary**: The commit-per-iteration redesign is architecturally sound and well-tested. However, **two critical consistency gaps** in error handling must be fixed before merge:

1. **BLOCKING**: Missing git reset on task failure path (affects git-enabled loops)
2. **BLOCKING**: Missing git reset on pipeline intermediate task failure
3. **REQUIRED**: Missing v0.8.1 release notes file (blocks release workflow)
4. **REQUIRED**: Correcting contradictory v0.8.0 release notes subtitle

The core logic is production-ready; these are edge-case handlers that complete the feature.

---

## Issue Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW | Total |
|----------|----------|------|--------|-----|-------|
| **Blocking** (Repo Changes) | 0 | 3 | 4 | 0 | **7** |
| **Should Fix** (Code You Touched) | 0 | 0 | 6 | 0 | **6** |
| **Pre-existing** (Legacy Issues) | 0 | 0 | 7 | 1 | **8** |

---

## BLOCKING ISSUES (Must Fix Before Merge)

### 🔴 Issue 1: Missing git reset on TaskFailed path — CRITICAL CONSISTENCY

**Location**: `src/services/handlers/loop-handler.ts:246-271` (TaskFailed handler)
**Confidence**: 85%
**Severity**: HIGH
**Impact**: **BREAKS COMMIT-PER-ITERATION INVARIANT**

**Problem**:
When a task fails (agent crashes, timeout, non-zero exit) on a git-enabled loop, the `handleTaskTerminal` method records the iteration as `fail` and **does NOT call `resetToCommit()`**. In contrast, all exit-condition-evaluated paths (`recordAndContinue`, lines 1078-1158) correctly reset the working directory on fail/discard/crash.

This creates an inconsistency:
- **Exit-condition path** (task completes normally): Git reset on fail ✓
- **Task failure path** (process crash): Git reset on fail ✗

Result: The working directory retains partial/dirty changes from the failed agent, and the next iteration starts from a polluted state instead of a clean commit.

**Required Fix**:
```typescript
if (isTaskFailed) {
  // Git: reset to clean state on task failure (v0.8.1)
  if (iteration.preIterationCommitSha) {
    const resetTarget = await this.getResetTargetSha(loop);
    if (resetTarget) {
      const resetResult = await resetToCommit(loop.workingDirectory, resetTarget);
      if (!resetResult.ok) {
        this.logger.warn('Failed to reset after task failure', {
          loopId, iterationNumber: iteration.iterationNumber,
          resetTarget, error: resetResult.error.message,
        });
      }
    }
  }
  // ... existing failure handling
}
```

**Test Evidence**: The existing test at `tests/unit/services/handlers/loop-handler.test.ts:1435-1454` is named "should reset to gitStartCommitSha on task failure" but its implementation explicitly states "Task failure does NOT go through git commit/reset path." This gap was documented but not fixed.

---

### 🔴 Issue 2: Missing git reset on pipeline intermediate task failure

**Location**: `src/services/handlers/loop-handler.ts:1352-1364` (handlePipelineIntermediateTask)
**Confidence**: 85%
**Severity**: HIGH
**Impact**: Same as Issue 1 but for pipeline-mode loops

**Problem**: The `handlePipelineIntermediateTask` failure path also writes directly to the DB without calling `resetToCommit()`.

**Required Fix**: Same pattern as Issue 1 — add git reset before the transaction block at line 1352.

---

### 🔴 Issue 3: Missing v0.8.1 release notes file

**Location**: `docs/releases/RELEASE_NOTES_v0.8.1.md` (does not exist)
**Confidence**: 85%
**Severity**: MEDIUM → HIGH (blocking release)
**Impact**: Release workflow will fail during pre-flight validation

**Problem**: The project's release process (documented in CLAUDE.md) requires `docs/releases/RELEASE_NOTES_v{version}.md` to exist before releasing. CHANGELOG.md, ROADMAP.md, and package.json all reference v0.8.1, but the release notes file is missing.

**Required Fix**: Create `docs/releases/RELEASE_NOTES_v0.8.1.md` with content from the CHANGELOG v0.8.1 section:

```markdown
# Autobeat v0.8.1 Release Notes

## Bug Fix: Commit-per-iteration Git Integration

**Version**: 0.8.1
**Release Date**: 2026-03-25
**Base Version**: v0.8.0

### What's Fixed

Corrected the git integration design from per-iteration branch isolation to per-iteration commit tracking:

- **v0.8.0 design** (incorrect): Each iteration checked out a separate branch (`loop/work/iteration-1`, `loop/work/iteration-2`, etc.). This created excessive branch overhead and complexity.

- **v0.8.1 design** (correct): Each iteration records a commit SHA after changes. The loop maintains a single working branch. Iterations are tracked by commit history, not branch proliferation.

### Changes

- **Iteration git tracking**: Now records `preIterationCommitSha` (before-state baseline) and `gitCommitSha` (after-state result) instead of `gitBranch`
- **Loop base context**: Now records `gitStartCommitSha` (HEAD at loop creation) instead of `gitBaseBranch`
- **Revert on failure**: On iteration fail/discard, the working directory is reset to `gitStartCommitSha` to ensure clean state for next attempt
- **Database migration v12**: Adds `loops.git_start_commit_sha`, `loop_iterations.{git_commit_sha, pre_iteration_commit_sha}`; preserves legacy `git_base_branch` and `git_branch` columns

### Migration

For users upgrading from v0.8.0:

- Existing loops with `gitBranch` on iterations will show that value in CLI `loop status` output (fallback)
- New loops created in v0.8.1 will use the commit-based tracking
- No data loss — all v0.8.0 columns are preserved in the database

### Testing

- 13 new integration tests covering: commit on pass/keep, reset on fail/discard, pre-iteration SHA capture, null-commit fallback
- All existing tests pass
- Full test suite: `npm run test:all`

### Migration v12

Safe migration (nullable columns, no table lock):
```sql
ALTER TABLE loops ADD COLUMN git_start_commit_sha TEXT;
ALTER TABLE loop_iterations ADD COLUMN git_commit_sha TEXT;
ALTER TABLE loop_iterations ADD COLUMN pre_iteration_commit_sha TEXT;
```

### Known Limitations

- v0.8.1 always captures git state when creating loops in git repos (adds ~3 process spawns). This enables commit tracking even without `--git-branch`. Non-git loops are unaffected.
- Sequential git operations (add, commit, diff, reset) inherit a 30s timeout per operation. Pathological cases (very large repos, slow filesystems) may experience timeouts. Standard repositories show sub-100ms latency.

### Contributors

See git log for implementation details.
```

---

### 🔴 Issue 4: Contradictory v0.8.0 release notes subtitle

**Location**: `docs/releases/RELEASE_NOTES_v0.8.0.md:3`
**Confidence**: 95%
**Severity**: MEDIUM
**Impact**: Documentation integrity — subtitle and body contradict

**Problem**: Line 3 reads "per-iteration git branch isolation" (the old, incorrect design), but the body (lines 29-33) correctly describes the design was intended to be that but a fix was needed.

**Required Fix**: Change line 3 from:
```
Enhanced loop lifecycle with pause/resume controls, cron-scheduled loop execution, per-iteration git branch isolation, and CLI naming standardization.
```
to:
```
Enhanced loop lifecycle with pause/resume controls, cron-scheduled loop execution, git-aware loop iteration tracking, and CLI naming standardization.
```

---

## SHOULD-FIX ISSUES (High-Quality Improvements)

These are not blocking but should be addressed together with the blocking fixes:

### ⚠️ Issue 5: Duplicated git state capture logic — HIGH architectural concern

**Location**: `src/services/loop-manager.ts:229-239` and `src/services/handlers/schedule-handler.ts:564-576`
**Confidence**: 85% (Architecture reviewer)
**Category**: Code you touched

**Problem**: Both `LoopManagerService.createLoop()` and `ScheduleHandler.handleLoopTrigger()` contain nearly identical git state capture logic (3-5 lines each). If capture logic needs to change, both sites must be updated.

**Recommended Fix** (not required, but improves maintainability):
```typescript
// In src/utils/git-state.ts or src/services/loop-git.ts
export async function captureLoopGitContext(
  workingDirectory: string,
  gitBranch?: string,
): Promise<{ gitBaseBranch?: string; gitStartCommitSha?: string }> {
  const gitStateResult = await captureGitState(workingDirectory);
  if (!gitStateResult.ok || !gitStateResult.value) return {};

  const gitBaseBranch = gitBranch ? gitStateResult.value.branch : undefined;
  const shaResult = await getCurrentCommitSha(workingDirectory);
  const gitStartCommitSha = shaResult.ok ? shaResult.value : undefined;

  return { gitBaseBranch, gitStartCommitSha };
}
```

### ⚠️ Issue 6: Weak assertion in branch checkout test — HIGH test quality issue

**Location**: `tests/unit/services/handlers/loop-handler.test.ts:1302-1322`
**Confidence**: 90% (Tests reviewer)
**Category**: Blocking

**Problem**: The test "should NOT call createAndCheckoutBranch for subsequent iterations" wraps its core assertion in `if (calls.length > 0)`, making it vacuously true if the function is never called (the opposite of what the test claims to verify).

**Recommended Fix**:
```typescript
it('should re-checkout loop branch without baseBranch for subsequent iterations', async () => {
  // ... setup ...
  vi.mocked(createAndCheckoutBranch).mockClear();

  const taskId1 = await getLatestTaskId(loop.id);
  await eventBus.emit('TaskCompleted', { taskId: taskId1!, exitCode: 0, duration: 100 });
  await flushEventLoop();

  const calls = vi.mocked(createAndCheckoutBranch).mock.calls;
  expect(calls).toHaveLength(1); // Exactly one re-checkout call
  expect(calls[0][2]).toBeUndefined(); // No fromRef for re-checkout
});
```

### ⚠️ Issue 7: Missing error-path test for git commit failures

**Location**: `tests/unit/utils/git-state.test.ts`
**Confidence**: 85% (Tests reviewer)
**Category**: Blocking

**Problem**: `commitAllChanges` test suite covers success and `git add` failure, but not the case where `git commit -m` itself fails (e.g., pre-commit hook rejection).

**Recommended Fix**: Add test case for pre-commit hook failure.

### ⚠️ Issue 8: Redundant git rev-parse calls in loop creation

**Location**: `src/services/loop-manager.ts:231-238`, `src/services/handlers/schedule-handler.ts:565-569`
**Confidence**: 85% (Performance + Architecture reviewers)
**Category**: Performance improvement

**Problem**: `captureGitState()` already calls `git rev-parse HEAD` and returns the SHA. Immediately after, `getCurrentCommitSha()` calls `git rev-parse HEAD` again. This is a redundant process spawn.

**Recommended Fix**: Reuse the SHA from `captureGitState()`:
```typescript
const gitStateResult = await captureGitState(validatedWorkingDirectory);
if (gitStateResult.ok && gitStateResult.value) {
  gitBaseBranch = request.gitBranch ? gitStateResult.value.branch : undefined;
  gitStartCommitSha = gitStateResult.value.commitSha; // Reuse, no second rev-parse
}
```

### ⚠️ Issue 9: Complexity growth in startNextIteration — HIGH complexity

**Location**: `src/services/handlers/loop-handler.ts:478-569`
**Confidence**: 90% (Complexity reviewer)
**Category**: Should-fix

**Problem**: Method grew from ~30 lines to 96 lines. Git setup block (lines 510-562) has 13 decision points and 4-level nesting. This should be extracted.

**Recommended Fix**: Extract git setup into a private helper:
```typescript
private async setupGitForIteration(
  loop: Loop,
  iterationNumber: number,
): Promise<string | undefined> {
  if (iterationNumber === 1 && loop.gitBranch) {
    const branchResult = await createAndCheckoutBranch(
      loop.workingDirectory, loop.gitBranch, loop.gitBaseBranch,
    );
    if (!branchResult.ok) {
      this.logger.warn('Failed to create git branch for loop', { ... });
    }
  } else if (iterationNumber > 1 && loop.gitBranch) {
    const checkoutResult = await createAndCheckoutBranch(loop.workingDirectory, loop.gitBranch);
    if (!checkoutResult.ok) {
      this.logger.warn('Failed to re-checkout loop branch', { ... });
    }
  }

  const shaResult = await getCurrentCommitSha(loop.workingDirectory);
  if (shaResult.ok) return shaResult.value;
  this.logger.warn('Failed to capture pre-iteration commit SHA', { ... });
  return undefined;
}
```

### ⚠️ Issue 10: Nesting depth in recordAndContinue — HIGH complexity

**Location**: `src/services/handlers/loop-handler.ts:1078-1158`
**Confidence**: 88% (Complexity reviewer)
**Category**: Should-fix

**Problem**: Git revert logic adds nesting that reaches 6 levels. Per patterns, this is critical (threshold is 4).

**Recommended Fix**: Extract revert path into a helper:
```typescript
private async revertIterationChanges(loop: Loop, iteration: LoopIteration): Promise<void> {
  const resetTarget = await this.getResetTargetSha(loop);
  if (!resetTarget) return;

  const resetResult = await resetToCommit(loop.workingDirectory, resetTarget);
  if (!resetResult.ok) {
    this.logger.warn('Failed to reset to commit after iteration failure', {
      loopId: loop.id,
      iterationNumber: iteration.iterationNumber,
      resetTarget,
      error: resetResult.error.message,
    });
  }
}
```

### ⚠️ Issue 11: Legacy gitBranch field always NULL in new code

**Location**: `src/implementations/loop-repository.ts:259, 401, 454, 488, 509`
**Confidence**: 85% (Consistency reviewer)
**Category**: Documentation improvement

**Problem**: `LoopIteration.gitBranch` is marked as "dead after v0.8.1" but still written to the DB with no comment explaining why.

**Recommended Fix**: Add inline comment in insert/update paths:
```typescript
iteration.gitBranch ?? null, // Legacy (v0.8.0), always null for v0.8.1+
```

---

## PRE-EXISTING ISSUES (Informational Only)

These are not your responsibility but worth noting:

- **Sequential git operation timeouts**: All git commands share a 30s timeout regardless of expected duration (lightweight `rev-parse` vs heavy `git add -A`). Consider tiered timeouts in a future refactor.
- **`getResetTargetSha` fetches 100 iterations to find best**: O(n) scan instead of direct query. Add `loopRepo.getIteration(loopId, iterationNumber)` method if needed.
- **loop-handler.ts is 1,612 lines**: Well above the 500-line complexity threshold. Future refactor should split into separate concerns.
- **No rollback migrations**: All migrations define `up` without `down`. Standard for SQLite given limitations, but worth noting.

---

## SUMMARY BY REVIEWER

| Reviewer | Score | Finding | Recommendation |
|----------|-------|---------|-----------------|
| **Security** | 8/10 | 1 MEDIUM blocking (missing branch check), 1 MEDIUM should-fix (validation mismatch) | APPROVED_WITH_CONDITIONS |
| **Architecture** | 7/10 | 1 HIGH blocking (duplicated git capture logic), 1 MEDIUM should-fix (validation naming) | APPROVED_WITH_CONDITIONS |
| **Performance** | 7/10 | 2 HIGH blocking (sequential spawns), 1 MEDIUM blocking (redundant rev-parse), 1 MEDIUM should-fix (optimize query) | APPROVED_WITH_CONDITIONS |
| **Complexity** | 6/10 | 2 HIGH blocking (branch count and nesting), 1 MEDIUM should-fix (file size) | APPROVED_WITH_CONDITIONS |
| **Consistency** | 7/10 | 2 HIGH blocking (missing reset on task failure, dup git commit), 2 MEDIUM should-fix | CHANGES_REQUESTED |
| **Regression** | 6/10 | 2 HIGH blocking (missing reset, CLI fallback), 1 MEDIUM should-fix (behavior change) | CHANGES_REQUESTED |
| **Tests** | 8/10 | 2 HIGH blocking (weak assertions), 1 MEDIUM should-fix (missing edge case) | CHANGES_REQUESTED |
| **Database** | 9/10 | No blocking issues; migration is clean and safe | APPROVED |
| **Dependencies** | 10/10 | No changes except version bump | APPROVED |
| **Documentation** | 7/10 | 2 MEDIUM blocking (missing release notes, contradictory subtitle) | CHANGES_REQUESTED |

---

## PRIORITY-ORDERED ACTION PLAN

### Before Merge (Blocking)
1. **Add git reset to TaskFailed handler** (loop-handler.ts:246-271) — 10 min
2. **Add git reset to pipeline TaskFailed handler** (loop-handler.ts:1352-1364) — 5 min
3. **Create RELEASE_NOTES_v0.8.1.md** — 5 min
4. **Fix RELEASE_NOTES_v0.8.0.md subtitle** — 1 min
5. **Fix weak test assertion** (branch checkout test) — 5 min
6. **Add missing test case** (git commit failure) — 5 min
7. **Add CLI fallback for v0.8.0 loops** (gitCommitSha/gitBranch) — 3 min

### Recommended Before Merge (Should-Fix)
8. **Extract git state capture to shared helper** — 5 min
9. **Extract git setup from startNextIteration** — 10 min
10. **Extract revert logic from recordAndContinue** — 5 min
11. **Fix redundant rev-parse in loop creation** — 3 min
12. **Add comments to legacy gitBranch writes** — 2 min

### After Merge (Nice-to-Have)
13. Run full test suite and verify all passing
14. Manual test: create git-enabled loop, observe commit history
15. Manual test: agent failure in git-enabled loop, verify reset occurs
16. Prepare v0.8.1 release and publish to npm

---

## CONFIDENCE ANALYSIS

| Finding | Reviewers | Combined Confidence |
|---------|-----------|-------------------|
| Missing git reset on TaskFailed (CRITICAL) | Consistency, Regression, Tests | **85%** (multiple independent confirmation) |
| Duplicated git capture (HIGH) | Architecture, Complexity, Performance | **85%** |
| Sequential git operations (HIGH) | Performance (2 findings) | **90%+** |
| Test assertion weakness | Tests (2 findings) | **90%+** |
| Documentation issues | Documentation (2 findings) | **85-95%** |

All BLOCKING findings have **≥80% confidence** across multiple independent reviewers. This indicates robust pattern recognition, not noise.

---

## NEXT STEPS

1. **Create a new branch** from fix/git-integration to address these findings
2. **Apply all blocking fixes** (Issues 1-4)
3. **Apply should-fix improvements** (Issues 5-12) — these make the code more maintainable
4. **Re-test all paths** via:
   - `npm run test:core` (domain changes)
   - `npm run test:handlers` (loop-handler, schedule-handler changes)
   - `npm run test:integration` (end-to-end git workflows)
   - `npm run test:all` (full suite, in terminal)
5. **Re-run Snyk** to ensure no new issues introduced
6. **Re-request review** on updated PR
7. **Merge and release** v0.8.1

---

## Files Affected (Summary)

| File | Changes | Risk |
|------|---------|------|
| `src/services/handlers/loop-handler.ts` | Add reset logic to TaskFailed paths (2 locations); extract helpers (2 extractions) | **HIGH** — core event handler |
| `src/services/loop-manager.ts` | Deduplicate git capture logic → extract helper | **LOW** — refactor only |
| `src/services/handlers/schedule-handler.ts` | Deduplicate git capture logic → extract helper | **LOW** — refactor only |
| `tests/unit/services/handlers/loop-handler.test.ts` | Fix weak assertions, add missing cases | **LOW** — test improvements |
| `tests/unit/utils/git-state.test.ts` | Add missing error-path test | **LOW** — test improvements |
| `docs/releases/RELEASE_NOTES_v0.8.1.md` | Create new file | **LOW** — documentation |
| `docs/releases/RELEASE_NOTES_v0.8.0.md` | Update line 3 | **LOW** — documentation |
| `src/cli/commands/loop.ts` | Add CLI fallback for v0.8.0 loops | **LOW** — backward compatibility |

---

**Report Generated**: 2026-03-25 20:11
**Branch**: fix/git-integration
**Base**: main
