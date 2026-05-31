# Consistency Review Report

**Branch**: feat-184-dashboard-channels -> main
**Date**: 2026-05-27
**PR**: #196

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Stale inline comment: "1-5" should be "1-6"** - `src/cli/dashboard/keyboard/handle-main-keys.ts:45`
**Confidence**: 95%
- Problem: The comment says `// 1-5 -- jump to panel by number` but this PR added key `6` for channels via `PANEL_JUMP_KEYS`. The hint string was correctly updated to `1-6: panel` but the inline code comment was not.
- Fix:
```typescript
// 1-6 — jump to panel by number
```

**Stale inline comment: pause/resume says "schedules and loops only"** - `src/cli/dashboard/keyboard/handle-main-keys.ts:176`
**Confidence**: 92%
- Problem: The comment says `// p -- pause/resume focused entity (schedules and loops only)` but this PR added channel pause/resume support. The `pauseOrResumeEntity` function now handles channels, and the hints correctly show pause/resume for channels, but this comment was not updated.
- Fix:
```typescript
// p — pause/resume focused entity (schedules, loops, and channels)
```

**Channel cancel does not use TERMINAL_STATUSES pattern** - `src/cli/dashboard/keyboard/entity-mutations.ts:84-94`
**Confidence**: 85%
- Problem: All other entity types in `cancelEntity` use the `TERMINAL_STATUSES` constant (a centralized Record mapping entity kind to its terminal status array) to guard against cancelling already-terminal entities. The channel case instead inlines `entityStatus !== ChannelStatus.DESTROYED && entityStatus !== ChannelStatus.COMPLETED`. This diverges from the established pattern and means `TERMINAL_STATUSES` does not include `channels` — a future developer adding cancel logic elsewhere for channels would not find the canonical terminal set in `constants.ts`.
- Fix: Add `channels` to the `TERMINAL_STATUSES` constant:
```typescript
// In constants.ts:
export const TERMINAL_STATUSES: {
  orchestrations: OrchestratorStatus[];
  loops: LoopStatus[];
  tasks: TaskStatus[];
  schedules: ScheduleStatus[];
  pipelines: PipelineStatus[];
  channels: ChannelStatus[];
} = {
  // ... existing entries ...
  channels: [ChannelStatus.DESTROYED, ChannelStatus.COMPLETED],
};

// In entity-mutations.ts cancelEntity:
case 'channel':
  if (
    !TERMINAL_STATUSES.channels.includes(entityStatus as ChannelStatus) &&
    mutations.channelService
  ) {
    await mutations.channelService.destroyChannel(entityId as ChannelId, 'user-requested');
    refreshNow();
  }
  break;
```

**Channel delete uses inline status check instead of TERMINAL_STATUSES** - `src/cli/dashboard/keyboard/entity-mutations.ts:202-211`
**Confidence**: 85%
- Problem: Same pattern deviation as above — `deleteEntity` for channels inlines `entityStatus === ChannelStatus.DESTROYED || entityStatus === ChannelStatus.COMPLETED` instead of using `TERMINAL_STATUSES.channels`. Other entity types consistently use the constant.
- Fix: Same as above — once `TERMINAL_STATUSES.channels` exists, use it here:
```typescript
case 'channel':
  if (
    TERMINAL_STATUSES.channels.includes(entityStatus as ChannelStatus) &&
    mutations.channelRepo
  ) {
    await mutations.channelRepo.delete(entityId as ChannelId);
    refreshNow();
  }
  break;
```

## Issues in Code You Touched (Should Fix)

_(none)_

## Pre-existing Issues (Not Blocking)

_(none)_

## Suggestions (Lower Confidence)

- **`channelService` optionality inconsistency with `channelRepo`** - `src/cli/dashboard/types.ts:59-62` (Confidence: 70%) — `channelService` and `channelRepo` are both optional (`?`) in `DashboardMutationContext`, but `pipelineRepo` is the only other optional field in that interface (all others like `orchestrationService`, `loopService`, `scheduleService`, `taskManager` are required). The channel fields being optional makes sense because they are new, but the `channelService?.` null checks sprinkled through entity-mutations could be avoided if the mutation context required both when channels are available. This is a minor architectural preference, not a bug.

- **`channels?: readonly ChannelLike[]` optional in BuildActivityFeedArgs while all others required** - `src/cli/dashboard/activity-feed.ts:104` (Confidence: 65%) — This is documented as intentional (ChannelRepository lacks `findUpdatedSince` so the full-fetch result is reused), but it creates a subtle asymmetry. Other entity types have dedicated `findUpdatedSince` queries for the activity feed. If a future `findUpdatedSince` is added to ChannelRepository, this field should be made required to match the pattern.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 4 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Consistency Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The PR demonstrates strong consistency overall. Channels are integrated as a 6th entity panel following the established patterns for all 5 existing panels: `PanelId` union, `PANEL_ORDER`, `FILTER_CYCLES`, `PANEL_JUMP_KEYS`, `ViewState` discriminated union, `NavState` per-panel records, `DashboardData` fields, `fetchAllData` parallel batch, `fetchDetailExtra` dispatch, `EntityBrowserPanel` switch, `DetailView` switch, keyboard handler chains, and hint strings. The new `ChannelMessagePersistenceHandler` mirrors the `UsageCaptureHandler` factory pattern exactly. The `capturePaneContent` tmux method follows the same validation/error pattern as all sibling methods. The `useChannelPanePreview` hook follows the same ref-guarded polling pattern as `useResourceMetrics`.

The four MEDIUM findings are all about maintaining pattern consistency with the centralized `TERMINAL_STATUSES` constant and keeping inline comments in sync with the expanded entity set. None are functional bugs — they are consistency deviations that could cause confusion for future contributors. Applies ADR-001 (channel names validated via SESSION_NAME_REGEX — the `capturePaneContent` method correctly uses `validateSessionName` which enforces this).
