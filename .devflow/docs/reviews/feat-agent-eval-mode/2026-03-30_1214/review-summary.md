# Code Review Summary

**Branch**: feat-agent-eval-mode → main
**PR**: #125
**Date**: 2026-03-30_1214
**Reviewers**: Security, Architecture, Performance, Complexity, Consistency, Regression, Tests, TypeScript, Documentation

---

## Merge Recommendation: CHANGES_REQUESTED

**Core Issue**: The feature is architecturally sound with strong test coverage, but **four critical regressions prevent agent eval mode from working through the MCP interface and scheduled loops**. Additionally, **duplicate code in the stale state guard and cleanup logic creates maintenance hazards**, and **documentation has not been updated for this significant feature**. These are all straightforward to fix and do not require architectural changes.

**Confidence Summary**: Issues have high confidence (80-95% across reviewers) and are concrete, actionable, and well-documented in individual reports.

---

## Issue Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW | Total |
|----------|----------|------|--------|-----|-------|
| **Blocking** (in your changes) | 0 | 9 | 7 | 0 | **16** |
| **Should Fix** (code you touched) | 0 | 0 | 6 | 0 | **6** |
| **Pre-existing** (legacy issues) | 0 | 0 | 3 | 1 | **4** |

---

## Blocking Issues (MUST FIX BEFORE MERGE)

### CRITICAL
_(none)_

### HIGH (9 issues)

**1. Orphan eval agent tasks on loop cancellation** [Architecture] — `src/services/handlers/loop-handler.ts:277`, `src/services/agent-exit-condition-evaluator.ts:64`
- **Confidence**: 85%
- **Problem**: When a loop is cancelled, the eval task is not tracked in `taskToLoop` by design, so it continues running as an orphan. Wastes worker slots.
- **Fix**: Track eval task ID in LoopHandler and emit `TaskCancelled` event on loop cancellation, OR inject `AbortSignal` into evaluator.

**2. JSON Schema for CreateLoop still requires `exitCondition`** [Regression] — `src/adapters/mcp-adapter.ts:1043`
- **Confidence**: 95%
- **Problem**: The manually-defined JSON Schema for MCP tool discovery requires `exitCondition`, but the Zod schema makes it optional for agent mode. MCP clients will reject agent-mode requests.
- **Fix**: Change `required: ['strategy', 'exitCondition']` to `required: ['strategy']` on line 1043.

**3. JSON Schema for ScheduleLoop still requires `exitCondition`** [Regression] — `src/adapters/mcp-adapter.ts:1180`
- **Confidence**: 95%
- **Problem**: Same as above for ScheduleLoop tool.
- **Fix**: Change `required: ['strategy', 'exitCondition', 'scheduleType']` to `required: ['strategy', 'scheduleType']` on line 1180.

**4. JSON Schema for CreateLoop missing `evalMode`, `evalPrompt` properties** [Regression] — `src/adapters/mcp-adapter.ts:966-1044`
- **Confidence**: 92%
- **Problem**: The Zod schema includes `evalMode` and `evalPrompt`, and the handler passes them, but the JSON Schema in `listTools()` does not expose them. MCP clients cannot discover these fields.
- **Fix**: Add `evalMode` and `evalPrompt` to the JSON Schema `properties` block, and update `exitCondition` description to note it is required only for shell eval mode.

**5. JSON Schema for ScheduleLoop missing `evalMode`, `evalPrompt` properties** [Regression] — `src/adapters/mcp-adapter.ts:1146-1181`
- **Confidence**: 92%
- **Problem**: Same as above for ScheduleLoop.
- **Fix**: Add `evalMode` and `evalPrompt` to ScheduleLoop JSON Schema.

**6. `schedule-manager.ts` validation blocks agent-mode scheduled loops** [Regression] — `src/services/schedule-manager.ts:485`
- **Confidence**: 90%
- **Problem**: `createScheduledLoop()` unconditionally rejects empty `exitCondition`, even for agent eval mode where it is intentionally empty.
- **Fix**: Guard with `if (evalMode === 'shell')` before checking `exitCondition`.

