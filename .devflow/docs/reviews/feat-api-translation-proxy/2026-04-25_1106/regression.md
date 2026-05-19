# Regression Review Report

**Branch**: feat/api-translation-proxy -> main
**Date**: 2026-04-25
**Diff**: `git diff b762591...HEAD` (incremental)

## Issues in Your Changes (BLOCKING)

### CRITICAL

_(none)_

### HIGH

_(none)_

### MEDIUM

_(none)_

## Issues in Code You Touched (Should Fix)

_(none)_

## Pre-existing Issues (Not Blocking)

_(none)_

## Suggestions (Lower Confidence)

_(none)_

## Analysis of Behavioral Changes

The following intentional behavioral changes were verified for regression safety:

### 1. Proxy gate widened from server-only to `!skipProxy` (DD1)

**Change**: `(options.mode ?? 'server') === 'server'` replaced with `!skipProxy`, where `skipProxy = mode === 'cli'`. This means proxy now starts in `run` mode in addition to `server` mode.

**Regression risk**: LOW. Both `run` mode callers (`src/cli/commands/run.ts:144` and `src/cli/commands/orchestrate.ts:382`) bootstrap with `mode: 'run'` and use `container.dispose()` for cleanup. The new `container.dispose()` path includes proxy shutdown (DD3), so proxy is always cleaned up. The `processSpawner` guard remains intact, ensuring test environments with mock spawners skip proxy startup. New tests at `bootstrap-proxy-integration.test.ts:203-240` verify run-mode startup, cli-mode skip, and dispose cleanup.

**Confidence**: 95% -- no regression. The gate widening is correctly scoped and all callers handle cleanup.

### 2. Proxy failure changed from warn-and-continue to fatal error (DD2)

**Change**: When proxy startup fails, bootstrap now returns `err(...)` instead of logging a warning and continuing with direct Anthropic API.

**Regression risk**: Evaluated and intentional. The old behavior (fallback to direct Anthropic API) was arguably incorrect: if the user configured `translate: 'openai'` with a third-party API key, falling back to direct Anthropic would fail with the wrong key/model and produce confusing errors downstream. The new fatal error includes remediation guidance (`beat agents config set claude translate ""`). This is a behavioral change that could surface as a new failure if someone had a flaky proxy target, but the error message is actionable. The `processSpawner` guard ensures tests are not affected.

**Confidence**: 92% -- intentional breaking change with correct rationale, not a regression.

### 3. Proxy cleanup added to `container.dispose()` (DD3)

**Change**: `Container.dispose()` now stops `proxyManager` before killing workers (step 4 of 9).

**Regression risk**: NONE. `ProxyManager.stop()` is documented as idempotent. The `container.get('proxyManager')` lookup returns `Err` when not registered (no proxy active), so the conditional check handles the no-proxy case. The `index.ts` shutdown handler manually stops proxy then calls `process.exit(0)` without calling `dispose()`, so there is no double-stop conflict in that path. The `run.ts` and `orchestrate.ts` paths use `dispose()` exclusively.

**Confidence**: 95% -- no regression. Idempotent cleanup, correct ordering.

### 4. `processNonStreamingResponse` return type changed from `boolean` to `void`

**Change**: The method previously returned `true` on success and `false` on error. Now it returns `void` (sends error responses directly).

**Regression risk**: NONE. The return value was never consumed by any caller. Both call sites (`handleBackendNonStreamingResponse:469` and `handleJsonFallback:570`) call the method as a statement, not checking the return value. The method was already sending error responses directly via `sendError()` in all error paths, making the boolean return redundant.

**Confidence**: 95% -- verified all call sites; return value was unused.

### 5. `SUPPORTED_TRANSLATE_TARGETS` renamed to `TRANSLATE_TARGETS` and centralized

**Change**: Local `const SUPPORTED_TRANSLATE_TARGETS = ['openai'] as const` in `agents.ts` removed. Replaced by exported `TRANSLATE_TARGETS` from `configuration.ts`. Both `agents.ts` CLI and `mcp-adapter.ts` MCP tool now import from the single source of truth.

