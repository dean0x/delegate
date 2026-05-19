# Code Review Summary

**Branch**: feat/dashboard-redesign-v1.3.0 -> main  
**PR**: dean0x/autobeat#133  
**Date**: 2026-04-11 22:00  
**Reviewers**: 13 specialized agents (security, architecture, performance, complexity, consistency, regression, testing, typescript, react, accessibility, ui-design, database, documentation)

---

## Merge Recommendation: CHANGES_REQUESTED

The v1.3.0 dashboard redesign delivers substantial user-facing features and demonstrates strong type discipline and architectural patterns in new code. However, the PR has **28 HIGH-severity blocking issues** concentrated in four areas: (1) keyboard handler complexity that will compound in future iterations, (2) performance regressions from incomplete optimization of 1Hz polling queries, (3) critical documentation errors that will break release artifacts, and (4) a non-deterministic test suite that loses signal. These issues are fixable without redesigning the feature—they require targeted refactoring and index additions that can land in this PR or short follow-ups.

---

## Issue Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW | Total |
|----------|----------|------|--------|-----|-------|
| **Blocking** (in YOUR changes) | 0 | 28 | 24 | 5 | **57** |
| **Should Fix** (same file, touched) | 0 | 6 | 20 | 6 | **32** |
| **Pre-existing** (not owned by PR) | 0 | 0 | 9 | 4 | **13** |
| **TOTAL** | **0** | **34** | **53** | **15** | **102** |

---

## Blocking Issues by Focus Area

### Architecture (4 HIGH)

1. **`use-keyboard.ts` is a 1,091-line god module** (95% confidence)  
   - Single file contains all three view handlers (detail, workspace, main) + activity feed mode
   - 381-line `handleMainKeys` function with cyclomatic complexity ~30, 6-level nesting
   - Duplicates entity-action dispatch (Enter/c/d) six times across three handlers
   - **Fix**: Split into `keyboard/{constants, helpers, handle-detail, handle-workspace, handle-main}.ts` + shared `dispatch-cancel.ts`

2. **Hidden behavioral difference: activity-row vs main-panel cancel cascade** (92% confidence)  
   - Activity-row cancel calls `cancelOrchestration(id, reason, { cancelAttributedTasks: true })`
   - Main-panel cancel calls `cancelOrchestration(id, reason)` with no options (relies on hidden service default)
   - Same runtime behavior today, but one config change breaks only one call site
   - **Fix**: Centralize intent in single helper, pass `cancelAttributedTasks: true` explicitly both places

3. **`useDashboardData` reaches 3 layers deep into repositories** (88% confidence)  
   - Hook imports `checkOrchestrationLiveness` (service) + 7 repositories directly
   - Duplicates `isProcessAlive` check vs `RecoveryManager`
   - Aggregates 10 queries, status counts, liveness checks in React hook
   - **Fix**: Extract `DashboardQueryService` with `getMainSnapshot()`, `getWorkspaceSnapshot()`, `getDetailExtras()`, `getOrchestrationLiveness()`

4. **`OrchestrationManagerService.cancelAttributedTasks` violates SRP** (82% confidence)  
   - Service now owns both orchestration lifecycle AND sub-task cascade responsibility
   - Cascade is sequential for-loop that serializes worst-case dashboard response
   - Optional deps (`taskRepository`, `taskManager`) signal graft-on behavior
   - **Fix**: Extract `AttributedTaskCancellationHandler` subscribing to `OrchestrationCancelled` event, or use `Promise.all` with service composition

### Performance (4 CRITICAL, 4 HIGH)

1. **Output streaming re-reads entire buffer every 1s per child** (CRITICAL, 95% confidence)  
   - Comment claims "delta-parse for efficiency" but `OutputRepository.get()` returns full buffer
   - Subsequent slice/parse are memory-side only; I/O still full re-read
   - Cost grows O(N · T) where N = concurrent panels (9 max), T = cumulative output
   - **Fix**: Implement true incremental API (`getSince(taskId, byteOffset)`) or cache + probe-size-first pattern

