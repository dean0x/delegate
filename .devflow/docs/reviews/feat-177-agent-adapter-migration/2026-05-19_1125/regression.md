# Regression Review Report

**Branch**: feat/177-agent-adapter-migration -> main
**Date**: 2026-05-19

## Issues in Your Changes (BLOCKING)

### HIGH

**Existing tasks with agent='gemini' will crash task repository reads** - `src/implementations/task-repository.ts:37`
**Confidence**: 85%
- Problem: The `TaskRowSchema` uses `z.enum(AGENT_PROVIDERS_TUPLE).nullable()` where `AGENT_PROVIDERS_TUPLE` is now `['claude', 'codex']`. Any existing task row in the database with `agent='gemini'` will fail Zod validation when read via `rowToTask()`. The error will be a raw ZodError ("Invalid enum value. Expected 'claude' | 'codex', received 'gemini'") rather than an actionable message. The PR description states "Tasks with agent='gemini' fail with actionable error" but no actionable error path exists for DB reads.
- Fix: Either (a) add a data migration in v28 to set `agent=NULL` on tasks where `agent='gemini'` (similar to how `judge_agent` is handled in the loops migration), or (b) change the Zod schema to accept any string and validate downstream so existing rows can be loaded and displayed with a clear error only when the user attempts to *run* a gemini task. Option (a) is simpler and consistent with the loops table approach. Applies PF-002 -- if gemini tasks are extremely rare or non-existent in production, the Zod crash may be acceptable, but the migration approach is defensive.

### MEDIUM

**Incomplete migration: package.json still references Gemini** - `package.json:76,83`
**Confidence**: 90%
- Problem: `package.json` `keywords` array still contains `"gemini"` and the `description` field still says "Claude, Codex, Gemini." These are npm-facing metadata that will be published with the next release. The PR removes Gemini support but leaves the npm metadata claiming it exists.
- Fix: Remove `"gemini"` from the `keywords` array and update the `description` field to say "Claude, Codex" (or "Claude and Codex").

**Incomplete migration: README.md still references Gemini extensively** - `README.md:61,66,226,240,249,281,300-301,431`
**Confidence**: 88%
- Problem: README.md was not modified in this branch but contains extensive Gemini references: "Autobeat works with Claude Code, Codex, Gemini", "at least one coding agent CLI installed (claude, codex, or gemini)", agent config examples for gemini, environment variable tables listing `GEMINI_API_KEY`/`GEMINI_BASE_URL`, and ollama examples configuring gemini. Users following the README will attempt to use a non-existent agent.
- Fix: Update README.md to remove all Gemini references and examples. This is part of the same removal scope.

**Incomplete migration: skills/ directory still references Gemini** - `skills/autobeat/SKILL.md`, `skills/autobeat/references/*.md`
**Confidence**: 87%
- Problem: The skill files in `skills/autobeat/` contain multiple Gemini references across `SKILL.md`, `capability-matrix.md`, `orchestration.md`, and `loops.md`. These are agent-facing documentation that AI coding agents read when using Autobeat. Outdated references will mislead agents into attempting `agent: 'gemini'` which will fail.
- Fix: Update skill files to remove Gemini from agent lists, capability matrix entries, and system prompt documentation.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**buildTmuxCommand not on AgentAdapter interface** - `src/core/agents.ts:273-310`
**Confidence**: 80%
- Problem: `buildTmuxCommand()` is added to `BaseAgentAdapter` (concrete class) and `ProcessSpawnerAdapter` (concrete class) but NOT to the `AgentAdapter` interface. Code that works with the `AgentAdapter` interface (e.g., the worker pool, agent registry) cannot call `buildTmuxCommand()` without downcasting. This will create a regression in Phase 3 when tmux integration needs to call `buildTmuxCommand()` through the interface-based DI system. The PR description says this is "Track A of Phase 2" which implies Phase 3 will consume this.
- Fix: Add `buildTmuxCommand(options: SpawnOptions & { sessionsDir: string }): Result<{ readonly config: TmuxSpawnConfig; readonly prompt: string }>` to the `AgentAdapter` interface. This ensures Phase 3 can use it through DI without runtime type checks.

## Pre-existing Issues (Not Blocking)

_No CRITICAL pre-existing issues found._

## Suggestions (Lower Confidence)

- **Config file with defaultAgent='gemini' degrades silently** - `src/core/configuration.ts:116-127` (Confidence: 70%) -- When a user's `~/.autobeat/config.json` has `"defaultAgent": "gemini"`, `safeParse` rejects it and falls back to env-only config. The warning message mentions "configuration file validation failed" but does not specifically explain that 'gemini' is no longer supported. Users who configured Gemini as their default will see a generic validation warning rather than a targeted migration message.

- **Loop repository may crash on existing loops with judge_agent context** - `src/implementations/loop-repository.ts` (Confidence: 65%) -- While migration v28 maps `judge_agent='gemini'` to NULL for existing rows, if any code path creates a loop row between v27 migration and v28 migration application (unlikely but possible during rolling upgrade), the CHECK constraint could cause an INSERT failure. The migration is transactional so this is unlikely.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Regression Score**: 5/10
**Recommendation**: CHANGES_REQUESTED

The Gemini removal is structurally sound -- the core type narrowing (`AgentProvider`), adapter deletion, CLI/MCP updates, and migration v28 (loops table) are all well-executed (avoids PF-002 -- clean break forward). However, the migration is incomplete across several surfaces: the task repository Zod schema will crash on existing gemini tasks (HIGH), and multiple documentation/metadata files (package.json, README, skills) still reference Gemini (MEDIUM). The `buildTmuxCommand` interface omission is a Phase 3 regression risk. Fix the HIGH issue and address the MEDIUM documentation gaps before merging.
