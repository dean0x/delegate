# Complexity Review Report

**Branch**: feat/177-agent-adapter-migration -> main
**Date**: 2026-05-19

## Issues in Your Changes (BLOCKING)

No blocking complexity issues found.

## Issues in Code You Touched (Should Fix)

No should-fix complexity issues found.

## Pre-existing Issues (Not Blocking)

### HIGH

**getMigrations() is a 910-line method with 28 inline migration lambdas** - `src/implementations/database.ts:262-1145`
**Confidence**: 95%
- Problem: `getMigrations()` returns an array of 28 migration objects, each containing an inline `up()` lambda with raw SQL. At 910 lines, this single method far exceeds the 200-line CRITICAL threshold. Each migration adds ~30-75 lines, and the method will continue growing with every schema change. While each individual migration is simple, the aggregate makes the file (1,176 lines) difficult to navigate and review.
- Fix: Extract migrations into individual files (e.g., `src/implementations/migrations/v028-remove-gemini-judge.ts`) and have `getMigrations()` import and aggregate them. This is a pattern used by Knex, Drizzle, and other migration frameworks. Each file would be self-contained and independently reviewable.

## Suggestions (Lower Confidence)

- **BaseAgentAdapter accumulating spawn modes** - `src/implementations/base-agent-adapter.ts` (Confidence: 70%) — The adapter now has three build methods (`buildArgs`, `buildInteractiveArgs`, `buildTmuxArgs`) and three spawn methods (`spawn`, `spawnInteractive`, `buildTmuxCommand`), all sharing `resolveSpawnConfig`. At 553 lines the file is above the 500-line warning threshold. Not actionable yet, but worth monitoring as more modes are added.

- **Migration v28 duplicates the full loops table schema (75 lines of SQL)** - `src/implementations/database.ts:1070-1143` (Confidence: 65%) — This is the 4th time the `loops` table has been fully recreated (v11, v22, v26-related pattern, v28). Each recreation duplicates the entire column list. This is an inherent SQLite limitation (no ALTER CHECK) and the pattern is consistent, but the growing column count (31 columns) makes each recreation increasingly error-prone.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | 1 | 0 | 0 |

**Complexity Score**: 8/10
**Recommendation**: APPROVED

The new code introduced in this PR is well-structured and low-complexity:

- `buildTmuxCommand()` (28 lines) is clean — delegates to `resolveSpawnConfig()` for config assembly, builds the result object, and returns. Cyclomatic complexity is ~3 (one provider guard, one Result check, one ternary for runtime args). Well within all thresholds.
- `buildTmuxArgs()` overrides in Claude/Codex adapters are 2-3 lines each — trivial.
- The Gemini adapter deletion (175 lines removed) is a net complexity reduction.
- `agents.ts` CLI commands lost ~101 lines of Gemini-related code — cleaner.
- Migration v28 follows the established table-recreation pattern exactly (consistent with v11, v22, v26). The CASE WHEN for mapping gemini->NULL is straightforward.
- The test file (413 lines) is well-organized with clear sections per adapter and no deep nesting.

The only pre-existing concern is the monolithic `getMigrations()` method, which this PR contributes to but did not create. The new code itself is clean, readable, and follows existing patterns. Avoids PF-001 — flagging the pre-existing migration method as informational, not blocking.
