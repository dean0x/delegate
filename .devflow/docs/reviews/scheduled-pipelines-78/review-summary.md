# Review Summary: Scheduled Pipelines (PR #80)

**Branch**: feat/scheduled-pipelines-78 -> main
**Date**: 2026-03-18
**Reviewers**: architecture, complexity, consistency, database, documentation, performance, regression, security, tests, typescript (10 reports)

---

## Merge Recommendation: CHANGES_REQUESTED

Seven of ten reviewers requested changes; three approved with conditions. The blocking issues center on three themes: (1) duplicated business logic introduced in this PR, (2) missing Zod validation on `pipeline_task_ids`, and (3) documentation contradictions and test coverage gaps. All blocking issues have straightforward fixes.

---

## Issue Counts

| Severity | Blocking | Should-Fix | Pre-existing | Total |
|----------|----------|------------|--------------|-------|
| CRITICAL | 1 | 0 | 0 | 1 |
| HIGH | 9 | 1 | 1 | 11 |
| MEDIUM | 14 | 10 | 7 | 31 |
| LOW | 2 | 3 | 6 | 11 |
| **Total** | **26** | **14** | **14** | **54** |

After deduplication (see below), the unique blocking issue count is **11** (1 CRITICAL, 5 HIGH, 5 MEDIUM).

---

## Top 5 Priority Fixes

### 1. Refactor `createSchedule` to use `validateScheduleTiming`

**Severity**: HIGH | **Flagged by**: architecture, complexity, consistency, regression (4 reviewers)

The `validateScheduleTiming` helper was extracted for `createScheduledPipeline`, and its own JSDoc claims it is "shared between createSchedule and createScheduledPipeline", but `createSchedule` still contains ~80 lines of identical inline validation. This is the most-flagged issue across all reviews.

**Fix**: Replace the inline validation in `createSchedule` with a call to `validateScheduleTiming`:
```typescript
async createSchedule(request: ScheduleCreateRequest): Promise<Result<Schedule>> {
  const timingResult = this.validateScheduleTiming(request);
  if (!timingResult.ok) return timingResult;
  const { scheduledAtMs, expiresAtMs, nextRunAt, timezone } = timingResult.value;
  // ... rest of createSchedule using extracted values
}
```

**Files**: `src/services/schedule-manager.ts:64-176`

---

### 2. Consolidate `afterScheduleId` resolution logic

**Severity**: HIGH | **Flagged by**: architecture, complexity, consistency (3 reviewers)

`handlePipelineTrigger` re-implements afterScheduleId resolution inline (~18 lines) instead of using the extracted `resolveAfterScheduleDependency` helper. The core lookup-check-decide flow (fetch history, get latest execution, check terminal state) is duplicated.

**Fix**: Extract a lower-level `resolveAfterScheduleTaskId` that returns `TaskId | undefined`, then consume it from both `handleSingleTaskTrigger` and `handlePipelineTrigger`:
```typescript
private async resolveAfterScheduleTaskId(afterScheduleId: ScheduleId): Promise<TaskId | undefined> {
  const historyResult = await this.scheduleRepo.getExecutionHistory(afterScheduleId, 1);
  if (!historyResult.ok || historyResult.value.length === 0) return undefined;
  const latestExecution = historyResult.value[0];
  if (!latestExecution.taskId) return undefined;
  const depTaskResult = await this.taskRepo.findById(latestExecution.taskId);
  if (!depTaskResult.ok || !depTaskResult.value || isTerminalState(depTaskResult.value.status)) return undefined;
  return latestExecution.taskId;
}
```

**Files**: `src/services/handlers/schedule-handler.ts:327-345` (inline) vs `455-485` (helper)

---

### 3. Update TASK-DEPENDENCIES.md to reflect dependency cascade behavior

**Severity**: CRITICAL | **Flagged by**: documentation (1 reviewer, but severity is CRITICAL)

TASK-DEPENDENCIES.md explicitly documents that failed/cancelled dependencies **unblock** dependent tasks. The PR introduces the opposite behavior: cascade cancellation. Multiple sections contradict the new code, including "Handle Dependency Failures", "Error Handling" examples, "Cancelled Dependency Propagation", "Design Rationale", and a stale "Future Consideration (v0.4.0)" section.

**Fix**: Update all contradicting sections in `docs/TASK-DEPENDENCIES.md`:
- Section "3. Handle Dependency Failures": Replace with v0.6.0 cascade semantics
- "Error Handling" example: Update to show cascade cancellation
- "Cancelled Dependency Propagation": Remove "does NOT automatically cancel" claim
- "Future Consideration (v0.4.0)": Remove or mark as implemented
- Event flow diagram: Add cascade cancellation path

