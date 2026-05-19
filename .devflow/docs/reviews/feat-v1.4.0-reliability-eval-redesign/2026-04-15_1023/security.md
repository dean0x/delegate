# Security Review Report

**Branch**: feat/v1.4.0-reliability-eval-redesign -> main
**PR**: #136
**Base SHA**: 33abbb78c6c566480ef474d5b98d20087051a929
**Date**: 2026-04-15 10:23

## Scope of Review

PR #136 cleanup closes #137-#143. Security-relevant focus areas:
- #141 Atomic O_EXCL PID file locking in `src/cli/commands/schedule-executor.ts`
- #139 `AgentAdapter.spawn()` options-bag refactor (orchestratorId still regex-validated in `base-agent-adapter.ts`)
- Judge evaluator temp-file handling (TOCTOU)
- Prompt-builder and adapter argv construction (injection)
- Boundary validation for new fields (`eval_type`, `judge_agent`, `jsonSchema`)

## Pitfall Cross-Check (.memory/knowledge/pitfalls.md)

None of PF-001..PF-005 overlap with the security-relevant files in this PR. PF-005 (Zod-on-read) is in fact reinforced — `SQLiteLoopRepository` tightens `eval_type` and `judge_agent` from `z.string().nullable().optional()` to `z.enum(...).nullable().optional()`, rejecting corrupt DB values at the boundary.

---

## Issues in Your Changes (BLOCKING)

### CRITICAL

None.

### HIGH

None.

---

## Issues in Code You Touched (Should Fix)

### MEDIUM

**PID-reuse false positive in `acquirePidFile` liveness check** — `src/cli/commands/schedule-executor.ts:96-99`
**Confidence**: 82%
- Problem: When `acquirePidFile` finds an existing PID file, it calls `isProcessAlive(existingPid)` (a `kill(pid, 0)` probe). If the original executor crashed and the OS subsequently recycled that PID to an unrelated process (very common on long-uptime hosts where PIDs are 5-digit and recycle within hours/days), this branch returns `'already-running'` and the new executor exits with code 0 — even though no executor is actually managing schedules. The comment block at lines 69-71 explicitly accepts a different residual TOCTOU but does not address PID reuse, which is a more likely failure mode than the documented stale-file race.
- Fix: After confirming the PID is alive via signal 0, additionally verify the process is actually an autobeat schedule executor before trusting the result. On Linux, read `/proc/{pid}/comm` or `/proc/{pid}/cmdline` and assert it contains `node` + `autobeat`/`beat`. On macOS, use `ps -p {pid} -o comm=`. Without this check, a recycled PID can silently disable schedule execution. Code sketch:
  ```ts
  function isAutobeatExecutor(pid: number): boolean {
    try {
      if (process.platform === 'linux') {
        const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
        return cmdline.includes('beat') || cmdline.includes('autobeat');
      }
      // macOS / other: best-effort fall back via spawnSync('ps')
      return true; // accept liveness as a weak signal
    } catch {
      return false;
    }
  }
  // In acquirePidFile:
  if (existingPid !== null && isProcessAlive(existingPid) && isAutobeatExecutor(existingPid)) {
    return ok('already-running');
  }
  ```

**`ProcessSpawnerAdapter.spawn()` silently drops `orchestratorId` and `jsonSchema`** — `src/implementations/process-spawner-adapter.ts:26-28`
**Confidence**: 80%
- Problem: The destructuring at line 26 only pulls `prompt`, `workingDirectory`, `taskId`, `model` from `SpawnOptions`. `orchestratorId` and `jsonSchema` are silently dropped at this boundary because the wrapped `ProcessSpawner.spawn()` interface does not accept them. The class comment at lines 1-9 marks this as a backward-compatibility shim removed once tests migrate to mock AgentAdapters — but in the meantime, any production call path that resolves to this adapter will silently lose orchestrator attribution (a v1.3.0 feature) and structured-output schema (a v1.4.0 feature). The MCP boundary now validates `orchestratorId` and feature contracts assume it propagates; silent loss is a defense-in-depth gap.
- Fix: Either (a) add a one-line warning log when `orchestratorId` or `jsonSchema` is set but the wrapped spawner cannot use them, or (b) explicitly mark this adapter as test-only (move to `tests/`) so it cannot accidentally be wired into production. Minimal change:
  ```ts
  spawn(opts: SpawnOptions): Result<{ process: ChildProcess; pid: number }> {
    if (opts.orchestratorId || opts.jsonSchema) {
      // SECURITY: caller passed v1.3+ fields that this legacy adapter ignores.
      // Silent drop hides feature-loss bugs.
      console.error(JSON.stringify({
        level: 'warn',
        message: 'ProcessSpawnerAdapter dropping orchestratorId/jsonSchema — wire AgentAdapter directly',
      }));
    }
    return this.spawner.spawn(opts.prompt, opts.workingDirectory, opts.taskId, opts.model);
  }
  ```

