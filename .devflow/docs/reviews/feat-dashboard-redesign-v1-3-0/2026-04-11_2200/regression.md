# Regression Review Report

**Branch**: `feat/dashboard-redesign-v1.3.0` -> `main`
**Date**: 2026-04-11 22:00
**Scope**: 97 files changed (~12.5k insertions), `git diff main...HEAD`
**Version**: 1.2.0 -> 1.3.0 (minor)

## Methodology

This is a minor version bump. The regression check focuses on whether existing
consumers (npm `autobeat` users, MCP callers, CLI scripts, running schedules,
loops, orchestrations, persisted DB state from v1.2.0) silently break under
v1.3.0. Internal-only refactors that do not cross the public surface are
informational; behavior changes documented in release notes still get listed so
the merge decision is transparent.

The audited public surface for `autobeat@1.x`:
- `bin/beat` CLI commands and flags
- MCP tool names + schemas exported by `mcp-adapter.ts`
- The `main()` export from `src/index.ts` (npm `main`)
- Persisted SQLite DB schema (forward-compat: v1.2.0 rows must work post-migration)
- File-system artifacts: `~/.autobeat/orchestrator-state/`, log paths

Internal modules (`src/cli/dashboard/types.ts`, `src/core/interfaces.ts`,
`src/services/handler-setup.ts`, etc.) are NOT considered public for npm consumers
since `package.json` has no `exports` field but the project does not advertise
them as a stable surface. Test doubles in `tests/fixtures/` and `tests/unit/`
that implement repository interfaces ARE in-tree consumers and are checked.

## Issues in Your Changes (BLOCKING)

### CRITICAL

_None found._

### HIGH

**Cancel cascade default change is observable to MCP consumers** — `src/services/orchestration-manager.ts:396`
**Confidence**: 95%
- Problem: `OrchestrationService.cancelOrchestration(id, reason)` now defaults to
  `cancelAttributedTasks: true`. MCP `CancelOrchestrator` calls the service
  without the new opts (mcp-adapter.ts:2966), so v1.3.0 MCP `CancelOrchestrator`
  cancels the orchestration AND every task with `tasks.orchestrator_id = id`
  that is `queued`/`running`. In v1.2.0, those tasks kept running because no
  attribution column existed.
