# Testing Review Report

**Branch**: feat/v1.4.0-reliability-eval-redesign -> main
**PR**: #136
**Date**: 2026-04-15 10:23
**Diff range**: 33abbb78c6c566480ef474d5b98d20087051a929...HEAD
**Total test count in scope**: 261 `it()` blocks across 9 files (~57 net new for v1.4.0)

---

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none found)

### HIGH

**Tautological "Feedback accumulation cap" tests don't exercise production code** — Confidence: 95%
- `tests/unit/services/eval-domain-batch2.test.ts:675-715` (2 tests in `describe('Feedback accumulation cap')`)
- Problem: Both tests re-implement the cap logic locally (a hand-rolled for-loop with `Buffer.byteLength` and `MAX_FEEDBACK_BYTES = 8192`) and assert that the *test's own loop* honours the cap. Neither test imports or invokes the production accumulation function; they verify the test scaffold, not the SUT. If the production cap is removed, raised to 16KB, or the eviction policy changes, both tests still pass. The header comment even calls them "behavioral invariant" tests, which they are not — they are circular by construction.
- Fix: Either delete both tests or rewrite them to drive the actual feedback-accumulator code path (e.g. through `JudgeExitConditionEvaluator` / `AgentExitConditionEvaluator` with N synthetic prior iterations) and assert the resulting `feedback` length never exceeds 8192 bytes. Example shape:
  ```ts
  // Drive accumulation through the real evaluator, not a local re-impl
  const iters = Array.from({ length: 200 }, (_, i) => makeIteration(i));
  const result = await evaluator.evaluate(loopWithIters(iters), taskId);
  expect(Buffer.byteLength(result.feedback ?? '')).toBeLessThanOrEqual(8192);
  ```

**`acquirePidFile` lacks the concurrency test that proves O_EXCL atomicity** — Confidence: 90%
- `tests/unit/services/schedule-executor-autostart.test.ts:284-369` (the new 6 acquirePidFile tests)
- Problem: The 6 new tests cover every *single-process* code path (no file → acquired; live PID → already-running; dead PID → acquired-after-unlink; mkdir failure → err; nested mkdir → acquired). They verify real behaviour through real temp files (good — no atomic-primitive mocking). But the entire reason the helper exists is to win the race between two simultaneously-starting executors, and that race is never tested. The DECISION comment in the source explicitly cites "Atomic O_EXCL create-or-fail prevents PID file race" — without a concurrent-call test, that contract is asserted only by code review.
- Fix: Add a single test that fires `Promise.all([acquirePidFile(p, A), acquirePidFile(p, B)])` and asserts exactly one returns `'acquired'` and the other returns `'already-running'` (or `'acquired'` after stale cleanup if A is dead). Even on a single thread, `openSync('wx')` is sync so this exercises the EEXIST branch deterministically:
  ```ts
  it('exactly one of two concurrent acquisitions wins', () => {
    // Pre-create a live owner so the loser path is deterministic
    fs.writeFileSync(tempPidPath, String(process.pid), 'utf-8');
    const [a, b] = [process.pid + 1, process.pid + 2].map(p => acquirePidFile(tempPidPath, p));
    const outcomes = [a, b].map(r => r.ok ? r.value : 'err');
    expect(outcomes.filter(o => o === 'already-running')).toHaveLength(2);
  });
  ```

**`schedule-executor-autostart.test.ts` ships an executable assertion that asserts nothing** — Confidence: 99%
- `tests/unit/services/schedule-executor-autostart.test.ts:264-277`
- Problem: The test `'spawn would use detached + ignore + unref (verified by reviewing source)'` ends with `expect(true).toBe(true)`. It is documentation masquerading as a passing test. Coverage tools and dashboards will count it as a green guardrail; it is not. The associated comment is honest ("This test serves as documentation, not as an executable assertion") which makes it worse — the team knowingly added a fake assertion.
- Fix: Delete the `it(...)` block. Move the comment to a top-of-file ARCHITECTURE note or to a JSDoc on `ensureScheduleExecutorRunning`. If a guardrail is desired, write a small grep test that reads the source file and asserts the strings `detached: true`, `stdio: 'ignore'`, and `.unref()` appear in `schedule-executor.ts` — that at least fails when someone removes them.

### MEDIUM

