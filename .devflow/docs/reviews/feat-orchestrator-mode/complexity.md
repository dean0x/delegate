# Complexity Review Report

**Branch**: feat/orchestrator-mode -> main
**Date**: 2026-03-27
**PR**: #123
**Files Changed**: 51 (+4206, -703)

## Issues in Your Changes (BLOCKING)

### HIGH

**`handleOrchestrateForeground` is 116 lines with 10+ branches and 4-level nesting** - `src/cli/commands/orchestrate.ts:214-330`
**Confidence**: 88%
- Problem: This function performs bootstrap, service resolution, orchestration creation, event bus subscription, SIGINT handling, and completion waiting -- all in one function. It is 116 lines with ~10 decision branches (5 early-exit `if (!result.ok)` checks, `if (!orchestration.loopId)`, `if (!eventBusResult.ok)`, the inner `if (resolved)` guard, and the `if (exitCode === 0)` branch). Nesting reaches 4 levels inside the `new Promise` callback with `eventBus.subscribe` callbacks. The `try` block wraps the entire function body, and the Promise constructor callback at line 274 contains nested closures over `resolved`, `subscriptionIds`, and `sigintHandler`.
- Impact: Exceeds the 50-line function threshold (CRITICAL per complexity patterns). The nested Promise callback with event subscriptions and SIGINT handling is the hardest part to follow. Future modifications to the event subscription logic require understanding the entire function context.
- Fix: Extract the event-waiting logic into a helper function:
  ```typescript
  function waitForLoopCompletion(
    eventBus: EventBus,
    loopId: LoopId,
    service: OrchestrationService,
    orchestrationId: OrchestratorId,
  ): Promise<number> {
    return new Promise<number>((resolve) => {
      let resolved = false;
      const subscriptionIds: string[] = [];
      const cleanup = () => { for (const id of subscriptionIds) eventBus.unsubscribe(id); };
      const resolveOnce = (code: number) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve(code);
      };
      const sigintHandler = () => {
        process.stderr.write('\nCancelling orchestration...\n');
        service.cancelOrchestration(orchestrationId, 'User interrupted (SIGINT)');
      };
      process.on('SIGINT', sigintHandler);
      // ... subscriptions ...
    });
  }
  ```
  This would reduce `handleOrchestrateForeground` from 116 to ~60 lines and nesting from 4 to 2.

**`parseOrchestrateCreateArgs` has 12 decision branches with repeated pattern** - `src/cli/commands/orchestrate.ts:76-139`
**Confidence**: 82%
- Problem: The `for` loop body contains 8 `if/else if` branches: 6 flag handlers (each with inner validation), 1 unknown-flag check, and 1 goal-word accumulator. Cyclomatic complexity is ~14 (loop + 7 if/else-if + validation early returns). The pattern `const next = args[i + 1]; const val = parseInt(next, 10); if (isNaN(val) || val < N || val > M)` is duplicated 3 times for `--max-depth`, `--max-workers`, and `--max-iterations`.
- Impact: Exceeds the cyclomatic complexity warning threshold of 10. Each new flag adds another branch. The repeated numeric validation is fragile -- adding a new numeric flag requires duplicating the exact pattern.
- Fix: Extract a `parseIntFlag` helper to deduplicate the numeric flag parsing:
  ```typescript
  function parseIntFlag(args: readonly string[], i: number, name: string, min: number, max: number):
    Result<{ value: number; nextIndex: number }, string> {
    const next = args[i + 1];
    const val = parseInt(next, 10);
    if (isNaN(val) || val < min || val > max) return err(`${name} must be ${min}-${max}`);
    return ok({ value: val, nextIndex: i + 1 });
  }
  ```
  This eliminates 3 repeated blocks and reduces branches from 12 to 9.

### MEDIUM

**`createOrchestration` is 149 lines with 8 error-return points** - `src/services/orchestration-manager.ts:58-207`
**Confidence**: 83%
- Problem: The method has 4 phases (validation, state setup, DB persist, loop creation + update) with 8 distinct error-return points. At 149 lines it exceeds the 50-line warning threshold by 3x. While the method is linearly structured with clear comment-header sections and reads well top-to-bottom, its length makes it a maintenance concern.
- Impact: The function is readable due to linear flow and clear section markers, but the state file setup section (lines 99-122) is a self-contained unit that would benefit from extraction.
- Fix: Extract state file setup into a private method:
  ```typescript
  private setupStateFiles(goal: string): Result<{ stateFilePath: string; exitConditionScript: string }> {
    try {
      const stateDir = getStateDir();
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const stateFileName = `state-${Date.now()}-${crypto.randomUUID().substring(0, 8)}.json`;
      const stateFilePath = path.join(stateDir, stateFileName);
      writeStateFile(stateFilePath, createInitialState(goal));
      const exitConditionScript = writeExitConditionScript(stateDir, stateFilePath);
      return ok({ stateFilePath, exitConditionScript });
    } catch (error) { /* ... */ }
  }
  ```
  This would bring `createOrchestration` down to ~100 lines.

