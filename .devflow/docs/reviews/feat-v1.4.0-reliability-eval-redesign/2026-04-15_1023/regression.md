# Regression Review Report

**Branch**: feat/v1.4.0-reliability-eval-redesign -> main
**PR**: #136
**Base SHA**: 33abbb78c6c566480ef474d5b98d20087051a929
**Date**: 2026-04-15

## Scope

Diff command: `git diff 33abbb78...HEAD`

Files reviewed (29 files, +2147/-625):
- Core API: `src/core/agents.ts` (AgentAdapter.spawn signature change)
- Adapters: `base-agent-adapter.ts`, `process-spawner-adapter.ts`, `codex-adapter.ts`, `gemini-adapter.ts`
- Worker pool: `event-driven-worker-pool.ts`
- Loop handler: 2 helper extractions (`refetchAfterAgentEval`, `handleStopDecision`, `finishLoop`)
- 3 evaluators sharing extracted `eval-prompt-builder.ts`
- `composite-exit-condition-evaluator.ts` (silent fallback → throw)
- Schedule executor: 4 pure helper extractions
- DB migration v22 (CHECK constraints on `eval_type` and `judge_agent`)
- `loop-repository.ts` Zod schema tightening + `taskTemplate.jsonSchema` round-trip
- ~92 test sites updated for new spawn signature

---

## Issues in Your Changes (BLOCKING)

None at HIGH/CRITICAL severity.

---

## Issues in Code You Touched (Should Fix)

