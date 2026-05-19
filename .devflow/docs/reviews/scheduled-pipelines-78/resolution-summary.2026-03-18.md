# Resolution Summary

**Branch**: feat/scheduled-pipelines-78 -> main
**Date**: 2026-03-18
**Command**: /resolve
**PR**: #80

## Statistics
| Metric | Value |
|--------|-------|
| Total Issues | 11 |
| Fixed | 8 |
| False Positive | 1 |
| Deferred (Tech Debt) | 1 |
| Blocked | 0 |

## Fixed Issues
| Issue | File:Line | Commit |
|-------|-----------|--------|
| `createSchedule` not using `validateScheduleTiming` | `src/services/schedule-manager.ts:64` | `68fdd62` |
| Duplicated `afterScheduleId` resolution in pipeline trigger | `src/services/handlers/schedule-handler.ts:327` | `dea7739` |
| Non-null assertion `pipelineSteps!` → explicit parameter | `src/services/handlers/schedule-handler.ts:319` | `dea7739` |
| Pipeline cleanup bypasses events (validated intentional, added comment) | `src/services/handlers/schedule-handler.ts:380` | `dea7739` |
| Missing Zod validation on `pipeline_task_ids` | `src/implementations/schedule-repository.ts:538` | `3dcf586` |
| `nextRunAt` fallback `undefined` → `null` for consistency | `src/adapters/mcp-adapter.ts:1616` | `231b848` |
| TASK-DEPENDENCIES.md contradicts cascade behavior | `docs/TASK-DEPENDENCIES.md` | `5fd1f0a` |
| Missing release notes for v0.6.0 | `docs/releases/RELEASE_NOTES_v0.6.0.md` | `5fd1f0a` |

## Test Coverage Added
| Issue | File:Line | Commit |
|-------|-----------|--------|
| Missing `cancelSchedule` with `cancelTasks=true` service test | `tests/unit/services/schedule-manager.test.ts` | `6838f90` |

## False Positives
| Issue | File:Line | Reasoning |
|-------|-----------|-----------|
| MCP adapter tests use simulate helpers instead of real adapter | `tests/unit/adapters/mcp-adapter.test.ts:857` | All 55 existing tests use the same pattern — handler methods are private, only reachable through MCP SDK transport mock. Not a targeted fix. |

## Deferred to Tech Debt
| Issue | File:Line | Risk Factor |
|-------|-----------|-------------|
| Pipeline task saves not in transaction | `src/services/handlers/schedule-handler.ts:340` | `better-sqlite3` `db.transaction()` is synchronous, cannot support `await` inside callback. Requires async-aware transaction infrastructure. TODO comment added. |

## Simplification Applied
| Change | File |
|--------|------|
| Removed redundant `timezone: tz` alias | `src/services/schedule-manager.ts` |
| Removed obvious `// reuse shared logic` comments | `src/services/schedule-manager.ts` |
| Reused `truncatePrompt` helper for step summaries | `src/services/schedule-manager.ts` |
| Removed unnecessary intermediate `taskTemplate` variable | `src/services/handlers/schedule-handler.ts` |

## Commits Created
- `231b848` fix(mcp-adapter): use null instead of undefined for nextRunAt fallback
- `68fdd62` refactor(schedule-manager): deduplicate timing validation in createSchedule
- `3dcf586` fix(schedule-repo): add Zod validation for pipeline_task_ids boundary
- `5fd1f0a` docs: update dependency docs for cascade cancellation + add v0.6.0 release notes
- `dea7739` refactor(schedule-handler): deduplicate afterScheduleId resolution + type-safety
- `6838f90` test(schedule-manager): add cancelSchedule with cancelTasks=true coverage
- `44ba820` refactor: simplify resolver fixes — remove aliases, reuse helpers

## Final State
- Build: clean
- Tests: 1,470 passing, 0 failures
- Formatting: clean (Biome)
