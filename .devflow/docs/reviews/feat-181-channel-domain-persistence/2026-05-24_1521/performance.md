# Performance Review Report

**Branch**: feat/181-channel-domain-persistence -> main
**Date**: 2026-05-24T15:21

## Issues in Your Changes (BLOCKING)

### HIGH

**N+1 Member Loading in findAll / findByStatus** - `src/implementations/channel-repository.ts:188,197`
**Confidence**: 92%
- Problem: `findAll()` and `findByStatus()` call `this.rowToChannel(row)` for each parent row, which internally executes `this.findMembersByChannelIdStmt.all(validated.id)` -- a separate SQL query per channel. For a page of 100 channels (the default limit), this produces 1 + 100 = 101 queries. The PR's own test (P2 at line 662) documents this as "N+1 Member Loading (Baseline)" with a 50-channel benchmark, confirming the pattern is known but intentionally deferred.
- Impact: At the default `LIMIT 100`, every `findAll()` call issues 101 synchronous SQLite queries. While SQLite's in-process query overhead is low (~50us per prepared statement execution on warm cache), this scales linearly with page size. At current scale (Phase 6, no production users yet -- avoids PF-002) this is acceptable. However, when channels are polled for dashboard display or status checks, the cost compounds.
- Fix: Batch-load members for all channel IDs in a single query using `WHERE channel_id IN (...)` and group into a `Map<ChannelId, ChannelMember[]>`. This reduces the query count from N+1 to 2 regardless of page size:
  ```typescript
  // In findAll / findByStatus, after fetching channel rows:
  const channelIds = rows.map(r => r.id);
  const placeholders = channelIds.map(() => '?').join(',');
  const allMembers = this.db.prepare(
    `SELECT * FROM channel_members WHERE channel_id IN (${placeholders}) ORDER BY joined_at ASC`
  ).all(...channelIds) as ChannelMemberRow[];
  const membersByChannel = new Map<string, ChannelMemberRow[]>();
  for (const mr of allMembers) {
    const list = membersByChannel.get(mr.channel_id) ?? [];
    list.push(mr);
    membersByChannel.set(mr.channel_id, list);
  }
  // Then pass the pre-loaded members to rowToChannel instead of querying per row
  ```
  Note: The PR test comment ("N+1 Member Loading (Baseline)") and CLAUDE.md ("N+1 member loading baseline (acceptable for Phase 6)") indicate this is a conscious deferral. Flagging as HIGH rather than CRITICAL because the scope is bounded by LIMIT and SQLite's in-process nature mitigates latency. This should be addressed before dashboard polling or any hot-path usage of findAll.

### MEDIUM

**Zod parse per row on every member** - `src/implementations/channel-repository.ts:307,327`
**Confidence**: 82%
- Problem: `rowToChannel` calls `ChannelRowSchema.parse(row)` for every channel row, and `rowToMember` calls `ChannelMemberRowSchema.parse(row)` for every member row. For 100 channels with 3 members each, this is 100 + 300 = 400 Zod parse calls per findAll page. Zod's parse overhead is ~10-50us per call depending on schema complexity.
- Impact: Combined with the N+1 query pattern, a findAll(100) with 3 members each incurs 101 queries + 400 Zod parses. The Zod overhead is smaller than the N+1 query overhead, but it compounds. The existing pattern (validate at boundary) is architecturally correct -- this is an observation for awareness, not a design criticism.
- Fix: This is consistent with the project's "parse at boundaries" convention (seen in loop-repository, pipeline-repository, and all other repos). No action required unless profiling reveals Zod as a bottleneck. If it does, consider `safeParse` with a fast-path skip when in production mode, or Zod's `.passthrough()` for trusted internal data.

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

### MEDIUM

**SELECT * in all queries** - `src/implementations/channel-repository.ts:113-124`
**Confidence**: 80%
- Problem: All channel and member queries use `SELECT *`, which fetches all columns including potentially large `system_prompt` TEXT fields when only metadata is needed (e.g., count operations already use `COUNT(*)`, but list/find queries fetch full rows).
- Impact: For the channel table with ~10 columns and typically small data, this is negligible. The `system_prompt` field on `channel_members` could grow, but at current scale this is a non-issue. This is the established pattern across all repositories in the codebase (loop-repository: 7 uses, schedule-repository: 7 uses, pipeline-repository: 7 uses).
- Fix: No action needed -- this matches the project convention. If a lightweight "list channels without members/prompts" query is needed later, add a dedicated slim query.

## Suggestions (Lower Confidence)

- **Async wrapping of synchronous SQLite calls** - `src/implementations/channel-repository.ts:146-159` (Confidence: 65%) -- All repository methods wrap synchronous `better-sqlite3` operations in `async`/`tryCatchAsync`. The async boundary adds microtask overhead without actual async benefit since SQLite operations are synchronous. This is the established project convention (all repositories follow this pattern) and provides a uniform Result-based interface, so this is not actionable.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Performance Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The N+1 member loading is the only significant performance concern. The PR explicitly documents this as a known baseline deferral ("acceptable for Phase 6"). The architecture supports a straightforward batch-loading fix when needed. The remaining issues (Zod parse overhead, SELECT *) are consistent with established project patterns and do not warrant blocking.

Conditions:
- Track the N+1 batch-loading optimization as a follow-up item before any dashboard polling or hot-path integration uses `findAll`/`findByStatus` with large page sizes.

Decisions applied:
- applies ADR-001: CHANNEL_NAME_REGEX max-64-char constraint is performance-relevant -- it bounds the tmux session name length, avoiding truncation overhead in tmux operations.
- avoids PF-002: N+1 is flagged but not blocking because the feature has zero production users; a clean optimization can land when the hot path materializes.
