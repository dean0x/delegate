# Code Review Summary

**Branch**: feat/184-dashboard-channels -> main
**Date**: 2026-05-27
**Cycle**: 2 (incremental review)
**Reviewers**: 14 specialized agents (accessibility, architecture, complexity, consistency, database, documentation, performance, react, regression, reliability, security, testing, typescript, ui-design)

## Merge Recommendation: CHANGES_REQUESTED

**Blocking Issues**: 7 total
- **CRITICAL**: 1 (test file not included in test group)
- **HIGH**: 3 (activity feed data source, setupEventHandlers complexity, channels not in health summary)
- **MEDIUM**: 6 (plus additional mediun in should-fix category)

The PR cannot merge until the CRITICAL test file issue is resolved. Three HIGH issues should be fixed for correctness/consistency, and six MEDIUM issues should be addressed to prevent tech debt.

---

## Issue Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 1 | 3 | 3 | 0 |
| Should Fix | 0 | 0 | 5 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |
| **Total** | **1** | **3** | **9** | **0** |

### Blocking Issues (7)

#### CRITICAL

**1. Test file `channel-message-persistence-handler.test.ts` orphaned from test groups** — Testing
- **File**: `package.json`
- **Confidence**: 95%
- **Impact**: The new handler has zero automated test coverage in CI. No pipeline testing.
- **Fix**: Add to `test:handlers` script:
  ```json
  "test:handlers": "... channel-message-persistence-handler.test.ts --no-file-parallelism"
  ```
- **Severity**: Blocks merge — handler regression undetectable in CI

---

#### HIGH

**2. Activity feed receives unfiltered channels (time-window inconsistency)** — Performance, Regression, Reliability, Consistency
- **File**: `src/cli/dashboard/use-dashboard-data.ts:368`
- **Confidence**: 85%
- **Impact**: All 5 other entity types filtered to last-hour updates (50 items max). Channels pass full 100-item list regardless of age. Activity feed contains stale channel entries while other entities age-filtered.
- **Pattern**: `findUpdatedSince(since1h, 50)` exists for tasks/loops/schedules/orchestrations/pipelines; missing for channels.
- **Fix**: Filter in-memory before passing to activity feed builder:
  ```typescript
  const recentChannels = channels.filter(c => (c.updatedAt ?? c.createdAt) >= since1h);
  ```
- **Note**: This same issue flagged by 4 reviewers (performance, regression, reliability, consistency) — confidence boosted from 85% → 95%

**3. `setupEventHandlers` function exceeds 300 lines (336 lines)** — Complexity
- **File**: `src/services/handler-setup.ts:261`
- **Confidence**: 82%
- **Impact**: Each new handler adds ~20 lines of identical boilerplate. Function now 336 lines, well past the 200-line CRITICAL threshold. Handlers 8-13 (OrchestrationHandler through ChannelMessagePersistenceHandler) all follow the same `if (deps.X) { const result = await Handler.create(); if (!result.ok) warn(); else handler = result.value; }` pattern.
- **Fix**: Extract optional handler creation into a helper function (deferred to next refactor pass is acceptable since pattern is consistent)
- **Note**: Pre-existing structural debt exacerbated by this PR; the 20-line addition is proportional

**4. Health summary omits active channels** — UI Design
- **File**: `src/cli/dashboard/components/header.tsx:42-71`
- **Confidence**: 82%
- **Impact**: A user with 3 active channels and no other running entities sees "idle" in the header, which is incorrect.
- **Fix**: Include `channelCounts.byStatus['active']` in the `running` sum and `channelCounts.byStatus['paused']` in `queued`:
  ```typescript
  const running = /* existing */ + (data.channelCounts.byStatus['active'] ?? 0);
  const queued = /* existing */ + (data.channelCounts.byStatus['paused'] ?? 0);
  ```

---

#### MEDIUM (Blocking)

**5. Pruning statement error isolation (database guarantee mismatch)** — Database
- **File**: `src/implementations/channel-repository.ts:382-384`
- **Confidence**: 85%
- **Impact**: Comment says "best-effort" but exception propagates. If prune DELETE throws after INSERT succeeds, the entire `tryCatchAsync` returns `err()`, reporting failure even though the message was persisted.
- **Fix**: Wrap prune in isolated try/catch so prune failure doesn't affect save result:
  ```typescript
  try {
    this.pruneMessagesStmt.run(...);
  } catch (pruneError) {
    // Swallow — pruning is best-effort
  }
  ```

