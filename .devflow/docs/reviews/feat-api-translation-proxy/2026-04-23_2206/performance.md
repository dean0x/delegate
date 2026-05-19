# Performance Review Report

**Branch**: feat/api-translation-proxy -> main
**Date**: 2026-04-23

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Array spread creates a new copy on every stream event in middleware pipeline** - `src/translation/middleware/middleware.ts:53`
**Confidence**: 85%
- Problem: `runStreamEventMiddleware` calls `[...middlewares].reverse()` on every invocation. During streaming, this function is called once per SSE chunk from the backend (potentially hundreds or thousands of times per response). Each call allocates a new reversed array. With only 3 middlewares the constant factor is small, but it is unnecessary allocation on the hot path.
- Fix: Pre-compute the reversed middleware array once at the `StreamTranslator` construction site, or accept it as a constructor parameter in reverse order. The same issue exists in `runResponseMiddleware` (line 41) but that is called only once per non-streaming response, so it is much lower impact.

```typescript
// In StreamTranslator constructor, pre-reverse once:
private readonly reversedMiddlewares: readonly TranslationMiddleware[];
constructor(
  private readonly sourceSerializer: StreamSerializer,
  private readonly targetParser: StreamParser,
  middlewares: readonly TranslationMiddleware[],
) {
  this.reversedMiddlewares = [...middlewares].reverse();
}

// Then in applyMiddleware:
private applyMiddleware(event: CanonicalStreamEvent): CanonicalStreamEvent | null {
  if (this.reversedMiddlewares.length === 0) return event;
  let current: CanonicalStreamEvent | null = event;
  for (const mw of this.reversedMiddlewares) {
    if (!current) return null;
    if (mw.processStreamEvent) {
      current = mw.processStreamEvent(current);
    }
  }
  return current;
}
```

---

**Per-line `res.write()` calls during SSE streaming create excessive system calls** - `src/translation/proxy/translation-proxy.ts:557-562`
**Confidence**: 82%
- Problem: In the streaming data handler, each SSE line from the translator is written to the response individually via `res.write(sseLine + '\n')`. When a single OpenAI chunk produces multiple canonical events (e.g., `message_start` + `content_start` + `content_delta`), this results in 6+ individual `res.write()` calls per backend chunk. Each write is a syscall and TCP send on the loopback. Batching into a single write per chunk would reduce syscall overhead.
- Fix: Concatenate all SSE lines from a single chunk into one buffer and write once.

```typescript
backendRes.on('data', (chunk: Buffer) => {
  resetIdleTimer();
  const text = chunk.toString('utf-8');
  const lines = lineBuffer.feed(text);

  const outputParts: string[] = [];
  for (const line of lines) {
    const sseLines = translator.processLine(line);
    for (const sseLine of sseLines) {
      outputParts.push(sseLine);
      outputParts.push('\n');
    }
  }
  if (outputParts.length > 0) {
    res.write(outputParts.join(''));
  }
});
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**SHA-256 hash computed per tool name on every request when tools are >64 chars** - `src/translation/middleware/tool-name-mapping.ts:22-27`
**Confidence**: 80%
- Problem: `truncateName` calls `createHash('sha256').update(name).digest('hex')` for each tool name exceeding 64 characters. Claude Code tool names are stable per-session (the same tool set is sent with every request). The `forwardMap` cache (line 51) mitigates this for repeat calls within the same middleware instance, but the `ToolNameMappingMiddleware` is created once per `ProxyManager.start()` and reused across requests, so in practice the cache will be warm after the first request. The SHA-256 cost is approximately 1-2us per tool name, so with Claude Code's ~50+ tools this adds negligible latency. Current caching is adequate; noting for awareness only.

## Pre-existing Issues (Not Blocking)

_No pre-existing performance issues identified in files reviewed._

## Suggestions (Lower Confidence)

- **SHA-256 per request for prompt cache hashing** - `src/translation/middleware/prompt-cache.ts:50` (Confidence: 65%) -- `hashPrefix()` computes SHA-256 of the system prompt text on every request. System prompts for Claude Code can be 50KB+. The hash itself is fast (~50us for 50KB) and only runs once per request (not per stream chunk), so this is likely fine. If profiling shows it matters, the hash could be memoized by text length + first/last 100 chars as a cheap check.

- **String concatenation in argumentsAccumulator** - `src/translation/codecs/openai-codec.ts:357` (Confidence: 62%) -- Tool call arguments accumulate via `existing.argumentsAccumulator += tcArgs` across many stream chunks. For large tool arguments (e.g., code blocks), this creates O(n^2) string concatenation. In practice, tool arguments in Claude Code are typically small JSON objects (<1KB), and V8 optimizes short string concat. If very large tool arguments become common, switching to an array push + join pattern would be better.

- **Eager proxy startup adds bootstrap latency** - `src/bootstrap.ts:377-387` (Confidence: 70%) -- When translation is configured, `ProxyManager.start()` is awaited at bootstrap, adding TCP listen + bind overhead (~1-5ms) to every server startup. This is a conscious design decision (documented in the DECISION comment) and the overhead is minimal. The alternative (lazy start) would require the agentRegistry factory to be async, which conflicts with the synchronous factory pattern.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Performance Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

Conditions: The two MEDIUM blocking items (array spread on hot path, per-line res.write) are low-severity performance nits that do not cause measurable degradation at current scale (single proxy, small middleware stack, loopback network). They should be addressed as part of normal cleanup but do not block merge.

Overall the translation proxy demonstrates strong performance awareness: proper streaming with backpressure (Node.js streams handle this), bounded request body (50MB cap), timeout management (connect, response, stream idle), and efficient buffer-based line parsing. The middleware pipeline is lightweight, the codec conversions are allocation-efficient, and the hot path (streaming) avoids unnecessary object creation.
