# Regression Review Report

**Branch**: feat/184-dashboard-channels -> main
**Date**: 2026-05-28
**Prior Resolutions**: Cycle 3 (18 issues, 13 fixed, 4 FP, 0 deferred) — all accounted for.

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

### MEDIUM

(none)

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

(none)

## Regression Analysis

### 1. Lost Functionality Check

| Check | Status | Notes |
|-------|--------|-------|
| Removed exports | PASS | No `export` statements removed (verified via `git diff | grep "^-export"`) |
| Removed files | PASS | No files deleted in this PR |
| Removed CLI options | N/A | No CLI changes in this diff |
| Removed event handlers | PASS | No `.on()` calls removed |

### 2. Broken Behavior Check

| Check | Status | Notes |
|-------|--------|-------|
| `unwrapAll` removal | PASS | Function was private to `use-dashboard-data.ts`, sole caller was `fetchAllData`. Replaced by inline per-result unwrapping that preserves identical error semantics (labeled error strings on failure). No external consumers. |
| `fetchMetricsExtras` signature change | PASS | Removed `channels` parameter. Function is file-private (`async function`, not exported). Single call site updated from `fetchMetricsExtras(ctx, channels)` to `fetchMetricsExtras(ctx)`. Now uses `ctx.channelRepository.findUpdatedSince()` instead of in-memory filter — behavior improvement, not regression. |
| `Channel` type import removed | PASS | `use-dashboard-data.ts` no longer references `Channel` type directly; types are inferred from repository return types in the new destructured `Promise.all` pattern. TypeScript typecheck confirms clean. |
| `resolveMemberIndex` null check narrowing | PASS | Changed from `!selectedName` (falsy: catches null, undefined, empty string) to `selectedName === null` (strict null). The parameter type is `string \| null` and all assignments produce either `null` or `members[idx]?.name ?? null` (never empty string). Narrowing is correct. |
| `?? []` removal on pipelines/channels | PASS | `DashboardData.pipelines` and `DashboardData.channels` are non-optional `readonly` arrays in `types.ts`. The `?? []` was defensive against a type that cannot be undefined. Removal is safe. |
| `dimColor` change on channel detail | PASS | Changed from unconditional `dimColor` to `dimColor={!isSelected}` with `color={isSelected ? 'white' : undefined}`. This fixes contrast on selected rows — additive improvement. |
| Channel hints: `baseChannel` vs `baseNoOutput` | PASS | New `baseChannel` removes 'Enter detail' hint for channels (which have no Enter drill-through). Prevents misleading hint text. Not a regression — intentional correction. |

### 3. Intent vs Reality Check

| Commit message claim | Verified |
|---------------------|----------|
| Exhaustive never guards added | YES — `cancelEntity`, `deleteEntity`, `getPanelItems`, `panelToEntityKind` all have `default: { const _exhaustive: never = kind; }` guards |
| Limit clamp on `getMessages` | YES — `Math.max(1, Math.min(...))` ensures limit is at least 1 and at most MAX_MESSAGES_PER_CHANNEL |
| Atomic `saveMessage` transaction | YES — INSERT + COUNT + conditional DELETE wrapped in `this.db.transaction()` |
| Cache eviction guard | YES — `membersByChannelIdsStmtCache` evicts oldest entry when exceeding DEFAULT_LIMIT |
| `findUpdatedSince` for channels | YES — Interface method added, implementation backed by prepared statement with `idx_channels_updated_at` index, 3 tests cover time filtering, limit, and empty results |

### 4. Incomplete Migration Check

| Check | Status | Notes |
|-------|--------|-------|
| `ChannelRepository` interface + implementation alignment | PASS | `findUpdatedSince` added to both `interfaces.ts:1060` and `channel-repository.ts:380` |
| Dashboard mock alignment | PASS | `makeCtx` in `use-dashboard-data.test.ts` includes `findUpdatedSince` mock. All channel repo mocks in test files updated. |
| Activity feed integration | PASS | `fetchMetricsExtras` now calls `ctx.channelRepository.findUpdatedSince(since1h, 50)` in the parallel batch, consistent with all other entity types |
| Prior in-memory channel filter removed | PASS | Old `channels.filter((c) => (c.updatedAt ?? c.createdAt ?? 0) >= since1h)` replaced by proper DB query. No orphaned filter code remains. |

### 5. Cross-Cycle Awareness

Prior resolution cycle 3 fixed 13 issues. This review confirms:
- Exhaustive never guards: present and correctly structured (inside try/catch, `void _exhaustive` to avoid unused-var lint, assignment alone enforces invariant)
- Limit clamp: lower bound of 1 added via `Math.max(1, ...)` 
- Atomic saveMessage: transaction wraps INSERT + prune, with inner try/catch preserving INSERT on prune failure
- Cache eviction guard: FIFO eviction on cache overflow
- dimColor contrast: conditional `dimColor={!isSelected}` replaces unconditional `dimColor`
- No regressions from the cycle 3 fixes observed

### 6. Decision/Pitfall Awareness

- **ADR-001** (channel name = tmux SESSION_NAME_REGEX): No changes to channel name validation in this diff. Existing constraint preserved.
- **ADR-003** (pre-existing gaps tracked as issues): No pre-existing gaps surfaced in this regression review.
- **PF-004** (multi-step create rollback must clean all three layers): No create/rollback changes in this diff. Existing rollback logic unchanged.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | - | 0 | 0 |

**Regression Score**: 10/10
**Recommendation**: APPROVED

No regressions detected. All changes are either additive (new `findUpdatedSince` method, exhaustive guards, new tests) or behavioral improvements (atomic saveMessage, limit clamp, dimColor contrast fix, proper DB query replacing in-memory filter). The `unwrapAll` removal and `fetchMetricsExtras` signature change are internal-only refactors with no external surface area. All 1,329 tests across dashboard (773), repository (288), and handler (268) suites pass. TypeScript typecheck is clean.
