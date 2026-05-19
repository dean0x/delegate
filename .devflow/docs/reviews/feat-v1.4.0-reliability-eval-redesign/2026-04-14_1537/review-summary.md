# Code Review Summary

**Branch**: feat-v1.4.0-reliability-eval-redesign -> main
**Date**: 2026-04-14T15:37:00Z
**Reviewers**: 10 specialized agents (architecture, complexity, consistency, database, dependencies, performance, regression, security, testing, typescript)

## Merge Recommendation: BLOCK MERGE

The PR introduces a well-designed eval redesign with solid architecture (Strategy/Composite pattern, DI, extracted shared utilities). However, **one test failure in CI** and **two HIGH-severity security issues** block merge. These must be resolved before approval.

---

## Issue Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW | Total |
|----------|----------|------|--------|-----|-------|
| **Blocking** | 0 | 4 | 6 | 0 | **10** |
| **Should Fix** | 0 | 0 | 8 | 0 | **8** |
| **Pre-existing** | 0 | 0 | 2 | 0 | **2** |

---

## Blocking Issues (Must Fix Before Merge)

### CRITICAL

None identified.

### HIGH (4 issues, confidence ≥80%)

**1. Test Failure: `resource-exhaustion.test.ts:213` expects old timeout default** — _Regression_
- **File**: `tests/security/resource-exhaustion.test.ts:213`
- **Confidence**: 95%
- **Impact**: TEST WILL FAIL IN CI
- **Problem**: Assertion `expect(fallback.timeout).toBe(1800000)` hardcoded to old 30-min default. Configuration schema now defaults to `0` (disabled). This test must be updated or the full test suite will fail.
- **Fix**:
  ```typescript
  expect(fallback.timeout).toBe(0); // v1.4.0: timeout disabled by default
  ```

**2. Default Timeout Disabled — DoS Vector** — _Security_
- **File**: `src/core/configuration.ts:20`
- **Confidence**: 85% (Security + Architecture + Performance reviewers agreed)
- **Impact**: SECURITY - Defense-in-depth loss
- **Problem**: Timeout default changed from `1800000` (30min) to `0` (disabled). Any task without explicit timeout now runs indefinitely. Removes safety net against runaway processes consuming unbounded resources.
- **Fix**: Keep `min(0)` for opt-out, but set default to high-but-finite value:
  ```typescript
  timeout: z.number().min(0).max(86400000).default(7200000), // 2hr default, set to 0 to opt out
  ```

**3. Judge Decision File Has TOCTOU Window** — _Security_
- **File**: `src/services/judge-exit-condition-evaluator.ts:301`
- **Confidence**: 82%
- **Impact**: SECURITY - Privilege boundary confusion
- **Problem**: Judge agent writes `.autobeat-judge` to loop's working directory. Between cleanup at line 197 and judge completion at line 211, the work agent (in same directory) can preemptively write `.autobeat-judge` file, causing the evaluator to read the work agent's decision instead of the judge's. Privilege boundary confusion: evaluated entity influences evaluation.
- **Fix**: Use unpredictable filename per evaluation:
  ```typescript
  const decisionFileName = `.autobeat-judge-${judgeTaskId}`;
  const decisionFilePath = path.join(loop.workingDirectory, decisionFileName);
  // Include specific filename in judge prompt
  ```

**4. Missing CHECK Constraint on eval_type Column** — _Database_
- **File**: `src/implementations/database.ts:856` (migration v21)
- **Confidence**: 85%
- **Impact**: DATA INTEGRITY - Breaks defense-in-depth pattern
- **Problem**: `eval_type TEXT DEFAULT 'feedforward'` has no CHECK constraint. Project convention (all other enum columns: `status`, `strategy`) enforces valid values at the database layer. Without CHECK, any string can be written to `eval_type`, violating the `EvalType` enum contract. Zod schema doesn't help here (uses bare `z.string()`, not `z.enum()`).
- **Fix**:
  ```sql
  ALTER TABLE loops ADD COLUMN eval_type TEXT DEFAULT 'feedforward'
    CHECK(eval_type IS NULL OR eval_type IN ('feedforward', 'judge', 'schema'))
  ```
  Also tighten Zod schema:
  ```typescript
  eval_type: z.enum(['feedforward', 'judge', 'schema']).nullable().optional(),
  ```

---

## Should-Fix Issues (HIGH-MEDIUM priority, should address while here)

### HIGH (0 issues)

None identified.

### MEDIUM (8 issues, confidence ≥80%)

**1. LoopHandler `handleTaskTerminal` — High Cyclomatic Complexity** — _Complexity_
- **File**: `src/services/handlers/loop-handler.ts:197-341` (~140 lines)
- **Confidence**: 88%
- **Problem**: Handles both TaskCompleted and TaskFailed with deeply nested conditionals (4+ levels). Stale-state guard adds nested fetch-and-check sequences with 3+ nesting levels. Cyclomatic complexity ~12 (well above threshold of 10).
- **Fix**: Extract stale-state guard into `refetchLoopAndIterationAfterEval()` helper method, reducing main method to linear flow.

