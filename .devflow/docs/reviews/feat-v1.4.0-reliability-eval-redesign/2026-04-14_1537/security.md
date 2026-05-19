# Security Review Report

**Branch**: feat/v1.4.0-reliability-eval-redesign -> main
**Date**: 2026-04-14T15:37:00Z
**PR**: #136

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

**Default timeout disabled (DoS vector via unbounded task execution)** - `src/core/configuration.ts:20`
**Confidence**: 85%
- Problem: The timeout Zod schema minimum was changed from `min(1000)` (1 second) to `min(0)` and the default was changed from `1800000` (30 minutes) to `0` (disabled). The comment reads "tasks run 2.5+ hours; timeout was killing them" -- but removing the timeout floor entirely means any task spawned without an explicit timeout will run indefinitely. A single malicious or buggy prompt can monopolize a worker slot forever without any safety net. The prior `SECURITY: max 1 hour` annotation was intentionally guarding against this. The new max of 86400000 (24 hours) is reasonable as an upper bound, but the default of 0 (no timeout at all) removes a defense-in-depth layer.
- Fix: Keep `min(0)` if you must allow opt-out, but set the default to a high-but-finite value (e.g., `7200000` = 2 hours) rather than `0`. This preserves the ability to opt out by setting timeout=0, while keeping defense-in-depth for the default case:
```typescript
timeout: z.number().min(0).max(86400000).default(7200000),
// Default: 2hr (covers long tasks; set timeout=0 to opt out)
```

**Judge evaluator file-based decision is writable by the agent under evaluation** - `src/services/judge-exit-condition-evaluator.ts:301`
**Confidence**: 82%
- Problem: The judge agent is instructed to write `.autobeat-judge` into the loop's working directory. However, the working directory is the same directory that the work agent just modified. If the work agent (or any code it runs) writes a `.autobeat-judge` file preemptively or maliciously before the judge runs, the `cleanupDecisionFile` call at line 197 mitigates this for the current iteration -- but there is a TOCTOU window: after `cleanupDecisionFile` at line 197 and before the judge completes at line 211, the work agent (if still running in the same directory, e.g., a pipeline step) could write the file. The judge evaluator would then read the work agent's decision rather than the judge agent's decision. This is a privilege boundary confusion: the entity being evaluated can influence the evaluation outcome.
- Fix: Use a unique filename per evaluation to eliminate the TOCTOU window:
```typescript
const JUDGE_DECISION_FILE_PREFIX = '.autobeat-judge-';
// In runJudgeAgent:
const decisionFileName = `${JUDGE_DECISION_FILE_PREFIX}${judgeTaskId}`;
const decisionFilePath = path.join(loop.workingDirectory, decisionFileName);
```
Then include the specific filename in the judge prompt. This makes the file unpredictable to the work agent.

### MEDIUM

**jsonSchema string passed unsanitized to CLI arguments** - `src/implementations/claude-adapter.ts:25-26`
**Confidence**: 83%
- Problem: The `jsonSchema` string is passed directly as a CLI argument via `['--json-schema', jsonSchema]`. While the MCP boundary validates `z.string().max(16000)`, the schema content itself is not validated as actual JSON or checked for shell-hostile characters. The `spawn()` call uses the array form (not shell interpolation), so classic shell injection is not possible. However, extremely large or specially crafted strings could cause issues with the Claude CLI's argument parsing. The `max(16000)` Zod constraint is the only defense.
- Fix: Add a JSON.parse validation at the boundary before passing to CLI args. This is defense-in-depth since the MCP path already limits to 16000 chars:
```typescript
// In buildArgs:
if (jsonSchema) {
  try {
    JSON.parse(jsonSchema); // Validate it's actual JSON
  } catch {
    // Log and skip — don't pass malformed JSON to CLI
    return [...this.baseArgs, ...modelArgs, '--', prompt];
  }
  const schemaArgs = ['--json-schema', jsonSchema];
  return [...this.baseArgs, ...modelArgs, ...schemaArgs, '--', prompt];
}
```

