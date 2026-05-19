# Architecture Review Report

**Branch**: feat/134-system-prompt-support -> main
**Date**: 2026-04-17T22:18
**Scope**: Incremental review (7 commits since ef16f93b)

## Issues in Your Changes (BLOCKING)

No CRITICAL or HIGH issues found.

### MEDIUM

**Schedule handler threads systemPrompt via taskTemplate but ScheduleLoop path does not** - `src/services/schedule-manager.ts:508-514`
**Confidence**: 82%
- Problem: In `createScheduledLoop`, the `taskTemplate` passed to `createSchedule` omits `systemPrompt` (lines 508-514). The `loopConfig` object carries systemPrompt (via `request.loopConfig.systemPrompt`), but the fallback `taskTemplate` stored on the schedule row does not. The single-task and pipeline schedule creation paths both set `systemPrompt: request.systemPrompt` on their taskTemplate (lines 75, 304). This inconsistency means that if any code path reads `schedule.taskTemplate.systemPrompt` for a scheduled loop (e.g., for display or future features), it will be undefined even though the loopConfig has it.
- Fix: Add `systemPrompt: request.loopConfig.systemPrompt` to the taskTemplate in `createScheduledLoop`:
  ```typescript
  taskTemplate: {
    prompt: request.loopConfig.prompt ?? '',
    priority: request.loopConfig.priority,
    workingDirectory: request.loopConfig.workingDirectory,
    agent: request.loopConfig.agent,
    model: request.loopConfig.model,
    systemPrompt: request.loopConfig.systemPrompt,  // <-- add
  },
  ```

## Issues in Code You Touched (Should Fix)

No issues found.

## Pre-existing Issues (Not Blocking)

No CRITICAL pre-existing issues found.

## Suggestions (Lower Confidence)

- **GeminiBasePromptCache uses console.error for structured logging** - `src/implementations/gemini-adapter.ts:100-102` (Confidence: 65%) -- The `#warn` method writes structured JSON to `console.error`. All other adapter code injects a `Logger` via constructor. The cache class could accept an optional logger for consistency, though `console.error` is acceptable for a class that is intentionally infrastructure-level and not testable via DI.

- **ProcessSpawner interface still lacks `dispose` and `cleanup`** - `src/core/interfaces.ts:66-69` (Confidence: 70%) -- Known pitfall PF-006 documented the paired-interface drift between `ProcessSpawner` and `AgentAdapter`. This PR correctly added `cleanup()` to `ProcessSpawnerAdapter` (the shim), but `ProcessSpawner` itself still has only `spawn` and `kill`. Since `ProcessSpawner` is only used in tests via `MockProcessSpawner`, the drift is currently benign. If `ProcessSpawner` gains more consumers, the mismatch could resurface.

## Pitfall Cross-Reference

| Pitfall | Overlap with changed files? | Status |
|---------|---------------------------|--------|
| PF-006 (paired-interface drift) | Yes -- `ProcessSpawnerAdapter` gained `cleanup()` | Addressed: adapter shim correctly implements no-op `cleanup()`. Interface drift acknowledged but benign (test-only consumer). |
| PF-004 (prepared statement caching) | No new query methods in this diff | N/A |
| PF-005 (Zod on repo reads) | No new repo read methods in this diff | N/A |

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Architecture Score**: 9/10

The incremental changes are architecturally sound:

1. **GeminiBasePromptCache extraction** (SRP): Clean separation of filesystem I/O concerns from the adapter's declarative `getSystemPromptConfig`. The extracted class uses private `#` fields, has a single responsibility, and is injectable via constructor for testing.

2. **cleanup() lifecycle method on AgentAdapter**: Well-designed extension -- the base class provides a no-op default, only Gemini overrides it, and the worker pool calls it conditionally (only when systemPrompt was set). This follows OCP (new behavior without modifying existing adapters).

3. **systemPrompt threading through schedule/pipeline/loop flows**: Consistent pattern -- added to `ScheduleCreateRequest`, `ScheduledPipelineCreateRequest`, `LoopCreateRequest`, and plumbed through MCP tools, CLI, and handler code paths. The pipeline trigger correctly inherits `defaults.systemPrompt` for each step task.

4. **CLI dash-guard fix** (`next === undefined` instead of `!next.startsWith('-')`): Architecturally correct -- system prompts may legitimately contain dash-prefixed content. Applied consistently across all three CLI parsers (run, loop, orchestrate).

5. **Comment tag standardization** (`@design` to `DECISION:`): Consistent with project conventions established in prior review.

**Recommendation**: APPROVED_WITH_CONDITIONS

The single MEDIUM finding (scheduled loop taskTemplate missing systemPrompt) is a consistency gap that should be addressed before merge, but does not cause runtime failures since the loop config is the authoritative source for system prompt propagation in the loop trigger path.
