# Reliability Review Report

**Branch**: feat/184-dashboard-channels -> main
**Date**: 2026-05-28

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Unbounded statement cache in `membersByChannelIdsStmtCache`** - `src/implementations/channel-repository.ts:136`
**Confidence**: 85%
- Problem: `membersByChannelIdsStmtCache` is a `Map<number, SQLite.Statement>` with no upper bound. Each distinct arity (count of channel IDs passed to `findMembersByChannelIds`) creates a new prepared statement that is cached permanently. While the arity is bounded by `DEFAULT_LIMIT` (100), the cache can accumulate up to 100 entries — each a compiled SQLite statement holding memory. In practice, the dashboard polling loop calls `findAll(FETCH_LIMIT)` which returns a variable number of rows depending on how many channels exist, meaning the arity stabilizes quickly. However, if channel count fluctuates (channels created/destroyed over time), the cache grows monotonically since entries are never evicted.
- Impact: Memory leak proportional to distinct channel-count values observed over the process lifetime. Each prepared statement holds a native SQLite resource. In long-running server processes, this could accumulate hundreds of dangling statements.
- Fix: Add an upper bound to the cache (e.g., LRU eviction or a simple size cap). At minimum, document the implicit bound as an assertion:
```typescript
// After the set():
if (this.membersByChannelIdsStmtCache.size > SQLiteChannelRepository.DEFAULT_LIMIT) {
  // Evict oldest entry — arity values beyond DEFAULT_LIMIT should never appear
  const firstKey = this.membersByChannelIdsStmtCache.keys().next().value;
  if (firstKey !== undefined) this.membersByChannelIdsStmtCache.delete(firstKey);
}
```

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Prune runs on every insert above threshold** - `src/implementations/channel-repository.ts:396-399` (Confidence: 70%) — The prune check runs a COUNT query + DELETE on every `saveMessage` call once the channel exceeds 500 messages. For high-throughput channels this adds two extra SQL operations per message. Consider batching: only prune every Nth insert (e.g., `count % 50 === 0`) or use a per-channel counter to avoid the COUNT query entirely. Current behavior is correct and bounded, but could be more efficient.

- **`doCapture` ref guards may mask subtle timing bugs** - `src/cli/dashboard/use-channel-pane-preview.ts:47-53` (Confidence: 65%) — The `fetching.current` guard prevents overlapping polls, but since `capturePaneFn` is synchronous (spawnSync), the guard is technically unnecessary — a synchronous call cannot overlap with itself within the same event loop tick. The guard does no harm and is defensive, but could mislead future readers into thinking the function is async.

- **No channel count/cancelled in health summary `failed` line** - `src/cli/dashboard/components/header.tsx:59-65` (Confidence: 62%) — The `buildHealthSummary` function counts `failed` status across tasks, loops, orchestrations, and pipelines, but does not include `channelCounts.byStatus['destroyed']` in the failed tally. Destroyed channels are semantically similar to cancelled/failed entities. Whether this is intentional depends on product intent.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Reliability Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Reliability Assessment

The PR demonstrates strong reliability practices overall:

1. **Bounded iteration** — All loops have known bounds. The `MAX_MESSAGES_PER_CHANNEL = 500` cap prevents unbounded message growth. `MAX_CAPTURE_LINES = 10_000` bounds the tmux capture. `getMessages` clamps its limit to `MAX_MESSAGES_PER_CHANNEL`. `FETCH_LIMIT` bounds all dashboard queries. Prune is guarded by a count check to avoid unnecessary scans (*avoids PF-004* — the prune error isolation ensures saveMessage succeeds even if prune fails, preventing partial state).

2. **Resource cleanup** — `useChannelPanePreview` uses the `closing.current` ref + `clearInterval` pattern consistent with existing hooks. The `fetching.current` guard prevents overlapping polls (defensive, since the underlying call is sync).

3. **Best-effort error handling** — `ChannelMessagePersistenceHandler` follows the `UsageCaptureHandler` pattern: errors are logged as warnings, never thrown, never propagated. Dashboard mutation operations (`cancelEntity`, `pauseOrResumeEntity`, `deleteEntity`) all swallow errors with the documented rationale that the next 1Hz poll corrects state.

4. **Assertion density** — `capturePaneContent` validates session name against `SESSION_NAME_REGEX` and bounds `lines` to `MAX_CAPTURE_LINES`. `updateRound` validates round is a non-negative integer. `ChannelMessageRowSchema` uses Zod parse-at-boundary for DB row validation.

5. **Statement cache** — The `membersByChannelIdsStmtCache` solves the N+1 query problem for `findAll`/`findByStatus` (previously 101 queries, now 2). The cache is implicitly bounded by `DEFAULT_LIMIT = 100` distinct arities, but lacks an explicit cap — the one blocking finding above.

### Condition for Approval

Add an explicit upper bound or eviction to `membersByChannelIdsStmtCache` to prevent unbounded native resource accumulation in long-running processes. A simple size check after `set()` is sufficient.
