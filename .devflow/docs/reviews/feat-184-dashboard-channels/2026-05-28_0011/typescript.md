# TypeScript Review Report

**Branch**: feat/184-dashboard-channels -> main
**Date**: 2026-05-28

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Missing exhaustive `never` guards in `getPanelItems` and `panelToEntityKind` switches** - `src/cli/dashboard/keyboard/helpers.ts:22-37,72-87`
**Confidence**: 90%
- Problem: Both `getPanelItems()` and `panelToEntityKind()` handle all current `PanelId` cases including the new `'channels'` but lack a `default: { const _: never = panelId; ... }` exhaustive check. This means a future addition to the `PanelId` union will compile without error and silently return `undefined` at runtime, since TypeScript infers the return type as `T | undefined` when no default branch exists on a non-void function. The same pattern WAS correctly added to `getEntityDisplayFields` in `entity-browser-panel.tsx:131-134` and the `DetailView` switch in `detail-view.tsx:189-192` within this same PR, creating an inconsistency where some switches are protected and some are not.
- Fix: Add exhaustive `never` default to both switches:
  ```typescript
  // In getPanelItems:
  case 'channels':
    return toIdentifiables(data.channels ?? []);
  default: {
    const _exhaustive: never = panelId;
    return _exhaustive;
  }

  // In panelToEntityKind:
  case 'channels':
    return 'channel';
  default: {
    const _exhaustive: never = panelId;
    return _exhaustive;
  }
  ```

**Missing exhaustive `never` guard in `cancelEntity` switch** - `src/cli/dashboard/keyboard/entity-mutations.ts:45-91`
**Confidence**: 85%
- Problem: The `cancelEntity` switch statement handles all `EntityKind` values including the new `'channel'` case but has no `default: never` exhaustive guard. Unlike `deleteEntity` (which also lacks one but follows the same pre-existing pattern), `cancelEntity` is the most critical mutation path (user pressing 'c') and a missed case would silently swallow the cancel request. The `pauseOrResumeEntity` switch has a `default: break` which is intentionally non-exhaustive (only some entities support pause), so this finding applies specifically to `cancelEntity` and `deleteEntity`.
- Fix: Add `default: { const _: never = kind; throw new Error(\`Unhandled entity kind: \${_}\`); }` to the `cancelEntity` and `deleteEntity` switches.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Unnecessary null-coalescing on required `DashboardData.channels` property** - `src/cli/dashboard/keyboard/helpers.ts:35`
**Confidence**: 82%
- Problem: `data.channels ?? []` applies null-coalescing to `DashboardData.channels` which is typed as `readonly Channel[]` (required, not optional). The `?? []` is unreachable code since the type guarantees the property exists. This matches the pre-existing `data.pipelines ?? []` on line 33 (same file), suggesting it was copied from the pipelines pattern — but `pipelines` is also required on `DashboardData` (line 206 of types.ts), so both are unnecessary.
- Fix: Use `data.channels` directly (and optionally clean up `data.pipelines` too for consistency). The type system already guarantees the array is present.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`unwrapped.value as [...]` positional cast in `fetchAllData` lacks compile-time safety** - `src/cli/dashboard/use-dashboard-data.ts:266-279`
**Confidence**: 80%
- Problem: The destructuring of `unwrapped.value` uses a positional `as` cast against a manually-maintained tuple type. The channel additions correctly extend both the `Promise.all` array (lines 208-220) and the tuple cast (lines 266-279) to 12 elements, but the approach is inherently fragile — the compiler does not verify that the Promise.all order matches the tuple cast order. If a future contributor reorders the Promise.all entries without updating the cast, the types would silently be wrong. This is a pre-existing pattern (not introduced by this PR) that now spans 12 positional elements.
- Fix: No change needed in this PR. A future refactor could introduce a named helper that returns a properly-typed record instead of relying on positional tuple casts.

## Suggestions (Lower Confidence)

- **`data.pipelines ?? []` is also unnecessary** - `src/cli/dashboard/keyboard/helpers.ts:33` (Confidence: 78%) — Same issue as the channels null-coalescing: `pipelines` is a required field on `DashboardData`, making the fallback unreachable. Pre-existing.

- **`ChannelMessage.id` uses string concatenation pattern `cm-${crypto.randomUUID()}`** - `src/services/handlers/channel-message-persistence-handler.ts:90` (Confidence: 65%) — The `cm-` prefix is useful for visual identification but differs from other domain ID patterns which use branded types (e.g., `ChannelId()`, `TaskId()`). The message ID is only used as a database primary key and never leaves the persistence boundary, so the plain string approach is adequate, but a branded `ChannelMessageId` type would be more consistent with the codebase. Low priority.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**TypeScript Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The type cascade is executed thoroughly: `PanelId`, `EntityKind`, `ViewState`, `ActivityEntry.kind`, `NavState`, `DashboardData`, `DashboardMutationContext`, `TERMINAL_STATUSES`, `FILTER_CYCLES`, `PANEL_ORDER`, and `PANEL_JUMP_KEYS` are all expanded consistently to include `'channels'`. Discriminated unions and exhaustive `never` guards are applied in the critical rendering paths (`entity-browser-panel.tsx`, `detail-view.tsx`, `channel-detail.tsx`). The new `ChannelMessage` domain type, `ChannelMessageRowSchema` Zod validation, and `ChannelMessagePersistenceHandler` all follow Result-type patterns with zero `any` usage.

The two MEDIUM blocking findings (missing exhaustive `never` guards in `helpers.ts` switches) are real — they were added in other switches within this same PR, creating a consistency gap that should be closed before merge. The should-fix item (unnecessary `?? []`) is cosmetic but worth cleaning up since the correct pattern already exists in the same file.

Applies ADR-001 — channel name validation flows through CHANNEL_NAME_REGEX which is correctly referenced in channel-manager.ts validation and tmux session name derivation. The type system correctly propagates `ChannelId` branded types throughout the cascade.
