# Complexity Review Report

**Branch**: feat/api-translation-proxy -> main
**Date**: 2026-04-24

## Issues in Your Changes (BLOCKING)

### HIGH

**`handleNonStreamingRequest` remains a 76-line method with 5-level nesting inside a Promise+callback+event chain** - `src/translation/proxy/translation-proxy.ts:417-492`
**Confidence**: 85%
- Problem: Although response processing was extracted into `processNonStreamingResponse`, the remaining `handleNonStreamingRequest` method is still 76 lines with deep nesting: method -> Promise -> requestFn callback -> backendRes events -> conditional branches. The callback-within-a-Promise pattern forces 4-5 indent levels. The `handleStreamingRequest` method (lines 593-673, ~80 lines) has the same structural issue but was improved more aggressively in this PR by extracting `handleStreamingError`, `handleJsonFallback`, and `handleSseStream` — the non-streaming handler was not given the same treatment.
- Fix: Extract the `requestFn` callback body into a dedicated method (e.g., `handleBackendResponse`) that receives `backendRes`, `res`, `middlewares`, `responseTimeout`, and `resolve`. This flattens the nesting by one level and brings the method body below 50 lines:

```typescript
private handleBackendNonStreamingResponse(
  backendRes: http.IncomingMessage,
  res: http.ServerResponse,
  middlewares: readonly TranslationMiddleware[],
  responseTimeout: ReturnType<typeof setTimeout>,
  resolve: () => void,
): void {
  const statusCode = backendRes.statusCode ?? 500;
  if (statusCode >= 400) {
    const errChunks: Buffer[] = [];
    backendRes.on('data', (chunk: Buffer) => errChunks.push(chunk));
    backendRes.on('end', () => {
      clearTimeout(responseTimeout);
      const backendMessage = extractBackendErrorMessage(errChunks);
      sendError(res, statusCode, mapStatusToErrorType(statusCode), backendMessage);
      resolve();
    });
    return;
  }
  const chunks: Buffer[] = [];
  backendRes.on('data', (chunk: Buffer) => chunks.push(chunk));
  backendRes.on('end', () => {
    clearTimeout(responseTimeout);
    this.processNonStreamingResponse(Buffer.concat(chunks).toString(), res, middlewares);
    resolve();
  });
}
```

### MEDIUM

**`processToolCallDeltas` has 3-branch if/else-if/else with nested conditionals reaching 4 indent levels** - `src/translation/codecs/openai-codec.ts:307-368`
**Confidence**: 82%
- Problem: The method is 62 lines with a 3-way branching structure (`openaiToCanonicalIndex.has` / `pendingToolCalls.has` / new), where two of the branches contain further nested `if` blocks for promoting pending calls or immediately starting them. The deepest nesting is 5 levels (for loop -> if/else-if/else -> if). This is inherent complexity from the OpenAI streaming protocol state machine, but the three branches could be named for clarity.
- Fix: Extract each branch into a private method to make the state transitions self-documenting:

```typescript
private processToolCallDeltas(toolCalls: Array<Record<string, unknown>>): CanonicalStreamEvent[] {
  const events: CanonicalStreamEvent[] = [];
  for (const tc of toolCalls) {
    const tcIndex = tc['index'] as number;
    const func = tc['function'] as Record<string, unknown> | undefined;
    const tcId = tc['id'] as string | undefined;
    const tcName = func?.['name'] as string | undefined;
    const tcArgs = func?.['arguments'] as string | undefined;

    if (this.openaiToCanonicalIndex.has(tcIndex)) {
      events.push(...this.accumulateStartedToolCall(tcIndex, tcArgs));
    } else if (this.pendingToolCalls.has(tcIndex)) {
      events.push(...this.promoteOrAccumulatePending(tcIndex, tcId, tcName, tcArgs));
    } else {
      events.push(...this.registerNewToolCall(tcIndex, tcId, tcName, tcArgs));
    }
  }
  return events;
}
```

**`handleSseStream` accepts 7 parameters** - `src/translation/proxy/translation-proxy.ts:539-591`
**Confidence**: 84%
- Problem: The method takes 7 parameters (`backendRes`, `res`, `translator`, `lineBuffer`, `resetIdleTimer`, `clearIdleTimer`, `resolve`). The complexity skill threshold flags 5+ parameters as HIGH severity, but here the parameter count is a direct consequence of decomposing the streaming request handler into focused sub-methods (an improvement from the prior monolithic version). The parameters are all distinct concerns that do not naturally form a single "options" object. This is a medium severity finding because the decomposition trade-off is net positive.
- Fix: Group the timer functions and resolve callback into a small context object to reduce the parameter count to 5:

```typescript
interface StreamCallbackContext {
  resetIdleTimer: () => void;
  clearIdleTimer: () => void;
  resolve: () => void;
}
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`handleStreamingError` and `handleJsonFallback` both accept `clearIdleTimer` and `resolve` as separate callback parameters** - `src/translation/proxy/translation-proxy.ts:495-536`
**Confidence**: 80%
- Problem: Both extracted methods take `clearIdleTimer: () => void` and `resolve: () => void` as the last two parameters, a pattern repeated across 3 methods (`handleStreamingError`, `handleJsonFallback`, `handleSseStream`). This is not blocking but reinforces the suggestion to use a shared context object as noted above.
- Fix: Same `StreamCallbackContext` object as above would unify the pattern across all three methods.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`translation-proxy.ts` is 674 lines, exceeding the 500-line warning threshold** - `src/translation/proxy/translation-proxy.ts`
**Confidence**: 90%
- Problem: The file contains 674 lines. While this PR improved the situation (extracting helper functions, decomposing the streaming handler), the file length still exceeds the 500-line warning threshold. The file contains ~7 standalone utility functions, an interface, and the `TranslationProxy` class with 10 methods. The utility functions (`readBody`, `sendError`, `mapStatusToErrorType`, `stripAnthropicHeaders`, `extractBackendErrorMessage`, `countApproxChars`, `buildErrorResponse`) are cohesive with the proxy but could be in a separate `proxy-utils.ts` module.
- Fix: Extract utility functions (lines 48-201) into `src/translation/proxy/proxy-utils.ts`. This would bring the main file to ~470 lines.

**`openai-codec.ts` file is 578 lines, approaching the 500-line warning threshold** - `src/translation/codecs/openai-codec.ts`
**Confidence**: 85%
- Problem: At 578 lines, the file is above the 500-line warning threshold. It contains request serialization, response parsing, stream parsing (state machine), and stream serialization. The `OpenAIStreamParser` class alone spans lines 196-407 (~210 lines).
- Fix: No immediate action needed — the stream parser is a cohesive state machine that should not be split artificially. Monitor if it grows further.

## Suggestions (Lower Confidence)

- **Promise-wrapping pattern in `handleNonStreamingRequest` and `handleStreamingRequest`** - `src/translation/proxy/translation-proxy.ts:432,622` (Confidence: 70%) — Both methods use `new Promise<void>((resolve) => { ... })` to wrap Node.js callback-style HTTP requests. This is the canonical pattern for Node.js `http.request`, but if the codebase adopts a higher-level HTTP client (e.g., `undici`), these could be simplified to async/await. Not actionable now but worth noting for future refactors.

- **`countApproxChars` has 4-level nesting** - `src/translation/proxy/translation-proxy.ts:173-201` (Confidence: 65%) — The function has a `for -> if/else-if -> for -> if` nesting chain reaching 4 levels. However, the function is only 29 lines and the logic is straightforward character counting. The nesting is a consequence of the data shape, not unnecessary complexity.

- **`OpenAIStreamParser` maintains 7 mutable state fields** - `src/translation/codecs/openai-codec.ts:196-206` (Confidence: 65%) — The parser tracks `hasEmittedMessageStart`, `hasActiveTextBlock`, `currentContentIndex`, `activeToolCalls`, `savedId`, `savedModel`, `lastActiveToolIndex`, plus the new `openaiToCanonicalIndex` and `pendingToolCalls` (9 total). This is inherent to SSE state machine parsing and not easily reduced, but could benefit from a brief state-diagram comment.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 2 | 0 |

**Complexity Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The PR significantly improved complexity by decomposing the monolithic `handleStreamingRequest` into 4 focused methods, extracting `buildToolResultMessages` and `buildAssistantMessage` from `buildOpenAIMessages`, converting `parseContentBlock` from if-chains to a switch, adding exhaustive checking to `AnthropicStreamSerializer.serialize`, and extracting `countApproxChars` and `extractBackendErrorMessage` as standalone functions. The net direction is clearly positive. The one HIGH finding (`handleNonStreamingRequest` nesting depth) and the MEDIUM parameter-count finding are the main items to address before merge.
