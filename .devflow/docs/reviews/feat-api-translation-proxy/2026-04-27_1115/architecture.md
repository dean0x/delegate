# Architecture Review Report

**Branch**: feat/api-translation-proxy -> main
**Date**: 2026-04-27
**PR**: #152

## Issues in Your Changes (BLOCKING)

### HIGH

**Database registration changed from lazy singleton to eager value -- breaks Container's consistent registration pattern** - `src/bootstrap.ts:256-275`
**Confidence**: 85%
- Problem: The database registration was changed from `container.registerSingleton('database', () => ...)` to an eager `try { ... container.registerValue('database', db) }` pattern. While the motivation (catching `NODE_MODULE_VERSION` errors early with a user-friendly message) is valid, this breaks the consistent registration pattern used by every other service in bootstrap. All other registrations use `registerSingleton` with factory closures. The eager pattern also means the database is created unconditionally even if no downstream service ever resolves it (e.g., a hypothetical future CLI path that skips DB). More importantly, the `catch` block re-throws non-`NODE_MODULE_VERSION` errors as raw exceptions rather than returning `Result<Container>`, breaking the function's contract that errors are returned as `err()`.
- Fix: Keep the eager check for the specific `NODE_MODULE_VERSION` error but wrap all exceptions into the Result return type:
  ```typescript
  try {
    const dbLogger = logger.child({ module: 'database' });
    const db = new Database(undefined, dbLogger);
    container.registerValue('database', db);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('NODE_MODULE_VERSION')) {
      return err(
        new AutobeatError(
          ErrorCode.SYSTEM_ERROR,
          `better-sqlite3 was compiled for a different Node.js version.\n\n` +
            `  Current Node:  ${process.version}\n` +
            `  Fix:           npm rebuild better-sqlite3 -g\n` +
            `                 (or reinstall: npm install -g autobeat)\n`,
        ),
      );
    }
    return err(
      new AutobeatError(ErrorCode.SYSTEM_ERROR, `Failed to initialize database: ${msg}`),
    );
  }
  ```

**URL construction in TranslationProxy uses string concatenation instead of URL API** - `src/translation/proxy/translation-proxy.ts:389`
**Confidence**: 82%
- Problem: The target URL construction was changed from `new URL('/v1/chat/completions', this.config.targetBaseUrl)` to `new URL(this.config.targetBaseUrl.replace(/\/$/, '') + '/chat/completions')`. The original `new URL(path, base)` API correctly handles base URLs with or without trailing slashes and preserves existing path segments. The new approach drops the `v1` path component that was previously appended by the URL constructor's resolution behavior. For example, with `targetBaseUrl = "https://api.example.com/v1"`, the old code produced `https://api.example.com/v1/chat/completions` while the new code produces `https://api.example.com/v1/chat/completions` -- the same result in this case. However, the new approach is fragile: if targetBaseUrl contains query params or fragments, the regex strip + concatenation will produce incorrect URLs. The `new URL(path, base)` constructor handles these edge cases correctly.
- Fix: If the prior behavior was dropping the base path (i.e., `new URL('/v1/chat/completions', base)` resolves to just `/v1/chat/completions` ignoring base path), document the reason for the change and use the URL API properly:
  ```typescript
  const base = new URL(this.config.targetBaseUrl);
  base.pathname = base.pathname.replace(/\/?$/, '') + '/chat/completions';
  const targetUrl = base;
  ```

### MEDIUM

**probeUrl silently swallows deep-probe network errors** - `src/utils/url-probe.ts:245-247`
**Confidence**: 82%
- Problem: When the deep probe (GET /models) encounters a network error but the base HEAD probe succeeded, the error is silently discarded and the base probe result is returned. The comment says "deep probe network error is unusual; report base" but this loses diagnostic information. A user who has DNS working but whose API endpoint is on a different port or path would get a false "ok" from the HEAD probe with no indication that the authentication check failed.
- Fix: Include a warning in the returned result when the deep probe fails:
  ```typescript
  if ('error' in deepResult) {
    const baseMessage = messageForStatus(statusCode, headers, parsedUrl, false);
    return ok({
      reachable: true,
      statusCode,
      message: `${baseMessage}. Note: API key validation failed (${deepResult.error.message})`,
      severity: 'warning',
      durationMs,
    });
  }
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**ProxiedClaudeAdapter overrides methods not defined on immediate parent** - `src/translation/proxy/proxied-claude-adapter.ts:73-88`
**Confidence**: 80%
- Problem: `resolveModel()` and `resolveAuth()` are defined on `BaseAgentAdapter` (grandparent), not on `ClaudeAdapter` (direct parent). While TypeScript's `override` keyword correctly validates against any ancestor, the class header JSDoc says it overrides three methods of ClaudeAdapter. This is architecturally misleading -- the class is reaching two levels up in the hierarchy. Future maintainers refactoring `BaseAgentAdapter` may not realize `ProxiedClaudeAdapter` depends on these specific signatures.
- Fix: Update the class-level JSDoc to clarify:
  ```typescript
  /**
   * Overrides three resolution methods inherited from the adapter hierarchy:
   * - resolveBaseUrl() (from ClaudeAdapter) -> proxy URL
   * - resolveModel() (from BaseAgentAdapter) -> suppresses backend model
   * - resolveAuth() (from BaseAgentAdapter) -> suppresses backend API key
   */
  ```

## Pre-existing Issues (Not Blocking)

No critical pre-existing issues found.

## Suggestions (Lower Confidence)

- **Version generation could race with concurrent builds** - `scripts/generate-version.mjs` (Confidence: 65%) -- The script writes to `src/generated/version.ts` without a lock. If two npm scripts run concurrently (e.g., `prebuild` and `pretypecheck` triggered in parallel by a CI matrix), the file could be partially written. Low risk in practice since these are typically sequential.

- **Container.registerValue silently ignores duplicate registration** - `src/bootstrap.ts:260` (Confidence: 60%) -- `registerValue` returns `Result<void>` but the return value is not checked. If for some reason `'database'` was already registered (defensive programming concern), the error would be silently dropped. All other `registerSingleton` calls also ignore the return, so this is a pre-existing pattern, not introduced by this PR.

- **`handleConfigureAgent` network call blocks MCP tool response** - `src/adapters/mcp-adapter.ts:3357` (Confidence: 70%) -- The `probeUrl` call with 5s timeout happens synchronously within the MCP tool handler. If the probe is slow, the MCP client (Claude) waits for the full timeout. Consider making the probe fire-and-forget or reducing the timeout for the "check" action path.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Architecture Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The PR demonstrates strong architectural thinking overall: the IR-based translation layer with proper codec separation is well-designed, the `ProxiedClaudeAdapter` override pattern correctly isolates Claude Code from backend config, the version generation script eliminates runtime `package.json` reads, and the URL probe utility follows project conventions (Result types, DI via requestFn). The blocking issues center on a database registration inconsistency (bare throw in a Result-returning function) and fragile URL construction that bypasses the URL API.
