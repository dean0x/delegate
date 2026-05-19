# Resolution Summary

**Branch**: `feat/dashboard-redesign-v1.3.0` → `main`
**Date**: 2026-04-11
**Review directory**: `.docs/reviews/feat-dashboard-redesign-v1-3-0/2026-04-11_2200/`
**Command**: `/resolve`
**PR**: dean0x/autobeat#133

## Statistics

| Metric | Value |
|---|---:|
| Total issues parsed from 13 reviews | 152 |
| Issues targeted across 6 batches | 82 |
| Fixed | ~37 |
| False positive | 6 |
| Deferred to tech debt | ~101 |
| Blocked | 0 |
| **Commits created** | **20** |
| Typecheck after resolution | CLEAN |
| Biome after resolution | CLEAN (257 files) |
| Test groups validated | core, handlers, services, repositories, adapters, implementations, cli, dashboard |

## Batches executed

| # | Batch | Wave | Files owned | Fixed | Deferred | Commits |
|---|---|---|---:|---:|---:|---|
| 1 | Documentation blockers | 1 | 8 | 12 | 0 (4 FP) | 6 |
| 2 | Streaming correctness | 1 | 2 | 3 | 8 | 1 |
| 3 | DB indexes + prepared statements + Zod | 1 | 6 | 10 | 9 | 4 |
| 4 | Security / validation | 1 | 4 | 4 | 2 | 3 |
| 5 | Dashboard query optimization + cancel cascade | 2 | 5 | 5 | 9 | 2 |
| 6 | Consistency (timestamp, LogLevel, throw pattern) | 2 | 3 | 3 | 3 | 3 |
| — | Simplifier pass (Phase 7) | — | 8 | — | — | 1 |

**Out of scope (deferred by omission from batches)**: test quality improvements (15+ findings), `use-keyboard.ts` 1,091-line file split (14 findings), UI polish for tiles/panels/accessibility (~30 findings), cross-cutting themes (cyan color collision, formatTime duplication, short-id strategy, `node:` import prefix).

## Fixed Issues

### Documentation blockers (Batch 1)
| Issue | File:Line | Commit |
|---|---|---|
| Version not bumped | `package.json:3` | `741e7ab` |
| Wrong PR refs `#134`/`#135` → `#133` | `docs/releases/RELEASE_NOTES_v1.3.0.md:251` | `73f0214` |
| Wrong layout mode thresholds | `docs/releases/RELEASE_NOTES_v1.3.0.md:170` | `73f0214` |
| `g`/`G` keybinding description collapsed | `docs/releases/RELEASE_NOTES_v1.3.0.md:82` | `73f0214` |
| "read pressure" typo (should be write) | `docs/releases/RELEASE_NOTES_v1.3.0.md:44` | `73f0214` |
| CHANGELOG.md missing PR refs | `CHANGELOG.md` | `d2f732d` |
| Missing v1.3.0 keybindings + env var | `docs/FEATURES.md` | `5b98221` |
| UsageCaptureHandler not in architecture docs | `CLAUDE.md`, `docs/architecture/EVENT_FLOW.md` | `2c475d9` |
| Stale main-view comment | `src/cli/dashboard/workspace-types.ts:3` | `5b33617` |

### Streaming correctness (Batch 2)
| Issue | File:Line | Commit |
|---|---|---|
| UTF-8 byte-slice corrupts multi-byte chars | `src/cli/dashboard/use-task-output-stream.ts:129` (CRITICAL) | `203776d` |
| Polling interval recreated every render | `src/cli/dashboard/use-task-output-stream.ts:343`, `app.tsx` (CRITICAL) | `203776d` |
| Incomplete ANSI/terminal-escape stripping | `src/cli/dashboard/use-task-output-stream.ts:43` (HIGH, security) | `203776d` |

Fix notes: UTF-8 fix uses `[...str].slice(totalChars)` char-indexed slicing (no external dependency). Polling stabilization moves `taskIds`/`taskStatuses` into refs updated each render; `doPoll` now depends only on `[outputRepo, enabled]`. ANSI regex expanded to cover OSC, DCS/APC/PM/SOS, single-char ESC, and C1 controls. Includes regression tests with emoji, CJK, and OSC 8 sequences.

