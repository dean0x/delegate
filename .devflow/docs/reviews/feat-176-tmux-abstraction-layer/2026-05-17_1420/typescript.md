# TypeScript Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17
**Focus**: Type safety, generic usage, discriminated unions, utility types, strict typing, `any` usage

## Issues in Your Changes (BLOCKING)

### HIGH

**Duplicated `OutputMessage` validation without type guard** - `tmux-connector.ts:323-334` and `tmux-connector.ts:385-397`
**Confidence**: 92%
- Problem: The `OutputMessage` shape validation logic is copy-pasted in two locations (`flushPendingFiles` and `handleMessageFile`). Both perform identical `typeof` checks then cast with `parsed as OutputMessage`. Without a proper type guard function (`value is OutputMessage`), TypeScript cannot narrow the type after the check, requiring the unsafe `as` cast. Additionally, the `type` field is only validated as `string` but not checked against the union `'stdout' | 'stderr' | 'result'` -- a message with `type: "garbage"` would pass validation and be delivered as a valid `OutputMessage`.
- Fix: Extract a type guard function and add literal type validation:
```typescript
const VALID_OUTPUT_TYPES = new Set<string>(['stdout', 'stderr', 'result']);

function isOutputMessage(value: unknown): value is OutputMessage {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.sequence === 'number' &&
    typeof obj.timestamp === 'string' &&
    typeof obj.type === 'string' &&
    VALID_OUTPUT_TYPES.has(obj.type) &&
    typeof obj.content === 'string'
  );
}
```
Then replace both inline checks with `if (!isOutputMessage(parsed))`.

**`TmuxSessionManager.createSession` returns `sessionsDir: ''` in handle** - `tmux-session-manager.ts:132`
**Confidence**: 88%
- Problem: `createSession` returns `ok({ sessionName: config.name, taskId, sessionsDir: '' })`. The `TmuxHandle.sessionsDir` is typed as `string` (not optional), so an empty string silently satisfies the type but is semantically wrong. Any direct consumer of `TmuxSessionManager.createSession` would receive a handle with an unusable `sessionsDir`. Currently only `TmuxConnector` calls this and overwrites the value, but this is a latent type-safety hole.
- Fix: Either make `sessionsDir` optional on the session manager's return type by splitting `TmuxHandle` into a `TmuxSessionHandle` (without `sessionsDir`) for the session manager and `TmuxHandle` (with `sessionsDir`) for the connector, or pass `sessionsDir` through `TmuxSessionConfig` so the session manager can populate it correctly.

### MEDIUM

**`spawn` is declared `async` but contains no `await`** - `tmux-connector.ts:101`
**Confidence**: 90%
- Problem: The method signature `async spawn(...): Promise<Result<TmuxHandle, AutobeatError>>` wraps the return in a Promise unnecessarily. The entire method body is synchronous. This misleads callers into believing the operation is asynchronous and introduces an unnecessary microtask tick.
- Fix: If this is intentionally async for future extension (e.g., async wrapper generation), document that with a `// DESIGN DECISION: async for forward compatibility with...` comment. Otherwise, remove `async` and change the return type to `Result<TmuxHandle, AutobeatError>`.

**Dependency injection interfaces not exported from `index.ts`** - `index.ts`
**Confidence**: 85%
- Problem: `ITmuxSessionManager`, `ITmuxHooks`, and `ITmuxValidator` are defined in `types.ts` but not re-exported from `index.ts`. External consumers who want to write test doubles against these interfaces or implement alternative backends cannot import them through the public API barrel.
- Fix: Add to `index.ts` type exports:
```typescript
export type {
  // ... existing types ...
  ITmuxHooks,
  ITmuxSessionManager,
  ITmuxValidator,
} from './types.js';
```

