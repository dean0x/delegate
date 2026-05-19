# Security Review Report

**Branch**: feat-agent-eval-mode -> main
**Date**: 2026-03-30
**PR**: #125

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Unbounded `evalFeedback` stored in SQLite without size limits** - `src/services/agent-exit-condition-evaluator.ts:234-235`, `src/implementations/loop-repository.ts:269`
**Confidence**: 85%
- Problem: The `evalFeedback` field is constructed from the entire eval agent output (minus the last line) and stored directly in the `loop_iterations` table with no size cap. A misbehaving or manipulated eval agent could produce arbitrarily large output (megabytes), which gets stored verbatim in the `eval_feedback TEXT` column. Over many iterations, this could exhaust SQLite storage or cause performance degradation when querying iteration history.
- Impact: Potential denial-of-service via database bloat. The `LoopStatus` MCP tool and `beat loop status --history` CLI command read all iterations, so large feedback values amplify the read cost.
- Fix: Truncate feedback before storage, consistent with how `evalPrompt` is capped at 8000 chars in the Zod schema. Apply in `parseEvalOutput`:
  ```typescript
  // In parseEvalOutput, after constructing feedback:
  const MAX_FEEDBACK_LENGTH = 16000; // ~16KB reasonable limit
  const feedback = feedbackLines.length > 0
    ? feedbackLines.join('\n').slice(0, MAX_FEEDBACK_LENGTH)
    : undefined;
  ```

**No `evalTimeout` upper-bound enforcement in Zod schema** - `src/adapters/mcp-adapter.ts:255-260`
**Confidence**: 82%
- Problem: The MCP adapter's Zod schema for `evalTimeout` has `min(1000)` but no `.max()`. While the `LoopManagerService.validateCreateRequest()` enforces 300s/600s limits downstream, the Zod layer at the adapter boundary does not. A caller could send `evalTimeout: 999999999` which would pass Zod validation and only be caught by the service layer. This creates an inconsistency where the MCP schema description says "max: shell=300s, agent=600s" but the schema itself does not enforce it.
- Impact: Low direct risk due to defense-in-depth (service layer catches it), but violates the "validate at boundaries" principle. The description promises a constraint the schema does not enforce.
- Fix: Add `.max(600000)` to the Zod schema (use the higher agent limit; the service layer handles mode-specific enforcement):
  ```typescript
  evalTimeout: z
    .number()
    .min(1000)
    .max(600000)
    .optional()
    .default(60000)
    .describe('Eval timeout in ms (max: shell=300s, agent=600s)'),
  ```
  Apply to both `CreateLoopSchema` and `ScheduleLoopSchema`.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Eval task inherits `workingDirectory` without isolation** - `src/services/agent-exit-condition-evaluator.ts:47-52`
**Confidence**: 80%
- Problem: The eval agent task is created with `workingDirectory: loop.workingDirectory`, which is the same directory the work task just modified. The eval agent has full read/write access to this directory, meaning it could modify files, commit changes, or interfere with the loop's git state. While the eval task is architecturally designed to only read and evaluate, there is no enforcement of read-only access.
- Impact: An eval agent that produces side effects (writes files, modifies git state) could corrupt the loop's working directory. This is particularly concerning because the eval agent runs after the work task but before `handleIterationGitOutcome` processes the git state.
- Fix: This is an inherent limitation of the agent execution model. Document the constraint explicitly and consider adding a comment in `buildEvalPrompt` instructing the eval agent not to modify files:
  ```typescript
  const instructions = loop.evalPrompt ?? defaultInstructions;
  const safetyNote = 'IMPORTANT: Do NOT modify any files. You are an evaluator — read and assess only.';
  ```
  A stronger mitigation would be to use a temporary worktree clone for eval, but that is a significant architectural change.

## Pre-existing Issues (Not Blocking)

No critical pre-existing security issues found in the reviewed files.

## Suggestions (Lower Confidence)

- **`preIterationCommitSha` interpolated into prompt without validation** - `src/services/agent-exit-condition-evaluator.ts:132` (Confidence: 65%) -- The SHA is interpolated into a git diff command instruction string. While the SHA comes from the database (inserted by the system itself, not user input), and git SHAs are hex-only, a corrupted database row with a malicious string could theoretically inject prompt content. Risk is very low given the data provenance.

- **Custom `evalPrompt` could contain prompt injection attempts** - `src/services/agent-exit-condition-evaluator.ts:142` (Confidence: 70%) -- A user-supplied `evalPrompt` is injected directly into the eval agent prompt. While the eval agent operates in a sandboxed task context and its output is parsed structurally (PASS/FAIL or numeric score), a crafted `evalPrompt` could attempt to manipulate the eval agent's behavior. The structural parsing (last-line-only) provides natural mitigation, and the `[EVAL]` prefix helps distinguish eval tasks.

- **Agent eval mode with `maxIterations: 0` (unlimited) and no `evalTimeout` override could spawn unbounded eval tasks** - `src/services/agent-exit-condition-evaluator.ts:44` (Confidence: 60%) -- Each iteration in agent eval mode spawns an additional task (the eval task). With unlimited iterations, this doubles the task throughput. The existing `maxConsecutiveFailures` and `evalTimeout` provide natural bounds, but the resource impact of eval tasks is not documented.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Security Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The agent eval mode feature is well-designed from a security perspective. Key strengths:
1. Input validation is thorough -- `evalMode` is enum-constrained, `evalPrompt` has a Zod max length (8000), `evalTimeout` has mode-specific upper bounds at the service layer.
2. The eval task is created through the existing `TaskDelegated` event pipeline, inheriting all existing security controls (path validation, agent configuration).
3. Output parsing is defensive -- only the last line determines the result, and `Number.isFinite()` guards against NaN/Infinity.
4. The stale-state guard (re-fetch after eval) prevents TOCTOU issues.

Conditions for merge:
1. Add feedback size truncation to prevent unbounded database storage.
2. Add `.max(600000)` to `evalTimeout` in MCP Zod schemas for boundary-consistent validation.