**Files**: `docs/TASK-DEPENDENCIES.md` (lines 95-103, 377-403, 466-585)

---

### 4. Add Zod validation for `pipeline_task_ids` JSON deserialization

**Severity**: MEDIUM (blocking) | **Flagged by**: database, security, typescript (3 reviewers)

`pipeline_task_ids` is parsed with `JSON.parse(...) as string[]` (bare type assertion) while sibling field `pipeline_steps` correctly uses `PipelineStepsSchema.parse()`. Malformed data would silently produce invalid `TaskId` values.

**Fix**:
```typescript
const PipelineTaskIdsSchema = z.array(z.string().min(1));

if (data.pipeline_task_ids) {
  try {
    const parsed = JSON.parse(data.pipeline_task_ids);
    const validated = PipelineTaskIdsSchema.parse(parsed);
    pipelineTaskIds = validated.map((id) => TaskId(id));
  } catch {
    pipelineTaskIds = undefined;
  }
}
```

**Files**: `src/implementations/schedule-repository.ts:538-545`

---

### 5. MCP adapter tests must exercise real adapter, not simulate helpers

**Severity**: HIGH | **Flagged by**: tests (1 reviewer)

The new `SchedulePipeline` and enhanced schedule tool tests call freestanding `simulate*` helper functions that re-implement adapter logic inline. The actual `handleSchedulePipeline()`, `handleCancelSchedule()`, `handleListSchedules()`, and `handleGetSchedule()` methods are never exercised. The `adapter` variable created in `beforeEach` is unused.

**Fix**: Replace helper calls with actual `adapter.handleToolCall('SchedulePipeline', {...})` invocations. Also add a service-level test for `cancelSchedule` with `cancelTasks=true`.

**Files**: `tests/unit/adapters/mcp-adapter.test.ts:857-990`, `tests/unit/services/schedule-manager.test.ts`

---

## Deduplicated Issue List

### BLOCKING Issues

#### CRITICAL

| # | Issue | Reviewers | Files |
|---|-------|-----------|-------|
| 1 | TASK-DEPENDENCIES.md contradicts new dependency cascade behavior | documentation | `docs/TASK-DEPENDENCIES.md` |

#### HIGH

| # | Issue | Reviewers | Files |
|---|-------|-----------|-------|
| 2 | `createSchedule` not refactored to use `validateScheduleTiming` | architecture, complexity, consistency, regression | `src/services/schedule-manager.ts` |
| 3 | Duplicated `afterScheduleId` resolution logic in `handlePipelineTrigger` | architecture, complexity, consistency | `src/services/handlers/schedule-handler.ts` |
| 4 | Pipeline task creation loop not wrapped in a transaction (orphan risk on crash) | database | `src/services/handlers/schedule-handler.ts:340-399` |
| 5 | MCP adapter tests use simulate helpers instead of real adapter code paths | tests | `tests/unit/adapters/mcp-adapter.test.ts` |
| 6 | No service-level test for `cancelSchedule` with `cancelTasks=true` | tests | `tests/unit/services/schedule-manager.test.ts` |

Note: The "duplicated `missedRunPolicy` ternary in CLI" (complexity reviewer, HIGH) is a separate duplication issue in `src/cli/commands/schedule.ts:172-175` vs `222-228`.

#### MEDIUM (Blocking)

| # | Issue | Reviewers | Files |
|---|-------|-----------|-------|
| 7 | Missing Zod validation on `pipeline_task_ids` JSON parse | database, security, typescript | `src/implementations/schedule-repository.ts:538-545` |
| 8 | Pipeline cleanup bypasses event system (no dependency resolution for cancelled tasks) | architecture, database, regression | `src/services/handlers/schedule-handler.ts:380-387` |
| 9 | `nextRunAt` fallback uses `undefined` in SchedulePipeline but `null` everywhere else | consistency | `src/adapters/mcp-adapter.ts:1616` |
| 10 | Non-null assertion `schedule.pipelineSteps!` instead of type guard | typescript | `src/services/handlers/schedule-handler.ts:319` |
| 11 | Missing release notes for v0.6.0 | documentation | `docs/releases/` |

### SHOULD-FIX Issues

