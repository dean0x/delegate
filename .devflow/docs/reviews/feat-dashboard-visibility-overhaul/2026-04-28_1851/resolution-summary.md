# Resolution Summary

**Branch**: feat/dashboard-visibility-overhaul → main
**Date**: 2026-04-28
**Review**: .docs/reviews/feat-dashboard-visibility-overhaul/2026-04-28_1851/
**Command**: /resolve

## Statistics
| Metric | Value |
|--------|-------|
| Total Issues | 26 |
| Fixed | 24 |
| False Positive | 2 |
| Deferred | 0 |
| Blocked | 0 |

## Fixed Issues

### Batch 1: Visual Polish
| Issue | File:Line | Commit |
|-------|-----------|--------|
| H10: Tile borders missing borderColor="gray" | resources-tile.tsx, cost-tile.tsx, throughput-tile.tsx | `5cee64d` |
| H11: Cost tile missing cacheCreationInputTokens display | cost-tile.tsx:34 | `5cee64d` |
| H12: Activity feed uses padEnd instead of Box layout | activity-panel.tsx:57 | `5cee64d` |
| SF4: Activity feed column widths mismatch | activity-panel.tsx:35 | `5cee64d` |
| SF5: active status color cyan → green | format.ts:52 | `5cee64d` |

### Batch 2: Dashboard Views
| Issue | File:Line | Commit |
|-------|-----------|--------|
| H5: TaskDetail missing deps/usage data resolution | detail-view.tsx:58 | `f55e52e` |
| H6: Entity browser missing agent column | entity-browser-panel.tsx | `f55e52e` |
| H7: No truncation notice when FETCH_LIMIT reached | entity-browser-panel.tsx | `f55e52e` |
| H9: handleActivitySelect missing pipeline case | app.tsx:167 | `f55e52e` |
| SF3: Streaming gated on workspace view kind (TODO added) | app.tsx:140 | `f55e52e` |

### Batch 3: Keyboard + Workspace
| Issue | File:Line | Commit |
|-------|-----------|--------|
| H8: Activity feed Enter missing pipelines case | handle-main-keys.ts:109 | `107ea33` |
| SF1: v toggle missing in orchestration detail | use-keyboard.ts:66 | `107ea33` |
| SF2: w shortcut missing edge cases | use-keyboard.ts:82 | `107ea33` |

### Batch 4: Cleanup + Detail Interactivity
| Issue | File:Line | Commit |
|-------|-----------|--------|
| M4: CountsPanel dead code still on disk | counts-panel.tsx | `f55e52e` |
| M7: LoopDetail iteration rows not selectable (TODO) | loop-detail.tsx:144 | `f55e52e` |
| M8: ScheduleDetail execution rows not selectable (TODO) | schedule-detail.tsx:122 | `f55e52e` |

### Batch 5: Pipeline Events + DIP
| Issue | File:Line | Commit |
|-------|-----------|--------|
| H1: PipelineCreated event never emitted | schedule-manager.ts:419 | `4661a93` |
| H2: PipelineStatusChanged event never emitted | pipeline-handler.ts:197 | `4661a93` |
| H3: PipelineStepCompleted event never emitted | pipeline-handler.ts:89 | `4661a93` |
| SF6: DIP violation — PipelineHandler depends on concrete class | pipeline-handler.ts:19, interfaces.ts | `4661a93` |
| M1: stepTaskIds never populated with actual task IDs | schedule-manager.ts:402, pipeline-handler.ts | `4661a93` |

### Batch 6: MCP + Database
| Issue | File:Line | Commit |
|-------|-----------|--------|
| H4: CancelPipeline missing cascade cancellation | mcp-adapter.ts:350 | `51b458c` |
| M2: PipelineStatus tool does not resolve step tasks | mcp-adapter.ts:3674 | `51b458c` |
| SF7: Missing IF NOT EXISTS on migration v24 indexes | database.ts:981 | `51b458c` |

## False Positives
| Issue | File:Line | Reasoning |
|-------|-----------|-----------|
| M3: ReadOnlyContext missing dependencyRepository | read-only-context.ts:41 | No consumer of ReadOnlyContext uses dependencyRepository. Task detail dependency refs are computed inline from the existing tasks list in detail-view.tsx. Adding it would be scope creep. |
| M4b: MCP instructions missing pipeline tool docs | mcp-instructions.ts | Pipeline tools (PipelineStatus, ListPipelines, CancelPipeline) already documented at lines 81-82, 89. |

## Deferred to Tech Debt
(none)

## Blocked
(none)

## Test Fix Commit
| Commit | Description |
|--------|-------------|
| `84329eb` | Updated 3 test files for intentional behavior changes: active→green color, w shortcut edge cases, TaskId branded type cast |

## Note
Commit `99325b6` is a stray loop auto-commit that should be squashed before merge (contains detail-view.tsx change that's also in `84329eb`).
