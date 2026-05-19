# TypeScript Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17

## Issues in Your Changes (BLOCKING)

### HIGH

**Missing `import type` for type-only imports in tmux-connector.ts** - `src/implementations/tmux/tmux-connector.ts:23-33`
**Confidence**: 82%
- Problem: The import from `./types.js` pulls in `OutputMessage`, `StalenessConfig`, `TmuxHandle`, `TmuxHooks`, `TmuxSessionInfo`, `TmuxSessionManager`, `TmuxSpawnConfig`, and `TmuxValidator` as value imports. All of these are interfaces or type aliases used only in type positions (annotations, type parameters, type guards). Only `DEFAULT_STALENESS_CONFIG` is used as a runtime value and is correctly imported as a value. The codebase already uses `import type` in 164 locations (e.g., `import type { Logger }` on line 21 of the same file), establishing a convention.
- Fix: Split the import into type-only and value imports:
```typescript
import type {
  OutputMessage,
  StalenessConfig,
  TmuxHandle,
  TmuxHooks,
  TmuxSessionInfo,
  TmuxSessionManager,
  TmuxSpawnConfig,
  TmuxValidator,
} from './types.js';
import { DEFAULT_STALENESS_CONFIG } from './types.js';
```
The same pattern should be applied in `tmux-hooks.ts` (lines 19-28), `tmux-session-manager.ts` (lines 15-23), and `tmux-validator.ts` (line 11).

### MEDIUM

**Duplicated agent type literal union instead of reusing `AgentProvider`** - `src/implementations/tmux/types.ts:38,93`
**Confidence**: 85%
- Problem: Both `TmuxSpawnConfig.agent` and `WrapperConfig.agent` define the inline literal union `'claude' | 'codex'`. The project already has a canonical `AgentProvider = 'claude' | 'codex' | 'gemini'` in `src/core/agents.ts`. While the tmux layer currently only supports two agents, duplicating the literal set creates a maintenance risk: when a new agent is added to `AgentProvider`, both tmux definitions must be updated independently.
- Fix: Extract a tmux-specific type derived from the canonical one:
```typescript
import type { AgentProvider } from '../../core/agents.js';
/** Agent types supported by the tmux runtime */
export type TmuxAgentType = Extract<AgentProvider, 'claude' | 'codex'>;
```
Then use `TmuxAgentType` in both `TmuxSpawnConfig` and `WrapperConfig`. This keeps the relationship explicit and lets the compiler flag when the subset falls out of sync with the superset.

**Unsafe tuple assertion in `listSessions`** - `src/implementations/tmux/tmux-session-manager.ts:229`
**Confidence**: 83%
- Problem: `parts as [string, string, string, string, string]` is a type assertion that bypasses the compiler's type narrowing. While the `parts.length < 5` guard on line 227 makes the assertion safe at runtime, the assertion itself tells TypeScript to trust the developer rather than proving correctness through the type system.
- Fix: Use indexed access instead, which respects the `string | undefined` return type of array indexing and avoids the assertion:
```typescript
const name = parts[0];
const createdStr = parts[1];
const attachedStr = parts[2];
const widthStr = parts[3];
const heightStr = parts[4];
if (!name || !createdStr || !attachedStr || !widthStr || !heightStr) continue;
```
This makes the length guard redundant and eliminates the assertion. (Note: without `noUncheckedIndexedAccess` enabled, the current code is safe from TS's perspective too; this is a robustness improvement.)

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

_No issues found._

## Suggestions (Lower Confidence)

- **`VALID_OUTPUT_TYPES` could use `Set<OutputMessage['type']>` instead of `Set<string>`** - `src/implementations/tmux/tmux-connector.ts:48` (Confidence: 70%) -- Using the literal type from the interface ties the validation set to the type definition, so adding a new variant to `OutputMessage.type` would produce a compiler error if the set wasn't updated.

- **`TmuxInfo.path` hardcodes `'tmux'` instead of resolving the actual binary path** - `src/implementations/tmux/tmux-validator.ts:98` (Confidence: 65%) -- The `TmuxInfo` interface declares `path: string` suggesting a resolved path, but the implementation always returns the literal `'tmux'`. Either the field should be typed as `'tmux'` (const literal) or the implementation should resolve the path via `command -v tmux` (similar to how `jqPath` is resolved).

- **Consider narrowing `injectEnvironment` return to `Result` instead of `void`** - `src/implementations/tmux/tmux-session-manager.ts:120` (Confidence: 62%) -- The method is best-effort and silently discards the exec result. Since the project convention is Result types for all fallible operations, even best-effort operations could return `Result<void, AutobeatError>` to let callers decide whether to log or ignore the failure.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**TypeScript Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The tmux abstraction layer demonstrates strong TypeScript practices overall. The type system is used well: discriminated union `Result<T, E>` throughout, explicit return types on all methods, proper `unknown` handling with a runtime type guard (`isOutputMessage`), well-typed interfaces for dependency injection, and zero `any` types. The non-null assertions (`!`) are limited to two locations where safety is provable from surrounding control flow. The interfaces are clean and well-designed for consumers. The conditions for approval are minor: adopting `import type` consistently and extracting the duplicated agent literal union into a shared type.
