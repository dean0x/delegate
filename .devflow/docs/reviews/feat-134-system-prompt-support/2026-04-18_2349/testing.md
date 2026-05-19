# Testing Review Report

**Branch**: feat/134-system-prompt-support -> main
**Date**: 2026-04-18

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Non-null assertion on potentially uninitialized variable** - `tests/unit/implementations/agent-adapters.test.ts:980`
**Confidence**: 85%
- Problem: The variable `result` is declared with `let result: ReturnType<typeof adapter.spawn>;` (line 967) and assigned inside a `try` block (line 969). The assertion on line 980 uses `result!.ok` with a non-null assertion. If `adapter.spawn()` throws (unlikely but possible since it calls into mock spawn), `result` remains uninitialized and `result!.ok` throws a misleading `TypeError` instead of a clear failure message.
- Fix: Initialize the variable or assert it is defined before accessing `.ok`:
```typescript
expect(result).toBeDefined();
expect(result.ok).toBe(true);
```
Or initialize as `let result: ReturnType<typeof adapter.spawn> | undefined;` and use `expect(result?.ok).toBe(true);`.

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

_No issues found._

## Suggestions (Lower Confidence)

- **Missing negative test for `createPipeline` systemPrompt passthrough** - `tests/unit/services/schedule-manager.test.ts` (Confidence: 70%) -- `createScheduledPipeline` has both present/absent tests for `systemPrompt`, but `createPipeline()` does not test `systemPrompt` passthrough at all. Since `createPipeline` delegates to `createSchedule` per step, and `createSchedule` already has the test, this is low risk but breaks local symmetry with the other two schedule methods.

- **Worker pool cleanup test does not verify cleanup on kill path** - `tests/unit/implementations/event-driven-worker-pool.test.ts` (Confidence: 65%) -- The new "adapter cleanup delegation" tests cover the completion path (process exit) but do not test cleanup on the `kill()` path. The production code in `cleanupWorkerState` is shared between both paths, so this is already indirectly covered, but an explicit test for kill-with-systemPrompt would improve confidence.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Testing Score**: 9/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Assessment

The test suite for the system prompt feature is thorough and well-structured:

1. **Behavior-focused**: Tests validate observable outcomes (spawn args, event payloads, DB round-trips) rather than implementation details. This aligns with the testing iron law.

2. **Comprehensive coverage across layers**:
   - **Adapter layer** (agent-adapters.test.ts): 7 new tests covering Claude (`--append-system-prompt`), Codex (`-c developer_instructions`), and Gemini (fallback-to-prepend and GEMINI_SYSTEM_MD injection), plus regression guards for absent systemPrompt.
   - **GeminiBasePromptCache** (agent-adapters.test.ts): 8 new unit tests covering cache miss, stale cache, size guard, cache hit, in-memory caching, invalidation, cleanup, and path-traversal rejection.
   - **Worker pool** (event-driven-worker-pool.test.ts): 3 new tests for adapter cleanup delegation -- correct adapter called, no-op when systemPrompt absent, best-effort on throw.
   - **Schedule repository** (schedule-repository.test.ts): 4 new tests for systemPrompt DB round-trip in both taskTemplate and loopConfig.
   - **Orchestration manager** (orchestration-manager.test.ts): 4 new tests for systemPrompt handling -- custom prompt, operational contract injection, default flow, and whitespace-as-absent.
   - **Orchestrator prompt** (orchestrator-prompt.test.ts): 7 new tests for the `operationalContract` return value.
   - **Schedule manager** (schedule-manager.test.ts): 6 new tests for systemPrompt threading in createSchedule, createScheduledPipeline, and createScheduledLoop.

3. **Good test patterns**: Proper AAA structure, clear test names describing expected behavior, proper cleanup in afterEach blocks, use of real SQLite (in-memory) rather than repository mocks.

4. **Edge cases covered**: Empty/whitespace systemPrompt treated as absent, path-traversal prevention, cache staleness, oversized combined prompt, adapter cleanup throwing.

5. **Mock interface updated**: agent-registry.test.ts mock adapter correctly includes the new `cleanup` method.

The single blocking issue (non-null assertion) is cosmetic/defensive -- the test will still pass correctly in practice. The suggestions are enhancement opportunities, not problems.
