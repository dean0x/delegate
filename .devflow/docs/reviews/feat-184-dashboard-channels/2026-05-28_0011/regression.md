# Regression Review Report

**Branch**: feat/184-dashboard-channels -> main
**Date**: 2026-05-28

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

### MEDIUM

**Health summary omits destroyed channels from "failed" counter** - `src/cli/dashboard/components/header.tsx:59-65`
**Confidence**: 82%
- Problem: `buildHealthSummary()` aggregates `failed` and `cancelled` counts from all entity types into the "failed" counter, but does not include `channelCounts.byStatus['destroyed']`. Since channels have no `failed` status, `destroyed` is the terminal-error analog (user-initiated kill). Without it, the header health summary under-reports terminal channel states. The existing 5 entity types all contribute their terminal-error statuses to this counter -- channels being absent is an inconsistency.
- Fix: Add `(data.channelCounts.byStatus['destroyed'] ?? 0)` to the `failed` accumulator, matching the pattern for `pipelineCounts.byStatus['cancelled']` and `scheduleCounts.byStatus['cancelled']`.

```typescript
const failed =
  (data.taskCounts.byStatus['failed'] ?? 0) +
  (data.loopCounts.byStatus['failed'] ?? 0) +
  (data.scheduleCounts.byStatus['cancelled'] ?? 0) +
  (data.orchestrationCounts.byStatus['failed'] ?? 0) +
  (data.pipelineCounts.byStatus['failed'] ?? 0) +
  (data.pipelineCounts.byStatus['cancelled'] ?? 0) +
  (data.channelCounts.byStatus['destroyed'] ?? 0);
```

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **`removeActivityFeed` inlining of `taskAction`/`scheduleAction`** - `src/cli/dashboard/activity-feed.ts:127,157` (Confidence: 65%) -- Two identity functions (`taskAction`, `scheduleAction`) were removed and their return value inlined as `task.status` / `sched.status`. This is correct and simplifies the code. However, if future entity-specific verb mapping is needed (e.g. task status "blocked" -> "waiting"), the dedicated functions would need to be re-introduced. Low concern since the pattern is trivial to restore.

- **`ChannelService` resolution in dashboard cli mode** - `src/cli/dashboard/index.tsx:149` (Confidence: 62%) -- `channelService` is lazily registered and only pre-resolved in `server`/`run` modes. In `cli` (dashboard) mode, `container.get<ChannelService>('channelService')` runs the factory at first access. If `ChannelManager.create()` fails (e.g. tmux unavailable), mutations degrade gracefully (channelService is undefined). This is correct behavior. The minor concern is that the factory invocation adds latency to dashboard startup -- but this matches the pattern used by all other optional services and is unlikely to be noticeable.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Regression Score**: 9/10
**Recommendation**: APPROVED_WITH_CONDITIONS

## Regression Checklist

- [x] No exports removed -- zero removed export statements in entire diff
- [x] Return types backward compatible -- all existing function signatures preserved; new optional fields added
- [x] Default values unchanged -- INITIAL_NAV expanded with `channels: 0` / `channels: null` defaults (additive)
- [x] Side effects preserved -- all existing event handlers, logging, and event emission untouched
- [x] All consumers of changed code updated -- PanelId, EntityKind, ViewState, NavState, DashboardData all extended with `channels` variant; all switch/Record sites updated with exhaustive `never` guards
- [x] Migration complete across codebase -- `'channels'` added to all Record<PanelId, ...> initializers across 7+ files
- [x] CLI options preserved -- no CLI changes affect existing options
- [x] API endpoints preserved -- MCP tools unchanged (new tools added, none removed)
- [x] Commit message matches implementation -- type cascade, new handler, new migration, new views all present
- [x] Breaking changes documented -- migration v32 is additive (CREATE TABLE IF NOT EXISTS), no schema breaks

## Analysis Notes

**Type Cascade Completeness** (applies ADR-003 -- pre-existing gaps tracked separately):
The PR extends `PanelId`, `EntityKind`, `ActivityEntry.kind`, `ViewState`, `NavState`, `DashboardData`, and `DashboardMutationContext` with channel variants. TypeScript exhaustive `never` guards enforce completeness at compile time. All existing entity types (tasks, loops, schedules, orchestrations, pipelines) continue to work identically -- the channel additions are purely additive.

**Handler Registration** (avoids PF-001 -- all findings surfaced):
The new `ChannelMessagePersistenceHandler` follows the established factory pattern (matches UsageCaptureHandler, CheckpointHandler). Registration in `handler-setup.ts` is optional/best-effort. The prior resolution cycle fixed test coverage for handler registration.

**Migration v32**:
Additive-only migration -- `CREATE TABLE IF NOT EXISTS channel_messages` with three indexes. No existing tables modified. `ON DELETE CASCADE` foreign key to `channels(id)` ensures cleanup. Schema version test updated from 31 to 32.

**N+1 Query Fix**:
`findAll()` and `findByStatus()` switched from per-channel member queries (N+1) to a batched IN-clause fetch (`hydrateChannelRows`). Single-entity lookups (`findById`, `findByName`) retain the old pattern where N+1 is not a concern. This is a performance improvement, not a regression.

**Removed Functions**:
`taskAction()` and `scheduleAction()` were identity functions (`return status`). Their removal and inlining as `task.status` / `sched.status` is behaviorally identical.

**Pane Preview Hook**:
New `useChannelPanePreview` polls at 3s intervals, only when viewing a channel detail with a valid session name. The `closing` ref pattern prevents post-unmount setState. No existing hooks or polling intervals affected.
