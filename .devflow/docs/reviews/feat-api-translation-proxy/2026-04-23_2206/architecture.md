# Architecture Review Report

**Branch**: feat/api-translation-proxy -> main
**Date**: 2026-04-23

## Issues in Your Changes (BLOCKING)

### HIGH

**LoggingMiddleware holds mutable per-request state but is shared across requests** - `src/translation/middleware/logging.ts:23-24`
**Confidence**: 90%
- Problem: `LoggingMiddleware` stores `requestStartTime` and `requestModel` as instance fields (lines 23-24). However, `ProxyManager` creates a single instance (line 136 of `proxy-manager.ts`) and passes it in the `middlewares` array shared across all proxy requests. If two requests overlap (concurrent Claude Code workers), the second `processRequest` overwrites the first's `requestStartTime`, causing the first response's `elapsedMs` to be incorrect.
- Impact: Incorrect observability metrics under concurrent load. Not a data corruption risk, but violates the architecture principle of stateless middleware instances for shared pipelines.
- Fix: Make `LoggingMiddleware` stateless by using a request-scoped context. Two options:
  1. Create a new `LoggingMiddleware` instance per request (adjust `TranslationProxy` to clone middleware per handler invocation).
  2. Use a `WeakMap` keyed on request identity or pass timing through the canonical request metadata.

**PromptCacheMiddleware holds mutable cross-request state but is shared across concurrent requests** - `src/translation/middleware/prompt-cache.ts:77-79`
**Confidence**: 90%
- Problem: Same pattern as LoggingMiddleware. `lastPrefixHash`, `currentPrefixHash`, and `currentPrefixTokens` are instance fields that get overwritten by concurrent requests. This corrupts cache-hit detection when multiple workers send requests simultaneously.
- Impact: False cache-hit/miss annotations on concurrent requests.
- Fix: Same approach as LoggingMiddleware — either create per-request instances or use a request-scoped context map.

**ToolNameMappingMiddleware shared across concurrent requests with mutable per-request maps** - `src/translation/middleware/tool-name-mapping.ts:33-35`
**Confidence**: 90%
- Problem: `reverseMap` and `forwardMap` are instance fields populated during `processRequest` and consumed during `processResponse`/`processStreamEvent`. When shared across concurrent requests, one request's tool name mappings bleed into another's. If Request A has long tool names and Request B does not, Request B's response could incorrectly trigger reverse-mapping from Request A's state.
- Impact: Tool name corruption under concurrent load — a response could return the wrong tool name, causing Claude Code to fail to match tool results.
- Fix: This middleware must be per-request. Create fresh middleware instances for each request in `TranslationProxy.handleMessages()`.

### MEDIUM

**ProxyManager registered in container only on success path, but shutdown accesses it unconditionally** - `src/bootstrap.ts:380` / `src/index.ts:76-80`
**Confidence**: 85%
- Problem: In `bootstrap.ts`, `proxyManager` is only registered in the container when `proxyResult.ok` is true (line 380). In `index.ts`, the shutdown handler accesses `container?.get('proxyManager')` (line 76). If the proxy fails to start, `container.get('proxyManager')` returns an error result, which is handled correctly (`proxyManagerResult?.ok` is false). However, if `options.processSpawner` is set (test mode), the proxy code is skipped entirely, so the key is never registered. This is consistent because shutdown is also test-aware. The issue is that `proxyManager` is not a typed container registration (no interface/type guard), making it easy to introduce errors if other code later attempts to resolve it.
- Impact: Minor typing gap. Not a runtime bug currently, but fragile for future maintenance.
- Fix: Consider defining a `ProxyManager` container key type in the container interface, or document the optional registration pattern with a comment.

