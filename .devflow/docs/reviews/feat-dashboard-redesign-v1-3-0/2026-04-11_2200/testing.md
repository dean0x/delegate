# Testing Review Report

**Branch**: feat/dashboard-redesign-v1.3.0 -> main
**Date**: 2026-04-11 22:00
**Diff command**: `git diff main...HEAD`
**PR**: dean0x/autobeat#133 "feat: dashboard redesign v1.3.0"
**Reviewer focus**: testing (devflow:testing pattern + project test conventions)

## Summary of changes reviewed
- 22 unit test files added/modified under `tests/unit/cli/dashboard`, `tests/unit/implementations`, `tests/unit/services`
- 4 new integration test files (`tests/integration/{bootstrap-handler-wiring, flush-interval-benchmark, orchestration-workspace, orchestrator-id-propagation}.test.ts`) and 1 modified (`orchestration-lifecycle`)
- 1 test file deleted (`tests/unit/cli/dashboard/main-view.test.tsx`, paired with deleted source)
- ~12,498 LOC added across src + tests; test count for `test:dashboard` jumped to 520 in 25 files

## Issues in Your Changes (BLOCKING)

### CRITICAL

**Integration test suite is non-deterministic — OOM kills 2–6 tests per run**
**Confidence**: 95%
**Locations**: `tests/integration/` (suite-wide), exposed by added test files
- Problem: Reproduced 4 consecutive runs of `npm run test:integration` on this branch and observed differing test totals each time (86/88, 84/86, 81/83, 81/87). Each run reports `1 error: Worker terminated due to reaching memory limit: JS heap out of memory` and **silently drops 2–6 tests** from the run while still reporting "11 passed (12)" — there are 13 integration test files in the directory but only 11 reach completion. Running `event-flow.test.ts` and `worker-pool-management.test.ts` in isolation passes cleanly, so the failure is cumulative memory pressure during the full suite. On `main` (9 files, 75 tests) the OOM message also appears but no tests are dropped — so the 4 new test files added by this PR push the suite over the threshold. CI may report green when the dropped tests would otherwise fail.
- Impact: Loss of test signal. Tests added in this PR look like they pass while their integration peers silently disappear from the count. Vitest's exit-code reporting on test workers terminating is not reliable here — `Tests 81 passed (87)` does not flag the gap because the harness counts the `(87)` as planned, not failed.
- Fix:
  1. Reduce per-test memory growth by ensuring every test that creates a `Database(':memory:')` calls `db.close()` and disposes the EventBus. Audit `tests/integration/orchestration-workspace.test.ts` (creates 7 SQLite repos per test in `beforeEach`), `bootstrap-handler-wiring.test.ts` (calls real `bootstrap()` with `mode: 'run'` which wires every handler), `orchestrator-id-propagation.test.ts`, and `flush-interval-benchmark.test.ts`.
  2. Lower `vmMemoryLimit` per worker but enable `restartWorkerOnTimeout` so the suite recovers between files (currently `vmMemoryLimit: '1024MB'` but workers don't restart between integration files).
  3. Investigate `bootstrap-handler-wiring.test.ts` — calling the real `bootstrap()` likely retains references to all subscribed handlers; adding `await container.dispose()` on the failure path inside `if (!eventBusResult.ok) return;` is missing (lines 49–67 + 84–87 only dispose on the happy path).
  4. Verify locally with `npm run test:integration` — must report identical totals across 3 runs before merge.

### HIGH

**Orphaned hook tests: useTaskOutputStream React hook is never invoked in its test file**
**Confidence**: 100%
- `tests/unit/cli/dashboard/use-task-output-stream.test.ts:1-247`
- Problem: The PR adds 371 LOC of source for `useTaskOutputStream` and 246 LOC of "tests", but `grep useTaskOutputStream(` returns 0 invocations of the actual hook. Only the four exported pure helpers (`stripAnsi`, `mergeOutputLines`, `buildStreamState`, `shouldPollThisTick`) are exercised. The ~150 lines of stateful polling logic in `useTaskOutputStream` (lines 220–371 of `src/cli/dashboard/use-task-output-stream.ts`) — the `useEffect` polling loop, `closingRef` cleanup-on-unmount, `fetchingRef` overlap guard, error path from `outputRepo.get()`, terminal-task one-shot fetch via `terminalFetchedRef`, taskIds change detection — has **zero test coverage**. The mocked `OutputRepository` factory at line 22–30 is created but never wired to a `renderHook(useTaskOutputStream(...))` call.
- Impact: The polling cadence, ring-buffer integration, error handling, and unmount safety of the production code path are not tested. A regression where `closingRef` is not cleared, where overlapping polls cause race conditions, or where `outputRepo.get()` rejection is mishandled will not be caught by this test file.
- Fix: Use `ink-testing-library`'s `render()` with a wrapper component that calls `useTaskOutputStream(mockRepo, taskIds, statuses, true)` and assert via the captured `streams` Map. At minimum cover: (a) successful poll updates lines, (b) terminal task gets exactly one final fetch then no more, (c) `outputRepo.get()` rejection sets `error` field, (d) unmount sets `closingRef.current = true` and pending `setVersion` calls do not throw.

**Bootstrap handler-wiring test asserts on internal subscriber count (magic number 3)**
**Confidence**: 90%
- `tests/integration/bootstrap-handler-wiring.test.ts:97`
- Problem: `expect(loopCreatedCount).toBeLessThanOrEqual(3)` couples the test to the **implementation detail** of how many handlers internally subscribe to `LoopCreated`. If a future refactor merges two handlers (count drops to 2) or splits one (count rises to 4), the test fails even though the regression guard (handlers must be subscribed at least once) still holds. The "do not double-subscribe" intent should be expressed by emitting a `LoopCreated` event and asserting that exactly one loop row is persisted, not by inspecting the subscription count.
- Impact: Brittle test that breaks on harmless refactors and gives the wrong signal — counts are not behavior.
- Fix: Replace the `toBeLessThanOrEqual(3)` assertion with a behavioral check: emit a `LoopCreated` event via `eventBus.emit(...)`, then `findById` the loop and assert it was persisted exactly once (FK-safe insert, no duplicate row error).

**Hardcoded process.env mutation in bootstrap-handler-wiring without isolation**
**Confidence**: 90%
- `tests/integration/bootstrap-handler-wiring.test.ts:24-39`
- Problem: The test mutates `process.env['AUTOBEAT_DATABASE_PATH']` in `beforeEach` and restores in `afterEach`. This is shared mutable global state — even though Vitest is configured with `maxWorkers: 1`, Vitest's `isolate: false` means the env mutation leaks into any subsequent test in the same worker that reads `AUTOBEAT_DATABASE_PATH` before its own setup runs. Combined with a thrown error inside the test body (e.g., the `await rm(tempDir)` failing on Windows), the env restore is skipped because `afterEach` runs in a try/catch but the `else if` branch checks `originalEnv['AUTOBEAT_DATABASE_PATH']` which might already have been set by a parallel suite. Tests should not depend on env vars at all — they should pass `databasePath` through configuration.
- Impact: Hidden test ordering coupling; if the test fails with an unrelated error before `afterEach` cleanup runs, every subsequent integration test in the run sees a polluted env.
- Fix: Remove env mutation entirely. Pass the `databasePath` as a `bootstrap()` option instead of via env var, or use `vi.stubEnv('AUTOBEAT_DATABASE_PATH', ...)` which Vitest auto-restores. The latter is a one-line change.

**Recovery-manager-orchestration test uses real `process.kill(999999, 0)` for the "dead PID" case**
**Confidence**: 85%
- `tests/unit/services/recovery-manager-orchestration.test.ts:281-317`
- Problem: The "dead worker PID" test (line 287) hardcodes `ownerPid: 999999` because `RecoveryManager.isProcessAlive` is a private method that calls `process.kill(pid, 0)` directly — there is no DI seam for `isProcessAlive` on the `RecoveryManager` class (only the `checkOrchestrationLiveness` standalone helper accepts injection). On macOS with default `kern.maxproc=2048` PID 999999 is reliably dead, but on Linux containers with `pid_max=4194304` and a busy workload, PID 999999 may belong to a real process — and the test would falsely fail (expect dead, got live). The CI memory mentions `worker-pool-management.test.ts:157` is already flaky for similar reasons. This adds another timing/PID-space coupling.
- Impact: Flaky test on Linux CI with large PID space; non-deterministic failures depending on host PID assignments.
- Fix: Either (a) refactor `RecoveryManager` to accept `isProcessAlive: (pid: number) => boolean` as a constructor dependency (consistent with `checkOrchestrationLiveness`), or (b) use a PID guaranteed to be unsignal-able on every platform — `process.kill(0, 0)` with PID 0 is the current process group, so use `Number.MAX_SAFE_INTEGER` or fork+kill a real child for the test fixture.

**`expect(secondState.lines).toEqual(['first_NOT_PRESENT', 'line1', 'line2'].slice(1))` is misleading and likely a debug remnant**
**Confidence**: 100%
- `tests/unit/cli/dashboard/use-task-output-stream.test.ts:156`
- Problem: The literal `['first_NOT_PRESENT', 'line1', 'line2'].slice(1)` evaluates to `['line1', 'line2']`. This is a roundabout, confusing way to write the expected value — it looks like a copy-paste artifact from debugging where the dev was checking which element was missing. It's correct, but it raises immediate suspicion in code review and could easily be interpreted as a bug.
- Impact: Reviewer confusion, future maintainer waste; reads like a typo.
- Fix: Replace with `expect(secondState.lines).toEqual(['line1', 'line2'])`. Same effect, no obfuscation.

**File-logger error-fallback test depends on `/root/cannot-write-here/test.log`**
**Confidence**: 80%
- `tests/unit/implementations/file-logger.test.ts:141-150`
- Problem: The test `falls back to SilentLogger when file cannot be opened` hardcodes `/root/cannot-write-here/test.log` to force `mkdir` failure. On macOS as the developer user this path is unwritable so `mkdir` fails — fallback works. On Linux containers running tests as root (common in CI), `mkdir -p /root/cannot-write-here` will succeed because root owns `/root` and can create child directories. Then `open(...)` will succeed too, no fallback engages, and the test will fail with "expected SilentLogger, got FileLogger" — or worse, accidentally write to the host filesystem.
- Impact: Platform-specific flaky test; fails or pollutes host on root-running CI.
- Fix: Use a deterministically-unwritable path. Options: (a) `path.join(os.tmpdir(), 'definitely-not-a-dir-' + Date.now(), '\0invalid', 'test.log')` (NUL byte in the directory name forces ENOENT), (b) Mock `fs/promises.mkdir` to reject with `EACCES`, (c) Use `chmod 0000` on a tmp directory then use it as parent.

**`tests/unit/cli/dashboard/use-keyboard.test.tsx` uses `setTimeout(10ms)` per keystroke (18 calls)**
**Confidence**: 80%
- `tests/unit/cli/dashboard/use-keyboard.test.tsx:231-240` (the `press` helper) and 18 callsites
- Problem: The `press()` helper sleeps for 10ms after each keystroke to "cover ink's escape-sequence debounce on Linux CI runners" (per the comment). With 72 tests in this file, this introduces ~720ms+ of fixed latency per run, and on slow/loaded CI runners 10ms may be insufficient when JIT warm-up or GC kicks in. Compounded with additional 20ms `setTimeout` waits in cancel/delete tests (lines 591, 606, 622, etc., 12 callsites), the suite is timing-coupled. The justification ("ink's escape-sequence debounce") is real, but the fix relies on a magic constant that will eventually drift.
- Impact: Latent flake risk on CI; slow test execution.
- Fix: Replace timing-based waits with deterministic flushing. Options: (a) Use `vi.useFakeTimers()` and `await vi.runAllTimersAsync()` to advance ink's internal debounce instantly, (b) `vi.waitFor(() => expect(lastFrame()).toContain('panel:tasks'))` which polls until the assertion passes or times out, (c) Read ink's actual debounce delay from a constant and reuse it. Option (b) is the lowest-risk swap and removes all 18 setTimeout calls.

## Issues in Code You Touched (Should Fix)

### HIGH

**Integration test re-implements `LoopHandler` behavior in `beforeEach` instead of using the real handler**
**Confidence**: 95%
- `tests/integration/orchestration-lifecycle.test.ts:55-72`, `tests/unit/services/orchestration-manager.test.ts:21-40`
- Problem: Both files manually subscribe a mini-handler to `LoopCreated` that calls `loopRepo.save(loop)` — duplicating production `LoopHandler` behavior. The comment "ARCHITECTURE: In production, LoopHandler saves the loop to DB on LoopCreated" admits the duplication. This **violates** the project's documented memory: "Handler test pattern (2026-03-09): Real implementations, not mocks". When `LoopHandler.handleLoopCreated` changes (e.g., adds checkpoint creation, model attribution), these tests will pass with the old behavior — false confidence. The test isn't really verifying the lifecycle integration; it's verifying a synthetic copy of it.
- Impact: Tests miss real handler regressions; the documented project pattern is violated; tests give false signal of integration coverage.
- Fix: Import and instantiate the real `LoopHandler.create({...})` in `beforeEach`, same as `tests/unit/services/handlers/usage-capture-handler.test.ts:51-61` does (which is the model pattern). Wire it to the same `eventBus` and let it process `LoopCreated` events for real. This costs ~5 lines but kills the synthetic handler.

**`tests/unit/cli/dashboard/use-terminal-size.test.ts:170-204`: "rapid resize events" test asserts a value that never changes**
**Confidence**: 95%
- Problem: Test `resets debounce timer on multiple rapid resize events` triggers 3 resize events and asserts `expect(captureRef.current?.columns).toBe(80)` both before AND after debounce flush. The columns value never changes during the test (process.stderr.columns is set to 80 the entire time and never mutated between resizes), so the assertion passes regardless of whether debounce works correctly. The test would pass even if `useTerminalSize` had no debounce at all. **The test name lies about what it verifies.**
- Impact: Zero coverage of the debounce behavior despite the test name claiming otherwise. False sense of safety.
- Fix: Mutate `process.stderr.columns` between resize events (`Object.defineProperty(process.stderr, 'columns', { value: 100, ... })` then trigger resize), then assert columns is still 80 before debounce fires and 100 after. Verify the timing: pre-debounce assertion captures the *old* value; post-debounce captures the *new* value.

**Layout tests assert exact pixel/cell math, breaking on any constant tweak**
**Confidence**: 80%
- `tests/unit/cli/dashboard/layout.test.ts:21-27, 35-39, 49-54`
- Problem: Tests assert exact arithmetic outputs (`panelHeight=6`, `panelWidth=59`, `topRowHeight=8`, etc.) with detailed comments explaining the formula derivation. These tests are coupled to the specific magic numbers in `computeMetricsLayout` — `0.35` (top row ratio), `8` (min top row), `14` (max top row), `90/120` (tile breakpoints). Any UX-driven tweak ("make the top row 30% instead of 35%") forces updating ~30 assertions even though the layout *behavior* (responsive, three modes, clamped bounds) is unchanged.
- Impact: High test maintenance cost on cosmetic tweaks; tests look like they verify behavior but are really verifying constants.
- Fix: Test relationships, not values. Replace `expect(layout.topRowHeight).toBe(8)` with `expect(layout.topRowHeight).toBeGreaterThanOrEqual(8); expect(layout.topRowHeight).toBeLessThanOrEqual(14); expect(layout.topRowHeight + layout.bottomRowHeight).toBe(layout.availableHeight)`. Test the contract (clamps within bounds, sums to available height) instead of the exact output.

### MEDIUM

**`tests/unit/services/recovery-manager-orchestration.test.ts:240`: unused destructured `mocks`**
**Confidence**: 100%
- Problem: `const { recovery, mocks } = makeRecoveryManager(...)` — `mocks` is destructured but never used. Linter (biome) likely flags this. Either remove it or use it for the assertion.
- Fix: `const { recovery } = makeRecoveryManager(...)`.

**Orchestration-detail test "highlights selected child row" only checks substring, not highlighting**
**Confidence**: 90%
- `tests/unit/cli/dashboard/orchestration-detail.test.tsx:230-238`
- Problem: The test passes `childSelectedTaskId="task-sel-002"` and asserts `expect(lastFrame()).toContain('task-sel-0')`. The assertion would pass even if highlighting is broken because the selected row's id is *always* in the rendered output. The test name claims it verifies selection-highlighting; the assertion verifies row rendering.
- Fix: Use ink's color/inverse rendering and assert on the actual highlight markers — e.g., snapshot the row containing 'task-sel-002' and verify it includes ANSI inverse code `\x1b[7m` or whatever marker the component uses for selection.

**`tests/unit/implementations/file-logger.test.ts:117-124`: "dispose flushes remaining buffered writes" misnamed**
**Confidence**: 85%
- Problem: The test name says "flushes remaining buffered writes" but `FileLogger.write()` is fire-and-forget (no application-level buffer — it calls `fileHandle.write(line).catch(...)` directly). `dispose()` calls `fileHandle.sync()` which only forces the kernel to flush its own buffers. The test passes because the single write happens before dispose, but the framing "buffered writes" is wrong — there is no application buffer.
- Fix: Rename to `dispose() ensures pending fs writes are durable before resolving` or test multiple in-flight writes (start 100 writes, immediately dispose, verify all 100 lines are present in the file).

**`tests/unit/implementations/file-logger.test.ts:132-137`: "writes after dispose are silently dropped" doesn't verify the drop**
**Confidence**: 90%
- Problem: The test only checks that `logger.info('after dispose')` doesn't throw. It does not verify the message was actually dropped (no readFile assertion to confirm "after dispose" is absent). The assertion is necessary but not sufficient.
- Fix: Add `const contents = await readFile(LOG_FILE, 'utf-8'); expect(contents).not.toContain('after dispose');`.

**`MAX_LINES_PER_STREAM === 500` test is a brittle constant check**
**Confidence**: 80%
- `tests/unit/cli/dashboard/use-task-output-stream.test.ts:242-246`
- Problem: Tests literally `expect(MAX_LINES_PER_STREAM).toBe(500)`. This is a tautology that breaks on every constant tweak. If 500 is the right number, that's a product decision; the test doesn't verify anything other than that nobody changed the constant.
- Fix: Delete the test, or replace it with a behavioral check that the ring buffer trims at the constant's value (which `trims ring buffer to MAX_LINES_PER_STREAM` already covers).

**`buildStreamState — sets error when provided` is a no-op test**
**Confidence**: 100%
- `tests/unit/cli/dashboard/use-task-output-stream.test.ts:187-194`
- Problem: The test creates a state literal `{ ...EMPTY_INITIAL, error: 'fetch failed' }` and asserts `expect(state.error).toBe('fetch failed')`. It does not call `buildStreamState`. It only verifies that JS object spread works. **This test exercises nothing.**
- Fix: Either delete it or actually call `buildStreamState(prevWithError, output, status)` and verify the error field is preserved in the returned state.

**`orchestrator-id-propagation.test.ts:109` reaches into raw SQL to backdate `created_at`**
**Confidence**: 70%
- Problem: `db.getDatabase().prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(past, oldTask.id)` bypasses the repository abstraction to backdate a row. This couples the test to the column name (`created_at`) and table name (`tasks`). When migration v20+ renames or restructures, the test breaks even though the abstract behavior (`findUpdatedSince` filters by time) is unchanged.
- Fix: Either expose a `taskRepo.testHelper_setCreatedAt(id, ts)` method gated by `NODE_ENV === 'test'`, or use a fake clock and inject `now()` into `createTask` so the test can create an "old" task without manual timestamp injection.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`TEST_DIR` computed at module load time using `Date.now()` (file-logger test)**
**Confidence**: 75%
- `tests/unit/implementations/file-logger.test.ts:12`
- Problem: `const TEST_DIR = path.join(os.tmpdir(), 'file-logger-test-${Date.now()}');` is computed once at module load. With Vitest's `isolate: false`, two test files importing this module would share the same `TEST_DIR` constant. This isn't reached today (only one file imports it), but it's a latent collision. Better hygiene: create a fresh tmpdir per test in `beforeEach` via `mkdtemp`.
- Fix: Use `mkdtemp(join(tmpdir(), 'file-logger-'))` in `beforeEach` and rm it in `afterEach`. Same pattern as `bootstrap-handler-wiring.test.ts:27`.

**`flush-interval-benchmark.test.ts` is misnamed — it's a config schema test, not a benchmark**
**Confidence**: 95%
- Problem: The file is in `tests/integration/` and named `flush-interval-benchmark.test.ts`, but it has 5 tests that all call `ConfigurationSchema.parse({})` and assert on the default value (1000). It does not measure flush interval timing, does not verify the OutputRepository actually flushes at that cadence, and does not run a benchmark. It's a unit-level config-schema test masquerading as an integration benchmark.
- Fix: Rename to `output-flush-interval-default.test.ts`, move to `tests/unit/core/configuration.test.ts` (extending the existing schema tests). If a real flush-cadence integration test is wanted, write one that exercises `SQLiteOutputRepository.append()` with the configured cadence and asserts on the time-to-persist.

**`tests/integration/orchestration-lifecycle.test.ts:185-215`: test relies on `setEmitFailure` magic from `TestEventBus`**
**Confidence**: 65%
- Problem: The compensation test simulates a `LoopCreated` failure by calling `eventBus.setEmitFailure('LoopCreated', true)`. This is a TestEventBus-only escape hatch that doesn't exist on production `InMemoryEventBus`. The test is asserting on compensation behavior in a setup that production never sees. While testing compensation requires injecting failures somehow, the cleaner pattern would be to inject a `loopRepo.save` that returns `err(...)` and let the real handler catch it.

## Suggestions (Lower Confidence)

- **Repetitive `vi.fn().mockResolvedValue({ ok: true, value: undefined })` boilerplate** — `tests/unit/cli/dashboard/use-keyboard.test.tsx:529-536` (Confidence: 70%) — Extract `okMock = () => vi.fn().mockResolvedValue({ ok: true, value: undefined })` to dedupe 8 identical fn definitions.
- **`tests/unit/cli/dashboard/orchestration-detail.test.tsx:174` weak assertion** — Confidence: 65% — `expect(lastFrame()).toBeTruthy()` says nothing about what was rendered. Either remove the test or assert on visible content.
- **`workspace-keyboard.test.tsx:48-53` `INITIAL_NAV: NavState`** — Confidence: 65% — Missing required fields `activityFocused`, `activitySelectedIndex`, `orchestrationChildSelectedTaskId`, `orchestrationChildPage`. Compiles only because `tests/` is excluded from `tsconfig.json` typecheck. Add the missing fields or make them optional in the NavState type. Note: Vitest is currently transpiling away type errors in test files because tsconfig excludes `tests/**` — this PR exposes the gap that test files have no strict type validation.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 1 | 7 | 0 | - |
| Should Fix | - | 3 | 7 | - |
| Pre-existing | - | - | 3 | 0 |

**Testing Score**: 5/10
- Strong points: Most new test files use real SQLite implementations following the project's "Handler test pattern" (e.g., `usage-capture-handler.test.ts` is exemplary). Pure-function helpers (parser, layout, stream) are well-isolated. Behavioral assertions in `use-keyboard.test.tsx` correctly use rendered output rather than internal state.
- Critical concerns: The integration suite is non-deterministic on this branch — silently dropping 2–6 tests per run via OOM. The new `useTaskOutputStream` hook (the largest source addition) has zero tests for its actual hook behavior — only the pure helpers. Synthetic LoopHandler stubs in two integration test files violate the documented "real implementations" memory. Several timing-dependent and constant-coupled tests will become flake/maintenance burdens.
- Blocking issues are concentrated in (a) test infrastructure stability and (b) missing hook coverage. Both are fixable without rewriting test design.

**Recommendation**: CHANGES_REQUESTED

The PR cannot merge until:
1. The integration suite is deterministic (reproduce 3 consecutive identical totals)
2. `useTaskOutputStream` hook has at least 4 behavioral tests for the polling loop (success, terminal one-shot, error, unmount)
3. `bootstrap-handler-wiring.test.ts:97` magic-number assertion is replaced with a behavioral check
4. The misleading `['first_NOT_PRESENT', 'line1', 'line2'].slice(1)` literal at `use-task-output-stream.test.ts:156` is fixed
5. The `/root/...` hardcoded path in `file-logger.test.ts:143` is replaced with a deterministically-unwritable target

Other HIGH/MEDIUM items can be tracked as follow-up but the integration OOM is a release blocker — silently dropping tests means CI green is no longer trustworthy on this branch.