**7. Unsafe `as` casts on `eval_mode` bypass type safety** [TypeScript] — `src/implementations/loop-repository.ts:609`, `src/adapters/mcp-adapter.ts:2181`, `src/adapters/mcp-adapter.ts:2512`
- **Confidence**: 85%
- **Problem**: The Zod schema validates `eval_mode` as bare `z.string()` instead of `z.enum(['shell', 'agent'])`, then the code casts to a narrower type. Bypasses validation.
- **Fix**: Change `LoopRowSchema.eval_mode` from `z.string().default('shell')` to `z.enum(['shell', 'agent']).default('shell')`. Remove casts in mcp-adapter.ts (Zod already narrows the type).

**8. parseLoopCreateArgs exceeds function length threshold (238 lines)** [Complexity] — `src/cli/commands/loop.ts:40-278`
- **Confidence**: 88%
- **Problem**: Adding agent eval mode pushed this function to 238 lines with ~25 decision points. The agent and shell branches are cleanly separable but inlined.
- **Fix**: Extract `parseAgentModeArgs()` and `parseShellModeArgs()` helpers to split the function. Reduces both paths from ~120 lines to ~60 lines.

**9. handleTaskTerminal exceeds function length (148 lines) with duplicated cleanup** [Complexity] — `src/services/handlers/loop-handler.ts:182-330`
- **Confidence**: 85%
- **Problem**: The stale state guard adds 43 lines with 3 identical cleanup blocks (`cleanupPipelineTaskTracking`, `taskToLoop.delete`, `cleanupPipelineTasks`). Maintenance hazard.
- **Fix**: Extract a `cleanupIterationTracking()` helper and refetch into `refetchAfterEval()` method. Use try/finally to ensure cleanup always runs.

---

### MEDIUM (7 issues)

**10. `evalMode` string literal union instead of enum** [Architecture] — `src/core/domain.ts:536`, `src/adapters/mcp-adapter.ts:2178`
- **Confidence**: 83%
- **Problem**: No single source of truth for eval modes. Use `as 'shell' | 'agent'` casts instead of a canonical enum. Lacks exhaustiveness checking in `CompositeExitConditionEvaluator`.
- **Fix**: Define `export enum EvalMode { SHELL = 'shell', AGENT = 'agent' }` in domain.ts. Use in all places, add default case to composite evaluator's switch.

**11. Unbounded `evalFeedback` stored in SQLite** [Security] — `src/services/agent-exit-condition-evaluator.ts:234-235`
- **Confidence**: 85%
- **Problem**: The eval agent output (minus last line) is stored verbatim in `loop_iterations` table with no size cap. A misbehaving agent could produce megabytes, causing DB bloat.
- **Fix**: Truncate feedback to `const MAX_FEEDBACK_LENGTH = 16000` before storage (consistent with 8000-char cap on `evalPrompt`).

**12. No `.max()` upper-bound enforcement in Zod schema for evalTimeout** [Security] — `src/adapters/mcp-adapter.ts:255-260`
- **Confidence**: 82%
- **Problem**: MCP schema allows `evalTimeout: 999999999` which only fails at service layer, not at boundary. Violates "validate at boundaries" principle.
- **Fix**: Add `.max(600000)` to Zod schema for both `CreateLoopSchema` and `ScheduleLoopSchema` (use agent limit; service layer handles mode-specific enforcement).

**13. Schema default inconsistency between CreateLoop and ScheduleLoop** [Consistency] — `src/adapters/mcp-adapter.ts:246` vs `src/adapters/mcp-adapter.ts:317`
- **Confidence**: 92%
- **Problem**: `CreateLoopSchema.evalMode` has `.default('shell')` but `ScheduleLoopSchema.evalMode` does not. Different MCP tool descriptions for the same field.
- **Fix**: Add `.default('shell')` to ScheduleLoop's `evalMode` definition.

**14. Orchestrator prompt documents invalid CLI syntax** [Consistency] — `src/services/orchestrator-prompt.ts:45`
- **Confidence**: 90%
- **Problem**: Example shows `beat loop "<prompt>" --until "..." --strategy retry`, but parser rejects `--strategy` in shell mode. Orchestrator agents following this will get validation error.
- **Fix**: Remove `--strategy retry` from shell eval example (strategy is inferred from `--until` or `--eval`).

**15. Stale-guard cleanup code duplicated verbatim (3 locations)** [Consistency/Complexity] — `src/services/handlers/loop-handler.ts:294-296`, `313-315`, `324-326`
- **Confidence**: 90%
- **Problem**: Identical 3-line cleanup sequence repeated 3 times. If cleanup logic changes, all sites must be updated in sync.
- **Fix**: Extract helper `cleanupIterationTracking(iteration, taskId, loopId)` and call from all three locations.

