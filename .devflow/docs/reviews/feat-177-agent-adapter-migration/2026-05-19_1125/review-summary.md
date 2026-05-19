# Code Review Summary

**Branch**: feat/177-agent-adapter-migration -> main
**Date**: 2026-05-19_1125
**Reviewers**: 11 specialized agents (security, architecture, performance, complexity, consistency, regression, testing, reliability, typescript, database, documentation)

---

## Merge Recommendation: **CHANGES_REQUESTED**

**Summary**: The PR executes a thorough Gemini removal and introduces solid Phase 2 tmux infrastructure (`buildTmuxCommand`, `buildTmuxArgs`). However, **4 HIGH blocking issues** must be fixed before merge:

1. **Unsafe TaskId cast** — empty-string TaskId bypasses branded-type safety (reliability, typescript)
2. **buildTmuxCommand missing from AgentAdapter interface** — breaks Strategy pattern (architecture, consistency, regression, typescript) 
3. **Incomplete documentation updates** — README.md and skills/ still reference removed Gemini (documentation, regression)
4. **TaskRepository Zod schema crash** — existing gemini tasks will fail with unhelpful errors (regression)

All 4 can be resolved with surgical fixes; no structural changes required.

---

## Issue Aggregation Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| **Blocking** (Your Changes) | 0 | 4 | 0 | - |
| **Should Fix** (Code You Touched) | 0 | 0 | 3 | - |
| **Pre-existing** (Legacy Issues) | 0 | 1 | 6 | 0 |

**Score**: 6.5/10 average across all reviewers
- Security: 9/10 (APPROVED)
- Architecture: 8/10 (APPROVED_WITH_CONDITIONS)
- Performance: 9/10 (APPROVED)
- Complexity: 8/10 (APPROVED)
- Consistency: 7/10 (CHANGES_REQUESTED)
- Regression: 5/10 (CHANGES_REQUESTED)
- Testing: 8/10 (CHANGES_REQUESTED)
- Reliability: 8/10 (CHANGES_REQUESTED)
- TypeScript: 7/10 (CHANGES_REQUESTED)
- Database: 9/10 (APPROVED_WITH_CONDITIONS)
- Documentation: 5/10 (CHANGES_REQUESTED)

---

## Blocking Issues (Must Fix Before Merge)

### 1. 🔴 Empty TaskId Bypass — Branded Type Safety Violation
**Files**: `src/implementations/base-agent-adapter.ts:131, 137`
**Reviewers**: Reliability (HIGH 90%), TypeScript (MEDIUM 90%)
**Severity**: HIGH
**Confidence**: 90%

**Problem**:
- Line 137: `(options.taskId ?? '') as TaskId` casts an empty string to the `TaskId` branded type when taskId is undefined
- `TaskId` is `string & { readonly __brand: 'TaskId' }` — branding should enforce non-empty values
- Empty string produces session name `beat-task-` (line 131) and violates tmux's duplicate-session guard
- Downstream code (session manager, connector) sees empty-string TaskId that passes type checks but is semantically invalid

**Fix**:
Add a precondition guard at the top of `buildTmuxCommand()`:
```typescript
if (!options.taskId) {
  return err(agentMisconfigured(this.provider, 'buildTmuxCommand requires a non-empty taskId'));
}
const taskId = TaskId(options.taskId); // Now safely narrowed to non-empty
```

**Why This Blocks**: Violates bounded-input reliability invariant; will cause silent failures when taskId is undefined.

---

### 2. 🔴 buildTmuxCommand Missing from AgentAdapter Interface
**Files**: `src/core/agents.ts:273-310`, `src/implementations/base-agent-adapter.ts:114`, `src/implementations/process-spawner-adapter.ts:46`
**Reviewers**: Architecture (HIGH 92%), Consistency (HIGH 90%), Regression (HIGH 80%), TypeScript (MEDIUM 82%)
**Severity**: HIGH
**Confidence**: 85%

**Problem**:
- `buildTmuxCommand()` is implemented on both `BaseAgentAdapter` and `ProcessSpawnerAdapter` but NOT declared on the `AgentAdapter` interface
- Code that holds an `AgentAdapter` reference (returned from `AgentRegistry.get()`) cannot call `buildTmuxCommand()` without unsafe casts
- Violates Strategy pattern — all spawn-related methods (`spawn`, `spawnInteractive`, `kill`, `dispose`) are on the interface
- Phase 3 (WorkerPool integration) will need to call this through the interface, forcing unsafe downcasts or a disruptive refactor

