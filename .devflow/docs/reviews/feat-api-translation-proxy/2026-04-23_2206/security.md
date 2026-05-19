# Security Review Report

**Branch**: feat/api-translation-proxy -> main
**Date**: 2026-04-23
**PR**: #152

## Issues in Your Changes (BLOCKING)

### MEDIUM

**User-controlled URL reflected in error response** - `src/translation/proxy/translation-proxy.ts:221`
**Confidence**: 85%
- Problem: The `req.url` value is included verbatim in the error response sent to the client: `sendError(res, 404, 'invalid_request_error', \`Unknown endpoint: ${url}\`)`. Since this proxy only binds to 127.0.0.1 and the client is the local Claude Code process (not an external attacker), the practical risk is low. However, reflecting unsanitized user input in responses is an anti-pattern that could facilitate log injection or confuse downstream error parsing if the URL contains special characters (newlines, JSON metacharacters, etc.).
- Fix: Sanitize or truncate the URL before reflecting it:
```typescript
const safeUrl = url.replace(/[^\x20-\x7E]/g, '').substring(0, 200);
sendError(res, 404, 'invalid_request_error', `Unknown endpoint: ${safeUrl}`);
```

**No validation that `translate` value is a supported target at the MCP/CLI boundary** - `src/adapters/mcp-adapter.ts:350-355`, `src/cli/commands/agents.ts:110-111`
**Confidence**: 82%
- Problem: The `translate` field in the Zod schema and CLI accepts any string value. While `loadProxyConfig()` in `proxy-manager.ts:73` validates against `SUPPORTED_TRANSLATE_TARGETS` at runtime and returns `null` for unsupported values (failing silently), the user receives no feedback that an unsupported target was saved. They could save `translate: "gemini"` and wonder why the proxy never starts. This is a boundary validation gap rather than a direct security vulnerability, but it violates the "validate at boundaries" principle and could cause confusion that leads to insecure fallback behavior (e.g., user thinks they are proxied but falls back to direct Anthropic API without realizing it).
- Fix: Add enum validation at the MCP schema level:
```typescript
translate: z
  .enum(['openai', ''])
  .optional()
  .describe('API translation target...')
```
And at the CLI level:
```typescript
const VALID_TRANSLATE_VALUES = ['openai', ''];
if (key === 'translate' && !VALID_TRANSLATE_VALUES.includes(value)) {
  ui.error(`Unsupported translate target: "${value}". Supported: openai`);
  process.exit(1);
}
```

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

_No issues found._

## Suggestions (Lower Confidence)

- **SSRF via user-configured targetBaseUrl** - `src/translation/proxy/translation-proxy.ts:318` (Confidence: 65%) -- The `targetBaseUrl` is user-configured and used to construct outbound HTTP requests to arbitrary hosts. Since this is an explicitly user-configured field (the user deliberately sets it via `beat agents config set`), blocking internal IPs would likely break legitimate use cases (e.g., local proxy endpoints). However, if this tool is ever used in a multi-tenant context, the lack of URL allowlisting could allow requests to internal services. Current local-only usage is acceptable.

- **Timeouts may not fully prevent resource exhaustion** - `src/translation/proxy/translation-proxy.ts:39-43` (Confidence: 62%) -- The 5-minute non-streaming timeout and 60-second stream idle timeout are reasonable defaults. However, there is no overall maximum connection count or rate limiting on the proxy server. A pathological or misconfigured Claude Code instance could open many concurrent connections. Since the proxy only binds to 127.0.0.1, this is limited to local denial-of-service scenarios.

- **Backend error body is discarded** - `src/translation/proxy/translation-proxy.ts:367-375` (Confidence: 70%) -- When the backend returns a 4xx/5xx error, the error body from the backend is collected into `errChunks` but never used. The proxy sends a generic "Backend returned error" message instead. This is actually good from a security perspective (prevents leaking backend error details to the client), but from a debugging perspective it would be helpful to log the backend error at debug level without forwarding it.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Security Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

## Security Assessment

The translation proxy implementation demonstrates strong security awareness overall:

**Strengths:**
1. **Credential isolation**: The proxy correctly strips all inbound `x-api-key` and `authorization` headers before forwarding, and uses only the configured `targetApiKey` for outbound auth (`stripAnthropicHeaders` function at line 72-95). API keys never leak across boundaries.
2. **Loopback binding**: The proxy binds exclusively to `127.0.0.1:0` (line 172), preventing remote access. The HTTP (non-TLS) choice is well-justified for loopback-only traffic.
3. **Body size limits**: `MAX_BODY_BYTES` at 50MB prevents memory exhaustion from oversized requests (line 39).
4. **Timeout protection**: Connection, response, and stream idle timeouts prevent resource leaks (lines 40-43).
5. **No credential logging**: Logger calls in the middleware and proxy manager avoid logging API keys or request bodies. The `LoggingMiddleware` only logs metadata (model, counts, flags).
6. **Secure config file permissions**: Config files use 0o700 for directories and 0o600 for files, preventing other users from reading stored API keys.
7. **Header sanitization**: Anthropic-specific and auth headers are stripped before forwarding to the target backend.
8. **Client disconnect handling**: Both streaming and non-streaming paths abort outbound requests when the inbound client disconnects.
9. **Generic error messages**: Error responses sent to the client use generic messages ("Backend returned error") rather than forwarding raw backend error details.

**Conditions for approval:**
- Consider adding input validation for the `translate` field at the MCP/CLI boundary (MEDIUM finding #2) to prevent silent misconfiguration.