**`EvalResult.decision field` tests verify TypeScript compilation, not runtime behaviour** — Confidence: 92%
- `tests/unit/services/eval-domain-batch2.test.ts:612-645` (4 tests in `describe('EvalResult.decision field')`)
- Problem: Each test constructs an `EvalResult` literal and asserts the field round-trips through `expect(result.decision).toBe(...)`. There is no production code under test; tsc would catch any incompatible literal, and the runtime checks are tautological. Same critique applies to `describe('jsonSchema in Task domain', ...)` (lines 651-668) — both tests just call `createTask({...})` and read back the field that was set.
- Fix: Drop the EvalResult literal-shape tests entirely (TypeScript covers them). Keep `jsonSchema in Task domain` only if `createTask` does any normalization/defaulting on `jsonSchema` — otherwise drop those too. Spend the saved test budget on driving these fields through the loop handler / spawn pipeline where they actually matter (the v1.4.0 spawn-chain tests in agent-adapters cover the `jsonSchema` plumbing already).

**Pure-fn signal handler tests still spy on the global `process.exit`, defeating the DI rationale** — Confidence: 88%
- `tests/unit/services/schedule-executor-pure-fns.test.ts:163, 176, 190`
- Problem: The test file's intro says "Uses … injected fake process for `registerSignalHandlers` … to avoid polluting signal handlers between tests." The fake-process injection works for `proc.on(...)`, but the handler implementation calls the real `process.exit(0)` — so three of the six `registerSignalHandlers` tests still need `vi.spyOn(process, 'exit')`. That isn't wrong, but it means the tests *only* avoid polluting `process.on` listeners, not `process.exit` itself; if a future change forgets to restore the spy, sibling tests can be killed by a real exit. The `exitCleanly` closure also captures `process.stderr.write` directly without a fake, so any test that triggers a signal noise-pollutes test output.
- Fix: Push exit and stderr behind the same DI seam as `proc.on`. Either (a) accept the full `Pick<NodeJS.Process, 'on' | 'exit' | 'stderr'>` shape so all three boundaries are mockable, or (b) accept an `onExit: (code: number) => void` callback alongside `cleanup` and let production wire it to `process.exit`. The current design tests one of three side-effects with DI and the other two with global spies — pick one model.

**`evaluateWithCompletions` helper relies on `setImmediate` ticks for sequencing — fragile under timer mocks** — Confidence: 80%
- `tests/fixtures/eval-test-helpers.ts:155-164`
- Problem: The helper sequences phases by awaiting `new Promise(r => setImmediate(r))` between simulateFns. This works against real timers, but several callers (e.g. `eval-task-waiter.test.ts`) use `vi.useFakeTimers()` in sibling describes; if a future caller installs fake timers in a `beforeAll` or accidentally leaves them on, `setImmediate` is mocked and the helper will hang or skip phases without explanation. The judge-evaluator file currently doesn't use fake timers, so this is latent rather than active. The helper also re-spies on `eventBus.emit` every call without restoring — if a single test invokes it twice, the second `vi.spyOn` stacks on top of the first.
- Fix: (a) Document the fake-timer constraint at the top of the helper (or use `vi.advanceTimersToNextTimerAsync()` when fake timers are detected). (b) Restore the spy at the end of the helper (try/finally with `mockRestore`) so callers can re-invoke without state bleed.

**Pipeline `setTimeout` cooldown test cannot fail for the right reason** — Confidence: 80%
- `tests/unit/services/handlers/loop-handler.test.ts:651-668` (`Cooldown > should use setTimeout when cooldownMs > 0`)
- Problem: The assertion is `expect(updatedLoop!.currentIteration).toBe(1)` after a 999999 ms cooldown. That passes whether `setTimeout` is used, whether the iteration is silently dropped, whether the next iteration crashes during scheduling, or whether the handler simply ignores cooldownMs. Test name promises "uses setTimeout"; assertion only proves "did not advance synchronously". A regression that, e.g., never schedules iteration 2 at all would still pass.
- Fix: Use `vi.useFakeTimers()` and assert that advancing by `cooldownMs - 1` keeps `currentIteration === 1`, advancing by `cooldownMs + 1` advances to `2`. That actually proves the timer-based scheduling.

---

## Issues in Code You Touched (Should Fix)

### HIGH