**PID file race condition in schedule executor** - `src/cli/commands/schedule-executor.ts:66-70`
**Confidence**: 80%
- Problem: `ensureScheduleExecutorRunning()` reads the PID file, checks liveness, and conditionally spawns. Between the liveness check (line 67) and the spawn (line 77), another process could also pass the same check and spawn. The comment at line 10-11 acknowledges this: "PID file race is benign -- per-schedule dedup in ScheduleExecutor prevents double execution." The dedup is indeed present, making this a low-impact issue, but two executor processes will both consume resources and write to the same PID file. The second write wins, orphaning the first executor's PID tracking.
- Fix: Use an exclusive file lock (e.g., `fs.openSync(pidPath, 'wx')` for atomic create-or-fail) to serialize executor startup:
```typescript
try {
  const fd = fs.openSync(pidPath, 'wx');
  fs.writeSync(fd, String(process.pid));
  fs.closeSync(fd);
} catch (e) {
  if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
    // Another process won the race — re-check liveness
    return;
  }
  throw e;
}
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**DEFAULT_CONFIG object deleted without replacement** - `src/core/configuration.ts:62-84`
**Confidence**: 85%
- Problem: The `DEFAULT_CONFIG` constant was removed entirely. The Zod schema defaults fill this role, but the removal means there is no longer a single, reviewable constant listing all default values. This is not a direct vulnerability, but it reduces auditability of the security-relevant defaults (timeout, memory reserve, max listeners, etc.). The previous code had explicit `SECURITY:` comments on each default. Those annotations are now embedded in Zod `.default()` calls across a single dense line each, making them harder to audit.
- Fix: No code change needed, but consider adding a comment block above `ConfigurationSchema` that lists the security-relevant defaults and their rationale in a reviewable format.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`--dangerously-skip-permissions` hardcoded in Claude adapter** - `src/implementations/claude-adapter.ts:20`
**Confidence**: 90%
- Problem: The Claude adapter always passes `--dangerously-skip-permissions`, giving the spawned Claude agent full filesystem and command execution access. This is by design for an automation tool, but there is no configuration option to disable it for users who want sandboxed execution.
- Note: Pre-existing, not introduced by this PR. Informational only.

## Suggestions (Lower Confidence)

- **evalResponse field stores unbounded agent output** - `src/core/domain.ts:641`, `src/services/agent-exit-condition-evaluator.ts:267,279` (Confidence: 70%) -- The `evalResponse` field stores raw agent output without a length cap. While `evalFeedback` is capped at `MAX_FEEDBACK_LENGTH`, `evalResponse` stores the full JSON envelope. For audit purposes this may be intentional, but large eval responses could bloat the SQLite database over time.

- **Resource monitoring now always enabled for 'run' mode** - `src/bootstrap.ts:61-63` (Confidence: 65%) -- `skipResourceMonitoring` was changed from `mode === 'run'` to `false`. The comment explains the rationale (prevent unchecked spawning), but this changes behavior for the `beat run` CLI path. Users running single-shot tasks may see unexpected resource check overhead.

- **Heartbeat write errors silently swallowed** - `src/implementations/event-driven-worker-pool.ts:353-355` (Confidence: 65%) -- The `updateHeartbeat` call in the 30s interval does not check the Result return value. If the DB write consistently fails (e.g., disk full), the recovery manager will see stale heartbeats and warn, but the root cause (DB write failure) is not surfaced.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Security Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The PR introduces a well-structured eval redesign with good patterns (Zod boundary validation, DI for testability, structured output with text fallback). The two HIGH findings are: (1) the default timeout being disabled removes a defense-in-depth safety net against unbounded task execution, and (2) the judge decision file mechanism has a TOCTOU window where the entity under evaluation can influence its own evaluation outcome. Neither is an immediate exploit in this context, but both weaken security posture and should be addressed before merge.
