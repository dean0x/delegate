# Consistency Review Report

**Branch**: feat-v1.4.0-reliability-eval-redesign -> main
**Date**: 2026-04-14T15:37:00Z

## Issues in Your Changes (BLOCKING)

### HIGH

**Timeout minimum changed from 1000 to 0 without migration/deprecation** - `src/core/configuration.ts:20`
**Confidence**: 85%
- Problem: The `timeout` field in `ConfigurationSchema` had `min(1000)` and `default(1800000)` before this PR. Now it is `min(0)` with `default(0)`. This is a behavioral change: all existing tasks that relied on the 30-minute default timeout now run with no timeout at all. The `DEFAULT_CONFIG` constant was also removed. The DECISION comment explains the rationale ("tasks run 2.5+ hours; timeout was killing them"), but this is a configuration regression for users who relied on the safety-net timeout. The min boundary change (1000 to 0) also means previously invalid values (e.g., `timeout: 500`) now pass validation.
- Fix: If disabling timeout by default is intentional, consider adding a note to CHANGELOG/release notes about this behavioral change. The `min(0)` change should be documented as a breaking change for validation consumers who expected `timeout >= 1000`.

**`DEFAULT_CONFIG` constant removed, Zod `default()` is now sole source of truth** - `src/core/configuration.ts:62-84` (removed)
**Confidence**: 82%
- Problem: The codebase previously had two sources of truth for config defaults: `ConfigurationSchema` with `.default()` clauses AND a `DEFAULT_CONFIG` constant. The PR removes `DEFAULT_CONFIG` entirely. While the CLAUDE.md principle "Validate at boundaries (Zod schemas)" supports this, any external code or test that imported `DEFAULT_CONFIG` is now broken. The diff shows tests were updated (`tests/unit/core/configuration.test.ts`), but the removal is not just a cleanup -- it's a pattern change. The existing `ConfigurationSchema` comments already documented "Single source of truth for validation AND defaults", so this removal actually corrects a prior inconsistency. No blocking issue here, but flagged for awareness.
- Fix: Verify no remaining references to `DEFAULT_CONFIG` exist outside the diff.

### MEDIUM

**`CompositeExitConditionEvaluator` constructor arity changed from 2 to 4 without default parameters** - `src/services/composite-exit-condition-evaluator.ts:23-27`
**Confidence**: 83%
- Problem: The constructor signature changed from `(shellEvaluator, agentEvaluator)` to `(shellEvaluator, agentEvaluator, judgeEvaluator, feedforwardEvaluator)`. This is a breaking change for any call site. The handler-setup.ts correctly passes all 4, but this is a public class. Existing codebase consistently uses constructor injection without defaults for required dependencies (DI pattern), so this is consistent with the project pattern. However, the test for `CompositeExitConditionEvaluator` was removed entirely (`tests/unit/services/composite-exit-condition-evaluator.test.ts` deleted, -107 lines) without a replacement test in the new test files.
- Fix: Verify the composite evaluator routing logic is tested elsewhere (e.g., in `eval-batch3.test.ts` or `eval-domain-batch2.test.ts`). If not, add tests covering the 4-way dispatch: shell, schema, judge, feedforward.

**`EvalType` uses `as const` object pattern instead of `enum`** - `src/core/domain.ts:580-585`
**Confidence**: 80%
- Problem: The existing codebase uses TypeScript `enum` for `LoopStrategy`, `LoopStatus`, `EvalMode`, `TaskStatus`, `Priority`, `ScheduleStatus`, etc. The new `EvalType` uses the `as const` object + type extraction pattern instead. This is a stylistic deviation from the established enum convention. Both patterns are type-safe, but mixing them creates inconsistency for developers who need to discover the pattern for new domain constants.
- Fix: Consider using `enum EvalType { FEEDFORWARD = 'feedforward', JUDGE = 'judge', SCHEMA = 'schema' }` to match the existing domain model convention. The `as const` pattern is functionally equivalent but inconsistent with all other domain enums in the same file.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Heartbeat timer cleanup is done in two places** - `src/implementations/event-driven-worker-pool.ts:284-289,339-342`
**Confidence**: 82%
- Problem: `cleanupWorkerState()` clears the heartbeat timer (lines 284-289) AND `clearTimeoutForWorker()` also clears the heartbeat timer (lines 339-342). Both paths are reachable from `handleWorkerCompletion()` (which calls `clearTimeoutForWorker` then `cleanupWorkerState`). The double-clear is harmless (`clearInterval(undefined)` is a no-op) but the duplication is inconsistent with the timeout timer pattern, where only `clearTimeoutForWorker()` handles cleanup and `cleanupWorkerState()` doesn't touch it.
- Fix: Pick one cleanup site for consistency. The existing `timeoutTimer` pattern uses `clearTimeoutForWorker()` as the single cleanup point. Mirror that: clear `heartbeatTimer` only in `clearTimeoutForWorker()` (already done) and remove the duplicate in `cleanupWorkerState()`.