**Fix**:
Add to `AgentAdapter` interface in `src/core/agents.ts`:
```typescript
buildTmuxCommand(
  options: SpawnOptions & { sessionsDir: string },
): Result<{ readonly config: TmuxSpawnConfig; readonly prompt: string }>;
```

**Why This Blocks**: Breaks adapter abstraction pattern; Phase 3 will require this or unsafe casts. Fixing now prevents rework later.

---

### 3. 🔴 README.md Not Updated — 5+ Stale Gemini References
**Files**: `README.md:61, 66, 226, 240, 249`
**Reviewers**: Documentation (HIGH 95%), Regression (HIGH 88%)
**Severity**: HIGH
**Confidence**: 95%

**Problem**:
- Line 61: "Autobeat works with Claude Code, Codex, Gemini"
- Line 66: Prerequisites list `gemini` as an agent option
- Line 226: "Four agent runtimes" (Gemini still listed)
- Line 240: Example `beat agents config set gemini`
- Line 249: `GEMINI_API_KEY` table row

The primary user-facing document actively instructs new users to configure a removed agent, causing immediate configuration failures.

**Fix**:
- Update to "Two agent runtimes" or "Claude Code and Codex"
- Remove all `gemini` CLI examples and config references
- Remove `GEMINI_*` env var rows from tables
- Remove Gemini from prerequisites list

**Why This Blocks**: Direct user-facing regression — users will waste time configuring non-existent agent.

---

### 4. 🔴 Skills Files Not Updated — 10+ Stale Gemini References
**Files**: 
- `skills/autobeat/SKILL.md:15, 164, 185`
- `skills/autobeat/references/capability-matrix.md:20, 22, 344, 400, 533`
- `skills/autobeat/references/loops.md:238`
- `skills/autobeat/references/orchestration.md:48`

**Reviewers**: Documentation (HIGH 95%), Regression (HIGH 87%)
**Severity**: HIGH
**Confidence**: 95%

**Problem**:
- Skills files provide structured context injected into AI agents
- These files still list `gemini` as a supported agent, document the removed `beat agents refresh-base-prompt` command, and reference `GEMINI_SYSTEM_MD`
- AI agents using Autobeat will attempt to use Gemini, generating invalid commands

**Fix**:
- Update all agent selection references from `claude, codex, gemini` to `claude, codex`
- Remove `GEMINI_SYSTEM_MD` documentation
- Remove `beat agents refresh-base-prompt` command documentation
- Remove Gemini from capability matrix rows

**Why This Blocks**: Direct regression for AI agents using the tool — they will attempt removed functionality.

---

## Should-Fix Issues (Code You Touched)

### 1. ⚠️ TaskRepository Zod Schema Will Crash on Existing Gemini Tasks
**Files**: `src/implementations/task-repository.ts:37`
**Reviewers**: Regression (HIGH 85%)
**Severity**: HIGH
**Confidence**: 85%

**Problem**:
- `TaskRowSchema` validates `z.enum(AGENT_PROVIDERS_TUPLE).nullable()` where `AGENT_PROVIDERS_TUPLE = ['claude', 'codex']`
- Any task row with `agent='gemini'` will fail Zod validation during `rowToTask()` with unhelpful error: "Invalid enum value. Expected 'claude' | 'codex', received 'gemini'"
- PR description promises "Tasks with agent='gemini' fail with actionable error" but no actionable error path exists

**Fix**:
Add data migration in v28 (similar to loops table) to map `agent='gemini'` to `NULL`:
```sql
UPDATE tasks SET agent = CASE WHEN agent = 'gemini' THEN NULL ELSE agent END;
```

Then update TaskRowSchema to handle NULL gracefully.

**Why This Is Critical**: Existing production databases with gemini tasks will crash silently during task reads.

---

