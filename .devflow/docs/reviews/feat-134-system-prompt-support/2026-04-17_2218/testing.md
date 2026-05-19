# Testing Review Report

**Branch**: feat/134-system-prompt-support -> main
**Date**: 2026-04-17T22:18
**Scope**: Incremental review (7 commits since ef16f93b)

## Issues in Your Changes (BLOCKING)

### HIGH

**No unit tests for `GeminiBasePromptCache` class** - `src/implementations/gemini-adapter.ts:17-95`
**Confidence**: 92%
- Problem: The newly extracted `GeminiBasePromptCache` class (commit abbd413) contains non-trivial logic: in-memory caching with lazy load, staleness checks (30-day TTL), byte-size guards (64KB), file I/O for combined prompt writing, and cleanup. None of this has dedicated unit tests. The existing Gemini tests in `agent-adapters.test.ts` exercise `GeminiAdapter` end-to-end through the `spawn()` method, which indirectly touches `buildCombinedFile` and the fallback path. However, several behaviors are untested:
  - Staleness check (cache older than 30 days is rejected, not used)
  - Combined prompt exceeding 64KB falls back to prepend
  - `invalidate()` forces re-read on next call
  - `cleanupTaskFile()` succeeds and handles missing file gracefully
  - In-memory cache hit (second call skips disk read)
- Fix: Add a dedicated `describe('GeminiBasePromptCache')` test suite in `agent-adapters.test.ts` that constructs the class with a temp `cacheDir` and tests each behavior independently. Example:
  ```typescript
  describe('GeminiBasePromptCache', () => {
    it('should return null when no base cache file exists', () => {
      const cache = new GeminiBasePromptCache(emptyDir);
      expect(cache.buildCombinedFile('prompt', outputPath)).toBeNull();
    });
    it('should reject stale cache (>30 days)', () => { /* ... */ });
    it('should fall back when combined exceeds 64KB', () => { /* ... */ });
    it('should serve from memory on second call', () => { /* ... */ });
    it('cleanupTaskFile removes task-scoped file', () => { /* ... */ });
  });
  ```

**No tests for `systemPrompt` threading through schedule flows** - `src/services/schedule-manager.ts:75`, `src/services/handlers/schedule-handler.ts:401`
**Confidence**: 88%
- Problem: Three new `systemPrompt` fields were added to MCP schemas (`ScheduleTaskSchema`, `SchedulePipelineSchema`, `ScheduleLoopSchema`) and wired through `schedule-manager.ts` (lines 75, 301) and `schedule-handler.ts` (line 401 for pipeline step tasks). None of these paths have test coverage. The MCP adapter tests cover `DelegateTask`, `TaskStatus`, and `LoopStatus` for systemPrompt but skip all three schedule tools entirely. The schedule-handler pipeline step propagation (`systemPrompt: defaults.systemPrompt`) is particularly critical -- if the field is dropped, every scheduled pipeline task silently loses its system prompt.
- Fix: Add tests in `mcp-adapter.test.ts` for `ScheduleTask`, `SchedulePipeline`, and `ScheduleLoop` that verify `systemPrompt` is passed through to the created schedule's task template. Add a test in the schedule-handler test suite verifying pipeline step tasks inherit `systemPrompt` from defaults.

### MEDIUM

**No test for worker pool cleanup delegation to adapter** - `src/implementations/event-driven-worker-pool.ts:304-312`
**Confidence**: 85%
- Problem: The worker pool's `cleanupWorkerState` method was refactored from direct `unlinkSync` of a hardcoded path to delegation via `agentAdapter.cleanup(taskId)`. This is a behavioral change in a critical path (worker completion). The existing worker pool tests (`event-driven-worker-pool.test.ts`) do not cover this new delegation pattern. If `agentRegistry.get()` fails or `cleanup()` throws, the method should still complete (best-effort). The current code handles `agentRegistry.get()` failure (only calls cleanup when `agentResult.ok`), but a throwing `cleanup()` is unguarded.
- Fix: Add tests in `event-driven-worker-pool.test.ts` that verify:
  1. `cleanup(taskId)` is called on the correct adapter when a worker with `systemPrompt` completes
  2. `cleanup()` is NOT called when the task has no `systemPrompt`
  3. Worker cleanup completes even if `cleanup()` throws

