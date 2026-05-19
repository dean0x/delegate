# Regression Review Report

**Branch**: feat/v070-task-loops -> main
**Date**: 2026-03-21
**PR**: #110

## Regression Checklist

- [x] No exports removed without deprecation
- [x] Return types backward compatible
- [x] Default values unchanged (or documented)
- [x] Side effects preserved (events, logging)
- [x] All consumers of changed code updated
- [x] Migration complete across codebase
- [x] CLI options preserved or deprecated
- [x] API endpoints preserved or versioned
- [x] Commit messages match implementation
- [x] No deleted files

## Issues in Your Changes (BLOCKING)

### CRITICAL

No critical blocking issues found.

### HIGH

No high-severity blocking issues found.

### MEDIUM

No medium-severity blocking issues found.

## Issues in Code You Touched (Should Fix)

No should-fix issues found.

## Pre-existing Issues (Not Blocking)

No pre-existing issues found.

## Suggestions (Lower Confidence)

No lower-confidence suggestions.

## Detailed Analysis

### 1. Constructor Signature Changes (No Regression)

**MCPAdapter constructor** -- `src/adapters/mcp-adapter.ts:260`
- New 4th parameter `loopService: LoopService` inserted before `agentRegistry`
- **All 8 call sites updated** (1 in bootstrap.ts, 7 in mcp-adapter.test.ts)
- Confidence: 95% -- Verified all callers updated; no external consumers (private class)

**RecoveryManager constructor** -- `src/services/recovery-manager.ts:27`
- New 7th parameter `loopRepository?: LoopRepository` added as **optional**
- **3 existing call sites in task-persistence.test.ts remain valid** with 6 args (optional param)
- **1 existing call site in recovery-manager.test.ts** remains valid
- **2 new test call sites** pass 7th argument for loop cleanup tests
- Confidence: 98% -- Optional parameter guarantees backward compatibility

**withServices return type** -- `src/cli/services.ts:63`
- Added `loopService: LoopService` to return object
- All existing consumers destructure only what they need (`{ taskManager }`, `{ scheduleService }`)
- New consumer: `src/cli/commands/loop.ts` uses `{ loopService }`
- Confidence: 95% -- Additive change, object destructuring is forward-compatible

**HandlerDependencies interface** -- `src/services/handler-setup.ts:54`
- Added `loopRepository: LoopRepository & SyncLoopOperations`
- **Required** (not optional) -- all callers updated (bootstrap.ts, handler-setup.test.ts)
- Confidence: 95% -- Verified all callers supply the new dependency

**HandlerSetupResult interface** -- `src/services/handler-setup.ts:68`
- Added `loopHandler: LoopHandler`
- **Required** -- bootstrap.ts now registers `setupResult.value.loopHandler`
- Confidence: 95% -- Single consumer (bootstrap.ts) properly updated

**ReadOnlyContext interface** -- `src/cli/read-only-context.ts:24`
- Added `loopRepository: LoopRepository`
- All existing consumers access only `taskRepository`, `outputRepository`, `scheduleRepository`
- New consumer: `src/cli/commands/loop.ts` accesses `loopRepository`
- Test updated to verify new field exists
- Confidence: 95% -- Additive, existing consumers unaffected

### 2. Behavioral Changes (No Regression)

**truncatePrompt extraction** -- `src/utils/format.ts` (new), `src/services/schedule-manager.ts` (removed local)
- Local `truncatePrompt` in schedule-manager.ts was moved to shared `src/utils/format.ts`
- Identical implementation: `if (text.length <= maxLen) return text; return text.substring(0, maxLen) + '...';`
- All 7 import sites verified: schedule-manager, mcp-adapter, schedule.ts, status.ts, loop.ts, loop-manager.ts, format.ts
- Confidence: 98% -- Exact same logic, just relocated

**MCP single-task prompt truncation fix** -- `src/adapters/mcp-adapter.ts:1144`
- Old: `task.prompt.substring(0, 100) + '...'` (always appended `...` even for short prompts)
- New: `truncatePrompt(task.prompt, 100)` (only appends `...` when actually truncated)
- This is a **bug fix**, not a regression. Short prompts no longer get spurious `...` suffix.
- Same fix applied to schedule template prompt and pipeline step prompt display.
- Confidence: 95% -- Correct behavioral improvement

