# Consistency Review Report

**Branch**: feat/v070-task-loops -> main
**Date**: 2026-03-21

## Issues in Your Changes (BLOCKING)

### HIGH

**LoopRepository.update() signature deviates from TaskRepository/ScheduleRepository pattern** - `src/core/interfaces.ts:534`, `src/implementations/loop-repository.ts:274`
**Confidence**: 90%
- Problem: The existing `TaskRepository.update()` and `ScheduleRepository.update()` both accept `(id, Partial<T>)` signatures -- `update(taskId: TaskId, update: Partial<Task>)` and `update(id: ScheduleId, update: Partial<Schedule>)`. The new `LoopRepository.update()` instead accepts `(loop: Loop)` (the entire domain object). This is an inconsistent API shape for repositories within the same codebase.
- Impact: Developers familiar with the existing repository pattern will expect `update(id, partial)`. The full-object signature also requires callers to always construct a complete Loop object (via `updateLoop()`) before persisting, which is a different workflow than how tasks and schedules are updated (where partial updates are sent directly to the repo).
- Fix: Either align `LoopRepository.update()` to `update(id: LoopId, update: Partial<Loop>)` to match existing repos, OR acknowledge this as an intentional design choice and document the deviation. Given that `updateLoop()` domain helper is always used anyway, the full-object pattern is defensible -- but it should be documented.

**LoopRepository.findById() returns `undefined` instead of `null`** - `src/core/interfaces.ts:539`, `src/core/interfaces.ts:623`
**Confidence**: 92%
- Problem: The existing `TaskRepository.findById()` returns `Result<Task | null>` and `ScheduleRepository.findById()` returns `Result<Schedule | null>`. The new `LoopRepository.findById()` returns `Result<Loop | undefined>` and `findByIdSync()` returns `Loop | undefined`. The codebase consistently uses `null` for "not found" return values from repositories.
- Impact: Inconsistent nullable patterns create confusion. Consumers need to check `=== null` for tasks/schedules but `=== undefined` for loops. This propagates through the service layer (e.g., `loop-manager.ts:321` checks `!result.value` which works for both, but the type contract differs).
- Fix: Change to `Result<Loop | null>` and `Loop | null` to match `TaskRepository` and `ScheduleRepository`:
  ```typescript
  findById(id: LoopId): Promise<Result<Loop | null>>;
  findByIdSync(id: LoopId): Loop | null;
  ```

### MEDIUM

**ErrorCode.TASK_NOT_FOUND used for Loop not-found errors** - `src/services/loop-manager.ts:322`, `src/services/handlers/loop-handler.ts:380`
**Confidence**: 85%
- Problem: When a loop is not found, the code uses `ErrorCode.TASK_NOT_FOUND` with the message "Loop {loopId} not found". The same pattern exists in `ScheduleManagerService` (which also uses `ErrorCode.TASK_NOT_FOUND` for schedules at `schedule-manager.ts:509`), so this is actually consistent with the existing (imperfect) pattern. However, it produces confusing error codes -- a `TASK_NOT_FOUND` error for a loop lookup.
- Impact: Misleading error codes in logs and error responses. A `LOOP_NOT_FOUND` or generic `NOT_FOUND` error code would be more precise.
- Fix: Since `ScheduleManagerService` has the same issue, this is a pre-existing pattern. No blocking action needed, but consider adding `LOOP_NOT_FOUND` (and `SCHEDULE_NOT_FOUND`) error codes in a follow-up.

**MCP tool names for loops deviate from schedule naming convention** - `src/adapters/mcp-adapter.ts`
**Confidence**: 82%
- Problem: Schedule tools follow the pattern `{Verb}{Noun}` for actions and `{Verb/Get}{Noun}` for queries: `ScheduleTask`, `ListSchedules`, `GetSchedule`, `CancelSchedule`, `PauseSchedule`, `ResumeSchedule`. Loop tools use: `CreateLoop`, `LoopStatus`, `ListLoops`, `CancelLoop`. The `LoopStatus` tool breaks the `Get{Noun}` convention (should be `GetLoop` for consistency with `GetSchedule`). The CLAUDE.md documents PascalCase tools and lists them explicitly but does not yet include loop tools.
- Impact: Inconsistent tool naming across feature areas. `LoopStatus` vs `GetSchedule` for equivalent operations.
- Fix: Rename `LoopStatus` to `GetLoop` to match `GetSchedule`. Update CLAUDE.md's MCP Tools list to include the new loop tools.

