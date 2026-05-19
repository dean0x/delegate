# Consistency Review Report

**Branch**: feat-agent-eval-mode -> main
**Date**: 2026-03-30T12:14:00Z

## Issues in Your Changes (BLOCKING)

### HIGH

**Schema default inconsistency: `evalMode` has `.default('shell')` in `CreateLoopSchema` but not in `ScheduleLoopSchema`** - `src/adapters/mcp-adapter.ts:246` vs `src/adapters/mcp-adapter.ts:317`
**Confidence**: 92%
- Problem: `CreateLoopSchema` defines `evalMode` with `.optional().default('shell')`, but `ScheduleLoopSchema` defines the same field with only `.optional()` (no `.default()`). This means for `ScheduleLoop`, `data.evalMode` can be `undefined` at runtime, while for `CreateLoop` it is always `'shell'` or `'agent'`. Both schemas feed into the same `LoopCreateRequest` type, and both are cast with `as 'shell' | 'agent' | undefined`, so the downstream `createLoop` factory handles the undefined case. However, the schemas present different MCP tool descriptions to the caller -- `CreateLoop` implies a default, `ScheduleLoop` does not. This is a behavioral inconsistency between two tools that should behave identically for shared fields.
- Fix: Add `.default('shell')` to `ScheduleLoopSchema.evalMode` for parity:
  ```typescript
  // src/adapters/mcp-adapter.ts:317
  evalMode: z.enum(['shell', 'agent']).optional().default('shell').describe('Evaluation mode: shell command or agent review'),
  ```

**Orchestrator prompt documents invalid CLI syntax** - `src/services/orchestrator-prompt.ts:45`
**Confidence**: 90%
- Problem: The orchestrator prompt shell eval loop example shows `beat loop "<prompt>" --until "npm test" --strategy retry`, but the CLI parser at `src/cli/commands/loop.ts:209-210` rejects `--strategy` in shell eval mode with the error `'--strategy is only valid with --eval-mode agent'`. An orchestrator agent following this prompt will hit a validation error.
- Fix: Remove `--strategy retry` from the shell eval example since strategy is inferred from `--until` (retry) or `--eval` (optimize):
  ```typescript
  // src/services/orchestrator-prompt.ts:45
  beat loop "<prompt>" --until "npm test"
  ```

### MEDIUM

**Mixed repository field naming in `AgentExitConditionEvaluator`** - `src/services/agent-exit-condition-evaluator.ts:34-35`
**Confidence**: 82%
- Problem: The constructor uses `outputRepository` (full name) alongside `loopRepo` (abbreviated). Handler-level classes in this codebase consistently use the abbreviated `Repo` suffix (`loopRepo`, `taskRepo`, `checkpointRepo`, `dependencyRepo`), while manager-level services use the full `Repository` suffix (`loopRepository`, `scheduleRepository`). This evaluator is a service-level component injected alongside handlers, so the mixed naming breaks the established pattern.
- Fix: Rename to `outputRepo` for consistency with its sibling `loopRepo`:
  ```typescript
  constructor(
    private readonly eventBus: EventBus,
    private readonly outputRepo: OutputRepository,
    private readonly loopRepo: LoopRepository,
    private readonly logger: Logger,
  ) {}
  ```

**Stale-guard cleanup code duplicated verbatim (3 locations)** - `src/services/handlers/loop-handler.ts:294-296`, `313-315`, `324-326`
**Confidence**: 80%
- Problem: The three-line cleanup sequence (`cleanupPipelineTaskTracking`, `taskToLoop.delete`, `cleanupPipelineTasks`) is written identically in the two stale-guard early-return paths AND in the normal path. This violates the project's pattern of extracting repeated sequences (see PF-002, PF-003 resolutions). If cleanup logic changes, all three sites must be updated in lockstep.
- Fix: Extract a helper method:
  ```typescript
  private cleanupTaskTracking(iteration: LoopIteration, taskId: TaskId, loopId: LoopId): void {
    this.cleanupPipelineTaskTracking(iteration);
    this.taskToLoop.delete(taskId);
    this.cleanupPipelineTasks(loopId, iteration.iterationNumber);
  }
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Type assertion `as 'shell' | 'agent' | undefined` used instead of Zod inference** - `src/adapters/mcp-adapter.ts:2181`, `src/adapters/mcp-adapter.ts:2512`
**Confidence**: 82%
- Problem: The `evalMode` field is defined with `z.enum(['shell', 'agent'])` in the schema, which gives Zod full type information. Yet when constructing `LoopCreateRequest`, the code casts with `as 'shell' | 'agent' | undefined` rather than relying on `z.infer`. This is inconsistent with how `strategy` is handled on the same line (mapped via enum, not cast). Similarly, `loop-repository.ts:609` uses `as 'shell' | 'agent'`. These raw casts bypass type safety and would silently pass if a new mode were added to the enum but not the cast.
- Fix: For MCP adapter, since `CreateLoopSchema` has `.default('shell')`, the inferred type is already `'shell' | 'agent'` (never undefined). Remove the cast and let TypeScript infer. For the repository, consider using a Zod parse or a type guard for the `eval_mode` string from the database row.

**`LoopRowSchema.exit_condition` changed from `.min(1)` to empty string allowed** - `src/implementations/loop-repository.ts:360`
**Confidence**: 80%
- Problem: The `LoopRowSchema` previously enforced `z.string().min(1)` for `exit_condition`, matching the invariant that shell mode requires a non-empty command. Now it allows empty strings to accommodate agent mode. However, this weakens the schema validation for ALL rows, not just agent mode rows. A corrupted shell-mode row with an empty `exit_condition` would silently pass validation and fail only at runtime when exec is called.
- Fix: Consider a discriminated refinement, or add a comment documenting that empty `exit_condition` is valid only for `evalMode === 'agent'`. At minimum, the existing approach is acceptable given that `LoopManagerService.createLoop()` validates this at the service boundary.

## Pre-existing Issues (Not Blocking)

No pre-existing issues found meeting the confidence threshold.

## Suggestions (Lower Confidence)

- **Test boilerplate repetition in `agent-exit-condition-evaluator.test.ts`** - `tests/unit/services/agent-exit-condition-evaluator.test.ts` (Confidence: 72%) -- The `vi.spyOn(eventBus, 'emit')` + `capturedEvalTaskId` + `await new Promise(setImmediate)` + `simulateEvalTaskComplete` pattern is copy-pasted across 12+ tests. A shared helper would reduce noise (e.g., `evaluateWithCompletion(evaluator, loop, taskId, simulateFn)`).

- **`buildEvalPrompt` uses mutable `let` for `preIterationCommitSha`** - `src/services/agent-exit-condition-evaluator.ts:125` (Confidence: 65%) -- The project's CLAUDE.md mandates "immutable by default." The `let preIterationCommitSha` could be refactored to a `const` by extracting the iteration lookup into a separate expression.

- **`ScheduleLoopSchema` and `CreateLoopSchema` duplicate 12+ shared loop fields** - `src/adapters/mcp-adapter.ts:234-270` vs `src/adapters/mcp-adapter.ts:308-335` (Confidence: 60%) -- These schemas share most loop config fields but are defined independently. Extracting a shared `LoopConfigFields` schema and spreading into both would reduce duplication and prevent future drift (as demonstrated by the `evalMode` default inconsistency found above).

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Consistency Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The feature introduces a well-structured agent eval mode following existing patterns (Strategy, Composite, DI). The main consistency gaps are the schema default divergence between `CreateLoop` and `ScheduleLoop`, and an orchestrator prompt example that references CLI syntax the parser rejects. Both are straightforward to fix.
