# Resolution Summary

**Branch**: feat/agent-skill -> main
**Date**: 2026-03-31_0957
**Review**: .docs/reviews/feat-agent-skill/2026-03-31_0957
**Command**: /resolve

## Statistics
| Metric | Value |
|--------|-------|
| Total Issues | 9 |
| Fixed | 9 |
| False Positive | 0 |
| Deferred | 0 |
| Blocked | 0 |

## Fixed Issues
| Issue | File:Line | Commit |
|-------|-----------|--------|
| Incorrect MCP param name (`orchestrationId` → `orchestratorId`) | `src/adapters/mcp-instructions.ts:63` | 877c3d6 |
| Variable `p` shadows `@clack/prompts` import | `src/cli/commands/init.ts:479,490` | c9b23ff |
| `process.cwd()` not injected via InitDeps | `src/cli/commands/init.ts:277` | c9b23ff |
| Duplicated skill-path display logic | `src/cli/commands/init.ts:477-493` | c9b23ff |
| Stale files persist after `cpSync` update | `src/cli/commands/init.ts:162` | c9b23ff |
| `parseSkillsAgents` uses union instead of Result type | `src/cli/commands/init.ts:175` | c9b23ff |
| `defaultCopySkills` uses ad-hoc shape instead of Result type | `src/cli/commands/init.ts:148` | c9b23ff |
| Missing flags in capability matrix | `skills/autobeat/references/capability-matrix.md:413` | 8bfbfbf |
| CLAUDE.md missing new file locations | `CLAUDE.md` | 8bfbfbf |

## Simplification
| File | Change | Commit |
|------|--------|--------|
| `src/cli/commands/init.ts` | Removed empty no-op `if (options.yes)` block, inverted guard condition | d55c784 |

## False Positives
None.

## Deferred to Tech Debt
None.

## Blocked
None.
