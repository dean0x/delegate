# Code Review Summary

**Branch**: feat-184-dashboard-channels -> main  
**Date**: 2026-05-27_1736  
**PR**: #196  
**Reviewers**: 13 (accessibility, architecture, complexity, consistency, database, performance, react, regression, reliability, security, testing, typescript, ui-design)

---

## Merge Recommendation: CHANGES_REQUESTED

### Executive Summary

The PR introduces channels as a 6th entity type to the dashboard with strong pattern consistency and comprehensive test coverage (~1,400 new test lines across 14 test files). The implementation extends the established 5-entity architecture cleanly — new `PanelId` union member, filter cycles, keyboard handlers, mutation dispatch, detail view, and activity feed integration all follow established conventions precisely.

However, **3 blocking HIGH/CRITICAL issues** prevent merge without fixes:

1. **Performance (HIGH)**: N+1 query pattern in `channel findAll` wired into 1-second dashboard poll loop — 51 queries per second per 50 channels
2. **Performance (HIGH)**: Missing covering index on `channel_messages` for `getMessages` ordering path
3. **Testing (HIGH)**: Zero test coverage for channel entity mutations (cancel/destroy, pause/resume, delete)

An additional **4 blocking MEDIUM issues** require fixes before merge:

- Consistency: 4 stale/missing inline comments and missing `TERMINAL_STATUSES` pattern extension
- TypeScript: Missing `never` exhaustive guard in `memberStatusColor`, unvalidated `lines` parameter in `capturePaneContent`
- Reliability: Unbounded `lines` parameter, unbounded `channel_messages` growth
- UI Design: Unused `scrollOffset` prop and unbounded message list rendering
- Security: Missing `lines` parameter validation (shell command injection vector)

### Convergence Status

**3 HIGH findings converge across multiple reviewers** (exact same root cause identified independently):

| Finding | Reviewers | Root Cause | Fix |
|---------|-----------|-----------|-----|
| N+1 queries on `findAll` | Performance, Architecture, Database | `rowToChannel` executes separate member query per row | Batch IN-clause fetch after channel rows |
| Activity feed channels incomplete | Architecture, Regression, Performance, UI Design, React | Missing `findUpdatedSince` on ChannelRepository | Client-side filter or implement method |
| Missing `lines` validation | Security, TypeScript, Reliability | Shell interpolation without bounds check | Add `Number.isInteger()` and bounds guard |

This convergence **elevates confidence** on these three issues (85%+ consensus across independent reviewers).

---

## Issue Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW | Total |
|----------|----------|------|--------|-----|-------|
| Blocking | 0 | 3 | 4 | 0 | **7** |
| Should Fix | 0 | 0 | 4 | 0 | **4** |
| Pre-existing | 0 | 0 | 3 | 0 | **3** |

**Total actionable issues**: 14 (7 blocking, 4 should-fix, 3 pre-existing)

---

## Blocking Issues (MUST FIX)

### HIGH Severity

#### 1. N+1 Query Performance on `channel findAll` (Hot Path)
- **Reviewers**: Performance, Architecture, Database
- **Location**: `src/implementations/channel-repository.ts:420-429`
- **Confidence**: 90%
- **Impact**: `findAll(50)` = 51 queries. Dashboard polls every 1s → 51 SQLite queries/sec on main polling path
- **Consequence**: Query overhead compounds (51 channel + 12 other entities + overhead) may cause poll overlap, degrading dashboard responsiveness
- **Fix**: Batch-load members with single `IN` clause after fetching channel rows, then join in-memory
  ```typescript
  const rows = this.db.prepare(...).all(...);
  const channelIds = rows.map(r => r.id);
  if (channelIds.length > 0) {
    const allMembers = this.db.prepare(
      `SELECT * FROM channel_members WHERE channel_id IN (${channelIds.map(() => '?').join(',')})`
    ).all(...channelIds);
    const membersByChannel = new Map();
    for (const m of allMembers) {
      const list = membersByChannel.get(m.channel_id) ?? [];
      list.push(m);
      membersByChannel.set(m.channel_id, list);
    }
    return rows.map(r => this.rowToChannelWithMembers(r, membersByChannel.get(r.id) ?? []));
  }
  ```

