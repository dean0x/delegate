# Architecture Review Report

**Branch**: feat-v1.4.0-reliability-eval-redesign -> main
**Date**: 2026-04-14T15:37:00Z
**PR**: #136
**Commits**: 20 (a6e13d4..33abbb7)

## Issues in Your Changes (BLOCKING)

### HIGH

**Timeout disabled by default breaks safety contract** - `src/core/configuration.ts:20`
**Confidence**: 88%
- Problem: The default timeout was changed from 1800000ms (30min) to 0 (disabled) with max raised from 3.6M to 86.4M (24hr). The inline comment says "tasks run 2.5+ hours; timeout was killing them" but the prior design was an intentional safety boundary documented in the schema with "SECURITY: max 1 hour". Disabling timeout by default removes a safety net against runaway processes consuming unbounded resources. The Zod schema min changed from 1000 to 0 meaning no timeout validation at the boundary for client-provided values.
- Fix: Keep timeout default at 0 for operational convenience, but restore min validation to prevent negative values being silently accepted. More importantly, add a `maxTaskDuration` safety ceiling (e.g., 24h) that is always enforced even when user timeout is 0, to prevent indefinite resource consumption. The DEFAULT_CONFIG object was also removed entirely -- this removes the documented fallback constants that served as documentation for operators.

```typescript
// Suggestion: separate "user timeout" (can be 0=disabled) from "safety ceiling"
timeout: z.number().min(0).max(86400000).default(0),
// Add a separate non-disablable safety ceiling
maxTaskDurationMs: z.number().min(3600000).max(172800000).default(86400000), // 24h hard ceiling
```

**DEFAULT_CONFIG constant removed without replacement** - `src/core/configuration.ts:62-84`
**Confidence**: 82%
- Problem: The `DEFAULT_CONFIG` const object was deleted. While Zod `.default()` provides the same runtime defaults, the explicit constant served as human-readable documentation of all default values in one place, referenced by comments throughout the codebase. Its removal reduces discoverability of the configuration surface.
- Fix: If the constant was truly redundant with Zod defaults, this is acceptable -- but verify no code references `DEFAULT_CONFIG` at runtime. If purely documentary, consider adding a comment block listing all defaults in one place.

### MEDIUM

**Double-completion risk in handleRetryResult `decision='stop'` path** - `src/services/handlers/loop-handler.ts:852-874`
**Confidence**: 85%
- Problem: When `evalResult.decision === 'stop'`, the handler runs a transaction to update iteration status and loop status to COMPLETED, then calls `completeLoop()` again on line 873. `completeLoop()` writes the loop status a second time and emits `LoopCompleted`. This double-write is noted as "harmless" elsewhere in the codebase (line 907 comment), but the `decision='stop'` path does not have that comment, and the atomic transaction already set status to COMPLETED. The double `update` call is at minimum wasteful.
- Fix: After the transaction succeeds, only call the cleanup portion of `completeLoop` (clear timer, emit event) rather than re-writing the loop status. Or extract a `completeLoopPostCommit` helper that only handles timer cleanup and event emission.

**`spawn()` positional parameter list growing beyond readability** - `src/core/agents.ts:248-254`, `src/implementations/base-agent-adapter.ts:133-139`
**Confidence**: 82%
- Problem: `AgentAdapter.spawn()` now takes 6 positional parameters (`prompt, workingDirectory, taskId?, model?, orchestratorId?, jsonSchema?`). This exceeds the conventional 3-4 parameter threshold for positional arguments. Each addition increases the risk of argument order mistakes, especially with multiple optional string parameters.
- Fix: Refactor to an options object pattern for the optional parameters:

```typescript
spawn(
  prompt: string,
  workingDirectory: string,
  options?: {
    taskId?: string;
    model?: string;
    orchestratorId?: string;
    jsonSchema?: string;
  },
): Result<{ process: ChildProcess; pid: number }>;
```

This is a breaking change to the AgentAdapter interface, so it should be coordinated in this PR since the interface is already being modified.