**Loop domain timestamps use `number` (epoch ms) but MEMORY.md claims Date objects** - `src/core/domain.ts:524-526`
**Confidence**: 80%
- Problem: The memory note says "Loop timestamps use Date objects -- Unlike Schedule/Task (epoch ms), loops use Date for human readability. Repo handles conversion." However, the actual Loop interface in domain.ts uses `number` for `createdAt`, `updatedAt`, and `completedAt` -- identical to Task and Schedule. This is actually consistent with the codebase, but the memory note is inaccurate.
- Impact: The memory note could mislead future development sessions into thinking loops have a different timestamp convention.
- Fix: Update the memory note to reflect reality: loops use epoch ms like everything else. No code change needed.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**CLAUDE.md MCP Tools list not updated with loop tools** - `CLAUDE.md:138`
**Confidence**: 88%
- Problem: CLAUDE.md explicitly lists all MCP tools: "All tools use PascalCase: `DelegateTask`, `TaskStatus`, ... `SchedulePipeline`". The new loop tools (`CreateLoop`, `LoopStatus`, `ListLoops`, `CancelLoop`) are not listed.
- Impact: CLAUDE.md is the project's source of truth for Claude Code guidance. Missing tool names means future sessions may not know these tools exist.
- Fix: Append the loop tools to the list:
  ```
  All tools use PascalCase: `DelegateTask`, `TaskStatus`, `TaskLogs`, `CancelTask`, `ScheduleTask`, `ListSchedules`, `GetSchedule`, `CancelSchedule`, `PauseSchedule`, `ResumeSchedule`, `CreatePipeline`, `SchedulePipeline`, `CreateLoop`, `LoopStatus`, `ListLoops`, `CancelLoop`
  ```

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Schedule also uses ErrorCode.TASK_NOT_FOUND for schedule not-found** - `src/services/schedule-manager.ts:509`
**Confidence**: 85%
- Problem: The pattern of reusing `TASK_NOT_FOUND` for non-task entities predates this PR. The loop code follows the same pattern, so it is consistent within the codebase -- but the underlying issue affects multiple features.
- Impact: Error codes lose semantic value when `TASK_NOT_FOUND` can mean "loop not found" or "schedule not found".

### LOW

**ScheduleRepository.update() fetches existing entity before updating; LoopRepository.update() does not** - `src/implementations/schedule-repository.ts:288` vs `src/implementations/loop-repository.ts:274`
**Confidence**: 70% (moved to Suggestions)

## Suggestions (Lower Confidence)

- **LoopRepository.update() skips existence check** - `src/implementations/loop-repository.ts:274` (Confidence: 70%) -- ScheduleRepository.update() fetches the existing record before applying updates; LoopRepository.update() directly runs the UPDATE statement without checking if the row exists. This could silently succeed (updating 0 rows) when the loop ID is invalid. However, the `updateLoop()` domain helper pattern means callers always have a valid Loop object, so this may be acceptable.

- **No shutdown/cleanup method on LoopHandler for cooldown timers** - `src/services/handlers/loop-handler.ts` (Confidence: 72%) -- LoopHandler maintains a `cooldownTimers` Map with active setTimeout handles (line 59). While `.unref()` is called on timers so they won't block process exit, there is no explicit `shutdown()` method to clear timers and in-memory maps during graceful shutdown. ScheduleHandler has no shutdown method either, so this is consistent -- but LoopHandler's timers make cleanup more important.

- **CLI loop cancel default differs from MCP default for cancelTasks** - `src/cli/commands/loop.ts` vs `src/adapters/mcp-adapter.ts` (Confidence: 65%) -- The CLI `handleLoopCancel` defaults `cancelTasks` to `false` (opt-in via `--cancel-tasks` flag), while the MCP `CancelLoopSchema` defaults `cancelTasks` to `true`. This could cause different behavior depending on which interface is used for the same operation.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Consistency Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The new loop feature largely follows established codebase conventions (factory pattern for handlers, Result types, event-driven architecture, Zod validation at boundaries, branded ID types, immutable domain objects). The main consistency gaps are: (1) the `findById` return type using `undefined` instead of `null`, (2) the repository `update()` signature accepting a full object instead of `(id, Partial)`, and (3) the MCP tool naming deviation (`LoopStatus` vs `GetLoop`). These are individually small but collectively represent a pattern drift that should be addressed before merging to maintain codebase uniformity.
