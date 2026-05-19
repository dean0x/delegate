# Code Review Summary: v0.8.0 Loop Enhancements

**Branch**: feat/v0.8.0-loop-enhancements -> main
**Date**: 2026-03-23
**PR**: #115
**Reviewers**: Security, Architecture, Performance, Complexity, Consistency, Regression, Tests, TypeScript, Database

---

## Merge Recommendation: **CHANGES_REQUESTED**

**Rationale**: The v0.8.0 feature set (loop pause/resume, scheduled loops, git integration, performance optimizations) is well-structured and demonstrates strong architectural discipline. However, **9 blocking issues** across multiple domains must be addressed before merge:

- **Type safety**: Unsafe `LoopId as unknown as TaskId` cast undermines branded type system (flagged by 5 reviewers)
- **Security**: Git branch name injection vulnerability, validation bypass in scheduled loop trigger path
- **Consistency**: Pattern deviations in schedule creation flow and transaction handling
- **Regression**: Task result loss in graceful-pause scenario, stale loop status tracking
- **Tests**: Complete coverage gaps for `createScheduledLoop()` and `handleScheduleLoop()`
- **Complexity**: Two functions exceed critical nesting/line thresholds

These issues are **not architectural showstoppers** — all are fixable with targeted changes (1-2 hours of focused rework + testing). The refactors are surgical: extract methods, add validation, fix type casts, add missing tests.

---

## Issue Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW | Total |
|----------|----------|------|--------|-----|-------|
| Blocking (Category 1) | 0 | 9 | 6 | 0 | **15** |
| Should Fix (Category 2) | 0 | 0 | 7 | 0 | **7** |
| Pre-existing (Category 3) | 0 | 0 | 6 | 2 | **8** |

---

## Blocking Issues (Category 1: Changes You Made)

### 1. Unsafe Type Cast: `LoopId as unknown as TaskId`
**Files**: `src/services/handlers/schedule-handler.ts:560`
**Severity**: HIGH
**Confidence**: 90% (flagged by Security, Architecture, Consistency, Regression, TypeScript)

**Problem**: The code emits `ScheduleExecutedEvent` with `taskId: loop.id as unknown as TaskId`. This double-cast (`as unknown as`) bypasses the branded type system entirely. While `clearRunningScheduleByTask` accepts `string` at runtime, the semantic type mismatch creates a maintenance trap: future refactors that tighten the type (e.g., `TaskId` instead of `string`) will silently break.

**Impact**: Type confusion vector. The `ScheduleExecutedEvent` interface declares `taskId: TaskId` but holds a `LoopId`. Violates the codebase's core safety principle (branded types prevent cross-domain ID confusion).

**Fix**: Widen the event interface to accept both types:
```typescript
export interface ScheduleExecutedEvent extends BaseEvent {
  type: 'ScheduleExecuted';
  scheduleId: ScheduleId;
  taskId?: TaskId;
  loopId?: LoopId;  // v0.8.0: set when schedule triggers a loop
  executedAt: number;
}

// In schedule-executor.ts:
private clearRunningScheduleByTask(entityId: TaskId | LoopId): void {
  const key = `${entityId}`;
  this.runningSchedules.delete(key);
}
```

---

### 2. Missing Git Branch Name Validation
**Files**: `src/utils/git-state.ts:96`, `src/utils/git-state.ts:123`
**Severity**: HIGH
**Confidence**: 85% (flagged by Security)

**Problem**: The `gitBranch` parameter flows from MCP/CLI input directly to `execFile('git', ['checkout', '-B', branchName])` without format validation. While `execFile` prevents shell injection, it does NOT prevent git flag injection. A branch name like `--orphan` or `--` would be interpreted as a git flag, not a branch name. This is called "argument injection" and is a known class of vulnerability.

**Impact**: An attacker providing `gitBranch: "--orphan"` could manipulate git behavior and potentially cause unintended branch creation or file operations.

