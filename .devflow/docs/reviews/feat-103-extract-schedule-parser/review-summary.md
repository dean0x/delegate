# Code Review Summary

**Branch**: feat/103-extract-schedule-parser -> main
**Date**: 2026-03-22
**Reviewers**: 8 specialized agents (security, architecture, performance, complexity, consistency, regression, tests, typescript)

## Merge Recommendation: CHANGES REQUESTED

This is a well-executed refactoring that improves code quality through pure function extraction and separation of concerns. However, **4 HIGH-confidence blocking issues must be addressed before merge**:

1. **Type Safety Gap**: Non-null assertions on optional fields that should use discriminated unions (2 reviewers)
2. **Missing User Guidance**: Pipeline usage hint dropped from error message (2 reviewers)
3. **Type Narrowing**: Type assertions (`as`) used instead of type guards
4. **Parser Consistency**: Prompt field handling diverges from loop parser pattern

These are fixable in ~30 minutes. All other aspects (security, tests, regression risk) are solid.

---

## Issue Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW | Total |
|----------|----------|------|--------|-----|-------|
| Blocking | 0 | 4 | 0 | - | 4 |
| Should Fix | 0 | 0 | 1 | 1 | 2 |
| Pre-existing | 0 | 0 | 2 | 3 | 5 |

**Confidence-Weighted Blocking Issues**: All 4 blocking issues at 80%+ confidence

---

## Blocking Issues (Must Fix)

### 1. Non-Null Assertions Bypass Type Safety (MEDIUM → HIGH due to duplication)

**Files**: `src/cli/commands/schedule.ts:252, 271`
**Confidence**: 82% (flagged by Architecture + TypeScript reviewers)

The `ParsedScheduleCreateArgs` interface declares `prompt` and `pipelineSteps` as optional, but the parser logic guarantees:
- When `isPipeline === true`: `pipelineSteps` is always set
- When `isPipeline === false`: `prompt` is always set

Current code forces non-null assertions:
```typescript
// Line 252
const steps: readonly string[] = args.pipelineSteps!;

// Line 271
const prompt: string = args.prompt!;
```

**Fix**: Use discriminated union to encode the invariant in the type system:

```typescript
type ParsedScheduleCreateArgs = {
  readonly scheduleType: 'cron' | 'one_time';
  readonly cronExpression?: string;
  readonly scheduledAt?: string;
  readonly timezone?: string;
  readonly missedRunPolicy?: 'skip' | 'catchup' | 'fail';
  readonly priority?: 'P0' | 'P1' | 'P2';
  readonly workingDirectory?: string;
  readonly maxRuns?: number;
  readonly expiresAt?: string;
  readonly afterScheduleId?: string;
  readonly agent?: AgentProvider;
} & (
  | { readonly isPipeline: true; readonly pipelineSteps: readonly string[]; readonly prompt?: string }
  | { readonly isPipeline: false; readonly prompt: string; readonly pipelineSteps?: undefined }
);
```

After this change, TypeScript automatically narrows the types:
```typescript
if (args.isPipeline) {
  const steps = args.pipelineSteps; // No ! needed - TypeScript knows it exists
}
```

**Why this matters**: Eliminates runtime assertions by moving the proof to the type system. This pattern is already used elsewhere in the codebase.

---

### 2. Missing Pipeline Usage Hint in Error Message (MEDIUM)

**Files**: `src/cli/commands/schedule.ts:149`
**Confidence**: 85-90% (flagged by Consistency + Regression reviewers)

The original code displayed two lines when the prompt was missing:
```
Error: Usage: beat schedule create <prompt> --cron "..." | --at "..." [options]
  Pipeline: beat schedule create --pipeline --step "lint" --step "test" --cron "0 9 * * *"
```

The refactored `parseScheduleCreateArgs` only returns the usage error. The pipeline hint is lost in `scheduleCreate` at the call site.

**Fix**: Include the hint in the error message:

```typescript
// In parseScheduleCreateArgs, line 149:
if (!isPipeline && !prompt) {
  return err(
    'Usage: beat schedule create <prompt> --cron "..." | --at "..." [options]\n' +
    '  Pipeline: beat schedule create --pipeline --step "lint" --step "test" --cron "0 9 * * *"'
  );
}
```

**Why this matters**: User-facing error messages should be helpful. Users who forget the prompt now lose the hint that `--pipeline` is an alternative mode. This is a regression in UX.

---

### 3. Type Assertions Instead of Type Guards (MEDIUM)

