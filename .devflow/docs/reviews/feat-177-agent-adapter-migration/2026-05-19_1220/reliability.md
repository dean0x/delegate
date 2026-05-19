# Reliability Review Report

**Branch**: feat/177-agent-adapter-migration -> main
**Date**: 2026-05-19T12:20

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

(none)

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | - | 0 | 0 |

**Reliability Score**: 9/10
**Recommendation**: APPROVED

## Rationale

All changes in this PR demonstrate sound reliability practices:

1. **Bounded iteration / assertion density**: The `buildTmuxCommand` method adds an explicit taskId precondition guard (line 125-132) that returns a typed `err(agentMisconfigured(...))` rather than proceeding with an empty string or throwing. This is the correct assertion-at-boundary pattern.

2. **Explicit narrowing over unsafe casts**: The new code at line 138-141 replaces `this.provider as TmuxAgentType` with a conditional assignment (`this.provider === 'claude' ? 'claude' : 'codex'`) preceded by an unsupported-provider guard. This eliminates a latent cast bug if `AgentProvider` gains new values -- the guard at line 134 rejects unknown providers before the narrowing is reached.

3. **Migration v28 data safety**: The DROP TABLE + RENAME pattern for `loops` is an established pattern in this codebase (3rd occurrence: migrations v10, v22, v26, v28). SQLite does not fire FK ON DELETE CASCADE triggers on DROP TABLE, so `loop_iterations` rows are preserved. The migration also correctly handles the `tasks.agent='gemini'` cleanup via a simple UPDATE before the loops table rebuild, with a clear comment explaining why a DB-level CHECK is unnecessary (Zod handles validation at the application boundary).

4. **Transaction safety**: Each migration runs inside its own `db.transaction()` wrapper (lines 232-243 of database.ts), so a v28 failure rolls back atomically without corrupting the database.

5. **Resource cleanup in tests**: The new test code properly calls `adapter.dispose()` in `afterEach` hooks (lines 87-89) and inline in the `it.each` test (line 407), preventing kill-timeout leaks. The `freshDb.close()` call at line 471 in the database test prevents SQLite handle leaks.

6. **No unbounded loops or retries introduced**: All new code paths are straight-line with early returns on error -- no loops, retries, or recursive calls.

The `as TaskId` branded-type cast at line 158 is safe because the guard at line 125 already validated `options.taskId` is truthy (non-empty), and `TaskId` is a nominal brand (`string & { __brand: 'TaskId' }`) whose constructor at `domain.ts:16` uses the same `as TaskId` pattern. This is consistent with the project's branded-type convention.

No pitfalls from the decisions index apply to reliability concerns in this diff. PF-002 (avoids PF-002) is relevant context: the Gemini removal is a clean break with no backward-compatibility scaffolding, which is correct for a feature with zero external users.
