# Resolution Summary

**Branch**: feat-184-dashboard-channels -> main
**Date**: 2026-05-28
**Review**: .devflow/docs/reviews/feat-184-dashboard-channels/2026-05-28_1409
**Command**: /resolve

## Decisions Citations

- avoids PF-001 — batch-3a, helpers:no-unit-tests (fixed rather than deferring)
- avoids PF-001 — batch-3a, dashboard-data-test:findUpdatedSince-call (fixed rather than deferring)
- avoids PF-001 — batch-3b, channel-repo-test:boundary-timestamp (fixed low-severity suggestion rather than deferring)
- avoids PF-002 — batch-2, database:1276:redundant-index (pre-deploy PR, migration not shipped to production)
- applies ADR-002 — batch-4b, header:66:destroyed-as-failed (FP — intentional pattern matching cancelled for schedules/pipelines)
- applies ADR-003 — batch-2, channel-repo:103-608:file-length (FP — pre-existing growth trajectory, mid-range for codebase)
- applies ADR-003 — batch-4a, dashboard-data:324:db-round-trip (FP — channels adopt existing findUpdatedSince pattern)
- applies ADR-003 — batch-4b, channel-repo:553:zod-validation-per-poll (FP — pre-existing pattern across all repositories)

## Statistics
| Metric | Value |
|--------|-------|
| Total Issues | 23 |
| Fixed | 11 |
| False Positive | 12 |
| Deferred | 0 |
| Blocked | 0 |

## Fixed Issues
| Issue | File:Line | Commit |
|-------|-----------|--------|
| pauseOrResumeEntity missing exhaustive never guard | `entity-mutations.ts:151` | `a306728` |
| findUpdatedSince hydrates members unnecessarily for activity feed | `channel-repository.ts:380` | `44f330d` |
| Redundant index idx_channel_messages_channel_id in migration v32 | `database.ts:1276` | `44f330d` |
| Channel findUpdatedSince JSDoc style diverges from @param convention | `interfaces.ts:1055` | `44f330d` |
| Missing test: findUpdatedSince called during main-view metrics fetch | `use-dashboard-data.test.ts` | `c5b544f` |
| Missing test: channel hints omit Enter detail | `hints.test.ts` | `c5b544f` |
| No unit tests for getPanelItems, panelToEntityKind, resolveMemberIndex | `helpers.test.ts` (new, 19 tests) | `c5b544f` |
| Test mock completeness — findUpdatedSince missing from detail-view overrides | `use-dashboard-data.test.ts:459,487` | `c5b544f` |
| Missing test for findUpdatedSince error path graceful degradation | `use-dashboard-data.test.ts` | `c5b544f` |
| Test creates unused variable — does not test stated time-window behavior | `channel-repository.test.ts:496` | `4281dbc` |
| Remove dimColor from pane preview content for readability | `channel-detail.tsx:183` | `b20789e` |

## False Positives
| Issue | File:Line | Reasoning |
|-------|-----------|-----------|
| Channel detail hint text omits [/] scroll and G tail | `hints.ts:42` | [/] and G keys are handled exclusively by handleOutputControls for tasks/orchestrations only. Channel message scrolling uses ↑/↓ via handleChannelNavigation. Adding scroll hints would advertise non-functional keys. |
| cancelEntity switch cyclomatic complexity | `entity-mutations.ts:35-104` | Low-confidence (65%). 6 semantically distinct cases with different cancel semantics per entity type. Table-driven dispatch would add indirection without reducing actual complexity. |
| SQLiteChannelRepository 18 prepared statements and 608 lines | `channel-repository.ts:103-608` | Pre-existing growth trajectory. schedule-repository.ts is 739 lines, loop-repository.ts is 821 lines — channel-repo at 608 is mid-range. applies ADR-003. |
| fetchAllData 120-line function with 12 sequential unwrap guards | `use-dashboard-data.ts:172-291` | Intentional documented design. Line 191 comment records the trade-off: individual guards chosen over unwrapAll + unsafe positional cast for direct type flow. Prior cycle accepted this. |
| Optional channelService/channelRepo on DashboardMutationContext | `types.ts:60-62` | Intentional staging. pipelineRepo is also optional — both pipelines and channels are newer entities. The suggested fix itself says "appropriate since channels are new." |
| fetchMetricsExtras blocking vs best-effort asymmetry | `use-dashboard-data.ts:226,333` | Consistent pattern. fetchAllData treats ALL entities as hard errors; fetchMetricsExtras treats ALL as best-effort. Not channel-specific — same contract for every entity. |
| Additional DB round-trip vs in-memory filter for channel activity | `use-dashboard-data.ts:324` | All 5 other entities use findUpdatedSince DB queries. Channels joining the pattern is consistent, not a regression. applies ADR-003. |
| 12 parallel Promise.all slots growing | `use-dashboard-data.ts:189-218` | Structural observation (62% confidence). 12 slots = 6 entities × 2 queries. Well-named variables grouped logically. No defect. |
| Destroyed channels counted as failed in health summary | `header.tsx:66` | Intentional. Commit 5cd4d26 explicitly placed destroyed in failed bucket — consistent with how cancelled is counted for schedules and pipelines (also user-initiated terminal actions). applies ADR-002. |
| Zod validation on every row conversion during 1Hz polling | `channel-repository.ts:553` | Pre-existing pattern across all entity repositories. Not introduced by this PR. applies ADR-003. |
| Selected member row blue background may have contrast concerns | `channel-detail.tsx:75` | backgroundColor='blue' + color='white' is canonical terminal TUI selection pattern. WCAG 4.5:1 is a web standard; terminal contrast depends on user's color theme. |
| MESSAGE_VIEWPORT_HEIGHT = 10 is hardcoded | `channel-detail.tsx:24` | Matches established codebase pattern. loop-detail uses 12, pipeline-detail uses 12, schedule-detail uses 12 — all hardcoded constants. |

## Deferred to Tech Debt
_(none)_

## Blocked
_(none)_
