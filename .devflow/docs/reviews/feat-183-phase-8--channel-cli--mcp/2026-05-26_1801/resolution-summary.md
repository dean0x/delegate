# Resolution Summary

**Branch**: feat/183-phase-8--channel-cli--mcp -> main
**Date**: 2026-05-26_1801
**Review**: .devflow/docs/reviews/feat-183-phase-8--channel-cli--mcp/2026-05-26_1801
**Command**: /resolve

## Decisions Citations

- applies ADR-001 — batch-3 (sec-2, cmplx-1), batch-5 (ts-1), batch-7 (test-1, test-3)
- applies ADR-002 — batch-4 (arch-4: displayReason dead code removal)
- applies ADR-003 — batch-1 (all issues introduced by PR, not pre-existing)
- avoids PF-001 — batch-1, batch-3, batch-4, batch-6, batch-7 (all fixed in-scope, none deferred)

## Statistics
| Metric | Value |
|--------|-------|
| Total Issues | 22 |
| Fixed | 19 |
| False Positive | 2 |
| Deferred | 0 |
| Blocked | 0 |

## Fixed Issues
| Issue | File:Line | Commit |
|-------|-----------|--------|
| systemPrompt description contradicts code ("overrides" → "fallback") | src/adapters/mcp-adapter.ts:600,:1936 | 7c2ecab |
| Extract requireChannelService() for 7 handlers | src/adapters/mcp-adapter.ts:4247+ | 7c2ecab |
| Unsafe `as AgentProvider` cast → z.enum(AGENT_PROVIDERS_TUPLE) | src/adapters/mcp-adapter.ts:576 | 7c2ecab |
| Missing .max(262_144) on topic in CreateChannelSchema | src/adapters/mcp-adapter.ts:594 | 7c2ecab |
| Extract buildChannelCreateRequest() from handleCreateChannel | src/adapters/mcp-adapter.ts:4238 | 7c2ecab |
| workingDirectory validatePath baseDir '/' for MCP context | src/adapters/mcp-adapter.ts:4273 | 9662718 |
| Split parseChannelCreateArgs into tokenize + validate | src/cli/commands/channel.ts:74 | 27983b0 |
| Missing topic CLI length limit for --topic | src/cli/commands/channel.ts:110 | 27983b0 |
| resolveChannelId swallows errors → returns Result | src/cli/commands/channel.ts:289 | 27983b0 |
| Container disposal on process.exit in handleChannelCreate + resolveChannelOp | src/cli/commands/channel.ts:314,537 | 27983b0 |
| handleChannelCommand JSDoc | src/cli/commands/channel.ts:252 | 27983b0 |
| Duplicate "Members:" label → "Member count:" + separator | src/cli/commands/channel.ts:453 | e87c340 |
| Dead displayReason parameter removed from channel destroy | src/cli/commands/channel.ts:528 | e87c340 |
| Missing memberName validation in parseMsgArgs (ADR-001) | src/cli/commands/msg.ts:73 | 5c5c2bc |
| Duplicate status-check blocks → REJECTED_STATUSES map | src/cli/commands/msg.ts:131 | 5c5c2bc |
| handleMsgCommand JSDoc | src/cli/commands/msg.ts:91 | 5c5c2bc |
| SerialQueue drain timeout race → cancellation token | src/services/channel-manager.ts:453 | b4023aa |
| sendMessage JSDoc missing COMPLETED rejection | src/core/interfaces.ts:1072 | b4023aa |
| Bootstrap channel recovery missing .catch() | src/bootstrap.ts:780 | b4023aa |

## Test Coverage Added
| Test | File | Commit |
|------|------|--------|
| --system-prompt at 100,000 char limit (pass) | tests/unit/cli/channel.test.ts | 52553b7 |
| --system-prompt over 100,000 chars (reject) | tests/unit/cli/channel.test.ts | 52553b7 |
| --working-directory path traversal (reject) | tests/unit/cli/channel.test.ts | 52553b7 |
| -a shorthand for --agent | tests/unit/cli/channel.test.ts | 52553b7 |
| -w shorthand for --working-directory | tests/unit/cli/channel.test.ts | 52553b7 |
| --topic at 262,144 char limit (pass) | tests/unit/cli/channel.test.ts | 27983b0 |
| --topic over 262,144 chars (reject) | tests/unit/cli/channel.test.ts | 27983b0 |
| memberName validation with CHANNEL_NAME_REGEX | tests/unit/cli/msg.test.ts | 5c5c2bc |

## False Positives
| Issue | File:Line | Reasoning |
|-------|-----------|-----------|
| Container disposal on process.exit in msg.ts | src/cli/commands/msg.ts:104-108 | CLI commands only open SQLite connections; process.exit() triggers OS cleanup. Dispose-before-exit is only used for long-lived sessions (orchestrate-interactive.ts). Adding it here would create inconsistency with all other CLI mutation commands. |
| handleChannelStatus 70 lines with 5-level nesting | src/adapters/mcp-adapter.ts:4364 | Matches established pattern: handleLoopStatus (80+ lines), handleOrchestratorStatus use identical structure. Extracting serialization would create inconsistency with every other status handler. The null check inside match() is necessary; restructuring away from match() would diverge from codebase convention. |

## Deferred to Tech Debt
(none)

## Blocked
(none)

## Pre-existing Issues (Not Blocking, Not Resolved)
| Issue | Source | Notes |
|-------|--------|-------|
| MCPAdapter at 4,622+ lines (god class) | architecture review | Pre-existing. Future: extract handler families into modules. |
| Dual Zod + JSON Schema definitions | architecture, complexity reviews | Pre-existing. Future: generate JSON Schema from Zod. |
| callTool switch with 41+ cases | complexity review | Pre-existing. Future: dispatch table Map. |
| SerialQueue unbounded backpressure | reliability review | Pre-existing. Future: bounded capacity with backpressure. |
| N+1 query in rowToChannel() | performance review | Pre-existing, documented in code. Bounded by DEFAULT_LIMIT=100. |
| 6 npm audit vulnerabilities | dependencies review | Pre-existing on main. Address in separate maintenance PR. |
