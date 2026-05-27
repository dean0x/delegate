# Phase 9 Handoff: feat/184-dashboard-channels (Steps 1-6 Complete)

## Branch
`feat/184-dashboard-channels`

## Commits (Steps 1-6)
- `5d009a7` feat(dashboard): Step 1 - add capturePaneContent to tmux infrastructure
- `1686f37` feat(dashboard): Step 2 - migration v32, ChannelMessage domain type, message persistence handler
- `b30d83b` feat(dashboard): Step 3 - expand type system to channels as 6th entity panel
- `61fa456` feat(dashboard): Step 4 - wire channel data into polling hook
- `8ff2cb2` feat(dashboard): Step 5a - add channels to activity feed
- `6dab03e` feat(dashboard): Step 5b - wire channel keyboard navigation
- `81be164` style: apply biome import ordering and formatting fixes

## Test Status
- `npm run test:dashboard` — 698 passing (26 files) ✅
- `npm run test:repositories` — 279 passing (8 files) ✅
- `npm run test:services` — 387 passing (14 files) ✅
- `npm run typecheck` — clean ✅
- `npm run check` — clean ✅

## Files Created (Steps 1-3, from prior phase)
- `src/services/handlers/channel-message-persistence-handler.ts`
- `tests/unit/services/handlers/channel-message-persistence-handler.test.ts`

## Files Modified (Steps 4-6)

### Step 4: Data Fetching
- `src/cli/dashboard/use-dashboard-data.ts`:
  - `fetchAllData`: adds `channelRepository.findAll(FETCH_LIMIT)` and `countByStatus()` to the parallel `Promise.all` batch (positions 5 and 11). Wires `channels` (ChannelList) and `channelCounts` (StatusMap) from `unwrapped.value`. Replaces `channels: []` and `channelCounts: buildEntityCounts({})` stubs.
  - `fetchMetricsExtras`: now accepts `channels: readonly Channel[]` as a second parameter (pre-fetched in `fetchAllData`; ChannelRepository has no `findUpdatedSince`). Passes `channels` through to `buildActivityFeed`.
  - `fetchDetailExtra`: adds `case 'channels'` — calls `ctx.channelRepository.getMessages(detail.entityId, 50)`, returns `{ channelMessages: result.ok ? result.value : undefined }` (best-effort, graceful degradation).
  - Import: `Channel` type added to domain import.
- `tests/unit/cli/dashboard/use-dashboard-data.test.ts`:
  - `makeCtx` extended with `channelRepository` mock (findAll, countByStatus, getMessages)
  - New tests: channel polling wires data, channel detail fetches messages, main view does not fetch messages, graceful degradation on message error, error propagation for findAll/countByStatus failures.

### Step 5a: Activity Feed
- `src/cli/dashboard/activity-feed.ts`:
  - `channelAction(status, currentRound?, maxRounds?)`: returns `'round N/M'` when status=active and both round values present; otherwise returns status string.
  - `ChannelLike` interface: `{ id, status, updatedAt?, createdAt?, currentRound?, maxRounds? }`
  - `BuildActivityFeedArgs`: `channels?: readonly ChannelLike[]` added (optional, backward-compatible)
  - `buildActivityFeed`: destructures `channels` from args; adds channel entries loop after pipelines loop; uses `??[]` guard for optional param.
- `tests/unit/cli/dashboard/activity-feed.test.ts`:
  - New `describe('channel verb mapping')` block: round formatting, status pass-through for paused/completed/destroyed, sorting with other entity kinds, graceful omission when channels=undefined or empty.

### Step 5b: Keyboard Handlers
- `src/cli/dashboard/keyboard/handle-detail-keys.ts`:
  - `handleChannelNavigation(input, key, params)`: guard on `view.entityType !== 'channels'`; resolves channel from `dataRef.current?.channels`; up/k decrements index, down/j increments; updates `channelMemberSelectedName` (mirrors loop iteration pattern using `.name` as stable key). Returns false on non-arrow keys for fallthrough to generic scroll.
  - Added as step 6 (before generic scroll) in `handleDetailKeys` dispatcher.
  - Doc-comment updated to list channel member navigation, updated step numbering.
- `src/cli/dashboard/keyboard/handle-main-keys.ts`:
  - Import: added `ChannelId` to domain imports.
  - Enter handler: added `case 'channels'` — sets view `{ kind: 'detail', entityType: 'channels', entityId: selectedItem.id as ChannelId, returnTo: 'main' }`.
  - `setNav` on Enter: added `channelMemberSelectedName: null` to the reset block (mirrors `loopIterationSelectedNumber: null` pattern).

### Biome formatting (no logic changes)
- `src/cli/dashboard/keyboard/constants.ts` — PANEL_ORDER reformatted to multi-line
- `src/cli/dashboard/keyboard/entity-mutations.ts` — import reformatted to multi-line
- `src/core/interfaces.ts` — import reordering
- `src/implementations/channel-repository.ts` — import reordering
- `tests/unit/implementations/channel-repository.test.ts` — import reordering
- `tests/unit/services/handlers/channel-message-persistence-handler.test.ts` — import reordering

