# Architecture Review Report

**Branch**: feat/184-dashboard-channels -> main
**Date**: 2026-05-28

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

### MEDIUM

(none)

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

(none)

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | - | 0 | 0 |

**Architecture Score**: 9/10
**Recommendation**: APPROVED

## Detailed Analysis

### Layering and Dependency Direction

The changes consistently respect the established layering:

1. **Core layer** (`src/core/`): `ChannelMessage` domain type, `ChannelMessageSentEvent` event, `ChannelRepository` interface extensions (`saveMessage`, `getMessages`), and `TmuxSessionManagerCorePort.capturePaneContent` -- all defined as interfaces or value types at the core layer. No implementation-layer imports leak inward. The `capturePaneContent` addition to `TmuxSessionManagerCorePort` is display-only and correctly documented as such. **applies ADR-001** (channel names validated at core layer boundary).

2. **Implementation layer** (`src/implementations/`): `SQLiteChannelRepository` adds `saveMessage`/`getMessages` using prepared statements and Zod boundary validation (consistent with existing patterns). `TmuxSessionManager.capturePaneContent` validates the session name with `SESSION_NAME_REGEX` and clamps `lines` to `MAX_CAPTURE_LINES` -- defensive coding consistent with all other session methods.

3. **Service layer** (`src/services/`): `ChannelMessagePersistenceHandler` follows the exact same pattern as `UsageCaptureHandler` -- factory pattern with `create()`, `BaseEventHandler` template method, best-effort semantics, and error logging without propagation. `ChannelManager.codePointSlice` is a pure function for summary generation.

4. **Presentation layer** (`src/cli/dashboard/`): Pure views receive data as props with no side effects. `useChannelPanePreview` follows the `useResourceMetrics` pattern (fetching ref + closing ref + interval cleanup). The `App` component threads `capturePaneContent` as an optional prop, maintaining the same optional-dependency pattern used for `isTmuxSessionAlive`.

### SOLID Compliance

- **SRP**: Each new module has a single responsibility -- `ChannelMessagePersistenceHandler` persists messages, `useChannelPanePreview` polls capture-pane, `ChannelDetail` renders the channel view. No god-class tendencies.
- **OCP**: Channels are added as the 6th entity type by extending existing discriminated unions (`PanelId`, `ViewState`, `EntityKind`) and `Record<PanelId, ...>` types. Existing entity behavior is not modified. The `handleDetailKeys` chain-of-responsibility pattern (`||` short-circuit) allows new handlers to be inserted without modifying existing ones.
- **ISP**: `TmuxSessionManagerCorePort` gains `capturePaneContent` -- this is a display-only method that does not force any implementor to handle business logic. The full `TmuxSessionManagerPort` in the implementation layer extends the core port naturally.
- **DIP**: All dependencies are injected. `ChannelMessagePersistenceHandler` receives `ChannelRepository`, `EventBus`, and `Logger` via its deps interface. The dashboard receives `capturePaneContent` as a function prop, not a concrete class reference.

### Event-Driven Architecture Consistency

The `ChannelMessagePersistenceHandler` correctly follows the hybrid event-driven pattern documented in CLAUDE.md -- it subscribes to `ChannelMessageSent` events and persists summaries as a side-effect handler. This is structurally identical to `UsageCaptureHandler` subscribing to `TaskCompleted`. The handler is registered in `handler-setup.ts` as handler #13 with the same optional/best-effort pattern (non-fatal warning on creation failure). **avoids PF-004** (the handler deals with insert-only message persistence, no multi-step rollback needed).

### Pattern Consistency

- **Factory pattern**: `ChannelMessagePersistenceHandler.create()` -- private constructor + static factory + subscribeToEvents -- matches `UsageCaptureHandler`, `CheckpointHandler`, and all other factory handlers.
- **Handler registration**: Slot #13 in `setupEventHandlers`, guarded by `deps.channelRepository`, non-fatal on failure -- matches slots #8-12.
- **Dashboard data flow**: `fetchAllData` includes channels in the parallel fetch batch, `fetchDetailExtra` handles `channels` entity type, `fetchMetricsExtras` reuses the fetched channel list (documented workaround for missing `findUpdatedSince`) -- all consistent with other entity types.
- **Keyboard navigation**: Channel member navigation in `handleChannelNavigation` mirrors `handleLoopNavigation` exactly (track by domain key, resolve index, clamp bounds).
- **Entity browser**: Channels are the 6th panel in `PANEL_ORDER`, with correct entries in `FILTER_CYCLES`, `TERMINAL_STATUSES`, `PANEL_JUMP_KEYS`, and `ENTITY_LABEL`.

### Migration v32

The `channel_messages` table has proper FK with `ON DELETE CASCADE`, three covering indexes (by channel_id, by channel+round DESC, by channel+created_at DESC), and appropriate NOT NULL constraints. The pruning strategy (`MAX_MESSAGES_PER_CHANNEL`) with count-before-prune guard prevents unbounded table growth.

### Tmux Port Hierarchy

The FEATURE_KNOWLEDGE describes a four-class hierarchy: TmuxValidator -> TmuxSessionManager -> TmuxHooks -> TmuxConnector. `capturePaneContent` is added at the `TmuxSessionManager` level (core port) and correctly not added to `TmuxConnectorPort` since the dashboard consumes it directly via `TmuxSessionManagerCorePort` -- this keeps the connector focused on managed session lifecycle. The method is not leaked to business logic since it is a display-only read.
