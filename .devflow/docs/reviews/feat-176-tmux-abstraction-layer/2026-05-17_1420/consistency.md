# Consistency Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17

## Issues in Your Changes (BLOCKING)

### HIGH

**Interface naming uses "I" prefix — deviates from codebase convention** - `src/implementations/tmux/types.ts:182,193,202`
**Confidence**: 95%
- Problem: The tmux layer introduces `ITmuxSessionManager`, `ITmuxHooks`, and `ITmuxValidator` with the Hungarian "I" prefix. The entire existing codebase (30+ interfaces in `core/interfaces.ts` alone) uses un-prefixed names: `TaskQueue`, `ProcessSpawner`, `ResourceMonitor`, `WorkerPool`, `Logger`, `EventBus`, etc. A `grep` for `^export interface I[A-Z]` across all source files returns only these 3 tmux interfaces.
- Fix: Rename to `TmuxSessionManagerPort`, `TmuxHooksPort`, `TmuxValidatorPort` (or simply `SessionManager`, `Hooks`, `Validator` if scoped within the tmux module). Alternatively, drop the prefix entirely and keep the current names without "I":
  ```typescript
  // types.ts
  export interface TmuxSessionManager { ... }
  export interface TmuxHooks { ... }
  export interface TmuxValidator { ... }
  ```
  Then rename the concrete classes to include an implementation qualifier (e.g., `DefaultTmuxSessionManager implements TmuxSessionManager`), or keep structural typing without `implements`.

**Classes do not use `implements` keyword despite having corresponding interfaces** - `src/implementations/tmux/tmux-session-manager.ts:69`, `tmux-hooks.ts:114`, `tmux-validator.ts:37`
**Confidence**: 92%
- Problem: `TmuxSessionManager`, `TmuxHooks`, and `TmuxValidator` all have corresponding interfaces (`ITmuxSessionManager`, `ITmuxHooks`, `ITmuxValidator`) but none of the classes use the `implements` keyword. The existing codebase consistently uses `implements`: `SQLiteTaskRepository implements TaskRepository`, `EventDrivenWorkerPool implements WorkerPool`, `SQLiteWorkerRepository implements WorkerRepository`, etc. (28+ classes use this pattern). Without `implements`, the compiler cannot verify structural conformance at definition time — mismatches only surface at usage sites.
- Fix: Add `implements` to each class:
  ```typescript
  export class TmuxSessionManager implements ITmuxSessionManager { ... }
  export class TmuxHooks implements ITmuxHooks { ... }
  export class TmuxValidator implements ITmuxValidator { ... }
  ```

**`spawn()` is `async` but contains no `await` calls** - `src/implementations/tmux/tmux-connector.ts:101`
**Confidence**: 90%
- Problem: `TmuxConnector.spawn()` is declared `async` and returns `Promise<Result<TmuxHandle, AutobeatError>>`, but the method body contains zero `await` expressions. Every operation inside (validate, generateWrapper, createSession, watch setup, setInterval) is synchronous. The unnecessary `async` wraps the return in a Promise, adding overhead and misleading callers about the method's nature. The design comment at line 4-6 even states "synchronous ExecFn so that the caller controls async boundaries."
- Fix: Remove `async` and return `Result<TmuxHandle, AutobeatError>` directly:
  ```typescript
  spawn(config: TmuxSpawnConfig, callbacks: SpawnCallbacks): Result<TmuxHandle, AutobeatError> {
  ```

### MEDIUM

**Mutable array return types instead of `readonly`** - `src/implementations/tmux/tmux-session-manager.ts:194`, `src/implementations/tmux/tmux-connector.ts:268`
**Confidence**: 88%
- Problem: `listSessions()` returns `Result<TmuxSessionInfo[], AutobeatError>` and `getActiveHandles()` returns `TmuxHandle[]`. The codebase convention uses `readonly` arrays in all return types: `Result<readonly Task[]>`, `Result<readonly WorkerRegistration[]>`, `Result<readonly Schedule[]>`, etc. (20+ occurrences in `core/interfaces.ts`).
- Fix:
  ```typescript
  listSessions(): Result<readonly TmuxSessionInfo[], AutobeatError> { ... }
  getActiveHandles(): readonly TmuxHandle[] { ... }
  ```

**Manual `typeof` validation instead of Zod schema at parse boundary (duplicated twice)** - `src/implementations/tmux/tmux-connector.ts:323-334,386-397`
**Confidence**: 82%
- Problem: Output message parsing uses manual `typeof` checks with `as Record<string, unknown>` casts, duplicated in both `flushPendingFiles()` and `handleMessageFile()`. The project's stated principle is "Parse, don't validate (Zod schemas)" and existing implementations use Zod schemas at boundaries (`TaskRowSchema` in task-repository, `WorkerRowSchema` in worker-repository). This manual approach is both inconsistent with the codebase pattern and duplicated across two methods.
- Fix: Define an `OutputMessageSchema` using Zod and extract a shared parse helper:
  ```typescript
  import { z } from 'zod';

  const OutputMessageSchema = z.object({
    sequence: z.number(),
    timestamp: z.string(),
    type: z.enum(['stdout', 'stderr', 'result']),
    content: z.string(),
  });

  function parseOutputMessage(raw: string): OutputMessage | null {
    const result = OutputMessageSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  }
  ```