**Fix**: Add validation at the input boundary (Zod schema) and apply it in git utilities:
```typescript
// src/utils/git-state.ts
export function validateGitBranchName(name: string): Result<string> {
  // Reject empty, starting with -, containing .., ~, ^, :, \, spaces, or control chars
  if (!name || name.startsWith('-') || /[\x00-\x1f\x7f ~^:?*\[\\]/.test(name) ||
      name.includes('..') || name.endsWith('.lock') || name.endsWith('/') || name.startsWith('/')) {
    return err(new AutobeatError(ErrorCode.INVALID_INPUT, `Invalid git branch name: ${name}`));
  }
  return ok(name);
}

// Apply in createAndCheckoutBranch and captureGitDiff
// Add to Zod schemas: gitBranch: z.string().min(1).regex(/^[^-]/, 'must not start with -')
```

---

### 3. Scheduled Loop Trigger Bypasses Validation
**Files**: `src/services/handlers/schedule-handler.ts:524`
**Severity**: HIGH
**Confidence**: 82% (flagged by Security)

**Problem**: When a scheduled loop fires, `handleLoopTrigger()` calls `createLoop(loopConfig, workingDirectory, scheduleId)` directly using the deserialized `loopConfig` from the database. This bypasses `LoopManagerService.createLoop()`, which performs critical validations: working directory path validation, git repo existence check, agent resolution, `evalTimeout` range check, and `maxIterations`/`maxConsecutiveFailures` bounds.

If the database `loopConfig` JSON is tampered with or conditions change between schedule creation and trigger time (e.g., working directory deleted), the loop starts with unvalidated parameters.

**Impact**: Config validation inconsistency. Direct loop creation (via `LoopManagerService`) validates; scheduled loop creation does not.

**Fix**: Extract validation from `LoopManagerService.createLoop()` into shared `validateLoopConfig()` and call it in `handleLoopTrigger`:
```typescript
// In schedule-handler.ts handleLoopTrigger:
const validationResult = await validateLoopConfig(loopConfig, workingDirectory);
if (!validationResult.ok) {
  await this.scheduleRepo.recordExecution({
    scheduleId,
    loopId: undefined,
    scheduledFor: schedule.nextRunAt ?? triggeredAt,
    executedAt: triggeredAt,
    status: 'failed',
    errorMessage: validationResult.error.message,
    createdAt: Date.now(),
  });
  return ok(undefined);
}
```

---

### 4. Non-Atomic Loop Trigger Execution Recording
**Files**: `src/services/handlers/schedule-handler.ts:530-540`
**Severity**: HIGH
**Confidence**: 88% (flagged by Architecture, Consistency)

**Problem**: `handleSingleTaskTrigger` and `handlePipelineTrigger` both use `Database.runInTransaction()` to atomically save task + record execution + update schedule. However, `handleLoopTrigger` performs `recordExecution` and `update` as separate async calls with no transaction. If `update` fails after `recordExecution` succeeds, the schedule has a stale `runCount`/`nextRunAt` while an execution record exists.

**Impact**: Consistency violation. The three trigger methods in the same handler follow different atomicity patterns, risking data inconsistency on partial failure.

**Fix**: Use synchronous transaction pattern matching existing trigger paths:
```typescript
const txResult = this.database.runInTransaction(() => {
  this.scheduleRepo.recordExecutionSync({
    scheduleId,
    loopId: loop.id,
    scheduledFor: schedule.nextRunAt ?? triggeredAt,
    executedAt: triggeredAt,
    status: 'triggered',
    createdAt: Date.now(),
  });
  return this.scheduleRepo.updateSync(schedule.id, scheduleUpdates, schedule);
});
if (!txResult.ok) {
  return await this.recordFailedExecution(scheduleId, schedule.nextRunAt ?? triggeredAt, triggeredAt, txResult.error.message);
}
```

---

### 5. Missing `toMissedRunPolicy()` Normalization in Scheduled Loop Creation
**Files**: `src/services/schedule-manager.ts:505`
**Severity**: HIGH
**Confidence**: 95% (flagged by Consistency)