## Patterns Established (Steps 4-6)
- **Channel in parallel batch**: `channelRepository.findAll` and `countByStatus` added at positions 5 and 11 in `fetchAllData`'s `Promise.all`; `ChannelList` type alias follows `PipelineList` pattern.
- **No findUpdatedSince on ChannelRepository**: Pass pre-fetched `channels` to `fetchMetricsExtras` rather than adding a separate query; the same channels from the main batch go into the activity feed.
- **Optional channels param in BuildActivityFeedArgs**: `channels?` is optional (not `channels`) for backward compatibility with existing callers that don't pass channels.
- **channelMemberSelectedName**: uses member `.name` as stable key (analogous to `loopIterationSelectedNumber` using iterationNumber). Resolves index via `members.findIndex(m => m.name === prev.channelMemberSelectedName)`.
- **handleChannelNavigation returns false for non-arrow keys**: unlike loop/orchestration navigation which swallow all keys, channel navigation falls through to generic scroll for non-arrow keys (e.g. p, c, d still work in channel detail).

## Integration Points for Steps 7-10

### Step 7: ChannelDetail component
- Location: `src/cli/dashboard/views/channel-detail.tsx` (new file to create)
- Replace `<NotFound>` stub in `src/cli/dashboard/views/detail-view.tsx` `channels` case
- Props shape needed:
  ```typescript
  interface ChannelDetailProps {
    channel: Channel;        // from data.channels.find(c => c.id === view.entityId)
    messages: readonly ChannelMessage[];  // from data.channelMessages ?? []
    selectedMemberName: string | null;    // from nav.channelMemberSelectedName
    scrollOffset: number;                 // from nav.scrollOffsets['channels']
    panePreview?: string;                 // from usePanePreview hook (Step 8)
  }
  ```
- Member list: render `channel.members` with status badges; highlight row where `member.name === selectedMemberName`
- Message list: render `messages` (newest-first from repo; display reversed or as-is)
- Round progress: show `currentRound / maxRounds` if maxRounds set

### Step 8: usePanePreview hook
- Location: `src/cli/dashboard/hooks/use-pane-preview.ts` (new file)
- Uses `capturePaneContent(name, lines)` from `TmuxSessionManagerCorePort` (added in Step 1)
- The `capturePaneContent` signature:
  ```typescript
  // TmuxSessionManagerCorePort (src/core/tmux-types.ts)
  capturePaneContent(name: string, lines?: number): Result<string, AutobeatError>
  ```
- React hook pattern: useState + useEffect + interval polling

### Step 9: Wire ChannelDetail into detail-view.tsx
- `src/cli/dashboard/views/detail-view.tsx` — channels case currently renders `<NotFound>` stub
- Extract channel from `data.channels.find(c => c.id === view.entityId)`
- Pass `nav.channelMemberSelectedName` and `nav.scrollOffsets['channels']`
- Pass `data.channelMessages ?? []`

### Step 10: Docs, help text, skills
- Update `skills/autobeat/` channel section
- Update help text in CLI commands if any channel dashboard entries needed

### Key Interfaces to Call
```typescript
// ChannelRepository (src/core/interfaces.ts)
findAll(limit?: number, offset?: number): Promise<Result<readonly Channel[]>>;
countByStatus(): Promise<Result<Record<string, number>>>;
getMessages(channelId: ChannelId, limit?: number): Promise<Result<readonly ChannelMessage[]>>;

// TmuxSessionManagerCorePort (src/core/tmux-types.ts)
capturePaneContent(name: string, lines?: number): Result<string, AutobeatError>;

// DashboardMutationContext (src/cli/dashboard/types.ts)
channelService?: ChannelService;  // for pause/resume/destroy
channelRepo?: ChannelRepository;  // for delete
```

### Key Types to Import
```typescript
// src/core/domain.ts
interface Channel {
  id: ChannelId; name: string; members: readonly ChannelMember[];
  communicationMode?: CommunicationMode; topic?: string;
  status: ChannelStatus; maxRounds?: number; currentRound: number;
  createdBy?: string; createdAt: number; updatedAt: number;
}
interface ChannelMember {
  name: string; agent: AgentProvider; systemPrompt?: string;
  tmuxSession: string; status: ChannelMemberStatus; joinedAt: number;
}
interface ChannelMessage {
  id: string; channelId: ChannelId; fromMember: string;
  toMember: string | null; round: number; summary: string; createdAt: number;
}
```

### NavState fields relevant to channel detail
```typescript
// src/cli/dashboard/types.ts (NavState)
channelMemberSelectedName: string | null;  // member name of highlighted row (null = first)
scrollOffsets: Record<PanelId, number>;    // 'channels' key for generic scroll
```

## Known Stubs / Deferred (remaining)
- `detail-view.tsx` channels case still renders `<NotFound>` — implement in Step 7
- `usePanePreview` hook not yet created — Step 8
- No keyboard tests for `use-keyboard.test.tsx` specifically testing channel navigation (the handler itself is tested via test:dashboard, but comprehensive E2E keyboard tests may be added in Step 5)
