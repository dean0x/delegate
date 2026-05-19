# Performance Review Report

**Branch**: feat/api-translation-proxy -> main
**Date**: 2026-04-27T11:15

## Issues in Your Changes (BLOCKING)

### HIGH

**Non-streaming response body accumulates without size limit** - `src/translation/proxy/translation-proxy.ts:484-488`
**Confidence**: 85%
- Problem: In `handleBackendNonStreamingResponse`, the success path (`statusCode < 400`) accumulates `chunks` with no byte cap, then calls `Buffer.concat(chunks).toString()`. While the error path correctly uses `MAX_ERR_BYTES` (64KB) to cap accumulation (line 468-471), the success path has no upper bound. A backend returning a very large JSON response (e.g., multi-megabyte reasoning content or tool call arguments) will be fully buffered in memory. The same unbounded pattern appears in `handleJsonFallback` (line 584-589).
- Fix: Apply the same cap used in `readBody()` (50MB via `MAX_BODY_BYTES`) or a tighter limit on the success accumulation paths:
```typescript
// In handleBackendNonStreamingResponse, success path:
const chunks: Buffer[] = [];
let totalBytes = 0;
backendRes.on('data', (chunk: Buffer) => {
  totalBytes += chunk.length;
  if (totalBytes <= MAX_BODY_BYTES) {
    chunks.push(chunk);
  }
});
backendRes.on('end', () => {
  clearTimeout(responseTimeout);
  if (totalBytes > MAX_BODY_BYTES) {
    sendError(res, 502, 'api_error', 'Backend response too large');
    resolve();
    return;
  }
  this.processNonStreamingResponse(Buffer.concat(chunks).toString(), res, middlewares);
  resolve();
});
```
Apply the same pattern to `handleJsonFallback`.

**`probeUrl` called synchronously in MCP tool handler request path** - `src/adapters/mcp-adapter.ts:3357-3364`, `src/adapters/mcp-adapter.ts:3511-3517`
**Confidence**: 82%
- Problem: The `handleConfigureAgent` method now awaits `probeUrl()` with a 5-second timeout on every `check` action (line 3357) and every `set` action that touches baseUrl/apiKey/translate (line 3511). This adds up to 5 seconds of latency to the MCP tool response. For `check`, this is called unconditionally when `agentConfig.baseUrl` is truthy. Users may call `ConfigureAgent check` frequently for status checks, and a slow or unreachable backend will cause 5-second stalls on every invocation.
- Fix: Consider either (a) making the probe optional with a `--probe` / `probe: true` parameter in the tool schema, or (b) reducing the timeout to 2-3 seconds for the `check` action, or (c) running the probe concurrently with other validation work (there is no concurrency opportunity currently, but this is worth noting for future changes). The `set` action probe (line 3511) is more acceptable since it only fires on config changes, but the `check` action probe fires on every status inquiry.

### MEDIUM

**URL construction using string concatenation instead of URL API** - `src/translation/proxy/translation-proxy.ts:389`
**Confidence**: 80%
- Problem: `new URL(this.config.targetBaseUrl.replace(/\/$/, '') + '/chat/completions')` constructs a URL via string concatenation after a regex strip. This is called on every proxied request. While not a hot-path bottleneck, the regex + string concat + URL parse is slightly less efficient than using the URL API's path resolution directly. More importantly, this pattern is fragile for base URLs with paths (e.g., `https://api.example.com/v1/` would produce `https://api.example.com/v1/chat/completions`, but `https://api.example.com/v1` also works correctly). The performance concern is marginal but the robustness concern is real.
- Fix: Pre-compute the target URL once at construction time (or proxy start) rather than per-request:
```typescript
// In constructor or start():
private readonly chatCompletionsUrl: URL;
constructor(config: TranslationProxyConfig) {
  this.chatCompletionsUrl = new URL(
    config.targetBaseUrl.replace(/\/$/, '') + '/chat/completions'
  );
}
// Then in handleMessages:
const targetUrl = this.chatCompletionsUrl;
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`argumentsAccumulator` string concatenation in streaming state machine** - `src/translation/codecs/openai-codec.ts:353,381`
**Confidence**: 80%
- Problem: The `argumentsAccumulator` field uses string concatenation (`+=`) to build up tool call arguments across stream chunks. For large tool call arguments (e.g., multi-kilobyte JSON payloads for code generation tools), this creates O(n^2) string copies because JavaScript strings are immutable -- each concatenation allocates a new string. In practice, most tool call arguments are small (<1KB), so this is unlikely to be a bottleneck, but for models that generate very large tool inputs (e.g., writing entire files), this could become measurable.
- Fix: Use an array accumulator and join at the end:
```typescript
interface ActiveToolCall {
  id: string;
  name: string;
  argumentsChunks: string[];  // was argumentsAccumulator: string
  started: boolean;
}
// On delta: tc.argumentsChunks.push(tcArgs);
// On stop: arguments: tc.argumentsChunks.join('')
```

## Pre-existing Issues (Not Blocking)

_No CRITICAL pre-existing performance issues found in the reviewed files._

## Suggestions (Lower Confidence)

- **SSE line batching could use pre-sized array** - `src/translation/proxy/translation-proxy.ts:617` (Confidence: 65%) -- The `output` array in `handleSseStream` is allocated empty and grown dynamically. For high-throughput streams, pre-sizing based on `lines.length` could reduce array resizes, but the current batching already consolidates writes per chunk which is the primary win.

- **`stripAnthropicHeaders` iterates all headers on every request** - `src/translation/proxy/translation-proxy.ts:90-113` (Confidence: 60%) -- The function iterates every header and checks `toLowerCase()` + `startsWith()` on each. For typical request headers (~10-15 entries), this is negligible. Only relevant if the proxy handles very high request rates (>1000 req/s), which is unlikely for a local translation proxy.

- **Build-time version generation runs synchronously via `readFileSync`** - `scripts/generate-version.mjs:6` (Confidence: 70%) -- Uses `readFileSync` and `writeFileSync` which block the event loop, but since this is a build-time script (not runtime code), the performance impact is zero at runtime. This is correct usage for a build script.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Performance Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The proxy's streaming path is well-optimized (batched writes, idle timers, backpressure via AbortController). The primary concerns are: (1) unbounded response body accumulation on the non-streaming success path and JSON fallback path -- these should have the same size caps as the inbound body reader and error path; (2) the `probeUrl` call adding up to 5 seconds of latency to every `ConfigureAgent check` invocation. The codec refactoring (thinking block lifecycle, tool call method extraction) is performance-neutral -- the extracted methods maintain the same algorithmic complexity while improving readability. The build-time VERSION injection eliminates runtime `package.json` reads, which is a net positive for startup performance.
