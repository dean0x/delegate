# TypeScript Review Report

**Branch**: feat/184-dashboard-channels -> main
**Date**: 2026-05-27

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Missing exhaustive `never` guard in `detail-view.tsx` switch on `entityType`** - `src/cli/dashboard/views/detail-view.tsx:97`
**Confidence**: 82%
- Problem: The switch on `entityType` (type `PanelId`) covers all 6 cases but lacks a `default: { const _: never = entityType; ... }` guard. If `PanelId` gains a 7th variant, the switch silently falls through returning `undefined` (rendered as nothing by React) instead of producing a compile-time error. The new `channel-detail.tsx:50` in this very PR demonstrates the correct pattern with its `never` guard on `ChannelMemberStatus`. The prior cycle 1 resolution (commit `bcb03e0`) also fixed this exact pattern in `memberStatusColor`. Applies ADR-001 (channel name validation shows the project takes type exhaustiveness seriously).
- Fix: Add a default case after the `channels` branch:
  ```typescript
  default: {
    const _exhaustive: never = entityType;
    return <Text color="red">Unknown entity type: {_exhaustive}</Text>;
  }
  ```

**Missing exhaustive `never` guard in `entity-browser-panel.tsx` `getEntityDisplayFields`** - `src/cli/dashboard/components/entity-browser-panel.tsx:65`
**Confidence**: 82%
- Problem: Same pattern as above. The switch covers all 6 `PanelId` cases and TypeScript infers exhaustiveness from the return type, but a `default: never` guard makes the intent explicit and produces a more actionable compiler error message when a new panel is added. Consistency with the `channel-detail.tsx:50` pattern in this same PR.
- Fix: Add after the `channels` case:
  ```typescript
  default: {
    const _exhaustive: never = panelId;
    return _exhaustive;
  }
  ```

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **`codePointSlice` could use `string.prototype[Symbol.iterator]` instead of `Array.from`** - `src/services/channel-manager.ts:108` (Confidence: 65%) -- `Array.from(str)` allocates a full array of code points for a 200-character limit. For very long messages, a generator-based approach or a simple `for...of` loop with a counter would avoid the intermediate allocation. In practice the 200 limit bounds the output, so the allocation is bounded by input size.

- **`useChannelPanePreview` synchronous capture in `doCapture` may block React render** - `src/cli/dashboard/use-channel-pane-preview.ts:50` (Confidence: 70%) -- `capturePaneFn` calls `execSync` under the hood (tmux session manager). If tmux hangs, the synchronous exec call blocks the Node event loop, freezing the entire dashboard until timeout. Other tmux operations in the dashboard (like `isTmuxSessionAlive`) have the same characteristic, so this is a pre-existing architectural pattern rather than a regression.

- **Tuple type assertion in `fetchAllData` could drift if `Promise.all` order changes** - `src/cli/dashboard/use-dashboard-data.ts:266` (Confidence: 62%) -- The `as [TaskList, LoopList, ..., StatusMap, StatusMap, ...]` assertion on `unwrapped.value` is manually synchronized with the `Promise.all` order. If someone reorders the parallel fetches without updating the destructuring, the types silently mismatch at runtime. This is a pre-existing pattern applied to all 6 entity types; not introduced by this PR.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**TypeScript Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

## Rationale

This PR demonstrates strong TypeScript discipline across ~2,850 lines of changes touching 45 files:

**Strengths:**
- Zero `any` usage across the entire diff -- all new types use explicit interfaces and branded types (applies ADR-001 pattern for `ChannelId` branded type)
- `PanelId` union type expanded consistently in all 15+ files that reference it -- `types.ts`, `constants.ts`, `entity-tabs.tsx`, `header.tsx`, `metrics-view.tsx`, `keyboard/helpers.ts`, etc.
- `ViewState` discriminated union correctly extended with the `channels` variant, preserving the pattern established for tasks/loops/schedules/orchestrations/pipelines
- `EntityKind` union expanded with `'channel'` and all switch statements in `entity-mutations.ts` updated with the new case
- `ActivityEntry.kind` union expanded in domain.ts and `buildActivityFeed` handles the new `'channel'` kind
- New `ChannelMessage` domain type with proper readonly fields and branded `ChannelId`
- `ChannelMessageRowSchema` Zod schema validates at the DB boundary (parse-don't-validate pattern)
- `ChannelMessagePersistenceHandler` follows the established factory-pattern with `Result` types throughout
- `TmuxSessionManagerCorePort.capturePaneContent` added with proper `Result<string, AutobeatError>` return type and input validation
- `DashboardMutationContext` uses optional `ChannelService?` / `ChannelRepository?` for graceful degradation
- `useChannelPanePreview` hook follows the established `useResourceMetrics` pattern (fetching/closing refs)
- `resolveSelectedMember` is correctly generic (`<T extends { name: string }>`)
- The `never` exhaustive guard in `memberStatusColor` (channel-detail.tsx:50) is correctly implemented (cycle 1 fix confirmed)

**Minor gaps (the 2 MEDIUM findings):**
- Two switch statements on `PanelId` lack explicit `never` guards. TypeScript's control flow analysis catches missing cases via return type inference, so these are not bugs today. However, explicit `never` guards are the project's documented best practice (seen in `channel-detail.tsx:50` and `nav-reducer.ts:56`) and provide clearer compiler errors when the union expands.

The type cascade from `PanelId` through `EntityKind`, `ViewState`, `NavState`, `DashboardData`, `ActivityEntry.kind`, and all keyboard/mutation handlers is complete and consistent. No type holes or unsafe assertions were introduced. Avoids PF-004 (rollback completeness -- the `deleteEntity` channel case properly guards on terminal status before repo delete).
