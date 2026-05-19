# Code Review Summary

**Branch**: fix/orchestrator-loop-termination -> main  
**Date**: 2026-05-14_1217  
**Reviewers**: 9 (security, architecture, performance, complexity, consistency, regression, testing, reliability, typescript)

---

## Merge Recommendation: CHANGES_REQUESTED

**Core Issue**: The PR eliminates a critical deadlock in orchestration loop termination (shell exit-condition script deadlock) and adds solid features (convergence detection, git context injection, binary search optimization). However, **4 blocking MEDIUM issues + 1 blocking HIGH issue** must be resolved before merge.

**Blocking Issues Summary**:
1. **Architecture (HIGH, 85%)**: Eval prompt string embedded in service layer — should live in `orchestrator-prompt.ts`
2. **Performance (HIGH, 92%)**: Sequential git commands should use `Promise.all` to halve latency
3. **Reliability (HIGH, 85%)**: Convergence detection has no opt-out — loops with legitimately small diffs will terminate prematurely
4. **Regression (MEDIUM, 82%)**: Test fidelity lost — compensation tests now vacuously pass for agent eval mode
5. **Regression (MEDIUM, 85%)**: Inconsistent state file guidance between two code paths that should stay in sync

---

## Issue Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW | Total |
|----------|----------|------|--------|-----|-------|
| Blocking | 0 | 2 | 3 | 0 | **5** |
| Should Fix | 0 | 0 | 4 | 0 | **4** |
| Pre-existing | 0 | 0 | 0 | 0 | 0 |

---

## Blocking Issues (Must Fix Before Merge)

### HIGH

**1. Eval prompt location — move from service to prompt builder** — `src/services/orchestration-manager.ts:238-247`
- **Severity**: HIGH (Architecture)
- **Confidence**: 85%
- **Problem**: The 11-line eval prompt for agent evaluator is hardcoded as a string literal inside `createOrchestration()`. This embeds domain-specific configuration in the service layer, violating SRP. The eval prompt is configuration that will likely need tuning or per-orchestration customization; it belongs with other prompt-building logic.
- **Impact**: Every eval prompt change requires modifying the service. Prompt content is not testable in isolation. Future orchestration types with different eval prompts become conditional logic inside the service.
- **Fix**: Extract to `orchestrator-prompt.ts`:
  ```typescript
  export function buildGoalEvalPrompt(goal: string): string {
    const escapedGoal = goal.replace(/"/g, '\\"');
    return `You are evaluating whether an orchestration goal has been achieved.\n\nGoal: "${escapedGoal}"\n\n...`;
  }
  ```
  Import and call in `createOrchestration()`. Also fixes the prompt injection issue (see Security MEDIUM below).

**2. Sequential git commands should parallelize** — `src/services/handlers/loop-handler.ts:1686-1687`
- **Severity**: HIGH (Performance)
- **Confidence**: 92%
- **Problem**: `getRecentGitLog` and `getRecentGitDiffStat` are independent async calls that are awaited sequentially. Wall-clock time is the sum of both commands (~50-200ms typical) instead of the max.
- **Impact**: Every freshContext loop iteration > 1 is delayed by the total latency of both git commands instead of the max.
- **Fix**: Use `Promise.all`:
  ```typescript
  const [gitLogResult, gitDiffStatResult] = await Promise.all([
    getRecentGitLog(loop.workingDirectory, 15),
    getRecentGitDiffStat(loop.workingDirectory, 5),
  ]);
  ```

**3. Convergence detection has no opt-out — hardcoded thresholds will terminate small-diff loops prematurely** — `src/services/handlers/loop-handler.ts:1211`
- **Severity**: HIGH (Reliability)
- **Confidence**: 85%
- **Problem**: `checkConvergence()` is always active with hardcoded `CONVERGENCE_MAX_CHANGED_LINES = 10`. Any git-enabled loop producing <10 lines changed in 3 consecutive iterations terminates automatically. But a code-review loop, linting loop, or docs-fixup loop may legitimately produce small diffs and get terminated early. There is no way to disable or tune this behavior.
- **Impact**: Users have no control over convergence sensitivity. Loops with legitimate small-diff workflows will terminate prematurely without ability to override.
- **Fix**: Add optional `convergenceEnabled` field to `Loop` domain type and `LoopCreateRequest`:
  ```typescript
  interface Loop {
    // ... existing fields
    readonly convergenceEnabled?: boolean; // default: true
  }
  
  private async checkConvergence(loop: Loop): Promise<boolean> {
    if (loop.convergenceEnabled === false) return false;
    // ... rest of method
  }
  ```

### MEDIUM

