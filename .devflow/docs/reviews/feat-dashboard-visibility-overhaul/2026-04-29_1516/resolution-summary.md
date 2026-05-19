# Resolution Summary

**Branch**: feat/dashboard-visibility-overhaul -> main
**Date**: 2026-04-29
**Review**: .docs/reviews/feat-dashboard-visibility-overhaul/2026-04-29_1516
**Command**: /resolve

## Statistics
| Metric | Value |
|--------|-------|
| Total Issues | 21 |
| Fixed | 15 |
| False Positive | 1 |
| Deferred | 0 |
| Skipped (pre-existing) | 5 |

## Fixed Issues
| Issue | File:Line | Commit |
|-------|-----------|--------|
| CancelPipeline cancelTasks cascade not implemented | `mcp-adapter.ts:3785` | `7e3d054` |
| Unsafe `as Task` cast bypasses union narrowing | `mcp-adapter.ts:3690` | `7e3d054` |
| Sequential N+1 task lookups in updatePipelineStatus | `pipeline-handler.ts:230` | `c0442ac` |
| Race condition docs in handleScheduleExecuted | `pipeline-handler.ts:113` | `c0442ac` |
| Dead code: CostTile, ThroughputTile, ActivityPanel | 3 source + 3 test files | `8b847f5` |
| Duplicate formatCost/formatTokens/formatDurationMs | `stats-tile.tsx:30` | `8b847f5` |
| getEntityDisplayFields repetitive switch pattern | `entity-browser-panel.tsx:46` | `c48ad5d` |
| No tests for PipelineHandler event handling | `pipeline-handler.ts:97` | `cdb9a54` |
| No tests for findActiveByStepScheduleId | `pipeline-repository.ts:320` | `cdb9a54` |
| No tests for StatsTile component | `stats-tile.tsx:1` | `ba9c3f1` |
| `as never` cast in workspace-keyboard test | `workspace-keyboard.test.tsx:169` | `f2f0083` |
| Missing test: w no-op when no orchestrations | `use-keyboard.ts:100` | `f2f0083` |
| Missing test: v from orchestration detail | `use-keyboard.ts:72` | `f2f0083` |
| DetailView inline dependency resolution logic | `detail-view.tsx:48` | `f2f0083` |
| Simplifier: cacheSavings alias, async wrappers | `stats-tile.tsx`, `pipeline-handler.ts` | `b477f51` |

## False Positives
| Issue | File:Line | Reasoning |
|-------|-----------|-----------|
| handleMainKeys Enter 5-arm switch repetition | `handle-main-keys.ts:91` | Each arm casts to a distinct branded type (TaskId, LoopId, etc.). A PanelId→string lookup map cannot satisfy the discriminated union overloads without equivalent casts. The switch provides implicit exhaustiveness. Converting to a map would add indirection without improving type safety. |

## Skipped (Pre-existing, Non-blocking)
| Issue | File:Line | Reasoning |
|-------|-----------|-----------|
| Migration v24 index changed retroactively | `database.ts:981` | Safe — IF NOT EXISTS is idempotent |
| findActiveByTaskId full-table scan | `pipeline-repository.ts:303` | Bounded by active pipeline count |
| mcp-adapter.ts 3,858 lines | `mcp-adapter.ts` | Known tech debt, not this PR |
| getMigrations() ~700 lines | `database.ts:262` | Append-only migrations, inherent |
| openDetail function unused | `types.ts:124` | Low priority dead export |

## Commits Created
- `c48ad5d` refactor(dashboard): extract findAndMap helper in getEntityDisplayFields
- `8b847f5` refactor(dashboard): delete dead tiles, move formatCost/formatTokens to format.ts
- `7e3d054` fix(pipeline): wire cancelTasks cascade in CancelPipeline, fix unsafe Task cast
- `c0442ac` perf(pipeline-handler): parallelize step task lookups, document sequential-dispatch invariant
- `ba9c3f1` test(dashboard): add StatsTile component tests
- `cdb9a54` test(pipeline): add tests for handleScheduleExecuted and findActiveByStepScheduleId
- `f2f0083` refactor(dashboard): resolve batch-2g review issues
- `8f164c6` style: fix biome formatting across resolver commits
- `b477f51` simplify: remove cacheSavings alias and redundant async wrappers
