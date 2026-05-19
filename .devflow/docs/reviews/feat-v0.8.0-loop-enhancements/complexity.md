# Complexity Review Report

**Branch**: feat/v0.8.0-loop-enhancements -> main
**Date**: 2026-03-23
**Reviewer Focus**: Cyclomatic complexity, deep nesting, long functions, complex conditionals

## Issues in Your Changes (BLOCKING)

### HIGH

**`parseScheduleCreateArgs` is a 146-line function with ~30 decision branches** - `src/cli/commands/schedule.ts:59`
**Confidence**: 92%
- Problem: This function spans lines 59-278 (after v0.8.0 additions). The for-loop body at line 87 contains a chain of ~30 `else if` branches, each handling a different CLI flag. The v0.8.0 changes added 10 more branches (lines 151-199) for loop-specific flags (`--loop`, `--until`, `--eval`, `--strategy`, `--direction`, `--max-iterations`, `--max-failures`, `--cooldown`, `--eval-timeout`, `--continue-context`, `--git-branch`), pushing this function well past the 50-line threshold into critical territory at 146+ lines with cyclomatic complexity exceeding 30.
- Fix: Extract loop-specific flag parsing into a separate function. The loop validation block (lines 225-278) is already a distinct concern and can be extracted cleanly:
  ```typescript
  // Extract from parseScheduleCreateArgs:
  function parseLoopFlags(loopArgs: string[], i: number, next: string | undefined):
    Result<{ consumed: number; value: Partial<LoopRawFlags> }, string> { ... }

  function validateLoopConfig(flags: LoopRawFlags, promptWords: string[], ...):
    Result<ParsedLoopConfig, string> { ... }
  ```
  This would bring `parseScheduleCreateArgs` back to ~80 lines and isolate loop concerns.

**`handleLoopPaused` has 6 levels of nesting** - `src/services/handlers/loop-handler.ts:366`
**Confidence**: 88%
- Problem: The force-pause path (lines 394-438) reaches 6 levels of indentation: `handleEvent` callback > `if (force)` > `if (iterationsResult.ok && ...)` > `if (latestIteration.status === 'running')` > `if (latestIteration.taskId)` > `if (!cancelResult.ok)`. Plus a parallel 6-level branch for `if (latestIteration.pipelineTaskIds)` > `for` > `emit`. This exceeds the 4-level warning threshold and the critical 5+ threshold.
- Fix: Extract the force-cancel logic into a dedicated method:
  ```typescript
  private async forceCancelCurrentIteration(loopId: LoopId): Promise<void> {
    const iterationsResult = await this.loopRepo.getIterations(loopId, 1);
    if (!iterationsResult.ok || iterationsResult.value.length === 0) return;

    const latestIteration = iterationsResult.value[0];
    if (latestIteration.status !== 'running') return;

    // Mark iteration as cancelled
    await this.loopRepo.updateIteration({
      ...latestIteration,
      status: 'cancelled',
      completedAt: Date.now(),
    });

    // Cancel the in-flight task
    await this.cancelIterationTasks(loopId, latestIteration);
  }
  ```
  This reduces `handleLoopPaused` to 3 levels of nesting and makes the force-cancel path independently testable.

### MEDIUM

**`handleScheduleLoop` is 68 lines with object construction complexity** - `src/adapters/mcp-adapter.ts:2243`
**Confidence**: 82%
- Problem: The `handleScheduleLoop` method (lines 2243-2374 in the feature branch) builds two nested object literals (`loopConfig` at 15 fields, `request` at 8 fields) before calling the service. While the cyclomatic complexity is low (linear flow), the function is 68 lines long and the inline object construction reduces readability. This sits in the warning zone (50-200 lines).
- Fix: The Zod schema already validates the input. Map directly from `parseResult.data` to the request type using a small mapper function:
  ```typescript
  private buildScheduledLoopRequest(data: z.infer<typeof ScheduleLoopSchema>): ScheduledLoopCreateRequest {
    return {
      loopConfig: {
        prompt: data.prompt,
        strategy: data.strategy === 'retry' ? LoopStrategy.RETRY : LoopStrategy.OPTIMIZE,
        // ... remaining fields
      },
      scheduleType: data.scheduleType === 'cron' ? ScheduleType.CRON : ScheduleType.ONE_TIME,
      // ... remaining fields
    };
  }
  ```

**`handleLoopTrigger` has nested collision-detection block at 4 levels** - `src/services/handlers/schedule-handler.ts:492`
**Confidence**: 80%
- Problem: The collision detection block (lines 502-520) nests: `handleEvent` callback > `if (existingLoopsResult.ok)` > `if (activeLoops.length > 0)`. The method itself is 80 lines (lines 492-571), which is in the warning zone. The collision check is conceptually separate from the trigger execution path.
- Fix: Extract collision detection to a helper:
  ```typescript
  private async hasActiveLoopForSchedule(scheduleId: ScheduleId): Promise<boolean> {
    const result = await this.loopRepo.findByScheduleId(scheduleId);
    if (!result.ok) return false;
    return result.value.some(l => l.status === LoopStatus.RUNNING || l.status === LoopStatus.PAUSED);
  }
  ```

