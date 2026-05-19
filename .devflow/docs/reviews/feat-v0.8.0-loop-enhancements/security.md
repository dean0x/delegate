# Security Review Report

**Branch**: feat/v0.8.0-loop-enhancements -> main
**Date**: 2026-03-23
**PR**: #115

## Issues in Your Changes (BLOCKING)

### HIGH

**Missing `gitBranch` input sanitization -- arbitrary git ref names passed to `execFile`** - `src/utils/git-state.ts:96`, `src/utils/git-state.ts:123`
**Confidence**: 85%
- Problem: The `gitBranch` parameter flows from MCP/CLI input through to `execFile('git', ['checkout', '-B', branchName])` and `execFile('git', ['diff', '--stat', ...])` without any format validation. While `execFile` prevents shell injection (no shell metacharacter expansion), a malicious or malformed branch name could still cause unexpected git behavior. For example, a branch name starting with `-` (e.g., `--orphan`) would be interpreted as a git flag, not a branch name. This is a "flag injection" via argument array, which `execFile` does NOT prevent.
- Impact: An attacker providing `gitBranch: "--orphan"` or `gitBranch: "-"` could manipulate git behavior. Branch names like `--` followed by a path could cause `git checkout` to operate on files instead of branches. The `captureGitDiff` function concatenates branch names into `${fromBranch}..${toBranch}` which is passed as a single argument, limiting flag injection there, but still lacks validation.
- Fix: Add a `validateGitBranchName` function that enforces git's own ref name rules and rejects names starting with `-`:
```typescript
// src/utils/git-state.ts
export function validateGitBranchName(name: string): Result<string> {
  // Reject empty, starting with -, containing .., ~, ^, :, \, spaces, or control chars
  if (!name || name.startsWith('-') || /[\x00-\x1f\x7f ~^:?*\[\\]/.test(name)
      || name.includes('..') || name.endsWith('.lock') || name.endsWith('/') || name.startsWith('/')) {
    return err(new AutobeatError(ErrorCode.INVALID_INPUT, `Invalid git branch name: ${name}`));
  }
  return ok(name);
}
```
Apply this validation in `createAndCheckoutBranch`, `captureGitDiff`, and at the MCP/CLI boundary Zod schemas (add `.regex()` constraint to `gitBranch` fields).

---

**Scheduled loop trigger bypasses `LoopManagerService` validation** - `src/services/handlers/schedule-handler.ts:524`
**Confidence**: 82%
- Problem: When a scheduled loop fires, `ScheduleHandler.handleLoopTrigger()` calls `createLoop(loopConfig, workingDirectory, scheduleId)` directly using the deserialized `loopConfig` from the database. This bypasses `LoopManagerService.createLoop()` which performs critical validations: working directory path validation (`validatePath`), git repo existence check (`captureGitState`), agent resolution, `evalTimeout` range check, `maxIterations`/`maxConsecutiveFailures` bounds, and strategy-direction consistency.
- Impact: If the database `loopConfig` JSON is tampered with (SQLite file access) or if conditions change between schedule creation and trigger time (e.g., working directory deleted, git repo removed), the loop will start with unvalidated parameters. The `loopConfig.workingDirectory` falls back to `process.cwd()` without path validation, which could reference an unsafe directory.
- Fix: Extract the validation logic from `LoopManagerService.createLoop()` into a shared `validateLoopConfig()` function and call it in `handleLoopTrigger` before creating the loop:
```typescript
// In schedule-handler.ts handleLoopTrigger:
const validationResult = await validateLoopConfig(loopConfig, workingDirectory);
if (!validationResult.ok) {
  // Record execution as 'failed' and continue
  await this.scheduleRepo.recordExecution({ ... status: 'failed', errorMessage: validationResult.error.message });
  return ok(undefined);
}
```

### MEDIUM

