# Consistency Review Report

**Branch**: feat-176-tmux-abstraction-layer -> main
**Date**: 2026-05-17

## Issues in Your Changes (BLOCKING)

### HIGH

**Deps interface properties missing `readonly` modifiers** - `src/implementations/tmux/tmux-connector.ts:35-43`, `src/implementations/tmux/tmux-hooks.ts:24-28`
**Confidence**: 88%
- Problem: `TmuxConnectorDeps` and `TmuxHooksDeps` define interface properties without `readonly` modifiers. Every other `*Deps` interface in the codebase (`EventDrivenWorkerPoolDeps`, `TaskManagerServiceDeps`, `WorkerHandlerDeps`, `LoopHandlerDeps`, etc.) uses `readonly` on all properties. This is the established DI contract pattern.
- Fix: Add `readonly` to all properties in both interfaces:
```typescript
// TmuxConnectorDeps
export interface TmuxConnectorDeps {
  readonly sessionManager: TmuxSessionManager;
  readonly hooks: TmuxHooks;
  readonly validator: TmuxValidator;
  readonly logger: Logger;
  readonly watch: WatchFn;
  readonly readFileSync?: (path: string, encoding: BufferEncoding) => string;
}

// TmuxHooksDeps
export interface TmuxHooksDeps {
  readonly writeFile: (filePath: string, content: string, opts: { mode: number }) => void;
  readonly mkdirSync: (dirPath: string, opts: { recursive: boolean; mode: number }) => void;
  readonly rmSync: (dirPath: string, opts: { recursive: boolean; force: boolean }) => void;
}
```

### MEDIUM

**TmuxSessionManager and TmuxValidator use inline anonymous deps types instead of named interfaces** - `src/implementations/tmux/tmux-session-manager.ts:72`, `src/implementations/tmux/tmux-validator.ts:40`
**Confidence**: 82%
- Problem: `TmuxSessionManager` uses `private readonly deps: { exec: ExecFn; maxConcurrentSessions?: number }` and `TmuxValidator` uses `private readonly deps: { exec: ExecFn }`. The codebase convention is to declare a named exported `*Deps` interface (as `TmuxConnectorDeps` and `TmuxHooksDeps` already do). Named interfaces allow consumers to construct deps objects by type reference, improving test ergonomics and documentation.
- Fix: Extract named interfaces:
```typescript
// In tmux-session-manager.ts
export interface TmuxSessionManagerDeps {
  readonly exec: ExecFn;
  readonly maxConcurrentSessions?: number;
}

// In tmux-validator.ts
export interface TmuxValidatorDeps {
  readonly exec: ExecFn;
}
```

**Type/implementation mismatch: `cwd` is required in type but treated as optional** - `src/implementations/tmux/types.ts:17`, `src/implementations/tmux/tmux-session-manager.ts:99`
**Confidence**: 85%
- Problem: `TmuxSessionConfig` declares `cwd: string` (required, non-optional), but `createSession` has `const cwdFlag = config.cwd ? ... : ''` which treats it as possibly empty/undefined. The unit test at `tests/unit/implementations/tmux/tmux-session-manager.test.ts:66` also destructures it away and passes a config without `cwd`. This is inconsistent within the new module itself.
- Fix: Either make the type match reality by marking `cwd` optional (`cwd?: string`) or remove the truthy check and always pass `-c`:
```typescript
// Option A: Make type optional (recommended — aligns with test expectations)
export interface TmuxSessionConfig {
  name: string;
  command: string;
  cwd?: string;  // optional — session uses default tmux dir when unset
  env?: Record<string, string>;
  width?: number;
  height?: number;
}
```

**`TmuxSessionManager.createSession` returns `TmuxHandle` with empty `sessionsDir`** - `src/implementations/tmux/tmux-session-manager.ts:139`
**Confidence**: 80%
- Problem: `createSession()` returns `ok({ sessionName: config.name, taskId: ..., sessionsDir: '' })` with an empty string for `sessionsDir`. The `TmuxHandle` type contract declares `sessionsDir` as `string` with a doc comment "Base directory where session data (sentinel, messages) lives" — an empty string violates this semantic contract. While the TmuxConnector overwrites this field, having a lower-level API return a semantically invalid handle is inconsistent with the codebase's "parse at boundaries, trust internally" principle.
- Fix: Either (a) accept `sessionsDir` as an optional field on `TmuxSessionConfig` so it can be passed through, (b) make `TmuxHandle.sessionsDir` optional with `?`, or (c) have `TmuxSessionManager.createSession` return a narrower type (e.g., `TmuxSessionRef { sessionName, taskId }`) without the `sessionsDir` field, and let the connector compose the full `TmuxHandle`.

## Issues in Code You Touched (Should Fix)

_(None found)_

## Pre-existing Issues (Not Blocking)

_(None found)_

## Suggestions (Lower Confidence)

- **Async method with no awaits** - `src/implementations/tmux/tmux-connector.ts:85` (Confidence: 65%) — `spawn()` is declared `async` returning `Promise<Result<...>>` but contains no `await` expressions. The existing `WorkerPool.spawn` is also async so this follows precedent, but it may cause confusion for callers who expect the Promise to represent actual async work. Consider returning `Result<...>` directly if no future async operations are planned.

- **Import type consistency within tmux module** - `src/implementations/tmux/tmux-connector.ts:24` (Confidence: 62%) — The connector uses `import type { Logger }` for the Logger interface but imports `OutputMessage`, `StalenessConfig`, `TmuxHandle`, `TmuxSpawnConfig` as value imports despite them being used only as type annotations. Since the tsconfig does not enforce `verbatimModuleSyntax` this compiles fine but is internally inconsistent within the same file.

- **TmuxSessionManager `taskId` derivation via string manipulation** - `src/implementations/tmux/tmux-session-manager.ts:115,138` (Confidence: 68%) — `config.name.replace(/^beat-/, '')` is used twice to derive a taskId from the session name. The `TmuxSessionConfig` does not include a `taskId` field (unlike `TmuxSpawnConfig`), so the session manager derives it by convention. If the session name ever diverges from `beat-{taskId}` this breaks silently.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 3 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Consistency Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The new tmux module follows the codebase's core patterns well: Result types for all fallible operations, AutobeatError factories with ErrorCode enum, dependency injection via constructor, kebab-case filenames, `ok(undefined)` for void results, and `import type` for the Logger interface. The deviations are minor (missing `readonly` on deps interfaces, inline anonymous types vs named interfaces, a type/implementation mismatch on `cwd`). None are blocking but the `readonly` modifiers should be added to maintain the DI contract pattern consistently. Applies PF-001 — all issues surfaced rather than deferred.