**Files**: `src/cli/commands/schedule.ts:72, 78`
**Confidence**: 80%

After runtime validation with `includes()`, the code uses `as` casts instead of type guards:

```typescript
// Line 72 - after checking next is in the list
const policies = ['skip', 'catchup', 'fail'];
if (!policies.includes(next)) return err(...);
missedRunPolicy = next as 'skip' | 'catchup' | 'fail'; // <- as cast

// Line 78 - similar pattern
const priorities = ['P0', 'P1', 'P2'];
if (!priorities.includes(next)) return err(...);
priority = next as 'P0' | 'P1' | 'P2'; // <- as cast
```

TypeScript cannot narrow `string` to a literal union after `includes()`, so the cast is technically necessary. However, a type guard provides proper narrowing without the cast:

```typescript
function isValidPolicy(v: string): v is 'skip' | 'catchup' | 'fail' {
  return v === 'skip' || v === 'catchup' || v === 'fail';
}

function isValidPriority(v: string): v is 'P0' | 'P1' | 'P2' {
  return v === 'P0' || v === 'P1' || v === 'P2';
}

// Usage:
if (!isValidPolicy(next)) return err(...);
missedRunPolicy = next; // No cast needed - properly narrowed
```

**Why this matters**: Type guards are TypeScript best practice. Casts bypass the type system. The codebase already uses type guards elsewhere.

---

### 4. Prompt Field Inconsistency with Loop Parser (MEDIUM)

**Files**: `src/cli/commands/schedule.ts:154`
**Confidence**: 82%

The schedule parser and loop parser handle the `prompt` field differently in pipeline mode:

**Loop parser** (`loop.ts:163`):
```typescript
prompt: isPipeline ? undefined : prompt
```
Explicitly undefines the prompt in pipeline mode.

**Schedule parser** (`schedule.ts:154`):
```typescript
prompt: prompt || undefined
```
Converts empty string to undefined in all modes, but leaves a non-empty string in pipeline mode.

**Problem**: In pipeline mode, the schedule parser can return a non-empty `prompt` value if the user typed words before `--pipeline`. This is then handled with a warning in `scheduleCreate` (line 273-274), but the parser behavior is inconsistent with `parseLoopCreateArgs`.

**Fix**: Match the loop parser pattern:

```typescript
// In parseScheduleCreateArgs return statement, line 154:
return ok({
  prompt: isPipeline ? undefined : (prompt || undefined),
  // ... rest of fields
});
```

Or validate earlier and emit a warning as a separate field:

```typescript
// Inside the parser
if (isPipeline && prompt) {
  promptWarning = 'Ignoring prompt in pipeline mode: use --step instead';
}

// Then in return:
return ok({
  prompt: undefined,
  promptWarning, // Optional field for caller to display
  // ...
});
```

**Why this matters**: Parser consistency. Both `parseScheduleCreateArgs` and `parseLoopCreateArgs` are public, exported functions. They should handle the same semantics the same way.

---

## Should-Fix Issues (Not Blocking, But Recommended)

### `parseInt` Without Explicit Radix

**File**: `src/cli/commands/schedule.ts:88`
**Confidence**: 85%
**Severity**: LOW

```typescript
const maxRuns = parseInt(next);  // Should specify radix
```

**Fix**:
```typescript
const maxRuns = parseInt(next, 10);
```

**Context**: This line existed before the refactor on main. Since it's now inside new extracted code, it's worth cleaning up. ESLint `radix` rule recommends explicit base-10.

---

## Pre-Existing Issues (Informational Only)

These issues existed before this PR. Not blocking, but worth noting:

| Issue | File | Confidence | Severity |
|-------|------|-----------|----------|
| No validation on `--at` / `--expires-at` strings at CLI boundary | `schedule.ts:63,94` | 65% | MEDIUM |
| `ScheduleId` branded type is passthrough cast with no validation | `schedule.ts:245` | 65% | LOW |
| `scheduleList` and `scheduleGet` could benefit from parser extraction | `schedule.ts:284-391` | 85% | MEDIUM |
| `ParsedScheduleCreateArgs` interface not exported | `schedule.ts:13` | 80% | LOW |
| Dynamic `import()` in tests instead of static import | `tests/unit/cli.test.ts:1052-1057, 2500, 2547` | 80% | LOW |

---

## Score Summary