**4. Inconsistent state file guidance between snippet builder and orchestrator prompt** — `src/services/orchestrator-prompt.ts:126-128` vs `227-234`
- **Severity**: MEDIUM (Regression)
- **Confidence**: 82%
- **Problem**: `buildStateManagementInstructions()` (scaffold path) says "Optionally write the state file", but `buildOrchestratorPrompt()` (full path) says "Always write the state file". Two code paths that historically stayed in sync have diverged. The scaffold tests that detect drift were also weakened (status markers removed from shared-marker checks).
- **Impact**: Users who scaffold a custom orchestrator get inconsistent guidance vs the full prompt. Maintenance burden increases; future changes risk further drift.
- **Fix**: Decide on one semantic and apply consistently:
  - If optional for both: update `resilienceSection` in `buildOrchestratorPrompt()` to match snippet builder
  - If mandatory only for scaffold: document the distinction explicitly with a JSDoc DECISION comment

**5. Compensation tests now vacuously pass because stateFilePath is always empty string** — `tests/integration/orchestration-lifecycle.test.ts:207, 239`
- **Severity**: MEDIUM (Regression, Testing)
- **Confidence**: 85%
- **Problem**: Tests assert `expect(existsSync(failedOrch.stateFilePath)).toBe(false)`. Since `stateFilePath` is now `''` (empty string), `existsSync('')` always returns `false` regardless of implementation. The test description says "state file removed" but the test validates nothing — it's a vacuous assertion.
- **Impact**: Test suite lost its ability to catch regressions in compensation cleanup behavior. Future changes that break cleanup won't be caught.
- **Fix**: Update assertions to reflect the new behavior:
  ```typescript
  // Agent eval mode: no state file is ever created
  expect(failedOrch.stateFilePath).toBe('');
  ```

**6. stateFilePath coercion inconsistency: empty string at call site, undefined coercion at definition** — `src/services/orchestration-manager.ts:232, 357`
- **Severity**: MEDIUM (TypeScript, Consistency)
- **Confidence**: 85%
- **Problem**: Parameter type is `stateFilePath: string | undefined`, caller passes `''` (empty string), method coerces it with `stateFilePath || undefined`. This dual representation creates a confusing abstraction where the parameter type says one thing but the function body relies on truthiness.
- **Impact**: Mixed representation reduces clarity. A future caller passing `undefined` directly would work, but the empty-string intermediate value is a confusing artifact.
- **Fix**: Pass `undefined` directly instead of `''`:
  ```typescript
  // orchestration-manager.ts:232
  buildFinalPrompts(loop, loop.systemPrompt, undefined); // was: ''
  ```

---

## Should-Fix Issues (Deferred Only With Justification)

### MEDIUM