**Imports placed mid-file instead of at top** - `src/implementations/tmux/types.ts:174-175`
**Confidence**: 85%
- Problem: `import type { AutobeatError }` and `import type { Result }` appear at line 174-175, after 170 lines of type definitions and constants. The codebase convention places all imports at the top of every file.
- Fix: Move these imports to the top of `types.ts`, alongside or after the file header comment.

**File header contradicts file content** - `src/implementations/tmux/types.ts:3`
**Confidence**: 85%
- Problem: Line 3 states "Pure type definitions -- no runtime logic" but the file exports runtime constants (`SESSION_NAME_PREFIX`, `SESSION_NAME_REGEX`, `SENTINEL_DONE`, `SENTINEL_EXIT`, `DEFAULT_STALENESS_CONFIG`, `MAX_CONCURRENT_SESSIONS`) and imports runtime modules. Line 2 correctly says "Types and constants" which contradicts line 3.
- Fix: Change line 3 to match reality:
  ```typescript
  /**
   * Types and constants for the tmux abstraction layer
   * Type definitions, interfaces, and shared constants — no business logic
   */
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Mixed dependency access patterns within `TmuxConnector`** - `src/implementations/tmux/tmux-connector.ts:88-91`
**Confidence**: 80%
- Problem: The class uses two different patterns for accessing dependencies: (1) `this.deps.logger`, `this.deps.sessionManager`, etc. via the retained deps bag, and (2) `this.readFileSyncFn`, `this.readdirSyncFn` via extracted private fields. No other implementation class in the codebase uses the `this.deps.` bag pattern (verified: zero matches for `this.deps.` outside tmux). The existing `EventDrivenWorkerPool` destructures deps into named private fields in the constructor.
- Fix: Either consistently use the deps bag pattern (move `readFileSync`/`readdirSync` back into the deps bag as required fields) or destructure all deps into named private fields (matching the existing `EventDrivenWorkerPool` pattern). Since this is a new module, either convention is acceptable as long as it's internally consistent — but given one approach is established codebase-wide, prefer destructuring.

**Optional behavior deps (`readFileSync`, `readdirSync`) in DI interface** - `src/implementations/tmux/tmux-connector.ts:48-50`
**Confidence**: 80%
- Problem: `readFileSync` and `readdirSync` are optional in `TmuxConnectorDeps` with defaults to `fs.*`. In the existing codebase, the only optional deps field is `outputFlushIntervalMs` in `EventDrivenWorkerPoolDeps` — a configuration value, not a behavior dependency. Having behavior dependencies be optional creates ambiguity about whether a caller needs to provide them.
- Fix: Make them required in the interface. The production callsite passes `fs.readFileSync` and `fs.readdirSync`; tests pass mocks. This matches how `watch` (also an fs function) is already required:
  ```typescript
  export interface TmuxConnectorDeps {
    sessionManager: ITmuxSessionManager;
    hooks: ITmuxHooks;
    validator: ITmuxValidator;
    logger: Logger;
    watch: WatchFn;
    readFileSync: (path: string, encoding: BufferEncoding) => string;
    readdirSync: (dirPath: string) => string[];
  }
  ```

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **`Result<T, AutobeatError>` vs `Result<T>` inconsistency** - `src/implementations/tmux/types.ts:183-203` (Confidence: 65%) -- The tmux interfaces use explicit `Result<T, AutobeatError>` while `core/interfaces.ts` uses `Result<T>` (defaulting to `Error`). However, `utils/cron.ts` and `services/schedule-executor.ts` also use explicit `Result<T, AutobeatError>`, so this is not a clear-cut violation — the codebase is split on this. Consider aligning with one convention project-wide, but not blocking.

- **`TmuxConnector` does not use the `deps.` bag pattern consistently with destructuring elsewhere** - `src/implementations/tmux/tmux-connector.ts` (Confidence: 70%) -- The `this.deps.` access pattern works and is internally consistent within the tmux module, but it introduces a second convention into the codebase. If tmux is intended to be the model for future subsystems, this should be standardized.

- **Hardcoded agent type `'claude'` in spawn** - `src/implementations/tmux/tmux-connector.ts:109` (Confidence: 65%) -- The `spawn()` method hardcodes `agent: 'claude'` in the wrapper config. This likely reflects current scope (only Claude agents use tmux) but could become a consistency issue when Codex/Gemini agents are supported.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 3 | 4 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Consistency Score**: 6/10
**Recommendation**: CHANGES_REQUESTED

The tmux abstraction layer introduces well-structured, well-documented code with proper Result types, DI, and error factories. However, several naming and structural conventions deviate from the established codebase patterns: "I"-prefixed interfaces (unique in the codebase), missing `implements` keyword on classes, unnecessary `async` on a synchronous method, mutable array returns, and manual validation instead of Zod schemas. These should be aligned before merge to maintain the codebase's strong consistency record.