### 2. ⚠️ Type Assertion `as TmuxAgentType` Bypasses Type Narrowing
**Files**: `src/implementations/base-agent-adapter.ts:136`
**Reviewers**: Architecture (HIGH 85%), Consistency (MEDIUM 82%), Reliability (MEDIUM 82%), TypeScript (MEDIUM 65%)
**Severity**: MEDIUM
**Confidence**: 82%

**Problem**:
- Runtime guard at line 118 checks `if (this.provider !== 'claude' && this.provider !== 'codex')` correctly
- But TypeScript cannot narrow `this.provider` (a readonly property) across statements, so the cast `as TmuxAgentType` is needed
- The cast suppresses compiler checks — if `AgentProvider` is extended with a new value, the guard might be forgotten and the cast would silently pass invalid data

**Fix**:
Use explicit type narrowing instead of assertion:
```typescript
const agent: TmuxAgentType = this.provider === 'claude' ? 'claude' : 'codex';
```
This makes narrowing explicit and produces a compile error if `AgentProvider` changes.

**Why This Matters**: Defensive improvement against future type extensions.

---

### 3. ⚠️ buildTmuxArgs Not Abstract — Silent Empty Array Default
**Files**: `src/implementations/base-agent-adapter.ts:105`
**Reviewers**: Consistency (HIGH 82%)
**Severity**: MEDIUM
**Confidence**: 82%

**Problem**:
- `buildArgs` and `buildInteractiveArgs` are both `protected abstract` (enforced on all subclasses)
- `buildTmuxArgs` is `protected` with a default empty-array implementation (not abstract)
- Pattern inconsistency: new adapters could silently produce empty args for tmux instead of getting a compile-time error

**Fix**:
Either:
1. Make `buildTmuxArgs` abstract to match the pattern, OR
2. Add a JSDoc DECISION comment explaining why tmux args are optional:
```typescript
/**
 * DECISION: buildTmuxArgs is non-abstract (returns [] by default) because:
 * - ProcessSpawnerAdapter doesn't support tmux; it returns INVALID_OPERATION in buildTmuxCommand()
 * - Making this abstract would require ProcessSpawnerAdapter to implement it just for consistency
 * - The guard at buildTmuxCommand line 118 prevents non-tmux adapters from reaching this method
 */
protected buildTmuxArgs(options: SpawnOptions): readonly string[] {
  return [];
}
```

---

## Pre-existing Issues (Not Blocking)

### 1. Pre-existing: getMigrations() Method Exceeds 200-Line Threshold
**Files**: `src/implementations/database.ts:262-1145` (910 lines)
**Reviewers**: Complexity (HIGH 95%)
**Severity**: HIGH
**Confidence**: 95%

**Problem**:
- Single method contains 28 inline migration lambdas (~30-75 lines each)
- File is 1,176 lines total; method makes it difficult to navigate and review

**Note**: This is pre-existing and contributed to by this PR, but not introduced by it. Defer to separate refactor task (extract migrations into individual files per Knex/Drizzle pattern).

---

### 2. Pre-existing: BaseAgentAdapter Approaching Complexity Threshold
**Files**: `src/implementations/base-agent-adapter.ts` (553 lines)
**Reviewers**: Complexity (HIGH 70%)
**Severity**: MEDIUM
**Confidence**: 70%

**Problem**:
- Now has three build methods (`buildArgs`, `buildInteractiveArgs`, `buildTmuxArgs`) and three spawn methods
- File is 553 lines (above 500-line warning threshold)
- Not actionable yet but worth monitoring as more modes are added

**Note**: Pre-existing structural trend; not critical for this PR.

---

### 3. Pre-existing: CHANGELOG.md Still References Gemini in Historical Entries
**Files**: `CHANGELOG.md:58, 139`
**Reviewers**: Documentation (MEDIUM 65%)
**Severity**: MEDIUM
**Confidence**: 65%

**Problem**:
- Historical entries (v0.5.0, v1.0.0 release notes) reference Gemini
- Factually accurate for their time but could confuse readers

**Note**: Optional cleanup — historical entries can remain unchanged to preserve version history.

---

## Additional Should-Address Recommendations

### Testing Coverage
**Finding**: Missing error path test for buildTmuxCommand when CLI not in PATH
**Files**: `tests/unit/implementations/build-tmux-command.test.ts`
**Reviewers**: Testing (HIGH 85%)
**Recommendation**: Add negative test case for CLI resolution failure

