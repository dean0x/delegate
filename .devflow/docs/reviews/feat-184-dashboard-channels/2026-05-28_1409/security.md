# Security Review Report

**Branch**: feat/184-dashboard-channels -> main
**Date**: 2026-05-28T14:09
**Diff**: `git diff 37efbc094027922e9cc86f6c6cec0a16e6e0da36...HEAD`
**Prior Resolutions**: Cycle 3 — 13 fixed, 4 false positive, 0 deferred

## Issues in Your Changes (BLOCKING)

No blocking security issues found.

## Issues in Code You Touched (Should Fix)

No should-fix security issues found.

## Pre-existing Issues (Not Blocking)

No pre-existing security issues found at CRITICAL severity in changed files.

## Suggestions (Lower Confidence)

No suggestions at 60-79% confidence.

## Analysis Notes

### SQL Injection Surface (OWASP A03) — Safe

The `findMembersByChannelIds` method (channel-repository.ts:515-546) constructs SQL dynamically with an IN clause. This was reviewed for injection risk:

- Placeholders are generated from array length (`ids.map(() => '?').join(', ')`), not from user-controlled values — **no injection vector**. The actual IDs are bound as parameterized values via `stmt.all(...ids)`.
- The arity is bounded by `DEFAULT_LIMIT` (100) from the calling `hydrateChannelRows` method, and the cache eviction guard (new in this diff, lines 524-532) enforces an upper bound on the statement cache size.
- This pattern is consistent with other repositories in the codebase (task, loop, etc.).
- Applies ADR-001: channel names are constrained to `CHANNEL_NAME_REGEX` (subset of tmux `SESSION_NAME_REGEX`), preventing special characters from flowing into session name derivation.

### New `findUpdatedSince` Method — Safe

The new `findUpdatedSince` (channel-repository.ts:380-388) uses a prepared statement with parameterized `sinceMs` and `limit` values. No string interpolation. Mirrors the identical pattern in `task-repository.ts:493-496` and other entity repositories. The `sinceMs` value originates from `Date.now()` arithmetic in `fetchMetricsExtras` — not user input.

### Dashboard Mutation Handlers — Safe

The `cancelEntity`, `pauseOrResumeEntity`, and `deleteEntity` functions in `entity-mutations.ts` all:
- Check terminal status before performing destructive operations (no double-cancel/delete).
- Use typed branded IDs (`ChannelId`, `LoopId`, etc.) preventing cross-entity confusion.
- Wrap all service calls in try/catch with intentional error swallowing to prevent TUI crashes — appropriate for best-effort dashboard operations.
- New exhaustiveness guards (`const _exhaustive: never = kind`) at lines 91-96 and 213-218 ensure future entity kinds cannot silently fall through.

### `saveMessage` Atomicity Improvement — Safe

The refactored `saveMessage` (channel-repository.ts:399-434) wraps INSERT + COUNT + conditional DELETE in a single SQLite transaction. This is a security improvement: it prevents concurrent `ChannelMessageSent` events from double-pruning message rows, which could cause data loss. The inner try/catch on the prune operation preserves the INSERT even if pruning fails.

### `getMessages` Limit Clamp — Safe

The `getMessages` method now applies `Math.max(1, Math.min(limit, MAX))` (channel-repository.ts:443-448), preventing both zero/negative limits (which could produce unexpected behavior) and unbounded queries. This is a defensive improvement.

### Error Message Information Disclosure — Acceptable

The `fetchAllData` function (use-dashboard-data.ts:221-233) surfaces repository error messages in the Result error string (e.g., `Tasks fetch failed: ${tasksResult.error.message}`). Since this is a CLI dashboard (not a web API exposed to external users), leaking internal error messages is acceptable and useful for debugging.

### Boundary Validation — Covered

All DB row conversions use Zod schemas (`ChannelRowSchema`, `ChannelMemberRowSchema`, `ChannelMessageRowSchema`) at the trust boundary, ensuring malformed database data cannot propagate into domain objects. This satisfies the parse-don't-validate principle.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | - | 0 | 0 |

**Security Score**: 9/10
**Recommendation**: APPROVED

The PR introduces no new security vulnerabilities. All SQL access uses parameterized queries or prepared statements. The dynamic IN-clause construction generates only `?` placeholders (not user values). Input validation at boundaries is comprehensive via Zod schemas. The `saveMessage` transactional refactor and `getMessages` limit clamp are defensive improvements. Dashboard mutations are properly guarded against terminal-status double-actions and include exhaustiveness checks for future entity kinds.