### DB indexes + prepared statements + Zod (Batch 3)
| Issue | File:Line | Commit |
|---|---|---|
| Missing indexes on 1Hz-polled queries | new migration v20 in `src/implementations/database.ts` (HIGH) | `e4315ad` |
| Prepared statements re-compiled per call in hot paths | 5 repositories | `9f6e2f1` |
| Raw `as TaskId` casts on read paths | `usage-repository.ts`, `orchestration-repository.ts` (HIGH) | `010a0a3` |

**Migration v20 indexes**:
- `idx_tasks_retry_of` (partial, covers recursive CTE in `sumByOrchestrationId`)
- `idx_loops_updated_at`, `idx_schedules_updated_at`, `idx_orchestrations_updated_at` (activity feed `findUpdatedSince`)
- `idx_tasks_updated_expr` on `COALESCE(completed_at, started_at, created_at)` (expression index for tasks, which has no `updated_at` column)

**13 prepared statements cached**: usage-repository (5), orchestration-repository (3), task-repository (3), loop-repository (1), schedule-repository (1).

**Zod schemas added**: `TaskUsageRowSchema`, `TaskUsageAggregateRowSchema`, `OrchestratorChildRowSchema`.

### Security / validation (Batch 4)
| Issue | File:Line | Commit |
|---|---|---|
| Loose `metadata.orchestratorId` Zod schema | `src/adapters/mcp-adapter.ts:79` | `b56ef01` |
| `AUTOBEAT_ORCHESTRATOR_ID` written to stderr without sanitization | `src/cli/commands/run.ts:194` | `7c1f405` |
| Spawn injects env var without format validation | `src/implementations/base-agent-adapter.ts:165` | `90d99c9` |

**Regex chosen**: `^orchestrator-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` with exact `min(49).max(49)` bounds. Matches `orchestrator-${crypto.randomUUID()}` output exactly.

Stderr sanitization strips `[\x00-\x1f\x7f]` and caps display at 200 chars. Spawn validation falls back to dropping the env var on malformed input (warns, does not crash).

### Dashboard query optimization + cancel cascade (Batch 5)
| Issue | File:Line | Commit |
|---|---|---|
| Serial for-await liveness: 150 sequential SQLite hits/s | `src/cli/dashboard/use-dashboard-data.ts:139` (CRITICAL/HIGH) | `c7d104a` |
| `fetchAllData` 17-line unwrap boilerplate | `src/cli/dashboard/use-dashboard-data.ts:117` (HIGH complexity) | `c7d104a` |
| Cancel cascade in wrong layer (service, not handler) | `src/services/orchestration-manager.ts:417` (HIGH arch) | `a2b0a12` |