### MEDIUM
**`ProcessSpawnerAdapter` silently drops `orchestratorId` and `jsonSchema`** — `src/implementations/process-spawner-adapter.ts:26-28`
**Confidence**: 92%
- Problem: The new `SpawnOptions` interface includes `orchestratorId` and `jsonSchema`, but `ProcessSpawnerAdapter.spawn` destructures only `{ prompt, workingDirectory, taskId, model }`, silently discarding the other two fields. There is no comment, no warning, and no runtime check. The Scrutinizer flagged this as intentional (test/legacy shim per the file's docblock: "removed once all tests migrate to mock AgentAdapters"), but the silent drop creates a real-but-subtle attribution / structured-output regression risk if this adapter is ever wired in production by mistake.
- Impact: If a `ProcessSpawnerAdapter` is used in any non-test code path, `AUTOBEAT_ORCHESTRATOR_ID` injection (v1.3.0 sub-task attribution) and `--json-schema` for Claude eval (v1.4.0 schema-mode evaluation) will silently no-op. Bug surface for future contributors.
- Fix: Either narrow the type (so the compiler enforces it) or warn:
  ```typescript
  spawn(opts: SpawnOptions): Result<{ process: ChildProcess; pid: number }> {
    if (opts.orchestratorId || opts.jsonSchema) {
      // Optional: log.warn once, or assert in dev mode
      // 'ProcessSpawnerAdapter ignores orchestratorId/jsonSchema — use a real AgentAdapter for these.'
    }
    return this.spawner.spawn(opts.prompt, opts.workingDirectory, opts.taskId, opts.model);
  }
  ```
  At minimum, add a code comment at the destructuring site (the file-level docblock says "compatibility adapter" but the destructure site itself looks like a normal implementation).

**`handleScheduleExecutor` now hard-exits on missing `scheduleRepository` instead of staying alive (conservative)** — `src/cli/commands/schedule-executor.ts:254-261`
**Confidence**: 86%
- Problem: The previous idle-check loop wrapped `container.get<ScheduleRepository>('scheduleRepository')` inside the `setInterval` callback and on failure simply `return`-ed (continued running, conservative). The refactor lifts the resolution out of the loop and now `process.exit(1)` is called at startup if container resolution fails. This is a behavior shift documented nowhere in the diff.
- Impact: If `scheduleRepository` is missing from the container at bootstrap (e.g., due to a partial container init regression in a future change), the executor process will die immediately rather than stay alive. For a long-running scheduling daemon, this changes failure semantics from "log and continue" to "exit". Most likely benign (this resolution should never fail in normal bootstrap), but the comment block in the OLD interval loop explicitly called out conservative-stay-alive behavior, and that intent is now lost.
- Fix: Either:
  1. Add a comment justifying the exit-on-resolution-failure as a stricter-than-before contract (intentional), or
  2. Match prior semantics: log and skip the idle check rather than exiting (`scheduleRepoResult.ok ? startIdleCheckLoop(...) : process.stderr.write('... — idle check disabled')`).

---

## Pre-existing Issues (Not Blocking)

### LOW
**Stale "1 hour" timeout warning in `config-validator.ts`** — `src/core/config-validator.ts:169-178`
**Confidence**: 95%
- Pre-existing in the codebase before this PR (file unchanged in diff). The validator emits an info warning when timeout equals 1 hour with text "Task timeout is at security maximum (1 hour)" — but `ConfigurationSchema` allows up to 24 hours. The security tests in this PR were correctly updated to match the actual 24h schema; this stale validator warning was missed.
- Recommendation: separate cleanup PR.

---

## Suggestions (Lower Confidence)

- **Per-branch refactor of stale-state log message in `refetchAfterAgentEval`** - `src/services/handlers/loop-handler.ts:333-362` (Confidence: 70%) — The original code combined repo-error/null/wrong-status into a single log line per fetch (e.g., `staleStatus: <actual-status>` when loop existed but was wrong-state). The new helper logs `status: 'null' | 'error'` for fetch failures and the actual status for wrong-state in two separate branches. Same message text, equivalent observability, but the combined-key `staleStatus` value is gone — log-grep tooling keyed on `staleStatus: <status-name>` would no longer match. Probably fine; flagging in case dashboards depend on it.
- **`handleStopDecision` tx-failure path calls `completeLoop` after partial commit** - `src/services/handlers/loop-handler.ts:1275-1278` (Confidence: 65%) — On `txResult.ok === false`, the helper calls `completeLoop(loop, LoopStatus.FAILED, 'Failed to persist stop decision')`, which writes the loop row again and may double-write. The pre-refactor code did the same thing, so this is not a regression — but the new `finishLoop` distinction documented elsewhere in the same diff suggests this branch could also benefit from a "DB already committed (or not) → choose write strategy" decision. Not a regression, just an inconsistency.

---

## Lost Functionality Check

| Item | Status |
|------|--------|
| Removed exports | None — `MAX_FEEDBACK_LENGTH` was a private module const replaced by `MAX_EVAL_FEEDBACK_LENGTH` (re-exported from `eval-prompt-builder.ts`). Not part of public API. |
| Removed CLI options | None |
| Removed event handlers | None |
| Removed log calls | None — original 4 stale-state logs preserved across `refetchAfterAgentEval` (verified line-by-line, see Suggestions above for shape change). |
| Removed error paths | None — composite evaluator's silent fallback intentionally REPLACED with throw (improvement). |
| Skipped cleanup | None — `dispose()`, `clearInterval`, `cleanup()`, `clearTimeout` calls all preserved. |

## Broken Behavior Check

| Item | Status |
|------|--------|
| Spawn signature change | BREAKING for `AgentAdapter` interface consumers, but all internal callers updated (1 production + ~92 test sites). External consumers (none in repo) would break — acceptable for v1.x minor-version pre-1.0 boundary per release notes. |
| Default values changed | None |
| Return types changed | None |
| Error handling changed | `CompositeExitConditionEvaluator` default branch now THROWS instead of falling back to feedforward — INTENTIONAL (documented), test added (`eval-batch3.test.ts:226-234`). |
| `taskTemplate.jsonSchema` round-trip | Added with explicit comment "Without this, Zod strips the field and schema-mode evaluation silently breaks." Good defensive change. |
| `handleStopDecision` extraction | Logger key `loopId` was previously `loop.id` in retry path and `loopId` shorthand in optimize path. Standardized to `loop.id` per docblock. Functionally equivalent. |
| `finishLoop` vs `completeLoop` split | Eliminates double-write after transaction-committed status. Test added (`loop-handler.test.ts:1882-1905`) verifying `loopRepo.update` is NOT called. |

## Intent vs Reality Check

| Commit Claim | Reality |
|--------------|---------|
| "Eval prompt builder shared across 3 evaluators" | Verified — all 3 evaluators import `buildEvalPromptBase` and `MAX_EVAL_FEEDBACK_LENGTH`. Prompt content byte-identical. |
| "TOCTOU fix on judge decision file" | Verified — per-task `.autobeat-judge-{taskId}` filename, test added (`judge-exit-condition-evaluator.test.ts:262-294`). |
| "Atomic O_EXCL PID file acquisition" | Verified — `acquirePidFile` returns Result, handles EEXIST, does stale-PID retry. New tests cover the cases. |
| "Migration v22 CHECK constraints" | Verified — table-recreation pattern with data preservation. Indexes recreated. |
| "Test count: ~92 spawn() sites updated" | Verified — `agent-adapters.test.ts` is fully migrated, no positional-arg `adapter.spawn(...)` calls remain in `tests/`. |

## Incomplete Migration Check

| Item | Status |
|------|--------|
| Old positional `spawn(prompt, workdir, ...)` calls | None remaining in `src/` or `tests/`. Verified via Grep. |
| Old `MAX_FEEDBACK_LENGTH` const references | None — all 3 evaluators use `MAX_EVAL_FEEDBACK_LENGTH` from the shared module. |
| Old fixed `.autobeat-judge` filename | Removed from production code. Test asserts unique filename and that the OLD pattern is NOT present. |
| `.length` vs `Buffer.byteLength()` for feedback cap | Updated in `loop-handler.ts:1534,1536` and matching test in `eval-domain-batch2.test.ts:685,687,705,707`. Consistent with prior MEMORY decision (byte-vs-char consistency 2026-03-19). |

## Test Assertion Strength Check

| Test | Pre/Post | Notes |
|------|----------|-------|
| `resource-exhaustion.test.ts` timeout tests | Realigned to actual 24h schema (was wrongly asserting 1h max) | Schema unchanged in this PR — tests were stale, now corrected. NOT a weakening. |
| `eval-batch3.test.ts` exhaustive switch | NEW test added for unknown evalType throw | Strengthening. |
| `judge-evaluator` per-task filename | NEW test added | Strengthening. |
| `loop-handler.test.ts` decision: stop double-write | NEW test added asserting `update` NOT called | Strengthening (catches future regressions of the optimization). |
| `agent-adapters.test.ts` | All ~35 sites migrated to options object | Equivalent assertions, just signature update. |

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | - |
| Should Fix | - | 0 | 2 | - |
| Pre-existing | - | - | 0 | 1 |

**Regression Score**: 9/10
**Recommendation**: APPROVED_WITH_CONDITIONS

This refactor is regression-safe at the high-priority level. The two MEDIUM Should-Fix items are quality-of-life concerns (silent-shim documentation and a startup-failure semantics shift) — not behavioral regressions in the primary value-flow. All claimed extractions preserve byte-identical prompt content, all logs are preserved, all error paths are preserved, all cleanup paths are preserved, the new tests strengthen rather than weaken assertions, and the API change is fully migrated across the codebase.
