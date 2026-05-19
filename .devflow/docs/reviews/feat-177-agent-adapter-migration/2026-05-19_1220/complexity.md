# Complexity Review Report

**Branch**: feat/177-agent-adapter-migration -> main
**Date**: 2026-05-19T12:20

## Issues in Your Changes (BLOCKING)

_(none)_

## Issues in Code You Touched (Should Fix)

_(none)_

## Pre-existing Issues (Not Blocking)

### HIGH

**`getMigrations()` method is 891 lines — far exceeds 50-line function threshold** - `src/implementations/database.ts:262`
**Confidence**: 95%
- Problem: The `getMigrations()` method spans lines 262-1152 (891 lines) and contains 28 migration objects with inline SQL. This is well above the CRITICAL threshold (>200 lines) for function length. Each new migration adds ~30-80 lines to this single method. The PR's migration v28 changes (adding the `UPDATE tasks SET agent = NULL` and updating the loops table recreation) are at lines 1069-1150 and follow the existing pattern, but the method itself is the issue.
- Impact: Navigating, reviewing, and modifying migrations requires scrolling through nearly 900 lines. Each new migration compounds the maintenance cost. Any merge conflict in this file requires understanding the full context.
- Fix: This is an established project pattern and extracting migrations would be a separate refactoring effort (e.g., moving each migration to its own file or using a migration registry). Not attributable to this PR — the PR follows the existing convention correctly.

### MEDIUM

**`database.ts` file is 1182 lines — exceeds 500-line file threshold** - `src/implementations/database.ts`
**Confidence**: 90%
- Problem: The file exceeds the 500-line "critical" threshold by over 2x. The bulk is the `getMigrations()` method described above. The PR adds ~8 net lines to this file — a minor contribution to a pre-existing issue.
- Impact: Large file size makes it harder for new contributors to orient and increases merge conflict surface area.
- Fix: Consider extracting migrations into a separate `migrations/` directory with one file per version, loaded by the `Database` class. This is a structural improvement for a future refactoring pass.

## Suggestions (Lower Confidence)

_(none)_

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | 1 | 1 | 0 |

**Complexity Score**: 8/10
**Recommendation**: APPROVED

### Rationale

The changes introduced by this PR are well-structured and low in complexity:

1. **`buildTmuxCommand` hardening** (base-agent-adapter.ts:125-141): Adds a clean taskId guard and replaces an unsafe `as` cast with explicit narrowing via a ternary. The method is 43 lines with clear early-return structure and cyclomatic complexity of ~4 (two guards, one config resolution check, one ternary). Well within acceptable thresholds.

2. **`AgentAdapter` interface extension** (agents.ts:310-327): Adds one method signature with thorough JSDoc. The interface grows to 7 methods, which is reasonable for a protocol that covers spawn/kill/cleanup/tmux lifecycle.

3. **Migration v28 `up` function** (database.ts:1073-1149): ~77 lines of SQL for table recreation — follows the exact pattern established by migrations v2, v3, v11, v22, and v26. The added `UPDATE tasks SET agent = NULL WHERE agent = 'gemini'` line is a single, clear data migration step. The CASE expression for `judge_agent` mapping is straightforward. This migration correctly avoids PF-002 by not adding backward-compatibility paths for the dropped Gemini provider.

4. **Test changes**: The `it.each` consolidation (build-tmux-command.test.ts:395-408) reduces duplication by collapsing two identical tests into a parameterized table — a complexity reduction. The new database migration test (database.test.ts:449-472) is self-contained with proper setup/teardown.

No new functions exceed 50 lines. No nesting deeper than 2 levels in changed code. No boolean complexity introduced. No magic values — all constants are named or self-documenting. The pre-existing `getMigrations()` method size is the only notable complexity concern, and it predates this PR.
