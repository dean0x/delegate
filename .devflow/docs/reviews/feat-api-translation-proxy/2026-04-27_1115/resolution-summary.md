# Resolution Summary

**Branch**: feat/api-translation-proxy -> main
**Date**: 2026-04-27_1115
**Review**: .docs/reviews/feat-api-translation-proxy/2026-04-27_1115
**Command**: /resolve

## Statistics
| Metric | Value |
|--------|-------|
| Total Issues Parsed | 78 |
| Unique Actionable | 17 |
| Fixed | 15 |
| False Positive | 1 |
| Deferred | 1 |
| Pre-existing/LOW | ~30 (not actionable) |

## Fixed Issues
| Issue | File:Line | Commit |
|-------|-----------|--------|
| Result contract violation (throw→err()) + DECISION comment on eager DB | src/bootstrap.ts:256-275 | 30d59c2 |
| API key logging safety comment | src/bootstrap.ts:412 | 30d59c2 |
| TLS error message: NODE_TLS_REJECT_UNAUTHORIZED→NODE_EXTRA_CA_CERTS | src/utils/url-probe.ts:146 | 440a3a2 |
| Scheme restriction (http/https only) for probeUrl | src/utils/url-probe.ts:212-221 | 440a3a2 |
| Unsafe `as NodeJS.ErrnoException` cast → instanceof narrowing | src/utils/url-probe.ts:101 | 440a3a2 |
| Deep probe warning field when network error swallowed | src/utils/url-probe.ts:245-247 | 440a3a2 |
| TLS error codes extracted to named Set constant | src/utils/url-probe.ts:121-151 | 440a3a2 |
| Merged messageForStatus/severityForStatus into statusResult() | src/utils/url-probe.ts:153-200 | 440a3a2 |
| Unbounded response body → MAX_BODY_BYTES cap | src/translation/proxy/translation-proxy.ts:484-488 | bb06778 |
| URL string concat → pre-computed URL in constructor | src/translation/proxy/translation-proxy.ts:389 | bb06778 |
| CheckPayload/SetPayload asymmetry → inlined both | src/adapters/mcp-adapter.ts:3366 | c82c1ca |
| Dynamic→static import for probeUrl in agents.ts | src/cli/commands/agents.ts:165 | c82c1ca |
| DESIGN comments on probe error handling asymmetry | src/adapters/mcp-adapter.ts:3361,3516 | c82c1ca |
| Exhaustive never check in serializeContentBlock | src/translation/codecs/anthropic-codec.ts:178 | b8199ad |
| O(n²) string concat → array accumulator for tool args | src/translation/codecs/openai-codec.ts:353,381 | b8199ad |

## False Positives
| Issue | File:Line | Reasoning |
|-------|-----------|-----------|
| probeUrl 5s latency on every MCP call | src/adapters/mcp-adapter.ts:3357 | Probe runs only on explicit ConfigureAgent check/set action, not per-call |

## Deferred to Tech Debt
| Issue | File:Line | Risk Factor |
|-------|-----------|-------------|
| handleConfigureAgent 220+ lines | src/adapters/mcp-adapter.ts:3326 | Pre-existing — file is 3500 lines (7x threshold). Extracting methods requires module boundary analysis. |

## Simplifier Pass
| Change | File |
|--------|------|
| Removed duplicate logger resolution (10 lines) | src/bootstrap.ts |
| Removed redundant checkPayload inline type annotation | src/adapters/mcp-adapter.ts |
| Removed single-use targetUrl and isStreaming intermediates | src/translation/proxy/translation-proxy.ts |
| Corrected misleading TLS docstring | src/utils/url-probe.ts |

## Commits Created
- 30d59c2 fix(bootstrap): restore Result contract and document eager DB registration
- 440a3a2 fix(url-probe): address batch-2 review issues
- bb06778 fix(translation-proxy): cap response body size and pre-compute target URL
- c82c1ca fix(config): resolve batch-4 consistency issues in probe handling
- b8199ad fix(translation): exhaustive switch and array accumulator in codecs
- f6120e0 refactor: simplify resolver fixes — remove duplicate logger, redundant intermediates
