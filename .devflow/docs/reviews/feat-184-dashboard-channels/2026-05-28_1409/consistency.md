# Consistency Review Report

**Branch**: feat/184-dashboard-channels -> main
**Date**: 2026-05-28T14:09

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Exhaustive never guard missing in `pauseOrResumeEntity`** - `src/cli/dashboard/keyboard/entity-mutations.ts:151`
**Confidence**: 90%
- Problem: `cancelEntity` (line 91) and `deleteEntity` (line 213) both received exhaustive `never` guards in their `default` branches during this PR. However, `pauseOrResumeEntity` (line 151) still uses a bare `default: break;` without the exhaustive guard. This is an inconsistency within the same file, introduced by this diff — the pattern was applied to two of three switch statements but not the third.
- Fix: Add the same exhaustive guard pattern to `pauseOrResumeEntity`:
```typescript
default: {
  const _exhaustive: never = kind;
  void _exhaustive;
  break;
}
```
Note: `pauseOrResumeEntity` intentionally only handles `schedule`, `loop`, and `channel` — `task`, `orchestration`, and `pipeline` are no-ops. The bare `default: break;` is functionally equivalent to the exhaustive guard because the EntityKind union currently covers exactly those 6 cases. However, adding the exhaustive guard ensures compile-time detection if a 7th entity kind is added. The pattern should be uniform across all three mutation functions.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Channel `findUpdatedSince` JSDoc style diverges from established `@param` convention** - `src/core/interfaces.ts:1055-1059`
**Confidence**: 82%
- Problem: The existing `findUpdatedSince` declarations on `TaskRepository` (line 184), `ScheduleRepository` (line 385), and `LoopRepository` (line 731) use a consistent JSDoc format: `"Find {entities} updated since a given timestamp (v1.3.0)"` with `@param sinceMs` and `@param limit` tags. The new `ChannelRepository.findUpdatedSince` JSDoc (lines 1055-1059) uses a different style — no `@param` tags, no version reference, and a longer architectural explanation. (Note: `PipelineRepository.findUpdatedSince` at line 1004 also lacks JSDoc, a pre-existing omission.)
- Fix: Align the JSDoc with the established pattern:
```typescript
/**
 * Find channels updated since a given timestamp.
 * Backed by idx_channels_updated_at (migration v31).
 * @param sinceMs - Epoch milliseconds lower bound
 * @param limit - Maximum results to return
 */
findUpdatedSince(sinceMs: number, limit: number): Promise<Result<readonly Channel[]>>;
```

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Test mock completeness for detail-view channel tests** - `tests/unit/cli/dashboard/use-dashboard-data.test.ts:429,457` (Confidence: 65%) — Two test cases ("fetches channel messages when in channel detail view" at line 428 and "gracefully handles channel message fetch error" at line 456) create channelRepo overrides that omit `findUpdatedSince`. This is functionally harmless because detail views don't call `fetchMetricsExtras`, but it diverges from the pattern used by the other inline channelRepo override at line 411 which includes it. If a future refactor made `findUpdatedSince` callable in detail views, these tests would fail unexpectedly.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Consistency Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The PR demonstrates strong consistency overall. Key positives:
- `findUpdatedSince` implementation follows the exact repository pattern (prepared statement, `tryCatchAsync`, `operationErrorHandler`, `hydrateChannelRows`) used by all 5 peer repositories.
- The `unwrapAll` refactor to individual result destructuring maintains identical error message format (`"{Entity} fetch failed: {message}"`).
- `?? []` removal from `getPanelItems` is correct — `DashboardData.pipelines` and `.channels` are non-optional fields.
- The `selectedName === null` change in `resolveMemberIndex` now matches the sibling `resolveIterationIndex` pattern exactly.
- Channel hints correctly omit "Enter detail" since channel-detail has no further drill-through.
- The `saveMessage` transaction wrapping is a sound atomicity improvement consistent with how other repos use `this.db.transaction()`.
- The `getMessages` limit clamp (`Math.max(1, Math.min(...))`) is appropriately domain-specific.

Conditions: Apply the exhaustive never guard to `pauseOrResumeEntity` for uniformity with the other two mutation switch statements in the same file.