| Domain | Score | Recommendation | Issues |
|--------|-------|-----------------|--------|
| Security | 9/10 | APPROVED | No blocking issues. Strong improvement: pure function eliminates side effects, validation preserved, no new attack surface. |
| Architecture | 8/10 | APPROVED_WITH_CONDITIONS | 1 MEDIUM (discriminated union) — well-executed extraction that follows `loop.ts` pattern. |
| Performance | 9/10 | APPROVED | No regressions. Slight improvement: parse errors fail faster without bootstrapping services. Dynamic imports in tests are cached. |
| Complexity | 7/10 | APPROVED | 2 HIGH (function length, mutable state) — inherent to CLI parsing domain. Well-tested (25 new tests covering all branches). |
| Consistency | 8/10 | APPROVED_WITH_CONDITIONS | 2 MEDIUM (missing pipeline hint, prompt handling divergence). Overall very consistent with `loop.ts` pattern. |
| Regression | 9/10 | APPROVED_WITH_CONDITIONS | 1 MEDIUM (pipeline hint regression). No breaking changes. 233 tests passing. |
| Tests | 9/10 | APPROVED | Excellent: pure function directly tested (22 tests), removed duplicated validation helpers, integration tests use real parser. |
| TypeScript | 8/10 | APPROVED_WITH_CONDITIONS | 2 MEDIUM (non-null assertions, type casts) + 1 LOW (parseInt radix). Good overall type design. |
| **Overall** | **8.25/10** | **CHANGES REQUESTED** | 4 HIGH blocking; 1 LOW should-fix. All fixable in <1 hour. |

---

## Key Strengths

1. **Pure Function Extraction** - `parseScheduleCreateArgs` is a clean, testable pure function returning `Result<T, E>`. No side effects, no process.exit calls.

2. **Test Quality** - 25 new focused tests cover all branches, flag combinations, and error paths. Tests call the real parser function, not a duplicate validator. Follows "test behavior, not implementation" principle.

3. **Separation of Concerns** - Parsing logic cleanly separated from side effects (`ui.error`, `process.exit`). Makes the code more modular and reusable.

4. **Consistency with Established Pattern** - Mirrors the structure, naming (`parse*CreateArgs`), and return type (`Result`) of `parseLoopCreateArgs` in `loop.ts`.

5. **No Security Regressions** - All existing validation checks preserved (type enums, priority enums, agent validation, flag conflicts, numeric bounds, path traversal, parameterized queries).

6. **No Breaking Changes** - Public exports (`handleScheduleCommand`) unchanged. New export `parseScheduleCreateArgs` is additive. All CLI flags preserved.

---

## Action Plan

**Before merge, make these changes:**

1. **Fix non-null assertions** - Adopt discriminated union for `ParsedScheduleCreateArgs` (10 min)
   - Eliminates `args.pipelineSteps!` and `args.prompt!` assertions
   - Improves type safety across both `isPipeline` branches

2. **Restore pipeline usage hint** - Add to error message (5 min)
   - Include `Pipeline: beat schedule create --pipeline --step "lint" --step "test" --cron "0 9 * * *"` in the error returned by parser

3. **Replace type casts with type guards** - Add guard functions (10 min)
   - `isValidPolicy()` for missed-run-policy values
   - `isValidPriority()` for priority values
   - Removes `as` casts, provides proper narrowing

4. **Align prompt field handling** - Match loop parser pattern (5 min)
   - Use `isPipeline ? undefined : (prompt || undefined)` in return statement

5. **Optional: Add radix to parseInt** - Clean up pre-existing issue (1 min)

**Estimated total time**: ~30 minutes

**After fixes**: Re-run TypeScript compiler, tests, and Snyk to confirm clean state. Then approve.

---

## Verification Checklist

- [ ] Discriminated union implemented and `!` assertions removed
- [ ] Non-null assertions on `pipelineSteps` and `prompt` eliminated
- [ ] Pipeline usage hint restored to error message
- [ ] Type guards (`isValidPolicy`, `isValidPriority`) implemented
- [ ] Type casts (`as`) removed from validation code
- [ ] Prompt field handling matches loop parser pattern
- [ ] TypeScript compiler clean: `npm run typecheck`
- [ ] All tests pass: `npm run test:cli`
- [ ] Snyk security scan clean: `npm run snyk`
- [ ] `npm run build` succeeds

---

## Summary

This is a **strong refactor that improves maintainability, testability, and code organization**. The extraction of `parseScheduleCreateArgs` follows established project patterns and removes significant duplication. The 4 blocking issues are all fixable in <1 hour and are straightforward improvements to type safety and user guidance. Once addressed, this PR is ready to merge.