**Duplicated prompt-building logic across three evaluators** - `src/services/agent-exit-condition-evaluator.ts:158-203`, `src/services/feedforward-evaluator.ts:128-157`, `src/services/judge-exit-condition-evaluator.ts:249-278`
**Confidence**: 85%
- Problem: Three evaluators (AgentExitConditionEvaluator, FeedforwardEvaluator, JudgeExitConditionEvaluator) each contain nearly identical `buildEvalPrompt` / `buildFindingsPrompt` methods that: (1) look up preIterationCommitSha from the iteration record, (2) build git diff instructions, (3) build tool instructions, (4) assemble the prompt with criteria. The extract-to-function pattern was applied to `waitForEvalTaskCompletion` (eval-task-waiter.ts) but not to prompt building.
- Fix: Extract a shared `buildEvalPromptBase(loop, taskId, loopRepo)` function that returns the common sections (git instructions, tool instructions, iteration metadata). Each evaluator can then wrap the result with its strategy-specific header and format directive.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Schedule executor PID file race window remains despite comment** - `src/cli/commands/schedule-executor.ts:10-11,65-70`
**Confidence**: 80%
- Problem: The comment acknowledges a PID file race ("PID file race is benign -- per-schedule dedup in ScheduleExecutor prevents double execution even if two executors start simultaneously") but the code between `readExecutorPid()` and the `spawn()` call has no locking. Two concurrent `ensureScheduleExecutorRunning()` calls can both see a stale PID, both spawn, and both write their PID -- the last writer wins, leaving one executor as an orphan with no PID tracking. While double execution is prevented by ScheduleExecutor dedup, the orphan process will never be cleaned up by the PID-based liveness check.
- Fix: Use an advisory lock file (`schedule-executor.lock`) with `O_EXCL` create or use the PID file itself as a lock with `wx` flag during the spawn window. Alternatively, document the orphan lifetime (it self-exits after 5 minutes of no active schedules via the idle check).

**`buildArgs` ignores jsonSchema parameter with eslint-disable comment** - `src/implementations/codex-adapter.ts:19-21`, `src/implementations/gemini-adapter.ts:19-21`
**Confidence**: 80%
- Problem: CodexAdapter and GeminiAdapter accept `_jsonSchema` with `@typescript-eslint/no-unused-vars` suppression. This is a code smell for ISP (Interface Segregation Principle) -- adapters are forced to accept a parameter they cannot use. The eslint-disable comments will accumulate as more adapter-specific capabilities are added (e.g., tool use flags, streaming modes).
- Fix: This is mitigated by the options-object refactoring suggested above for `spawn()`. With an options bag, adapters simply ignore keys they don't support without needing unused parameters or eslint overrides.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`as` casts on eval_type and judge_agent bypass Zod validation** - `src/implementations/loop-repository.ts:686-687`
**Confidence**: 82%
- Problem: `rowToLoop` casts `data.eval_type as EvalType` and `data.judge_agent as Loop['judgeAgent']` after Zod parse, but the Zod schema only validates these as `z.string().nullable().optional()` -- it does not constrain the string value to the `EvalType` enum or `AgentProvider` union. A corrupted DB row with `eval_type = 'bogus'` passes Zod and enters the domain unchecked. This is consistent with PF-005 (pitfall: "Repository read paths must use Zod, not `as` casts") -- the new v1.4.0 fields repeat the same pattern.
- Fix: Add enum validation in the Zod schema:

```typescript
eval_type: z.enum(['feedforward', 'judge', 'schema']).nullable().optional(),
judge_agent: z.enum(AGENT_PROVIDERS_TUPLE).nullable().optional(),
```

## Suggestions (Lower Confidence)

- **Feedback accumulation 8KB cap uses string length, not byte length** - `src/services/handlers/loop-handler.ts:1492` (Confidence: 70%) -- The cap is documented as "8KB" but uses `entry.length` (character count), not `Buffer.byteLength`. For multi-byte content this could exceed 8KB. Related to PF-002.

- **Judge evaluator defaults to `continue: true` on all failure paths** - `src/services/judge-exit-condition-evaluator.ts:208,218,243` (Confidence: 65%) -- While documented as "safe fallback", this means a misconfigured judge (wrong agent, bad prompt) will silently run to maxIterations instead of surfacing the configuration error. Consider returning an error result instead for emission failures (line 208), while keeping the default-continue for ambiguous decision parsing.

- **Schedule executor process stays alive via `process.stdin.resume()`** - `src/cli/commands/schedule-executor.ts:152` (Confidence: 60%) -- Using `stdin.resume()` to keep a background process alive is unconventional. The idleCheckTimer with `.unref()` combined with stdin resume creates a subtle interaction: the process stays alive because of stdin, not because of the timer. Consider using a simple `setInterval(() => {}, 60000)` keep-alive pattern that is more explicit about intent.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | - | 2 | 2 | - |
| Should Fix | - | - | 2 | - |
| Pre-existing | - | - | 1 | - |

**Architecture Score**: 7/10

The eval redesign follows strong patterns: Strategy pattern for evaluators, Composite pattern for routing, extracted shared utilities (eval-task-waiter), proper DI (FsAdapter injection in JudgeEvaluator), and consistent use of the event-driven architecture. The two-level eval hierarchy (evalMode + evalType) is well-documented with DECISION/ARCHITECTURE comments. Migration v21 is clean and backward-compatible. Validation constraints in LoopManager correctly enforce evalType/agent compatibility.

Deductions: (1) The spawn() positional parameter list is growing past readability -- an options object would be cleaner. (2) Prompt-building logic is duplicated across three evaluators despite eval-task-waiter proving the extraction pattern works. (3) The timeout default change removes a safety boundary without adding a replacement ceiling.

**Recommendation**: CHANGES_REQUESTED
