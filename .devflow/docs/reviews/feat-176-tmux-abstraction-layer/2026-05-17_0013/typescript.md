# TypeScript Review Report

**Branch**: feat-176-tmux-abstraction-layer -> main
**Date**: 2026-05-17

## Issues in Your Changes (BLOCKING)

### HIGH

**Missing session name validation on public methods** - `src/implementations/tmux/tmux-session-manager.ts:174,188,243`
**Confidence**: 90%
- Problem: `sendKeys()`, `isAlive()`, and `getSessionEnvironment()` are public methods on an exported class (`TmuxSessionManager` is re-exported from `index.ts`) but do not validate the `name` parameter against `SESSION_NAME_REGEX`. Only `createSession()` and `destroySession()` call `validateSessionName()`. Since `TmuxSessionManager` is part of the public API and can be used directly (not only through `TmuxConnector`), callers could pass arbitrary strings that get interpolated into shell commands via the `exec()` function.
- Fix: Add `validateSessionName` calls to `sendKeys`, `isAlive`, and `getSessionEnvironment`, or extract a private `execWithValidatedSession(name, cmd)` helper:

```typescript
sendKeys(name: string, keys: string): Result<void, AutobeatError> {
  const nameCheck = validateSessionName(name, 'sendKeys');
  if (!nameCheck.ok) return nameCheck;
  // ... rest of implementation
}

isAlive(name: string): Result<boolean, AutobeatError> {
  const nameCheck = validateSessionName(name, 'isAlive');
  if (!nameCheck.ok) return nameCheck;
  // ... rest of implementation
}

getSessionEnvironment(name: string, varName: string): Result<string | undefined, AutobeatError> {
  const nameCheck = validateSessionName(name, 'getSessionEnvironment');
  if (!nameCheck.ok) return nameCheck;
  // validate varName too:
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName)) {
    return err(tmuxSessionFailed('getSessionEnvironment', `Invalid variable name: ${varName}`, { varName }));
  }
  // ... rest of implementation
}
```

---

**Unvalidated `varName` parameter interpolated into shell command** - `src/implementations/tmux/tmux-session-manager.ts:244`
**Confidence**: 92%
- Problem: `getSessionEnvironment(name, varName)` interpolates `varName` directly into the exec string: `tmux show-environment -t ${name} ${varName}`. The `varName` parameter has no validation, yet it is injected into a shell command. While the `env` injection in `createSession()` properly validates keys against `/^[A-Za-z_][A-Za-z0-9_]*$/`, `getSessionEnvironment` does not apply the same check to `varName`.
- Fix: Apply the same POSIX env var name validation:

```typescript
getSessionEnvironment(name: string, varName: string): Result<string | undefined, AutobeatError> {
  const nameCheck = validateSessionName(name, 'getSessionEnvironment');
  if (!nameCheck.ok) return nameCheck;

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName)) {
    return err(tmuxSessionFailed('getSessionEnvironment', `Invalid variable name: "${varName}"`, { varName }));
  }

  const result = this.deps.exec(`tmux show-environment -t ${name} ${varName}`);
  // ...
}
```

### MEDIUM

**`JSON.parse(raw) as OutputMessage` uses type assertion instead of proper validation** - `src/implementations/tmux/tmux-connector.ts:285`
**Confidence**: 82%
- Problem: The code does `JSON.parse(raw) as OutputMessage` which is a type assertion (disables type checking). While the code immediately validates the required fields (lines 291-298) using `typeof` checks, the assertion still allows TypeScript to treat `parsed` as `OutputMessage` from line 285 onward — the runtime check on line 291 is not a type guard. If a future maintainer adds code between lines 285 and 291, they would access `parsed` as if it were fully typed.
- Fix: Parse into `unknown` first, then narrow:

```typescript
let parsed: unknown;
try {
  const raw = this.readFileSyncFn(filePath, 'utf8');
  parsed = JSON.parse(raw);
} catch {
  this.deps.logger.warn('Failed to parse output message file', { filePath });
  return;
}

if (
  typeof parsed !== 'object' || parsed === null ||
  typeof (parsed as Record<string, unknown>).sequence !== 'number' ||
  typeof (parsed as Record<string, unknown>).timestamp !== 'string' ||
  typeof (parsed as Record<string, unknown>).type !== 'string' ||
  typeof (parsed as Record<string, unknown>).content !== 'string'
) {
  this.deps.logger.warn('Output message missing required fields', { filePath });
  return;
}

const msg = parsed as OutputMessage; // Safe after full validation
```

Alternatively, use a Zod schema at this boundary (project principle: validate at boundaries with schemas).

---

**`deliveredSequences` Set grows unboundedly for long-running sessions** - `src/implementations/tmux/tmux-connector.ts:60,309`
**Confidence**: 80%
- Problem: `deliveredSequences: Set<number>` stores every sequence number ever delivered for deduplication. For a long-running agent that produces thousands of output messages, this set grows without limit. While `pendingMessages` has a `MAX_PENDING_MESSAGES` safety cap, `deliveredSequences` has no such bound.
- Fix: Since delivery is sequential (`nextExpectedSeq`), you only need to track the high-water mark for deduplication. Any sequence below `nextExpectedSeq` is by definition already delivered:

```typescript
// Replace deliveredSequences: Set<number> with just checking nextExpectedSeq:
// A message with sequence < nextExpectedSeq has already been delivered
if (msg.sequence < session.nextExpectedSeq) {
  // Already delivered, skip
  continue;
}
```

