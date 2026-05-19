# Consistency Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-18
**Focus**: Naming conventions, pattern deviations, API style mismatches

## Issues in Your Changes (BLOCKING)

### HIGH

**Inconsistent class naming prefix: `Default*` vs codebase descriptive prefix convention** - `src/implementations/tmux/tmux-session-manager.ts:64`, `tmux-hooks.ts:170`, `tmux-validator.ts:43`
**Confidence**: 85%
- Problem: The three support classes use a `Default*` prefix (`DefaultTmuxSessionManager`, `DefaultTmuxHooks`, `DefaultTmuxValidator`), while the entire rest of the codebase uses descriptive prefixes that communicate the implementation strategy: `SQLite*`, `InMemory*`, `Structured*`, `Console*`, `File*`, `Priority*`, `FIFO*`, `System*`, `Buffered*`, `EventDriven*`. The `Default` prefix is not used by any other implementation in the project. Meanwhile, `TmuxConnector` itself does NOT use the prefix, creating an inconsistency even within the new module.
- Fix: Either drop the `Default` prefix entirely (making them `TmuxSessionManager` class implementing `TmuxSessionManager` interface -- would require renaming the interface, e.g. `TmuxSessionManagerPort`) or use a descriptive prefix that communicates implementation strategy. Since these are the only planned implementations and the interfaces already serve as the abstraction, the simplest approach would be to keep the current naming but document the deviation. Alternatively, align with the connector by removing `Default` and renaming interfaces to `*Port` (matching `TmuxConnectorPort`).

**Duplicate shell-escaping functions with inconsistent naming** - `src/implementations/tmux/tmux-hooks.ts:40`, `tmux-session-manager.ts:49`
**Confidence**: 92%
- Problem: Two functions perform single-quote escaping for shell embedding with different names and slightly different behavior:
  - `shellSingleQuote(s)` in tmux-hooks.ts: escapes AND wraps in surrounding quotes, returns `'escaped'`
  - `escapeSingleQuoted(value)` in tmux-session-manager.ts: escapes only the interior, callers add their own quotes
  
  The naming inconsistency (`shellSingleQuote` vs `escapeSingleQuoted`) obscures the behavioral difference. Both files are in the same package, so a shared utility is natural.
- Fix: Extract both into a shared `tmux-shell-utils.ts` module within the package. Keep both functions (they serve different purposes), but give them clearly differentiated names:
  ```typescript
  // tmux-shell-utils.ts
  /** Escapes single quotes for embedding inside an already-quoted string */
  export function escapeForSingleQuotes(s: string): string {
    return s.replace(/'/g, "'\\''");
  }
  /** Returns a complete single-quoted shell token */
  export function singleQuoteToken(s: string): string {
    return `'${escapeForSingleQuotes(s)}'`;
  }
  ```

### MEDIUM

**Inline POSIX env var regex duplicated within tmux-session-manager.ts** - `src/implementations/tmux/tmux-session-manager.ts:155`, `tmux-session-manager.ts:290`
**Confidence**: 88%
- Problem: The regex `/^[A-Za-z_][A-Za-z0-9_]*$/` for validating POSIX environment variable names appears twice in the same file (`injectEnvironment` at line 155 and `getSessionEnvironment` at line 290). The codebase's constants pattern (seen in types.ts with `TASK_ID_REGEX`, `SESSION_NAME_REGEX`, `SAFE_PATH_REGEX`) would apply here too.
- Fix: Extract to a named constant in `types.ts` or at the top of the file:
  ```typescript
  const POSIX_ENV_VAR_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;
  ```

**Integration test helper duplication with behavioral divergence** - `tests/integration/tmux/session-lifecycle.test.ts:13-37`, `sentinel-detection.test.ts:15-31`
**Confidence**: 85%
- Problem: `realExec()` and `isTmuxAvailable()` are copy-pasted across both integration test files. Worse, the implementations diverge: `session-lifecycle.test.ts:isTmuxAvailable()` includes a probe session check (lines 32-37) for CI robustness, while `sentinel-detection.test.ts:isTmuxAvailable()` only checks the version. This means one test is more resilient to CI environments than the other, which is a silent behavioral inconsistency.
- Fix: Extract a shared `tests/integration/tmux/test-helpers.ts` module with the more robust version (including the probe check) and import it in both test files.