**Recovery tests don't assert the recovery side-effect they claim to test** — Confidence: 82%
- `tests/unit/services/handlers/loop-handler.test.ts:699-749` (`Recovery (R3) > should rebuild taskToLoop maps from DB on startup`)
- Problem: The test sets up DB state, creates a fresh `LoopHandler`, then asserts `expect(newHandlerResult.ok).toBe(true)` and stops. The body comment says "The handler's logger should mention rebuilt maps / The task-to-loop map should be populated (we can verify by checking that a TaskCompleted event for this task is handled)" — but neither check is implemented. The test name promises map rebuild; the assertions only prove the constructor returned ok.
- Fix: Either (a) emit `TaskCompleted` for the recovery task and assert the loop advances (proving the map was rebuilt), or (b) drop the test and rely on the Fix J/K/L recovery tests below it that *do* assert downstream state changes.

### MEDIUM

**Several judge-evaluator tests share a magic 2-element simulateFns array without commentary on phases** — Confidence: 78%
- `tests/unit/services/judge-exit-condition-evaluator.test.ts` (most tests)
- Problem: Every test passes `[(id) => simulateTaskComplete(eventBus, id), (id) => simulateTaskComplete(eventBus, id)]` — meaning "complete phase 1, complete phase 2". Future maintainers reading the test won't immediately know which simulateFn corresponds to which phase, and a dropped element silently changes which phase short-circuits.
- Fix: Wrap the magic array in a small helper, e.g. `bothPhasesComplete(eventBus)` and `evalPhaseCompletesJudgeFails(eventBus)`. Reuse them across all 11 tests in the file.

**Spawn-options assertions in agent-adapters tests rely on positional indexing into mock.calls** — Confidence: 80%
- `tests/unit/implementations/agent-adapters.test.ts:114, 131, 201, 249, 361, etc.`
- Problem: Tests reach into `mockSpawn.mock.calls[0][2]` to grab the `options` argument. The migrated production code now passes a single `SpawnOptions` object to `adapter.spawn(...)`, but the underlying `child_process.spawn(...)` mock still receives positional `(command, args, options)`. If a refactor reorders or splits those positional args, every assertion silently reads the wrong slot. There is no schema check that slot 2 is actually the env-bearing options object.
- Fix: Extract a helper at the top of the file: `function getSpawnEnv(call = 0) { const opts = mockSpawn.mock.calls[call][2] as { env?: Record<string,string> }; if (!opts?.env) throw new Error('spawn options missing env'); return opts.env; }`. Then `expect(getSpawnEnv().AUTOBEAT_WORKER).toBe('true')` can't be silently corrupted.

---

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`loop-handler.test.ts` is 2,057 lines and 70 `it()` blocks in one file** — Confidence: 85%
- `tests/unit/services/handlers/loop-handler.test.ts`
- Problem: This is the largest test file in the repo, mixing v0.7-v1.4 features (basic lifecycle, optimize, pipelines, cooldown, cancel, recovery, pause/resume, git, decision-field branching). A grouped `npm run test:handlers` will pull this whole file into one fork — relevant given the 1GB `vmMemoryLimit` hard-kill noted in CLAUDE.md. New tests in this PR (decision-field branching, ~10 tests) are well-structured but pile onto an already-large file.
- Fix: Split into `loop-handler.lifecycle.test.ts`, `loop-handler.recovery.test.ts`, `loop-handler.git.test.ts`, `loop-handler.decision.test.ts`. Each file independently mocks `git-state` to keep mocks file-scoped (which is the pattern already in place — splitting actually reduces contamination risk). Out of scope for this PR but noted.

**`agent-adapters.test.ts` uses module-level `vi.mock('child_process')` then a separate `vi.mock('../../../src/core/agents', …)`** — Confidence: 75%
- `tests/unit/implementations/agent-adapters.test.ts:23-36`
- Problem: The eval-test-helpers reconciliation explicitly avoids `vi.mock` due to module-registry contamination in `--no-file-parallelism` runs. This file uses two `vi.mock` calls at module scope that mock `child_process` and `core/agents`. If any sibling test file in the same run imports `child_process` for real (e.g. integration tests) the mocked `spawn` could leak into them. The file isn't new, but the new spawn-options migration broadens its surface.
- Fix: (separate PR) Migrate adapter tests to use the same fs-injection / spawner-injection pattern that judge-evaluator now follows. The `BaseAgentAdapter` could accept a `spawn` parameter for tests instead of importing `child_process` directly. Out of scope here.

### LOW