**Problem**: `createSchedule` and `createScheduledPipeline` both call `toMissedRunPolicy(request.missedRunPolicy)` to normalize the missed run policy before passing it to `createSchedule()`. The new `createScheduledLoop` method passes `request.missedRunPolicy` directly without the conversion. Pattern deviation could cause mismatched policy values.

**Impact**: Inconsistent missed-run-policy handling across the three schedule creation paths.

**Fix**:
```typescript
// line 505 — change:
missedRunPolicy: request.missedRunPolicy,
// to:
missedRunPolicy: toMissedRunPolicy(request.missedRunPolicy),
```

---

### 6. Task Result Loss in Graceful Pause Scenario
**Files**: `src/services/handlers/loop-handler.ts:202`
**Severity**: HIGH
**Confidence**: 82% (flagged by Regression)

**Problem**: The guard `if (loop.status !== LoopStatus.RUNNING)` on line 202 skips processing when a task completes while the loop is PAUSED (graceful pause case). This causes: (1) iteration result (pass/fail/score) is silently discarded, (2) `taskToLoop` entry is deleted so recovery won't find it, (3) iteration left in `running` status. When resumed, `recoverSingleLoop` finds a `running` iteration with no task, triggering `cancelled` status + restart, losing the actual task result.

**Impact**: **Loss of work in graceful pause**. The grace-pause feature explicitly promises to preserve in-flight iteration results — this bug contradicts that guarantee.

**Fix**: Allow PAUSED status through for result recording but skip scheduling next iteration:
```typescript
if (loop.status !== LoopStatus.RUNNING && loop.status !== LoopStatus.PAUSED) {
  this.logger.warn('Ignoring task completion for non-running loop', { loopId, status: loop.status });
  return ok(undefined);
}
// ... process result ...
if (loop.status === LoopStatus.RUNNING) {
  await this.scheduleNextIteration(...);
}
```

---

### 7. Dead Code: `--strategy` Flag Parsed but Value Discarded
**Files**: `src/cli/commands/schedule.ts:159-164`
**Severity**: HIGH
**Confidence**: 95% (flagged by TypeScript)

**Problem**: The `--strategy` flag is validated (`'retry' | 'optimize'`), the index is incremented to consume the argument, but the parsed value is never stored in any variable. This means `--strategy retry` is accepted but has no effect — strategy is always inferred from `--until` vs `--eval`.

**Impact**: User-facing bug. Documented `--strategy` flag appears to work but is silently ignored. If user passes `--strategy optimize --until <cmd>`, strategy will be RETRY despite explicit request.

**Fix**: Either store and use the strategy, or remove dead code. Option B (remove) is safer:
```typescript
// Option A: Store and use
} else if (arg === '--strategy' && next) {
  if (next !== 'retry' && next !== 'optimize') {
    return err('--strategy must be "retry" or "optimize"');
  }
  explicitStrategy = next;  // Store it
  i++;
}
// Then use: strategy: explicitStrategy === 'optimize' ? LoopStrategy.OPTIMIZE : LoopStrategy.RETRY,

// Option B: Remove dead code (preferred)
// Delete the entire '--strategy' branch (lines 159-164)
```

---

### 8. Complex Conditional Nesting in `handleLoopPaused`
**Files**: `src/services/handlers/loop-handler.ts:366-444`
**Severity**: HIGH
**Confidence**: 88% (flagged by Complexity)

**Problem**: The force-pause path reaches 6 levels of indentation, exceeding the critical 5+ threshold. This decreases readability and increases defect risk. Multiple conditional branches nest: `handleEvent` callback > `if (force)` > `if (iterationsResult.ok && ...)` > `if (latestIteration.status === 'running')` > `if (latestIteration.taskId)` > error handling.

**Impact**: Code maintainability and defect risk.