**Inconsistent `Tmux` prefix on type names** - `src/implementations/tmux/types.ts`
**Confidence**: 80%
- Problem: Types exported from the tmux package follow two naming patterns: some have the `Tmux` prefix (TmuxSessionConfig, TmuxHandle, TmuxInfo, TmuxSessionInfo, TmuxSpawnConfig) and some do not (OutputMessage, CommunicationMode, WrapperConfig, WrapperManifest, StalenessConfig, ExecResult, ExecFn, SpawnCallbacks). The non-prefixed names are generic enough to collide in a larger codebase. No collisions exist today, but the inconsistency makes the API surface harder to reason about.
- Fix: This is a judgment call. Since the types live in a dedicated `tmux/` package and are re-exported through a barrel, the current approach is workable. If the project wants consistency, prefix all public types with `Tmux` (e.g., `TmuxOutputMessage`, `TmuxExecFn`, `TmuxSpawnCallbacks`). If not, document the convention that tmux-internal types omit the prefix.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`SpawnCallbacks` re-exported from two sources** - `src/implementations/tmux/tmux-connector.ts:38`, `src/implementations/tmux/index.ts:9`
**Confidence**: 82%
- Problem: `tmux-connector.ts` line 38 re-exports `SpawnCallbacks` from `types.js`, and then `index.ts` line 9 exports it from `tmux-connector.js`. This creates a re-export chain: `types.js -> tmux-connector.js -> index.ts`. The re-export in `tmux-connector.ts` exists so that `TmuxConnectorDeps` consumers can import `SpawnCallbacks` alongside the connector. However, `SpawnCallbacks` is a pure type from `types.ts` -- the barrel `index.ts` could export it directly from `types.js` instead, which would be more consistent with how all other types are exported.
- Fix: Remove line 38 from `tmux-connector.ts` and add `SpawnCallbacks` to the type-only block in `index.ts` (lines 18-37, from `./types.js`).

## Pre-existing Issues (Not Blocking)

_No pre-existing consistency issues found in the changed files._

## Suggestions (Lower Confidence)

- **`TmuxConnector` stores `deps` bag as a private field but also extracts functions** - `src/implementations/tmux/tmux-connector.ts:129-133` (Confidence: 65%) -- The constructor stores `deps` as a private readonly field (via `private readonly deps`) but also extracts `readFileSyncFn`, `readFileFn`, and `readdirSyncFn` to separate private fields. Other implementations in the codebase (e.g., `EventDrivenWorkerPool`) fully destructure deps in the constructor. Both patterns exist, but mixing them in one class is slightly unusual.

- **`dispose()` returns `void` while `killAll()` returns `Promise<Result<void>>`** - `src/implementations/tmux/types.ts:251` (Confidence: 70%) -- The existing `WorkerPool.killAll()` in `src/core/interfaces.ts:100` returns `Promise<Result<void>>`, while `TmuxConnectorPort.dispose()` returns `void`. Since both serve as shutdown methods, the inconsistency in return type style is worth noting. `dispose()` swallows errors internally (log-and-continue), which is a valid design but different from the Result-returning pattern used elsewhere.

- **No `as const` assertion on `SESSION_NOT_FOUND_PATTERNS` array** - `src/implementations/tmux/tmux-session-manager.ts:37` (Confidence: 62%) -- The codebase uses `as const` on sentinel constants like `SESSION_NAME_PREFIX` and sentinel filenames. The string array `SESSION_NOT_FOUND_PATTERNS` could benefit from `as const` for type narrowing, though it has no practical effect here since only `.some()` is called on it.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | - | 2 | 2 | - |
| Should Fix | - | - | 1 | - |
| Pre-existing | - | - | - | - |

**Consistency Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The tmux abstraction layer is well-structured and follows most project conventions correctly: Result types throughout, dependency injection via `*Deps` interfaces, proper JSDoc with design decision documentation, separation of types into a dedicated module, and barrel exports. The two HIGH-severity issues (naming prefix deviation and duplicate shell-escaping functions) are genuine consistency gaps that should be addressed before merge. The MEDIUM-severity issues are less urgent but would improve internal consistency within the new module itself.
