# Regression Review Report

**Branch**: feat/api-translation-proxy -> main
**Date**: 2026-04-27
**Commits**: 18 (b264c57...ba527e8)

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

**ThinkingDeltaEvent breaking type change** - `src/translation/ir.ts:218-222`
**Confidence**: 90%
- Problem: `ThinkingDeltaEvent` gained a required `index` field (was previously `{ type: 'thinking_delta'; thinking: string }`). Any external consumer constructing or pattern-matching on `ThinkingDeltaEvent` without the `index` field will get a compile error. This is a breaking change to a public type exported from `src/translation/ir.ts`.
- Impact: External code or plugins consuming the canonical IR types (e.g. custom middleware or stream processors) will break on upgrade. Internal code is fully migrated (OpenAI codec, Anthropic codec, tests all updated).
- Fix: If the translation IR is considered internal-only, this is acceptable with a documented note. If it is part of the public API surface, a migration note in CHANGELOG is required. Given `src/utils/index.ts` re-exports from `url-probe.ts` but does NOT re-export IR types, this is likely internal-only. Verify that no external consumers import from `src/translation/ir.ts` directly. If internal-only, the severity drops to MEDIUM.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Database registration changed from lazy to eager** - `src/bootstrap.ts:256-275`
**Confidence**: 82%
- Problem: Database was previously registered as `registerSingleton('database', () => new Database(...))` (lazy -- created on first access). Now it is `registerValue('database', db)` (eager -- created immediately). This changes the timing of database initialization and means the database file is opened even if no code path in the current execution needs it.
- Impact: Low impact in practice -- all bootstrap callers (MCP server, CLI commands, dashboard) use repositories that require the database. The change enables the NODE_MODULE_VERSION error detection, which is a user experience improvement. No functional regression detected.
- Fix: No action needed. The behavioral change is intentional and the eager initialization provides better error messages. Noting for completeness.

**`handleConfigureAgent` changed from sync to async** - `src/adapters/mcp-adapter.ts:3326`
**Confidence**: 85%
- Problem: `handleConfigureAgent` changed from `private handleConfigureAgent(args): MCPToolResponse` to `private async handleConfigureAgent(args): Promise<MCPToolResponse>`. The call site at line 640 was updated from `return this.handleConfigureAgent(args)` to `return await this.handleConfigureAgent(args)`. This is correct for the internal call chain, but if any test or consumer was type-checking the return value of `callTool('ConfigureAgent', ...)` synchronously, it would need updating.
- Impact: The `callTool` method in MCP adapter already returns `Promise<MCPToolResponse>`, so the async change is compatible. All tests pass the result through `await`. No regression detected.
- Fix: No action needed -- the async change is properly propagated through the existing async call chain.

## Pre-existing Issues (Not Blocking)

(none detected at CRITICAL severity)

## Suggestions (Lower Confidence)

- **targetBaseUrl path construction change** - `src/translation/proxy/translation-proxy.ts:389` (Confidence: 70%) -- The URL construction changed from `new URL('/v1/chat/completions', this.config.targetBaseUrl)` to `new URL(this.config.targetBaseUrl.replace(/\/$/, '') + '/chat/completions')`. This preserves path prefixes in the target URL (e.g. `http://host/v1` becomes `http://host/v1/chat/completions` instead of being stripped to `http://host/v1/chat/completions`). The old behavior silently dropped the path component of `targetBaseUrl` when it contained `/v1`. The test was updated to match. This is a bug fix, not a regression, but the behavioral difference could affect users with unusual `targetBaseUrl` configurations that relied on the old (broken) path-stripping behavior.

- **`flush()` behavior change in OpenAI stream parser** - `src/translation/codecs/openai-codec.ts:481-486` (Confidence: 65%) -- `flush()` previously returned `[]` unconditionally. Now it closes any open thinking or text blocks. This is a correctness improvement (prevents dangling open blocks on abrupt stream termination) but changes observable behavior -- a consumer calling `flush()` on a parser with an open thinking block will now receive `thinking_stop` events.

- **`build:dev` and `build:watch` now require `scripts/generate-version.mjs` to run first** - `package.json:50-51` (Confidence: 60%) -- If the script fails (e.g. missing node_modules during initial setup), the build commands will fail with an error that may be confusing. The `clean` script also now removes `src/generated/`, so a `clean` followed by `build:dev` without `generate-version.mjs` would leave the project in a broken state until the script runs.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 0 | - |
| Should Fix | - | 0 | 2 | - |
| Pre-existing | - | - | 0 | 0 |

**Regression Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Conditions:
1. Confirm `ThinkingDeltaEvent` (and the new `ThinkingStartEvent`/`ThinkingStopEvent` types) are internal-only and not part of the published API surface. If they are internal, the HIGH finding drops to informational.

### Regression Checklist:
- [x] No exports removed without deprecation (verified: no `^-export` lines in diff)
- [x] No files deleted
- [x] Return types backward compatible (handleConfigureAgent: sync->async, but call chain was already async)
- [x] Default values unchanged
- [x] Side effects preserved (events, logging)
- [x] All consumers of changed code updated (showHelp, VERSION import, ThinkingDeltaEvent)
- [x] Migration complete across codebase (grep confirms no stale `pkg.version` or `readFileSync` for version)
- [x] CLI options preserved (no removed flags)
- [x] API endpoints preserved (HEAD / added, no endpoints removed)
- [x] Commit messages match implementation (verified 18 commits)
- [x] Tests updated for all behavioral changes (thinking lifecycle, URL probe, proxy adapter overrides, bootstrap database)
- [ ] Breaking changes documented in CHANGELOG (ThinkingDeltaEvent type change -- verify internal-only)