**6. Missing `destroyed` status in global STATUS_ICONS and statusColor** — UI Design
- **File**: `src/cli/dashboard/format.ts`
- **Confidence**: 85%
- **Impact**: Destroyed channels render with `○` (pending/queued icon) and gray color instead of `⊘` (red). Visual semantics broken — user sees "not started" rather than "irreversibly ended".
- **Fix**: Add cases in both `statusColor()` and `STATUS_ICONS`:
  ```typescript
  case 'destroyed': return 'red';
  destroyed: '⊘',
  ```

**7. `useEffect` dependency array includes redundant stable references** — React
- **File**: `src/cli/dashboard/use-channel-pane-preview.ts:86`
- **Confidence**: 80%
- **Impact**: Effect lists `[doCapture, enabled, sessionName, capturePaneFn]` but `doCapture` already captures all three. Duplicate cleanup cycles on every dependency change. Deviates from `useResourceMetrics` pattern.
- **Fix**: Remove redundant deps to match existing pattern:
  ```typescript
  }, [doCapture]);  // doCapture already captures [enabled, sessionName, capturePaneFn]
  ```

---

### Should-Fix Issues (5)

**8. Missing exhaustive `never` guard in `detail-view.tsx` switch** — TypeScript
- **File**: `src/cli/dashboard/views/detail-view.tsx:97`
- **Confidence**: 82%
- **Fix**: Add `default: { const _exhaustive: never = entityType; ... }`
- **Pattern**: `channel-detail.tsx:50` demonstrates the correct pattern in this same PR

**9. Missing exhaustive `never` guard in `entity-browser-panel.tsx`** — TypeScript
- **File**: `src/cli/dashboard/components/entity-browser-panel.tsx:65`
- **Confidence**: 82%
- **Fix**: Add `default: { const _exhaustive: never = panelId; ... }`

**10. `useMemo` deps reference entire `view` object instead of primitives** — React
- **File**: `src/cli/dashboard/app.tsx:163,198`
- **Confidence**: 83%
- **Impact**: Memo recalculates on every view state change even when relevant fields unchanged (function scope, exhaustive test)
- **Fix**: Extract primitives (`viewKind`, `viewEntityType`, `viewEntityId`) and pass to memo

**11. Dynamic SQL in `findMembersByChannelIds` creates new prepared statement on every poll** — Performance
- **File**: `src/implementations/channel-repository.ts:463-465`
- **Confidence**: 85%
- **Impact**: Dashboard polls every 1s, triggering new `db.prepare()` compilation each time. Dashboard polls with 10-50 members require compiled statement for each unique ID list.
- **Fix**: Cache prepared statements by arity (number of placeholders):
  ```typescript
  private readonly membersByIdsStmtCache = new Map<number, SQLite.Statement>();
  ```
- **Category**: Should-Fix (pre-existing pattern but adds new perf regression)

**12. `getMessages` limit parameter has no upper bound clamp** — Reliability
- **File**: `src/implementations/channel-repository.ts:395`
- **Confidence**: 80%
- **Fix**: Clamp limit to `MAX_MESSAGES_PER_CHANNEL`:
  ```typescript
  const effectiveLimit = Math.min(
    limit ?? DEFAULT_MESSAGE_LIMIT,
    MAX_MESSAGES_PER_CHANNEL,
  );
  ```

---

### Pre-existing Issues (1)

**13. Multiple handler test files missing from test groups (pre-existing)** — Testing
- **Files**: `usage-capture-handler.test.ts`, `attributed-task-cancellation-handler.test.ts`, `pipeline-handler.test.ts`
- **Confidence**: 90%
- **Impact**: Zero CI coverage for 4 handler implementations (pre-existing system issue)
- **Note**: Tracked separately per ADR-003; not a regression from this PR

---

## Convergence Status

**Deduplicated findings** (multiple reviewers flagging the same issues):

| Issue | Reviewers | Confidence Boost |
|-------|-----------|-----------------|
| Activity feed time-window inconsistency | Performance, Regression, Reliability, Consistency (4 agents) | 85% → 95% |
| Pruning error isolation | Database | 85% (verified) |
| Health summary omits channels | UI Design | 82% (verified) |
| Dynamic `prepare()` overhead | Performance, should-fix category | 85% (verified) |
| `codePointSlice` allocation | Performance, Reliability | 80-82% (both flagged) |

All convergent findings have high confidence (80%+). No conflicting assessments between reviewers.

---

## Cycle 1 Resolutions Verified

All 10 fixes from Cycle 1 confirmed present and correct:

