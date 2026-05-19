# Reliability Review Report

**Branch**: feat/177-agent-adapter-migration -> main
**Date**: 2026-05-19

## Issues in Your Changes (BLOCKING)

### HIGH

**Empty taskId propagated to session name and TaskId field — violates bounded-input invariant** - `src/implementations/base-agent-adapter.ts:131,137`
**Confidence**: 90%
- Problem: `SpawnOptions.taskId` is optional (`string | undefined`). When `undefined`, line 131 produces `name: "beat-task-undefined"` (template literal coerces `undefined` to string) and line 137 casts `'' as TaskId`. The session name `"beat-task-undefined"` passes `SESSION_NAME_REGEX` (`/^beat-[a-z0-9-]+$/`) so it won't be caught downstream, but multiple calls without a taskId would produce duplicate session names, violating the duplicate-session guard in `TmuxConnector.spawn()`. The empty-string `TaskId` would also cause the wrapper script to create a session directory named `sessionsDir/` (empty path segment), which is a filesystem reliability hazard.
- Fix: Add a precondition assertion at the top of `buildTmuxCommand()` requiring `taskId` to be a non-empty string:
  ```typescript
  if (!options.taskId) {
    return err(agentMisconfigured(this.provider, 'buildTmuxCommand requires a non-empty taskId'));
  }
  ```
  This aligns with the assertion density principle — validate preconditions in production code, not just tests.

### MEDIUM

**Type assertion `as TmuxAgentType` bypasses type narrowing** - `src/implementations/base-agent-adapter.ts:136`
**Confidence**: 82%
- Problem: The guard at line 118 checks `this.provider !== 'claude' && this.provider !== 'codex'`, which should narrow `this.provider` to `'claude' | 'codex'`. However, the narrowing does not carry through to line 136 because `this.provider` is a `readonly` abstract property (not a local variable), so TypeScript cannot narrow it across statements. The `as TmuxAgentType` cast suppresses the type error but could silently pass an invalid value if a new provider is added to `AgentProvider` and the guard is not updated. This is a metaprogramming restraint concern — prefer explicit narrowing over type assertions.
- Fix: Capture the narrowed value in a local `const` after the guard:
  ```typescript
  const agent: TmuxAgentType = this.provider === 'claude' ? 'claude' : 'codex';
  ```
  This makes the narrowing explicit and will produce a compile error if `AgentProvider` changes.

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Migration v28 does not verify source table column set before INSERT INTO ... SELECT** - `src/implementations/database.ts:1112-1134` (Confidence: 65%) — The INSERT INTO loops_new ... SELECT FROM loops assumes the source `loops` table has all 31 columns listed. If a database was somehow stuck on a version before `convergence_enabled` was added (v27), this migration would fail with a cryptic SQLite column-count mismatch. The migration framework applies sequentially so this should not happen in practice, but a defensive `PRAGMA table_info` check or a comment documenting the dependency on v27 would add clarity.

- **`buildTmuxCommand` does not validate `sessionsDir` against `SAFE_PATH_REGEX`** - `src/implementations/base-agent-adapter.ts:138` (Confidence: 70%) — `TmuxHooks.validateBaseInputs()` validates `sessionsDir` downstream, but `buildTmuxCommand()` is documented as "pure config assembly" that "does NOT call TmuxConnector." If the config is serialized or logged before reaching the connector, an unsafe path could appear in logs. Validating early at the assembly point would follow the parse-at-boundaries principle.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Reliability Score**: 8/10
**Recommendation**: CHANGES_REQUESTED

The branch is well-structured overall. The Gemini removal is clean and exhaustive — all type definitions, adapters, tests, CLI help text, MCP schemas, and documentation references have been updated consistently. Migration v28 follows the established table-recreation pattern with proper index recreation and data mapping (`CASE WHEN judge_agent = 'gemini' THEN NULL ELSE judge_agent END`). The new `buildTmuxCommand()` method reuses the existing `resolveSpawnConfig()` chain, avoiding duplication. Test coverage for the new method is thorough (30 tests) and the connector forwarding tests verify the `agentArgs` integration end-to-end.

The single blocking HIGH issue is the missing `taskId` precondition check, which could produce duplicate session names and empty filesystem paths when `taskId` is undefined. This is a bounded-input invariant violation that should be addressed before merge. The MEDIUM type assertion issue is a defensive improvement worth addressing while the code is being written.