#### 2. Missing Covering Index on `channel_messages` Query
- **Reviewer**: Performance
- **Location**: `src/implementations/channel-repository.ts:170-172`
- **Confidence**: 85%
- **Query**: `SELECT ... FROM channel_messages WHERE channel_id = ? ORDER BY created_at DESC LIMIT 50`
- **Index**: Only `idx_channel_messages_channel_id` exists; `ORDER BY created_at DESC` triggers filesort
- **Impact**: Full scan-and-sort for every detail view poll (2-second interval)
- **Fix**: Add composite index
  ```sql
  CREATE INDEX IF NOT EXISTS idx_channel_messages_channel_created
    ON channel_messages(channel_id, created_at DESC);
  ```

#### 3. Missing Tests for Channel Entity Mutations
- **Reviewer**: Testing
- **Location**: `src/cli/dashboard/keyboard/entity-mutations.ts:84-211`
- **Confidence**: 90%
- **Coverage Gap**: `cancelEntity('channel', ...)`, `pauseOrResumeEntity('channel', ...)`, `deleteEntity('channel', ...)`
- **Risk**: Three new mutation paths with status guards and optional service checks have zero test coverage
- **Fix**: Add test cases to `entity-mutations.test.ts`:
  - `cancelEntity('channel')` calls `channelService.destroyChannel` when not terminal
  - `cancelEntity('channel')` is no-op when terminal or service undefined
  - `pauseOrResumeEntity('channel')` cycles active↔paused
  - `deleteEntity('channel')` deletes only when terminal, repo present

### MEDIUM Severity

#### 4. Missing `never` Exhaustive Guard in `memberStatusColor`
- **Reviewer**: TypeScript
- **Location**: `src/cli/dashboard/views/channel-detail.tsx:37-46`
- **Confidence**: 90%
- **Issue**: Switch covers 3 statuses but no `default: never` check for future enum expansion
- **Fix**: Add `default: { const _: never = status; return 'gray'; }`

#### 5. Unvalidated `lines` Parameter in `capturePaneContent`
- **Reviewers**: Security, TypeScript, Reliability
- **Location**: `src/implementations/tmux/tmux-session-manager.ts:439-443`
- **Confidence**: 85%
- **Risk**: Interpolated directly into shell command without bounds checking
- **Fix**: Validate before interpolation
  ```typescript
  if (!Number.isInteger(lines) || lines <= 0 || lines > 10_000) {
    return err(tmuxSessionFailed(...));
  }
  ```

#### 6. Missing `TERMINAL_STATUSES` Pattern for Channels
- **Reviewer**: Consistency
- **Locations**: `src/cli/dashboard/keyboard/entity-mutations.ts:84-94, 202-211`
- **Confidence**: 85%
- **Issue**: Channel cancel/delete inline status checks instead of using centralized constant
- **Fix**: Add to `constants.ts`:
  ```typescript
  channels: [ChannelStatus.DESTROYED, ChannelStatus.COMPLETED],
  ```
  Then replace inline checks with `TERMINAL_STATUSES.channels.includes(status)`

#### 7. Unused `scrollOffset` Prop Defeats Scrollability
- **Reviewer**: UI Design
- **Location**: `src/cli/dashboard/views/channel-detail.tsx:78, 143-149`
- **Confidence**: 85%
- **Issue**: `scrollOffset` accepted but aliased to `_scrollOffset`. Message list unbounded, will overflow terminal
- **Fix**: Either implement scroll using `ScrollableList` pattern from `loop-detail.tsx`, or slice messages by offset. If deferred, document with `/** @todo Phase 10: implement scrolling **/`

---

## Should-Fix Issues (HIGH Priority)