**Fix**: Extract force-cancel logic into dedicated method:
```typescript
private async forceCancelCurrentIteration(loopId: LoopId, latestIteration: LoopIteration): Promise<Result<void>> {
  // Mark iteration as cancelled
  await this.loopRepo.updateIteration({
    ...latestIteration,
    status: 'cancelled',
    completedAt: Date.now(),
  });

  // Cancel the in-flight task(s)
  return await this.cancelIterationTasks(loopId, latestIteration);
}

// In handleLoopPaused:
if (force && latestIteration.status === 'running') {
  const cancelResult = await this.forceCancelCurrentIteration(loopId, latestIteration);
  if (!cancelResult.ok) {
    this.logger.warn('Failed to cancel iteration', { loopId, error: cancelResult.error.message });
  }
}
```

This reduces `handleLoopPaused` nesting from 6 to 3 levels.

---

### 9. Excessive Cyclomatic Complexity in `parseScheduleCreateArgs`
**Files**: `src/cli/commands/schedule.ts:59-278`
**Severity**: HIGH
**Confidence**: 92% (flagged by Complexity)

**Problem**: This 146-line function contains ~30 decision branches in a for-loop with sequential `else if` statements. The v0.8.0 additions added 10 more branches for loop-specific flags, pushing cyclomatic complexity well past the 50-line critical threshold (now 146+ lines with CC > 30).

**Impact**: Code maintainability. High CC increases defect density and makes testing harder.

**Fix**: Extract loop-specific flag parsing:
```typescript
function parseLoopFlags(loopArgs: string[], startIndex: number):
  Result<{ consumed: number; value: Partial<LoopRawFlags> }, string> {
  let i = startIndex;
  const flags: Partial<LoopRawFlags> = {};
  while (i < loopArgs.length) {
    const arg = loopArgs[i];
    const next = i + 1 < loopArgs.length ? loopArgs[i + 1] : undefined;

    if (arg === '--until' && next) {
      flags.until = next;
      i += 2;
    } else if (arg === '--eval' && next) {
      flags.eval = next;
      i += 2;
    } else if (arg === '--strategy' && next) {
      // Remove this dead code branch (no validation, value not stored)
      i += 2;
    } else if (arg === '--max-iterations' && next) {
      // ... parse maxIterations
      i += 2;
    } else {
      break;  // Not a loop flag
    }
  }
  return ok({ consumed: i - startIndex, value: flags });
}
```

This would reduce `parseScheduleCreateArgs` from 146 to ~80 lines and isolate loop concerns.

---

### 10. Missing `handleLoopPaused` Status Validation
**Files**: `src/services/handlers/loop-handler.ts:379`
**Severity**: MEDIUM
**Confidence**: 80% (flagged by Regression)

**Problem**: The handler blindly updates loop status to PAUSED without verifying the loop is currently RUNNING. While `LoopManagerService.pauseLoop()` validates this, the handler is also reachable directly via `EventBus.emit('LoopPaused', ...)`. A direct event emission could pause a completed/cancelled loop, corrupting state.

**Impact**: Defense-in-depth violation. The handler should be self-protecting.

**Fix**:
```typescript
if (loop.status !== LoopStatus.RUNNING) {
  this.logger.warn('Cannot pause loop that is not running', { loopId, status: loop.status });
  return ok(undefined);
}
```

---

### 11. Fragile Migration: `SELECT *, NULL, NULL, NULL`
**Files**: `src/implementations/database.ts:659`
**Severity**: HIGH (Database)
**Confidence**: 85% (flagged by Database, Regression)

**Problem**: Migration v11 uses `INSERT INTO loops_new SELECT *, NULL, NULL, NULL FROM loops`. This relies on column ordering between v10 `loops` and v11 `loops_new` being identical for the first 20 columns. If a future migration alters column order or a developer adds a column to v10, the NULLs get assigned to wrong columns.

**Impact**: Data corruption risk on migration.

