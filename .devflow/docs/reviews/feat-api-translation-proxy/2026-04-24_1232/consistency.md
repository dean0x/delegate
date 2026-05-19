# Consistency Review Report

**Branch**: feat/api-translation-proxy -> main
**Date**: 2026-04-24

## Issues in Your Changes (BLOCKING)

### HIGH

**Test factory constructs invalid type structure (9 occurrences)** - `tests/unit/translation/middleware/middleware.test.ts:35`
**Confidence**: 95%
- Problem: `makeStreamEvent()` constructs `{ type: 'content_delta', index: 0, delta: { type: 'text_delta', text } }` but `ContentDeltaEvent` in `src/translation/ir.ts:183-187` is `{ type: 'content_delta', index: number, text: string }` -- the IR type has a flat `text` property, not a nested `delta.text` structure. The `delta` property does not exist on `ContentDeltaEvent`. This was confirmed with a targeted typecheck that produced 9 TS2339/TS2353 errors on lines 35, 63, 64, 133, 134, 177, 178. The project tsconfig excludes `tests/` so `npm run typecheck` does not catch this.
- Impact: The `makeStreamTagger` middleware tagger reads/writes `event.delta.text` which does not match the real middleware contract. If middleware tests pass, it is because the JavaScript runtime allows extra properties, but the test assertions are not exercising the actual `ContentDeltaEvent.text` field -- they test a shape that no real event would have.
- Fix: Change `makeStreamEvent` and all taggers/assertions to use the flat `text` property:
  ```typescript
  function makeStreamEvent(text: string): CanonicalStreamEvent {
    return { type: 'content_delta', index: 0, text };
  }

  // In makeStreamTagger:
  if (event.type === 'content_delta') {
    return { ...event, text: `${event.text}:${tag}` };
  }

  // In assertions:
  if (result?.type === 'content_delta') {
    expect(result.text).toBe('hello:C:B:A');
  }
  ```

**Stale JSDoc references removed constant** - `src/core/configuration.ts:232`
**Confidence**: 92%
- Problem: The JSDoc for `TranslateTarget` says "Single source of truth -- kept in sync with SUPPORTED_TRANSLATE_TARGETS in proxy-manager.ts" but this PR removed `SUPPORTED_TRANSLATE_TARGETS` from `proxy-manager.ts`. The comment now references a non-existent artifact, which is misleading and will confuse future contributors.
- Fix: Update the JSDoc to reference the actual locations:
  ```typescript
  /**
   * Supported API translation targets.
   * Single source of truth — runtime validation uses this type at load boundaries
   * (CLI: agents.ts SUPPORTED_TRANSLATE_TARGETS, MCP: mcp-adapter.ts z.enum).
   * Empty string is the "clear" sentinel accepted at save boundaries (CLI, MCP).
   */
  ```

### MEDIUM

**Translate target defined in three separate places without shared constant** - `src/core/configuration.ts:235`, `src/cli/commands/agents.ts:23`, `src/adapters/mcp-adapter.ts:351`
**Confidence**: 82%
- Problem: The valid translate targets are independently defined in three locations: (1) `TranslateTarget` type in configuration.ts, (2) `SUPPORTED_TRANSLATE_TARGETS` array in agents.ts, (3) `z.enum(['openai', ''])` in mcp-adapter.ts. When a new translate target is added (e.g., 'gemini'), all three must be updated manually. The project pattern (CLAUDE.md) emphasizes single source of truth.
- Fix: Export the `SUPPORTED_TRANSLATE_TARGETS` array from `configuration.ts` alongside the type, and derive the MCP schema and CLI validation from it:
  ```typescript
  // configuration.ts
  export const SUPPORTED_TRANSLATE_TARGETS = ['openai'] as const;
  export type TranslateTarget = (typeof SUPPORTED_TRANSLATE_TARGETS)[number];
  ```
  Then import and use in both agents.ts and mcp-adapter.ts.

**`processNonStreamingResponse` return value never consumed** - `src/translation/proxy/translation-proxy.ts:381`
**Confidence**: 85%
- Problem: `processNonStreamingResponse` is documented as returning `boolean` ("Returns true on success, false if an error response was already sent"), but the return value is unused at both call sites (line 467 and line 532). The codebase consistently uses Result types for success/failure signaling. A boolean return that is never checked is dead code and inconsistent with the project's error-handling pattern.
- Fix: Change return type to `void` since callers do not use the result, and the method already sends error responses internally:
  ```typescript
  private processNonStreamingResponse(
    rawBody: string,
    res: http.ServerResponse,
    middlewares: readonly TranslationMiddleware[],
  ): void {
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`StreamTranslator.applyMiddleware` duplicates `runStreamEventMiddleware` logic** - `src/translation/proxy/stream-translator.ts:100-110`
**Confidence**: 80%
- Problem: The `applyMiddleware` private method reimplements the same loop as `runStreamEventMiddleware()` from `middleware.ts:48-59`, but uses the pre-reversed array. The DECISION comment at line 21 justifies this as a performance optimization. However, `runStreamEventMiddleware` is now only called in tests (the middleware.test.ts file), never in production code -- meaning two implementations exist for the same contract. If the middleware contract changes (e.g., adding an async variant), the inline copy would be missed.
- Impact: Low immediate risk since both implementations are simple and correct. But the shared function becomes dead production code, which contradicts the project's preference for no dead code.
- Fix: Either (a) make `runStreamEventMiddleware` accept a pre-reversed array option to avoid the allocation, or (b) document in `middleware.ts` that `runStreamEventMiddleware` is a reference implementation used only by tests, with production using `StreamTranslator.applyMiddleware`.

## Pre-existing Issues (Not Blocking)

No pre-existing consistency issues found in the changed files.

## Suggestions (Lower Confidence)

- **Bootstrap proxy-only guard could use Mode type** - `src/bootstrap.ts:382` (Confidence: 65%) -- The condition `(options.mode ?? 'server') === 'server'` is a string comparison. The project already defines Mode as a union type; using a dedicated `isServerMode()` helper would be more consistent with how other mode checks work elsewhere in bootstrap.

- **Test helper `makeStreamEvent` naming** - `tests/unit/translation/middleware/middleware.test.ts:34` (Confidence: 62%) -- The function name `makeStreamEvent` is generic but only creates `content_delta` events. Other test files use more specific names like `makeRequest()` with type parameters. Consider `makeContentDelta(text)` for clarity.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | - | 2 | 2 | - |
| Should Fix | - | - | 1 | - |
| Pre-existing | - | - | - | - |

**Consistency Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The main issues are: (1) the new middleware test file constructs stream events with a `delta` property that does not exist on the canonical IR type, causing 9 TypeScript errors when checked independently -- the tests validate a shape that no real event would have; (2) stale documentation referencing a removed constant; and (3) triple-definition of translate targets without a shared source of truth. The code changes themselves (middlewareFactory, extracted helpers, exhaustive switch) are well-documented with DECISION/ARCHITECTURE comments and follow the project's patterns well.
