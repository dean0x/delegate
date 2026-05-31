# Code Review Summary

**Branch**: feat/184-dashboard-channels -> main
**Date**: 2026-05-28
**Cycle**: 3
**Reviewers**: 14 (architecture, accessibility, complexity, consistency, database, documentation, performance, react, regression, reliability, security, testing, typescript, ui-design)

## Merge Recommendation: CHANGES_REQUESTED

Multiple blocking issues found across database, accessibility, testing, and typescript domains. 8 CRITICAL/HIGH/MEDIUM blocking issues require fixes before merge. Estimated 2-4 hour resolution, then full test/validation sweep.

---

## Convergence Status

**Cycle 1-2 Context**: 26 issues resolved (21 fixed, 3 false positive, 1 deferred). 12% FP ratio.

**Cycle 3 Trend**: Convergence improving. Issues are now focused, well-scoped, and actionable:
- Blocking issues reduced to 8 (vs. 26 in prior cycles)
- Strong consensus on 3 issues flagged by 2+ reviewers (health summary, captured pane priority, statement cache bounds)
- No red-flag cascading architecture issues
- Test coverage gaps identified systematically (testing reviewer)

**Recommendation**: After fixes, expect 85%+ convergence on final verification cycle.

---

## Issue Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| **Blocking** | 0 | 1 | 7 | 0 |
| **Should Fix** | 0 | 0 | 3 | 0 |
| **Pre-existing** | 0 | 0 | 0 | 2 |
| **Total** | **0** | **1** | **10** | **2** |

---

## Blocking Issues (8 total)

Issues in your changes that must be fixed before merge. Sorted by domain and reviewer consensus.

### 1. Missing exhaustive `never` guard in `getPanelItems` and `panelToEntityKind` — TypeScript (90% confidence)
**File**: `src/cli/dashboard/keyboard/helpers.ts:22-37,72-87`
**Severity**: HIGH
**Consensus**: 1 reviewer (typescript), but mirrors same pattern fixed elsewhere in this PR

Both switches handle `'channels'` case but lack `default: { const _: never = panelId; }` exhaustive check. Creates inconsistency with nearby `getEntityDisplayFields` and `DetailView` which DO have exhaustive checks added in this PR. Silent return of `undefined` on future entity additions.

**Fix Required**:
```typescript
// In getPanelItems (line 22-37):
case 'channels':
  return toIdentifiables(data.channels ?? []);
default: {
  const _exhaustive: never = panelId;
  return _exhaustive;
}

// In panelToEntityKind (line 72-87):
case 'channels':
  return 'channel';
default: {
  const _exhaustive: never = panelId;
  return _exhaustive;
}
```

---

### 2. Health summary missing destroyed channels from `failed` count — Consistency, Regression, UI-Design (82-88% confidence)
**Files**: `src/cli/dashboard/components/header.tsx:59-65`
**Severity**: MEDIUM
**Consensus**: 3 reviewers (consistency, regression, ui-design) — deduplicated

`buildHealthSummary()` includes terminal-abnormal statuses from all entity types (tasks: failed, loops: failed, schedules: cancelled, orchestrations: failed, pipelines: failed+cancelled) but omits `channelCounts.byStatus['destroyed']`. Channels are the 6th entity type, yet their failure state is invisible in the health header.

**Fix Required**:
```typescript
const failed =
  (data.taskCounts.byStatus['failed'] ?? 0) +
  (data.loopCounts.byStatus['failed'] ?? 0) +
  (data.scheduleCounts.byStatus['cancelled'] ?? 0) +
  (data.orchestrationCounts.byStatus['failed'] ?? 0) +
  (data.pipelineCounts.byStatus['failed'] ?? 0) +
  (data.pipelineCounts.byStatus['cancelled'] ?? 0) +
  (data.channelCounts.byStatus['destroyed'] ?? 0);
```

---

### 3. `getMessages` limit accepts negative and NaN values — Database (85% confidence)
**File**: `src/implementations/channel-repository.ts:414`
**Severity**: MEDIUM

`Math.min(limit ?? 50, 500)` does not clamp to minimum 1. Negative limits return -1 (SQLite interprets as "all rows"). NaN limits pass NaN to SQLite bind parameter, causing undefined behavior.

**Fix Required**:
```typescript
const effectiveLimit = Math.max(
  1,
  Math.min(
    limit ?? SQLiteChannelRepository.DEFAULT_MESSAGE_LIMIT,
    SQLiteChannelRepository.MAX_MESSAGES_PER_CHANNEL,
  ),
);
```

---

### 4. Save + count + prune not wrapped in transaction — Database (80% confidence)
**File**: `src/implementations/channel-repository.ts:383-402`
**Severity**: MEDIUM

Three sequential SQLite operations (INSERT, SELECT COUNT, DELETE) execute outside a transaction. Race condition: two concurrent `ChannelMessageSent` events could both read count=501, both execute prune, causing double-prune. While channels unlikely to hit high concurrency, atomicity violation.

