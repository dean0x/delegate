# Resolution Summary

**Branch**: feat/183-phase-8--channel-cli--mcp -> main
**Date**: 2026-05-26_1709
**Review**: .devflow/docs/reviews/feat-183-phase-8--channel-cli--mcp/2026-05-26_1709
**Command**: /resolve

## Decisions Citations

- applies ADR-001 — batch-1, issue #3 (regex import from domain.ts)
- avoids PF-001 — all batches (no issues deferred to future PR without justification)

## Statistics
| Metric | Value |
|--------|-------|
| Total Issues | 16 |
| Fixed | 14 |
| False Positive | 0 |
| Deferred | 2 |
| Blocked | 0 |

## Fixed Issues
| Issue | File:Line | Commit |
|-------|-----------|--------|
| MCP CreateChannel drops systemPrompt | src/adapters/mcp-adapter.ts:4272 | 625ac78 |
| MCP JSON schema missing systemPrompt | src/adapters/mcp-adapter.ts:1937 | 625ac78 |
| Duplicated channel name regex | src/adapters/mcp-adapter.ts:569 | 625ac78 |
| DestroyChannel handler ignores reason | src/adapters/mcp-adapter.ts:4336 | 625ac78 |
| CLI --limit unbounded | src/cli/commands/channel.ts:387 | 0b1ce96 |
| CLI --system-prompt no length limit | src/cli/commands/channel.ts:121 | 0b1ce96 |
| Double DB in destroy/pause/resume | src/cli/commands/channel.ts:300-510 | 0b1ce96 |
| DestroyChannel CLI reason clarified | src/cli/commands/channel.ts:510 | 0b1ce96 |
| Help text missing channel examples | src/cli/commands/help.ts | 0b1ce96 |
| CLI msg no message length limit | src/cli/commands/msg.ts:50 | fc9eb1d |
| Double DB + TOCTOU in msg command | src/cli/commands/msg.ts:91-124 | fc9eb1d |
| withServices() eager channelService | src/cli/services.ts:107 | 07eef81 |
| Async mcpAdapter factory | src/bootstrap.ts:714 | 07eef81 |
| Missing service-unavailable tests (6 handlers) | tests/unit/adapters/mcp-adapter.test.ts | 508b42e |

## Deferred to Tech Debt
| Issue | File:Line | Risk Factor |
|-------|-----------|-------------|
| DestroyChannel naming deviates from Cancel* convention | src/adapters/mcp-adapter.ts:783 | Naming change is API-breaking; intentional per plan design decision |
| Repetitive MCP handler boilerplate (7 handlers) | src/adapters/mcp-adapter.ts:4233-4594 | Pre-existing pattern across all MCP tool families; extraction tracked per ADR-003 |

## Blocked
_(none)_
