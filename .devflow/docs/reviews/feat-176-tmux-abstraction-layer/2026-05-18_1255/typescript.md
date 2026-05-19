# TypeScript Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-18
**Files reviewed**: 6 new files (types.ts, tmux-connector.ts, tmux-hooks.ts, tmux-session-manager.ts, tmux-validator.ts, index.ts), 1 modified (errors.ts)

## Issues in Your Changes (BLOCKING)

### CRITICAL

**Set.has() type mismatch causes compilation error** - `tmux-connector.ts:74`
**Confidence**: 100%
- Problem: `VALID_OUTPUT_TYPES` is typed as `Set<'stdout' | 'stderr' | 'result'>` but `v.type` is narrowed to `string` (not the literal union) after the `typeof v.type === 'string'` guard. `Set<T>.has(value: T)` requires the parameter to match `T`, so passing `string` to `Set<'stdout'|'stderr'|'result'>.has()` is a type error. `npm run typecheck` confirms: `error TS2345: Argument of type 'string' is not assignable to parameter of type '"stdout" | "stderr" | "result"'`.
- Fix: Widen the Set type to `Set<string>` (the runtime behavior is unchanged):
```typescript
const VALID_OUTPUT_TYPES: Set<string> = new Set(['stdout', 'stderr', 'result']);
```

**Logger.error() signature mismatch causes compilation error** - `tmux-connector.ts:297-300`
**Confidence**: 100%
- Problem: `Logger.error()` signature is `error(message: string, error?: Error, context?: Record<string, unknown>)`. Line 297 passes an object literal `{ taskId, error }` as the second argument, which TypeScript expects to be an `Error` instance, not a context record. `npm run typecheck` confirms: `error TS2353: Object literal may only specify known properties, and 'taskId' does not exist in type 'Error'`.
- Fix: Pass the error as the second argument and context as the third:
```typescript
} catch (teardownErr: unknown) {
  this.deps.logger.error(
    'Dispose: unhandled error during session teardown',
    teardownErr instanceof Error ? teardownErr : new Error(String(teardownErr)),
    { taskId: session.handle.taskId },
  );
}
```

### HIGH

**taskId uses plain `string` instead of branded `TaskId` type** - `types.ts:41,58,98`
**Confidence**: 85%
- Problem: The codebase uses branded types for domain identifiers (`TaskId`, `WorkerId`, etc.) in `src/core/domain.ts` to prevent ID confusion at compile time. The tmux layer uses plain `string` for `taskId` in `TmuxSpawnConfig`, `TmuxHandle`, and `WrapperConfig`. This means a `WorkerId` or any arbitrary string could be passed as a `taskId` without a type error, defeating the branding purpose.
- Fix: Import and use the branded `TaskId` type:
```typescript
import type { TaskId } from '../../core/domain.js';

export interface TmuxSpawnConfig extends TmuxSessionConfig {
  taskId: TaskId;
  // ...
}
export interface TmuxHandle {
  sessionName: string;
  taskId: TaskId;
  // ...
}
export interface WrapperConfig {
  taskId: TaskId;
  // ...
}
```
Note: This will require the connector's `activeSessions` Map to be `Map<TaskId, ActiveSession>` and callers to provide a branded `TaskId`. If the tmux layer intentionally operates below the domain layer and receives pre-validated IDs as strings, add a JSDoc `@design` comment explaining this decision.

### MEDIUM

**Non-null assertion on `sortedSeqs[0]` without safety check** - `tmux-connector.ts:663`
**Confidence**: 82%
- Problem: `session.nextExpectedSeq = sortedSeqs[0]!;` uses a non-null assertion. While the preceding `session.pendingMessages.size > MAX_PENDING_MESSAGES` guard ensures the map is non-empty, and therefore `sortedSeqs` is non-empty, `noUncheckedIndexedAccess` (not enabled in tsconfig but a recommended strictness) would flag this. If `noUncheckedIndexedAccess` is ever enabled, this line breaks.
- Fix: Use a safe fallback:
```typescript
const firstSeq = sortedSeqs[0];
if (firstSeq !== undefined) {
  session.nextExpectedSeq = firstSeq;
}
```

**Non-null assertion in `deliverPendingMessages`** - `tmux-connector.ts:691`
**Confidence**: 80%
- Problem: `session.pendingMessages.get(session.nextExpectedSeq)!` uses a non-null assertion. The `has()` check on the prior line of the while condition makes this safe at runtime, but TypeScript cannot narrow `Map.get()` based on a preceding `Map.has()`. If the codebase later enables `noUncheckedIndexedAccess` or if the pattern is copy-pasted without the guard, it could cause a runtime crash.
- Fix: Use a local variable with an early-continue:
```typescript
const msg = session.pendingMessages.get(session.nextExpectedSeq);
if (!msg) break; // should never happen due to has() check
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`readonly` missing on public interface fields** - `types.ts:21-34,39-48,54-61,75-84`
**Confidence**: 80%
- Problem: The codebase uses `readonly` extensively on domain types (e.g., `Task`, `Worker` interfaces in `domain.ts` — 340 `readonly` occurrences). The tmux config/handle/message interfaces have no `readonly` modifiers on any fields. For config objects (`TmuxSessionConfig`, `TmuxSpawnConfig`, `WrapperConfig`) and handle objects (`TmuxHandle`), fields should not be mutated after creation per the project's immutability-by-default principle.
- Fix: Add `readonly` to fields on `TmuxHandle`, `TmuxSessionConfig`, `TmuxSpawnConfig`, `WrapperConfig`, `WrapperManifest`, `OutputMessage`, `TmuxSessionInfo`, `TmuxInfo`, and `StalenessConfig`. Example:
```typescript
export interface TmuxHandle {
  readonly sessionName: string;
  readonly taskId: string;
  readonly sessionsDir: string;
}
```
Note: `ActiveSession` (internal to tmux-connector.ts) intentionally mutates fields (`exited`, `lastAliveCheck`, `nextExpectedSeq`, etc.) so it should NOT be made readonly.

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **`SpawnCallbacks` re-export route inconsistency** - `index.ts:9` vs `index.ts:18-37` (Confidence: 65%) — `SpawnCallbacks` is defined in `types.ts` alongside all other types but re-exported via `tmux-connector.js` instead of directly from `types.js` like the other 17 type re-exports. Consider moving it to the types re-export block for consistency.

- **`noUncheckedIndexedAccess` not enabled in tsconfig** - `tsconfig.json` (Confidence: 60%) — The tmux code defensively handles `undefined` from array indexing (e.g., `listSessions` parsing in session-manager.ts:254-259), but enabling `noUncheckedIndexedAccess` in tsconfig would enforce this pattern project-wide and catch the non-null assertions at lines 663 and 691 at compile time.

- **`as Record<string, unknown>` cast in type guard could use helper** - `tmux-connector.ts:69` (Confidence: 62%) — The `value as Record<string, unknown>` cast is standard but could be extracted into a reusable `asRecord(value: object): Record<string, unknown>` helper if this pattern appears in other type guards across the codebase.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 2 | 1 | 2 | - |
| Should Fix | - | - | 1 | - |
| Pre-existing | - | - | - | - |

**TypeScript Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The two CRITICAL issues are confirmed TypeScript compilation errors (`npm run typecheck` fails). The `Set.has()` type mismatch and `Logger.error()` signature mismatch must be fixed before merge. The HIGH issue (branded types) aligns with established codebase conventions but may be intentionally deferred if the tmux layer operates below the domain boundary — in that case, add a JSDoc design decision comment. The MEDIUM issues are forward-looking safety improvements.