**Fix Required**:
```typescript
const saveAndPrune = this.db.transaction(() => {
  this.saveMessageStmt.run({ ... });
  const countRow = this.countMessagesStmt.get(msg.channelId) as { count: number };
  if (countRow.count > SQLiteChannelRepository.MAX_MESSAGES_PER_CHANNEL) {
    this.pruneMessagesStmt.run(msg.channelId, msg.channelId, SQLiteChannelRepository.MAX_MESSAGES_PER_CHANNEL);
  }
});
saveAndPrune();
```

---

### 5. Unbounded statement cache in `membersByChannelIdsStmtCache` — Reliability (85% confidence)
**File**: `src/implementations/channel-repository.ts:136`
**Severity**: MEDIUM

`Map<number, SQLite.Statement>` grows without eviction. Each distinct arity (1..100) creates a cached prepared statement. While arity bounded by DEFAULT_LIMIT=100, in long-running server processes cache can accumulate 100+ native SQLite resources that are never released. Memory leak over time.

**Fix Required**:
```typescript
// After the set():
if (this.membersByChannelIdsStmtCache.size > SQLiteChannelRepository.DEFAULT_LIMIT) {
  const firstKey = this.membersByChannelIdsStmtCache.keys().next().value;
  if (firstKey !== undefined) this.membersByChannelIdsStmtCache.delete(firstKey);
}
```

---

### 6. Missing exhaustive `never` guard in `cancelEntity` and `deleteEntity` — TypeScript (85% confidence)
**File**: `src/cli/dashboard/keyboard/entity-mutations.ts:45-91, 197-208`
**Severity**: MEDIUM

Both switches handle all current `EntityKind` cases including `'channel'` but lack default `never` exhaustive check. Future entity additions silently compile and return `undefined`. Critical mutation path — missed case swallows user's cancel request.

**Fix Required**:
```typescript
// In cancelEntity and deleteEntity:
default: {
  const _exhaustive: never = kind;
  throw new Error(`Unhandled entity kind: ${_exhaustive}`);
}
```

---

### 7. Missing error-path test for `deleteEntity` channel branch — Testing (85% confidence)
**File**: `tests/unit/cli/dashboard/entity-mutations.test.ts`
**Severity**: MEDIUM

`cancelEntity(channel)` and `pauseOrResumeEntity(schedule)` both have explicit "swallows service errors" tests. `deleteEntity(channel)` also has a catch block that swallows errors but no corresponding test. Asymmetry in test coverage.

**Fix Required**: Add test analogous to existing error-swallowing tests:
```typescript
it('swallows repo errors without crashing', async () => {
  const mutations = makeMutations({
    channelRepo: makeChannelRepo({
      delete: vi.fn().mockRejectedValue(new Error('repo unavailable')),
    }),
  });
  const refreshNow = vi.fn();
  await expect(
    deleteEntity('channel', 'chan-err', ChannelStatus.DESTROYED, mutations, refreshNow),
  ).resolves.toBeUndefined();
  expect(refreshNow).not.toHaveBeenCalled();
});
```

---

### 8. Missing error-path test for `ChannelMessagePersistenceHandler.persistMessage` — Testing (82% confidence)
**File**: `tests/unit/services/handlers/channel-message-persistence-handler.test.ts`
**Severity**: MEDIUM

Handler has explicit error-handling branch (line 100-106) when `saveResult.ok` is false, logging warning and returning `ok(undefined)`. No test exercises this path. Only untested branch in the handler.

**Fix Required**: Add test:
```typescript
it('logs warning and does not throw when saveMessage fails (FK violation)', async () => {
  const nonExistentChannelId = ChannelId('ch-nonexistent');
  await eventBus.emit('ChannelMessageSent', {
    channelId: nonExistentChannelId,
    from: 'architect',
    to: 'all',
    round: 1,
    summary: 'This should fail FK check',
  });
  await flushEventLoop();

  // No throw, no crash — handler is best-effort
  expect(logger.warnings.length).toBeGreaterThan(0);
});
```

---

## Should-Fix Issues (3 total)

Issues in code you touched that are recommended improvements (non-blocking).

### 9. Unnecessary `?? []` null coalescing on required `DashboardData.channels` — TypeScript (82% confidence)
**File**: `src/cli/dashboard/keyboard/helpers.ts:35`

`DashboardData.channels` is typed as `readonly Channel[]` (required, not optional). The `?? []` is unreachable. Matches pre-existing pattern on `data.pipelines ?? []` but both should be cleaned up.

**Fix**: Use `data.channels` directly.

---

### 10. Statement cache growth strategy needed for `findMembersByChannelIds` — Performance (82% confidence)
**File**: `src/implementations/channel-repository.ts:484-491`

Cache comment correctly notes arity bounded by DEFAULT_LIMIT=100, but cache has no upper bound guard. While practical bound exists, violates reliability principle of explicit bounds.

