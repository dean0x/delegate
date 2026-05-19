# TypeScript Review Report

**Branch**: feat/api-translation-proxy -> main
**Date**: 2026-04-23

## Issues in Your Changes (BLOCKING)

### HIGH

**Stateful middleware shared across concurrent requests** - `src/translation/proxy/proxy-manager.ts:133-136`
**Confidence**: 85%
- Problem: `LoggingMiddleware` and `PromptCacheMiddleware` hold per-request mutable state (`requestStartTime`, `requestModel`, `lastPrefixHash`, `currentPrefixHash`, `currentPrefixTokens`) but are created once in `ProxyManager.start()` and shared across all concurrent requests handled by the `http.createServer` callback. If two Claude Code workers send requests simultaneously, the second request overwrites the first's state, causing incorrect elapsed time logging and wrong cache hit annotations.
- Fix: Create fresh middleware instances per request in `TranslationProxy.handleMessages()` rather than sharing them across the proxy lifetime, or document the concurrency limitation. Example:

```typescript
// In handleMessages(), build a per-request middleware stack:
const middlewares = [
  new ToolNameMappingMiddleware(),
  new PromptCacheMiddleware(),
  new LoggingMiddleware(this.config.logger),
];
```

Alternatively, make the middleware stateless by passing request context through a separate object (e.g., a request-scoped `Map` or context parameter).

### MEDIUM

**Non-null assertion on Map.get without guard** - `src/translation/codecs/openai-codec.ts:342`
**Confidence**: 88%
- Problem: `this.activeToolCalls.get(tcIndex)!` uses a non-null assertion. The `else` branch of the `if (!this.activeToolCalls.has(tcIndex))` check guarantees the key exists at entry, but the code above (lines 337-338) calls `this.activeToolCalls.delete(tcIndex)` then `this.activeToolCalls.set(this.currentContentIndex, toolCallData)` -- this means the map is re-keyed from the OpenAI `tcIndex` to the Anthropic `currentContentIndex`. If a *continuing* tool call delta arrives with the original `tcIndex` after re-keying, `has(tcIndex)` is false (new branch) but the tool call already started. The assertion would be safe in the normal flow, but a malformed stream could trigger `undefined`.
- Fix: Replace the assertion with an explicit guard:

```typescript
const existing = this.activeToolCalls.get(tcIndex);
if (!existing) continue; // Skip orphaned delta
```

**Unreachable dead code in tool_use mapping** - `src/translation/codecs/openai-codec.ts:150`
**Confidence**: 90%
- Problem: Line 138 filters to `c.type === 'tool_use'`, then line 140 re-checks `c.type === 'tool_use'`. The fallback return on line 150 (`return { id: '', type: 'function' as const, ... }`) is unreachable dead code since every element in the mapped array already passed the filter.
- Fix: Remove the redundant guard and use a type assertion or narrow once:

```typescript
assistantMsg.tool_calls = toolUses
  .filter((c): c is ToolUseContent => c.type === 'tool_use')
  .map((c) => ({
    id: c.id,
    type: 'function' as const,
    function: {
      name: c.name,
      arguments: JSON.stringify(c.input),
    },
  }));
```

**Missing exhaustive check in serialize switch** - `src/translation/codecs/anthropic-codec.ts:311`
**Confidence**: 82%
- Problem: `AnthropicStreamSerializer.serialize()` handles all 10 `CanonicalStreamEvent` discriminants but uses a bare `default: return []` instead of an exhaustive `never` check. If a new event type is added to the `CanonicalStreamEvent` union in `ir.ts`, the compiler will not flag the missing case -- the default silently swallows it.
- Fix: Replace the default with an exhaustive check:

```typescript
default: {
  const _exhaustive: never = event;
  return [];
}
```

**`translate` typed as open `string` instead of union** - `src/core/configuration.ts:234`
**Confidence**: 82%
- Problem: `AgentConfig.translate` is typed as `string` but only `'openai'` is currently supported. The `SUPPORTED_TRANSLATE_TARGETS` constant in `proxy-manager.ts:48` validates at runtime, but the type system allows any string value to flow through without a compile-time guard. Adding new targets requires remembering to update the runtime array.
- Fix: Define a union type and use it in both places:

```typescript
// In configuration.ts:
export type TranslateTarget = 'openai';
export interface AgentConfig {
  readonly translate?: TranslateTarget | string; // accept string for forward-compat but narrow in proxy-manager
}
```

Or, if strict typing is preferred across the codebase:
```typescript
export type TranslateTarget = 'openai';
export interface AgentConfig {
  readonly translate?: TranslateTarget;
}
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Inline structural type assertion in shutdown handler** - `src/index.ts:78`
**Confidence**: 83%
- Problem: `proxyManagerResult.value as { stop(): Promise<void> }` uses an inline structural type assertion rather than importing and casting to `ProxyManager`. The adjacent code for `scheduleExecutor` (line 71) uses the same pattern, so this is consistent with the existing style, but since `ProxyManager` is a concrete class now available from the translation module, a proper import would provide compile-time safety.
- Fix: Import `ProxyManager` and use a typed cast:

```typescript
import { ProxyManager } from './translation/proxy/proxy-manager.js';
// ...
const proxyManager = proxyManagerResult.value as ProxyManager;
await proxyManager.stop();
```

## Pre-existing Issues (Not Blocking)

No pre-existing CRITICAL issues found in reviewed files.

## Suggestions (Lower Confidence)

- **`server.address()` type assertion** - `src/translation/proxy/translation-proxy.ts:174` (Confidence: 70%) -- `server.address() as { port: number }` assumes the address is an object. After `listen(0, '127.0.0.1', ...)`, this is guaranteed to be an `AddressInfo` object (not `string | null`), but a defensive check would prevent a crash if the listen callback fires in an unexpected state.

- **`estimatePrefixTokens` counts both system and messages** - `src/translation/middleware/prompt-cache.ts:53-71` (Confidence: 65%) -- The function always counts the first N messages *in addition to* system blocks, but `hashPrefix()` only hashes system blocks when they exist (line 33). This means the token estimate may include messages that are not part of the hashed prefix, producing inaccurate cache hit annotations.

- **`LoggingMiddleware` import path uses absolute module path** - `src/translation/middleware/logging.ts:17` (Confidence: 60%) -- Import `from '../../translation/ir.js'` could be simplified to a relative `from '../ir.js'` since both files are within `src/translation/`. The current path works but is unnecessarily verbose.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 3 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**TypeScript Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The translation layer demonstrates strong TypeScript practices: no `any` types, proper discriminated unions for the canonical IR, `readonly` modifiers throughout, and Result types for fallible operations. The main concerns are the stateful middleware concurrency issue (HIGH), unreachable dead code, a non-null assertion, and a missing exhaustive switch check. The type safety of the `translate` config field could also be tightened. The codebase is otherwise well-typed with clear architectural documentation.
