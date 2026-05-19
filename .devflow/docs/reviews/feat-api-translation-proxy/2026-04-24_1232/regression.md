# Regression Review Report

**Branch**: feat/api-translation-proxy -> main
**Date**: 2026-04-24
**Commits**: 10 (bfc92a5...a7945c2)

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Stale JSDoc reference after constant relocation** - `src/core/configuration.ts:232`
**Confidence**: 90%
- Problem: The JSDoc on `TranslateTarget` says "Single source of truth -- kept in sync with SUPPORTED_TRANSLATE_TARGETS in proxy-manager.ts" but the `SUPPORTED_TRANSLATE_TARGETS` constant was removed from `proxy-manager.ts` in this PR. It now lives in `src/cli/commands/agents.ts:23`. The comment directs developers to a file that no longer contains the referenced constant.
- Fix:
  ```typescript
  // configuration.ts:232
  * Single source of truth — kept in sync with SUPPORTED_TRANSLATE_TARGETS in agents.ts (CLI boundary validation).
  ```

**`loadAgentConfig` silently drops unrecognized translate values** - `src/core/configuration.ts:258`
**Confidence**: 82%
- Problem: Before this PR, `loadAgentConfig` returned any string stored in `translate` (via `typeof record.translate === 'string'`). Now it only returns `'openai'` and maps everything else to `undefined`. If a user previously saved `translate: 'some-future-target'` in their config.json, upgrading would silently lose that value with no warning. The value remains in the JSON file but `loadAgentConfig` will not surface it. Combined with the CLI `agents config show` path (`src/cli/commands/agents.ts:192-193`), this means the user's translate config would disappear from view without explanation.
- Fix: This is acceptable behavior IF the prior code never accepted targets other than `'openai'`. Since the MCP adapter and CLI both previously lacked validation at the save boundary (the validation was only in `loadProxyConfig` which returned null), a user could have saved an invalid target. The behavioral change is correct (validate early), but a migration note or log warning would prevent confusion. A low-risk approach:
  ```typescript
  // configuration.ts:258
  translate: record.translate === 'openai'
    ? (record.translate as TranslateTarget)
    : typeof record.translate === 'string' && record.translate !== ''
      ? (/* unknown translate target stored — log or warn */ undefined)
      : undefined,
  ```

## Issues in Code You Touched (Should Fix)

No issues found.

## Pre-existing Issues (Not Blocking)

No critical pre-existing issues detected.

## Suggestions (Lower Confidence)

- **StreamTranslator inlines middleware loop instead of delegating to `runStreamEventMiddleware`** - `src/translation/proxy/stream-translator.ts:100-109` (Confidence: 65%) -- The `applyMiddleware` method now manually iterates `reversedMiddlewares` instead of calling the exported `runStreamEventMiddleware` helper. The logic is identical (reverse + null short-circuit), but the duplication means a future bug fix to `runStreamEventMiddleware` would not propagate here. The pre-computation of `reversedMiddlewares` is the reason for the divergence, which is a reasonable performance decision for hot-path streaming. Worth considering whether `runStreamEventMiddleware` could accept a pre-reversed array parameter to keep the single implementation.

- **`TranslationProxyConfig.middlewares` renamed to `middlewareFactory` without deprecation** - `src/translation/proxy/translation-proxy.ts:44` (Confidence: 62%) -- The `TranslationProxyConfig` interface changed the `middlewares` property to `middlewareFactory` (different name and type). Since this is an internal interface with only two consumers (proxy-manager.ts and tests), the risk is low. However, if any external code constructs a `TranslationProxyConfig`, it would fail at compile time. The test file was updated (`middlewareFactory: () => []`), and the only production consumer (proxy-manager.ts) was updated. All consumers appear migrated.

- **Three separate validation lists for translate targets** - `src/core/configuration.ts:235`, `src/cli/commands/agents.ts:23`, `src/adapters/mcp-adapter.ts:351` (Confidence: 70%) -- The valid translate targets are defined in three places: the `TranslateTarget` type union (`'openai'`), the CLI `SUPPORTED_TRANSLATE_TARGETS` array, and the MCP Zod schema `z.enum(['openai', ''])`. Adding a new target requires updating all three. The JSDoc already acknowledges the sync requirement, but a shared constant or Zod-derived type would prevent drift.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Regression Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The PR introduces no functional regressions. The refactoring in openai-codec.ts (tool call re-keying with `openaiToCanonicalIndex` map) is well-tested with 3 new test cases covering the exact bug it fixes (text-then-tool-call index mismatch). The `middlewares` to `middlewareFactory` migration is complete across all consumers. The bootstrap mode-gating (`server` only) correctly prevents proxy startup in CLI modes. The anthropic-codec switch/case refactor is a pure structural transformation with identical logic branches.

The two MEDIUM findings are documentation drift (stale JSDoc reference) and a minor behavioral narrowing (translate value loading). Neither affects runtime correctness for the supported `'openai'` target. The conditions for approval are: fix the stale JSDoc reference before merge.
