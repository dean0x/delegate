# Security Review Report

**Branch**: feat/api-translation-proxy -> main
**Date**: 2026-04-25
**Diff**: `git diff b762591...HEAD` (incremental)

## Issues in Your Changes (BLOCKING)

### CRITICAL

_No critical issues found._

### HIGH

_No high issues found._

### MEDIUM

_No medium issues found._

## Issues in Code You Touched (Should Fix)

_No should-fix issues found._

## Pre-existing Issues (Not Blocking)

_No pre-existing issues found._

## Suggestions (Lower Confidence)

_No lower-confidence suggestions._

## Analysis Notes

The following security-relevant areas were reviewed in the diff:

### 1. Proxy Startup in `run` Mode (DD1) -- No Issues

The `skipProxy` flag correctly gates proxy startup for `server` and `run` modes, skipping in `cli` mode. The `processSpawner` guard prevents proxy startup during tests. Both are appropriate access controls for the proxy lifecycle.

### 2. Fatal Proxy Failure (DD2) -- No Issues

The change from non-fatal to fatal proxy failure (`bootstrap.ts:399-404`) is a sound security decision. Previously, if the proxy failed to start, bootstrap silently fell back to direct Anthropic API -- which would fail with wrong credentials and produce confusing errors. The new behavior returns an `err()` with a remediation message. The error message does not leak API keys or sensitive configuration; it only suggests running `beat agents config set claude translate ""` to clear the setting.

### 3. API Key Handling -- No Issues

- `stripAnthropicHeaders()` correctly strips `x-api-key`, `authorization`, and all `anthropic-*` headers before forwarding to the target backend (`translation-proxy.ts:90-113`). This prevents credential leakage to the target.
- The `targetApiKey` is set via `Bearer` auth on the outbound request (`translation-proxy.ts:383`) and is never included in log output. The `logger.info('Translation proxy started', ...)` at `proxy-manager.ts:153-157` correctly logs only `port`, `targetBaseUrl`, and `targetModel`.
- The error remediation message in the fatal failure path (`bootstrap.ts:401-402`) does not include any credentials.

### 4. Error Body Forwarding (extractBackendErrorMessage) -- No Issues

The `DECISION` comment at `translation-proxy.ts:153-162` correctly documents that raw backend error text is forwarded to the local caller. This is acceptable because:
- The proxy binds exclusively to `127.0.0.1` (loopback only)
- The only client is the local Claude Code process
- Errors are truncated to 500 characters to prevent unbounded growth

### 5. MAX_ERR_BYTES Cap on Error Body Accumulation -- No Issues

The new `MAX_ERR_BYTES` (64KB) cap at `translation-proxy.ts:50` prevents memory exhaustion from malformed or maliciously large backend error responses. This is applied in both `handleStreamingError()` (`translation-proxy.ts:536-541`) and the new `handleBackendNonStreamingResponse()` (`translation-proxy.ts:448-452`). This is a positive security improvement over the prior code which had no cap on error body accumulation in the non-streaming path.

### 6. Shared PromptCacheState -- No Issues

The `PromptCacheState` interface (`prompt-cache.ts:24-26`) stores only a hash string (`lastPrefixHash`), not raw request content or credentials. The shared state is scoped to a single `ProxyManager` instance and is not exposed externally. There is no risk of cross-tenant data leakage since the proxy serves only the local machine.

### 7. Container Dispose Proxy Cleanup (DD3) -- No Issues

The `container.dispose()` method now stops the proxy before killing workers (`container.ts:210-220`). This ensures the HTTP server is properly shut down, preventing port leaks. The `ProxyManager.stop()` is documented as idempotent, preventing double-close issues.

### 8. TRANSLATE_TARGETS Single Source of Truth -- No Issues

The `TRANSLATE_TARGETS` const tuple (`configuration.ts:236`) centralizes valid targets. The `loadAgentConfig()` function (`configuration.ts:264-270`) silently drops unknown values from stored config, which prevents injection of unexpected translate targets from a tampered config file. The Zod schema in `mcp-adapter.ts:357-359` validates MCP input against the same canonical list.

### 9. URL Sanitization -- Pre-existing, Adequate

The `safeUrl` sanitization at `translation-proxy.ts:300` strips non-printable characters and caps at 200 characters, preventing log injection. This was pre-existing and remains adequate.

### 10. Loopback Binding -- Pre-existing, Adequate

The proxy server binds to `127.0.0.1` only (`translation-proxy.ts:250`), preventing external network access. The HTTP (not HTTPS) choice is documented as intentional for loopback-only use. Both are pre-existing and remain adequate.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Security Score**: 9/10
**Recommendation**: APPROVED

The changes in this diff are security-positive overall. The fatal proxy failure (DD2) prevents confusing fallback behavior. The `MAX_ERR_BYTES` cap closes a potential memory exhaustion vector in error body accumulation. API key handling, header stripping, error message exposure, and loopback binding are all correct and well-documented. No secrets are logged, no credentials are exposed in error messages, and input validation is properly applied at all boundaries.