**Prompt-building code duplicated across 3 evaluators** - `src/services/agent-exit-condition-evaluator.ts:158-203`, `src/services/feedforward-evaluator.ts:128-157`, `src/services/judge-exit-condition-evaluator.ts:249-278`
**Confidence**: 85%
- Problem: All three evaluators have a nearly identical `buildEvalPrompt` / `buildFindingsPrompt` method that: looks up `preIterationCommitSha` from the iteration record, constructs `gitDiffInstruction`, builds `toolInstructions`, and assembles the prompt. The `waitForEvalTaskCompletion` was correctly extracted into `eval-task-waiter.ts` to avoid this exact issue, but the prompt-building was not similarly extracted. The feedforward and judge eval prompts differ only in the header line and format directive.
- Fix: Consider extracting shared prompt-building logic into the `eval-task-waiter.ts` module or a new `eval-prompt-builder.ts`. The `waitForEvalTaskCompletion` extraction sets the precedent for this pattern.

**`eslint-disable-next-line` comments added to Codex and Gemini adapters** - `src/implementations/codex-adapter.ts:20`, `src/implementations/gemini-adapter.ts:20`
**Confidence**: 80%
- Problem: The `_jsonSchema` parameter is prefixed with underscore and has an `eslint-disable-next-line @typescript-eslint/no-unused-vars` comment. This is the correct way to handle unused abstract method parameters in TypeScript, but the project has biome configured (not ESLint). The comment `// eslint-disable-next-line` targets ESLint, not biome. If biome is the active linter, this comment is inert dead code.
- Fix: Verify whether ESLint or biome enforces `no-unused-vars`. If biome, these comments should be removed or replaced with the biome equivalent. The underscore prefix alone may be sufficient for biome.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**PF-004 (Pitfall): New `updateHeartbeatStmt` follows the cached-statement convention correctly** - `src/implementations/worker-repository.ts:78-80`
**Confidence**: 90%
- This is a positive note: the new `updateHeartbeatStmt` is correctly cached as a `private readonly` field in the constructor, matching the pattern established by all other statements in the repository. This avoids pitfall PF-004 (prepared statements must be cached in constructors).

**PF-005 (Pitfall): New worker repository read path correctly uses Zod** - `src/implementations/worker-repository.ts:191`
**Confidence**: 90%
- Positive note: `rowToRegistration` passes through `WorkerRowSchema.parse(row)`, consistent with PF-005 (repository read paths must use Zod).

## Suggestions (Lower Confidence)

- **`skipResourceMonitoring` hardcoded to `false`** - `src/bootstrap.ts:63` (Confidence: 70%) -- The DECISION comment explains the change, but `deriveModeFlags` now ignores the `mode` parameter for this flag entirely. Consider removing the `skipResourceMonitoring` field from `ModeFlags` if it can never be true, or document why it remains as a field.

- **`enrichPromptWithCheckpoint` now fetches 11 iterations instead of 2** - `src/services/handlers/loop-handler.ts:1446` (Confidence: 65%) -- The change from `getIterations(loop.id, 2, 0)` to `getIterations(loop.id, 11, 0)` is justified by the new evaluation history feature, but it's a 5.5x increase in data fetched per iteration start. For loops with many iterations, this could be measurable. The 8KB cap on feedback bytes is a good safeguard.

- **`feedforward + optimize` validation may confuse users** - `src/services/loop-manager.ts:203-211` (Confidence: 60%) -- The validation error says feedforward is "not compatible" with optimize, but the `handleOptimizeResult` method in loop-handler.ts does handle `decision === 'continue'` from feedforward. The validation is stricter than the runtime behavior.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 3 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Consistency Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The PR demonstrates strong consistency in several areas: the new evaluators follow the established Strategy/Composite pattern; database migrations use the same versioned migration pattern; repository implementations correctly cache prepared statements and use Zod validation at boundaries (avoiding PF-004 and PF-005 regressions); the `eval-task-waiter.ts` extraction correctly DRYs up shared event-waiting logic.

The main consistency gaps are: (1) `EvalType` uses `as const` instead of `enum` unlike all other domain constants; (2) the timeout default change is a behavioral regression that should be documented; (3) prompt-building logic is duplicated across three evaluators despite the waiter extraction setting the DRY precedent; (4) heartbeat timer cleanup is duplicated across two methods where the timeout timer pattern uses only one. None of these are blocking, but addressing items (1) and (4) would improve internal consistency.