**Fix**: Use explicit column list:
```sql
INSERT INTO loops_new (
  id, strategy, task_template, pipeline_steps, exit_condition,
  eval_direction, eval_timeout, working_directory, max_iterations,
  max_consecutive_failures, cooldown_ms, fresh_context, status,
  current_iteration, best_score, best_iteration_id, consecutive_failures,
  created_at, updated_at, completed_at,
  git_branch, git_base_branch, schedule_id
)
SELECT
  id, strategy, task_template, pipeline_steps, exit_condition,
  eval_direction, eval_timeout, working_directory, max_iterations,
  max_consecutive_failures, cooldown_ms, fresh_context, status,
  current_iteration, best_score, best_iteration_id, consecutive_failures,
  created_at, updated_at, completed_at,
  NULL, NULL, NULL
FROM loops
```

---

### 12. Missing `exitCondition` Max-Length Constraint
**Files**: `src/adapters/mcp-adapter.ts:263`, `src/adapters/mcp-adapter.ts:210`
**Severity**: MEDIUM
**Confidence**: 84% (flagged by Security)

**Problem**: The `exitCondition` Zod schema uses `z.string().min(1)` with no maximum length. This field is stored in SQLite and later executed as a shell command via `child_process.exec`. An extremely long string (megabytes) could cause resource exhaustion.

**Impact**: Denial of service via oversized shell command strings.

**Fix**: Add `.max(4000)` constraint (consistent with `prompt` field):
```typescript
exitCondition: z.string().min(1).max(4000).describe('Shell command to evaluate after each iteration'),
```
Apply in `CreateLoopSchema`, `ScheduleLoopSchema` in `mcp-adapter.ts`, and `LoopConfigSchema` in `schedule-repository.ts`.

---

### 13. Zod Enum Cast Masks Type Mismatch
**Files**: `src/implementations/schedule-repository.ts:583`
**Severity**: MEDIUM
**Confidence**: 85% (flagged by TypeScript)

**Problem**: `LoopConfigSchema` uses `z.enum(['retry', 'optimize'])` which parses to string literals, but `LoopCreateRequest.strategy` expects `LoopStrategy` enum. The `as LoopCreateRequest` cast hides this mismatch. If someone adds a non-string field to `LoopCreateRequest`, the cast silently accepts the wrong shape.

**Impact**: Type safety weakening over time. The cast suppresses real type errors.

**Fix**: Use `z.nativeEnum()` for enum fields:
```typescript
import { LoopStrategy, OptimizeDirection } from '../core/domain.js';

const LoopConfigSchema = z.object({
  // ...
  strategy: z.nativeEnum(LoopStrategy),
  evalDirection: z.nativeEnum(OptimizeDirection).optional(),
  // ...
});

loopConfig = LoopConfigSchema.parse(parsed) satisfies LoopCreateRequest;
```

---

### 14. Missing Test Coverage for Scheduled Loop Creation
**Files**: `src/services/schedule-manager.ts:478` (no test), `src/adapters/mcp-adapter.ts:2316` (no test)
**Severity**: HIGH
**Confidence**: 95% (flagged by Tests)

**Problem**: The new `createScheduledLoop` method (59 lines of business logic) has zero direct unit tests. It validates `loopConfig.exitCondition`, builds a schedule with loopConfig, computes nextRunAt, and emits `ScheduleCreated`. None of these paths are tested. The MCP adapter's `handleScheduleLoop` (45+ lines) is also untested.

**Impact**: Zero visibility into whether scheduled loop creation works correctly. No regression tests.

**Fix**: Add comprehensive tests:
```typescript
describe('ScheduleManagerService.createScheduledLoop()', () => {
  it('should create a cron schedule with loopConfig', async () => {
    const request: ScheduledLoopCreateRequest = {
      loopConfig: mockLoopConfig,
      scheduleType: ScheduleType.CRON,
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
      tags: ['test'],
    };
    const result = await scheduleManager.createScheduledLoop(request);
    expect(result.ok).toBe(true);
    const schedule = result.value;
    expect(schedule.loopConfig).toEqual(mockLoopConfig);
    expect(schedule.cronExpression).toBe('0 9 * * *');
  });

  it('should validate exitCondition is not empty', async () => {
    const request = { ...mockRequest, loopConfig: { ...mockLoopConfig, exitCondition: '' } };
    const result = await scheduleManager.createScheduledLoop(request);
    expect(result.ok).toBe(false);
    expect(result.error.message).toMatch(/exitCondition/);
  });

  it('should emit ScheduleCreated with loopConfig', async () => {
    const result = await scheduleManager.createScheduledLoop(mockRequest);
    const events = eventBus.getAllEmittedEvents();
    const scheduleCreated = events.find(e => e.type === 'ScheduleCreated');
    expect(scheduleCreated?.payload.schedule.loopConfig).toBeDefined();
  });
});
```

