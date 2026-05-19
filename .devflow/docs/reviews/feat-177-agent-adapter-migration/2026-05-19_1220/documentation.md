# Documentation Review Report

**Branch**: feat/177-agent-adapter-migration -> main
**Date**: 2026-05-19

## Issues in Your Changes (BLOCKING)

### HIGH

**CHANGELOG migration v28 description omits tasks.agent cleanup** - `CHANGELOG.md:14`
**Confidence**: 92%
- Problem: The CHANGELOG [Unreleased] migration v28 entry only mentions the `loops.judge_agent` CHECK constraint narrowing, but the actual migration v28 code also runs `UPDATE tasks SET agent = NULL WHERE agent = 'gemini'`. This is a meaningful data migration that users upgrading should know about -- their existing Gemini tasks will have their agent field set to NULL.
- Fix: Update the CHANGELOG migration v28 entry to mention the tasks.agent remapping:
```markdown
- **Migration v28**: Recreates `loops` table with `judge_agent CHECK` constraint narrowed to `('claude', 'codex')`. Existing `judge_agent='gemini'` rows mapped to `NULL` (reverts to loop's own agent). Existing `tasks.agent='gemini'` rows mapped to `NULL` (falls back to default agent).
```

**CLAUDE.md migration v28 description incomplete** - `CLAUDE.md:254`
**Confidence**: 90%
- Problem: The CLAUDE.md Database section describes migration v28 as only removing 'gemini' from `judge_agent` CHECK values, but the migration also clears `tasks.agent='gemini'` rows to NULL. This is developer-facing documentation that guides future contributors working on the codebase; an incomplete migration description creates confusion about what v28 actually does.
- Fix: Update line 254:
```markdown
- `loops.judge_agent` CHECK constraint updated: removes 'gemini' from allowed values; `tasks.agent='gemini'` rows mapped to NULL (migration v28)
```

### MEDIUM

**CHANGELOG [Unreleased] missing `buildTmuxCommand` addition to AgentAdapter interface** - `CHANGELOG.md:7-15`
**Confidence**: 82%
- Problem: The [Unreleased] section documents Gemini removal and migration v28, but does not document the addition of `buildTmuxCommand()` to the `AgentAdapter` interface (`src/core/agents.ts`). This is an internal API change, but it is a **breaking interface change** for any code implementing `AgentAdapter` -- all implementers must now provide this method. The PR description explicitly calls out this method as a key change.
- Fix: Add an entry under a `### Changed` or `### Added` section:
```markdown
### Added
- **`buildTmuxCommand()` on AgentAdapter interface**: Pure config assembly method producing `TmuxSpawnConfig` + prompt for Phase 3 tmux session migration. Adapters that do not support tmux return `INVALID_OPERATION`. (#177)
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**FEATURES.md "Last Updated" bumped without corresponding feature content** - `docs/FEATURES.md:5`
**Confidence**: 85%
- Problem: The "Last Updated" date was changed from `2026-05-08` to `2026-05-19`, but no feature content was added or changed in FEATURES.md. The date bump implies new feature documentation was added, which is misleading. Gemini was already removed from FEATURES.md in a prior commit (the diff shows no Gemini references were removed from this file). The date should only change when feature content changes.
- Fix: Revert the "Last Updated" date to `2026-05-08`, or add actual feature content documenting the Gemini removal and buildTmuxCommand addition (if this PR is intended to be the release that documents these changes).

## Pre-existing Issues (Not Blocking)

### MEDIUM

**CLAUDE.md v1.4.0 system prompt section still references Gemini adapter** - `CHANGELOG.md:65`
**Confidence**: 60% (below threshold -- moved to Suggestions)

## Suggestions (Lower Confidence)

- **Historical CHANGELOG entries still reference Gemini** - `CHANGELOG.md:65,107,146,164,347` (Confidence: 65%) -- The v1.4.0, v1.3.0, v1.1.0, v1.0.0, and v0.5.0 CHANGELOG entries reference Gemini. These are historical records and should NOT be changed -- they accurately describe what was shipped in those versions. Mentioning for completeness only.

- **PR description mentions "three-tier arg system" but no documentation explains it** - (Confidence: 68%) -- The PR description references a "three-tier arg system" (buildArgs, buildInteractiveArgs, buildTmuxArgs), but the ARCHITECTURE docs in the repo and the code JSDoc do not explain this pattern explicitly. The individual method JSDoc exists, but a short architectural note in `src/implementations/base-agent-adapter.ts` or `docs/architecture/` connecting the three tiers would aid future contributors.

- **JSDoc on `buildTmuxCommand` references "Phase 3" without linking to the epic** - `src/core/agents.ts:312-323` (Confidence: 72%) -- The JSDoc mentions "Phase 3 (WorkerPool rewiring)" multiple times but doesn't reference epic #175 or any design doc. A contributor reading the code cannot easily find the plan this refers to.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | - | 2 | 1 | - |
| Should Fix | - | - | 1 | - |
| Pre-existing | - | - | - | - |

**Documentation Score**: 6/10
**Recommendation**: CHANGES_REQUESTED

The documentation updates for Gemini removal in README.md, SKILL.md, capability-matrix.md, loops.md, and orchestration.md are thorough and consistent. The CHANGELOG properly documents the breaking changes in the [Unreleased] section. However, the migration v28 description in both CHANGELOG.md and CLAUDE.md is incomplete -- it omits the `tasks.agent` cleanup that the migration actually performs. The `buildTmuxCommand` interface addition is also undocumented in the CHANGELOG despite being a breaking API change for `AgentAdapter` implementers.
