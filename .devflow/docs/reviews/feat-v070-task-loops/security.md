# Security Review Report

**Branch**: feat/v070-task-loops -> main
**Date**: 2026-03-21
**PR**: #110
**Reviewer Focus**: Security vulnerability detection (injection, auth, crypto, business logic)

## Issues in Your Changes (BLOCKING)

### HIGH

**Undefined taskId emitted to TaskCancellationRequested event** - `src/services/loop-manager.ts:278`
**Confidence**: 95%
- Problem: When `cancelLoop()` is called with `cancelTasks: true`, it iterates running iterations and emits `TaskCancellationRequested` with `iteration.taskId`. However, `LoopIteration.taskId` is typed as `taskId?: TaskId` (optional) -- it can be `undefined` when the associated task has been cleaned up via `ON DELETE SET NULL`. The `TaskCancellationRequestedEvent` interface requires `taskId: TaskId` (non-optional). Emitting an event with `taskId: undefined` will cause downstream handlers to attempt operations on an undefined task ID, potentially causing unhandled errors or silent failures.
- Fix:
```typescript
// In src/services/loop-manager.ts, around line 276-289
const runningIterations = iterationsResult.value.filter(
  (i) => i.status === 'running' && i.taskId !== undefined
);
for (const iteration of runningIterations) {
  const cancelResult = await this.eventBus.emit('TaskCancellationRequested', {
    taskId: iteration.taskId!, // Safe: filtered above
    reason: `Loop ${loopId} cancelled`,
  });
```

### MEDIUM

**No upper bound on evalTimeout allows resource exhaustion** - `src/services/loop-manager.ts:132-140`, `src/adapters/mcp-adapter.ts:213`
**Confidence**: 85%
- Problem: The `evalTimeout` validation enforces a minimum of 1000ms but no maximum. A caller could set `evalTimeout` to `Number.MAX_SAFE_INTEGER` or a very large value (e.g., 86400000000 -- 1000 days), causing `execSync` to block the event loop for an extremely long period per iteration. The existing `DelegateTask` tool enforces a 24-hour maximum for task timeouts. The `evalTimeout` should have a similar upper bound.
- Fix: Add an upper bound in `loop-manager.ts` validation and in the MCP Zod schema:
```typescript
// In loop-manager.ts, after the min check:
if (request.evalTimeout !== undefined && request.evalTimeout > 300000) {
  return err(
    new AutobeatError(ErrorCode.INVALID_INPUT, 'evalTimeout must be <= 300000ms (5 minutes)', {
      field: 'evalTimeout',
      value: request.evalTimeout,
    }),
  );
}

// In mcp-adapter.ts CreateLoopSchema:
evalTimeout: z.number().min(1000).max(300000).optional().default(60000),
```

**execSync blocks the main event loop during exit condition evaluation** - `src/services/handlers/loop-handler.ts:580`
**Confidence**: 82%
- Problem: `evaluateExitCondition()` uses `child_process.execSync()` which blocks the Node.js event loop for the entire duration of the exit condition script execution (up to `evalTimeout` ms). While the timeout prevents indefinite blocking, a 60-second default timeout means all event processing, task completion handling, and other loop iterations are paused. This is a denial-of-service vector: a malicious or slow exit condition can freeze the entire server. Using `execFile` (async) or `child_process.exec` with a callback/promise would allow the event loop to continue processing.
- Fix: Replace `execSync` with async `exec` wrapped in a Promise:
```typescript
import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);

private async evaluateExitCondition(loop: Loop, taskId: TaskId): Promise<EvalResult> {
  try {
    const { stdout } = await execAsync(loop.exitCondition, {
      cwd: loop.workingDirectory,
      timeout: loop.evalTimeout,
      encoding: 'utf-8',
      env: { ...process.env, AUTOBEAT_LOOP_ID: loop.id, ... },
    });
    // ... same logic
  } catch (execError) { ... }
}
```
Note: This would also require making `handleIterationResult` and callers async-aware for the return value, which they already are.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Loop exit condition inherits full process environment** - `src/services/handlers/loop-handler.ts:572-577`
**Confidence**: 80%
- Problem: The exit condition shell command receives `...process.env` which exposes the entire server environment including any API keys, database credentials, or secrets in environment variables to the eval script. While this is a local-execution tool (not a web service), the exit condition is user-provided and could exfiltrate environment variables. The existing task spawning in `base-agent-adapter.ts` has `envPrefixesToStrip` to remove sensitive prefixes. The eval script should receive a minimal environment.
- Fix: Filter the environment to only include safe variables:
```typescript
const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  SHELL: process.env.SHELL,
  AUTOBEAT_LOOP_ID: loop.id,
  AUTOBEAT_ITERATION: String(loop.currentIteration),
  AUTOBEAT_TASK_ID: taskId,
};
```

## Pre-existing Issues (Not Blocking)

No CRITICAL pre-existing security issues found in files reviewed.

## Suggestions (Lower Confidence)

- **Unbounded loop with maxIterations=0 and maxConsecutiveFailures=0** - `src/services/loop-manager.ts:102-119` (Confidence: 70%) -- When both `maxIterations` and `maxConsecutiveFailures` are set to 0 (both mean "unlimited"), the loop will never terminate unless the exit condition passes. Consider logging a warning or requiring at least one termination bound.

- **exitCondition stored and executed as raw shell string** - `src/services/handlers/loop-handler.ts:580` (Confidence: 65%) -- The `exitCondition` is passed directly to `execSync()` which invokes a shell. This is by design (the feature intentionally runs shell commands), but the exit condition string is stored in SQLite and re-executed on recovery. If an attacker gained write access to the database, they could inject arbitrary commands. This is a defense-in-depth concern for the stored-command pattern.

- **Error messages may leak internal paths** - `src/services/loop-manager.ts:92`, `src/implementations/loop-repository.ts:504,514` (Confidence: 62%) -- Error messages include raw working directory paths and JSON parse errors that could reveal internal server filesystem structure. In a multi-tenant context this would be an information disclosure issue, but Autobeat is a local tool.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Security Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

### Rationale

The implementation follows strong security practices overall:
- Zod schemas validate all MCP inputs at the boundary
- `validatePath()` prevents path traversal for `workingDirectory`
- Parameterized SQL queries throughout (prepared statements)
- No hardcoded secrets
- Database CHECK constraints for defense-in-depth
- Proper FK cascade cleanup

The HIGH finding (undefined taskId in cancellation flow) is a real bug that could cause runtime errors. The MEDIUM findings around `execSync` blocking and unbounded `evalTimeout` are important for production resilience. The environment exposure concern is a defense-in-depth improvement. The shell execution pattern is inherent to the feature design (running user-provided evaluation scripts) and is not itself a vulnerability -- it is the intended behavior of the loop system.
