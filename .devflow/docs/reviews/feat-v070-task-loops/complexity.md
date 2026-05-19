# Complexity Review Report

**Branch**: feat/v070-task-loops -> main
**Date**: 2026-03-21
**PR**: #110

## Issues in Your Changes (BLOCKING)

### HIGH

**`handleLoopCreate` CLI function is 187 lines with high cyclomatic complexity** - `src/cli/commands/loop.ts:37-223`
**Confidence**: 90%
- Problem: The `handleLoopCreate` function spans 187 lines (critical threshold: >50). It contains a 14-branch `else if` chain for argument parsing (lines 53-137), followed by post-parsing validation logic and the service call. The argument parsing loop alone has 14 separate flag handlers, each with inline validation and `process.exit(1)` calls. Cyclomatic complexity is approximately 25+ due to the number of branches and nested conditionals.
- Impact: Difficult to test individual flag parsing in isolation. Adding a new flag requires modifying a long chain. Validation logic is interleaved with parsing, making it hard to reason about what happens when.
- Fix: Extract the argument parsing loop into a dedicated function that returns a typed options object (or early-exits on error). This separates parsing from business logic. The pattern already exists in the codebase for `schedule.ts`.

```typescript
interface LoopCreateOptions {
  prompt?: string;
  untilCmd?: string;
  evalCmd?: string;
  direction?: 'minimize' | 'maximize';
  maxIterations?: number;
  // ... other fields
}

function parseLoopCreateArgs(loopArgs: string[]): LoopCreateOptions {
  // argument parsing loop here
}

async function handleLoopCreate(loopArgs: string[]): Promise<void> {
  const opts = parseLoopCreateArgs(loopArgs);
  // validation and service call here (~40 lines)
}
```

---

**`recoverStuckLoops` has 5-level nesting depth** - `src/services/handlers/loop-handler.ts:1017-1105`
**Confidence**: 92%
- Problem: This 89-line method has nesting reaching 5 levels deep: `for > if > if > if > if/else if/else` (lines 1024-1097). The inner block starting at line 1060 (`if (isTerminalState(task.status))`) contains a 3-way branch (`COMPLETED` / `FAILED` / `CANCELLED`), each with its own logic. The `FAILED` branch adds a further nested condition for `maxConsecutiveFailures`.
- Impact: The deep nesting makes it hard to follow the control flow, especially during code review. Each nesting level adds cognitive load. Recovery logic is critical path code that must be correct.
- Fix: Extract the inner recovery logic into a helper method `recoverStuckIteration(loop, latestIteration)` to flatten the nesting. Use early returns for guard clauses.

```typescript
private async recoverStuckIteration(loop: Loop, iteration: LoopIteration): Promise<void> {
  if (iteration.status !== 'running') return; // already terminal

  if (!iteration.taskId) {
    await this.loopRepo.updateIteration({ ...iteration, status: 'cancelled', completedAt: Date.now() });
    return;
  }

  const taskResult = await this.taskRepo.findById(iteration.taskId);
  if (!taskResult.ok || !taskResult.value) return;

  const task = taskResult.value;
  if (!isTerminalState(task.status)) return; // still running

  if (task.status === TaskStatus.COMPLETED) {
    const evalResult = this.evaluateExitCondition(loop, task.id);
    await this.handleIterationResult(loop, iteration, evalResult);
    return;
  }

  if (task.status === TaskStatus.FAILED) {
    // handle failed recovery...
    return;
  }

  // CANCELLED
  await this.loopRepo.updateIteration({ ...iteration, status: 'cancelled', completedAt: Date.now() });
}
```

---

**`handleTaskTerminal` method is 97 lines with interleaved concerns** - `src/services/handlers/loop-handler.ts:172-268`
**Confidence**: 85%
- Problem: The `handleTaskTerminal` method handles two distinct code paths (task failed vs. task completed) in a single 97-line method. The "task failed" branch (lines 220-255) duplicates the consecutive failure check logic that also exists in `checkTerminationConditions`. The method performs 6 distinct operations: loop lookup, status check, iteration lookup, failure handling, exit condition evaluation, and cleanup.
- Impact: The method is on the edge of being hard to follow in one reading. The duplicated consecutive failure logic in the "task failed" branch (lines 234-248) vs. the shared `recordAndContinue` path creates a maintenance risk where the two paths could drift apart.
- Fix: Consider routing the "task failed" path through `recordAndContinue` as well (similar to how `handleRetryResult` handles it), which would eliminate the duplicate maxConsecutiveFailures check and reduce the method by ~15 lines. The task failed case in `handleTaskTerminal` currently bypasses `recordAndContinue` and does its own update/check/schedule cycle.

### MEDIUM

