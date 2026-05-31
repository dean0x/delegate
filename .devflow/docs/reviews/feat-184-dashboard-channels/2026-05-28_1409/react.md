# React Review Report

**Branch**: feat/184-dashboard-channels -> main
**Date**: 2026-05-28
**Diff**: `git diff 37efbc094027922e9cc86f6c6cec0a16e6e0da36...HEAD`

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

### MEDIUM

**Inconsistent exhaustiveness guards across switch statements in `pauseOrResumeEntity`** - `src/cli/dashboard/keyboard/entity-mutations.ts:151`
**Confidence**: 85%
- Problem: `cancelEntity` (line 91) and `deleteEntity` (line 213) both received exhaustive `never` guards in their default cases as part of this PR's changes. However, `pauseOrResumeEntity` (line 151) still uses a bare `default: break;` without the exhaustive guard. This is inconsistent and means a new `EntityKind` value could be silently ignored by `pauseOrResumeEntity` at runtime while being caught at compile time by the other two functions.
- Fix: Add the same exhaustive guard pattern:
  ```typescript
  default: {
    const _exhaustive: never = kind;
    void _exhaustive;
    break;
  }
  ```
  Note: `pauseOrResumeEntity` intentionally only handles schedule, loop, and channel -- the other kinds (task, orchestration, pipeline) are no-ops. To preserve that intent while still getting compile-time exhaustiveness, add explicit no-op cases for the remaining kinds before the default guard:
  ```typescript
  case 'task':
  case 'orchestration':
  case 'pipeline':
    break;
  default: {
    const _exhaustive: never = kind;
    void _exhaustive;
    break;
  }
  ```

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Member list could benefit from `useMemo` for selection comparison** - `src/cli/dashboard/views/channel-detail.tsx:143` (Confidence: 65%) -- The `channel.members.map()` call in the render body creates a new closure per render that calls `renderMemberRow` with an `isSelected` check. Since the parent is `React.memo`, this is unlikely to cause real performance issues, but if the member list grows large, memoizing the rendered member list or extracting a `MemberRow` component with `React.memo` would avoid unnecessary reconciliation when only `panePreview` changes. Low priority given small typical member counts.

- **`buildBreadcrumb` performs a linear `Array.find` scan on channels** - `src/cli/dashboard/components/header.tsx:117` (Confidence: 62%) -- `data?.channels.find((c) => c.id === entityId)` is called on every render of the Header (memoized, but re-renders on data changes). With FETCH_LIMIT of 50 channels max and Header rendering at 1-2Hz, this is negligible. A `Map`-based lookup would be theoretically cleaner per the `Set`/`Map` for O(1) lookups pattern [5], but the cost is trivial at this scale.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**React Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Condition

Fix the `pauseOrResumeEntity` exhaustiveness guard inconsistency (MEDIUM blocking) to match the pattern already applied to `cancelEntity` and `deleteEntity` in this same PR.

### Positive Observations

1. **Component composition is clean** -- `ChannelDetail` follows the established pure-view pattern: all data passed as props, `React.memo` wrapping, `displayName` set. No internal state or effects.

2. **Hook patterns are correct** -- `useChannelPanePreview` properly returns a cleanup function, manages `fetching`/`closing` refs to prevent overlapping polls and post-unmount setState, and resets state when deps change. Effect deps are complete and correct.

3. **The `fetchAllData` refactor eliminates unsafe positional casts** -- Replacing the `unwrapAll` + `unknown[]` cast with destructured `const [tasksResult, ...]` preserves type narrowing directly from `Promise.all`. This is a meaningful type-safety improvement.

4. **`dimColor` contrast fix** -- The change from unconditional `dimColor` to `dimColor={!isSelected}` with `color={isSelected ? 'white' : undefined}` correctly preserves readability when a member row is highlighted. This was identified and fixed from a prior review cycle.

5. **Exhaustive switch guards** -- `getPanelItems`, `panelToEntityKind`, `cancelEntity`, and `deleteEntity` all received proper `never` exhaustive guards. This protects against silent omissions when a new entity kind is added.

6. **Channel hint customization** -- `detailHints` correctly omits "Enter detail" for channels (which have no further drill-through) via a dedicated `baseChannel` string, avoiding misleading keyboard hints.

7. **`fetchMetricsExtras` now uses `channelRepository.findUpdatedSince`** -- Eliminates the prior workaround of filtering the full channel list in-memory. The channel activity feed now follows the same DB-backed pattern as all other entity types (applies ADR-003 -- the prior inline-filter was a known pre-existing gap).
