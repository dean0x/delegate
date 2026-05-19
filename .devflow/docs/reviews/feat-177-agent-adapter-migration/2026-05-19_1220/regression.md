# Regression Review Report

**Branch**: feat/177-agent-adapter-migration -> main
**Date**: 2026-05-19T12:20

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

**CHANGELOG does not document tasks.agent='gemini' to NULL migration** - `CHANGELOG.md:13`
**Confidence**: 85%
- Problem: Migration v28 now includes an `UPDATE tasks SET agent = NULL WHERE agent = 'gemini'` statement, but the CHANGELOG entry for v28 only mentions the `loops.judge_agent CHECK` constraint narrowing. The `tasks.agent` column cleanup is a silent data modification that existing users upgrading from v1.5.2 should know about -- their Gemini tasks will have `agent` set to NULL post-migration. This is a documentation regression: the code does more than the CHANGELOG says.
- Fix: Add the tasks.agent cleanup to the CHANGELOG database section:
```markdown
- **Migration v28**: Recreates `loops` table with `judge_agent CHECK` constraint narrowed to `('claude', 'codex')`. Existing `judge_agent='gemini'` rows mapped to `NULL` (reverts to loop's own agent). Existing `tasks.agent='gemini'` rows mapped to `NULL` to survive narrowed Zod validation.
```

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Migration v28 tasks.agent UPDATE is outside the transaction that recreates loops** - `src/implementations/database.ts:1077` (Confidence: 65%) -- The `UPDATE tasks SET agent = NULL WHERE agent = 'gemini'` runs before the loops table recreation. Both are inside `applyMigrations` which wraps each migration in a transaction, so this is safe. However, if the loops table recreation fails after the UPDATE, the migration rolls back as a unit -- which is correct behavior. No action needed, just noting the dependency ordering.

- **Historical v1.4.0 CHANGELOG entry still references Gemini adapters** - `CHANGELOG.md:65` (Confidence: 60%) -- The v1.4.0 entry mentions "wired through Claude, Codex, and Gemini adapters" which is historically accurate. Rewriting history in past release entries would be wrong, so no change needed. Just confirming this was considered.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | - | 0 | 0 |

**Regression Score**: 8/10
**Recommendation**: CHANGES_REQUESTED

## Regression Checklist

- [x] No exports removed without deprecation -- `buildTmuxCommand` added to `AgentAdapter` interface; all three implementations (`BaseAgentAdapter`, `ProcessSpawnerAdapter`, `ClaudeAdapter`/`CodexAdapter` via inheritance) already had the method before this PR. No breaking interface change.
- [x] Return types backward compatible -- `buildTmuxCommand` signature unchanged from pre-existing implementation; now formalized in the interface.
- [x] Default values unchanged -- No default value changes detected.
- [x] Side effects preserved -- No event emissions or logging removed.
- [x] All consumers of changed code updated -- `AgentProvider` narrowed from `'claude' | 'codex' | 'gemini'` to `'claude' | 'codex'`. Verified: no remaining Gemini references in `src/` (only in `database.ts` migration code which is correct). All Zod schemas (`TaskRowSchema`, `LoopRowSchema`, `PipelineRowSchema`) use `AGENT_PROVIDERS_TUPLE` which is now `['claude', 'codex']`. Migration v28 handles existing data.
- [x] Migration complete across codebase -- README, FEATURES.md, skills, CLAUDE.md, CHANGELOG all updated. Release notes (historical) correctly retain Gemini references. `docs/ROADMAP.md` and `docs/FEATURES.md` have no stale Gemini references.
- [x] CLI options preserved or deprecated -- CHANGELOG documents `beat agents refresh-base-prompt` removal (Gemini-only command).
- [x] Commit message matches implementation -- 7 commits all accurately describe their changes (interface addition, taskId guard, test fixes, migration fix, formatting).
- [ ] Breaking changes documented in CHANGELOG -- Partially. Gemini removal and CLI command removal are documented. Migration v28 `tasks.agent` cleanup is NOT documented (the HIGH finding above).

## Detailed Analysis

### 1. AgentAdapter Interface Extension (No Regression)

The `buildTmuxCommand` method was added to the `AgentAdapter` interface (`src/core/agents.ts:310-327`). This formalizes a method that already existed on both `BaseAgentAdapter` (line 121) and `ProcessSpawnerAdapter` (line 46). All three implementing classes already had this method before the PR. The interface change is additive and non-breaking.

The `taskId` guard added at `base-agent-adapter.ts:125-132` is a defensive improvement -- returning `err(AGENT_MISCONFIGURED)` when `taskId` is missing instead of silently using an empty string via `(options.taskId ?? '')`. The old cast `as TaskId` on an empty string was unsafe; the new guard is strictly better.

The explicit narrowing at `base-agent-adapter.ts:141` replaces `this.provider as TmuxAgentType` with a conditional that avoids a type assertion. This is a correctness improvement with no behavioral change.

### 2. Migration v28 Data Handling (Correct but Under-documented)

Migration v28 now includes `UPDATE tasks SET agent = NULL WHERE agent = 'gemini'` (line 1077). This is necessary because `TaskRowSchema` at `task-repository.ts:37` uses `z.enum(AGENT_PROVIDERS_TUPLE).nullable()` where `AGENT_PROVIDERS_TUPLE` is now `['claude', 'codex']`. Without this migration UPDATE, any existing task with `agent='gemini'` would fail Zod validation on read, causing a runtime crash. The migration correctly handles this. The test at `database.test.ts:449-472` verifies this behavior. `avoids PF-002` -- no backward-compatibility shim for a clean break.

### 3. Gemini Removal Completeness (Complete)

Verified no remaining Gemini references in:
- `src/` (only migration code, which is correct)
- `README.md` (all cleaned)
- `docs/FEATURES.md` (all cleaned)
- `docs/ROADMAP.md` (none found)
- `skills/autobeat/` (all cleaned)
- `CLAUDE.md` (only migration v28 documentation reference, which is correct)

Historical release notes (`docs/releases/RELEASE_NOTES_v*.md`) correctly retain Gemini references as they document past releases.

### 4. Test Coverage (Adequate)

New tests cover:
- `buildTmuxCommand` return shape validation (lines 91-107)
- Prompt field equality (lines 109-115)
- CodexAdapter-specific tmux args (lines 280-340) including `--model` override
- Missing taskId guard via `it.each` across both adapters (lines 394-409)
- Migration v28 tasks.agent=gemini to NULL mapping (lines 449-472)
- Migration v28 judge_agent CHECK constraint (lines 373-447, pre-existing + extended)

Test lifecycle management improved with `beforeEach`/`afterEach` for adapter creation and disposal (lines 81-89), fixing potential resource leaks in the previous inline instantiation pattern.