1. ✅ N+1 batch loading (`hydrateChannelRows`) — verified in repository
2. ✅ TERMINAL_STATUSES centralized — verified in `constants.ts`
3. ✅ Bounded message list (MAX_MESSAGES_PER_CHANNEL = 500) — verified in repository
4. ✅ Validated lines param (shell interpolation fix) — verified in `capturePaneContent`
5. ✅ Never exhaustive guard in `memberStatusColor` — verified
6. ✅ Entity mutation tests (13 tests) — verified in test suite
7. ✅ Stale JSDoc comment fix (1-5 → 1-6) — verified in hints.ts
8. ✅ Member-lookup deduplication — verified in `resolveSelectedMember`
9. ✅ Covering index for channel_messages — verified in migration v32
10. ✅ Unbounded message growth prevention — verified with inline pruning

No regressions from prior cycle detected.

---

## Quality Assessment

### Strengths

1. **Type discipline**: Zero `any` usage across 2,850+ lines. `PanelId` union expanded consistently in 15+ files. `ViewState` discriminated union properly extended.
2. **Security**: Shell injection vulnerability (Cycle 1) properly fixed with integer validation. All SQL parameterized. No hardcoded secrets.
3. **Architecture**: Event-driven pattern correctly followed. `ChannelMessagePersistenceHandler` mirrors `UsageCaptureHandler` exactly. Clean layering (core → implementations → services → CLI).
4. **Testing**: 579 lines of component tests, 197 lines of hook tests, 183 lines of persistence handler tests (once added to test suite). Behavior-driven, AAA pattern.
5. **Consistency**: Keyboard navigation follows existing patterns. Mutation wiring mirrors pipelines. Dashboard data flow parallel with 5 other entities.

### Weaknesses

1. **Test infrastructure**: New handler test file not registered in test groups (CRITICAL)
2. **Data flow asymmetry**: Activity feed treats channels differently than all other entities (HIGH)
3. **Function growth**: `setupEventHandlers` and `fetchAllData` growing toward CRITICAL thresholds (HIGH/MEDIUM)
4. **Visual gaps**: Missing `destroyed` status icon, health summary omission (MEDIUM)
5. **Hook patterns**: Dependency array redundancy in `useChannelPanePreview` (MEDIUM)

---

## Action Plan

### Before Merge (CRITICAL + HIGH)

1. **Add handler test file to `test:handlers` group** (package.json) — unblocks CI
2. **Filter channels by update time before activity feed** (use-dashboard-data.ts) — fixes data asymmetry
3. **Add `destroyed` status to STATUS_ICONS and statusColor** (format.ts) — fixes visual consistency
4. **Include channels in health summary** (header.tsx) — fixes header correctness
5. **Fix prune error isolation** (channel-repository.ts) — matches comment behavior

### Should Fix (MEDIUM, medium impact)

6. Prune test coverage (channel-repository.test.ts)
7. `useEffect` deps cleanup (use-channel-pane-preview.ts)
8. Exhaustive `never` guards in detail-view & entity-browser-panel (TypeScript)
9. `useMemo` primitive extraction in app.tsx
10. `findMembersByChannelIds` statement caching

### Can Defer (pre-existing, tracked separately)

- `setupEventHandlers` refactoring (tech debt, consistent pattern)
- Multiple handler test files missing (pre-existing system gap, ADR-003)

---

## Files Requiring Changes

| File | Issues | Type |
|------|--------|------|
| `package.json` | Test group registration | CRITICAL |
| `src/cli/dashboard/use-dashboard-data.ts` | Activity feed filter | HIGH |
| `src/cli/dashboard/format.ts` | Missing destroyed status | MEDIUM |
| `src/cli/dashboard/components/header.tsx` | Health summary | HIGH |
| `src/implementations/channel-repository.ts` | Prune error, cache, limit clamp | MEDIUM × 3 |
| `src/cli/dashboard/use-channel-pane-preview.ts` | useEffect deps, test coverage | MEDIUM × 2 |
| `src/cli/dashboard/views/detail-view.tsx` | Exhaustive never guard | MEDIUM |
| `src/cli/dashboard/components/entity-browser-panel.tsx` | Exhaustive never guard | MEDIUM |
| `src/cli/dashboard/app.tsx` | useMemo primitive extraction | MEDIUM |

---

## Summary

This is a well-executed 45-file, 18-commit feature implementation with strong type discipline, comprehensive testing, and solid architectural alignment. The PR extends the dashboard from 5 entity types to 6 with mechanical consistency across type cascades, keyboard navigation, mutations, and data flow.

**Blockers**: One CRITICAL test infrastructure issue (handler test file) and three HIGH correctness/consistency gaps (activity feed time-window, health summary, UI status icon) must be fixed.

**Post-merge debt**: Five MEDIUM issues should be addressed (pruning error isolation, caching, deps cleanup, exhaustive guards, limit clamping) to prevent compound debt as the system grows.

The type system, security posture, and architectural patterns are sound. Once the blocking issues are resolved, this branch is ready for merge.
