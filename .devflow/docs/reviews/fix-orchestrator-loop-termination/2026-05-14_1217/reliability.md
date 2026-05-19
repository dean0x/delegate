# Reliability Review Report

**Branch**: fix/orchestrator-loop-termination -> main
**Date**: 2026-05-14

## Issues in Your Changes (BLOCKING)

### HIGH

**Convergence detection has no opt-out mechanism -- loops that legitimately produce small diffs will terminate prematurely** - `src/services/handlers/loop-handler.ts:1211`
**Confidence**: 85%
- Problem: `checkConvergence()` is always active on every loop via `checkTerminationConditions()`. The hardcoded `CONVERGENCE_MAX_CHANGED_LINES = 10` threshold triggers on any git-enabled loop where 3 consecutive iterations each produce fewer than 10 changed lines. This is correct for stuck orchestrators, but a code-review loop, linting loop, or documentation-fixup loop may legitimately produce small diffs per iteration and get terminated early. There is no domain-level configuration to disable convergence or adjust the threshold.
- Fix: Add an optional `convergenceEnabled` (default `true`) or `convergenceThreshold` field to the `Loop` domain type and `LoopCreateRequest`. Check it at the top of `checkConvergence()`:
```typescript
private async checkConvergence(loop: Loop): Promise<boolean> {
  if (loop.convergenceEnabled === false) return false;
  // ... rest of method
}
```
This preserves the default behavior for orchestrators while giving explicit loop creators an escape hatch.

### MEDIUM

**Binary search truncation can produce an empty git context block prepended to the prompt** - `src/services/handlers/loop-handler.ts:1703-1720`
**Confidence**: 82%
- Problem: When even a single line of the git context exceeds `MAX_GIT_CONTEXT_BYTES` (4096), the binary search converges to `lo = 0`. The resulting `lines.slice(0, 0).join('\n')` is an empty string, but the return statement still prepends `"\n\n---\n\n"` before the prompt. This injects a meaningless separator into the agent's prompt. While not a crash, it wastes prompt tokens and could confuse the agent.
- Fix: Guard against the empty-context case after truncation:
```typescript
gitContext = lines.slice(0, lo).join('\n');
if (!gitContext) return prompt; // Nothing fit within budget — skip enrichment entirely
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Score plateau detection uses strict equality which silently fails for floating-point scores** - `src/services/handlers/loop-handler.ts:1252`
**Confidence**: 80%
- Problem: `scores.every((s) => s === scores[0])` uses `===` to detect score plateaus. Floating-point arithmetic can produce scores like `0.8500000000000001` and `0.85` that are functionally identical but not strictly equal. This means the plateau detector would fail to fire for legitimate plateaus produced by floating-point evaluators, causing the loop to continue unnecessarily until `maxIterations`.
- Fix: Use an epsilon comparison for floating-point tolerance:
```typescript
const SCORE_EPSILON = 1e-9;
const allSame = scores.every((s) => Math.abs(s - scores[0]) < SCORE_EPSILON);
```

## Pre-existing Issues (Not Blocking)

(No CRITICAL pre-existing reliability issues found in reviewed files.)

## Suggestions (Lower Confidence)

- **Git context enrichment fires two sequential async calls where parallel would suffice** - `src/services/handlers/loop-handler.ts:1686-1687` (Confidence: 65%) -- `getRecentGitLog` and `getRecentGitDiffStat` are independent and could be dispatched with `Promise.all()` to halve latency. Not a correctness issue but adds ~30s worst-case per iteration (two sequential git timeouts).

- **Convergence detection queries the database on every iteration completion even when the loop has fewer than 3 iterations** - `src/services/handlers/loop-handler.ts:1192` (Confidence: 70%) -- `checkConvergence()` always calls `this.loopRepo.getIterations()` then checks `completed.length < CONVERGENCE_MIN_ITERATIONS`. An early guard `if (loop.currentIteration < CONVERGENCE_MIN_ITERATIONS) return false` before the async DB call would avoid unnecessary I/O for the first 2 iterations of every loop.

- **`getRecentGitDiffStat` uses `HEAD~N` notation which fails on shallow clones** - `src/utils/git-state.ts:320` (Confidence: 62%) -- In shallow-cloned repositories (common in CI), `HEAD~5` will error if fewer than 5 commits are available. The function correctly returns `ok(null)` on non-timeout errors, but the error is silent. This may cause freshContext enrichment to silently skip git context in CI environments without any log entry.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Reliability Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The core fix (replacing shell exit-condition deadlock with agent eval mode) is a significant reliability improvement -- it eliminates the fundamental termination deadlock. The convergence detection and binary search truncation are well-bounded (satisfying the bounded-iteration reliability rule). The binary search has a provable upper bound of `ceil(log2(n))` iterations, and convergence detection constants are defined as named constants with clear JSDoc.

The HIGH finding (no opt-out for convergence detection) is the primary concern: it introduces a new implicit termination path that cannot be disabled by callers. Loops with legitimately small per-iteration diffs (review, lint, docs) may terminate prematurely after 3 iterations. This should be addressed before merge by either adding a domain-level opt-out or increasing the minimum iterations threshold.