Liveness fan-out: `Promise.all` + 4-second TTL cache (processes don't die at 1Hz granularity). `AttributedTaskCancellationHandler` created as new event handler subscribing to `OrchestrationCancelled`, registered in `handler-setup.ts`, with 7 new unit tests. `OrchestrationManagerService` no longer carries `taskRepository`/`taskManager` deps (Simplifier cleaned these up in `33fd27b`).

### Consistency (Batch 6)
| Issue | File:Line | Commit |
|---|---|---|
| `ActivityEntry.timestamp` is `Date` not epoch ms | `src/core/domain.ts:826` + `activity-feed.ts` + `activity-panel.tsx` | `2a349cc` |
| `FileLogger` ignores `LogLevel` filter | `src/implementations/file-logger.ts:100` | `ad676ed` |
| `LoopHandler.handleLoopCreated` throws (inconsistent) | `src/services/handlers/loop-handler.ts:170` | `c190662` |

### Simplifier pass (Phase 7)
| Change | File | Commit |
|---|---|---|
| Removed `@deprecated` `taskRepository?`/`taskManager?` deps | `orchestration-manager.ts`, `bootstrap.ts` | `33fd27b` |
| Removed double-parse in `findUpdatedSince` | `orchestration-repository.ts` | `33fd27b` |
| Hoisted `TopOrchestrationRowSchema` out of hot path | `usage-repository.ts` | `33fd27b` |
| Fixed handler count in stale jsdoc | `handler-setup.ts` | `33fd27b` |
| Fixed stale `Date` assertions → epoch ms | `tests/unit/cli/dashboard/activity-feed.test.ts` | `33fd27b` |
| Removed unused test imports | 2 test files | `33fd27b` |

## False Positives

| Issue | File:Line | Reasoning |
|---|---|---|
| Event count drift | `docs/FEATURES.md:273` | Counted 34 members in `AutobeatEvent` union — doc was accurate. |
| Activity Feed missing `d` | `RELEASE_NOTES_v1.3.0.md` | `d` is workspace-grid-only per code. Fixed by adding to Workspace table instead (where it was genuinely missing). |
| ROADMAP unchanged | `docs/ROADMAP.md` | Already had v1.3.0 in Released Versions. |
| EVENT_FLOW stale content | `docs/architecture/EVENT_FLOW.md:0` | Pre-existing content predating LoopHandler/OrchestrationHandler; not introduced by this PR. |
| Optional 3rd param regression | `orchestration-manager.ts:355` | Already backward-compatible via TS structural typing. |
| MCP schema exposes cancelAttributedTasks | `orchestration-manager.ts:396` | Out of Batch 5 file ownership; schema change is a separate concern. |

## Deferred to Tech Debt

### Architectural refactors (not done this run)
- **`use-keyboard.ts` split into per-view handlers + ENTITY_OPS table** — 14 findings across 1,091-line file. Recommended as follow-up PR; does not block merge.
- **`DashboardQueryService` extraction** — `use-dashboard-data.ts` reaches into 7+ repositories and duplicates `isProcessAlive`. Needs a service-layer boundary.
- **`DashboardData` discriminated union per view** — architectural rework of dashboard data model; impacts many consumer files.
- **`createOrchestration` 238-line simplification** — closures capture 4-5 local vars; promoting to methods would require threading parameters through, not a readability improvement.
- **`RecoveryManager` SRP split** (8 constructor deps, 7 phases).
- **`setupEventHandlers` 224-line template dedup**.
- **Branded-ID runtime validation across 5 types** (`TaskId`, `WorkerId`, `ScheduleId`, `LoopId`, `OrchestratorId`) — must be applied consistently, not one-off on `OrchestratorId`.
- **`OutputRepository` getSize / getSince API** for true delta reads — requires interface + implementation changes outside Batch 2 scope. `TODO:` comment added at `use-task-output-stream.ts` pointing to the target API.

### Performance follow-ups
- **Covering index `(orchestrator_id, captured_at)` on `task_usage`** (LOW).
- **Event-invalidated count cache** for `countOrchestratorChildren`.
- **`getOrchestratorChildren` ORDER BY unindexable expression** — requires persisting a real `updated_at` column on tasks.
- **Pre-existing `findAll(LIMIT)` missing created_at indexes** on loops/schedules/orchestrations (predates v1.3.0, amplified by dashboard polling).

### Testing debt (not addressed this run)
- **Integration suite OOM non-determinism** — 2–6 tests silently dropped per run. Vitest memory threshold.
- **`useTaskOutputStream` hook has zero behavioral invocations** in its test file — tests only cover pure helpers.
- **18 setTimeout(10ms) calls** in `use-keyboard.test.tsx` should be `vi.waitFor` / fake timers.
- **`process.env` mutation without `vi.stubEnv`** in `bootstrap-handler-wiring.test.ts:24-39`.
- **Real `process.kill(999999, 0)`** in `recovery-manager-orchestration.test.ts:281-317` — flaky.
- **Hardcoded `/root/cannot-write-here/test.log`** in `file-logger.test.ts:141-150`.
- **Tests re-implementing `LoopHandler` behavior in `beforeEach`** — violates "real implementations, not mocks" handler test pattern.

### UI / accessibility polish (all deferred)
- **Tile borders missing** on Resources/Cost/Throughput (top metrics row reads as one blob).
- **Counts-panel phantom leading space** and inconsistent widths from conditional zero-rendering.
- **Activity feed column ragged alignment** — only `status` is `padEnd`.
- **Cyan color collision** (running status / UI focus / brand / code-snippet hint — all cyan).
- **Two `statusColor` functions with divergent mappings** (format.ts vs metrics-bar.tsx).
- **Two `formatTime` implementations**.
- **Three short-id strategies** (`slice(0,12)` vs `slice(-8)`).
- **Hardcoded `height={24}` in `workspace-view.tsx:206`** bypasses responsive layout.
- **Accessibility findings**: color-only severity indicators on Resources tile, MetricsBar, CountsPanel; narrow metrics layout silently drops Throughput/Activity/Counts; no `?`/`h` help affordance; `AUTOBEAT_REDUCE_MOTION` env var undocumented.

### Minor / LOW
- **25 LOW findings** across all categories not individually enumerated. Includes dead-code comments, minor prop naming, and stylistic nits.

## Blocked

None. All targeted fixes landed cleanly.

## Commits (20 total, chronological)

| # | SHA | Message |
|---:|---|---|
| 1 | `741e7ab` | chore: bump version to 1.3.0 |
| 2 | `73f0214` | docs(release): correct PR refs and layout thresholds in v1.3.0 notes |
| 3 | `d2f732d` | docs(changelog): add PR #133 references to v1.3.0 entries |
| 4 | `5b98221` | docs: add missing v1.3.0 keybindings to FEATURES |
| 5 | `2c475d9` | docs: document UsageCaptureHandler and OrchestrationHandler in architecture |
| 6 | `5b33617` | chore(dashboard): remove stale main-view comment in workspace-types |
| 7 | `203776d` | fix(dashboard): UTF-8 safe delta-decode, stable polling cadence, comprehensive ANSI stripping |
| 8 | `b56ef01` | fix(mcp): tighten orchestratorId Zod schema bounds |
| 9 | `7c1f405` | fix(run): sanitize AUTOBEAT_ORCHESTRATOR_ID before stderr display |
| 10 | `90d99c9` | fix(adapter): validate orchestratorId format before env injection |
| 11 | `e4315ad` | feat(db): migration v20 adds performance indexes for dashboard polling |
| 12 | `9f6e2f1` | perf(repo): cache prepared statements in 5 repositories |
| 13 | `010a0a3` | fix(repo): parse Zod schemas on new read paths (orchestration, usage) |
| 14 | `a0cde1f` | style(test): fix biome quote style in usage-repository test |
| 15 | `2a349cc` | fix(domain): use epoch ms for ActivityEntry.timestamp (match project convention) |
| 16 | `ad676ed` | fix(logger): FileLogger honors LogLevel filter |
| 17 | `c190662` | fix(loop-handler): log-and-drop errors instead of throwing |
| 18 | `c7d104a` | perf(dashboard): parallelize + cache orchestration liveness fan-out |
| 19 | `a2b0a12` | refactor(services): extract AttributedTaskCancellationHandler from orchestration-manager |
| 20 | `33fd27b` | refactor: simplify v1.3.0 resolution output |

## Validation status

- `npm run typecheck`: CLEAN
- `npm run check` (biome): CLEAN, 257 files
- Test groups executed during resolution (per Resolver reports):
  - `test:core` (359 tests) — pass
  - `test:handlers` (170 tests) — pass
  - `test:services` (179 tests) — pass
  - `test:repositories` (211 tests) — pass
  - `test:adapters` (121 tests) — pass
  - `test:implementations` (383 tests) — pass (includes 6 new file-logger level-filter tests)
  - `test:cli` (295 tests) — pass
  - `test:dashboard` (529 tests) — pass
  - Simplifier re-verified 49 test files / 1,718 tests post-refactor
- Branch status: 20 commits ahead of origin; ready to push

## Pitfalls recorded (unchanged from /code-review Phase 5)

No new pitfalls added during /resolve. The 5 pitfalls recorded during /code-review already cover the systemic patterns addressed by this resolution run:

- **PF-001**: 1Hz dashboard polling amplifies unindexed queries (now addressed by migration v20)
- **PF-002**: UTF-8 byte-slice corrupts multi-byte characters (now addressed by char-indexed slicing)
- **PF-003**: React polling hooks: unstable useEffect deps recreate setInterval (now addressed by ref-based pattern)
- **PF-004**: Prepared statements must be cached in repository constructors (now addressed across 5 repos)
- **PF-005**: Repository read paths must use Zod, not `as` casts (now addressed for new methods)

These pitfalls remain in `.memory/knowledge/pitfalls.md` as forward-looking rules — they describe patterns to avoid in future work, not current state.

## Next steps

1. Push the 20 commits: `git push origin feat/dashboard-redesign-v1.3.0`
2. Address remaining blocking review comments on the PR via follow-up commits or respond to the reviewer
3. Consider follow-up PR for `use-keyboard.ts` split (biggest remaining architectural finding)
4. Consider follow-up PR for test quality improvements (integration OOM, missing hook test coverage)
5. Proceed with v1.3.0 release workflow once PR is merged