Or if you want to keep the set for robustness against out-of-order duplicates, prune it periodically (e.g., remove entries below `nextExpectedSeq - 100`).

---

**`TmuxSessionManager.createSession` returns hardcoded empty string for `sessionsDir`** - `src/implementations/tmux/tmux-session-manager.ts:139`
**Confidence**: 85%
- Problem: `createSession()` returns `{ sessionName: config.name, taskId: ..., sessionsDir: '' }` with `sessionsDir` hardcoded to an empty string. The `TmuxHandle` interface requires `sessionsDir: string` (the directory where session data lives), but `TmuxSessionManager` has no knowledge of it. This means anyone receiving a `TmuxHandle` from `createSession()` directly gets an invalid handle that cannot locate session data.
- Fix: Either accept `sessionsDir` as part of `TmuxSessionConfig` (it's already on the extended `TmuxSpawnConfig`) or remove `sessionsDir` from the return value since `TmuxSessionManager` operates at a lower abstraction level that doesn't know about session directories:

```typescript
// Option A: Accept sessionsDir in config (already available via TmuxSpawnConfig)
return ok({
  sessionName: config.name,
  taskId: config.name.replace(/^beat-/, ''),
  sessionsDir: config.sessionsDir ?? '',  // but TmuxSessionConfig doesn't have it
});

// Option B (recommended): TmuxSessionManager should return a simpler type
// and let TmuxConnector construct the full TmuxHandle
```

Note: `TmuxConnector.spawn()` (line 183-186) overrides the handle returned by `createSession` with the correct `sessionsDir`, so this is not a runtime bug in the current integration. But the type contract is misleading — `TmuxHandle.sessionsDir` promises meaningful data while `createSession` provides an empty string.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Missing `import type` annotations for type-only symbols in mixed imports** - `src/implementations/tmux/tmux-hooks.ts:19`, `src/implementations/tmux/tmux-validator.ts:11`, `src/implementations/tmux/tmux-session-manager.ts:15-21`
**Confidence**: 80%
- Problem: Several files import type-only symbols (`WrapperConfig`, `WrapperManifest`, `ExecFn`, `TmuxInfo`, `TmuxHandle`, `TmuxSessionConfig`, `TmuxSessionInfo`) alongside runtime values without using the inline `type` keyword. The connector file (`tmux-connector.ts:19`) correctly uses `import type { Logger }` for its type-only import from interfaces, showing awareness of the convention.
- Fix: Use inline type annotations for type-only imports within mixed import statements:

```typescript
// tmux-hooks.ts
import { SENTINEL_DONE, SENTINEL_EXIT, type WrapperConfig, type WrapperManifest } from './types.js';

// tmux-validator.ts
import { type ExecFn, type TmuxInfo } from './types.js';

// tmux-session-manager.ts
import {
  type ExecFn,
  MAX_CONCURRENT_SESSIONS,
  SESSION_NAME_REGEX,
  type TmuxHandle,
  type TmuxSessionConfig,
  type TmuxSessionInfo,
} from './types.js';
```

Note: This is not enforced by the current `tsconfig.json` (no `verbatimModuleSyntax`), so it is a documentation/style concern only. The connector file already follows this convention for Logger, making the omission in other files an inconsistency within the PR itself.

## Pre-existing Issues (Not Blocking)

None found.

## Suggestions (Lower Confidence)

- **Consider a narrower type for `OutputMessage.type`** - `src/implementations/tmux/types.ts:62` (Confidence: 70%) — The `type` field is declared as `'stdout' | 'stderr' | 'result'` but the runtime validation in `tmux-connector.ts:294` only checks `typeof parsed.type !== 'string'`. If a message arrives with `type: 'invalid'`, it would pass validation and be delivered with an unexpected type value. A type guard could verify membership in the union.

- **`WrapperConfig.agent` union could be extensible** - `src/implementations/tmux/types.ts:81` (Confidence: 65%) — Currently `agent: 'claude' | 'codex'` but the project supports multiple agents (Claude, Codex, Gemini, Ollama). Consider using a broader string literal union or extracting the agent type from the existing domain types.

- **Staleness logic resets `lastAliveCheck` only when `isAlive` returns true** - `src/implementations/tmux/tmux-connector.ts:189-214` (Confidence: 68%) — If `isAlive()` returns an error result (not `false` but an exec failure), `lastAliveCheck` is not reset. The condition `!isAlive` would be true for both "dead" and "exec error", potentially triggering a premature STALE signal after a transient tmux communication failure.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 3 | 0 |
| Should Fix | - | 0 | 1 | 0 |
| Pre-existing | - | - | 0 | 0 |

**TypeScript Score**: 8/10
**Recommendation**: CHANGES_REQUESTED

The implementation demonstrates strong TypeScript practices overall: no `any` types, proper Result types throughout, well-documented interfaces with JSDoc, discriminated union patterns via ErrorCode enum (consistent with project conventions per FEATURE_KNOWLEDGE), exhaustive dependency injection, and good use of `readonly`. The two HIGH issues relate to missing input validation on publicly-exported methods — session name and env var name validation is applied inconsistently (present on `createSession`/`destroySession` but absent on `sendKeys`/`isAlive`/`getSessionEnvironment`). The MEDIUM issues are type safety refinements that would improve maintainability. Applies PF-001 — all issues surfaced for resolution.