**Regression risk**: NONE. Migration is complete -- zero references to `SUPPORTED_TRANSLATE_TARGETS` remain in the codebase. The runtime value is identical (`['openai']`). The `TranslateTarget` type is now derived from the constant (`(typeof TRANSLATE_TARGETS)[number]`), eliminating manual sync.

**Confidence**: 98% -- verified via codebase-wide search, no remaining references.

### 6. `PromptCacheMiddleware` shared state pattern

**Change**: `lastPrefixHash` moved from instance field to constructor-injected `PromptCacheState` object. `ProxyManager` creates one `PromptCacheState` and passes it to each per-request middleware instance via the factory.

**Regression risk**: NONE. The default constructor `new PromptCacheMiddleware()` creates its own isolated `{ lastPrefixHash: null }`, preserving backward compatibility. Existing tests that use the no-arg constructor continue to work unchanged. The change enables cross-request cache hit detection that was previously broken (each factory-created instance had its own `lastPrefixHash`, so cache hits were never detected across requests). New tests at `prompt-cache.test.ts:144-238` cover shared state, isolated state, and changed-prefix scenarios.

**Confidence**: 95% -- backward compatible default, correct shared-state wiring.

### 7. `openai-codec.ts` stream parser restructured

**Change**: Tool call delta processing logic restructured from flat `if/else if/else` to nested `if/else` with explicit `const pending = this.pendingToolCalls.get(tcIndex)`. `parseToolArguments` helper extracted.

**Regression risk**: NONE. This is a pure refactor -- the logic branches are identical, just reorganized for clarity. The `has()` + `get() as T` pattern was replaced with `get()` + `!== undefined` check, which is both safer and semantically identical. The `parseToolArguments` helper preserves the exact same try/catch behavior (malformed JSON returns `{}`).

**Confidence**: 95% -- logic-preserving restructure.

### 8. Test type corrections (`delta.type: 'text_delta'` to `text`)

**Change**: `middleware.test.ts` updated `makeStreamEvent` and assertions from `event.delta.type === 'text_delta' / event.delta.text` to `event.text`.

**Regression risk**: NONE. The tests were corrected to match the actual `ContentDeltaEvent` type in `ir.ts:183-186`, which defines `{ type: 'content_delta'; index: number; text: string }`. The old test shape (`delta: { type: 'text_delta', text }`) appears to be a pre-existing type mismatch that was either from an older API version or a test-only divergence. No source code references `delta.type === 'text_delta'` or `delta.text` anywhere in the translation layer.

**Confidence**: 92% -- tests now match the type system; old shape was incorrect.

### 9. `loadAgentConfig` translate validation widened

**Change**: `record.translate === 'openai'` hardcoded check replaced with `(TRANSLATE_TARGETS as readonly string[]).includes(record.translate as string)`.

**Regression risk**: NONE. For the current single-element array `['openai']`, the runtime behavior is identical. The new code is more maintainable -- adding a new translate target to `TRANSLATE_TARGETS` automatically makes it accepted by `loadAgentConfig` without a separate code change.

**Confidence**: 98% -- equivalent runtime behavior for current values.

## Regression Checklist

- [x] No exports removed without deprecation (SUPPORTED_TRANSLATE_TARGETS was local const, not exported)
- [x] Return types backward compatible (processNonStreamingResponse return was unused)
- [x] Default values unchanged (PromptCacheMiddleware default constructor preserved)
- [x] Side effects preserved (proxy cleanup now happens via dispose() in addition to manual paths)
- [x] All consumers of changed code updated (TRANSLATE_TARGETS migration complete)
- [x] Migration complete across codebase (0 references to old names)
- [x] CLI options preserved
- [x] API endpoints preserved
- [x] Commit messages match implementation
- [x] Breaking changes documented (DD1, DD2, DD3 DECISION comments in code)

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Regression Score**: 9/10
**Recommendation**: APPROVED

The three behavioral changes (proxy gate widened, proxy failure made fatal, proxy cleanup in dispose) are intentional, well-documented with DECISION comments, and have correct test coverage. The remaining changes are safe refactors (type centralization, code extraction, test corrections). No regressions detected.
