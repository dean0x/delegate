# Architecture Review Report

**Branch**: fix/orchestrator-loop-termination -> main
**Date**: 2026-05-14
**PR**: #173

## Issues in Your Changes (BLOCKING)

### HIGH

**Eval prompt string literal embedded in service layer** - `src/services/orchestration-manager.ts:238-247`
**Confidence**: 85%
- Problem: The eval prompt for the agent evaluator is a multi-line string literal hardcoded inside `createOrchestration()`. This prompt is domain-specific configuration (it defines how goal achievement is assessed) and will likely need tuning, versioning, or per-orchestration customization. Embedding it as a string constant in the service method conflates prompt engineering with orchestration lifecycle management, violating SRP.
- Impact: Every change to the eval prompt requires modifying the service class. Prompt content is not testable in isolation. If different orchestration types need different eval prompts in the future, this becomes a conditional branching problem inside the service.
- Fix: Extract the eval prompt to a dedicated builder function in `orchestrator-prompt.ts` (which already houses all other prompt-building logic) and import it into the service. This keeps prompt engineering co-located and independently testable:
  ```typescript
  // orchestrator-prompt.ts
  export function buildGoalEvalPrompt(goal: string): string {
    return `You are evaluating whether an orchestration goal has been achieved.\n\nGoal: "${goal}"\n\n...`;
  }
  ```

### MEDIUM

**LoopHandler class continues to grow (2056 lines, ~42 private methods)** - `src/services/handlers/loop-handler.ts`
**Confidence**: 82%
- Problem: This PR adds `checkConvergence()`, `enrichPromptWithGitContext()`, and `parseGitDiffChangedLines()` to `LoopHandler`, which is already at 2056 lines and ~42 private methods. The class is approaching god-class territory. The new convergence detection and git context injection are orthogonal concerns to iteration lifecycle management.
- Impact: The class has multiple independent reasons to change: iteration lifecycle, git operations, convergence heuristics, and prompt enrichment. Adding more features here increases cognitive load and makes targeted testing harder.
- Fix: This is not blocking for this PR (the new methods are well-scoped and documented), but consider extracting in a follow-up:
  - `ConvergenceDetector` (or a standalone function) for `checkConvergence` + `parseGitDiffChangedLines`
  - `PromptEnricher` for `enrichPromptWithCheckpoint` + `enrichPromptWithGitContext`
  Both would be injected into LoopHandler via constructor, maintaining the DI pattern.

**`setupStateFiles` is now partially dead code for the default orchestration path** - `src/services/orchestration-manager.ts:99-145`
**Confidence**: 83%
- Problem: `setupStateFiles()` is no longer called by `createOrchestration()` (the default path), only by `createInteractiveOrchestration()`. The method's `withExitScript` parameter and the `cleanupFiles` helper with its traversal-attack guard are dead code for the primary code path. The method itself remains necessary for interactive orchestrations, but its generality is now misleading.
- Impact: Future developers may assume `setupStateFiles` is used by default orchestrations. The exit-condition-script branch (`withExitScript: true`) is now only reachable from scaffold code, not from the service. Minor maintenance burden.
- Fix: Add a JSDoc note clarifying the method is now only used by interactive orchestrations. Consider renaming to `setupInteractiveStateFiles` in a follow-up to make the scope explicit.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Convergence constants are module-level but non-configurable** - `src/services/handlers/loop-handler.ts:58-64`
**Confidence**: 80%
- Problem: `CONVERGENCE_WINDOW`, `CONVERGENCE_MIN_ITERATIONS`, `CONVERGENCE_MAX_CHANGED_LINES`, and `MAX_GIT_CONTEXT_BYTES` are hardcoded module-level constants. While the values are reasonable defaults, convergence behavior is inherently domain-specific -- a loop working on documentation changes will converge at different thresholds than one working on a large refactoring. There is no way for users to override these without modifying source code.
- Impact: Users cannot tune convergence sensitivity. A 10-line threshold may be too aggressive for some workflows (e.g., formatting-only changes that produce small but meaningful diffs).
- Fix: Consider making these configurable via the `Loop` domain object's optional fields (e.g., `convergenceThreshold?: number`) in a follow-up, with the current constants as defaults. This is not blocking since the feature is new and the defaults are conservative.

## Pre-existing Issues (Not Blocking)

(No pre-existing CRITICAL issues found in the reviewed files.)

## Suggestions (Lower Confidence)

- **Binary search truncation creates `O(n * n log n)` work due to repeated `Buffer.byteLength(lines.slice(0, mid).join('\n'))` calls** - `src/services/handlers/loop-handler.ts:1709-1715` (Confidence: 70%) -- Each binary search probe recomputes byte length from scratch by joining a prefix of the lines array. For the typical case (git context < 4KB, ~50 lines), this is fast, but the algorithmic complexity comment in the commit message ("O(n log n)") understates the cost since `join` + `byteLength` is O(k) per probe where k = number of joined characters. A prefix-sum approach would be truly O(n) once, O(log n) lookups. Likely not worth optimizing given the small input size, but the comment should be accurate.

- **`stateFilePath: string | undefined` parameter type in `buildFinalPrompts` vs empty string sentinel** - `src/services/orchestration-manager.ts:347` (Confidence: 65%) -- The method accepts `string | undefined` but the caller passes `''` (empty string) which is then converted to `undefined` via `stateFilePath || undefined`. This dual representation (empty string at the domain boundary, undefined at the prompt builder) creates a subtle type inconsistency. A branded type or explicit `Option<string>` would be cleaner.

- **Convergence detection in `checkTerminationConditions` is async but the method name does not signal I/O** - `src/services/handlers/loop-handler.ts:1191-1192` (Confidence: 62%) -- `checkTerminationConditions` was previously a synchronous-logic method (comparing numbers). Adding the async `checkConvergence()` call changes its contract to include DB I/O. The method name no longer reflects this. Consider renaming or documenting the I/O dependency.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Architecture Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The architectural change is well-motivated -- switching from shell exit condition scripts (which workers cannot write) to agent eval mode eliminates a real deadlock. The convergence detection and git context injection are solid additions with clean separation of concerns within the methods themselves.

The primary condition is extracting the eval prompt string from the service layer into `orchestrator-prompt.ts` to maintain the established pattern where all prompt construction lives in the prompt builder module. The LoopHandler growth and convergence constant configurability are noted for follow-up but do not block merge. avoids PF-001 -- all issues are surfaced with explicit disposition rather than deferred silently.
