# Complexity Review Report

**Branch**: feat/184-dashboard-channels -> main
**Date**: 2026-05-28
**PR**: #196
**Prior Resolutions**: Cycle 2 added exhaustive never guards and simplified redundant variables; complexity was acceptable.

## Issues in Your Changes (BLOCKING)

### HIGH

**`fetchAllData` function at 135 lines with growing positional-tuple destructuring** - `src/cli/dashboard/use-dashboard-data.ts:190`
**Confidence**: 82%
- Problem: `fetchAllData` is now 135 lines with a 12-element `Promise.all` array, a matching 12-element string-label array, 6 local type aliases, and a 12-element positional tuple cast. Adding channels extended each of these parallel arrays by +2 entries. The positional alignment between the `Promise.all` array, the label array, and the destructured tuple is fragile -- a single misalignment silently misassigns results. This is a pre-existing structural pattern, but the channel additions pushed it further into warning territory and this PR authored the new entries.
- Impact: Any future entity addition requires touching 5 tightly coupled parallel arrays in the same function. Misalignment errors are silent at runtime (wrong data assigned to wrong variable) and only manifest as incorrect dashboard data.
- Fix: Extract the parallel-fetch-and-unwrap pattern into a typed helper that pairs each fetch with its label, eliminating positional coupling. This is a refactoring beyond the scope of this PR but worth tracking:
  ```typescript
  // Sketch — not prescriptive
  const fetches = [
    { label: 'Tasks', fetch: taskRepository.findAll(FETCH_LIMIT) },
    { label: 'Channels', fetch: channelRepository.findAll(FETCH_LIMIT) },
    // ...
  ] as const;
  ```

## Issues in Code You Touched (Should Fix)

_No issues found at >= 80% confidence._

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`setupEventHandlers` function at 337 lines — linear handler-registration chain** - `src/services/handler-setup.ts:261`
**Confidence**: 85%
- Problem: The function is 337 lines of sequential handler creation with identical error-handling stanzas (create -> check .ok -> log warn or return err). This PR added one 19-line stanza (handler #13, `ChannelMessagePersistenceHandler`) that is structurally identical to handlers #8-#12. The function's cyclomatic complexity is moderate (each handler block is a simple if-guard), but the line count is well above the 200-line CRITICAL threshold for function length.
- Impact: Each new handler requires ~20 lines of boilerplate. The function will continue growing with every new event handler.
- Fix: Extract handler creation into a registry-driven loop or a typed builder. Each handler block follows the same pattern: `if (dep) { create() -> check .ok -> warn or assign }`. A data-driven approach would reduce this to ~5 lines per handler. Not blocking for this PR — the pattern is pre-existing and well-established.

**`fetchDetailExtra` growing if-chain for entity types** - `src/cli/dashboard/use-dashboard-data.ts:391`
**Confidence**: 80%
- Problem: `fetchDetailExtra` is a chain of 5 sequential `if (detail.entityType === '...')` blocks (58 lines total), each returning different shapes. This PR added the `channels` block (+4 lines). The function is still under 60 lines and each branch is simple, but the pattern will grow with each new entity type.
- Impact: Low — the function is still manageable and TypeScript exhaustiveness will catch missing branches.
- Fix: A lookup table mapping `entityType` to an async fetcher would cap growth, but is not worth the indirection at the current size.

## Suggestions (Lower Confidence)

- **`cancelEntity` switch statement growing to 6 cases** - `src/cli/dashboard/keyboard/entity-mutations.ts:45` (Confidence: 65%) -- The cancel/pause/delete switch statements each have 6 cases now. Each case is 5-8 lines. The functions are at 62, 46, and 52 lines respectively -- within acceptable range but approaching the warning threshold. Consider extracting a `EntityMutationDispatcher` if a 7th entity type is added.

- **`DashboardData` interface at 37+ fields** - `src/cli/dashboard/types.ts:201` (Confidence: 70%) -- The interface carries 6 entity lists, 6 count records, and 12+ optional detail extras. This is data-bag complexity -- wide but flat. Each field is typed and documented. The width makes the interface harder to scan but does not introduce cyclomatic complexity. No action needed unless it exceeds ~50 fields.

- **`handleDetailKeys` dispatcher chain at 7 handlers** - `src/cli/dashboard/keyboard/handle-detail-keys.ts:400` (Confidence: 60%) -- The short-circuit chain `handleEscReturn || handleOutputControls || handlePauseResume || handleLoopNavigation || handleOrchestrationNavigation || handleChannelNavigation || handleGenericScroll` is 7 entries. Each handler is well-extracted into its own named function with clear responsibility. The chain itself is low cyclomatic complexity (short-circuit OR). This is acceptable and follows the existing pattern cleanly.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | - | 2 | 0 |

**Complexity Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Rationale

This PR adds channels as the 6th entity type across ~15 dashboard files. The complexity profile is dominated by **type cascade** — the same structural addition (one more union member, one more switch case, one more array entry) replicated consistently across all touch points. This is inherent to the entity-type-expansion pattern and is enforced by TypeScript exhaustiveness checks, which means missing a case is a compile error, not a silent bug.

Key observations:
- **New files are well-structured**: `channel-detail.tsx` (193 lines), `use-channel-pane-preview.ts` (89 lines), and `channel-message-persistence-handler.ts` (116 lines) are all well under thresholds with low cyclomatic complexity.
- **Keyboard handlers follow established patterns**: `handleChannelNavigation` mirrors `handleLoopNavigation` closely. The helpers (`resolveMemberIndex`, `resolveSelectedMember`) are extracted and reused.
- **Repository additions are clean**: `saveMessage` + pruning is bounded (MAX_MESSAGES_PER_CHANNEL = 500). The `hydrateChannelRows` batch-load replaces N+1 queries.
- **The one blocking HIGH** is the positional-tuple fragility in `fetchAllData`, which this PR extended. It is not a new pattern but the 12-element tuple is in the warning zone. A follow-up refactoring to eliminate positional coupling would be worthwhile (applies ADR-003 — track as a separate issue rather than block this PR).

The prior resolution cycle already addressed redundant variables and null guards. No new complexity regressions were introduced.