2. **Activity-feed query fan-out: 7 SQL queries per 1s, 4 unindexed table scans** (CRITICAL, 90% confidence)  
   - `fetchMetricsExtras` issues 7 queries **on top of** 8 baseline queries = 15 queries/sec
   - `loops.findUpdatedSince`, `schedules.findUpdatedSince`, `orchestrations.findUpdatedSince` are full table scans (no `updated_at` index)
   - `tasks.findUpdatedSince` sorts on `COALESCE(completed_at, started_at, created_at)` (no expression index)
   - **Fix**: Add migration v20 with 4 indexes: `idx_loops_updated_at`, `idx_schedules_updated_at`, `idx_orchestrations_updated_at`, expression index on tasks

3. **Recursive CTE runs every 1s per orchestration-detail view** (CRITICAL, 88% confidence)  
   - `sumByOrchestrationId()` walks full retry chain without index on `tasks.retry_of`
   - O(rows * retry_depth) per poll
   - **Fix**: Add `CREATE INDEX idx_tasks_retry_of ON tasks(retry_of) WHERE retry_of IS NOT NULL`

4. **File logger fire-and-forget writes without backpressure** (HIGH, 90% confidence)  
   - Each log line schedules independent `write()` syscall, un-awaited
   - 50+ writes/sec under load, unbounded in-flight accumulation, silent errors
   - **Fix**: Use buffered writer (10-20 lines) or `WriteStream`, track pending with counter, await in `dispose()`

5. **Sequential N+1 awaits in liveness check** (HIGH, 92% confidence)  
   - 150 SQLite queries serially worst-case (5+ RUNNING orchestrations × 3 queries each)
   - **Fix**: `Promise.all` over the orchestration set

6. **Polling interval recreated every render** (CRITICAL React, see React section)

### Complexity (2 CRITICAL, 2 HIGH)

