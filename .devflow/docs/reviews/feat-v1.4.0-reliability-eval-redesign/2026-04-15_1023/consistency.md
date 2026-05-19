# Consistency Review Report

**Branch**: feat/v1.4.0-reliability-eval-redesign -> main
**Date**: 2026-04-15 10:23
**Diff Range**: `33abbb78c6c566480ef474d5b98d20087051a929...HEAD` (13 commits, 29 files)

## Pitfalls Check

Loaded `.memory/knowledge/pitfalls.md`. Of the 5 active pitfalls:

- **PF-001 / PF-004 (1Hz polling, statement caching)**: The new `findUpdatedSinceStmt` cache and `idx_loops_updated_at` index added in #143/v1.3.0 carry forward. The new `loop-repository` Zod tightening in this PR does not introduce any new uncached `db.prepare()` calls — verified.
- **PF-005 (Zod parse on every read)**: This PR actively *improves* compliance — `LoopRowSchema.eval_type` and `LoopRowSchema.judge_agent` were tightened from `z.string().nullable().optional()` to `z.enum(['feedforward','judge','schema']).nullable().optional()` and `z.enum(AGENT_PROVIDERS_TUPLE).nullable().optional()` respectively, removing the previous `as EvalType` / `as Loop['judgeAgent']` casts in `rowToLoop`. This is a positive consistency gain — no regression.
- **PF-002 / PF-003**: not relevant (no React/streaming code touched).

No pitfall reintroductions detected.

---

## Issues in Your Changes (BLOCKING)

None. No CRITICAL/HIGH consistency violations were introduced in changed lines.

---

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Mixed `loopId` shorthand vs `loopId: loop.id` logger keys still present in `loop-handler.ts`** — Confidence: 90%
- `src/services/handlers/loop-handler.ts:226`, `:248`, `:486`, `:585`, `:686`, `:702`, `:716`, `:723`, `:745`, `:783`, `:795`, `:815`, `:828`, `:1016`, `:1086`, `:1104`, `:1583`, `:1594`, `:1661` (~19 sites)
- Problem: PR #138 (commit `01aec32`) extracted `handleStopDecision` and explicitly notes in the JSDoc at line 1250 that the logger key was *standardised to `loopId: loop.id`*. The function `handleStopDecision` itself does this. But ~19 other call sites inside the same file still use the bare `loopId` shorthand because they live inside functions that hoist `const loopId = loop.id` (lines 559, 668, 740, 944) or take `loopId: LoopId` as a parameter (lines 1063, 1554, 1644, 1674, 1694).
- Functionally these are equivalent, but the JSDoc claim of "standardised" is overstated for the file as a whole. Either:
  (a) drop the "standardised" comment and document that both spellings are acceptable when `loopId === loop.id` is locally obvious, or
  (b) follow through on the standardisation by inlining `loop.id` everywhere logger objects are constructed.
- Fix: Remove or soften the JSDoc claim at `loop-handler.ts:1250–1251`. The narrative documents a non-existent invariant, which is misleading for future contributors who grep for "standardised".