**16. Unbounded output concatenation in parseEvalOutput** [Performance] — `src/services/agent-exit-condition-evaluator.ts:114`
- **Confidence**: 85%
- **Problem**: Joins full stdout/stderr arrays into a string, then splits again. Creates unnecessary memory copies for large agent output (50-100KB for code review analysis).
- **Fix**: Only parse last N lines; avoid join-then-split round-trip. Work directly with filtered lines array.

---

## Should-Fix Issues (Lower Priority, But Do It Now While Here)

### MEDIUM (6 issues)

**17. Eval task inherits workingDirectory without isolation** [Security] — `src/services/agent-exit-condition-evaluator.ts:47-52`
- **Confidence**: 80%
- **Problem**: Eval agent has full read/write access to the loop's working directory. While architecturally designed to read-only, no enforcement exists. A side-effecting eval agent could corrupt the loop's git state.
- **Fix**: Document the constraint explicitly. Add a safety note in the eval prompt: "IMPORTANT: Do NOT modify any files. You are an evaluator — read and assess only." Consider temp worktree clone for stronger isolation (future enhancement).

**18. Mixed repository naming: `outputRepository` vs `loopRepo`** [Consistency] — `src/services/agent-exit-condition-evaluator.ts:34-35`
- **Confidence**: 82%
- **Problem**: Constructor uses full `Repository` suffix while handler-level classes use `Repo`. Breaks established naming pattern.
- **Fix**: Rename `outputRepository` to `outputRepo` for consistency with `loopRepo`.

**19. Type assertion on evalMode instead of Zod inference** [TypeScript] — `src/adapters/mcp-adapter.ts:2181`, `src/adapters/mcp-adapter.ts:2512`
- **Confidence**: 82%
- **Problem**: Uses `as 'shell' | 'agent' | undefined` despite Zod schema already narrowing type. Bypasses type safety.
- **Fix**: Remove casts; let Zod infer. For MCP adapter, `CreateLoopSchema` has `.default('shell')` so type is never undefined.

**20. No validation of `evalMode` value in LoopManagerService** [TypeScript] — `src/services/loop-manager.ts:57`
- **Confidence**: 80%
- **Problem**: If a future caller passes an invalid `evalMode` string (not 'shell' or 'agent'), code silently defaults to shell behavior instead of rejecting with an error.
- **Fix**: Add explicit guard: `if (evalMode !== 'shell' && evalMode !== 'agent') return err(...)` at the top of validation.

**21. Stale state guard adds unnecessary overhead for shell mode** [Performance] — `src/services/handlers/loop-handler.ts:282-318`
- **Confidence**: 82%
- **Problem**: The two sequential DB reads (fetch loop, fetch iteration) run for every iteration in shell eval mode too. Shell eval is fast and stale state is near-impossible, so this overhead is unnecessary.
- **Fix**: Guard the entire stale-state block with `if (loop.evalMode === 'agent')` so it only runs for agent evaluations.

**22. Inline object parameter type duplicates EvalResult fields** [TypeScript] — `src/services/handlers/loop-handler.ts:1121`
- **Confidence**: 80%
- **Problem**: `recordAndContinue` parameter uses ad-hoc type `{ score?: number; exitCode?: number; errorMessage?: string; evalFeedback?: string }` instead of a named type or `Pick<EvalResult, ...>`. Duplicate definition requiring manual sync.
- **Fix**: Define named type `IterationEvalFields` or use `Pick<EvalResult, 'score' | 'exitCode'> & { errorMessage?: string; evalFeedback?: string }`.

---

## Test Coverage Gaps (Should Add Tests)

### HIGH (2 issues in test suite)

**23. Test boilerplate repetition in agent evaluator tests (12 occurrences)** [Tests] — `tests/unit/services/agent-exit-condition-evaluator.test.ts`
- **Confidence**: 90%
- **Problem**: The spy-capture-simulate pattern repeats 12 times: `vi.spyOn(eventBus, 'emit')` + `setImmediate` + `simulateEvalTaskComplete`. Per test-patterns, >3 repetitions indicate the API needs improvement.
- **Fix**: Extract `evaluateWithCompletion(evaluator, loop, taskId, eventBus, simulate?)` helper that encapsulates all 4 steps. Reduces each test by ~10 lines.

