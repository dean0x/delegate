# TypeScript Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

**Missing `TmuxConnectorPort` and `TmuxAgentType` exports from barrel** - `src/implementations/tmux/index.ts`
**Confidence**: 90%
- Problem: `types.ts` defines and exports `TmuxConnectorPort` (the port interface consumers should program against) and `TmuxAgentType` (the narrowed agent union), but the barrel `index.ts` does not re-export either. Any consumer outside the tmux package that needs the port interface for dependency injection or type annotations must reach into `./types.js` directly, bypassing the barrel. This defeats the purpose of the public API surface defined in `index.ts`.
- Fix: Add both to the `export type {}` block in `index.ts`:
```typescript
export type {
  CommunicationMode,
  ExecFn,
  ExecResult,
  OutputMessage,
  StalenessConfig,
  TmuxAgentType,        // <-- add
  TmuxConnectorPort,    // <-- add
  TmuxHandle,
  TmuxHooks,
  TmuxInfo,
  TmuxSessionConfig,
  TmuxSessionInfo,
  TmuxSessionManager,
  TmuxSessionResult,
  TmuxSpawnConfig,
  TmuxValidator,
  WrapperConfig,
  WrapperManifest,
} from './types.js';
```

### MEDIUM

**`VALID_OUTPUT_TYPES` decoupled from `OutputMessage['type']` union** - `src/implementations/tmux/tmux-connector.ts:53`
**Confidence**: 82%
- Problem: `VALID_OUTPUT_TYPES` is typed `Set<string>` with hardcoded values `['stdout', 'stderr', 'result']`. If `OutputMessage.type` (defined as `'stdout' | 'stderr' | 'result'` in `types.ts`) is extended with a new variant, `VALID_OUTPUT_TYPES` will silently fail to include it — the type guard will reject valid messages. Using `Set<OutputMessage['type']>` would cause a compile error if the set does not cover a new variant.
- Fix:
```typescript
const VALID_OUTPUT_TYPES = new Set<OutputMessage['type']>(['stdout', 'stderr', 'result']);
```
Then replace `VALID_OUTPUT_TYPES.has(v.type)` on line 66 with `VALID_OUTPUT_TYPES.has(v.type as OutputMessage['type'])` or use a helper that checks membership. Alternatively, keep the `Set<string>` for the `.has()` call but add a compile-time exhaustiveness check:
```typescript
const VALID_OUTPUT_TYPES: Set<string> = new Set<OutputMessage['type']>(['stdout', 'stderr', 'result']);
```
This way the set literal is checked against the union at construction, but `.has(v.type)` still accepts `string`.

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **`injectEnvironment` returns `boolean` instead of `Result`** - `tmux-session-manager.ts:134` (Confidence: 65%) -- Private method returns `boolean` while every other method in the class returns `Result<T, E>`. The return value is discarded at the call site (line 117). Documented as intentional ("best-effort"), but the pattern inconsistency could confuse future contributors. Consider returning `Result<void, AutobeatError>` for internal consistency, or documenting the boolean return with a JSDoc `@returns` explaining why it diverges from the Result pattern.

- **Non-null assertions on guarded paths are safe but could use comments** - `tmux-connector.ts:634`, `tmux-connector.ts:662` (Confidence: 62%) -- Both `!` assertions are logically safe (line 634 is inside a `size > 100` guard, line 662 is after a `.has()` check). However, `noUncheckedIndexedAccess` is not enabled in `tsconfig.json`, so these `!` assertions are not even required by the compiler. If `noUncheckedIndexedAccess` is enabled in the future, these assertions become load-bearing -- a brief inline comment explaining the invariant would help.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**TypeScript Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Positive Observations

The tmux module demonstrates strong TypeScript discipline:

1. **Zero `any` types** -- All code uses `unknown` with proper type guards (e.g., `isOutputMessage`), `Record<string, unknown>` for object property access, and explicit type annotations throughout.

2. **All public API return types explicitly annotated** -- Every public method on `TmuxConnector`, `DefaultTmuxSessionManager`, `DefaultTmuxHooks`, and `DefaultTmuxValidator` has an explicit return type annotation using `Result<T, AutobeatError>`.

3. **Consistent Result pattern** -- All fallible public operations return `Result<T, AutobeatError>`. No thrown exceptions in business logic.

4. **Proper type-only imports** -- All type imports use `import type` (split correctly per latest commit `2ff505c`).

5. **Well-designed interfaces** -- `TmuxSessionManager`, `TmuxHooks`, `TmuxValidator`, and `TmuxConnectorPort` are clean dependency injection interfaces. `SpawnCallbacks` properly types the `onOutput` and `onExit` payloads.

6. **Safe `as` usage** -- The only `as` cast (`as Record<string, unknown>` in the type guard) follows the standard pattern for narrowing `unknown` objects and is preceded by a null/type check.

7. **Type-safe discriminated unions** -- `OutputMessage.type` uses a string literal union (`'stdout' | 'stderr' | 'result'`), and `CommunicationMode` uses `'unicast' | 'broadcast'`.

8. **Nullable handling** -- `fs.watch` callback's `filename: string | null` is properly narrowed with `if (!filename) return` before use. Optional fields in configs use `?` consistently.

### Conditions for Merge

1. Export `TmuxConnectorPort` and `TmuxAgentType` from the barrel `index.ts` so consumers can import the port interface for DI without reaching into internal modules.
2. Tighten `VALID_OUTPUT_TYPES` type to prevent silent drift from the `OutputMessage['type']` union.
