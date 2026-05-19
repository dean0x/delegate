# Resolution Summary

**Branch**: feat/134-system-prompt-support -> main
**Date**: 2026-04-17
**Review**: .docs/reviews/feat-134-system-prompt-support/2026-04-17_1641
**Command**: /resolve

## Statistics
| Metric | Value |
|--------|-------|
| Total Issues | 17 |
| Fixed | 16 |
| False Positive | 0 |
| Deferred | 1 |
| Blocked | 0 |

## Fixed Issues
| Issue | File:Line | Commit |
|-------|-----------|--------|
| Temp file permissions (0644 → 0o600/0o700) | gemini-adapter.ts:80, agents.ts:242 | 89de208 |
| Sync I/O in spawn (in-memory cache) | gemini-adapter.ts:61-81 | 89de208 |
| Combined prompt size validation (64KB cap) | gemini-adapter.ts:76-81 | 89de208 |
| Adapter-owned cleanup() method | agents.ts, base-agent-adapter.ts, gemini-adapter.ts, worker-pool.ts | 89de208 |
| Unconditional unlinkSync guard | event-driven-worker-pool.ts:305-312 | 89de208 |
| Schedule tools missing systemPrompt | schedule-manager.ts, schedule-handler.ts | 83d57c6 |
| v1.4.0 version references (14 occurrences) | 7 files | 5375614 |
| @design → DECISION: convention (9 occurrences) | 7 files | 5375614 |
| Remaining v1.4.0 refs (5 more) | domain.ts, mcp-adapter.ts | 399c8e0 |
| taskId undefined collision | base-agent-adapter.ts:193 | c003bb7 |
| CLI dash-prefix rejection | cli.ts:182, loop.ts:319, orchestrate.ts:164 | c003bb7 |
| beat status help text | help.ts:43 | c003bb7 |
| Adapter injection tests (15 tests) | agent-adapters.test.ts | 841bbfe |
| Persistence round-trip tests (4 tests) | task-repository.test.ts | 841bbfe |
| includeSystemPrompt MCP tests (5 tests) | mcp-adapter.test.ts | 841bbfe |
| CLI flag parsing tests (12 tests) | cli.test.ts, orchestrate.test.ts | 841bbfe |

## False Positives
None.

## Deferred to Tech Debt
| Issue | File:Line | Risk Factor |
|-------|-----------|-------------|
| Extract GeminiSystemPromptCache class | gemini-adapter.ts:52-110 | Architectural refactor (constructor signature change, DI update, test fixture changes). In-memory caching resolves the practical concern (sync I/O). Remaining asymmetry is cosmetic — appropriate for dedicated refactor PR. |

## Blocked
None.

## Test Summary
- **Before resolve**: 2,376 tests
- **After resolve**: 2,397 tests (+21 net, +36 new tests, -15 redistributed)
- All 8 grouped suites pass
- Typecheck + lint + build clean
