# Consistency Review Report

**Branch**: feat/api-translation-proxy -> main
**Date**: 2026-04-23

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Inconsistent import path in LoggingMiddleware** - `src/translation/middleware/logging.ts:17`
**Confidence**: 95%
- Problem: Uses `../../translation/ir.js` (absolute-from-src path) while every other middleware file in the same directory uses `../ir.js` (relative path). Compare with `middleware.ts:15`, `tool-name-mapping.ts:15`, `prompt-cache.ts:20` which all use `../ir.js`.
- Fix:
```typescript
// Before
import type { CanonicalRequest, CanonicalResponse } from '../../translation/ir.js';
// After
import type { CanonicalRequest, CanonicalResponse } from '../ir.js';
```

**Inconsistent shutdown pattern: type assertion vs imported type** - `src/index.ts:78`
**Confidence**: 82%
- Problem: The proxyManager shutdown uses an inline type assertion `as { stop(): Promise<void> }` instead of importing the actual `ProxyManager` type. The scheduleExecutor above it uses the same inline assertion pattern (`as { stop(): unknown }`), but this is a pre-existing pattern. The new code follows that same pattern, which is internally consistent. However, the workerPool line (line 85) casts to the imported `WorkerPool` type. Adding new inline type assertions perpetuates this inconsistency rather than fixing it. Since you are the author of both the `ProxyManager` class and this shutdown code, the type could be imported directly.
- Fix: Import `ProxyManager` and use it directly, or accept the existing pattern as-is since this matches the adjacent `scheduleExecutor` cast. This is a minor consistency nit.

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

_No issues found._

## Suggestions (Lower Confidence)

- **Mutable state in LoggingMiddleware** - `src/translation/middleware/logging.ts:23-24` (Confidence: 65%) -- `requestStartTime` and `requestModel` are mutable instance fields that get overwritten per-request. This works correctly because TranslationProxy creates fresh middleware instances or the middleware is used per-proxy, but it violates the project-wide "immutable by default" principle from CLAUDE.md. Consider whether this is intentional (performance) or could use a per-request context object instead.

- **`PromptCacheMiddleware` mutable state without explicit lifecycle documentation** - `src/translation/middleware/prompt-cache.ts:77-79` (Confidence: 62%) -- Three mutable fields (`lastPrefixHash`, `currentPrefixHash`, `currentPrefixTokens`) accumulate state across requests. The class-level DECISION comment explains the approach, but the statefulness contracts (single-request-at-a-time assumption) are implicit. If the proxy ever handles concurrent requests, this would silently produce incorrect cache metrics.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | - | 0 | 0 | 0 |
| Pre-existing | - | - | 0 | 0 |

**Consistency Score**: 9/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Assessment

The new `src/translation/` module is remarkably consistent with the existing codebase:

1. **Result types** -- Used throughout all codec methods (`parseRequest`, `serializeRequest`, `parseResponse`, `serializeResponse`), `ProxyManager.start()`, `TranslationProxy.start()`, and `readBody()`. Matches the project-wide `Result<T>` pattern from `core/result.js`.

2. **Naming conventions** -- All files use camelCase for functions, PascalCase for classes/interfaces/types. `FormatCodec`, `StreamParser`, `StreamSerializer`, `CanonicalRequest`, `CanonicalResponse` all follow existing naming patterns (`TaskRepository`, `AgentAdapter`, `EventBus`).

3. **DECISION/ARCHITECTURE JSDoc comments** -- Present at all key decision points (codec separation rationale, middleware onion model, proxy HTTP-not-HTTPS exception, eager proxy startup, constructor-injected port). Matches the project convention documented in CLAUDE.md and pitfalls.

4. **Dependency injection** -- `Logger`, `FormatCodec`, `TranslationMiddleware` all injected via constructor. `ProxyManager` receives `ProxyConfig` + `Logger`. Consistent with the DI-everywhere pattern.

5. **Error handling** -- `logger.error(msg, error, context)` matches the `Logger` interface signature `error(message: string, error?: Error, context?: Record<string, unknown>)`. The `e instanceof Error ? e : undefined` guard in `translation-proxy.ts:159` is a correct pattern.

6. **Bootstrap integration** -- `container.registerValue('proxyManager', ...)` matches the existing pattern for non-singleton values. Proxy startup before agentRegistry follows the established dependency ordering pattern.

7. **Readonly types in IR** -- All IR types use `readonly` on every field. Matches the project's "immutable by default" principle.

8. **Test organization** -- New `test:translation` script follows the exact pattern of existing grouped suites (`test:core`, `test:handlers`, etc.) with `NODE_OPTIONS='--max-old-space-size=2048'` and `--no-file-parallelism`.

9. **Configuration extension** -- `AgentConfig.translate`, `saveAgentConfig` key union, CLI commands, MCP tools all extended symmetrically with existing `apiKey`/`baseUrl`/`model` patterns.

The only blocking issue is the import path inconsistency in `logging.ts`, which is trivially fixable.
