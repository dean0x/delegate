# TypeScript Review Report

**Branch**: feat/184-dashboard-channels -> main
**Date**: 2026-05-27

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Missing exhaustive `never` guard in `memberStatusColor` switch** - `src/cli/dashboard/views/channel-detail.tsx:37-46`
**Confidence**: 90%
- Problem: The `memberStatusColor` function uses a `switch` over `ChannelMemberStatus` that covers all 3 current variants but lacks a `default: never` exhaustive check. If a fourth status is added to the enum, this function will silently return `undefined` (type mismatch with declared `string` return) instead of producing a compile-time error. The project's CLAUDE.md engineering principles explicitly call for exhaustive switch with `never`.
- Fix:
```typescript
function memberStatusColor(status: ChannelMemberStatus): string {
  switch (status) {
    case ChannelMemberStatus.ACTIVE:
      return 'green';
    case ChannelMemberStatus.IDLE:
      return 'yellow';
    case ChannelMemberStatus.DESTROYED:
      return 'gray';
    default: {
      const _: never = status;
      return 'gray';
    }
  }
}
```

**No validation on `lines` parameter before shell interpolation** - `src/implementations/tmux/tmux-session-manager.ts:439-443`
**Confidence**: 85%
- Problem: The `capturePaneContent` method interpolates the `lines` parameter directly into a shell command (`` `tmux capture-pane -t '${name}' -p -S -${lines}` ``) without validating it is a positive integer. While the call chain only passes `undefined` (defaulting to 10), the public interface accepts any `number`. A negative number, zero, `NaN`, or non-integer would produce malformed tmux arguments. Other methods in this class (e.g., `validateDimensions` at line 167) validate numeric parameters before interpolation. This is a defensive-depth gap in an otherwise well-guarded class.
- Fix:
```typescript
capturePaneContent(name: string, lines = 10): Result<string, AutobeatError> {
  const nameCheck = validateSessionName(name, 'capturePaneContent');
  if (!nameCheck.ok) return nameCheck;

  if (!Number.isInteger(lines) || lines <= 0) {
    return err(
      tmuxSessionFailed('capturePaneContent', `lines must be a positive integer, got ${lines}`, {
        sessionName: name,
        lines,
      }),
    );
  }

  const result = this.deps.exec(`tmux capture-pane -t '${name}' -p -S -${lines}`);
  // ...
```

### LOW

**Redundant `ChannelId()` wrapping of already-branded value** - `src/services/handlers/channel-message-persistence-handler.ts:91`
**Confidence**: 85%
- Problem: `ChannelId(event.channelId)` is called where `event.channelId` is already typed as `ChannelId` (branded type). The `ChannelId` function is `(id: string) => id as ChannelId`, so this is a no-op cast. It introduces cognitive noise, suggesting the value might need conversion when it does not.
- Fix: Use `event.channelId` directly:
```typescript
const msg = {
  id: `cm-${crypto.randomUUID()}`,
  channelId: event.channelId,
  // ...
};
```

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **`channelAction` uses `string` parameter instead of `ChannelStatus` enum** - `src/cli/dashboard/activity-feed.ts:38` (Confidence: 65%) -- The `channelAction` function takes `status: string` rather than `ChannelStatus` from the domain enum. Other entity action functions in the same file follow the same `string` pattern (pre-existing), but since channels are new code, using the typed enum would provide compile-time safety against status string typos.

- **`ChannelLike` interface uses `string` for status instead of `ChannelStatus`** - `src/cli/dashboard/activity-feed.ts:87-96` (Confidence: 70%) -- The `ChannelLike` interface types `status` as `string` rather than `ChannelStatus`. This matches the other `*Like` interfaces in the same file (pre-existing pattern), but since this is new code, it could use the enum for stronger typing.

- **Optional `channelService` and `channelRepo` on `DashboardMutationContext`** - `src/cli/dashboard/types.ts:59-62` (Confidence: 60%) -- Both `channelService` and `channelRepo` are optional on `DashboardMutationContext`, requiring nil-checks at every usage site (`mutations.channelService`, `mutations.channelRepo`). This matches the existing `pipelineRepo?` pattern, so it is consistent, but the repeated `&& mutations.channelService` guards in `entity-mutations.ts` add cyclomatic complexity.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 1 |
| Should Fix | - | - | 0 | - |
| Pre-existing | - | - | 0 | 0 |

**TypeScript Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The TypeScript quality is strong overall. Type safety is well-maintained with branded types (`ChannelId`, `TaskId`), discriminated unions for `ViewState`, proper `readonly` annotations throughout all interfaces, `import type` usage, and consistent `Result<T, E>` return types. The two medium-severity items -- missing `never` exhaustive guard and unvalidated numeric shell interpolation -- are the only conditions before merge. The low-severity redundant branding is a cleanup item.

Decisions context applied: The code correctly applies ADR-001 (channel name validation constrained to tmux SESSION_NAME_REGEX) -- `validateSessionName` is called in `capturePaneContent` as in all other session operations, and `CHANNEL_NAME_REGEX` is used consistently in the channel manager.