**Eval prompt: "evaluator" vs "reviewer" wording divergence inside the same prompt** — Confidence: 88%
- `src/services/eval-prompt-builder.ts:62` — `contextHeader` says "You are an evaluator — read and assess only."
- `src/services/feedforward-evaluator.ts:131` — wraps it with "You are reviewing the result of an automated code improvement iteration."
- `src/services/judge-exit-condition-evaluator.ts:268` (inside `buildEvalPrompt`) — also wraps with "You are reviewing..."
- `src/services/agent-exit-condition-evaluator.ts:162–163` — uses "You are evaluating..." (consistent with the helper's "evaluator").
- Problem: the shared helper prompt was extracted (#140) using AgentExitConditionEvaluator's wording ("evaluator"). Feedforward and Judge prompts now contain both roles in adjacent sentences:
  > "You are reviewing the result of an automated code improvement iteration. … IMPORTANT: Do NOT modify any files. You are an evaluator — read and assess only."
- Pre-existing wording was uniformly "reviewer" in those two files. The extraction silently shifted them to "evaluator". Either accept the new uniform wording (and update the surrounding sentences in feedforward + judge to "You are evaluating...") or restore "reviewer" in the helper and align all three.
- Fix: Update `feedforward-evaluator.ts:131` and `judge-exit-condition-evaluator.ts:268` to start with "You are evaluating..." to match the helper's wording, OR change the helper to "You are a reviewer" and align the agent evaluator's "You are evaluating..." line. Pick one term and use it everywhere.

**Test naming style inconsistency: `should X` vs `decision: X — does Y` in `loop-handler.test.ts`** — Confidence: 82%
- `tests/unit/services/handlers/loop-handler.test.ts:1773–2055` (11 new `it()` blocks)
- Problem: the file already contains 58 `it('should X')`-style tests, matching the dominant project pattern (1944 `should` vs 757 non-`should` in `tests/unit`). The new v1.4.0 decision-field tests added at the end of the file use a different convention: `it('decision: continue — schedules next iteration WITHOUT incrementing consecutiveFailures', ...)` — colon-prefixed, em-dash separated, capitalized verbs. Within the same describe block, this stylistic split is jarring during code review and grep.
- Fix: Either rewrite the new tests as `it('should not increment consecutiveFailures when decision is continue', ...)` for in-file consistency, or accept that the file has multiple acceptable styles and document the convention in `tests/CONVENTIONS.md` if one exists. Recommendation: rewrite the 11 new tests in `should X` form to match the surrounding 58 tests.

---

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Test descriptor styles vary across `tests/unit` codebase-wide** — Confidence: 84%
- `tests/unit/services/eval-task-waiter.test.ts:52, 61, 74, 86, 95, 104` (newly added) — uses `it('resolves with...', ...)`, `it('does not resolve twice...', ...)`, `it('ignores events...', ...)` style.
- This matches the broader project pattern where ~28% of tests don't use `should`. The new file is internally consistent (all non-should), and the file is brand new, so there's nothing to harmonise *with* inside the file. Flagging only as informational.
- Fix: No action needed within this PR. Consider documenting a project test-naming convention if uniformity matters.

**`Result<T, Error>` vs `Result<T, AutobeatError>` mixed across codebase** — Confidence: 75%
- The new functions in `src/cli/commands/schedule-executor.ts` (`acquirePidFile`, `checkActiveSchedules`) return `Result<X, Error>`. This matches existing precedent in `src/services/loop-manager.ts`, `src/core/interfaces.ts`, `src/cli/dashboard/use-task-output-stream.ts`, and `src/cli/dashboard/use-dashboard-data.ts`.
- The dominant codebase pattern is `Result<T, AutobeatError>` (10+ files in handlers/services). The new schedule-executor functions are CLI-layer utilities where raw `Error` is arguably appropriate (no domain error codes apply). Pre-existing pattern split — informational only.

---

## Suggestions (Lower Confidence)

- **`EvalPromptBase.gitDiffInstructions` (plural) is a single string** — `src/services/eval-prompt-builder.ts:30` (Confidence: 65%) — minor naming nit; "instruction" (singular) would more accurately describe a single-line directive. Sibling field `toolInstructions` is also plural for a single sentence. Internal consistency is preserved (both plural), so leave as-is.

- **Migration v22 column ordering reshuffle** — `src/implementations/database.ts:870–928` (Confidence: 70%) — the `loops_new` schema in migration v22 reorders columns relative to migration v11/v15 (e.g., `eval_mode` and `eval_prompt` moved up before `working_directory`). This is harmless because the `INSERT INTO ... SELECT ...` uses explicit column lists, but readers diffing v11→v22 will see semantic noise from the reorder. Not a defect — just a code-archaeology friction point.

- **Test fixture naming: `createTestLoop` lacks default agent** — `tests/fixtures/eval-test-helpers.ts:105` (Confidence: 72%) — the fixture documentation explicitly notes "no default agent — tests that need a specific agent should pass it explicitly." This breaks from the previous behaviour in `eval-domain-batch2` (which defaulted to `'claude'`). Documented intentionally, but callers must remember; consider exposing a `createTestLoopForClaude` helper if the pattern repeats.

---

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | - |
| Should Fix | - | 0 | 3 | - |
| Pre-existing | - | - | 2 | 0 |

**Consistency Score**: 8/10
**Recommendation**: APPROVED

Rationale:
- No blocking issues. The PR actively *improves* consistency in two notable ways:
  1. The `LoopRowSchema` enum tightening (eval_type, judge_agent) eliminates two `as` casts in `rowToLoop` — directly aligned with PF-005.
  2. The `SpawnOptions` refactor (#139) replaces 6 positional params with a single options object across `BaseAgentAdapter`, `ProcessSpawnerAdapter`, and call sites in `event-driven-worker-pool.ts` — net consistency gain.
  3. Eval prompt-builder extraction (#140) genuinely de-duplicates ~70 lines of byte-identical prompt construction across 3 evaluators.
  4. Test fixture extraction (#143) consolidates `createOutputRepo`, `createLoopRepo`, `createTestLoop`, `evaluateWithCompletions`, etc., reducing 4 divergent stubs to 1.
- The three Should-Fix items are all stylistic/wording — none affect behaviour and all are reasonable to defer to a follow-up PR.
- Logger key usage of `ok`/`err` lowercase constructors is consistent throughout new code (no `Ok`/`Err` PascalCase).
- Result type usage is consistent within new code (the `acquirePidFile` sentinel-result pattern is well-documented and matches DI/Result conventions).
