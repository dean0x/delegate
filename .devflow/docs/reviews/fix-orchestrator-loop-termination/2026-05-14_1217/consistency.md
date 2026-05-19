# Consistency Review Report

**Branch**: fix/orchestrator-loop-termination -> main
**Date**: 2026-05-14

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Context placement inconsistency between enrichPromptWithCheckpoint and enrichPromptWithGitContext** - `src/services/handlers/loop-handler.ts:1720`
**Confidence**: 85%
- Problem: `enrichPromptWithCheckpoint` appends context AFTER the original prompt (`contextParts = [prompt, ..., context]` then joins), while `enrichPromptWithGitContext` prepends context BEFORE the prompt (`${gitContext}\n\n---\n\n${prompt}`). When both methods serve the same purpose (enriching the iteration prompt with cross-iteration context), opposite placement breaks the implicit contract that context sections follow the same structural pattern. An agent receiving context-before-prompt in freshContext mode and context-after-prompt in checkpoint mode encounters inconsistent prompt structures.
- Fix: Choose one direction and apply consistently. Given that `enrichPromptWithCheckpoint` appends (which is the established pattern), consider appending in `enrichPromptWithGitContext` as well:
  ```typescript
  return `${prompt}\n\n---\n\n${gitContext}`;
  ```
  Alternatively, if prepending is the intentional choice for freshContext (e.g., context should appear first because the agent has no memory), add a JSDoc DECISION comment explaining why the two methods differ.

**Redundant truthiness guard on required `workingDirectory` field** - `src/services/handlers/loop-handler.ts:709`
**Confidence**: 82%
- Problem: The guard `if (loop.freshContext && iterationNumber > 1 && loop.workingDirectory)` checks `loop.workingDirectory` as if it could be falsy. However, `Loop.workingDirectory` is typed as `readonly workingDirectory: string` (required, non-optional) on the `Loop` interface at `domain.ts:622`. This guard is inconsistent with how `workingDirectory` is treated elsewhere in the same file -- e.g., `enrichPromptWithCheckpoint` and `setupGitForIteration` access `loop.workingDirectory` without truthiness checks. Defense-in-depth is fine, but inconsistent application of the pattern reads as if the property might actually be optional.
- Fix: Either remove the guard (matching the pattern used in other methods that access `loop.workingDirectory`) or add a brief comment explaining the defense-in-depth rationale:
  ```typescript
  // Defense-in-depth: workingDirectory is required on Loop but may be empty for non-directory loops
  if (loop.freshContext && iterationNumber > 1 && loop.workingDirectory) {
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`stateFilePath` parameter coercion inconsistency in buildFinalPrompts** - `src/services/orchestration-manager.ts:347,357`
**Confidence**: 85%
- Problem: The `buildFinalPrompts` parameter type was changed to `stateFilePath: string | undefined`, but the first call site passes the empty string literal `''` (line 232) while internally the method coerces it via `stateFilePath: stateFilePath || undefined` (line 357). This means the caller passes `''`, the method converts it to `undefined`, and `buildOrchestratorPrompt` receives `undefined`. The second call site (`createInteractiveOrchestration` at line 405) passes the actual path string. This mixed representation (empty string at the domain level in `createOrchestration`, actual path in `createInteractiveOrchestration`) creates an inconsistency where "no state file" is represented as both `''` and `undefined` depending on context. The `OrchestrationRowSchema` validates `state_file_path: z.string()` (allowing empty), so the DB stores `''`, but the prompt builder receives `undefined`. The overall intent is clear, but the dual representation is a consistency gap.
- Fix: Pick one canonical representation for "no state file" and use it consistently. Since the DB stores `''` and the `Orchestration` domain type has `stateFilePath: string`, the simplest fix is to have `buildOrchestratorPrompt` accept `string` (not `string | undefined`) and check for empty string internally:
  ```typescript
  // In buildOrchestratorPrompt:
  const hasStateFile = !!stateFilePath;
  const stateFileSection = hasStateFile ? `STATE FILE: ${stateFilePath}...` : '';
  ```
  This avoids the `|| undefined` coercion and keeps the empty-string convention consistent from DB through to prompt builder.

## Pre-existing Issues (Not Blocking)

(none found at CRITICAL severity)

## Suggestions (Lower Confidence)

- **Missing closing `---` delimiter in enrichPromptWithGitContext context block** - `src/services/handlers/loop-handler.ts:1695-1720` (Confidence: 68%) -- `enrichPromptWithCheckpoint` closes each context section with `contextParts.push('---')`, but `enrichPromptWithGitContext` opens with `--- Iteration N Context ---` and closes with just `---\n\n` in the template literal. The existing pattern uses triple-dash delimiters symmetrically around context blocks; the new method uses them asymmetrically.

- **evalPrompt string literal embedded directly in service method** - `src/services/orchestration-manager.ts:238-247` (Confidence: 65%) -- All other prompt construction in the orchestrator flow uses `orchestrator-prompt.ts` (a dedicated module for prompt building). The new `evalPrompt` is a multi-line template literal built inline in the manager service. For consistency with the existing prompt-building architecture, this could be extracted to a builder function in `orchestrator-prompt.ts`.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Consistency Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The changes are well-structured overall. The agent eval mode switch, convergence detection, git context injection, and binary search truncation all follow existing codebase patterns for error handling (Result types), logging (structured JSON context), boundary validation (integer guards), and test patterns (behavior-focused with real implementations). The new `git-state.ts` functions (`getRecentGitLog`, `getRecentGitDiffStat`) correctly follow sibling function patterns (execFile, timeout, `Result<T | null>` return, input validation). Test coverage is thorough with edge cases (null, undefined, empty, non-git). The three findings above are style/consistency items that do not affect correctness. The state file removal for default orchestrations is clean and avoids backward-compatibility scaffolding for the internal-only feature (avoids PF-002).