**`cleanupOldOrchestrations` constructs SQL dynamically in a loop** - `src/implementations/orchestration-repository.ts:209-237`
**Confidence**: 80%
- Problem: The cleanup method builds `DELETE ... WHERE id IN (${placeholders})` dynamically inside a batched loop within `db.transaction`. This mixes string construction with database operations, deviating from the rest of the repository's clean prepared-statement pattern. The batch loop with `db.prepare` inside `db.transaction` adds unnecessary complexity.
- Impact: Harder to follow than the rest of the repository. While safe (parameterized query), it is inconsistent with the prepared-statement pattern used everywhere else.
- Fix: Use the existing `this.deleteStmt` in a transaction:
  ```typescript
  const deleteInTransaction = this.db.transaction((ids: readonly string[]) => {
    for (const id of ids) {
      this.deleteStmt.run(id);
    }
  });
  ```
  This is simpler, consistent with the repository pattern, and cleanup performance is not critical.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`handleToolCall` switch statement now has 26 branches** - `src/adapters/mcp-adapter.ts:383-445`
**Confidence**: 82%
- Problem: This PR adds 4 more cases to an already-large switch statement. While each case is a clean 1-line dispatch (good), the method's cyclomatic complexity is now 27 (26 cases + default). The switch itself is 60 lines long.
- Impact: Pre-existing structural issue incrementally worsened by this PR. Each feature adds more branches.
- Fix: Refactor to a dispatch map:
  ```typescript
  private readonly toolHandlers: Record<string, (args: unknown) => Promise<MCPToolResponse>> = {
    DelegateTask: (args) => this.handleDelegateTask(args),
    // ...
  };
  ```
  Not blocking since this is a pre-existing pattern. Consider for tech debt cleanup.

**`setupEventHandlers` is 170+ lines with sequential error handling** - `src/services/handler-setup.ts:213-385`
**Confidence**: 80%
- Problem: This function creates 8 handlers (7 previously + new OrchestrationHandler) with cleanup-on-failure at each step. The sequential create-check-cleanup pattern is repeated 5 times for factory-pattern handlers, now including the new OrchestrationHandler block (lines 355-381). Function is ~170 lines.
- Impact: Pre-existing pattern issue incrementally worsened. Each new handler adds ~15 lines of boilerplate.
- Fix: Extract a helper that encapsulates the create-check-cleanup pattern. Not blocking.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`mcp-adapter.ts` is 2875 lines** - `src/adapters/mcp-adapter.ts`
**Confidence**: 80%
- Problem: The file was already well above the 500-line CRITICAL threshold. This PR adds 380 lines (4 Zod schemas, 4 tool definitions, 4 handler methods). It now contains 26 `handleX` methods. While each handler is individually clean (15-40 lines), the file as a whole is 5.75x the critical threshold.
- Impact: Navigation and maintenance are increasingly difficult. Each feature addition exacerbates the issue.
- Fix: Split tool handlers into domain-specific modules (task, schedule, loop, orchestrator) that the adapter delegates to. Not blocking -- pre-existing issue.

## Suggestions (Lower Confidence)

- **Magic number 5 for `maxConsecutiveFailures`** - `src/services/orchestration-manager.ts:157` (Confidence: 68%) -- The `maxConsecutiveFailures: 5` in the loop creation is hardcoded. Consider extracting as `ORCHESTRATOR_MAX_CONSECUTIVE_FAILURES = 5` or making it configurable.

- **Repeated error-response boilerplate in MCP handlers** - `src/adapters/mcp-adapter.ts:2567-2775` (Confidence: 65%) -- Each of the 4 new orchestrator handlers repeats the same pattern: guard service, parse Zod, match ok/err. A `wrapHandler(service, schema, fn)` HOF could reduce each to ~10 lines. Pre-existing pattern across all handlers.

- **`orchestrate.ts` file is 516 lines** - `src/cli/commands/orchestrate.ts` (Confidence: 70%) -- Exceeds the 500-line WARNING threshold. Consider splitting arg parsing or subcommand handlers into separate modules if more subcommands are added.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Complexity Score**: 7/10

The new orchestration feature introduces well-structured code that follows established project patterns (Result types, event-driven handlers, repository pattern, immutable domain objects, factory functions). The dependency-injection refactoring (positional args to deps objects) is a clear complexity improvement -- it eliminates parameter-order bugs across 8 constructors. The detach-mode extraction into `detach-helpers.ts` is a good deduplication of previously inline logic from `run.ts`. Domain types, repository, handler, prompt builder, and state file management are all clean and well-separated. The two HIGH findings are concentrated in `orchestrate.ts` where `handleOrchestrateForeground` exceeds both length and nesting thresholds, and `parseOrchestrateCreateArgs` has high cyclomatic complexity with repeated patterns. No CRITICAL complexity issues were found.

**Recommendation**: APPROVED_WITH_CONDITIONS

Conditions:
1. Extract the event-waiting logic from `handleOrchestrateForeground` into a helper function to reduce its length below 80 lines and nesting below 3 levels.
2. The remaining MEDIUM and Should-Fix findings are recommended improvements but not blocking.
