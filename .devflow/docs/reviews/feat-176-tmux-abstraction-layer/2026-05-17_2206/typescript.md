# TypeScript Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17

## Issues in Your Changes (BLOCKING)

### MEDIUM

**`parseInt` results not validated for NaN in `listSessions` — corrupt `TmuxSessionInfo` objects** - `tmux-session-manager.ts:222-226`
**Confidence**: 85%
- Problem: `parseInt(createdStr, 10)`, `parseInt(widthStr, 10)`, and `parseInt(heightStr, 10)` can return `NaN` if the tmux format string contains unexpected data (e.g., extra colons in session name, locale-specific output). The resulting `TmuxSessionInfo` objects would have `NaN` fields typed as `number`, silently propagating invalid state.
- Impact: Downstream code comparing or computing with `NaN` fields would produce incorrect results (e.g., `NaN >= threshold` is always `false`). Currently the connector only uses `s.name`, so staleness detection is safe, but consumers of the `listSessions()` return type trust that `created: number` is a valid number.
- Fix: Add a NaN guard after parsing or skip lines with unparseable fields:
```typescript
const created = parseInt(createdStr, 10);
const width = parseInt(widthStr, 10);
const height = parseInt(heightStr, 10);
if (isNaN(created) || isNaN(width) || isNaN(height)) continue;

sessions.push({
  name,
  created,
  attached: attachedStr === '1',
  width,
  height,
});
```

**Session name containing colons breaks `listSessions` tuple destructuring** - `tmux-session-manager.ts:213-216`
**Confidence**: 82%
- Problem: The `parts.split(':')` approach assumes tmux session names do not contain colons. Although the `SESSION_NAME_REGEX` (`/^beat-[a-z0-9-]+$/`) prevents colons in Autobeat-managed sessions, the tmux output includes ALL sessions (not just beat-*). A non-beat session named `foo:bar` would produce 6+ parts, shifting the positional destructuring and corrupting `createdStr`, `attachedStr`, etc. for any subsequent entries.
- Impact: The corrupted parse would be caught by `SESSION_NAME_REGEX.test(name)` on line 219 (filtering to only beat-* sessions), so the corrupted entry itself would be skipped. However, this relies on `name` being the first element of the split, which remains correct even with extra colons. The `as [string, string, string, string, string]` cast is safe because the `parts.length < 5` guard ensures at least 5 elements, and extra elements are just ignored by destructuring.
- Revised assessment: Upon closer inspection, this cast is actually safe for the specific use case because (a) the `length < 5` check guards the minimum, (b) extra parts from colons in other session names don't corrupt the first field, and (c) non-beat entries are filtered out. The `as` cast is justified by the preceding guard.
- No fix needed. This is safe as written.

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

_No issues found._

## Suggestions (Lower Confidence)

- **`getSessionEnvironment` not on `TmuxSessionManager` interface** - `tmux-session-manager.ts:237` (Confidence: 65%) — The method exists on `DefaultTmuxSessionManager` but not on the `TmuxSessionManager` interface. If consumers access it through the interface type, it would be inaccessible. Currently only tests use it with the concrete type, so this is likely intentional, but worth documenting the intent (public API vs. implementation-only method).

- **`as const` assertion on `SESSION_NAME_PREFIX` narrows to literal type but is only used in runtime regex** - `types.ts:218` (Confidence: 60%) — The `as const` on `SESSION_NAME_PREFIX = 'beat-'` creates a literal type `'beat-'` but the value is only used in runtime string operations (e.g., `config.name.replace(/^beat-/, '')`). The `as const` adds no runtime safety benefit here. Not harmful, but the pattern is typically used for discriminated unions or template literal types.

- **`readdirSync` injectable type returns `string[]` but real `fs.readdirSync` return type depends on overload** - `tmux-connector.ts:77,124` (Confidence: 62%) — The injectable `readdirSync` is typed as `(dirPath: string) => string[]` and the default `(p) => fs.readdirSync(p)` compiles because TypeScript selects the `string[]` overload. But if the signature were ever changed to pass options (e.g., `{ withFileTypes: true }`), the return type would silently become `Dirent[]` and break downstream `.endsWith()` calls. The current code is correct; this is just a note that the tight coupling between the injectable signature and the default implementation is fragile.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**TypeScript Score**: 9/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Conditions
1. Add NaN validation to `parseInt` results in `listSessions()` (`tmux-session-manager.ts:222-226`)

### Assessment

This is a high-quality TypeScript implementation that follows strong typing practices throughout:

- **No `any` types**: All code uses proper types; `unknown` is used correctly in the `isOutputMessage` type guard.
- **Result types consistently**: Every fallible operation returns `Result<T, AutobeatError>`. No thrown errors in business logic.
- **Dependency injection via interfaces**: All three subsystems (`TmuxSessionManager`, `TmuxHooks`, `TmuxValidator`) are defined as interfaces with injectable implementations.
- **Type guards**: The `isOutputMessage` type guard properly validates all fields including the literal union for `type`, making the single `as Record<string, unknown>` cast safe.
- **Non-null assertions**: The two `!` assertions (`sortedSeqs[0]!` at line 578 and `pendingMessages.get(...)!` at line 602) are both guarded by preceding checks (`size > MAX_PENDING_MESSAGES` ensures non-empty, and `has(key)` ensures the `get` succeeds). These are safe.
- **`as` casts**: The tuple cast at line 216 is guarded by `parts.length < 5`. The `as Record<string, unknown>` in the type guard is the standard unknown-narrowing pattern. The `as const` assertions on constants are standard.
- **No implicit `any`**: TypeScript `strict: true` is enabled. The typecheck passes cleanly.
- **Discriminated unions**: `Result<T, E>` is used throughout with proper `ok` discriminant checks. No missing branches.
- **Interface completeness**: `DefaultTmuxSessionManager`, `DefaultTmuxHooks`, and `DefaultTmuxValidator` all implement their respective interfaces completely. `getSessionEnvironment` is intentionally implementation-only.