**MCP task list response adds promptPreview** -- `src/adapters/mcp-adapter.ts:1117-1121`
- Added `promptPreview` field to task objects in list response via `{ ...task, promptPreview }`
- Original `prompt` field still present (spread preserves all original fields)
- Additive change -- existing consumers that parse the response are not broken
- Confidence: 95% -- Strictly additive, spread preserves all existing fields

### 3. Event System (No Regression)

**New event types added** -- `src/core/events/events.ts`
- 4 new event interfaces: `LoopCreatedEvent`, `LoopIterationCompletedEvent`, `LoopCompletedEvent`, `LoopCancelledEvent`
- Added to `AutobeatEvent` union type (additive, no existing types changed)
- Confidence: 98% -- Additive-only union extension

**LoopHandler subscribes to existing events** -- `src/services/handlers/loop-handler.ts:117-119`
- Subscribes to `TaskCompleted`, `TaskFailed`, `TaskCancelled` (existing event types)
- Handler immediately returns `ok(undefined)` for non-loop tasks (line 178-181)
- Guard check: `this.taskToLoop.get(taskId)` returns undefined for regular tasks
- No interference with existing DependencyHandler, QueueHandler, PersistenceHandler
- Confidence: 92% -- Guard pattern is sound; multiple handlers on same event is established pattern

### 4. Database Migration (No Regression)

**Migration v10** -- `src/implementations/database.ts`
- Creates `loops` and `loop_iterations` tables (new tables, no existing tables modified)
- Foreign key: `loop_iterations.task_id REFERENCES tasks(id) ON DELETE SET NULL`
- Foreign key: `loop_iterations.loop_id REFERENCES loops(id) ON DELETE CASCADE`
- 4 performance indexes created
- No changes to existing tables or indexes
- Confidence: 98% -- New tables only, existing schema untouched

### 5. Domain Types (No Regression)

**New types** -- `src/core/domain.ts`
- `LoopId` branded type, `LoopStatus` enum, `LoopStrategy` enum, `OptimizeDirection` enum
- `Loop`, `LoopIteration`, `LoopCreateRequest` interfaces
- `createLoop()`, `updateLoop()` factory/helper functions
- All additive -- no existing types modified
- Confidence: 98%

### 6. Interfaces (No Regression)

**New interfaces** -- `src/core/interfaces.ts`
- `LoopRepository`, `SyncLoopOperations`, `LoopService`
- Additive -- no existing interfaces modified
- Confidence: 98%

### 7. Package.json Test Scripts (No Regression)

- `test:services`: Added `tests/unit/services/loop-manager.test.ts`
- `test:handlers`: Added `tests/unit/services/handlers/loop-handler.test.ts`
- `test:repositories`: Added `tests/unit/implementations/loop-repository.test.ts`
- All additions to existing script definitions -- no removals
- Confidence: 98%

### 8. Intent vs Implementation

All 21 commits verified against their messages:
- `feat:` commits add new functionality (loop types, events, repo, handler, MCP tools, CLI)
- `fix:` commits address specific issues (timestamps, optional taskId, self-review)
- `refactor:` commits extract/simplify (recordAndContinue helper, unused parameter)
- `style:` commits are formatting only (biome)
- `test:` commits add new tests
- `docs:` commits update documentation
- No intent/reality mismatches detected
- Confidence: 90%

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | - | 0 | 0 |

**Regression Score**: 9/10
**Recommendation**: APPROVED

## Rationale

This is a clean additive feature branch with no regression risk:

1. **No removed exports, files, or event handlers** -- zero lost functionality
2. **All constructor signature changes properly propagated** -- every call site updated or backward-compatible via optional parameters
3. **Extracted `truncatePrompt` is functionally identical** -- moved, not changed (with a minor bug fix for always-appended `...`)
4. **New LoopHandler subscribes to existing events non-destructively** -- guard pattern (`taskToLoop.get()`) ensures non-loop tasks are ignored immediately
5. **Database migration is strictly additive** -- new tables, no schema changes to existing tables
6. **All 1,092 tests pass** across all test groups (adapters, services, handlers, repositories, integration, CLI, core, scheduling)
7. **All consumers of changed interfaces verified** -- no orphan references to old APIs
