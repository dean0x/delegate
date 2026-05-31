# Resolution Summary

**Branch**: feat-184-dashboard-channels -> main
**Date**: 2026-05-28
**Review**: .devflow/docs/reviews/feat-184-dashboard-channels/2026-05-28_0011
**Command**: /resolve

## Decisions Citations

- avoids PF-001 — batch-3, channel-repo:188-197:prune-not-in (documented FP reasoning)
- avoids PF-001 — batch-3, channel-repo:394-399:count-per-save (documented FP reasoning)
- avoids PF-001 — batch-5, persistence-handler-test:save-failure (fixed rather than deferred)
- avoids PF-001 — batch-6, dashboard-data:190:fetchAllData-tuple (fixed pre-existing rather than deferring)
- avoids PF-001 — batch-6, dashboard-data:362-364:findUpdatedSince (fixed rather than deferring)
- applies ADR-003 — batch-4, channel-detail:142-146:scrollable-list (FP — pre-existing gap, 2-5 members typical)

## Statistics
| Metric | Value |
|--------|-------|
| Total Issues | 18 |
| Fixed | 13 |
| False Positive | 4 |
| Deferred | 0 |
| Blocked | 0 |
| Pre-existing (addressed) | 1 |

## Fixed Issues
| Issue | File:Line | Commit |
|-------|-----------|--------|
| Missing exhaustive never guards in getPanelItems and panelToEntityKind | `helpers.ts:22-37,72-87` | `b23c392` |
| Missing exhaustive never guard in cancelEntity and deleteEntity | `entity-mutations.ts:45-91,169-207` | `b23c392` |
| Unnecessary ?? [] on required channels and pipelines fields | `helpers.ts:33,35` | `b23c392` |
| JSDoc comment-code drift — pause/resume panel list omits channels | `hints.ts:16` | `b23c392` |
| Misleading "Enter detail" hint for channel detail view | `hints.ts:53-58` | `b23c392` |
| Health summary omits destroyed channels from failed count | `header.tsx:59-65` | `5cd4d26` |
| getMessages limit accepts negative/NaN values | `channel-repository.ts:414` | `4714904` |
| save+count+prune not wrapped in transaction | `channel-repository.ts:383-402` | `4714904` |
| Statement cache grows unbounded — no eviction guard | `channel-repository.ts:136` | `4714904` |
| dimColor on blue selected background — low contrast | `channel-detail.tsx:83-84` | `1ef95f0` |
| Live Preview ternary chain lacks mutual exclusivity invariant comment | `channel-detail.tsx:177-187` | `1ef95f0` |
| Missing error-path test for deleteEntity channel branch | `entity-mutations.test.ts` | `b23c392` |
| Missing save-failure error path test for ChannelMessagePersistenceHandler | `channel-message-persistence-handler.test.ts` | `b23c392` |
| Pre-existing: fetchAllData positional-tuple fragility refactored to named destructuring | `use-dashboard-data.ts:190` | `bc5571d` |
| Missing findUpdatedSince on ChannelRepository — added method + tests | `interfaces.ts`, `channel-repository.ts`, `use-dashboard-data.ts` | `bc5571d` |

## False Positives
| Issue | File:Line | Reasoning |
|-------|-----------|-----------|
| Member list uses inline .map() instead of ScrollableList | `channel-detail.tsx:142-146` | Typical channels have 2-5 members. ScrollableList requires dedicated scroll offset in NavState + reducer + keyboard handler changes — significant scope for a non-issue at current scale. applies ADR-003. |
| Prune DELETE uses NOT IN subquery materializing 500 IDs | `channel-repository.ts:188-197` | Intentional design per PR description ("Prune with count guard"). SQLite handles 500-row NOT IN efficiently. Count guard skips DELETE when unnecessary. |
| saveMessage issues COUNT on every persist | `channel-repository.ts:394-399` | The COUNT IS the count-guard mechanism. Channels are low-throughput. COUNT(*) on 500-row indexed table is sub-millisecond. In-memory counter would add mutable state complexity without measurable benefit. |
| Prune-on-every-insert could be batched | `channel-repository.ts:396-399` | Same root cause as COUNT per save — the count-guard design is intentional and bounded at MAX_MESSAGES=500. |

## Deferred to Tech Debt
_(none)_

## Blocked
_(none)_
