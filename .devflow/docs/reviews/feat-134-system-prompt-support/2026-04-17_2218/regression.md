# Regression Review Report

**Branch**: feat/134-system-prompt-support -> main
**Date**: 2026-04-17
**Scope**: Incremental review of 7 commits since ef16f93b

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Mock AgentAdapter missing `cleanup()` method** - `tests/unit/implementations/agent-registry.test.ts:13-19`
**Confidence**: 82%
- Problem: The `createMockAdapter()` function returns an object typed as `AgentAdapter` but omits the newly-added `cleanup(taskId: string): void` method. The main `tsconfig.json` excludes tests from type-checking (line 23: `"exclude": [..., "tests", ...]`), and Vitest uses esbuild for transpilation without type-checking, so this compiles and tests pass. However, if test type-checking is ever enabled (e.g., via `tsc --project tsconfig.test.json`), or if a future test in this file calls `cleanup()`, it will fail. The mock is structurally incomplete relative to the interface it claims to implement.
- Fix: Add `cleanup: vi.fn()` to the mock object:
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

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

(none -- all findings above threshold)

## Regression Checklist

- [x] No exports removed without deprecation
- [x] Return types backward compatible
- [x] Default values unchanged (or documented)
- [x] Side effects preserved (events, logging)
- [x] All consumers of changed code updated
- [x] Migration complete across codebase
- [x] CLI options preserved or deprecated
- [x] API endpoints preserved or versioned
- [x] Commit messages match implementation
- [x] Breaking changes documented

## Detailed Analysis

### 1. Lost Functionality -- None Detected

No exports were removed (`git diff | grep "^-export"` returned empty). The `AgentAdapter` interface was extended (new `cleanup()` method) rather than narrowed. All existing CLI flags (`--system-prompt`) are preserved; the only behavioral change is relaxing the dash-guard (`!next.startsWith('-')` -> `next === undefined`) which is intentional and tested.

### 2. Broken Behavior -- None Detected

**Cleanup path refactored safely**: The old `cleanupWorkerState` in `event-driven-worker-pool.ts` unconditionally called `unlinkSync(path.join(..., taskId + '.md'))` catching all errors. The new path guards with `if (worker?.task.systemPrompt)` before calling `adapter.cleanup(taskId)`. This is safe because temp files are only written inside `getSystemPromptConfig`, which is only called when `systemPrompt` is truthy (line 191 of `base-agent-adapter.ts`). No temp file can exist without `systemPrompt` being set.

**GeminiBasePromptCache extraction**: The `GeminiAdapter.getSystemPromptConfig` was refactored to delegate to `GeminiBasePromptCache`. One behavioral change: stale caches (>30 days) now return `null` from `buildCombinedFile` (falling back to prependToPrompt), whereas before they would still read the stale content and only emit a warning. This is arguably more correct (stale data is not silently used), but it changes behavior. The staleness warning was preserved. Confidence this is intentional: HIGH (the code comment says "Do not cache stale content -- force re-read after user refreshes").

**systemPrompt threading through schedule flows**: All three schedule paths were verified:
- Single-task schedules: `systemPrompt` threaded via `schedule-manager.ts:75` into `taskTemplate`
- Pipeline schedules: `systemPrompt` threaded via `schedule-manager.ts:304` into `taskTemplate`, and propagated to each step task via `schedule-handler.ts:401`
- Loop schedules: `systemPrompt` flows through `loopConfig` -> `createLoop()` -> `loop.taskTemplate.systemPrompt` (domain.ts:712)

### 3. Intent vs Reality Mismatch -- None Detected

Commits match their descriptions:
- `c003bb7` "fix: system-prompt path collision and CLI dash-guard regression" -- correctly changes `!next.startsWith('-')` to `next === undefined` in 3 CLI parsers, adds random suffix for path collision prevention
- `89de208` "fix(gemini): secure file permissions, in-memory prompt cache, adapter-owned cleanup" -- adds `mode: 0o700`/`0o600`, introduces `GeminiBasePromptCache`, moves cleanup into adapter
- `83d57c6` "fix: thread systemPrompt through to task creation in schedule flows" -- adds `systemPrompt` to `ScheduleCreateRequest`, `ScheduledPipelineCreateRequest`, and threads through `schedule-manager.ts`
- `abbd413` "refactor: extract GeminiBasePromptCache from adapter" -- pure structural extraction

### 4. Incomplete Migrations -- None Detected

All consumers of `AgentAdapter` were checked:
- `BaseAgentAdapter` (abstract base): provides default no-op `cleanup()` (line 303)
- `ProcessSpawnerAdapter`: provides no-op `cleanup()` (line 39)
- `GeminiAdapter`: overrides with file deletion (line 153)
- Mock in `agent-registry.test.ts`: missing `cleanup` (noted above as MEDIUM)

The `@design` -> `DECISION:` comment migration across the 7 commits is complete. No remaining `@design` tags were found in changed files. The `v1.4.0` version reference cleanup is also complete -- no remaining `v1.4.0` refs in changed files.

### 5. Known Pitfalls Check

- **PF-006** (Paired-interface drift): The new `cleanup()` method was added to the `AgentAdapter` interface and implemented in both concrete adapters (`BaseAgentAdapter`, `ProcessSpawnerAdapter`). The `ProcessSpawner` interface in `core/interfaces.ts` was NOT changed, but this is correct -- `ProcessSpawner` is a lower-level interface that `ProcessSpawnerAdapter` wraps, and cleanup is adapter-level (not spawner-level). No PF-006 regression.
- **PF-008** (Tautological tests): New tests in this diff are behavioral -- they call production functions (CLI parsers, adapter spawn, MCP callTool) and assert side effects (spawn args, env vars, JSON responses). No `expect(true).toBe(true)` patterns found.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | - |
| Should Fix | - | 0 | 1 | - |
| Pre-existing | - | - | 0 | 0 |

**Regression Score**: 9/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The single MEDIUM finding (incomplete mock) is non-blocking and does not affect production code. All 7 commits match their stated intent, no exports were removed, no return types changed, and the systemPrompt threading through all schedule/loop/orchestrator paths is complete and consistent. The GeminiBasePromptCache extraction preserves all behavior (with the minor intentional improvement of not caching stale content). The only condition is that the mock adapter in `agent-registry.test.ts` should be updated to include `cleanup: vi.fn()` for interface completeness.
