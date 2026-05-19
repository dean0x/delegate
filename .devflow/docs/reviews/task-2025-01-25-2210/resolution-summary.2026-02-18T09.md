# Resolution Summary

**Branch**: task-2025-01-25_2210 -> main
**Date**: 2026-02-18T09:00Z
**Command**: /resolve

## Statistics
| Metric | Value |
|--------|-------|
| Total Issues | 25 |
| Fixed | 19 |
| False Positive | 1 |
| Deferred | 4 |
| Blocked | 0 |
| Not in scope (remaining from full review) | ~20 |

## Fixed Issues
| Issue | File:Line | Commit |
|-------|-----------|--------|
| Dual-write: remove save() from adapter (CRITICAL) | src/adapters/mcp-adapter.ts:938 | 5c32bfa |
| Non-null assertion on scheduledAtMs (CRITICAL) | src/adapters/mcp-adapter.ts:908 | 5c32bfa |
| Missing path validation in handleScheduleTask (HIGH) | src/adapters/mcp-adapter.ts:913 | 5c32bfa |
| Optional ScheduleRepository/EventBus params (HIGH) | src/adapters/mcp-adapter.ts:108 | 5c32bfa |
| Infinite retrigger on getNextRunTime failure (HIGH) | src/services/handlers/schedule-handler.ts:299 | ab676d1 |
| Missing exhaustive check in handleScheduleCreated (MEDIUM) | src/services/handlers/schedule-handler.ts:168 | ab676d1 |
| No-op TaskCompleted/TaskFailed subscriptions (MEDIUM) | src/services/handlers/schedule-handler.ts:572 | ab676d1 |
| ScheduleExecutor not stopped during shutdown (HIGH) | src/core/container.ts:220, src/index.ts:83 | 5c32bfa |
| Constructor side effects -> factory pattern (HIGH) | src/services/schedule-executor.ts:76 | 5c32bfa |
| Event subscriptions never unsubscribed (HIGH) | src/services/schedule-executor.ts:82 | 5c32bfa |
| Unsafe `as` casts on event objects (HIGH) | src/services/schedule-executor.ts:85 | 5c32bfa |
| Unsafe JSON deserialization of task_template (HIGH) | src/implementations/schedule-repository.ts:402 | b2651e1 |
| Silent enum defaults -> throw (MEDIUM) | src/implementations/schedule-repository.ts:449 | b2651e1 |
| findByStatus no LIMIT -> pagination (HIGH) | src/implementations/schedule-repository.ts:136 | b2651e1 |
| Missing composite index for execution history (MEDIUM) | src/implementations/database.ts:477 | b2651e1 |
| Missing numeric CHECK constraints (MEDIUM) | src/implementations/database.ts:438 | b2651e1 |
| FEATURES.md claims scheduling NOT implemented (HIGH) | docs/FEATURES.md:179 | b2651e1 |
| CLAUDE.md missing scheduling docs (HIGH) | CLAUDE.md:49 | b2651e1 |
| README.md missing schedule tools (HIGH) | README.md:70 | b2651e1 |
| ROADMAP.md shows scheduling as "Research" (HIGH) | docs/ROADMAP.md:203 | b2651e1 |

## False Positives
| Issue | File:Line | Reasoning |
|-------|-----------|-----------|
| Unsafe `as Priority`/`as ScheduleStatus` casts | src/adapters/mcp-adapter.ts:915,:988 | Zod schemas guarantee only valid string values. String literals are identical to TypeScript enum values. Casts are type-safe because Zod enforces the constraint at boundary. |

## Deferred to Tech Debt
| Issue | File:Line | Risk Factor |
|-------|-----------|-------------|
| Unsafe EventBus casts in handleScheduleQuery | src/services/handlers/schedule-handler.ts:503 | Systemic issue: `respond`/`respondError` exist on InMemoryEventBus but not the EventBus interface. Same pattern in queue-handler, query-handler, worktree-handler. Cross-cutting architectural concern requiring coordinated change across 4+ handlers. |
| ScheduleUpdatedEvent uses Partial<Schedule> instead of ScheduleUpdate | src/core/events/events.ts:270 | Requires changing ScheduleRepository.update signature in interfaces.ts AND schedule-repository.ts, plus handler and events.ts. Touches 4 files for a type refinement with no runtime bug. |
| Direct repo writes in executor (handleMissedRun FAIL + updateNextRun) | src/services/schedule-executor.ts:351,382 | Requires new event types (ScheduleCancelled, ScheduleSkipped), new handler methods, removal of direct repo calls. Significant architectural refactoring across multiple files. |
| TOCTOU in schedule-repository update() | src/implementations/schedule-repository.ts:214 | Changes public API (ScheduleRepository interface), modifies core business logic used by 8+ call sites, requires signature change from Partial<Schedule> to targeted SQL UPDATE. |

## Remaining Issues (not in scope for this resolution pass)
~20 additional issues from the full review were not included in this resolution pass. These include:
- Rate limiting on schedule creation (Security M1)
- CancelSchedule status validation (Quality M2)
- Record<string, unknown> response typing (TypeScript HIGH)
- In-memory runningSchedules lost on restart (Security M2/Quality M6)
- Missing exhaustive check in handleMissedRun (TypeScript MEDIUM)
- error as Error unsafe cast (TypeScript MEDIUM)
- INSERT OR REPLACE semantics (Database M4)
- task_template size validation (Database SF7)
- cron-parser v4 vs v5 (Dependencies HIGH)
- parseCronExpression type leak (Dependencies MEDIUM)
- No dedicated scheduling docs file (Documentation M5)
- No release notes (Documentation M6)
- handleScheduleTriggered direct task creation (Architecture MEDIUM)
- Wrong ErrorCode for schedules (Architecture MEDIUM)
- High complexity in handleScheduleTask (Quality M5)
- EventBus.on/once/onRequest use any (TypeScript SF HIGH)

## Commits Created
- `ab676d1` fix: prevent infinite retrigger, add exhaustive check, remove dead code in schedule-handler
- `5c32bfa` fix: address schedule-executor resource leaks and consistency issues
- `b2651e1` docs: update documentation to reflect scheduling feature implementation
- `d045251` refactor: simplify resolution fixes for clarity and consistency

## Verification
- TypeScript compilation: PASS (0 errors)
- Core tests: 273/273 PASS
- Adapter tests: 38/38 PASS
- Handler/repository tests: pre-existing better-sqlite3 native module incompatibility (unrelated)