**Fix**: Add size guard or document implicit bound as assertion (see blocking issue #5 for exact code).

---

### 11. `fetchAllData` positional-tuple fragility with 12-element Promise.all array — Complexity (82% confidence)
**File**: `src/cli/dashboard/use-dashboard-data.ts:190`

Function has 12-element `Promise.all` array, matching 12-element string-label array, and 12-element positional tuple cast. Positional alignment is fragile — misalignment silently misassigns results. Not new pattern, but adding channels extended each array and this PR authored new entries.

**Fix**: Extract parallel-fetch-and-unwrap pattern into typed helper that pairs fetch with label, eliminating positional coupling. (Recommended as follow-up refactoring, applies ADR-003).

---

## Pre-existing Issues (2 total)

Noted for visibility but not blocking.

### 12. Loop detail iteration rows use dimColor on blue selected background — Accessibility
**File**: `src/cli/dashboard/views/loop-detail.tsx:84-91`
**Confidence**: 85%

Same low-contrast pattern exists in loop detail view (pre-existing). Channel detail follows this pattern, but pattern itself has accessibility issue on selected rows with blue background.

---

### 13. `unwrapped.value as [...]` positional cast in `fetchAllData` lacks compile-time safety — TypeScript
**File**: `src/cli/dashboard/use-dashboard-data.ts:266-279`
**Confidence**: 80%

Positional tuple cast approach is pre-existing (not introduced by this PR). Compiler does not verify that Promise.all order matches tuple cast order. Channel additions correctly extend both, but pre-existing fragility.

---

## Blocking Issues by Reviewer Domain

| Domain | Count | Issues |
|--------|-------|--------|
| TypeScript | 2 | Exhaustive never guards (helpers.ts, entity-mutations.ts) |
| Database | 2 | Limit guard, transaction wrap |
| Testing | 2 | deleteEntity error path, handler error path |
| Accessibility | 1 | Selected member row dimColor contrast |
| Consistency | 1 | Health summary destroyed channels |
| Documentation | 1 | JSDoc comment drift in mainHints |
| Performance | 1 | Prune query efficiency (defer-acceptable) |
| Regression | 1 | Health summary destroyed channels (deduplicated) |
| Reliability | 1 | Statement cache bounds |
| UI-Design | 1 | Health summary, pane preview priority (deduplicated) |

---

## Action Plan

### Phase 1: Critical Blocking Fixes (TypeScript, Database, Testing)
1. Add exhaustive `never` guards in `helpers.ts` and `entity-mutations.ts` (30 min)
2. Fix `getMessages` limit clamping to Math.max(1, ...) (15 min)
3. Wrap save+count+prune in transaction (30 min)
4. Add statement cache eviction guard (20 min)
5. Add two missing error-path tests (45 min)

**Estimated time**: 2 hours

### Phase 2: Consistency & Documentation Fixes
6. Add destroyed channels to health summary (15 min)
7. Fix `mainHints` JSDoc to include channels (10 min)
8. Fix accessibility dimColor on selected member row (20 min)

**Estimated time**: 45 minutes

### Phase 3: Validation (Full Test Suite + Review)
```bash
npm run test:core && npm run test:handlers && npm run test:services && \
  npm run test:repositories && npm run test:adapters && npm run test:implementations && \
  npm run test:cli && npm run test:dashboard && npm run test:scheduling && \
  npm run test:checkpoints && npm run test:error-scenarios && \
  npm run test:orchestration && npm run test:translation && \
  npm run test:integration && npm run test:tmux && npm run test:tmux:integration
```

**Estimated time**: 3-4 minutes (grouped test suites)

---

## Reviewer Confidence Levels

| Confidence Range | Count |
|------------------|-------|
| 85-92% (High) | 5 issues |
| 80-85% (Moderate-High) | 5 issues |
| 70-80% (Moderate) | 2 suggestions |
| 60-70% (Lower) | 2 suggestions |

High-confidence issues are well-scoped, repeatable, and directly testable.

---

## Post-Resolution Outlook

After fixes:
- **TypeScript**: 0 blocking (all exhaustive guards added)
- **Database**: 0 blocking (limit, transaction, cache bounds fixed)
- **Testing**: 0 blocking (two error paths covered)
- **Accessibility**: 1 MEDIUM addressed
- **Consistency**: 1 MEDIUM addressed
- **Documentation**: 1 MEDIUM addressed

**Estimated final result**: APPROVED (with optional should-fix refinements tracked separately).

---

## Notes

- Cycle 2 fixed 21/26 issues (80% resolution rate). Similar fix rate expected here.
- Three issues (health summary, pane preview priority, statement cache) were flagged by 2+ reviewers — highest confidence findings.
- Architecture review gave 9/10 score, security gave 9/10 score — no fundamental structural issues.
- Pattern consistency is strong; most issues are edge cases or gaps (missing checks, asymmetric coverage).
- Applies ADR-001 (channel name validation), ADR-003 (pre-existing gaps tracked separately), avoids PF-001 (surface issues rather than defer), avoids PF-004 (prune error isolation).