---

## Pre-existing Issues (Not Blocking)

### LOW

**PID file inherits umask-controlled permissions (0o666 default)** — `src/cli/commands/schedule-executor.ts:86,103`
**Confidence**: 85%
- Problem: `fs.openSync(pidPath, 'wx')` creates the file with the default mode `0o666`, modulated by the user's umask. A liberal umask (e.g., `0o022`) leaves the file world-readable. The PID itself is not sensitive (visible via `ps`), and the parent directory is `~/.autobeat` which is typically `0o755`, so practical exposure is low. Pre-existing — same code shape existed before #141 with `writeFileSync`.
- Fix (informational): Pass an explicit restrictive mode to `openSync` for defense-in-depth on shared/multi-tenant hosts:
  ```ts
  const fd = fs.openSync(pidPath, 'wx', 0o600);
  ```

---

## Suggestions (Lower Confidence)

- **Judge decision-file path uses `judgeTaskId` (UUID) — TOCTOU correctly mitigated** - `src/services/judge-exit-condition-evaluator.ts:60-62, 187-204` (Confidence: 70%) — Per-task filename `.autobeat-judge-${judgeTaskId}` derived from `crypto.randomUUID()` (via `createTask` in `src/core/domain.ts:235`) is unguessable by the work agent. The fix correctly addresses the documented TOCTOU. Possible minor concern: stale `.autobeat-judge-{uuid}` files may accumulate in the working directory if the judge process is killed mid-write — `cleanupDecisionFile` is called on success/abort paths but not on `TaskDelegated` emit failure (line 222). Consider an unconditional `cleanupDecisionFile` in a `finally`.
- **`preIterationCommitSha` is interpolated into the agent prompt without sanitization** - `src/services/eval-prompt-builder.ts:57` (Confidence: 65%) — The git SHA is sourced from `getCurrentCommitSha()` (a child-process `git rev-parse HEAD` call), which makes injection very unlikely under normal operation. However, the value is shown to an LLM that may execute the literal `git diff <sha>..HEAD` command. If `getCurrentCommitSha` ever returned attacker-influenced content (corrupt git state, hostile working-tree), the LLM could execute the unintended command. Defense-in-depth: validate the value against `/^[0-9a-f]{7,64}$/` in `eval-prompt-builder.ts` before interpolation.

---

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | - |
| Should Fix | - | 0 | 2 | - |
| Pre-existing | - | - | 0 | 1 |

**Security Score**: 9/10
**Recommendation**: APPROVED

### Security Wins in This PR

1. **Atomic PID-file acquisition (#141)** — `acquirePidFile` correctly uses `O_EXCL | O_CREAT` (Node `'wx'` flag) and properly distinguishes EEXIST from other errors. The race window is bounded to the documented stale-file recovery path.
2. **Defense-in-depth orchestratorId validation** — `base-agent-adapter.ts:182-193` keeps the canonical-UUID regex check at the env-injection boundary even though MCP also validates upstream. Silent drop with structured-warning log is the right behavior — does not throw in the spawn hot path.
3. **TOCTOU fix on judge decision file** — Per-task `.autobeat-judge-{uuid}` filename (using `crypto.randomUUID()`-backed task IDs) makes the path unguessable by the work agent in the same working directory.
4. **CHECK constraints + Zod enum tightening** — Migration v22 adds DB-level CHECK constraints on `eval_type` and `judge_agent`; `LoopRowSchema` upgrades from `z.string()` to `z.enum(...)`. Two-layer boundary validation rejects corrupt rows.
5. **Schema round-trips `jsonSchema`** — `TaskRequestSchema.jsonSchema: z.string().optional()` (loop-repository.ts:120) prevents Zod from silently stripping the field, which would have broken schema-mode evaluation.

### Why APPROVED (not BLOCK / CHANGES_REQUESTED)

No CRITICAL or HIGH findings in your changes. The two MEDIUM findings (PID reuse and `ProcessSpawnerAdapter` silent drop) are defense-in-depth improvements, not exploitable vulnerabilities — neither has a known attack path under normal operation. The LOW finding is pre-existing. Recommend addressing the PID-reuse case in a follow-up PR; it is a reliability concern with security-adjacent failure modes (silent disabling of schedule execution).
