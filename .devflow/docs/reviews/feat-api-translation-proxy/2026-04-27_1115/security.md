# Security Review Report

**Branch**: feat/api-translation-proxy -> main
**Date**: 2026-04-27
**PR**: #152

## Issues in Your Changes (BLOCKING)

### MEDIUM

**TLS bypass recommendation in user-facing error message** - `src/utils/url-probe.ts:146`
**Confidence**: 90%
- Problem: The error message for TLS/SSL failures suggests setting `NODE_TLS_REJECT_UNAUTHORIZED=0`, which disables all TLS certificate verification for the entire Node.js process. This is a known-dangerous workaround (OWASP A02 - Cryptographic Failures) that would expose all outbound HTTPS connections (including the actual API proxy traffic carrying API keys) to MITM attacks. Including this in an error message normalizes an insecure practice.
- Fix: Remove the TLS bypass suggestion or replace it with a safer recommendation:
  ```typescript
  // Instead of:
  return `TLS/SSL error connecting to ${urlStr}: ${error.message}. For self-signed certs, set NODE_TLS_REJECT_UNAUTHORIZED=0.`;
  // Use:
  return `TLS/SSL error connecting to ${urlStr}: ${error.message}. Verify the server's TLS certificate is valid, or configure a custom CA bundle via NODE_EXTRA_CA_CERTS.`;
  ```

**No protocol scheme restriction on probeUrl target** - `src/utils/url-probe.ts:212-221`
**Confidence**: 82%
- Problem: The `probeUrl` function validates that the input is a parseable URL but does not restrict the protocol scheme. A `file://`, `ftp://`, or other non-HTTP scheme would pass `new URL()` validation but cause unexpected behavior or errors when passed to `http.request`. While the current call sites pass URLs that were previously validated at the `baseUrl` save boundary (CLI `agents config set`), that CLI validation (`new URL(value)`) also lacks scheme restrictions. The MCP `ConfigureAgent` tool path has the same gap. This is a defense-in-depth concern (OWASP A10 - SSRF), not an active exploit path, since the URL ultimately comes from the user's own config.
- Fix: Add scheme validation at the probe entry point:
  ```typescript
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    return err(new Error(`Unsupported protocol "${parsedUrl.protocol}" — only http: and https: are supported`));
  }
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**API key potentially logged in bootstrap info message** - `src/bootstrap.ts:412`
**Confidence**: 80%
- Problem: The line `logger.info('Translation proxy active', { port: proxyPort, targetBaseUrl: proxyConfig.targetBaseUrl })` is safe as-is, but `proxyConfig` also contains `targetApiKey`. If someone were to change this to log the full `proxyConfig` object, the API key would be emitted to logs. The proximity of `proxyConfig.targetApiKey` in the same scope as the log call creates a latent risk. This is a low-severity concern since the current code is correct.
- Fix: No immediate code change needed. The current log statement correctly omits `targetApiKey`. Consider adding a comment:
  ```typescript
  // NOTE: Only log non-secret fields from proxyConfig (targetBaseUrl, not targetApiKey)
  logger.info('Translation proxy active', { port: proxyPort, targetBaseUrl: proxyConfig.targetBaseUrl });
  ```

## Pre-existing Issues (Not Blocking)

### MEDIUM

**No scheme restriction on baseUrl at CLI save boundary** - `src/cli/commands/agents.ts:138-145`
**Confidence**: 85%
- Problem: The `baseUrl` validation uses `new URL(value)` which accepts any scheme (`file://`, `ftp://`, `javascript:`, etc.). While this is a pre-existing pattern and the URL is used only for HTTP outbound requests (which would fail for non-HTTP schemes), defense-in-depth would restrict to `http:` and `https:` at the save boundary.
- Fix (separate PR):
  ```typescript
  if (key === 'baseUrl' && value !== '') {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      ui.error(`Invalid baseUrl: "${value}" is not a valid URL.`);
      process.exit(1);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      ui.error(`baseUrl must use https: or http: protocol, got "${parsed.protocol}"`);
      process.exit(1);
    }
  }
  ```

## Suggestions (Lower Confidence)

- **SSRF via redirect following in probeUrl** - `src/utils/url-probe.ts:162-165` (Confidence: 65%) -- The probe reports redirects to the user but Node.js `http.request` does not follow redirects by default, so this is informational. However, if a future change added redirect following, the probe could be directed to internal services. The current behavior is safe.

- **Unbounded non-streaming response accumulation** - `src/translation/proxy/translation-proxy.ts:484-485` (Confidence: 70%) -- The non-streaming success path (`chunks.push(chunk)`) accumulates the entire backend response body in memory without a size cap (unlike the error path which caps at `MAX_ERR_BYTES`). A malicious backend could send a very large response. In practice, the backend is user-configured and trusted, but defense-in-depth would add a cap similar to `MAX_BODY_BYTES`.

- **Timing information in probe responses** - `src/utils/url-probe.ts:29` (Confidence: 60%) -- The `durationMs` field in `UrlProbeResult` is surfaced to the user via CLI and MCP tool responses. While this is useful for diagnostics, timing side-channels could theoretically help fingerprint internal infrastructure. Low risk given the tool is used only by the server operator.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Security Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The branch introduces a well-structured URL probe utility and translation proxy enhancements. The proxy correctly binds to loopback only (`127.0.0.1`), strips Anthropic-specific auth headers before forwarding, uses separate auth for the backend, and has body size limits on inbound requests. The main security concerns are:

1. The TLS bypass recommendation in error messages should be changed to suggest `NODE_EXTRA_CA_CERTS` instead of `NODE_TLS_REJECT_UNAUTHORIZED=0`.
2. Protocol scheme validation should be added to `probeUrl` as defense-in-depth against non-HTTP schemes.

Neither issue is exploitable in the current deployment model (single-user CLI tool where the operator controls all config), but both represent security hygiene improvements that should be addressed before merge.

Positive security observations:
- Proxy binds exclusively to `127.0.0.1` (loopback) -- not reachable from network
- Anthropic headers (`x-api-key`, `authorization`) are properly stripped before forwarding
- Request body size is capped at 50MB (`MAX_BODY_BYTES`)
- URL sanitization before logging (`safeUrl` with printable ASCII filter and 200-char cap)
- `ProxiedClaudeAdapter.resolveAuth()` correctly suppresses backend API key injection to Claude Code
- AbortController-based timeouts on all outbound requests prevent resource exhaustion