**2. LoopHandler `handleRetryResult`/`handleOptimizeResult` — Structural Duplication** — _Complexity_
- **File**: `src/services/handlers/loop-handler.ts:834-1070`
- **Confidence**: 82%
- **Problem**: Both methods have identical `decision === 'stop'` blocks (15+ lines each): run transaction, update status, call `completeLoop`. `handleOptimizeResult` is 130 lines with 8+ branches.
- **Fix**: Extract shared `decision === 'stop'` transaction into helper method, reducing duplication by ~20 lines per method.

**3. TaskRequestSchema Missing jsonSchema Field** — _Database_
- **File**: `src/implementations/loop-repository.ts:94-111`
- **Confidence**: 88%
- **Impact**: DATA LOSS - Silent truncation on round-trip
- **Problem**: `TaskRequest` now includes `jsonSchema?: string` (for eval tasks). Loop's `taskTemplate` serializes to JSON and deserializes via `TaskRequestSchema.parse()`. However, `TaskRequestSchema` doesn't include `jsonSchema` field. Zod silently strips unknown keys, so when loop is saved with `jsonSchema` and reloaded from DB after process restart, the field is lost. Judge-mode loops will lose structured output schema after restart.
- **Fix**: Add to both loop and schedule repositories:
  ```typescript
  jsonSchema: z.string().optional(), // v1.4.0: structured output for eval tasks
  ```