**`LoopHandler` class is 1,106 lines** - `src/services/handlers/loop-handler.ts:1-1106`
**Confidence**: 88%
- Problem: The file is 1,106 lines, well above the 500-line critical threshold. While the class is well-organized into sections (event handlers, iteration engine, exit condition, helpers, recovery), the sheer size makes navigation difficult. Individual methods are mostly reasonable (the largest are flagged above), but the aggregate is a large single-class file.
- Impact: As the loop feature grows, this file will become harder to maintain. Merge conflicts are more likely when multiple developers touch it.
- Fix: No immediate action required since the internal structure is clear and methods are reasonably decomposed. For future work, consider extracting the recovery logic (lines 987-1105) into a separate `LoopRecoveryManager` class, and potentially the exit condition evaluation (lines 571-627) into a standalone `ExitConditionEvaluator` utility. This would bring the handler down to ~800 lines.

---

**`LoopManagerService.createLoop` validation block is 166 lines** - `src/services/loop-manager.ts:52-217`
**Confidence**: 82%
- Problem: The `createLoop` method is 166 lines, with ~130 lines devoted to sequential input validation checks (lines 58-178). Each validation follows the same pattern: check condition, return `err(new AutobeatError(...))`. While each individual check is simple, the repetitive pattern makes the method long.
- Impact: Adding new fields requires adding more validation blocks, growing the method further. The pattern is consistent with the project's validation approach, but the length is at the boundary of maintainability.
- Fix: Consider extracting the validation block into a private `validateCreateRequest(request)` method that returns `Result<void>`. This separates validation from domain object construction and event emission, making each method more focused. The ScheduleManager follows a similar pattern; both could benefit from this extraction.

---

**`mcp-adapter.ts` growing to 2,233 lines** - `src/adapters/mcp-adapter.ts`
**Confidence**: 80%
- Problem: The MCP adapter has grown from 1,776 to 2,233 lines with this PR (+457 lines). It was already above the 500-line critical threshold before this change. The file now contains tool definitions, request handlers, and response formatting for 18 tools.
- Impact: This is a pre-existing structural concern amplified by this PR. Each new feature adds ~100-150 lines of tool definitions + handlers. The file will become increasingly unwieldy.
- Fix: This is informational for this PR since the mcp-adapter structure is pre-existing. For future work, consider splitting tool handlers into separate files grouped by domain (task tools, schedule tools, loop tools, agent tools), with the adapter acting as a thin router.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`extractHandlerDependencies` is 60 lines of repetitive Result unwrapping** - `src/services/handler-setup.ts:108-167`
**Confidence**: 80%
- Problem: This function extracts 13 dependencies from the container, each with 2 lines of code (call + error check). The pattern is identical for all 13: `const xResult = getDependency<T>(container, 'x'); if (!xResult.ok) return xResult;`. With the addition of `loopRepository` as the 13th dependency, this function is now 60 lines of boilerplate.
- Impact: Low immediate risk since the pattern is clear, but each new handler adds 2 more lines. The function is hard to scan because every block looks identical.
- Fix: Consider a batch extraction pattern where dependencies are declared as a list and extracted in a loop, with fail-fast on the first error. This is a minor refactor that would reduce the function to ~15 lines. However, this would lose the individual type annotations, so it may not be worth the tradeoff.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`mcp-adapter.ts` tool routing switch statement has 18 cases** - `src/adapters/mcp-adapter.ts:309-355`
**Confidence**: 85%
- Problem: The `setupHandlers` method contains a switch statement with 18 case branches for tool routing. Each new feature adds more cases. This is a pre-existing pattern that was at 14 cases before this PR.
- Impact: The switch is growing but each case is a single line (delegation to a handler method), so the cognitive complexity per-case is minimal. The real concern is that adding tools requires modifying 3 places: the switch, the tool definition list, and the handler method.
- Fix: Consider a registry pattern where tools are registered with their handler functions, eliminating the switch entirely. This is a larger refactor best done in a separate PR.

## Suggestions (Lower Confidence)

- **`recordAndContinue` has 6 parameters** - `src/services/handlers/loop-handler.ts:868-904` (Confidence: 70%) -- The method takes 6 parameters which is at the warning threshold. Consider grouping `evalResult` fields into the existing `EvalResult` type rather than passing them separately.

- **`startPipelineIteration` mixes computation with DB writes** - `src/services/handlers/loop-handler.ts:469-559` (Confidence: 65%) -- The method creates tasks, runs a transaction, tracks state, and emits events. These are well-commented phases, but the method is 91 lines. The comment "Pre-create ALL task domain objects OUTSIDE transaction (pure computation)" suggests the author already recognizes the mixed concerns.

- **`handleLoopGet` display formatting is interleaved with data access** - `src/cli/commands/loop.ts:290-363` (Confidence: 62%) -- The function mixes repository calls with UI formatting. Extracting a `formatLoopDetails(loop)` function would improve testability, though the current structure is consistent with other CLI commands.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 3 | 3 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Complexity Score**: 6/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The v0.7.0 loop feature introduces significant new code (~5,700 lines across 30 files) with generally good internal structure. The code is well-organized with clear section comments, consistent use of the Result pattern, and good method decomposition for most functions. However, three specific areas exceed complexity thresholds: the CLI argument parser (187 lines, ~25 cyclomatic complexity), the recovery method (5-level nesting), and the task terminal handler (duplicated failure logic). These should be addressed before merge to maintain the codebase's overall maintainability. The remaining MEDIUM findings are at the boundary of acceptable complexity and could be deferred to a follow-up.
