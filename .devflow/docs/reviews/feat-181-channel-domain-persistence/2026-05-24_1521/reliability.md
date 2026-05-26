# Reliability Review Report

**Branch**: feat/181-channel-domain-persistence -> main
**Date**: 2026-05-24

## Issues in Your Changes (BLOCKING)

### HIGH

**updateRound does not enforce maxRounds upper bound** - `src/implementations/channel-repository.ts:216-218`
**Confidence**: 85%
- Problem: `updateRound` validates that `round` is a non-negative integer, but does not check whether the round exceeds the channel's `maxRounds`. The comment on `ChannelCreateRequest.maxRounds` (domain.ts:1115) states "Maximum conversation rounds before the channel transitions to COMPLETED" and documents a range of 1-10000. However, nothing in `updateRound` prevents callers from setting `currentRound` to a value far exceeding `maxRounds` (or to any arbitrarily large integer). This is a missing precondition on a critical path — the repository has the data to enforce it (it could query `maxRounds` from the same row), but currently trusts callers entirely.
- Fix: This enforcement is better placed at the service/handler layer (not the repository), consistent with the project's "validate at boundaries" pattern. The service layer that calls `updateRound` should fetch the channel, compare `round < channel.maxRounds`, and return a Result error if exceeded. Add a JSDoc comment to `updateRound` documenting this contract: "Caller must ensure round does not exceed channel.maxRounds."

### MEDIUM

**No upper bound on members array in save transaction** - `src/implementations/channel-repository.ts:149-154`
**Confidence**: 82%
- Problem: The `save` method iterates over `channel.members` in a transaction with no upper bound check. While the array is finite (bounded by caller input), there is no assertion or limit. A channel with thousands of members would execute thousands of INSERT statements inside a single SQLite transaction, which could cause lock contention and memory pressure. The `maxRounds` field documents an explicit bound (1-10000) but members have no equivalent. Applies ADR-001 (channel names constrained to tmux compatibility) — each member creates a tmux session, so unbounded members means unbounded tmux sessions.
- Fix: Add a documented constant (e.g., `MAX_CHANNEL_MEMBERS = 50`) and assert `channel.members.length <= MAX_CHANNEL_MEMBERS` as a precondition in `createChannel` or at the service boundary. This mirrors the `maxRounds` range constraint documented in ChannelCreateRequest.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**updateRound precondition throws inside tryCatchAsync but error message lacks context** - `src/implementations/channel-repository.ts:217`
**Confidence**: 80%
- Problem: The precondition `throw new Error(...)` inside `tryCatchAsync` is correctly caught and converted to a Result error, which is good. However, the error message says "updateRound: round must be a non-negative integer" but does not mention what the actual type was (e.g., NaN, -1, 3.5). For reliability debugging, knowing whether the caller passed NaN vs. -1 vs. 3.14 matters. The `${round}` at the end will show the value, but NaN/Infinity would benefit from explicit type information.
- Fix: Enhance the error message: `throw new Error(\`updateRound: round must be a non-negative integer, got ${round} (type: ${typeof round})\`)`. This adds negligible cost and significantly aids debugging.

**Silent no-op on update operations for nonexistent entities** - `src/implementations/channel-repository.ts:204-222`
**Confidence**: 80%
- Problem: `updateStatus`, `updateRound`, and `updateMemberStatus` all succeed silently (return `Result<void>` ok) when the target entity does not exist. The tests (T15b) explicitly document this as "silent no-op" behavior. While this is a valid design choice, from a reliability perspective it means callers cannot distinguish "update applied" from "target not found." A caller that mistypes a channel ID or passes a stale reference gets silent success, masking bugs. This is a bounded-but-latent reliability concern.
- Fix: Consider checking `this.updateStatusStmt.run(...).changes === 0` and returning an error Result when no rows were affected. Alternatively, document this no-op contract on the ChannelRepository interface with a JSDoc comment so service-layer callers know to verify existence first.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**N+1 member loading in rowToChannel** - `src/implementations/channel-repository.ts:306-309`
**Confidence**: 90%
- Problem: Every call to `rowToChannel` issues a separate `findMembersByChannelIdStmt.all()` query per channel. When `findAll` returns 50 channels (as tested in P2), this executes 51 queries (1 for channels + 50 for members). The test baseline (P2) accepts this with a 500ms threshold, but it is an N+1 pattern that will degrade as channel count grows. This is documented in CLAUDE.md as "N+1 member loading baseline (acceptable for Phase 6)."
- Fix: Future optimization — use a single `SELECT * FROM channel_members WHERE channel_id IN (...)` query and group results in memory. Not blocking since it is explicitly documented as a known baseline for Phase 6.

## Suggestions (Lower Confidence)

- **tmuxSession name length could exceed tmux TMUX_NAME_MAX** - `src/core/domain.ts:1134` (Confidence: 70%) — With both channel name and member name at max 64 chars, `beat-channel-{64}-{64}` = 142 chars, well under tmux's 256-byte limit. However, the JSDoc says "max 64 chars leaves room" without documenting the exact arithmetic. A static assertion or comment showing the worst-case calculation (13 + 64 + 1 + 64 = 142 < 256) would make the bound explicit.

- **createChannel removes validation but relies on caller discipline** - `src/core/domain.ts:1121-1126` (Confidence: 65%) — The factory function previously threw on invalid names (visible in the diff as removed code). The new pattern delegates validation to "service/MCP boundary" per the JSDoc. This is architecturally consistent with createTask/createSchedule/createLoop, but the reliability risk is that a future caller bypasses the boundary and creates a channel with an invalid name. The JSDoc comment mitigates this, but an assert would be stronger.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Reliability Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

Conditions:
1. Document the `updateRound` vs `maxRounds` enforcement contract (HIGH) — either enforce at service layer or add JSDoc clarifying the caller's obligation
2. Consider adding a `MAX_CHANNEL_MEMBERS` bound to prevent unbounded tmux session creation (MEDIUM)