### Testing Coverage
**Finding**: Missing test for CodexAdapter model passthrough in buildTmuxCommand
**Files**: `tests/unit/implementations/build-tmux-command.test.ts`
**Reviewers**: Testing (HIGH 82%)
**Recommendation**: Add test for `--model` arg in CodexAdapter tmux path

### Test Cleanup
**Finding**: Two return-shape tests don't call adapter.dispose()
**Files**: `tests/unit/implementations/build-tmux-command.test.ts:78-104`
**Reviewers**: Testing (MEDIUM 85%)
**Recommendation**: Add afterEach cleanup hook

### Documentation
**Finding**: CHANGELOG.md missing [Unreleased] entry for breaking change
**Files**: `CHANGELOG.md`
**Reviewers**: Documentation (MEDIUM 90%)
**Recommendation**: Add entry documenting Gemini removal, CLI command removal, migration v28

### Documentation
**Finding**: FEATURES.md "Last Updated" header is stale
**Files**: `docs/FEATURES.md:5`
**Reviewers**: Documentation (MEDIUM 85%)
**Recommendation**: Update to current date (2026-05-19)

---

## Strengths of This PR

1. **Gemini Removal is Thorough** — All 52 changed files have consistent updates: type narrowing, adapter deletion, CLI help text, MCP schemas, tests. No orphaned references remain in source code.

2. **Phase 2 tmux Infrastructure is Solid** — `buildTmuxCommand()` reuses `resolveSpawnConfig()` cleanly, avoids duplication, and produces a well-typed `TmuxSpawnConfig` result.

3. **Migration v28 is Safe** — Table recreation follows established pattern, CHECK constraint narrowed correctly, data mapping (`judge_agent='gemini'` → NULL) is sound, indexes recreated, transaction-protected.

4. **Test Coverage is Strong** — New `build-tmux-command.test.ts` (413 lines, 30 tests) thoroughly covers Claude, Codex, ProxiedClaude, and ProcessSpawnerAdapter paths. FakeAdapter boundary test is excellent. Migration v28 tests validate schema changes.

5. **Security Review Clean** — Shell injection analysis passed; arg escaping via `singleQuoteToken()` is correct; no hardcoded credentials introduced.

6. **Performance Impact is Minimal** — `buildTmuxCommand()` is pure config assembly (no new I/O), migration v28 is one-time, and Gemini adapter deletion removes unnecessary sync I/O.

---

## Action Plan

### Before Merge (Required)

1. **Fix TaskId validation** — Add precondition guard in buildTmuxCommand() (5 min)
2. **Add buildTmuxCommand to AgentAdapter interface** — Declare method on interface (10 min)
3. **Update README.md** — Remove all 5 Gemini references (15 min)
4. **Update skills/ files** — Remove Gemini from SKILL.md, capability-matrix.md, loops.md, orchestration.md (20 min)
5. **Add task agent migration** — Map agent='gemini' to NULL in v28 (10 min)

**Total**: ~60 min work

### After Merge (Recommended)

1. Extract migrations into individual files per Knex pattern (reduce getMigrations() from 910 lines)
2. Add optional narrowing helper for TmuxAgentType instead of `as` cast
3. Add CHANGELOG.md entry documenting breaking change
4. Monitor BaseAgentAdapter file size (553 lines approaching threshold)

---

## Decisions Context

- **Applies PF-002**: Gemini removal is a clean break (no backward-compatibility scaffolding) for a feature with zero users in production. Correct per project guidelines.
- **Applies avoids PF-001**: No security issues deferred; all patterns addressed in-branch.
- **Phase 2 deliverable**: Track A complete (tmux config production, agent adapters extended). Phase 3 (WorkerPool integration) will depend on buildTmuxCommand being available via AgentAdapter interface.

---

## Summary for Orchestrator

**Status**: 4 HIGH blocking issues identified. All fixable with surgical changes (no refactoring required).

**Confidence**: 95% — issues identified by 2-4 independent reviewers each (cross-reviewer consensus).

**Recommendation**: Request changes. Once the 4 blocking issues are fixed, this PR is approved.

**Time to Fix**: ~60 minutes of targeted work.