**`translate` field on AgentConfig lacks validation for supported values** - `src/core/configuration.ts:251`
**Confidence**: 82%
- Problem: `loadAgentConfig` reads `translate` as any string. `loadProxyConfig` in `proxy-manager.ts` validates against `SUPPORTED_TRANSLATE_TARGETS`, but `saveAgentConfig` accepts any string value without validation. A user could `beat agents config set claude translate gemini` and get no error, but the proxy would silently not start (returning `null` from `loadProxyConfig`).
- Impact: Poor user feedback — invalid translate values are silently ignored at boot time. The CLI `agents.ts` warns about missing `baseUrl`/`apiKey`/`model` but not about invalid `translate` values.
- Fix: Add validation in `saveAgentConfig` or in the CLI `agentsConfigSet` for the `translate` key:
  ```typescript
  if (key === 'translate' && value !== '' && !['openai'].includes(value)) {
    ui.error(`Unsupported translate target: "${value}". Supported: openai`);
    process.exit(1);
  }
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Bootstrap async operation before container factory registration creates temporal coupling** - `src/bootstrap.ts:373-388`
**Confidence**: 80%
- Problem: The proxy startup (`await proxyManager.start()`) runs in the middle of synchronous container registration, between `taskQueue` and `agentRegistry`. This creates a temporal dependency: the `agentRegistry` factory captures `proxyPort` from the enclosing scope (line 406), which is a local `let` variable set by the async proxy start. While this works correctly, it breaks the existing pattern where all container registrations are synchronous factory functions. The bootstrap function was previously purely registration-then-resolve; now it has an interleaved async side effect.
- Impact: Increases cognitive complexity of bootstrap. Future developers may not realize that moving the `agentRegistry` registration before the proxy section would cause `proxyPort` to always be `undefined`.
- Fix: Document the ordering dependency with a comment (partially done), or extract the proxy start into a post-registration phase similar to how `scheduleExecutor` and `recoveryManager` are handled. Example: register a lazy `proxyManager` factory, then resolve it after all registrations.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Container lacks type-safe registration — all keys are stringly-typed** - `src/bootstrap.ts` (throughout)
**Confidence**: 85%
- Problem: Container registrations use string keys (`'proxyManager'`, `'taskManager'`, etc.) with no compile-time guarantee that the resolved type matches the registered type. The `proxyManager` registration (line 380) follows this existing pattern, but the pattern itself is a pre-existing architectural weakness.
- Impact: Runtime type errors possible if a key is misspelled or a type assertion is wrong.

## Suggestions (Lower Confidence)

- **Codec interface has unused methods by design** - `src/translation/codec.ts:44-53` (Confidence: 70%) — `FormatCodec` defines `parseRequest`, `serializeRequest`, `parseResponse`, `serializeResponse` but each codec only implements half (source vs target). The unused methods throw or return errors. This is ISP-adjacent: the interface could be split into `SourceCodec` and `TargetCodec`, but the current design trades ISP purity for future extensibility (reverse proxy support). Acceptable trade-off given the documented intent.

- **TranslationProxy is a 603-line file handling HTTP, streaming, error mapping, and body parsing** - `src/translation/proxy/translation-proxy.ts` (Confidence: 65%) — Approaches god-class territory by SRP standards. The helpers (`readBody`, `sendError`, `stripAnthropicHeaders`, `buildErrorResponse`, `mapStatusToErrorType`) are file-scoped functions, not methods, which is a reasonable mitigation. The class itself has 3 methods (`handleRequest`, `handleMessages`, `handleCountTokens`) plus streaming/non-streaming branches. Currently manageable but worth monitoring as the feature evolves.

- **Hardcoded `/v1/chat/completions` path assumes OpenAI-compatible API structure** - `src/translation/proxy/translation-proxy.ts:318` (Confidence: 60%) — The target endpoint path is hardcoded. If a future translation target uses a different path, this would need to become configurable. Low risk given "openai" is the only supported target.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 3 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Architecture Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The translation proxy layer demonstrates strong architectural fundamentals: clean IR-based codec pattern (Strategy), middleware pipeline (Chain of Responsibility), proper dependency injection through bootstrap, and correct layer separation (IR never imports codecs; codecs never import each other). The `ProxiedClaudeAdapter` inheritance is minimal and well-scoped to a single method override.

The blocking issues are all instances of the same root cause: stateful middleware instances shared across concurrent requests. This is a concurrency bug pattern that will manifest when multiple Claude Code workers send API requests simultaneously. The fix is straightforward — create middleware instances per request rather than per proxy lifetime.
