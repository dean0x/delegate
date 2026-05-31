# Architecture Review Report

**Branch**: feat/184-dashboard-channels -> main
**Date**: 2026-05-27
**Prior Resolutions**: Cycle 1 resolved 10/11 issues (1 FP). This is Cycle 2.

## Issues in Your Changes (BLOCKING)

### HIGH

(none)

### MEDIUM

(none)

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **channels field optional in BuildActivityFeedArgs but not in DashboardData** - `src/cli/dashboard/activity-feed.ts:104` (Confidence: 65%) -- `channels` is `readonly ChannelLike[] | undefined` in `BuildActivityFeedArgs` but `readonly Channel[]` (required) in `DashboardData`. The mismatch is intentional (backward compat for callers that do not yet supply channels), but the dual contract could confuse future maintainers. A minor consistency observation only.

- **DashboardMutationContext optional fields asymmetry** - `src/cli/dashboard/types.ts:59-62` (Confidence: 60%) -- `pipelineRepo`, `channelService`, and `channelRepo` are optional (`?`), but other repos (taskRepo, loopRepo, etc.) are required. This follows the established pattern for "later-added" entity support and degrades gracefully. However, if all six entities are now first-class, a future consolidation pass could make all required. Low risk.

- **Handler count arithmetic is fragile** - `src/services/handler-setup.ts:574-581` (Confidence: 70%) -- `totalHandlers: standardHandlers.length + 4 + (orchestrationHandler ? 1 : 0) + ...` uses a hardcoded `4` for the mandatory factory handlers. Adding or removing a mandatory factory handler requires updating this literal. A computed value (e.g., collecting all mandatory handlers into an array) would be less fragile.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Architecture Score**: 9/10
**Recommendation**: APPROVED

## Detailed Rationale

### Layering and Dependency Direction

The change respects the established Clean Architecture layering:

- **Core layer** (`src/core/`): Only additions -- `ChannelMessage` domain type, `ChannelMessageSentEvent.summary` field, `capturePaneContent` on `TmuxSessionManagerCorePort`, `ChannelRepository.saveMessage/getMessages` on the interface. No imports from implementations or services.
- **Implementations** (`src/implementations/`): `SQLiteChannelRepository` adds message persistence. `TmuxSessionManager` adds `capturePaneContent`. Both depend only on core types.
- **Services** (`src/services/`): `ChannelMessagePersistenceHandler` follows the `UsageCaptureHandler` template precisely -- factory pattern, `BaseEventHandler`, best-effort error handling, single concern. `ChannelManager` emits the event with a summary.
- **CLI/Dashboard** (`src/cli/dashboard/`): Consumes core types and interfaces only. No reverse imports detected.

No circular dependencies introduced. All dependency arrows point inward. (applies ADR-001 -- channel names remain tmux-compatible throughout the new code paths)

### Event-Driven Pattern Adherence

The `ChannelMessagePersistenceHandler` follows the hybrid event-driven architecture correctly:

1. Subscribes to `ChannelMessageSent` events via `EventBus`
2. Writes to `channel_messages` via `ChannelRepository` (write path through event handler)
3. Dashboard reads via `ChannelRepository.getMessages()` (query via direct repo access)
4. Factory pattern with `create()` matches `UsageCaptureHandler`, `CheckpointHandler` -- consistent initialization
5. Best-effort error handling -- warns but never throws, never propagates
6. Registered as optional handler #13 in `handler-setup.ts`, following the exact pattern of handlers #9-12

### Single Responsibility

Each new module has one clear responsibility:

| Module | Responsibility |
|--------|---------------|
| `ChannelMessagePersistenceHandler` | Persist message summaries on event |
| `useChannelPanePreview` | Poll tmux capture-pane for a session |
| `ChannelDetail` | Render channel detail view (pure component) |
| `channel-detail.tsx` handlers | Channel-specific keyboard navigation |

No god classes or multi-concern modules detected.

### Type System and Domain Modeling

- `PanelId` union extended: `'channels'` added alongside existing 5 panel types -- all `Record<PanelId, ...>` initializers updated consistently across `INITIAL_NAV`, `FILTER_CYCLES`, `PANEL_ORDER`, `PANEL_JUMP_KEYS`, `TERMINAL_STATUSES`, and `ENTITY_LABEL`
- `EntityKind` union extended: `'channel'` added, `cancelEntity`/`deleteEntity`/`pauseOrResumeEntity` switch arms cover it
- `ViewState` discriminated union extended: `entityType: 'channels'` variant with `ChannelId` and `returnTo: 'main'`
- `ActivityEntry.kind` extended: `'channel'` added to the domain type in `domain.ts`
- `ChannelMessage` domain type added in core with branded `ChannelId`

Type cascade is complete -- no missing switch arms or uncovered union variants detected. (avoids PF-004 -- rollback layers are not affected by this read-only dashboard feature)

### Consistency with Existing Entity Patterns

Channels follow the exact patterns established by pipelines (the most recently added entity):

1. **Dashboard data flow**: `fetchAllData` adds `channels` to the parallel `Promise.all` batch -- same pattern as pipelines
2. **Detail extras**: `fetchDetailExtra` fetches `channelMessages` when `entityType === 'channels'` -- mirrors pipeline step tasks
3. **Keyboard handling**: `handleChannelNavigation` in `handle-detail-keys.ts` follows the loop iteration pattern (member name as stable key, not array index)
4. **Mutation wiring**: `DashboardMutationContext` adds optional `channelService` + `channelRepo` -- mirrors `pipelineRepo` optionality
5. **Index wiring**: `index.tsx` resolves `capturePaneContent` alongside `isTmuxSessionAlive` -- consistent optional tmux feature

### Migration Design (v32)

The `channel_messages` table migration is well-designed:

- FK to `channels(id)` with `ON DELETE CASCADE` -- messages are automatically cleaned up when a channel is deleted
- Three indexes covering the query patterns: by `channel_id`, by `(channel_id, round DESC)`, by `(channel_id, created_at DESC)`
- Pruning at 500 messages per channel built into `saveMessage()` prevents unbounded growth (Cycle 1 resolution)

### Security and Boundary Validation

- `capturePaneContent` validates session name via `validateSessionName` (SESSION_NAME_REGEX)
- `lines` parameter bounded: `0 < lines <= MAX_CAPTURE_LINES (10_000)`, integer check (Cycle 1 resolution)
- Zod schemas validate `ChannelMessageRow` at the repository boundary
- `codePointSlice` truncation is surrogate-pair-safe -- documented design decision

### Cross-Cycle Awareness (Cycle 1 Fixes Verified)

All 10 Cycle 1 fixes are architecturally sound and still present in this diff:
- N+1 batch loading (`hydrateChannelRows`) -- confirmed in repository
- TERMINAL_STATUSES centralized pattern -- confirmed in `constants.ts`
- Bounded message list (MAX_MESSAGES_PER_CHANNEL = 500) -- confirmed in repository
- Validated lines param -- confirmed in `capturePaneContent`
- Never exhaustive guard -- confirmed in `channel-detail.tsx` member status color