**4. Database Row Types Have Triple Union** — _TypeScript_
- **File**: `src/implementations/loop-repository.ts:157-159,180`
- **Confidence**: 82%
- **Problem**: `LoopRow` and `LoopIterationRow` fields (`eval_type`, `judge_agent`, `judge_prompt`, `eval_response`) use `string | null | undefined`. SQLite columns are never `undefined` (either present as string/null or column doesn't exist in old schema). Type mismatch adds unnecessary width and masks bugs.
- **Fix**: Use `string | null` on row interfaces (matching SQLite reality), keep `.optional()` only on Zod schema for migration transitions.

**5. Loop Repository Uses `as` Casts Instead of Zod Enum Validation** — _TypeScript + Database_
- **Files**: `src/implementations/loop-repository.ts:686-687`, `src/implementations/loop-repository.ts:94-111`
- **Confidence**: 88%
- **Impact**: Violates PF-005 pitfall (Zod parse on every read)
- **Problem**: `data.eval_type as EvalType` and `data.judge_agent as Loop['judgeAgent']` bypass Zod validation. Zod schema uses bare `z.string().nullable().optional()` instead of `z.enum()`. Corrupted DB rows (e.g., `eval_type = 'invalid'`) would pass Zod and flow into domain types unvalidated.
- **Fix**: Replace with enum validators:
  ```typescript
  eval_type: z.enum(['feedforward', 'judge', 'schema']).nullable().optional(),
  judge_agent: z.enum(['claude', 'codex', 'gemini']).nullable().optional(),
  ```
  Remove `as` casts after Zod parse validates.

**6. Exhaustive Switch Default Branch Silently Falls Back** — _TypeScript_
- **File**: `src/services/composite-exit-condition-evaluator.ts:53-56`
- **Confidence**: 85%
- **Problem**: Default case has `const _exhaustive: never = evalType` (correct compile-time guard) but then returns fallback to feedforward. If compile guard bypassed (JS caller, JSON deserialization), code silently uses feedforward instead of throwing. Masks misconfigured `evalType` at runtime.
- **Fix**:
  ```typescript
  default: {
    const _exhaustive: never = evalType;
    throw new Error(`Unhandled evalType: ${_exhaustive}`);
  }
  ```

**7. No Dedicated Tests for `waitForEvalTaskCompletion` Utility** — _Testing_
- **File**: `src/services/eval-task-waiter.ts` (114 lines, new)
- **Confidence**: 88%
- **Impact**: COVERAGE - Core shared utility untested in isolation
- **Problem**: Shared event subscription, cleanup, and fallback timer logic used by all evaluators has zero dedicated tests. Indirectly exercised through evaluator tests (happy path only), but missing:
  - Fallback timer fires after `evalTimeout + 5000ms`
  - Loop cancellation triggers `TaskCancellationRequested`
  - `TaskTimeout` event resolves waiter
  - Multiple simultaneous events (only first processed)
  - Subscription cleanup after resolution
- **Fix**: Add `eval-task-waiter.test.ts` with fallback timer, cancellation, timeout event, and idempotent resolution test cases.

**8. LoopHandler Decision Field Branching Has No Direct Test Coverage** — _Testing_
- **File**: `src/services/handlers/loop-handler.ts:829-870` (167 new lines)
- **Confidence**: 85%
- **Impact**: COVERAGE - Core v1.4.0 behavioral change untested
- **Problem**: `decision === 'continue'` (lines 837-851) skips `consecutiveFailures` increment. `decision === 'stop'` (lines 852-870) completes loop with transaction. Zero new test cases in `loop-handler.test.ts` covering these branches. Feedforward/judge continue-without-penalty logic has no direct test coverage.
- **Fix**: Add to `loop-handler.test.ts`:
  - When `decision: 'continue'`, `consecutiveFailures` NOT incremented, next iteration starts
  - When `decision: 'stop'`, loop completed and iteration recorded as `pass`
  - When `decision` undefined, existing `passed` logic applies (backward compat)

---

## Pre-Existing Issues (Not Blocking)

### MEDIUM (2 issues)

**1. Weak Zod Validation for enum-like fields in existing repositories** — _Database pitfall PF-005_
- **File**: Existing pattern in `loop-repository.ts`, `schedule-repository.ts`
- **Confidence**: 82%
- **Note**: Pre-existing issue, but new fields repeat the pattern. See Should-Fix #5 above for fixes.

**2. DEFAULT_CONFIG removal reduces auditability** — _Security_
- **File**: `src/core/configuration.ts`
- **Confidence**: 85%
- **Note**: Timeout default change should be prominently documented in release notes / CHANGELOG.

---

## Action Plan

### Immediate (Required for Merge)

1. **Update test**: `resource-exhaustion.test.ts:213` — change expected timeout to `0`
2. **Security: Default timeout** — change default from `0` to `7200000` (2hr) OR document as intentional breaking change
3. **Security: Judge decision file** — use unpredictable filename per judgment with `${judgeTaskId}` in path
4. **Database: eval_type column** — add CHECK constraint in migration v21
5. **Database: eval_type Zod schema** — change from `z.string()` to `z.enum([...])`
6. **Database: judge_agent Zod schema** — add enum validation
7. **Database: TaskRequestSchema** — add `jsonSchema` field to both loop and schedule repositories

### High Priority (Should Fix While Here)

8. **Complexity: handleTaskTerminal** — extract stale-state guard into helper
9. **Complexity: decision === 'stop' blocks** — extract into shared helper
10. **TypeScript: as casts in rowToLoop** — remove after Zod enum validation
11. **TypeScript: Row type unions** — change `| undefined` to `| null`
12. **TypeScript: Exhaustive switch** — throw instead of silent fallback
13. **Testing: eval-task-waiter.test.ts** — add dedicated test file
14. **Testing: decision field coverage** — add test cases to loop-handler.test.ts

---

## Summary by Category

### Architecture
- **Score**: 7/10 — Well-designed Strategy/Composite pattern, good DI usage, one safety timeout concern
- **Key**: Spawn parameter list growing past readability (refactored as options object in architecture fix above)

### Complexity
- **Score**: 6/10 — Two HIGH methods (handleTaskTerminal, handleRetryResult/Result) exceed nesting/length thresholds
- **Key**: Extract guards and duplicate blocks as noted above

### Consistency
- **Score**: 7/10 — EvalType uses `as const` instead of `enum` (deviation from other domain constants)
- **Key**: Minor stylistic inconsistency, not blocking

### Database
- **Score**: 7/10 — Migration clean and follows patterns, but missing CHECK and weak Zod validation
- **Key**: Four MEDIUM/HIGH issues listed above

### Dependencies
- **Score**: 10/10 — Zero dependency changes, clean audit
- **Recommendation**: APPROVED

### Performance
- **Score**: 7/10 — Two-phase judge eval and increased iteration fetch are acceptable architectural trade-offs
- **Key**: Disabled timeout (MEDIUM) noted in security section

### Regression
- **Score**: 7/10 — One test failure blocks, timeout default is intentional breaking change
- **Key**: Must document timeout change prominently in release notes

### Security
- **Score**: 7/10 — Two HIGH findings (disabled timeout, TOCTOU window), all fixable
- **Key**: Both listed above in blocking issues

### Testing
- **Score**: 7/10 — Good breadth (~2200 new test lines) but two gaps: eval-task-waiter and decision field coverage
- **Key**: Both listed above in should-fix section

### TypeScript
- **Score**: 7/10 — Type safety weakened by `as` casts and fallback fallthrough
- **Key**: Requires enum Zod validation and throw instead of silent default

---

## Notes for Next Steps

1. **CHANGELOG/Release Notes**: Must document timeout default change as breaking change (v1.3.0 → v1.4.0)
2. **Migration v21**: Add CHECK constraint before applying to production databases
3. **Test Execution**: All 4 blocking issues must be fixed before running full test suite (`npm run test:all`)
4. **Code Review Handoff**: These fixes can be tackled in parallel — the decision field and timeout issues are independent

---

**Review Date**: 2026-04-14 at 15:37 UTC
**Reviewers**: Architecture, Complexity, Consistency, Database, Dependencies, Performance, Regression, Security, Testing, TypeScript
**Total Findings**: 20 issues (4 HIGH blocking, 6 MEDIUM blocking, 8 MEDIUM should-fix, 2 pre-existing)
