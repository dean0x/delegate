# Regression Review Report

**Branch**: feat-v1.4.0-reliability-eval-redesign -> main
**Date**: 2026-04-14T15:37:00Z

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

**Stale test assertion: `resource-exhaustion.test.ts` expects old timeout default** - `tests/security/resource-exhaustion.test.ts:213`
**Confidence**: 95%
- Problem: The security test at line 213 asserts `expect(fallback.timeout).toBe(1800000)` (the old 30-minute default). The `ConfigurationSchema` default was changed from `1800000` to `0` in this PR, but this test was not updated. This will cause a test failure in the `test:all` / CI suite.
- Fix: Update line 213 to `expect(fallback.timeout).toBe(0);` with a comment explaining the v1.4.0 change. The PR already correctly updated `configuration.test.ts` and `service-initialization.test.ts` -- this file was missed.

### MEDIUM

**CompositeExitConditionEvaluator constructor signature changed -- callers must pass 4 evaluators** - `src/services/composite-exit-condition-evaluator.ts:22-28`
**Confidence**: 85%
- Problem: The constructor changed from `(shell, agent)` to `(shell, agent, judge, feedforward)`. The old 2-argument call signature is now a compile error. The deleted `composite-exit-condition-evaluator.test.ts` used the old signature. Its replacement (`eval-batch3.test.ts`) uses the new signature. However, any out-of-tree consumer that constructs `CompositeExitConditionEvaluator` directly will break at compile time.
- Fix: This is an internal class (not exported from the package entry point) and only instantiated in `handler-setup.ts`, which was correctly updated. The risk is low for external consumers since this is not a published API. No code fix needed, but note it in CHANGELOG as a breaking internal change.

**Timeout default changed from 30min to 0 (disabled) -- behavioral regression for existing users** - `src/core/configuration.ts:20`
**Confidence**: 82%
- Problem: The default task timeout changed from 1800000ms (30 minutes) to 0 (no timeout). Existing users who relied on the implicit 30-minute safety timeout now have no timeout at all. Runaway tasks will never be killed automatically unless the user explicitly sets `TASK_TIMEOUT`. The commit message documents the rationale ("tasks run 2.5+ hours; timeout was killing them"), but this is a breaking default change.
- Fix: This is an intentional design decision, but it should be prominently documented in the release notes / CHANGELOG as a breaking default change. Users who want the old behavior can set `TASK_TIMEOUT=1800000`. The `setupTimeoutForWorker()` in `event-driven-worker-pool.ts:308-310` correctly handles `0` and `undefined` by skipping timeout setup.

## Issues in Code You Touched (Should Fix)

### HIGH

(none)

### MEDIUM

**`evalType` stored as `TEXT DEFAULT 'feedforward'` in migration but `EvalType` cast uses `as EvalType`** - `src/implementations/loop-repository.ts:686`
**Confidence**: 80%
- Problem: The `rowToLoop` method casts `data.eval_type as EvalType` when converting from DB rows to domain objects. While the Zod schema validates the row at parse time, the `eval_type` field uses `z.string().nullable().optional()` -- it does not validate against the actual `EvalType` enum values (`feedforward`, `judge`, `schema`). A corrupted DB value like `eval_type = 'invalid'` would pass Zod validation but produce an invalid `EvalType` in the domain model, which could then fall through to the `default` branch in `CompositeExitConditionEvaluator` (safely handled as feedforward, but silently wrong).
- Fix: Tighten the Zod schema from `z.string().nullable().optional()` to `z.enum(['feedforward', 'judge', 'schema']).nullable().optional()` to validate at the boundary. The same applies to `judge_agent` which should validate against `AGENT_PROVIDERS_TUPLE`.

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **`DEFAULT_CONFIG` removed but no migration path for tests referencing it** - `src/core/configuration.ts` (Confidence: 65%) -- The removal of the `DEFAULT_CONFIG` constant simplifies the code (Zod defaults are now canonical), but the `config-validator.test.ts` helper `createTestConfiguration()` may still reference the old constant indirectly. Verify all test helpers use `ConfigurationSchema.parse({})` as the source of defaults.

- **`decision: 'stop'` in `handleRetryResult` updates loop status twice** - `src/services/handlers/loop-handler.ts:852-873` (Confidence: 70%) -- When `evalResult.decision === 'stop'`, the handler writes `LoopStatus.COMPLETED` in the transaction (line 866) and then calls `completeLoop()` again (line 873), which also writes `COMPLETED`. The second write is described as "harmless" in the existing code pattern, but the event emission in `completeLoop()` may fire a `LoopCompleted` event for a loop that was already marked completed in the DB. This is consistent with the existing `passed` code path (lines 893-908), so it is not a regression per se, but the pattern warrants scrutiny.

- **Judge evaluator not reviewed** - `src/services/judge-exit-condition-evaluator.ts` (Confidence: 60%) -- This 405-line new file was not fully reviewed in this regression-focused analysis. It spawns two sequential agent tasks (eval phase + judge phase) with file-based decision passing via `.autobeat-judge`. The file I/O and two-phase coordination are complex enough to warrant a dedicated review for correctness.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Regression Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

### Rationale

The PR is well-structured with thorough test coverage for the new eval type system. The eval-task-waiter extraction, composite evaluator routing, and loop handler decision field integration are backward-compatible and correctly tested. However:

1. **One test will fail in CI** (`resource-exhaustion.test.ts:213`): this is a clear regression that blocks merge.
2. **Timeout default change is intentional but breaking**: existing users lose the implicit 30-minute safety timeout. Must be documented in release notes.
3. **Zod boundary validation is incomplete**: `eval_type` is stored as `z.string()` rather than `z.enum()`, which weakens the parse-don't-validate pattern this codebase follows.

### Pitfall Check

Reviewed `.memory/knowledge/pitfalls.md` (5 active pitfalls). None of the pitfall areas overlap with files changed in this PR:
- PF-001 (dashboard polling / indexes): No dashboard changes in this diff.
- PF-002 (UTF-8 byte-slice): No streaming changes.
- PF-003 (React polling hooks): No React changes.
- PF-004 (prepared statement caching): All new repo statements are cached in constructors (loop-repository.ts save/update/recordIteration/updateIteration stmts -- correct pattern).
- PF-005 (Zod on repo reads): The new `eval_type`/`judge_agent`/`judge_prompt` fields ARE Zod-validated via `LoopRowSchema` (lines 63-66). However, the validation is `z.string()` rather than `z.enum()` which is weaker than ideal (noted as Should-Fix above).

### Regression Checklist

- [x] No exports removed without deprecation
- [x] Return types backward compatible (EvalResult extended with optional `decision` and `evalResponse` fields)
- [x] Default values changed -- **DOCUMENTED** (timeout 30min -> 0, resource monitoring always on)
- [x] Side effects preserved (events, logging)
- [x] All consumers of changed code updated (except `resource-exhaustion.test.ts`)
- [x] Migration complete across codebase (DB migration v21, repo, domain, MCP adapter, CLI)
- [x] CLI options preserved (new `beat schedule executor` subcommand, existing commands unchanged)
- [x] API endpoints preserved (MCP tools extended with optional fields, backward compatible)
- [x] Commit messages match implementation
- [ ] Breaking changes documented in CHANGELOG -- **NOT YET** (timeout default change needs release notes)