| # | Issue | Reviewers | Severity |
|---|-------|-----------|----------|
| 12 | `cancelSchedule` ordering: schedule cancelled before tasks fetched (race) | security | MEDIUM |
| 13 | `recordFailedExecution` hardcodes "Failed to create task:" prefix | regression | MEDIUM |
| 14 | No JSDoc on `cancelSchedule` new parameter or `createScheduledPipeline` | documentation | HIGH / MEDIUM |
| 15 | N+1 `getDependencies()` in dependency cascade check | performance | MEDIUM |
| 16 | `ScheduleExecuted` event `taskId` semantics differ for pipelines (undocumented) | regression | LOW |
| 17 | `cancelSchedule` only cancels latest execution's tasks, not all in-flight | database | MEDIUM |
| 18 | Nesting depth 5 in dependency cascade check | complexity | MEDIUM |
| 19 | EVENT_FLOW.md does not document pipeline trigger flow | documentation | MEDIUM |
| 20 | No error-path tests for `createScheduledPipeline` validation | tests | MEDIUM |
| 21 | Pipeline trigger test uses dynamic imports in vi.spyOn (fragile) | tests | MEDIUM |
| 22 | `typeof schedule.taskTemplate` return type instead of explicit `TaskRequest` | typescript | MEDIUM |
| 23 | `SchedulePipeline` response field order differs from `ScheduleTask` | consistency | MEDIUM |
| 24 | `missedRunPolicy` Zod schemas lack `.describe()` | consistency | MEDIUM |

### PRE-EXISTING Issues (Not Blocking)

| # | Issue | Reviewers | Severity |
|---|-------|-----------|----------|
| 25 | MCP adapter growing toward god class (1,776 lines) | architecture, complexity | MEDIUM |
| 26 | Zod schema / JSON Schema duplication pattern across all tools | architecture, complexity | MEDIUM |
| 27 | `INSERT OR REPLACE` in schedule repo can trigger cascading deletes | database | MEDIUM |
| 28 | Read-modify-write pattern in schedule update (re-serializes unchanged JSON) | performance | MEDIUM |
| 29 | `afterSchedule` (MCP) vs `afterScheduleId` (domain) naming inconsistency | consistency | MEDIUM |
| 30 | `findDue` SELECT * returns pipeline_steps on hot path | database, performance | LOW |
| 31 | `ErrorCode.TASK_NOT_FOUND` used for schedule not found | architecture | LOW |
| 32 | No integration test for full pipeline trigger flow | tests | MEDIUM |

---

## Strengths

1. **Strong decomposition of schedule handler**: The refactoring of `handleScheduleTriggered` into `handleSingleTaskTrigger`, `handlePipelineTrigger`, and shared helpers (`recordFailedExecution`, `recordTriggeredExecution`, `updateScheduleAfterTrigger`, `resolveAfterScheduleDependency`) demonstrates excellent SRP awareness.

2. **Clean domain model extension**: The `pipelineSteps` field on `Schedule` and `pipelineTaskIds` on `ScheduleExecution` are additive, nullable, and backward-compatible. The migration is safe (new nullable TEXT columns).

3. **Thorough input validation at MCP boundary**: Zod schemas enforce step count limits (2-20), prompt length (1-4000), priority enum, agent enum, schedule type enum, and path validation with symlink resolution.

4. **Correct dependency cascade fix**: The DependencyHandler change properly prevents blocked tasks from running when upstream tasks fail, closing a correctness gap. The QueueHandler fast-path optimization is a smart, well-documented race condition fix.

5. **Consistent Result<T> pattern**: All new methods follow the established Result type pattern with no thrown errors in business logic. Error handling is explicit and composable.

6. **Comprehensive security practices**: Parameterized SQL statements throughout, `validatePath()` with symlink resolution, immutable data patterns, and full audit trail for pipeline executions.

7. **Extensive test coverage**: The PR adds tests for pipeline trigger logic (real SQLite), pipeline creation, dependency cascade, queue handler fast-path, and repository round-trip, covering both happy paths and failure modes.

8. **Well-documented breaking change**: The dependency cascade behavior change is clearly called out in FEATURES.md as a breaking change with explanation of old vs new behavior.

---

## Review Scores

| Reviewer | Score | Recommendation |
|----------|-------|----------------|
| Architecture | 7/10 | CHANGES_REQUESTED |
| Complexity | 6/10 | CHANGES_REQUESTED |
| Consistency | 6/10 | CHANGES_REQUESTED |
| Database | 6/10 | CHANGES_REQUESTED |
| Documentation | 4/10 | CHANGES_REQUESTED |
| Performance | 7/10 | APPROVED_WITH_CONDITIONS |
| Regression | 8/10 | APPROVED_WITH_CONDITIONS |
| Security | 8/10 | APPROVED_WITH_CONDITIONS |
| Tests | 6/10 | CHANGES_REQUESTED |
| TypeScript | 7/10 | CHANGES_REQUESTED |
| **Average** | **6.5/10** | **CHANGES_REQUESTED** |