**No max-length constraint on `exitCondition` field** - `src/adapters/mcp-adapter.ts:263`, `src/adapters/mcp-adapter.ts:210`
**Confidence**: 84%
- Problem: The `exitCondition` Zod schema uses `z.string().min(1)` with no maximum length. This field is stored in the database and later executed as a shell command via `child_process.exec`. An extremely long `exitCondition` string (e.g., megabytes) could cause resource exhaustion when stored in SQLite and when passed to the shell.
- Impact: Denial of service via oversized shell command strings. The `exitCondition` is also stored inside `loopConfig` JSON in the `schedules` table, amplifying storage impact for recurring schedules.
- Fix: Add `.max(4000)` to the `exitCondition` Zod schemas (consistent with the `prompt` field's existing 4000-char limit):
```typescript
exitCondition: z.string().min(1).max(4000).describe('Shell command to evaluate after each iteration'),
```
Apply in both `CreateLoopSchema` and `ScheduleLoopSchema` in `mcp-adapter.ts`, and in `LoopConfigSchema` in `schedule-repository.ts`.

---

**`loopConfig` deserialization error exposes internal details** - `src/implementations/schedule-repository.ts:582`
**Confidence**: 80%
- Problem: When `JSON.parse(data.loop_config)` or `LoopConfigSchema.parse(parsed)` fails, the error is thrown as `new Error(\`Invalid loop_config JSON for schedule ${data.id}: ${e}\`)`. The stringified error `${e}` may include the full Zod validation error with internal field names and expected types, or JSON parse error with position details.
- Impact: Information disclosure. If error messages are surfaced to MCP clients (which they are via the error response path), internal schema details are exposed. This is LOW severity but combined with the scheduled loop trigger path, it could help an attacker understand the internal data model.
- Fix: Sanitize the error message:
```typescript
throw new Error(`Invalid loop_config JSON for schedule ${data.id}`);
```
Log the full error details at `warn` level for debugging, but don't include them in the thrown error.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Unsafe type cast `loop.id as unknown as TaskId` in schedule-handler** - `src/services/handlers/schedule-handler.ts:560`
**Confidence**: 85%
- Problem: The `ScheduleExecuted` event is emitted with `taskId: loop.id as unknown as TaskId`, using a `LoopId` in a `TaskId` slot. This bypasses TypeScript's branded type safety entirely. While documented as an "ARCHITECTURE EXCEPTION," it creates a type confusion vector: if any code path processes `ScheduleExecuted` events and passes the `taskId` to task-specific operations (e.g., `taskRepo.findById()`), it would silently fail or produce unexpected results with a loop ID.
- Impact: Type confusion could lead to incorrect state transitions if the `taskId` slot is used for task lookups elsewhere. The `clearRunningScheduleByTask` usage is safe (string comparison), but the pattern is fragile against future changes.
- Fix: Extend the `ScheduleExecutedEvent` interface to include an optional `loopId` field, or introduce a `ScheduleLoopExecuted` event type, rather than misusing the `taskId` slot:
```typescript
export interface ScheduleExecutedEvent extends BaseEvent {
  type: 'ScheduleExecuted';
  scheduleId: ScheduleId;
  taskId?: TaskId;
  loopId?: LoopId;  // v0.8.0: set when schedule triggers a loop
  executedAt: number;
}
```

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`exitCondition` uses `exec` (shell) not `execFile`** - `src/services/exit-condition-evaluator.ts:30`
**Confidence**: 90% (that it is intentional by design)
- Problem: The `ShellExitConditionEvaluator` uses `exec` which spawns a shell, meaning `exitCondition` strings are subject to full shell interpretation. This is intentional (the field is documented as a "Shell command"), but it means any value stored in the `exitCondition` field has arbitrary code execution capability.
- Impact: This is by design -- the `exitCondition` IS a shell command the user provides. The security boundary is at the input validation layer (MCP/CLI), not at execution. This pre-existing design means the `loopConfig.exitCondition` deserialization path introduced in v0.8.0 inherits this trust model. If the database is compromised, the stored `exitCondition` can execute arbitrary commands.
- Note: This is informational. The tool is designed for trusted local use (MCP server on local machine). Not blocking.

## Suggestions (Lower Confidence)

- **Missing `fromRef` validation in `createAndCheckoutBranch`** - `src/utils/git-state.ts:97` (Confidence: 70%) -- The `fromRef` parameter (derived from `gitBaseBranch` or previous iteration branch name) is passed directly to `git checkout -B`. If the base branch name was corrupted in the database, it could cause flag injection. Same mitigation as the `gitBranch` validation finding above.

- **`workingDirectory` fallback to `process.cwd()` in scheduled loop trigger** - `src/services/handlers/schedule-handler.ts:522` (Confidence: 65%) -- When `loopConfig.workingDirectory` and `schedule.taskTemplate.workingDirectory` are both undefined, it falls back to `process.cwd()`. This is the MCP server process's working directory, which may not be appropriate for the loop's git operations. Consider requiring `workingDirectory` in the `ScheduledLoopCreateRequest` or at least validating it with `validatePath`.

- **`LoopConfigSchema` is more permissive than input schemas** - `src/implementations/schedule-repository.ts:114` (Confidence: 68%) -- The `LoopConfigSchema` used for database deserialization has looser validation than the MCP input schemas. For example, `exitCondition` has no `.max()`, `maxIterations` has no `.min(0)`, and `evalTimeout` has no `.min(1000)`. If the database is tampered with, values outside the normal input range could be loaded. Consider matching the input schema constraints in the deserialization schema.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Security Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

### Rationale

The v0.8.0 changes introduce two new attack surfaces that need hardening before merge:

1. **Git branch name injection**: The `gitBranch` parameter flows from user input to `execFile` arguments without validation. While `execFile` prevents shell metacharacter expansion, git flag injection (branch names starting with `-`) is still possible. This is a well-known class of argument injection vulnerabilities.

2. **Validation bypass in scheduled loop trigger**: The `handleLoopTrigger` path bypasses the comprehensive validation in `LoopManagerService.createLoop()`, creating an inconsistency where direct loop creation is validated but scheduled loop creation is not. This is particularly concerning because the `loopConfig` is deserialized from JSON stored in the database.

The core architecture is sound -- use of `execFile` over `exec` for git operations, Zod boundary validation for JSON deserialization, and Result-based error handling. The issues are fixable with targeted changes (branch name validation, shared validation function, max-length constraints).
