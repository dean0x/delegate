# Regression Review Report

**Branch**: feat/api-translation-proxy -> main
**Date**: 2026-04-23

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

**ProxyManager not stopped during CLI-mode shutdown** - `src/index.ts:75-80`
**Confidence**: 82%
- Problem: The proxy shutdown is added to `src/index.ts` (MCP server entry point), but the CLI entry point (`src/cli.ts`) does not have a corresponding shutdown path. If bootstrap starts a proxy in CLI mode (mode `'cli'` or `'run'`), there is no shutdown handler to stop it. The `processSpawner` guard in bootstrap prevents proxy start when `options.processSpawner` is provided (test path), but production CLI modes do not inject a processSpawner.
- Impact: Orphaned HTTP listener on process exit in CLI mode. Node.js will close it on process exit anyway, but if the CLI process is long-lived (e.g., `beat orchestrate --foreground`), the proxy port stays open without cleanup.
- Fix: The bootstrap guard `if (!options.processSpawner)` is a proxy for "is this a test context." For CLI modes (mode `'cli'`), the proxy would still start. Verify that CLI entry points either (a) do not trigger proxy start (only `'server'` mode should), or (b) include a shutdown hook. Consider adding a mode check: `if (!options.processSpawner && mode === 'server')` to restrict proxy startup to the MCP server daemon context.

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Proxy startup blocks bootstrap for all agents** - `src/bootstrap.ts:377` (Confidence: 65%) -- The `await proxyManager.start()` call blocks the entire bootstrap sequence. If the target backend is slow to respond during the TCP listen, it delays server readiness for all agents (codex, gemini), not just claude. The TranslationProxy.start() binds to localhost so this should be fast, but if the constructor or middleware initialization has side effects that reach the network, it could be a concern.

- **No test for bootstrap fallback path when proxy fails** - `tests/unit/translation/proxy/bootstrap-proxy-integration.test.ts` (Confidence: 70%) -- The bootstrap-proxy-integration test covers `loadProxyConfig` and `ProxiedClaudeAdapter` construction, but does not test the fallback path in `bootstrap()` where `proxyResult.ok === false` results in standard `ClaudeAdapter` being used. This is the production fallback and is documented in the ARCHITECTURE comment but untested.

- **Commit message says "remove dead code" but no code was removed** - commit `9a9ee52` (Confidence: 72%) -- The commit `refactor(translation): simplify codecs and proxy -- remove dead code` implies code removal, but the diff shows only additions and modifications. No files were deleted and no exports were removed. This may indicate the simplification happened within new files (removing earlier iterations), but the commit message could be misleading for future archaeology.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | - | 0 | 0 |

**Regression Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Regression Checklist

- [x] No exports removed without deprecation
- [x] Return types backward compatible -- `AgentConfig` gains optional `translate` field (additive)
- [x] Default values unchanged -- `saveAgentConfig` key union widened, all existing values preserved
- [x] Side effects preserved (events, logging) -- all existing event handlers untouched
- [x] All consumers of changed code updated -- `loadAgentConfig`, `saveAgentConfig`, CLI, MCP adapter all updated consistently
- [x] Migration complete across codebase -- `translate` field added to all relevant consumers
- [x] CLI options preserved -- existing `apiKey|baseUrl|model` still work, `translate` added
- [x] API endpoints preserved -- MCP tools additive only
- [x] Commit messages match implementation -- new feature (translation proxy), no breaking changes
- [x] Breaking changes documented -- N/A (no breaking changes)

### Notes

This is a well-structured additive feature. The changes touch 5 existing files (package.json, mcp-adapter.ts, mcp-instructions.ts, bootstrap.ts, configuration.ts, agents.ts, index.ts) and add 20 new files. All modifications to existing files are backward-compatible:

1. `AgentConfig` interface gains an optional `translate` field -- additive, no consumer breaks
2. `saveAgentConfig` key union widened from `'apiKey' | 'baseUrl' | 'model'` to include `'translate'` -- additive
3. Bootstrap conditionally creates `ProxiedClaudeAdapter` instead of `ClaudeAdapter` -- guarded by config
4. The `processSpawner` guard ensures tests using injected spawners are unaffected by proxy logic
5. Shutdown handler in `src/index.ts` properly stops proxy before killing workers

The one HIGH finding relates to shutdown cleanup in non-MCP-server modes, which is a minor lifecycle concern rather than a functional regression.