**`signal` parameter in `onExit` is stringly-typed** - `tmux-connector.ts:55`
**Confidence**: 82%
- Problem: `onExit: (code: number | null, signal?: string) => void` uses a bare `string` for the exit signal. Currently the only non-`undefined` value is `'STALE'` (line 238). As the system grows, other exit reasons will emerge (e.g., `'SIGTERM'`, `'SIGKILL'`, `'TIMEOUT'`). A string literal union would prevent typos and enable exhaustive handling by consumers.
- Fix: Define an exit reason type:
```typescript
export type TmuxExitReason = 'STALE' | 'SIGTERM' | 'SIGKILL';

export interface SpawnCallbacks {
  onOutput: (msg: OutputMessage) => void;
  onExit: (code: number | null, reason?: TmuxExitReason) => void;
}
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`handleSentinel` filename parameter is wider than necessary** - `tmux-connector.ts:353`
**Confidence**: 80%
- Problem: `private handleSentinel(taskId: string, sessionDir: string, filename: string, ...)` accepts any `string` for `filename`, but it is only called with `'.done'` or `'.exit'` (line 146-147). The sentinel constants (`SENTINEL_DONE`, `SENTINEL_EXIT`) are already typed as `'.done' as const` and `'.exit' as const` in `types.ts`. Using these literal types would make the method's contract explicit and let TypeScript verify exhaustive handling in the conditional on line 369.
- Fix:
```typescript
private handleSentinel(
  taskId: string,
  sessionDir: string,
  filename: typeof SENTINEL_DONE | typeof SENTINEL_EXIT,
  callbacks: SpawnCallbacks,
): void {
```

**Inconsistent `import type` usage** - `tmux-connector.ts:18`, `tmux-connector.ts:21-30`, `tmux-validator.ts:11`, `tmux-session-manager.ts:15-22`
**Confidence**: 80%
- Problem: Some imports correctly use `import type` (e.g., `tmux-connector.ts:19` for `Logger`, `types.ts:174-175` for `AutobeatError` and `Result`) while others import type-only symbols as value imports. For example, `AutobeatError` at `tmux-connector.ts:18` is only used as a type parameter in return types, never instantiated. Similarly, `ITmuxHooks`, `ITmuxSessionManager`, `ITmuxValidator`, `OutputMessage`, `StalenessConfig`, `TmuxHandle`, `TmuxSpawnConfig` are all type-only but imported as values.
- Fix: Split the types.js import in `tmux-connector.ts`:
```typescript
import type { AutobeatError } from '../../core/errors.js';
import { ok } from '../../core/result.js';
import type { Result } from '../../core/result.js';
import { DEFAULT_STALENESS_CONFIG } from './types.js';
import type {
  ITmuxHooks, ITmuxSessionManager, ITmuxValidator,
  OutputMessage, StalenessConfig, TmuxHandle, TmuxSpawnConfig,
} from './types.js';
```
Apply similar splitting to `tmux-validator.ts` and `tmux-session-manager.ts`.

## Pre-existing Issues (Not Blocking)

### LOW

**`WrapperConfig.agent` omits `'gemini'`** - `types.ts:81`
**Confidence**: 80%
- Problem: `agent: 'claude' | 'codex'` doesn't include `'gemini'`, which is a supported agent per the project's multi-agent support (v0.5.0). The connector also hardcodes `agent: 'claude'` at `tmux-connector.ts:109`. This limits future extensibility but is not a regression since the current layer is Claude-focused.
- Fix: Consider widening to `agent: 'claude' | 'codex' | 'gemini'` or importing the agent type from the existing agent registry.

## Suggestions (Lower Confidence)

- **Non-null assertions could use defensive patterns** - `tmux-connector.ts:345,414,426` (Confidence: 65%) -- The `!` assertions on `sortedSeqs[0]` and `pendingMessages.get()` are guarded by prior checks but could use `?? 1` or `if (!msg) continue` patterns for defense-in-depth.

- **`listSessions` tuple cast could use a destructuring guard** - `tmux-session-manager.ts:220` (Confidence: 70%) -- `parts as [string, string, string, string, string]` is safe given the `parts.length < 5` check above, but a named parsing function would be clearer and avoid the assertion.

- **`types.ts` mixes runtime code with type definitions** - `types.ts:174-175,206-227` (Confidence: 60%) -- The file header says "Pure type definitions -- no runtime logic" but it exports runtime constants (`SESSION_NAME_PREFIX`, `SENTINEL_DONE`, etc.) and imports at line 174-175. Consider splitting into `types.ts` (pure types) and `constants.ts` (runtime values).

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 0 | 1 |

**Positive observations**:
- Zero `any` types across all new files -- `unknown` is used correctly for JSON parsing
- All public methods have explicit return type annotations
- Discriminated union Result types are used consistently throughout
- The `as const` assertions on sentinel/prefix constants produce proper literal types
- `import type` is used in some places (e.g., `Logger`, the types.ts dependency imports)
- Interfaces (`ITmuxSessionManager`, `ITmuxHooks`, `ITmuxValidator`) enable clean dependency injection
- `ActiveSession` is a well-structured internal state type with no exported leakage

**TypeScript Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The two HIGH issues -- duplicated validation without a type guard (which also misses literal union validation for `OutputMessage.type`) and the semantically incorrect empty-string `sessionsDir` -- should be addressed. The medium issues around `async` without `await`, missing interface exports, and stringly-typed signals are worth fixing for long-term type safety.