These are non-blocking but should be addressed before merge for quality/consistency:

#### 8. Stale Inline Comments (4 instances)
- **Reviewer**: Consistency
- **Locations**: `handle-main-keys.ts:45` ("1-5" → "1-6"), `handle-main-keys.ts:176` (pause/resume now includes channels)
- **Confidence**: 95%/92%
- **Fix**: Update comments to reflect 6 entity types, extended pause/resume support

#### 9. Duplicated Member-Lookup Logic
- **Reviewer**: React
- **Location**: `app.tsx:156-165` vs `channel-detail.tsx:80-86`
- **Confidence**: 85%
- **Issue**: "resolve selected channel member with fallback" duplicated in 2 locations
- **Fix**: Extract to shared `resolveSelectedMember(members, selectedName)` utility

#### 10. Double State-Update in `useChannelPanePreview` Hook
- **Reviewer**: React
- **Location**: `use-channel-pane-preview.ts:68-96`
- **Confidence**: 82%
- **Issue**: Two effects on `sessionName` change both reset state, then poll fires immediately
- **Fix**: Consolidate session-reset logic into the polling effect's setup, eliminate first effect

#### 11. Unbounded `channel_messages` Growth
- **Reviewer**: Reliability
- **Location**: `src/implementations/database.ts:1267`
- **Confidence**: 85%
- **Issue**: No TTL or pruning; messages accumulate indefinitely per channel
- **Fix**: Add `MAX_MESSAGES_PER_CHANNEL` constant and prune on each save, or document as accepted trade-off

---

## Pre-Existing Issues (INFORMATIONAL)

These were already in the codebase and are not blockers. Listed for transparency:

| Issue | Location | Status |
|-------|----------|--------|
| N+1 pattern on rowToChannel documented but unbounded | `channel-repository.ts:420` | Known, commented, but impacts dashboard hot path now (addressed in Blocking #1) |
| `handler-setup.ts` approaching 600 lines, linear growth pattern | `handler-setup.ts:597` | Pre-existing, acknowledged in complexity review (ADR-003) |
| `use-dashboard-data.ts` at 557 lines with 6-way if-chain | `use-dashboard-data.ts` | Pre-existing, manageable but approaching refactoring threshold |
| `buildActivityFeed` has 6 near-identical for-loops | `activity-feed.ts:120-179` | Pre-existing pattern, acceptable |

---

## Positive Findings

**What works well:**
- ✅ **Pattern consistency across 6 entities**: `PanelId` union, filter cycles, keyboard handlers, mutations, detail view routing all follow exact same structure (applies ADR-001)
- ✅ **Comprehensive test coverage**: 8 new test files, ~1,400 test lines across repository, handlers, dashboard data, detail view, activity feed
- ✅ **Clean event-driven integration**: `ChannelMessagePersistenceHandler` mirrors `UsageCaptureHandler` pattern, best-effort degradation
- ✅ **Database migration safety**: Migration v32 uses `CREATE TABLE IF NOT EXISTS`, proper indexes, `ON DELETE CASCADE` for cleanup
- ✅ **Security posture strong**: Parameterized SQL everywhere, boundary validation on DB reads via Zod, session name validation before shell interpolation (except `lines` parameter)
- ✅ **Keyboard parity complete**: Tab navigation, digit key 6, arrow/j/k, Enter drill, Esc return, p pause/resume, c cancel/destroy, d delete all implemented
- ✅ **React component quality**: `ChannelDetail` is pure, memoized, uses stable keys, proper hook ordering, full cleanup functions

---

## Decisions Applied

- **ADR-001**: Channel name validation constrained to tmux SESSION_NAME_REGEX. Verified: `validateSessionName` called in `capturePaneContent`, `CHANNEL_NAME_REGEX` used consistently.
- **ADR-003**: Missing `findUpdatedSince` on ChannelRepository deferred. Pragmatic workaround (client-side filter) documented in regression review.
- **Avoids PF-004**: `ChannelCreated` rollback now deletes DB record on emit failure (all 3 layers covered).

---

## Conditions for Approval

**All 7 blocking issues MUST be fixed before merge:**

1. ✓ Implement N+1 batch loading in `channel findAll`
2. ✓ Add `idx_channel_messages_channel_created` covering index
3. ✓ Add test cases for channel entity mutations (cancel, pause/resume, delete)
4. ✓ Add `default: never` guard in `memberStatusColor`
5. ✓ Add `lines` parameter validation in `capturePaneContent`
6. ✓ Extend `TERMINAL_STATUSES` to include `channels`
7. ✓ Implement scroll for messages or document deferral

**Should-fix issues (4) can be addressed in this PR or deferred to immediate follow-up, at maintainer's discretion:**
- Update stale inline comments (low effort, high clarity value — recommend in-PR fix)
- Extract member-lookup utility (medium effort, good precedent — recommend in-PR fix)
- Consolidate `useChannelPanePreview` effects (low effort — recommend in-PR fix)
- Document or implement message pruning (medium effort, can defer with TODO comment)

---

## Quality Assessment

| Dimension | Score | Notes |
|-----------|-------|-------|
| Architecture | 8/10 | Excellent pattern consistency; one HIGH issue on query optimization |
| React/UI | 8/10 | Clean component patterns; viewport scrolling gap |
| TypeScript | 8/10 | Strong typing; missing `never` guard and parameter validation |
| Security | 8/10 | Good: parameterized SQL, boundary validation; gap: `lines` validation |
| Testing | 7/10 | Strong coverage overall; gap: entity mutation paths untested |
| Performance | 6/10 | N+1 and missing indexes dominate; degradation cascades to dashboard responsiveness |
| Reliability | 7/10 | Good defensive patterns; unbounded message growth needs policy |
| Database | 8/10 | Clean migration, proper indexes, good constraints; N+1 inherited from Phase 6 |
| Consistency | 8/10 | Excellent pattern adherence; 4 stale comments and missing constant extension |
| Complexity | 7/10 | New code is clean; existing growth pattern in handler-setup/use-dashboard-data continues |

**Overall Quality**: 7.6/10 — Solid implementation with strong pattern consistency marred by performance and testing gaps that must be addressed.

---

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Dashboard latency under load | HIGH | Fix N+1 and add index (fixes reduce per-tick queries from ~63 to ~13) |
| Channel mutations data loss if untested | HIGH | Add comprehensive entity-mutations tests before merge |
| Shell injection in tmux interaction | MEDIUM | Validate `lines` parameter (defense-in-depth) |
| Future enum expansion missed | MEDIUM | Add `never` guard and keep exhaustiveness checks |
| Unbounded memory in long-running channels | MEDIUM | Document or implement message TTL |

---

## Next Steps

1. **Address all 7 blocking issues** — estimated effort ~4-6 hours
2. **Re-run reviewer checks** on fixes (minimal, focused verification)
3. **Merge to main** once approval restored
4. **Post-merge**: Consider follow-up PR for `findUpdatedSince` on ChannelRepository (improves activity feed consistency, enables future query optimization)

---

## Files Requiring Changes

- `src/implementations/channel-repository.ts` — N+1 batch loading
- `src/implementations/database.ts` — Add covering index in migration or post-migrate
- `tests/unit/cli/dashboard/entity-mutations.test.ts` — Channel mutation test cases
- `src/cli/dashboard/views/channel-detail.tsx` — Scroll implementation or deferral comment
- `src/implementations/tmux/tmux-session-manager.ts` — Validate `lines` parameter
- `src/cli/dashboard/keyboard/constants.ts` — Extend `TERMINAL_STATUSES`
- `src/cli/dashboard/keyboard/handle-main-keys.ts` — Fix 2 stale comments
- *(optional)* Refactor duplicated logic in `app.tsx` / `channel-detail.tsx`
- *(optional)* Consolidate effects in `use-channel-pane-preview.ts`