- Impact: Documented behavior change in `RELEASE_NOTES_v1.3.0.md` ("Cancel
  Cascade" section), but the MCP `CancelOrchestrator` schema does not expose
  the `cancelAttributedTasks` option, so MCP consumers cannot opt out. Practical
  blast radius is bounded: only tasks created in v1.3.0 with attribution
  populated are affected; pre-v1.3.0 tasks have `orchestrator_id IS NULL` and
  are unaffected.
- Fix: Acceptable as-is for a minor bump because the new behavior is the
  documented design and the surface previously had no attribution to cascade
  over. To make the behavior strictly opt-in, expose
  `cancelAttributedTasks: z.boolean().optional().default(true)` on
  `CancelOrchestratorSchema` and forward it through `handleCancelOrchestrator`.

### MEDIUM

**`outputFlushIntervalMs` default lowered 5s -> 1s** — `src/core/configuration.ts:44`
**Confidence**: 95%
- Problem: Default flush interval changed from `5000` to `1000`. This is a 5x
  increase in the rate at which workers persist captured output to SQLite,
  affecting write pressure on systems with many concurrent workers.
- Impact: Documented in `RELEASE_NOTES_v1.3.0.md` under "Breaking Changes" with
  override instructions (`OUTPUT_FLUSH_INTERVAL_MS=5000`). The release-notes
  wording says "may slightly increase database read pressure" which is mildly
  misleading — it is write pressure, not read.
- Fix: Update release-notes phrasing to "write pressure" for accuracy. No code
  fix required; the env override is sufficient escape valve.

**`OrchestrationService.cancelOrchestration` signature widened** — `src/core/interfaces.ts:355`
**Confidence**: 90%
- Problem: Public interface added an optional 3rd parameter. In-tree `OrchestrationManagerService`
  is the only implementation, but anyone building against `OrchestrationService` from
  the dist tree (uncommon, but possible) sees a new optional param. Adding optional
  params to a method signature is structurally backward compatible in TS, so
  callers that pass 2 args still work — no code change required.
- Impact: None at runtime. Interface widening is backward compatible.
- Fix: None required.

**Recovery now auto-fails zombie RUNNING orchestrations on startup** — `src/services/recovery-manager.ts:222`
**Confidence**: 90%
- Problem: New Phase 1d (`failZombieRunningOrchestrations`) traces
  `orchestration → loop → most-recent-iteration → task → worker.ownerPid` and
  marks dead-PID orchestrations as `FAILED`. Conservative path leaves rows
  alone when the chain is broken (`'unknown'` liveness), but a v1.2.0 user
  upgrading with stuck `RUNNING` orchestrations from a prior daemon shutdown
  will see those rows transition to `FAILED` on first v1.3.0 daemon start.
- Impact: This is an intentional fix (referenced as "zombie orchestration
  recovery via worker liveness detection (#134)" in release notes). The
  behavior is positive (clean state, dashboard shows accurate status), but it
  is a state-mutating side effect of upgrade. No data loss — the row is
  preserved in audit trail.
- Fix: None required. The conservative `'unknown'` short-circuit prevents
  false positives. Worth a sentence in release notes that "stuck `RUNNING`
  orchestrations from prior daemon shutdowns will be auto-marked `FAILED` on
  first v1.3.0 startup if the worker PID is no longer alive".

### LOW

**`loop-handler.handleLoopCreated` now propagates errors instead of swallowing them** — `src/services/handlers/loop-handler.ts:194`
**Confidence**: 95%
- Problem: Previously errors from `loopRepo.save()` inside `handleLoopCreated`
  were logged and dropped. Now they `throw result.error`, which the EventBus
  converts into a rejected handler result, surfacing through `emit()`'s `err()`
  return.
- Impact: Both call sites of `emit('LoopCreated', ...)` (`loop-manager.ts:302`
  and `schedule-handler.ts:612`) already check `emitResult.ok` and propagate
  the failure, so this is a positive correctness fix (it prevents orphan loop
  IDs reaching `orchestration-manager.ts` and crashing with FK violations).
  No external regression.
- Fix: None required. This is an intentional behavior fix.

**`createOrchestration` is now compensation-capable on partial failure** — `src/services/orchestration-manager.ts:189-296`
**Confidence**: 92%
- Problem: v1.2.0 left orphan orchestration rows when `loopService.createLoop()`
  failed mid-creation. v1.3.0 marks the orch row as `FAILED` (soft delete) and
  cleans up state files. Adds a conditional update guard against dashboard
  cancellation racing the create flow.
- Impact: Existing callers waiting on the same `Result<Orchestration>` still
  see ok/err with the same shape. Soft-delete (FAILED) means rows remain in
  the DB, which is preferable to hard-delete for audit trail.
- Fix: None required. Positive correctness improvement.

## Issues in Code You Touched (Should Fix)

**`ProcessSpawnerAdapter.spawn()` does not accept the new `orchestratorId` arg** — `src/implementations/process-spawner-adapter.ts:26-33`
**Confidence**: 80%
- Problem: `BaseAgentAdapter.spawn()` and `AgentAdapter.spawn()` interface both
  added an optional `orchestratorId?: string` 5th parameter. `ProcessSpawnerAdapter`
  (which is the test-only compat shim wrapping `MockProcessSpawner`) only
  accepts 4 args. TypeScript accepts this because optional params allow
  narrower implementations. At runtime, when `EventDrivenWorkerPool` calls
  `adapter.spawn(prompt, dir, taskId, model, orchestratorId)` and the adapter
  is `ProcessSpawnerAdapter`, the 5th arg is silently dropped.
- Impact: Production code uses `ClaudeAdapter`/`CodexAdapter`/`GeminiAdapter`
  (all extend `BaseAgentAdapter`, which propagates the env var), so real
  attribution chains are NOT broken. This only affects tests using
  `MockProcessSpawner` — orchestrator attribution will not propagate to
  spawned workers in those tests. Any test that asserts
  `AUTOBEAT_ORCHESTRATOR_ID` propagation through a `MockProcessSpawner` would
  see a silent miss.
- Fix: Update `ProcessSpawnerAdapter.spawn` signature to match the interface
  (add `orchestratorId?: string` and forward to `this.spawner.spawn(...)`).
  Also check whether `ProcessSpawner.spawn` itself needs the 5th arg —
  currently it does not.

**Test doubles claiming to implement `TaskRepository` are missing the new v1.3.0 methods** — `tests/fixtures/test-doubles.ts:332-460`, `tests/unit/services/handlers/worker-handler.test.ts:168-206`
**Confidence**: 95%
- Problem: `TestTaskRepository` and `MockTaskRepo` declare `implements TaskRepository`
  but do not provide the three new v1.3.0 methods: `findByOrchestratorId`,
  `getThroughputStats`, `findUpdatedSince`. `tsconfig.json` excludes `tests/`
  from typecheck, so `npm run typecheck` does not catch this. Vitest uses
  esbuild (no structural type enforcement) so the worker-handler test passes
  at runtime.
- Impact: A future test that uses one of these doubles in a code path which
  calls a missing method will throw `TypeError: ...is not a function` at
  runtime. The misleading `implements` clause hides the gap from anyone
  reading the code.
- Fix: Add the three missing methods to both classes (return empty arrays /
  zero stats) or remove the `implements TaskRepository` clause and use a
  partial type. Recommended: add stub implementations so `Object.keys()`
  introspection still finds the contract.

## Pre-existing Issues (Not Blocking)

_No pre-existing CRITICAL issues introduced by unchanged code paths._

## Suggestions (Lower Confidence)

- **Bootstrap sanity check is brittle to future handler conditionalisation** — `src/bootstrap.ts:441-456` (Confidence: 70%) — The defensive check requires
  `LoopCompleted` to have at least one subscriber, but `LoopCompleted` is only
  subscribed by `OrchestrationHandler`, which is created conditionally on
  `orchestrationRepository` being registered. If a future change makes
  `orchestrationRepository` optional in any bootstrap mode, the sanity check
  silently breaks ALL bootstraps with a misleading error. Consider asserting
  conditional subscribers conditionally, or document the implicit dependency
  in the comment block.

- **`AgentAdapter.spawn` overloads do not enforce attribution propagation** — `src/core/agents.ts:247-253` (Confidence: 65%) — The 5th param is optional, so
  any implementation that simply omits it (like `ProcessSpawnerAdapter`)
  passes typecheck. A discriminated overload (separate methods for "spawn root"
  vs "spawn child of orch") would make missing attribution a compile error
  rather than a silent runtime drop.

- **`useDashboardData` 3rd param defaults to 0 silently** — `src/cli/dashboard/use-dashboard-data.ts:376` (Confidence: 60%) — The new
  `orchestrationChildPage = 0` default means stale callers passing only 2
  args reset to page 0 every render, which is fine for now but obscures the
  pagination state. Consider making the param required and threading it
  explicitly from `app.tsx` (which already does).

## Migration / DB Compatibility

| Area | Change | v1.2.0 -> v1.3.0 compat |
|------|--------|--------------------------|
| `tasks.orchestrator_id` (migration v18) | Nullable column added, partial index on non-null | ✅ Existing rows get `NULL`, no migration risk |
| `task_usage` table (migration v19) | New table, PK/FK `task_id`, cascade-delete | ✅ Empty on first start, populated by `UsageCaptureHandler` going forward |
| `tasks.dependencies` JSON column | Unchanged | ✅ |
| `orchestrations` schema | Unchanged | ✅ `updateIfStatus` is read-modify-write on existing columns |
| `loops` schema | Unchanged | ✅ `findUpdatedSince` is a read query against `updated_at` |
| `schedules` schema | Unchanged | ✅ Same |
| `workers` schema | Unchanged | ✅ |
| `task_checkpoints` schema | Unchanged | ✅ |

Both new migrations (v18, v19) are additive, idempotent (`CREATE TABLE IF NOT EXISTS`,
`ALTER TABLE ... ADD COLUMN`, `CREATE INDEX IF NOT EXISTS`), and applied in
incrementing order by `Database.applyMigrations`. A v1.2.0 DB upgraded to v1.3.0:
1. Migration v18 adds `orchestrator_id TEXT REFERENCES orchestrations(id) ON DELETE SET NULL` to `tasks` (NULL for all existing rows).
2. Migration v19 creates `task_usage` (empty).

A v1.3.0 -> v1.2.0 downgrade is NOT supported by either migration (no `down`
function), but autobeat does not advertise downgrade compatibility.

## Public API Surface Change Audit

### CLI flags / commands

| Item | Status |
|------|--------|
| `beat run` | Unchanged flags. New behavior: reads `AUTOBEAT_ORCHESTRATOR_ID` env var, validates against DB, drops stale ones with stderr warning. Backward compatible — env var is ignored if not set. |
| `beat dashboard` | Unchanged flags. New behavior: full bootstrap (mode='cli') instead of `createReadOnlyContext()`, ~200-500ms slower startup. New stderr line `[dashboard] logs → ~/.autobeat/dashboard.log` printed before alt-screen. New keybindings `c`, `d`, `m`, `v`, `w`, `g`/`G`, `[`/`]` added (no existing keys removed). |
| `beat dashboard logs path` | N/A — printed via stderr only. |
| `beat orchestrate` / `beat orchestrate --foreground` | Unchanged flags. Compensation pattern on failure, but `Result` shape unchanged. |
| `beat schedule *` / `beat loop *` | Unchanged. |

### MCP tools

| Tool | Status |
|------|--------|
| `DelegateTask` | New optional `metadata.orchestratorId` field. Schema accepts old shape (no `metadata`). Validated against DB; stale IDs dropped silently with logger.warn. **Backward compatible.** |
| `CancelOrchestrator` | Schema unchanged. Behavior change: cancels attributed sub-tasks by default. Documented in release notes. Power users cannot opt out via MCP. **Behavior change, schema unchanged.** |
| All other MCP tools | Unchanged. |

### Dashboard keybindings (user-facing)

| Key | v1.2.0 | v1.3.0 |
|-----|--------|--------|
| `q` | quit | quit |
| `r` | refresh | refresh |
| `f` | filter | filter |
| `Tab` / `Shift+Tab` | cycle panels | cycle panels (now also activity panel) |
| `j`/`k` / arrows | navigate | navigate |
| `Enter` | open detail | open detail |
| `Esc` / `Backspace` | back | back |
| `pageUp`/`pageDown` | page | page |
| `c` | — | **NEW**: cancel focused entity (when mutations available) |
| `d` | — | **NEW**: delete terminal entity (when mutations available) |
| `m` | — | **NEW**: jump to metrics view |
| `v` | — | **NEW**: toggle main/workspace |
| `w` | — | **NEW**: jump to workspace |
| `g` / `G` | — | **NEW**: goto top / bottom |
| `[` / `]` | — | **NEW**: page navigation in orchestration detail |

**No existing keybindings removed or changed.** All changes are additive. Safe.

### Repository interfaces (in-tree only — not advertised npm surface)

| Interface | v1.3.0 added | v1.3.0 removed |
|-----------|--------------|-----------------|
| `TaskRepository` | `findByOrchestratorId`, `getThroughputStats`, `findUpdatedSince` | none |
| `ScheduleRepository` | `findUpdatedSince` | none |
| `LoopRepository` | `findUpdatedSince` | none |
| `OrchestrationRepository` | `updateIfStatus`, `getOrchestratorChildren`, `countOrchestratorChildren`, `findUpdatedSince` | none |
| `OrchestrationService` | optional 3rd param to `cancelOrchestration` | none |
| `UsageRepository` | NEW interface | n/a |
| `EventBus` (`InMemoryEventBus`) | `getSubscriberCount` | none |

External implementers of these interfaces (none known on npm) would break,
but in-tree implementations are all updated. The two test doubles
(`TestTaskRepository`, `MockTaskRepo`) silently miss the new methods because
tests are excluded from `tsc`. See "Should Fix" section.

### Removed / renamed exports

| Item | v1.2.0 location | v1.3.0 status |
|------|-----------------|----------------|
| `MainView` | `src/cli/dashboard/views/main-view.tsx` | **DELETED**. No in-tree imports remain. Documented in release notes. Internal-only. |
| `MainView` test | `tests/unit/cli/dashboard/main-view.test.tsx` | **DELETED**. Replaced by `metrics-view.test.tsx`. |
| `ViewState.detail` (no `returnTo`) | `src/cli/dashboard/types.ts` | Variant now requires `returnTo` field. Only constructed in-tree (`useKeyboard`, `app.tsx`, tests — all updated). |
| `NavState` interface | `src/cli/dashboard/types.ts` | 4 new required fields (`activityFocused`, `activitySelectedIndex`, `orchestrationChildSelectedTaskId`, `orchestrationChildPage`). Internal-only, all in-tree constructions updated. |
| `ReadOnlyContext` interface | `src/cli/read-only-context.ts` | 2 new required fields (`workerRepository`, `usageRepository`). All in-tree constructions updated. |

## Bootstrap / mode-handling regressions

The `BootstrapMode` enum (`'server' | 'cli' | 'run'`) is unchanged. All three
modes are still routed through `bootstrap()` and produce a populated container.

| Mode | v1.2.0 | v1.3.0 | Risk |
|------|--------|--------|------|
| `server` | Full subsystems incl. recovery, scheduler | Same + new zombie orch detection in recovery | Low — additive |
| `cli` | Skip recovery + executor | Same | None |
| `run` | Skip executor + monitoring | Same | None |

**Critical fix in bootstrap**: Handler subscription was previously inside the
`taskManager` singleton factory (v1.2.0). Callers resolving any other service
without first resolving `taskManager` (e.g., `beat orchestrate --foreground`
which uses `orchestrationService`) left the `EventBus` with zero subscribers,
causing `LoopCreated` events to be lost and FK constraint violations downstream.
v1.3.0 wires handlers eagerly at bootstrap time. The new
`bootstrap-handler-wiring.test.ts` integration test guards against regression.

This means **v1.3.0 fixes a latent v1.2.0 bug** rather than introducing a
regression. Users who were silently affected by the bug will notice
correct behavior. Users who happened to always resolve `taskManager` first
notice nothing.

The new defensive sanity check at `src/bootstrap.ts:441-456` asserts that
`LoopCreated`, `TaskQueued`, and `LoopCompleted` have at least one subscriber
each. All three are subscribed by handlers that are unconditional in current
bootstrap.ts, so the check passes for all modes. See Suggestions for the
brittleness concern about `LoopCompleted` (subscribed only by the conditional
`OrchestrationHandler`).

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 3 | 2 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Regression Score**: 8/10
**Recommendation**: **APPROVED_WITH_CONDITIONS**

### Why APPROVED_WITH_CONDITIONS, not BLOCK:

1. **No exports removed from public surface**. `MainView` removal is internal,
   `cancelOrchestration` widening is backward compatible.
2. **No required parameters added to public APIs**. The MCP `DelegateTask`
   schema and CLI flags are unchanged or additive.
3. **DB migrations are additive and idempotent**. v1.2.0 -> v1.3.0 schema
   change is safe (nullable column + new table).
4. **Behavior changes are documented in `RELEASE_NOTES_v1.3.0.md`**:
   `outputFlushIntervalMs` default, cancel cascade, dashboard redesign,
   zombie orchestration recovery.
5. **All existing dashboard keybindings preserved**. New keys are additive.
6. **CLI flags / behavior unchanged or strictly additive**.
7. **Bootstrap fixes a latent v1.2.0 bug** (eager handler wiring). This is
   a positive correctness improvement, not a regression.

### Conditions for merge:

1. **(Optional, recommended)** Update test doubles `TestTaskRepository` and
   `MockTaskRepo` to add stub implementations of the three new
   `TaskRepository` methods, OR remove the `implements TaskRepository` clause
   to make the partial nature explicit. Failing tests would block this in
   future PRs that exercise the missing methods.
2. **(Optional)** Update `ProcessSpawnerAdapter.spawn()` to accept and forward
   the new `orchestratorId` param so test paths using `MockProcessSpawner`
   correctly propagate attribution.
3. **(Optional)** Fix release-notes phrasing for `outputFlushIntervalMs`:
   "increase database write pressure" instead of "read pressure".
4. **(Optional)** Add a sentence to release notes about the
   recovery-on-startup auto-FAIL of zombie `RUNNING` orchestrations from prior
   v1.2.0 daemon shutdowns.

None of the above are blockers. Merge is safe under v1.2.0 -> v1.3.0 minor
bump semver semantics. The largest behavior shift (cancel cascade) is
documented as a desired new default and the surface for it (`tasks.orchestrator_id`)
did not exist in v1.2.0, so the cascade has nothing to cascade over for
pre-upgrade tasks.