**Mock `AgentAdapter` in `agent-registry.test.ts` missing `cleanup` method** - `tests/unit/implementations/agent-registry.test.ts:13-20`
**Confidence**: 82%
- Problem: The `createMockAdapter` factory creates objects with `{ provider, spawn, kill, dispose }` but omits the newly added `cleanup` method from the `AgentAdapter` interface. TypeScript doesn't catch this because `vi.fn()` returns `any`, allowing structural incomplete objects to satisfy the interface. This is a drift risk -- if any test uses the mock and calls `cleanup()`, it will throw at runtime.
- Fix: Add `cleanup: vi.fn()` to the mock factory:
  ```typescript
  function createMockAdapter(provider: AgentProvider): AgentAdapter {
    return {
      provider,
      spawn: vi.fn().mockReturnValue(ok({ process: {}, pid: 1234 })),
      kill: vi.fn().mockReturnValue(ok(undefined)),
      dispose: vi.fn(),
      cleanup: vi.fn(),
    };
  }
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Gemini adapter tests use `console.error` spy that may leak across tests** - `tests/unit/implementations/agent-adapters.test.ts:968`
**Confidence**: 80%
- Problem: The "GeminiAdapter: without base cache" test creates `vi.spyOn(console, 'error').mockImplementation(() => {})` and calls `consoleSpy.mockRestore()` inline after the assertion. If the test fails before `mockRestore()`, the spy leaks into subsequent tests, swallowing their console.error output. Other tests in this suite do not use this pattern.
- Fix: Move `consoleSpy` to `beforeEach`/`afterEach` or use a try/finally:
  ```typescript
  it('GeminiAdapter: without base cache...', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // ... test body ...
    } finally {
      consoleSpy.mockRestore();
    }
  });
  ```

## Pre-existing Issues (Not Blocking)

No critical pre-existing testing issues found in the files reviewed.

## Suggestions (Lower Confidence)

- **Gemini adapter test creates real temp files on disk** - `tests/unit/implementations/agent-adapters.test.ts:990-993` (Confidence: 70%) -- The test manually creates a cache directory and writes `gemini-base.md` to verify the GEMINI_SYSTEM_MD env var injection path. While the temp directory is cleaned in `afterEach`, this couples the test to filesystem behavior. Consider injecting `GeminiBasePromptCache` directly into the `GeminiAdapter` constructor (which already supports it) to avoid filesystem coupling.

- **CLI `--system-prompt` dash-guard tests assert implementation detail** - `tests/unit/cli.test.ts:3123-3130`, `tests/unit/cli/orchestrate.test.ts:187-195` (Confidence: 65%) -- These tests verify that a system prompt starting with `--` is accepted. The test names reference implementation (`"no startsWith check"`). If the parser implementation changes (e.g., to use a library), these tests would need updating despite behavior being unchanged. Consider renaming to describe behavior ("accepts values starting with dashes").

- **No negative test for `includeSystemPrompt` with non-boolean values** - `tests/unit/adapters/mcp-adapter.test.ts:3062-3174` (Confidence: 62%) -- The includeSystemPrompt tests cover true/false/absent but not invalid types (e.g., string "true"). Zod handles this via `.boolean().optional().default(false)`, but a test confirming Zod rejection would guard against schema drift.

## Pitfall Check

- **PF-008 (Tautological tests)**: Reviewed all new test blocks. No `expect(true).toBe(true)` or re-implemented production logic in test bodies. All tests call production code (adapter.spawn, adapter.callTool, repo.save/findById, parseLoopCreateArgs, parseOrchestrateCreateArgs) and assert observable output. No violations found.

- **PF-006 (Paired-interface drift)**: The `cleanup(taskId: string)` addition to `AgentAdapter` was correctly mirrored in `BaseAgentAdapter` (no-op default), `GeminiAdapter` (override), and `ProcessSpawnerAdapter` (no-op). However, the mock in `agent-registry.test.ts:13-20` is missing it (flagged above as MEDIUM).

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Testing Score**: 6/10
**Recommendation**: CHANGES_REQUESTED

The new tests (5 files, ~440 lines) cover the happy paths well for CLI parsing, MCP adapter `includeSystemPrompt` flag, agent adapter system prompt passthrough, and task repository persistence. However, two significant gaps remain: (1) the newly extracted `GeminiBasePromptCache` class has zero direct test coverage for its edge cases (staleness, size guard, invalidation, cleanup), and (2) the `systemPrompt` field threading through all three schedule MCP tools (`ScheduleTask`, `SchedulePipeline`, `ScheduleLoop`) is entirely untested. The worker pool cleanup delegation refactor also lacks test coverage. These gaps affect confidence in the schedule and Gemini paths specifically.