**24. Variable reference before declaration in test** [Tests] — `tests/unit/services/handlers/loop-handler.test.ts:786-795`
- **Confidence**: 85%
- **Problem**: The mock callback references `loop.id` on line 788, but `loop` is declared on line 795. Works due to closure timing, but is fragile to refactoring.
- **Fix**: Move `const loop = await createAndEmitLoop(...)` above the mock setup.

### MEDIUM (2 issues)

**25. Missing test for stale iteration guard path** [Tests] — `src/services/handlers/loop-handler.ts:301-317`
- **Confidence**: 82%
- **Problem**: The second branch of the stale state guard (iteration status changed) has no test. One of two defensive code paths is uncovered.
- **Fix**: Add a test where `loopRepo.updateIteration(...)` changes iteration status to a terminal state, verify result is not processed.

**26. Missing test for shell mode `evalTimeout` boundary (300s max)** [Tests] — `src/services/loop-manager.ts:130`
- **Confidence**: 80%
- **Problem**: Tests verify agent mode rejects >600s timeout, but no test for shell mode rejecting >300s timeout.
- **Fix**: Add test for shell mode with `evalTimeout: 300001` to verify rejection.

---

## Documentation Gaps (BLOCKING USER DISCOVERABILITY)

### HIGH (3 issues)

**27. FEATURES.md not updated for agent eval mode** [Documentation] — `docs/FEATURES.md`
- **Confidence**: 95%
- **Problem**: Loop Strategies section (lines 338-340) only describes shell-based evaluation. Configuration section (351-356) omits `evalMode`, `evalPrompt`, eval timeout differences. CLI Commands section (358-366) does not show new `--eval-mode agent` flags. Database Schema section (374-375) does not mention Migration 15.
- **Fix**: Add agent eval mode to Loop Strategies section. Add `evalMode`, `evalPrompt` to Configuration. Add agent eval CLI examples. Add Migration 15 to Database Schema.

**28. README.md Eval Loops section omits agent eval mode** [Documentation] — `README.md:105-135`
- **Confidence**: 92%
- **Problem**: Only shows shell-based `--until` and `--eval` examples. Agent eval mode is a user-facing feature but has no mention. Users won't know it exists.
- **Fix**: Add "Agent eval" example: `beat loop "Fix the failing tests" --eval-mode agent --strategy retry`

**29. CHANGELOG.md [Unreleased] section empty** [Documentation] — `CHANGELOG.md:7-9`
- **Confidence**: 90%
- **Problem**: Despite substantial feature additions (new eval mode, new fields, DB migration v15, new CLI flags), [Unreleased] says "Nothing yet."
- **Fix**: Add entry documenting features, database migration, and new CLI flags. Include brief description of agent eval mode.

---

### MEDIUM (2 issues)

**30. CLAUDE.md File Locations table missing new evaluator files** [Documentation] — `CLAUDE.md:147-167`
- **Confidence**: 85%
- **Problem**: New architectural files (`src/services/agent-exit-condition-evaluator.ts`, `src/services/composite-exit-condition-evaluator.ts`) are not in the quick reference table.
- **Fix**: Add table entries pointing to both evaluator service files.

**31. Inline comment on `exitCondition` lacks design rationale** [Documentation] — `src/core/domain.ts:277`
- **Confidence**: 80%
- **Problem**: Comment says "empty string for agent mode" but does not explain why it is not optional. Future developers might wonder if this is a bug.
- **Fix**: Expand comment: `// Shell command for shell eval mode; empty string for agent mode (kept non-optional for backward compat)`

---

## Pre-existing Issues (Informational, Not Blocking)

| Issue | Location | Confidence | Note |
|-------|----------|-----------|------|
| **PF-005**: `getResetTargetSha` O(n) iteration scan | `src/services/handlers/loop-handler.ts:~1224` | 90% | Agent eval loops with optimize strategy will exercise this path. Deferred resolution still applies. |
| **PF-006**: 4 sequential git spawns per iteration | `src/utils/git-state.ts:~331` | 88% | PR adds 2nd agent spawn per iteration (eval), making total overhead higher. Acceptable given iteration frequency. |
| **ShellExitConditionEvaluator** vulnerable to empty `exitCondition` | `src/services/exit-condition-evaluator.ts:31` | 85% | If routing bug allows agent-mode loop to reach shell evaluator with empty `exitCondition`, it silently returns `passed: true`. Add defensive empty-string guard. |
| **FEATURES.md version label stale** | `docs/FEATURES.md:5` | 85% | Will be outdated after merge. Update "Last Updated" to reflect new version. |
| **ExitConditionEvaluator interface missing JSDoc** | `src/core/interfaces.ts:685-687` | 82% | Now has two implementations (shell, agent). Add JSDoc describing contract. |

