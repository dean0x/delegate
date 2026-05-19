# Complexity Review Report

**Branch**: feat/api-translation-proxy -> main
**Date**: 2026-04-23

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

**`handleStreamingRequest` exceeds function length threshold (161 lines)** - `translation-proxy.ts:441-602`
**Confidence**: 95%
- Problem: The `handleStreamingRequest` method spans 161 lines (threshold: >50 critical, 50-200 high). It handles connection setup, error responses, JSON fallback detection, SSE streaming, idle timers, line buffering, flushing, and error recovery all in one method. The nesting reaches 5 levels deep in the callback structure (method > Promise > requestFn callback > backendRes.on > lineBuffer processing).
- Fix: Extract the three distinct response paths into named private methods:
  ```typescript
  private handleStreamingError(backendRes, res, statusCode, streamIdleTimer, resolve): void { ... }
  private handleJsonFallback(backendRes, res, streamIdleTimer, resolve): void { ... }
  private handleSseStream(backendRes, res, translator, lineBuffer, resetIdleTimer, streamIdleTimer, resolve): void { ... }
  ```
  This reduces `handleStreamingRequest` to ~40 lines of setup + routing.

**`handleNonStreamingRequest` exceeds function length threshold (104 lines)** - `translation-proxy.ts:335-439`
**Confidence**: 90%
- Problem: 104 lines with nesting up to 5 levels (method > Promise > requestFn callback > backendRes.on('end') > parseResult check). The success path alone contains parse-response, run-middleware, serialize-response, and send-response all nested inside callbacks.
- Fix: Extract the success-path response processing into a helper:
  ```typescript
  private processNonStreamingResponse(body: string, res: http.ServerResponse): void {
    // parse -> middleware -> serialize -> send
  }
  ```

**`OpenAIStreamParser.processChunk` — high cyclomatic complexity (~18)** - `openai-codec.ts:222-374`
**Confidence**: 92%
- Problem: 152 lines with cyclomatic complexity around 18 (counting if/else branches, null checks, map lookups, nested conditionals). The method handles: usage-only chunks, delta-less chunks, message_start emission, text content, reasoning content, tool calls (new vs continuing, started vs not-started), text block closure, tool block closure, and finish reason — all in a single function. Nesting reaches 4 levels inside the tool calls loop.
- Fix: Extract the tool call delta handling into a dedicated method:
  ```typescript
  private processToolCallDeltas(toolCalls: Array<Record<string, unknown>>): CanonicalStreamEvent[] {
    // handles new vs continuing tool calls, block start/stop transitions
  }
  ```
  Also extract the "close active text block" pattern (lines 303-308) which appears twice into a small helper, and the "close active tool call" pattern (lines 273-285).

**`buildOpenAIMessages` — high cyclomatic complexity (~14)** - `openai-codec.ts:78-166`
**Confidence**: 88%
- Problem: 88 lines with ~14 branch points. The function handles system messages, tool_result splitting (with nested content extraction), non-tool-result user content, assistant messages with tool_use/text separation, and regular user messages. Three `continue` statements and nested filter+map chains add cognitive load.
- Fix: Extract the tool_result and assistant-with-tool_use cases into named helpers:
  ```typescript
  function buildToolResultMessages(toolResults: CanonicalContent[]): OpenAIMessage[] { ... }
  function buildAssistantMessage(msg: CanonicalMessage): OpenAIMessage { ... }
  ```

### MEDIUM

**`handleCountTokens` — moderate complexity with deep nesting (5 levels)** - `translation-proxy.ts:224-272`
**Confidence**: 85%
- Problem: 48 lines, but nesting reaches 5 levels: method > if parsed > if messages > for msg > if Array.isArray(content) > for block. The approximate token counting logic interleaves input validation with content traversal.
- Fix: Extract the character counting into a pure function:
  ```typescript
  function countApproxChars(parsed: unknown): number { ... }
  ```

