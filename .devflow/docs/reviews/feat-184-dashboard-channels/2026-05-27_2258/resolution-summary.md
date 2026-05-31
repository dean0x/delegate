# Resolution Summary

**Branch**: feat-184-dashboard-channels -> main
**Date**: 2026-05-27
**Review**: .devflow/docs/reviews/feat-184-dashboard-channels/2026-05-27_2258
**Command**: /resolve

## Decisions Citations

- applies ADR-003 — batch-1, pre-test-groups-missing (pre-existing handler test gaps fixed while here)
- avoids PF-001 — batch-1, pre-test-groups-missing (fixed 4 missing handler test registrations rather than deferring)

## Statistics
| Metric | Value |
|--------|-------|
| Total Issues | 26 |
| Fixed | 21 |
| False Positive | 3 |
| Deferred | 1 |
| Blocked | 0 |
| Pre-existing (addressed) | 1 |

## Fixed Issues
| Issue | File:Line | Commit |
|-------|-----------|--------|
| test:handlers missing channel-message-persistence-handler.test.ts (CRITICAL) | `package.json` | `4eb3824` |
| Pre-existing: 3 handler test files added to test:handlers (usage-capture, attributed-task-cancellation, pipeline) | `package.json` | `4eb3824` |
| cancelEntity channel error-swallowing test added | `entity-mutations.test.ts` | `4eb3824` |
| useChannelPanePreview hook code path verification (partial — Ink test renderer limitation) | `use-channel-pane-preview.test.ts` | `4eb3824` |
| Activity feed time-window: channels now filtered to since1h inline | `use-dashboard-data.ts:364` | `9e3a1db` |
| channels field made required in BuildActivityFeedArgs | `activity-feed.ts:104` | `9e3a1db` |
| codePointSlice rewritten as O(200) iterator | `channel-manager.ts:108` | `9e3a1db` |
| Prune error isolation — try/catch inside tryCatchAsync | `channel-repository.ts:382` | `185ad1f` |
| Prune guarded with count check (only fires when > 500) | `channel-repository.ts:384` | `185ad1f` |
| findMembersByChannelIds statement cache by arity | `channel-repository.ts:463` | `185ad1f` |
| getMessages limit clamped to MAX_MESSAGES_PER_CHANNEL | `channel-repository.ts:395` | `185ad1f` |
| Missing destroyed status in statusColor and STATUS_ICONS | `format.ts` | `87caa9c` |
| Health summary includes channelCounts (active→running, paused→queued) | `header.tsx:42-71` | `87caa9c` |
| Stale JSDoc "1-5" → "1-6" in hints.ts and handle-main-keys.ts | `hints.ts:14`, `handle-main-keys.ts:5` | `87caa9c` |
| Hint "c cancel" → "c destroy" when channels focused | `hints.ts:25` | `87caa9c` |
| CLAUDE.md File Locations: added channel-detail.tsx and use-channel-pane-preview.ts | `CLAUDE.md:328-329` | `87caa9c` |
| Exhaustive never guard in detail-view.tsx switch | `detail-view.tsx:185` | `ddda39a` |
| Exhaustive never guard in entity-browser-panel.tsx switch | `entity-browser-panel.tsx:131` | `ddda39a` |
| Member status icon: IDLE uses ◐ (distinct from ACTIVE ●) | `channel-detail.tsx:36` | `ddda39a` |
| Activity log dimColor removed — full visual weight for messages | `channel-detail.tsx:150` | `ddda39a` |
| Pane preview error state propagated to ChannelDetail (loading vs error distinction) | `app.tsx:166`, `detail-view.tsx`, `channel-detail.tsx` | `2a76916` |
| useMemo deps extracted to primitives (viewKind, viewEntityType, viewEntityId) | `app.tsx:163` | `2a76916` |

## False Positives
| Issue | File:Line | Reasoning |
|-------|-----------|-----------|
| Removed taskAction/scheduleAction helpers | `activity-feed.ts:127,157` | Both were identity functions. Loops/orchestrations/pipelines/channels retain helpers because they have non-trivial logic (iteration count, mode mapping, step formatting, round progress). Pattern is: helpers where needed, inline where trivial. |
| No test for pruning behavior (MAX_MESSAGES=500) | `channel-repository.test.ts` | Test already existed at line 944 from a prior session commit. Verified present and passing (285 repo tests). |
| Redundant useEffect deps in useChannelPanePreview | `use-channel-pane-preview.ts:86` | The useEffect body references enabled/sessionName/capturePaneFn directly in its early-return guard, independent of the doCapture callback. Removing them caused test flakiness (1/3 failures). These are genuine deps, not redundant. |

## Deferred to Tech Debt
| Issue | File:Line | Risk Factor |
|-------|-----------|-------------|
| No findUpdatedSince on ChannelRepository | `interfaces.ts:1019-1055` | Pre-existing API gap from Phase 7. In-memory filter applied (batch-2 fix) is sufficient. Adding the method requires new repository method + SQL + tests — out of scope. Per ADR-003. |

## Blocked
_(none)_