---

## Action Plan (Priority Order)

### Phase 1: Fix Regressions (Blocking MCP & Scheduled Loops)
1. **Regression Suite** (30 min): Fix JSON schemas for CreateLoop/ScheduleLoop — remove `exitCondition` from `required`, add `evalMode`/`evalPrompt` properties (6 changes: issues #2-5)
2. **Schedule Manager** (10 min): Guard `exitCondition` validation with `if (evalMode === 'shell')` (issue #6)
3. **Type Safety** (15 min): Change `LoopRowSchema.eval_mode` to `z.enum()`, remove casts in adapter (issue #7)

### Phase 2: Fix Architectural & Test Issues (Enables Clean Merge)
4. **Code Duplication** (45 min): Extract `cleanupIterationTracking()` helper, refactor stale guard into helpers, extract CLI parser helpers (issues #8, #9, #15)
5. **Enum + Validation** (20 min): Add `EvalMode` enum, fix `evalMode` casts, add runtime validation in LoopManagerService (issues #10, #20)
6. **Test Refactoring** (30 min): Extract `evaluateWithCompletion()` helper, fix variable declaration ordering (issues #23, #24)

### Phase 3: Polish & Documentation (Before Merge)
7. **Bounds & Consistency** (15 min): Add `.max(600000)` to Zod schemas, guard stale-state performance optimization to agent mode, fix schema default (issues #12, #13, #21)
8. **Feedback & Timeout** (10 min): Truncate `evalFeedback`, document eval task isolation constraint (issues #11, #17)
9. **Repository Naming** (5 min): Rename `outputRepository` to `outputRepo` (issue #18)
10. **Documentation** (60 min): Update FEATURES.md, README.md, CHANGELOG.md, CLAUDE.md, fix orchestrator prompt syntax (issues #27-30)

---

## Key Metrics

| Metric | Value | Assessment |
|--------|-------|-----------|
| **Architecture Quality** | 8/10 | Strategy/Composite patterns correctly applied; event-driven task creation; stale-state guard is sound |
| **Code Quality** | 6/10 | New services well-structured, but duplication in CLI parser and loop handler creates maintenance risk |
| **Test Coverage** | 7/10 | Strong behavioral coverage with good test cases; boilerplate repetition and missing edge-case tests |
| **TypeScript Safety** | 7/10 | Good overall typing; unsafe `as` casts on `eval_mode` and missing validation in manager are the main issues |
| **Performance** | 7/10 | Reasonable for the feature (agent eval inherently expensive); unbounded output concatenation and stale-guard overhead are fixable |
| **Security** | 8/10 | Good security posture; input validation thorough; feedback truncation and eval task isolation constraints need documentation |
| **Regression Risk** | **CRITICAL** | Four HIGH regressions in MCP schemas and schedule manager prevent agent eval from working via MCP/scheduled loops |

---

## Summary

The **agent eval mode feature is architecturally sound** and demonstrates strong engineering (Strategy pattern, Composite evaluator, proper dependency injection, event-driven eval task lifecycle, comprehensive stale-state guard). Test coverage is strong across behaviors (output parsing, timeout handling, feedback capture, CLI argument parsing).

However, **merge is blocked by four critical regressions** in the MCP and scheduled loop paths that prevent agent eval mode from being usable:
- JSON Schemas for MCP tools still require `exitCondition` and are missing `evalMode`/`evalPrompt` properties
- Schedule manager validation rejects agent-mode loops

These regressions are straightforward to fix (schema updates, one service-layer guard) and do not require architectural changes.

Additionally, **code duplication in the stale-state guard and CLI parser creates maintenance hazards** that should be resolved now rather than later. These are one-time refactoring investments that improve long-term maintainability.

Finally, **user-facing documentation (README, FEATURES, CHANGELOG) has not been updated**, preventing users from discovering this significant new feature.

**With these issues fixed, the PR is approvable.** None of the problems are fundamental — all are implementation-level corrections or documentation gaps.