---

### 15. MCP Loop Tests Bypass Adapter Dispatch
**Files**: `tests/unit/adapters/mcp-adapter.test.ts:2183-2230`
**Severity**: HIGH
**Confidence**: 85% (flagged by Tests)

**Problem**: The `simulatePauseLoop` and `simulateResumeLoop` helper functions call `loopService` directly and manually construct MCP responses. They do NOT route through the actual `callTool` method, so they skip Zod schema validation, tool routing in the switch statement, and response formatting. A bug in the adapter's `handlePauseLoop` (e.g., wrong field in Zod schema) would not be caught.

**Impact**: Adapter implementation untested. Schema validation, routing, and response formatting are unverified.

**Fix**: Route through the adapter's `callTool` method:
```typescript
it('should pause a loop with graceful mode', async () => {
  const result = await adapter.callTool('PauseLoop', { loopId: 'loop-pause-1', force: false });
  expect(result.isError).toBe(false);
  const response = JSON.parse(result.content[0].text);
  expect(response.success).toBe(true);
  expect(response.force).toBe(false);
});

it('should force-pause a loop', async () => {
  const result = await adapter.callTool('PauseLoop', { loopId: 'loop-pause-1', force: true });
  expect(result.isError).toBe(false);
  const response = JSON.parse(result.content[0].text);
  expect(response.force).toBe(true);
});
```

---

## Should-Fix Issues (Category 2: Related Code)

| Issue | File | Severity | Confidence |
|-------|------|----------|-----------|
| Missing `LoopPaused` subscription in ScheduleExecutor | `src/services/schedule-executor.ts:140-150` | MEDIUM | 70% |
| `handleLoopTrigger` does not use `afterScheduleId` chaining | `src/services/handlers/schedule-handler.ts:490-571` | MEDIUM | 65% |
| ScheduleHandler imports domain factory (SRP boundary) | `src/services/handlers/schedule-handler.ts:524` | MEDIUM | 82% |
| LoopHandler directly imports git utilities (SRP boundary) | `src/services/handlers/loop-handler.ts:45` | MEDIUM | 80% |
| `nextRunAt` injection pattern differs from existing paths | `src/services/schedule-manager.ts:512` | MEDIUM | 82% |
| Git operations lack timeout on event-driven hot path | `src/services/handlers/loop-handler.ts:528`, `src/services/handlers/loop-handler.ts:1003` | MEDIUM | 82% |
| `recoverStuckLoops` does not recover PAUSED loops | `src/services/handlers/loop-handler.ts:1306` | MEDIUM | 80% |

---

## Pre-existing Issues (Category 3: Not Blocking)

| Issue | File | Severity | Confidence |
|-------|------|----------|-----------|
| `exitCondition` uses `exec` (shell) not `execFile` | `src/services/exit-condition-evaluator.ts:30` | MEDIUM | 90% |
| `clearRunningScheduleByTask` uses linear scan O(n) | `src/services/schedule-executor.ts:171-178` | MEDIUM | 80% |
| Update statement overwrites immutable fields | `src/implementations/loop-repository.ts:191-214` | MEDIUM | 80% |
| Missing FK constraint on `schedule_executions.loop_id` | `src/implementations/database.ts:681` | MEDIUM | 82% |
| `LoopConfigSchema` validation lacks numeric constraints | `src/implementations/schedule-repository.ts:114-129` | MEDIUM | 80% |
| `callTool` switch statement has 21 cases | `src/adapters/mcp-adapter.ts:350` | MEDIUM | 90% |