**7. Prompt injection vector via unsanitized goal text in evalPrompt** — `src/services/orchestration-manager.ts:240`
- **Severity**: MEDIUM (Security)
- **Confidence**: 82%
- **Problem**: User-supplied `request.goal` is interpolated directly: `Goal: "${request.goal}"`. Adversarial goal containing `"\n\nIgnore all prior instructions...` could manipulate the evaluator agent.
- **Impact**: Limited to single-user MCP context (no cross-tenant risk), but a crafted goal could cause loop termination bypass.
- **Fix**: Escape with XML-style delimiters (also fixes issue #1 when eval prompt is extracted):
  ```typescript
  const escapedGoal = goal.replace(/"/g, '\\"');
  return `...Goal:\n<goal>${escapedGoal}</goal>\n...`;
  ```

**8. Binary search truncation can produce empty git context block** — `src/services/handlers/loop-handler.ts:1703-1720`
- **Severity**: MEDIUM (Reliability)
- **Confidence**: 82%
- **Problem**: When even a single line exceeds `MAX_GIT_CONTEXT_BYTES` (4096), binary search converges to `lo = 0`. The return still prepends `\n\n---\n\n` before the prompt, creating a meaningless separator.
- **Impact**: Wastes prompt tokens, confuses agent.
- **Fix**: Guard against empty context:
  ```typescript
  gitContext = lines.slice(0, lo).join('\n');
  if (!gitContext) return prompt; // Nothing fit — skip enrichment
  ```

**9. Score plateau detection uses strict equality for floating-point values** — `src/services/handlers/loop-handler.ts:1252`
- **Severity**: MEDIUM (Reliability)
- **Confidence**: 80%
- **Problem**: `scores.every((s) => s === scores[0])` uses `===`. Floating-point arithmetic can produce `0.8500000000000001` vs `0.85` that are functionally identical but not strictly equal. Plateau detector silently fails.
- **Impact**: Loop continues unnecessarily until `maxIterations` instead of stopping at convergence.
- **Fix**: Use epsilon comparison:
  ```typescript
  const SCORE_EPSILON = 1e-9;
  const allSame = scores.every((s) => Math.abs(s - scores[0]) < SCORE_EPSILON);
  ```

**10. `as never` type assertion in test hides incompatibility** — `tests/unit/services/handlers/loop-handler.test.ts:2533`
- **Severity**: MEDIUM (TypeScript)
- **Confidence**: 82%
- **Problem**: `new Error('git not found') as never` casts to suppress type check. Could mask real incompatibilities if `Result` error type changes.
- **Impact**: Test type safety reduced.
- **Fix**: Use correct error type:
  ```typescript
  error: new AutobeatError(ErrorCode.SYSTEM_ERROR, 'git not found'),
  ```

---

## Testing Issues

**HIGH**

**11. Missing test: binary search truncation when git context exceeds 4KB** — `src/services/handlers/loop-handler.ts:1701-1718`
- **Severity**: HIGH (Testing)
- **Confidence**: 92%
- **Problem**: Non-trivial truncation algorithm has zero test coverage. If binary search has off-by-one error, prompt could be empty or exceed budget.
- **Impact**: Critical path untested.
- **Fix**: Add test mocking `getRecentGitLog` to return 5000+ bytes, verify truncation.

**12. Missing test: convergence detection for non-git loops (no gitBranch)** — `src/services/handlers/loop-handler.ts:1227`
- **Severity**: HIGH (Testing)
- **Confidence**: 85%
- **Problem**: Convergence has explicit `isGitLoop` guard, but no test verifies it skips correctly. All tests set `gitBranch`.
- **Impact**: Guard could be accidentally removed without test failure.
- **Fix**: Add test case running 3 iterations on non-git loop, verifying status is RUNNING (not COMPLETED).

---

## Architectural Issues (Noted, Non-Blocking)

### Should-Address (Follow-Up)

- **LoopHandler class continues to grow** (2056 lines, 42 methods) — Consider extracting convergence detection and git context enrichment into collaborator modules in next release
- **setupStateFiles is now partially dead code** — Add JSDoc clarifying it's only used by interactive orchestrations
- **buildOrchestratorPrompt branching complexity** — Triple-ternary conditionals on `stateFilePath` should be consolidated into single decision point
- **Convergence constants are hardcoded and non-configurable** — Track for future per-loop tuning via domain-level config fields

---

## Strengths

1. **Core deadlock fix is solid** — Switching from shell exit-condition script (which workers cannot write) to agent eval mode eliminates a fundamental architectural deadlock
2. **Convergence detection is well-bounded** — Constants are named, threshold logic is clear, min iterations protect early stages
3. **Binary search optimization is correct** — Provably bounded at `ceil(log2(n))` iterations, eliminates O(n^2) truncation loop
4. **Git utilities follow existing patterns** — Use `execFile` (not `exec`), validate inputs, enforce timeouts
5. **Test coverage is thorough in breadth** — All four major features have dedicated test blocks with real SQLite and TestEventBus
6. **Result type consistency** — All fallible operations use `Result<T, AutobeatError>` consistently

---

## Action Plan

1. **MUST FIX (High Priority)**:
   - Move eval prompt to `orchestrator-prompt.ts` (also fixes security issue) — issue #1
   - Parallelize git commands with `Promise.all` — issue #2
   - Add convergence opt-out to `Loop` domain type — issue #3

2. **SHOULD FIX (Medium Priority)**:
   - Align state file guidance between two code paths — issue #4
   - Fix compensation test vacuous assertions — issue #5
   - Remove stateFilePath coercion (`''` → undefined) — issue #6
   - Add binary search truncation test — issue #11
   - Add non-git convergence test — issue #12

3. **CAN DEFER (Low Priority)**:
   - Security: Escape goal text with XML delimiters — issue #7 (limited scope, single-user context)
   - Reliability: Guard empty git context — issue #8
   - Reliability: Use epsilon for float comparison — issue #9
   - TypeScript: Fix test type assertion — issue #10

4. **FOLLOW-UP WORK (Post-Merge)**:
   - Extract convergence detection to module
   - Consolidate `buildOrchestratorPrompt` branching
   - Make convergence thresholds configurable per loop

---

## Quality Assessment

**Code Quality**: 8/10 — Well-structured individual methods, clear naming, good boundary validation. Complexity increases mainly due to feature additions rather than poor design.

**Test Quality**: 7/10 — Thorough breadth, behavioral testing approach, real implementations. Two HIGH-confidence gaps in coverage (truncation and non-git guard).

**Reliability**: 7/10 — Core fix is solid. Convergence detection and binary search are bounded. Main concern is lack of opt-out for convergence (HIGH).

**Architecture**: 7/10 — Eval prompt placement is the main issue (SRP violation). LoopHandler growth noted but not blocking.

**Overall**: The fix addresses a real deadlock and adds valuable features, but needs 5 issues resolved (1 HIGH, 4 MEDIUM) and 2 test additions before merge is safe.
