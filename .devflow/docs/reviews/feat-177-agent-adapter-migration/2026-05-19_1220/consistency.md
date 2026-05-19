# Consistency Review Report

**Branch**: feat/177-agent-adapter-migration -> main
**Date**: 2026-05-19

## Issues in Your Changes (BLOCKING)

### HIGH

**Migration v28 description incomplete -- omits tasks.agent cleanup** - `CHANGELOG.md:14`, `CLAUDE.md:254`
**Confidence**: 92%
- Problem: Migration v28 performs two operations: (1) recreates `loops` table with narrowed `judge_agent` CHECK, and (2) runs `UPDATE tasks SET agent = NULL WHERE agent = 'gemini'`. The CHANGELOG entry only describes the loops table rebuild. The CLAUDE.md Database section only mentions `loops.judge_agent`. The migration's own `description` field was updated to mention "and tasks.agent column" but the user-facing docs do not reflect this.
- Fix: Update CHANGELOG.md line 14:
  ```markdown
  - **Migration v28**: Recreates `loops` table with `judge_agent CHECK` constraint narrowed to `('claude', 'codex')`. Existing `judge_agent='gemini'` rows mapped to `NULL` (reverts to loop's own agent). Also maps `tasks.agent='gemini'` to `NULL` so existing task rows pass Zod validation.
  ```
  Update CLAUDE.md line 254:
  ```markdown
  - `loops.judge_agent` CHECK constraint updated: removes 'gemini' from allowed values; `tasks.agent='gemini'` mapped to NULL (migration v28)
  ```

### MEDIUM

**Interface JSDoc references ErrorCode.INVALID_OPERATION for the taskId case but implementation uses AGENT_MISCONFIGURED** - `src/core/agents.ts:322`
**Confidence**: 82%
- Problem: The `buildTmuxCommand` JSDoc on the `AgentAdapter` interface says "Adapters that do not support tmux (e.g. ProcessSpawnerAdapter) must return err with ErrorCode.INVALID_OPERATION. Adapters that support tmux require a non-empty taskId." The second sentence implies the taskId requirement but does not specify which error code to use. The implementation at `base-agent-adapter.ts:127` uses `agentMisconfigured` (AGENT_MISCONFIGURED). While both are defensible, `ProcessSpawnerAdapter` uses `INVALID_OPERATION` for its tmux rejection, creating two different error codes for conceptually similar "can't do tmux" failures. This could confuse callers that need to handle both.
- Fix: This is acceptable as-is since the missing-taskId case is genuinely a misconfiguration (the adapter supports tmux but was called incorrectly), while `ProcessSpawnerAdapter`'s case is a capability gap (the adapter fundamentally doesn't support tmux). However, the JSDoc should clarify the expected error code for the taskId case:
  ```typescript
  * Adapters that do not support tmux (e.g. ProcessSpawnerAdapter) must return err with
  * ErrorCode.INVALID_OPERATION. Adapters that support tmux require a non-empty taskId
  * and return err with ErrorCode.AGENT_MISCONFIGURED when it is missing.
  ```

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

### MEDIUM

**TmuxAgentType is now equivalent to AgentProvider** - `src/implementations/tmux/types.ts:22`
**Confidence**: 85%
- Problem: With Gemini removed, `AgentProvider = 'claude' | 'codex'` and `TmuxAgentType = Extract<AgentProvider, 'claude' | 'codex'>` are now identical types. The `Extract` serves no narrowing purpose anymore. The explicit narrowing at `base-agent-adapter.ts:141` (`const agent: TmuxAgentType = this.provider === 'claude' ? 'claude' : 'codex'`) is redundant when `this.provider` can only be `'claude' | 'codex'`.
- Fix: Not blocking -- `TmuxAgentType` remains semantically correct (documents which providers support tmux) and will diverge again if a new provider is added that does not support tmux. The explicit narrowing comment at line 138-141 anticipates this. No action needed unless a follow-up simplification pass is planned.

## Suggestions (Lower Confidence)

- **Gemini references in v1.5.0 release notes Ollama example** - `docs/releases/RELEASE_NOTES_v1.5.0.md:60-63` (Confidence: 65%) -- The v1.5.0 release notes show `beat agents config set gemini runtime ollama` as an example. Since v1.5.0 is a historical document reflecting what was true at that release, updating it is debatable -- but it could confuse readers who reference old release notes. Consider adding a note that Gemini support was removed in a later version, or leave as-is since release notes are point-in-time documents.

- **FEATURES.md only updates date, not content** - `docs/FEATURES.md:5` (Confidence: 62%) -- The PR updates the FEATURES.md "Last Updated" date but does not add a section or note about Gemini removal. Since FEATURES.md lists "currently implemented and working" features, the Gemini removal is arguably reflected by its absence. However, the v0.5.0 section (if it still mentions Gemini) may need updating. Verified: FEATURES.md has no Gemini references, so the date-only update is correct.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Consistency Score**: 8/10
**Recommendation**: CHANGES_REQUESTED

The PR demonstrates strong consistency across the codebase:
- Gemini removal is thorough: source code, CLI, MCP tools, skills, README, and CHANGELOG all updated
- Migration v28 follows established patterns (table rebuild + CASE WHEN mapping, index recreation) matching migrations v2, v22, v26
- Error handling pattern (Result types, `agentMisconfigured` factory) is consistent with existing adapter code
- Test patterns (beforeEach/afterEach lifecycle, `it.each` for parametric tests, `.dispose()` cleanup) match codebase conventions
- JSDoc DECISION comments follow established annotation style

One blocking HIGH issue: the migration v28 documentation in CHANGELOG.md and CLAUDE.md is incomplete -- it omits the `tasks.agent` cleanup that the migration performs. This creates a documentation-implementation inconsistency that should be fixed before merge. The MEDIUM interface JSDoc issue is a minor clarification.