**`handleScheduleCancelled` cascade logic reaches 5 levels of nesting** - `src/services/handlers/schedule-handler.ts:704`
**Confidence**: 85%
- Problem: The cascade-cancel block (lines 724-750) reaches 5 levels: `handleEvent` > `if (scheduleResult.ok && ...)` > `if (loopsResult.ok)` > `for (const loop ...)` > `if (!cancelResult.ok)`. This is a new v0.8.0 addition and crosses the warning threshold.
- Fix: Extract cascade cancellation to a helper method:
  ```typescript
  private async cascadeCancelLoops(scheduleId: ScheduleId, reason: string): Promise<void> {
    const loopsResult = await this.loopRepo.findByScheduleId(scheduleId);
    if (!loopsResult.ok) return;

    const activeLoops = loopsResult.value.filter(
      l => l.status === LoopStatus.RUNNING || l.status === LoopStatus.PAUSED
    );
    for (const loop of activeLoops) {
      // ... cancel each
    }
  }
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`mcp-adapter.ts` file length: 2,515 lines** - `src/adapters/mcp-adapter.ts`
**Confidence**: 85%
- Problem: The file was already large before v0.8.0, but this PR adds ~290 lines (3 new handler methods, 3 new schemas, 3 new tool definitions), pushing total length to 2,515 lines. This is well past the critical 500-line file threshold per the complexity metrics (5x over). While this is partially a pre-existing concern, the PR contributes significantly.
- Fix: This is a known structural issue. The adapter could be split by domain (schedule tools, loop tools, task tools, agent tools) using a registration pattern. Not blocking, but the growth trajectory is concerning.

**`loop-handler.ts` file length: 1,437 lines** - `src/services/handlers/loop-handler.ts`
**Confidence**: 82%
- Problem: At 1,437 lines, this file is nearly 3x the 500-line critical threshold. The v0.8.0 changes add ~218 lines (pause/resume handlers, git branch logic). The git branch management (branch creation, diff capture) is a distinct concern mixed into the iteration engine.
- Fix: Extract git operations into a `LoopGitManager` utility class:
  ```typescript
  class LoopGitManager {
    async createIterationBranch(loop: Loop, iterationNumber: number): Promise<string | undefined> { ... }
    async captureIterationDiff(loop: Loop, iteration: LoopIteration): Promise<string | undefined> { ... }
  }
  ```
  This would remove ~50 lines from the handler and create a cohesive, testable git utility.

**`schedule-handler.ts` file length: 848 lines** - `src/services/handlers/schedule-handler.ts`
**Confidence**: 80%
- Problem: At 848 lines, this file exceeds the 500-line warning threshold. The v0.8.0 changes added ~132 lines for loop trigger handling and cascade cancellation.
- Fix: The three trigger paths (single-task, pipeline, loop) could each be in separate files or composed as strategy objects. Lower priority than the others.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`callTool` switch statement has 21 cases** - `src/adapters/mcp-adapter.ts:350`
**Confidence**: 90%
- Problem: The switch statement routing tool calls now has 21 cases (3 new from v0.8.0). While each case is a single line delegation, the switch itself has high cyclomatic complexity. This is a pre-existing pattern that grows with each feature.
- Impact: Each new tool adds a case. A tool registry pattern would scale better.

**`recoverSingleLoop` is 114 lines with 7 distinct code paths** - `src/services/handlers/loop-handler.ts:1323`
**Confidence**: 82%
- Problem: This pre-existing function handles 7 recovery scenarios (no iterations, terminal iteration/pass, terminal iteration/other, no task ID, task still running, task completed, task failed, task cancelled). At 114 lines, it is in the warning zone. The v0.8.0 changes did not modify this function, but `handleLoopResumed` now delegates to it, making it a more critical code path.
- Impact: Adding the resume path increases the importance of this function's correctness.

## Suggestions (Lower Confidence)

- **`scheduleCreate` three-way dispatch could use a strategy map** - `src/cli/commands/schedule.ts:372` (Confidence: 65%) -- The function dispatches to loop, pipeline, or task creation via sequential `if` blocks. A dispatch map keyed on `args.isLoop`/`args.isPipeline` would be cleaner but is a minor style concern.

- **`recordAndContinue` has 6 parameters** - `src/services/handlers/loop-handler.ts:984` (Confidence: 70%) -- This helper takes 6 positional parameters (loop, iteration, status, consecutiveFailures, loopUpdate, evalResult). An options object would improve call-site readability, but the function is only called from 4 well-documented sites within the same file.

- **`ScheduleLoopSchema` duplicates field definitions from `CreateLoopSchema`** - `src/adapters/mcp-adapter.ts:249` (Confidence: 68%) -- The Zod schema has 15 fields that overlap with `CreateLoopSchema`. A shared base schema with `.extend()` would reduce duplication, but Zod schemas are declarative and duplication is tolerable.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 3 | 0 |
| Pre-existing | 0 | 0 | 2 | 0 |

**Complexity Score**: 6/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Conditions

1. **Extract force-cancel logic** from `handleLoopPaused` to reduce nesting depth from 6 to 3 levels (HIGH severity).
2. **Extract loop-specific flag parsing** from `parseScheduleCreateArgs` to bring the function below 100 lines (HIGH severity).

### Positive Observations

- New handler methods (`handleLoopPaused`, `handleLoopResumed`, `pauseLoop`, `resumeLoop`) are well-structured with early returns and clear flow.
- `handleLoopResumed` elegantly reuses `recoverSingleLoop()` rather than duplicating recovery logic.
- Git branch management degrades gracefully (warning + continue) rather than failing loops when git operations fail.
- The `recordAndContinue` helper effectively consolidates what would otherwise be 5 separate iteration-result code paths.
- New domain types (`LoopPausedEvent`, `LoopResumedEvent`, `ScheduledLoopCreateRequest`) are well-defined and minimal.
