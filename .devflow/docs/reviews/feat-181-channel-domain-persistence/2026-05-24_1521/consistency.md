# Consistency Review Report

**Branch**: feat/181-channel-domain-persistence -> main
**Date**: 2026-05-24

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Inconsistent status enum usage in test assertions (4 occurrences)** -- Confidence: 92%
- `tests/unit/implementations/channel-repository.test.ts:82`, `tests/unit/implementations/channel-repository.test.ts:95`, `tests/unit/implementations/channel-repository.test.ts:301`, `tests/unit/implementations/channel-repository.test.ts:353`
- Problem: The PR converts most status assertions to use `ChannelStatus.ACTIVE` and `ChannelMemberStatus.IDLE` enums but leaves 4 assertions using bare string literals (`'active'`). This is internally inconsistent within the same file -- the PR itself uses both styles.
- Fix: Replace all remaining string literal status assertions with enum references:
  ```typescript
  // line 82
  expect(found.status).toBe(ChannelStatus.ACTIVE);
  // line 95
  expect(m1.status).toBe(ChannelMemberStatus.ACTIVE);
  // line 301
  expect(added!.status).toBe(ChannelMemberStatus.ACTIVE);
  // line 353
  expect(member.status).toBe(ChannelMemberStatus.ACTIVE);
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Status enum-to-domain cast pattern diverges from loop-repository/schedule-repository convention** -- Confidence: 82%
- `src/implementations/channel-repository.ts:317`, `src/implementations/channel-repository.ts:333`
- Problem: The channel repository uses bare `as ChannelStatus` and `as ChannelMemberStatus` casts to convert Zod-validated strings to enum values. The loop-repository and schedule-repository both use explicit conversion functions (`toLoopStatus()`, `toScheduleStatus()`) with exhaustive switches that throw on unknown values ("possible data corruption"). The task-repository uses `as TaskStatus` (same pattern as channel-repo). Two patterns exist in the codebase, but the newer repositories (loop, schedule) adopted the safer explicit conversion pattern.
- Fix: While the Zod schema already validates the string values making the cast safe, adopting the explicit conversion function pattern would be more consistent with the more recent repositories. This is low risk either way since Zod guards the boundary. Noting as informational rather than blocking -- the `as` cast pattern is also established (task-repository).

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **`CommunicationMode` is a string union while `ChannelStatus`/`ChannelMemberStatus` are enums** - `src/core/domain.ts:1077` (Confidence: 65%) -- This follows the existing codebase convention where lifecycle status types are enums and value/mode types are string unions (`IterationStatus`, `OrchestratorMode`). No action needed, but worth noting for future contributors that this is intentional.

- **`updateRound` precondition validation inside repository is unique across all repositories** - `src/implementations/channel-repository.ts:216-218` (Confidence: 72%) -- The `updateRound` method throws if `round` is not a non-negative integer. No other repository method in the codebase validates input parameters this way -- they rely on the service/handler layer for validation. The JSDoc on `createChannel` explicitly states "Assumes valid input -- callers must validate... before calling." This precondition inside the repo layer is a mild deviation from the convention that repositories are pure data access layers. However, the throw is wrapped by `tryCatchAsync` and converts to a Result error, so it is safe.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Consistency Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The PR demonstrates strong consistency with established codebase patterns overall:
- `ChannelStatus`/`ChannelMemberStatus` correctly follow the enum convention used by `TaskStatus`, `LoopStatus`, `ScheduleStatus` (applies ADR-001 -- channel names constrained to tmux session name compatibility)
- `createChannel` factory correctly follows the no-internal-validation convention matching `createTask`/`createSchedule`/`createLoop`
- Zod boundary validation schemas follow the established pattern (module-level, `z.enum` for status strings)
- Repository class structure matches loop-repository/schedule-repository patterns (prepared statements, `tryCatchAsync`, `operationErrorHandler`)
- `readonly` addition to `ChannelCreatedEvent.members` improves immutability consistency
- Removal of duplicate `addMemberStmt` (reusing `saveMemberStmt`) is a clean deduplication
- `effectiveLimit`/`effectiveOffset` extraction in `findAll`/`findByStatus` improves readability

The one blocking item is the inconsistent mix of enum references and string literals within the same test file -- a straightforward cleanup.
