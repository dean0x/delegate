## Review Summary: task-2025-01-25_2210 (PR #48 — Task Scheduling)

**Date**: 2026-02-18
**Reviewers**: 8 perspectives (security, architecture, performance, quality, typescript, database, dependencies, documentation)

### Merge Recommendation
**REQUEST_CHANGES** — Do not merge in current state.

The scheduling feature is architecturally sound in concept but has significant issues across security, type safety, data integrity, and documentation that need resolution before merge.

### Consensus Findings (HIGH confidence)
*Findings all reviewers agreed on or that survived challenge:*

1. **Missing path validation on workingDirectory in handleScheduleTask** (Security H1)
   - `src/adapters/mcp-adapter.ts:913` — `handleDelegateTask` validates paths, `handleScheduleTask` does not
   - Path traversal attack vector. Unanimous agreement.

2. **Unsafe JSON deserialization of task_template without Zod validation** (Security H2, Database)
   - `src/implementations/schedule-repository.ts:402-405` — `JSON.parse()` + `as DelegateRequest` with no schema validation
   - Violates project's "parse, don't validate" principle. Unanimous.

3. **Read-modify-write TOCTOU in schedule update()** (Database H1, Performance H1)
   - `src/implementations/schedule-repository.ts:214-237` — SELECT then INSERT OR REPLACE without transaction
   - Existing codebase uses synchronous transactions for TOCTOU protection. Unanimous.

4. **Dual-write / double-save on schedule creation** (Architecture CRITICAL, Performance, Quality M1)
   - MCP adapter saves to DB at line 856, then emits ScheduleCreated, handler saves again at line 209
   - Breaks event-driven persistence pattern used everywhere else. Unanimous.

5. **Non-null assertion `scheduledAtMs!`** (TypeScript CRITICAL, Quality H2)
   - `src/adapters/mcp-adapter.ts:908` — runtime crash risk if validation order refactored
   - Unanimous.

6. **Silent enum defaults (toMissedRunPolicy/toScheduleStatus)** (Security M4, Database SF8, TypeScript MEDIUM)
   - `src/implementations/schedule-repository.ts:449-479` — unknown values silently become ACTIVE/SKIP
   - Data corruption masked. Unanimous: should throw.

7. **No tests for ScheduleHandler (593 LOC) or ScheduleExecutor (428 LOC)** (Quality P2)
   - The two most complex, stateful, race-condition-prone components have zero test coverage
   - Quality reviewer scored 4/10 largely on this basis. Unanimous concern.

8. **Documentation completely stale** (Documentation — all 4 HIGH findings)
   - FEATURES.md says scheduling is NOT implemented
   - CLAUDE.md, README.md, ROADMAP.md all omit scheduling entirely
   - Unanimous.

9. **Infinite retrigger when getNextRunTime fails for CRON schedules** (Quality H3)
   - `src/services/handlers/schedule-handler.ts:299-306` — stale nextRunAt causes re-trigger every tick
   - Unchallenged. Production bug.

10. **ScheduleExecutor not stopped during shutdown** (Quality H1)
    - Timer can fire during shutdown while DB/workers are being destroyed
    - Unchallenged.

### Majority Findings (MEDIUM confidence)
*Most agreed, with some dissent:*

11. **Unsafe type casts throughout** (TypeScript HIGH, Architecture, Quality H4)
    - `as Priority`, `as ScheduleStatus`, `as unknown as` for EventBus correlation — multiple locations
    - Performance reviewer noted casts are common in event-driven TS code. Majority: fix the casts, type the EventBus properly.

12. **cron-parser v4 when v5 is available; luxon 4.5MB transitive dep** (Dependencies)
    - Zero-dep alternative `croner` exists. Architecture reviewer agreed lean deps matter.
    - Performance reviewer noted server-side package size is less critical. Majority: evaluate alternatives, but not merge-blocking.

13. **ScheduleUpdate type defined but unused** (TypeScript MEDIUM)
    - `src/core/domain.ts:302` defines it, but `Partial<Schedule>` used instead in repository/events
    - Security reviewer agreed this enables unrestricted field updates (M3). Majority: use ScheduleUpdate.

14. **No rate limiting on schedule creation** (Security M1)
    - Performance reviewer noted this is an MCP server consumed by AI, not a public API
    - Security: still a resource exhaustion vector. Majority: add a reasonable limit.

15. **findByStatus has no LIMIT** (Database H2, Performance, Quality S1)
    - `src/implementations/schedule-repository.ts:136-138` — unbounded query
    - Majority agreed: add pagination consistent with findAll().

### Split Findings (LOW confidence)
*Genuinely contested, both perspectives included:*

16. **Sequential processing of due schedules in executor tick** (Performance H2)
    - Performance: should use Promise.all() for parallel execution
    - Architecture: sequential is safer for resource management and prevents thundering herd
    - Quality: sequential is correct for a scheduler; parallelism should be opt-in
    - **Split**: Both sides have merit. Sequential is defensible for v1.

17. **INSERT OR REPLACE semantics in save()** (Database H4)
    - Database: silent overwrite is dangerous
    - Architecture: UUID collision is astronomically unlikely; INSERT OR REPLACE is simpler
    - **Split**: Document the behavior; don't block on it.

18. **Zod validation on every row read** (Performance M4)
    - Performance: overhead on hot polling path
    - Security: validation at boundaries is a core project principle
    - **Split**: Keep validation, optimize only if profiling shows it matters.

### Issue Counts
- 🔴 Blocking: 15 (across all perspectives)
- ⚠️ Should-fix: 18
- ℹ️ Pre-existing: 12

### Scores by Perspective
| Perspective | Score | Recommendation |
|---|---|---|
| Security | 5/10 | CHANGES_REQUESTED |
| Architecture | 5/10 | CHANGES_REQUESTED |
| Performance | 5/10 | CHANGES_REQUESTED |
| Quality | 4/10 | CHANGES_REQUESTED |
| TypeScript | 6/10 | CHANGES_REQUESTED |
| Database | 6/10 | CHANGES_REQUESTED |
| Dependencies | 6/10 | CHANGES_REQUESTED |
| Documentation | 3/10 | CHANGES_REQUESTED |
| **Overall** | **5/10** | **CHANGES_REQUESTED** |

### Debate Summary
Key exchanges that changed findings:
- **Sequential vs parallel schedule execution**: Performance pushed for parallelism, architecture and quality defended sequential. Remained split.
- **Zod validation on read path**: Performance flagged as overhead, security defended as boundary validation principle. Remained split — keep unless profiled.
- **cron-parser vs alternatives**: Dependencies raised croner as zero-dep option. Not merge-blocking but should be evaluated.
- **Silent enum defaults**: All three perspectives (security, database, typescript) independently found this. Strengthened to unanimous HIGH.
- **Documentation gap**: Unchallenged by any reviewer. Strongest consensus item — every doc file is stale.
