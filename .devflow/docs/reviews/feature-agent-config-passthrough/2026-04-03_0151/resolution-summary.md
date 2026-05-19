# Resolution Summary

**Branch**: feature/agent-config-passthrough -> main
**Date**: 2026-04-03
**Review**: .docs/reviews/feature-agent-config-passthrough/2026-04-03_0151
**Command**: /resolve

## Statistics
| Metric | Value |
|--------|-------|
| Total Issues | 12 |
| Fixed | 10 |
| False Positive | 1 |
| Deferred | 0 |
| Blocked | 0 |

## Fixed Issues
| Issue | File:Line | Commit |
|-------|-----------|--------|
| Zod schemas strip `model` on DB roundtrip (4 schemas) | loop-repository.ts:87, schedule-repository.ts:78,102,118 | e98f9d8 |
| Orchestration `model` not persisted (migration v17 + repo) | orchestration-repository.ts, database.ts:757 | e98f9d8 |
| Triple `loadAgentConfig()` per spawn consolidated to 1 | base-agent-adapter.ts:76,103,116 | c33befb |
| ConfigureAgent `set` partial-write risk (collect-all pattern) | mcp-adapter.ts:3015-3048 | c243c25 |
| JSON Schema `model` validation inconsistent (8 locations) | mcp-adapter.ts (multiple) | c243c25 |
| `Record<string, unknown>` replaced with typed interfaces | mcp-adapter.ts:2961,3049 | c243c25 |
| Duplicated Claude baseUrl warning extracted to helper | mcp-adapter.ts:2688,2968,3038 | c243c25 |
| CLI baseUrl missing URL validation | agents.ts:119 | 490d24a |
| No tests for model in retry/resume | task-manager.test.ts | 2b91dc9 |
| No tests for schedule/pipeline model threading | schedule-manager.test.ts | 2b91dc9 |

## False Positives
| Issue | File:Line | Reasoning |
|-------|-----------|-----------|
| Duplicate test blocks (4x Claude baseUrl warning) | mcp-adapter.test.ts:2776 | Only one instance exists in the current file. Diff rendering artifact from review. |

## Deferred to Tech Debt
None.

## Blocked
None.

## Simplification
- Removed inline interface/type declarations from `case` blocks in ConfigureAgent handler
- Tightened `getClaudeBaseUrlWarning` parameter type from `string` to `AgentProvider`
- Eliminated redundant `loadAgentConfig` call in ConfigureAgent `set` case
- Renamed verbose warning variables for consistency

## Commits Created (resolution)
- `e98f9d8` fix: restore model field through persistence round-trip for loops, schedules, and orchestrations
- `c33befb` perf: load agent config once per spawn instead of three times
- `c243c25` fix: resolve batch-c issues in ConfigureAgent and JSON Schema model constraints
- `490d24a` fix: validate baseUrl in CLI agents config set command
- `2b91dc9` test: add model threading coverage for retry, resume, and schedule paths (batch-e)
