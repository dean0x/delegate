# Resolution Summary

**Branch**: feat/agent-eval-mode -> main
**Date**: 2026-03-30
**Review**: .docs/reviews/feat-agent-eval-mode/2026-03-30_1214
**Command**: /resolve

## Statistics
| Metric | Value |
|--------|-------|
| Total Issues | 31 |
| Fixed | 26 |
| False Positive | 0 |
| Deferred | 0 |
| Blocked | 0 |
| Pre-existing (skipped) | 5 |

## Fixed Issues

### Batch 1: MCP Adapter (7 issues)
| Issue | File:Line | Commit |
|-------|-----------|--------|
| JSON Schema CreateLoop requires exitCondition | mcp-adapter.ts:1043 | 7065025 |
| JSON Schema ScheduleLoop requires exitCondition | mcp-adapter.ts:1180 | 7065025 |
| JSON Schema CreateLoop missing evalMode/evalPrompt | mcp-adapter.ts:966-1044 | 7065025 |
| JSON Schema ScheduleLoop missing evalMode/evalPrompt | mcp-adapter.ts:1146-1181 | 7065025 |
| Unsafe `as` casts on evalMode | mcp-adapter.ts:2181,2512 | b7937af |
| No `.max()` on evalTimeout in Zod | mcp-adapter.ts:255 | 7065025 |
| Schema default inconsistency (ScheduleLoop) | mcp-adapter.ts:317 | 3215a56 |

### Batch 2: Loop Handler (2 issues)
| Issue | File:Line | Commit |
|-------|-----------|--------|
| Duplicated cleanup blocks (3 locations) | loop-handler.ts:294-326 | f42d7bd |
| Stale guard runs for shell mode unnecessarily | loop-handler.ts:282 | f42d7bd |

### Batch 3: EvalMode Enum (2 issues)
| Issue | File:Line | Commit |
|-------|-----------|--------|
| String literal union instead of enum | domain.ts:536 | b7937af |
| Missing exhaustive default in composite evaluator | composite-exit-condition-evaluator.ts:17 | b7937af |

### Batch 4: Agent Evaluator (4 issues)
| Issue | File:Line | Commit |
|-------|-----------|--------|
| Unbounded evalFeedback storage | agent-exit-condition-evaluator.ts:235 | e022f5b |
| Output join-then-split round-trip | agent-exit-condition-evaluator.ts:114 | e022f5b |
| Eval task lacks read-only instruction | agent-exit-condition-evaluator.ts:47 | e022f5b |
| Mixed naming: outputRepository vs loopRepo | agent-exit-condition-evaluator.ts:34 | e022f5b |

### Batch 5: Schedule Manager (1 issue)
| Issue | File:Line | Commit |
|-------|-----------|--------|
| Validation blocks agent-mode scheduled loops | schedule-manager.ts:485 | 942c2c7 |

### Batch 6: Manager/Prompt/CLI (3 issues)
| Issue | File:Line | Commit |
|-------|-----------|--------|
| No evalMode validation in LoopManager | loop-manager.ts:57 | e691389 |
| Orchestrator prompt invalid CLI syntax | orchestrator-prompt.ts:45 | 7065025 |
| parseLoopCreateArgs exceeds 238 lines | loop.ts:40-278 | 7065025 |

### Batch 9-10: Types & Tests (5 issues)
| Issue | File:Line | Commit |
|-------|-----------|--------|
| Inline type duplication in recordAndContinue | loop-handler.ts:1121 | 707273f |
| Test boilerplate (12 repetitions) | agent-exit-condition-evaluator.test.ts | 707273f |
| Variable reference before declaration | loop-handler.test.ts:786 | 707273f |
| Missing stale iteration guard test | loop-handler.test.ts | 707273f |
| Missing shell mode evalTimeout boundary test | loop-manager.test.ts | 707273f |

### Batch 11: Documentation (5 issues)
| Issue | File:Line | Commit |
|-------|-----------|--------|
| FEATURES.md not updated | docs/FEATURES.md | 7065025 |
| README.md omits agent eval | README.md:105-135 | 7065025 |
| CHANGELOG.md [Unreleased] empty | CHANGELOG.md:7-9 | 7065025 |
| CLAUDE.md missing evaluator files | CLAUDE.md:147-167 | 7065025 |
| exitCondition inline comment lacks rationale | domain.ts:277 | 7065025 |

### Batch 12: Orphan Eval Task (1 issue)
| Issue | File:Line | Commit |
|-------|-----------|--------|
| Orphan eval tasks on loop cancellation | loop-handler.ts:277 | e022f5b |

## Pre-existing Issues (Skipped)
| Issue | Location | Note |
|-------|----------|------|
| PF-005: getResetTargetSha O(n) scan | loop-handler.ts:~1224 | Deferred resolution still applies |
| PF-006: 4 sequential git spawns | git-state.ts:~331 | Acceptable given iteration frequency |
| ShellExitConditionEvaluator empty exitCondition | exit-condition-evaluator.ts:31 | Routing prevents this path |
| FEATURES.md version label stale | docs/FEATURES.md:5 | Update at release time |
| ExitConditionEvaluator interface missing JSDoc | interfaces.ts:685-687 | Informational |