**`parseContentBlock` — long if-chain (7 branches)** - `anthropic-codec.ts:28-103`
**Confidence**: 82%
- Problem: 75 lines with 7 sequential `if (type === ...)` blocks. While each branch is simple, the pattern could be more maintainable as a dispatch map or switch statement, and the function length is above the 50-line threshold.
- Fix: Convert to a switch statement for clarity (or a Record-based dispatch map for extensibility):
  ```typescript
  switch (type) {
    case 'text': return { ... };
    case 'image': return { ... };
    // ...
  }
  ```

**`serializeRequest` — 10 sequential optional field assignments** - `openai-codec.ts:442-503`
**Confidence**: 80%
- Problem: 61 lines, 10 sequential `if (canonical.X)` checks building a body object. While each check is simple, the function is a wall of conditional assignments that obscures what the "shape" of the output is.
- Fix: Consider grouping related fields (e.g., sampling params, tool params, metadata) or using a builder pattern. Low urgency since each branch is trivially understandable.

**File length: `translation-proxy.ts` (603 lines)** - `translation-proxy.ts`
**Confidence**: 90%
- Problem: File exceeds the 500-line critical threshold. Contains the TranslationProxy class, 5 top-level helper functions, and multiple interfaces. The proxy is architecturally sound (clean separation between handleRequest routing, streaming, and non-streaming), but the raw line count signals it could benefit from splitting.
- Fix: Extract helper functions (`readBody`, `sendError`, `buildErrorResponse`, `mapStatusToErrorType`, `stripAnthropicHeaders`) into a `proxy-utils.ts` module. This would drop `translation-proxy.ts` to ~500 lines.

**File length: `openai-codec.ts` (586 lines)** - `openai-codec.ts`
**Confidence**: 88%
- Problem: File exceeds the 500-line critical threshold. Contains the OpenAICodec class, OpenAIStreamParser state machine, OpenAIStreamSerializer, and 5 helper functions.
- Fix: Extract `OpenAIStreamParser` into its own file (`openai-stream-parser.ts`). The parser is a self-contained state machine (~200 lines) that would be independently testable.

## Issues in Code You Touched (Should Fix)

(none identified)

## Pre-existing Issues (Not Blocking)

(none identified -- changed lines are all in new files)

## Suggestions (Lower Confidence)

- **`AnthropicStreamSerializer.serialize` switch has 10 cases** - `anthropic-codec.ts:207-314` (Confidence: 65%) — The switch is long but each case is a pure data mapping with no nesting. Could be refactored to a dispatch map but readability may not improve.

- **Duplicated pattern: body read + JSON parse + error handling** - `translation-proxy.ts:224-242,274-293` (Confidence: 70%) — `handleCountTokens` and `handleMessages` both read the body, check errors, parse JSON, and handle parse failures with nearly identical code. Could extract a `readAndParseJsonBody` helper.

- **`AnthropicCodec.parseRequest` — 57 lines with many spread operators** - `anthropic-codec.ts:341-398` (Confidence: 62%) — The function builds a large object with 13 conditional spread properties. Readable as-is but approaches the complexity threshold.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 4 | 4 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Complexity Score**: 6/10
**Recommendation**: CHANGES_REQUESTED

The translation proxy introduces a substantial amount of new code (2,642 lines across 13 files) with generally clean architecture -- the codec/IR/middleware/proxy layering is well-structured. However, four HIGH-severity complexity issues stand out: the two long proxy handler methods (`handleStreamingRequest` at 161 lines, `handleNonStreamingRequest` at 104 lines) and two high-complexity functions in the OpenAI codec (`processChunk` CC~18, `buildOpenAIMessages` CC~14). These should be decomposed before merge to keep the codebase maintainable. The smaller files (middleware, line-buffer, stream-translator, proxied-claude-adapter, codec interface, IR types) are all well within complexity thresholds and demonstrate good decomposition practices.