1. **`handleMainKeys`: 381 lines, 30 complexity, 5-level nesting** (CRITICAL, 96% confidence)  
   - Single dispatcher handles Tab/panel-jump/activity-arrows/Enter/c/d/f/filter
   - Four entity kinds, two focus areas, duplicated dispatch 3× across handlers
   - **Fix**: Extract per-mode handlers + entity-ops table (see Architecture #1)

2. **`handleWorkspaceKeys`: 274 lines, 12 branches, 4 near-identical scroll blocks** (CRITICAL, 94% confidence)  
   - `[`, `]`, `g`, `G` are copy-pasted four times with per-block guard
   - **Fix**: Extract helpers for scroll/jump logic (see Architecture #1)

### Documentation (3 CRITICAL)

1. **`package.json` version NOT bumped to 1.3.0** (100% confidence)  
   - All other artifacts (CHANGELOG, FEATURES, ROADMAP, RELEASE_NOTES) updated for v1.3.0
   - Release workflow hard-fails if `npm view autobeat version` equals `package.json` version
   - **Fix**: `npm version 1.3.0 --no-git-tag-version` before merge

2. **Release notes reference non-existent PR numbers `#134`, `#135`** (99% confidence)  
   - Should be `#133` (this branch)
   - All 9 lines in "What's Changed Since v1.2.0" section will have broken GitHub links post-publish
   - **Fix**: Replace all `#134`/`#135` with `#133`

3. **Layout mode thresholds in release notes don't match code** (99% confidence)  
   - Notes say: full ≥80×20, narrow <80, too-small <60 OR <14
   - Code says: full ≥60×14, narrow <60, too-small <14 (rows-only)
   - **Fix**: Update table to match `layout.ts:78-84`

### React (2 CRITICAL)

1. **UTF-8 byte-slice corrupts multi-byte characters at chunk boundaries** (CRITICAL, 92% confidence)  
   - `Buffer.from(fullContent).slice(prev.totalBytes).toString('utf-8')` at arbitrary byte offset
   - If multi-byte sequence (emoji, CJK, accents) straddles boundary, produces U+FFFD
   - Corruption permanent (no recovery on next poll)
   - **Fix**: Track UTF-8 string offset OR buffer partial bytes until next full codepoint

2. **Polling interval recreated every render — taskIds/taskStatuses unstable** (CRITICAL, 95% confidence)  
   - `app.tsx:98-99` computes `childTaskIds = data?.workspaceData?.childTaskIds ?? []` → fresh `[]` each render
   - `use-dashboard-data.ts:281-284` rebuilds lists on every poll → fresh references each second
   - `useTaskOutputStream` lists these in `doPoll` deps → new `doPoll` identity → cleanup runs → `closingRef.current = true` → new immediate poll fires
   - Intended 1s cadence collapses to "poll on every render" (250ms)
   - **Fix**: Memoize in app.tsx with `EMPTY_TASK_IDS` module-level constant OR read via refs inside `doPoll`

### Testing (1 CRITICAL)

1. **Integration suite non-deterministic — OOM kills 2–6 tests per run** (CRITICAL, 95% confidence)  
   - 4 new test files + existing 9 push suite over memory threshold
   - Tests silently dropped while exit code still "11 passed (12)"
   - **Fix**: (a) Audit new test files for `db.close()` + `container.dispose()` paths, (b) lower `vmMemoryLimit` with worker restart, (c) verify 3 consecutive runs report same count

### Accessibility (5 HIGH)

1. **Hidden keybindings: `m`, `w`, `j`/`k`, `1–4`, `g` are undocumented** (95% confidence)  
   - Footer lists `v: workspace` but not `m`/`w` global view jumps
   - Users cannot discover full keyboard surface without reading source
   - **Fix**: Add `?`/`h` help overlay listing all bindings; document critical ones in footer

2. **Footer hint "Tab: activity" is misleading** (90% confidence)  
   - Tab cycles through 5 panels (loops→tasks→schedules→orch→activity), not jump-to-activity
   - Implies single press reaches activity; actually takes four presses
   - **Fix**: Rewrite to accurately describe cycle order or split into two-line footer

3. **Resources tile: severity conveyed only by color** (88% confidence)  
   - Green/yellow/red bar with no `[OK]`/`[WARN]`/`[CRIT]` label
   - Color-blind, monochrome, screen-reader users cannot distinguish severity
   - **Fix**: Pair color with text label: `CPU [█████░░░░] 75% [WARN]`

4. **MetricsBar status conveyed only by color** (87% confidence)  
   - `failed` and `cancelled` both render as red; no glyph to differentiate
   - **Fix**: Prefix with `statusIcon()` glyph (same as `StatusBadge`)

5. **Narrow layout silently drops Throughput/Activity/Counts panels** (92% confidence)  
   - User on 50-col terminal sees no CountsPanel (failure totals) with no disclosure
   - **Fix**: List hidden sections: `Narrow terminal — Throughput, Activity, Counts hidden. Resize to ≥60 cols.`

### TypeScript (2 HIGH)

1. **`SQLiteUsageRepository` skips Zod validation on every read** (95% confidence)  
   - Every row cast does `as number`, `as TaskId` — unchecked assertions
   - Sister repos use `z.object({...}).parse(row)`; `UsageRepository` is only one that bypasses
   - Corrupt rows render `$NaN`, `Infinity` tokens, empty-string magic IDs
   - **Fix**: Add `UsageRowSchema` + aggregate schema, use `.parse()` on all rows

2. **`ActivityEntry` is not a discriminated union — forces 12+ `as` casts** (85% confidence)  
   - Flat `{ entityId: string; kind: 'task'|'loop'|... }` instead of branded variants
   - Every consumer casts: `entry.entityId as TaskId | LoopId | ...`
   - Worst offender: `app.tsx:131-140` uses `as never` (bottom type)
   - **Fix**: Make discriminated union: `type ActivityEntry = { kind: 'task'; entityId: TaskId; ... } | ...`

### Consistency (3 HIGH)

1. **`ActivityEntry.timestamp: Date` breaks project convention** (92% confidence)  
   - Every existing timestamp is `number` (epoch ms): `Task.createdAt`, `Schedule.nextRunAt`, `Loop.createdAt`, etc.
   - `ActivityEntry` alone uses `Date`, then immediately `.getTime()`
   - **Fix**: Change to `timestamp: number`, format-on-render only

2. **`LoopHandler.handleLoopCreated` throws while every other handler logs** (85% confidence)  
   - All handlers follow log-and-drop pattern; only `LoopCreated` propagates via `throw`
   - Violates "stick to ONE async pattern" (CLAUDE.md)
   - **Fix**: Either make all handlers throw (cleanest long-term) or all log (restore consistency now)

3. **`FileLogger` ignores configured `LogLevel`** (90% confidence)  
   - `StructuredLogger`/`ConsoleLogger` both respect `LogLevel`; `FileLogger` accepts none
   - Dashboard log balloons with `debug` lines that MCP-server mode would suppress
   - **Fix**: Accept `level` param, check before `write()` like other implementations

### Regression (1 HIGH, well-documented)

1. **Cancel cascade default change is observable to MCP consumers** (95% confidence)  
   - v1.2.0 had no `orchestrator_id` column; v1.3.0 cascades attributed tasks by default
   - Documented in release notes, acceptable for minor version
   - **Fix**: Optional — expose `cancelAttributedTasks` on `CancelOrchestratorSchema` to make opt-out possible

### Database (2 HIGH)

1. **Missing `tasks.retry_of` index makes recursive CTE O(rows × depth)** (92% confidence)  
   - Covered in Performance #3 above

2. **Statements re-prepared inside hot-path query methods (1Hz polling)** (88% confidence)  
   - 7 new methods call `db.prepare()` inline instead of caching in constructor
   - All other methods in same files use constructor-cached pattern
   - **Fix**: Cache all new statements as instance fields

### Security (0 findings)

No CRITICAL/HIGH security issues. MEDIUM findings (ANSI stripping, log injection, loose Zod regex) are tightening opportunities, not blockers.

---

## Strengths

- **Type discipline**: 7,000+ lines of new code with zero `any` types. Branded IDs and discriminated unions for view state are well-modeled.
- **Architecture patterns**: New repositories (`UsageRepository`, `UsageCaptureHandler`) follow Result type convention, factory pattern, and `tryCatchAsync` exactly.
- **Code organization**: `layout.ts` (175 lines) is exemplary pure-function refactoring with no React imports. `activity-feed.ts`, `usage-parser.ts` likewise clean.
- **Database safety**: Migrations are additive, idempotent, and properly scoped. All SQL uniformly parameterized (no injection vectors).
- **Test coverage for helpers**: Parser, layout, stream state pure functions are well-isolated and unit-tested.
- **Domain model**: `TaskUsage`, `OrchestratorChild`, `ActivityEntry` are immutable value objects with read-only fields.

---

## Top 5 Action Items (Prioritized)

### 1. Fix `use-keyboard.ts` god module split (2–3 hours, HIGH impact)
**Files**: `src/cli/dashboard/use-keyboard.ts`  
**Effort**: Large refactor  
**Why first**: Blocks further dashboard iterations; architectural debt compounds every feature.
- Extract `keyboard/{constants.ts, helpers.ts, handle-detail.ts, handle-workspace.ts, handle-main.ts, dispatch-cancel.ts}`
- Build `ENTITY_OPS` table to collapse 6 duplicated dispatch switches into 1
- Drops per-handler size below 100 lines

### 2. Add missing database indexes (30 mins, CRITICAL impact)
**Files**: `src/implementations/database.ts` (new migration v20)  
**Effort**: Small mechanical change  
**Why second**: Unblocks performance blocker without architectural changes.
- `CREATE INDEX idx_tasks_retry_of ON tasks(retry_of) WHERE retry_of IS NOT NULL`
- `CREATE INDEX idx_loops_updated_at ON loops(updated_at DESC)`
- `CREATE INDEX idx_schedules_updated_at ON schedules(updated_at DESC)`
- `CREATE INDEX idx_orchestrations_updated_at ON orchestrations(updated_at DESC)`

### 3. Fix documentation errors (30 mins, RELEASE-BLOCKING)
**Files**: `package.json`, `docs/releases/RELEASE_NOTES_v1.3.0.md`  
**Effort**: Trivial  
**Why third**: Release workflow will hard-fail without these.
- Bump `package.json` to 1.3.0 via `npm version 1.3.0 --no-git-tag-version`
- Replace `#134`/`#135` with `#133`
- Fix layout threshold table to match code

### 4. Stabilize polling refs and add `DashboardQueryService` (1–2 hours, HIGH impact)
**Files**: `src/cli/dashboard/{app.tsx, use-task-output-stream.ts, use-dashboard-data.ts}`, `src/services/dashboard-query-service.ts` (new)  
**Effort**: Medium refactor  
**Why fourth**: Unblocks React correctness and performance issues together.
- Memoize `childTaskIds`/`childTaskStatuses` in app.tsx with module-level empty constants
- Extract `DashboardQueryService` to own all aggregate fetches
- Stabilize polling interval

### 5. Fix test suite OOM and add missing hook tests (1–2 hours, TESTING-BLOCKING)
**Files**: `tests/integration/`, `tests/unit/cli/dashboard/use-task-output-stream.test.ts`  
**Effort**: Medium  
**Why fifth**: Unblocks release signal guarantee.
- Audit new integration test files for disposal paths
- Add 4 behavioral tests for `useTaskOutputStream` hook (success, terminal one-shot, error, unmount)
- Verify 3 consecutive runs report identical test counts

---

## Pre-existing Issues (Informational)

These are not owned by this PR but are surfaced by the reviews:

| Issue | Location | Priority |
|-------|----------|----------|
| `OutputRepository.append` is O(n²) over chunks | `src/implementations/output-repository.ts` | Medium (amplified by 1Hz polling) |
| Bootstrap handler-wiring omitted `UsageCaptureHandler` registration check | `src/bootstrap.ts` | Low (lifecycle correct) |
| Flaky CI test: worker-pool-management.test.ts:157 (timing-dependent PID) | `tests/integration/` | Low (pre-existing) |
| EVENT_FLOW.md architecture docs missing UsageCaptureHandler, OrchestrationHandler | `docs/architecture/EVENT_FLOW.md` | Low (refresh-on-next-release) |

---

## Merge Checklist

- [ ] Fix 3 CRITICAL documentation errors (package.json, PR numbers, layout thresholds)
- [ ] Split `use-keyboard.ts` into per-view files + `ENTITY_OPS` table
- [ ] Add 4 missing database indexes (migration v20)
- [ ] Stabilize polling refs in app.tsx (`EMPTY_TASK_IDS` + `useMemo`)
- [ ] Extract `DashboardQueryService` and wire dashboard to use it
- [ ] Fix integration suite OOM (verify 3 identical runs)
- [ ] Add behavioral hook tests for `useTaskOutputStream`
- [ ] Verify all HIGH-severity items have PRs filed or are being fixed in-branch

---

## Decision

**CHANGES_REQUESTED** — Do not merge without addressing the 3 CRITICAL documentation blockers and at least 3 of the 5 action items above. The core feature (v1.3.0 dashboard) is sound; the issues are about code organization, performance optimization, and test signal integrity that will pay dividends in v1.4.0 and beyond.

**Estimated re-review time**: ~4 hours to fix and re-run focused test suites on the above items.