**`hasLogContaining` assertions create fragile coupling to log message strings** — Confidence: 70%
- `tests/unit/services/handlers/loop-handler.test.ts:166, 200`
- `tests/unit/services/eval-task-waiter.test.ts:207, 223, 260`
- Problem: Assertions like `expect(logger.hasLogContaining('Eval task completion timed out by fallback timer')).toBe(true)` couple tests to exact substrings. A minor wording change in production breaks tests without indicating any behavioural regression. This is a stylistic preference common across the codebase, so flagged as LOW.
- Fix: Use a structured-log assertion helper — e.g. `logger.hasLogWithKey('event', 'eval_timeout_fallback')` once events are tagged with stable keys. Out of scope for this PR.

---

## Suggestions (Lower Confidence)

- **Helper `evaluateWithCompletions` uses generic `T extends { evaluate(...) }` but signature drift won't be caught** - `tests/fixtures/eval-test-helpers.ts:135-143` (Confidence: 65%) — A new evaluator with an extra arg compiles silently against the structural constraint; consider a stricter `ExitConditionEvaluator` constraint.
- **`schedule-executor-pure-fns.test.ts` startIdleCheckLoop tests check `clearInterval(timer)` works but don't assert `.unref()` is called** - `tests/unit/services/schedule-executor-pure-fns.test.ts:204-330` (Confidence: 65%) — Production calls `idleCheckTimer.unref()` for graceful exit; no test pins this contract.
- **Judge evaluator test uses `outputRepoPhase1.get(undefined as unknown as ReturnType<typeof TaskId>)` to bypass typing** - `tests/unit/services/judge-exit-condition-evaluator.test.ts:243-245` (Confidence: 60%) — The double-cast to satisfy the get() signature is a smell; consider a `taskId(any)` helper or a stub that doesn't require the parameter.

---

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 3 | 3 | 0 |
| Should Fix | - | 1 | 2 | - |
| Pre-existing | - | - | 2 | 1 |

**Testing Score**: 7/10

**Recommendation**: CHANGES_REQUESTED

### Rationale

The PR adds 57 high-quality tests for genuinely tricky surface area (event-driven evaluators, two-phase judge with TOCTOU defenses, pure-fn extractions for testability). Most of the new code follows the project's behavior-over-implementation philosophy and the eval-test-helpers reconciliation is a model of careful test refactoring with documented decisions.

Three concerns block a clean approval:

1. The `acquirePidFile` test suite verifies every code path *except* the atomicity guarantee that justifies the helper's existence. One additional test fixes this and proves the O_EXCL contract.
2. Two tautological test groups (`Feedback accumulation cap`, `EvalResult.decision field`) inflate the green count without verifying production behaviour. They should be either removed or rewritten to drive real code paths.
3. The `expect(true).toBe(true)` placeholder in `schedule-executor-autostart.test.ts` is a documented anti-pattern that should not ship.

The spawn-site migration (~92 sites) appears clean — `agent-adapters.test.ts` was migrated wholesale to the new `SpawnOptions` object form, and its 43 tests rebuild meaningful coverage of the structured argument. No tests appear to have been weakened during the migration.

The `eval-test-helpers.ts` no-`vi.mock` discipline is sound and the contamination rationale is well-documented. The injected-fs DI pattern in `JudgeExitConditionEvaluator` is the right architectural choice and tests demonstrate it correctly. Pure-fn extraction in `schedule-executor` is also well-tested with fake timers and an injected fake process — a clear improvement over spying on globals.

### Files Reviewed

- `tests/fixtures/eval-test-helpers.ts` (new, 196 lines)
- `tests/unit/services/eval-task-waiter.test.ts` (new, 328 lines, 16 tests)
- `tests/unit/services/schedule-executor-pure-fns.test.ts` (new, 330 lines, 21 tests)
- `tests/unit/services/handlers/loop-handler.test.ts` (~290 lines added, 70 tests total)
- `tests/unit/services/judge-exit-condition-evaluator.test.ts` (refactored, 295 lines, 11 tests)
- `tests/unit/services/eval-batch3.test.ts` (refactored, 373 lines, 19 tests)
- `tests/unit/services/eval-domain-batch2.test.ts` (refactored, 716 lines, 33 tests)
- `tests/unit/services/schedule-executor-autostart.test.ts` (~132 lines added, 26 tests, includes 6 new acquirePidFile tests)
- `tests/unit/implementations/agent-adapters.test.ts` (~116 lines diff, 43 tests, full SpawnOptions migration)
- `tests/security/resource-exhaustion.test.ts` (timeout schema alignment, 22 tests)
