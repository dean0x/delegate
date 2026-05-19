# Security Review Report

**Branch**: feat/api-translation-proxy -> main
**Date**: 2026-04-24T12:32

## Issues in Your Changes (BLOCKING)

### HIGH

**Backend error messages forwarded to client without sanitization** - `src/translation/proxy/translation-proxy.ts:145-157`, `src/translation/proxy/translation-proxy.ts:457`, `src/translation/proxy/translation-proxy.ts:510`
**Confidence**: 85%
- Problem: The new `extractBackendErrorMessage()` function extracts error messages from backend responses and forwards them verbatim to the inbound client via `sendError()`. While the message is truncated to 500 characters, the backend error body can contain internal details such as model deployment names, internal hostnames, stack traces, or quota identifiers that the local client (Claude Code) does not need and should not see. This is a change from the previous behavior which returned the generic string `'Backend returned error'`. The file's own security invariant at line 12 states: "Never includes API keys in error messages or logs." While API keys specifically are not leaked, forwarding raw backend error content widens the information exposure surface.
- Fix: Sanitize or categorize the backend message before forwarding. Keep the detailed message for `logger.debug` (which is already done) but send a categorized summary to the client:
  ```typescript
  function extractBackendErrorMessage(chunks: Buffer[]): { detail: string; summary: string } {
    const MAX_LENGTH = 500;
    const raw = Buffer.concat(chunks).toString('utf-8');
    if (!raw) return { detail: 'Backend returned error', summary: 'Backend returned error' };
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const errorObj = parsed['error'] as Record<string, unknown> | undefined;
      const msg = errorObj?.['message'] ?? parsed['message'];
      const detail = typeof msg === 'string' ? msg.substring(0, MAX_LENGTH) : raw.substring(0, MAX_LENGTH);
      return { detail, summary: 'Backend returned error' };
    } catch {
      return { detail: raw.substring(0, MAX_LENGTH), summary: 'Backend returned error' };
    }
  }
  // Then: logger.debug('Backend error response', { statusCode, backendMessage: result.detail });
  // And:  sendError(res, statusCode, errorType, result.summary);
  ```
  Alternatively, since the proxy is local-only (127.0.0.1), the current behavior is defensible with an explicit comment acknowledging the design choice. The risk is LOW in practice because the client is same-machine, but HIGH in principle because it violates the stated security invariant pattern of opaque error messages.

### MEDIUM

**Unbounded buffer accumulation for backend error responses** - `src/translation/proxy/translation-proxy.ts:450-451`, `src/translation/proxy/translation-proxy.ts:502-503`
**Confidence**: 82%
- Problem: When the backend returns a 4xx/5xx error, the error body is accumulated in `errChunks` without any size limit. While inbound request bodies are bounded by `MAX_BODY_BYTES` (50MB), backend error responses have no equivalent guard. A malicious or misconfigured backend could return an arbitrarily large error body, causing memory exhaustion in the proxy process. The `extractBackendErrorMessage()` function truncates to 500 chars at extraction time, but the full body is buffered in memory first. This applies to both `handleNonStreamingRequest` (line 450) and `handleStreamingError` (line 502).
- Fix: Add a size cap on error body accumulation, similar to `readBody`:
  ```typescript
  private handleStreamingError(...): void {
    const errChunks: Buffer[] = [];
    let errBytes = 0;
    const MAX_ERR_BYTES = 64 * 1024; // 64KB is generous for error bodies
    backendRes.on('data', (chunk: Buffer) => {
      errBytes += chunk.length;
      if (errBytes <= MAX_ERR_BYTES) errChunks.push(chunk);
    });
    // ... rest unchanged
  }
  ```
  Apply the same pattern at line 450 in `handleNonStreamingRequest`.

## Issues in Code You Touched (Should Fix)

_No issues found in this category._

## Pre-existing Issues (Not Blocking)

### MEDIUM

**parseRequest error message forwarded to client** - `src/translation/proxy/translation-proxy.ts:335`
**Confidence**: 82%
- Problem: `parseResult.error.message` from the source codec's `parseRequest` is forwarded directly to the client. While this is pre-existing code (line 335 was not modified in this PR), the codec parse error messages could theoretically contain unexpected content if the codec implementation changes. For a local-only proxy this is low risk.
- Fix: Consider using a generic message like `'Invalid request format'` and logging the detail.

## Suggestions (Lower Confidence)

- **No size limit on JSON fallback response body** - `src/translation/proxy/translation-proxy.ts:527-528` (Confidence: 65%) -- The `handleJsonFallback` method accumulates the full response body in `chunks` without a size cap. For a successful (2xx) JSON fallback this is needed to parse the full response, but a misbehaving backend could return a very large body. The `NONSTREAM_TIMEOUT_MS` / `STREAM_IDLE_TIMEOUT_MS` provide some protection, but no explicit byte limit exists.

- **`SUPPORTED_TRANSLATE_TARGETS` duplicated across files** - `src/cli/commands/agents.ts:23`, `src/translation/proxy/proxy-manager.ts` (removed), `src/adapters/mcp-adapter.ts:351` (Confidence: 70%) -- The supported translate targets are now defined in three places: as a `TranslateTarget` type in `configuration.ts`, as a const array in `agents.ts:23`, and as a Zod enum in `mcp-adapter.ts:351`. If a new target is added, all three must be updated in lockstep. This is a consistency concern more than a security one, but divergence could allow invalid targets to bypass validation at one boundary while being rejected at another.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Security Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Positive Security Observations

1. **URL sanitization for log injection** (line 280-282): The new code sanitizes unknown endpoint URLs before including them in error responses -- strips non-printable characters and caps length at 200. Good defense-in-depth.
2. **Per-request middleware factory**: The `middlewareFactory` pattern eliminates shared mutable state across concurrent requests, preventing data races that could cause cross-request information leakage (e.g., tool name maps or cache hashes bleeding between requests).
3. **MCP schema tightening**: The `translate` field in the MCP adapter's Zod schema was changed from `.string()` to `.enum(['openai', ''])`, rejecting arbitrary values at the API boundary. The `TranslateTarget` type in `configuration.ts` enforces the same at the type level. The removed `SUPPORTED_TRANSLATE_TARGETS` validation in `proxy-manager.ts` is now redundant because `loadAgentConfig` only returns `'openai'` or `undefined` for the translate field.
4. **Proxy mode gating**: The bootstrap change (line 382) restricts proxy startup to `'server'` mode only, reducing attack surface for CLI modes that don't need a local HTTP server.
5. **Existing security invariants preserved**: API key stripping, 127.0.0.1-only binding, anthropic header stripping, request body size limits -- all remain intact and well-documented.

### Conditions for Approval

1. Address the backend error message forwarding (HIGH) -- either sanitize the message sent to clients or add an explicit comment acknowledging the local-only trust model as justification for the current behavior.
2. Address the unbounded error buffer accumulation (MEDIUM) -- add a byte cap on error body accumulation to match the defensive pattern already used for inbound request bodies.