---

## Positive Observations

1. **Type discipline enforced**: Branded types used consistently throughout (TaskId, LoopId, ScheduleId, LoopIteration). The `as unknown as TaskId` cast is an exception, not the rule.

2. **Event-driven architecture well-executed**: New handlers (LoopPaused, LoopResumed) follow established patterns with early returns, clear flow, and proper error handling.

3. **Test patterns are strong**: Pause/resume lifecycle tests, repository tests for new schema fields, and CLI parser tests are all well-structured and behavior-driven.

4. **Graceful degradation**: Git operations fail gracefully (warning + continue) rather than failing loops. This is intentional design.

5. **New domain types are minimal and well-defined**: `LoopPausedEvent`, `LoopResumedEvent`, `ScheduledLoopCreateRequest` are focused interfaces with no bloat.

6. **Handler setup properly wired**: New dependencies injected correctly in `handler-setup.ts`.

7. **Result types used consistently**: All service methods return `Result<T, Error>`, no exceptions in business logic.

8. **Zod validation at boundaries**: MCP and CLI inputs validated with comprehensive schemas before reaching domain.

---

## Risk Assessment

**Overall Risk Level**: **MEDIUM** (fixable with targeted changes)

**High-Risk Areas**:
- Type safety (unsafe cast creates future maintenance trap)
- Security (git command injection, validation bypass)
- Regression (task result loss in pause scenario contradicts documented behavior)

**Medium-Risk Areas**:
- Complexity (two functions exceed thresholds)
- Test coverage (two features untested)
- Consistency (pattern deviations in transaction handling)

**Low-Risk Areas**:
- Architecture (event-driven patterns well-executed)
- Database (migration safe, just needs explicit columns)
- Performance (git operations on hot path need timeout, but graceful degradation present)

---

## Recommended Fix Order

**Priority 1 (Type Safety & Correctness)** — 1 hour
1. Fix `LoopId as unknown as TaskId` cast → widen `ScheduleExecutedEvent` interface
2. Fix task result loss in graceful pause → allow PAUSED through `handleTaskTerminal`
3. Add status validation to `handleLoopPaused`

**Priority 2 (Security & Consistency)** — 1.5 hours
4. Add git branch name validation
5. Extract validation from `LoopManagerService` for scheduled trigger
6. Fix non-atomic loop trigger recording
7. Add `toMissedRunPolicy()` normalization
8. Add `exitCondition` max-length constraint

**Priority 3 (Dead Code & Complexity)** — 1 hour
9. Remove or fix `--strategy` dead code
10. Extract force-cancel from `handleLoopPaused` (6-level nesting)
11. Extract loop flags from `parseScheduleCreateArgs` (146-line CC>30 function)

**Priority 4 (Tests & Migration)** — 1.5 hours
12. Add unit tests for `createScheduledLoop()` and `handleScheduleLoop()`
13. Fix MCP adapter tests to route through adapter dispatch
14. Fix migration v11 with explicit column list
15. Add missing git branch iteration tests

---

## Summary Statistics

- **Total Unique Issues**: 30 (15 blocking, 7 should-fix, 8 pre-existing)
- **Type Safety Issues**: 5 (unsafe casts, dead code, type mismatches)
- **Security Issues**: 3 (git injection, validation bypass, constraint missing)
- **Regression Issues**: 3 (task result loss, API change, status handling)
- **Test Coverage Gaps**: 4 (createScheduledLoop, handleScheduleLoop, git branch logic, MCP adapter)
- **Complexity Issues**: 2 (handleLoopPaused nesting, parseScheduleCreateArgs)
- **Consistency Issues**: 3 (transaction handling, policy normalization, nextRunAt injection)

**Effort to Fix**: 4-5 hours (surgical changes, no rearchitecting needed)

**Quality After Fix**: Expected score improvement from 6.8/10 to 9.2/10 across all reviewers
