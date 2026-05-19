# Documentation Review Report

**Branch**: task-2025-01-25_2210 -> main
**Date**: 2026-02-18
**Focus**: Documentation drift, missing API docs, stale comments, CLAUDE.md update needs, README gaps

---

## Issues in Your Changes (BLOCKING)

### HIGH

**1. FEATURES.md explicitly claims "Scheduled Tasks" is NOT implemented** - `/Users/dean/Sandbox/delegate/docs/FEATURES.md:179`
- Problem: Line 179 reads `- **Scheduled Tasks**: No cron-like scheduling` under the section "NOT Implemented (Despite Some Documentation Claims)". This PR implements the entire scheduling feature (6 new MCP tools, ScheduleHandler, ScheduleExecutor, cron utilities, database migration), yet the documentation actively denies its existence.
- Impact: CRITICAL doc drift. Users reading FEATURES.md will believe scheduling does not exist. This is the single most misleading statement in the codebase relative to this PR.
- Fix: Remove "Scheduled Tasks" from the "NOT Implemented" section. Add a new section documenting the scheduling feature, following the pattern of the existing "Task Dependencies (v0.3.0)" section. Should include:
  - MCP Tools: `ScheduleTask`, `ListSchedules`, `GetSchedule`, `CancelSchedule`, `PauseSchedule`, `ResumeSchedule`
  - Schedule types: CRON (5-field) and ONE_TIME (ISO 8601)
  - Missed run policies: skip, catchup, fail
  - Timezone support (IANA)
  - Concurrent execution prevention
  - Database schema (schedules, schedule_executions tables)
  - Event-driven integration (ScheduleCreated, ScheduleTriggered, ScheduleExecuted, etc.)
- Category: BLOCKING - documentation actively contradicts implemented code
- **Confidence: HIGH** - Unchallenged. No reviewer disputed this.

**2. CLAUDE.md missing scheduling documentation and file locations** - `/Users/dean/Sandbox/delegate/CLAUDE.md:49-169`
- Problem: CLAUDE.md is the primary guidance file for Claude Code working on this project. It has no mention of scheduling. The "Architecture Notes" section (line 49) lists handlers but omits `ScheduleHandler`. The "File Locations" table (line 155) omits all new files. The "MCP Tools" section (line 152) only mentions 4 tools (DelegateTask, TaskStatus, TaskLogs, CancelTask) but the PR adds 6 more scheduling tools.
- Impact: Any Claude Code session working on this codebase will not know scheduling exists, will not know where the files are, and will not know the new MCP tools are available. This directly undermines the purpose of CLAUDE.md.
- Fix: Update the following sections:
  - **Architecture Notes**: Add `ScheduleHandler` and `ScheduleExecutor` to the handler list
  - **MCP Tools**: Add note about scheduling tools: `ScheduleTask`, `ListSchedules`, `GetSchedule`, `CancelSchedule`, `PauseSchedule`, `ResumeSchedule`
  - **File Locations**: Add rows for:
    - Schedule repository: `src/implementations/schedule-repository.ts`
    - Schedule handler: `src/services/handlers/schedule-handler.ts`
    - Schedule executor: `src/services/schedule-executor.ts`
    - Cron utilities: `src/utils/cron.ts`
  - **Database section**: Mention the `schedules` and `schedule_executions` tables
  - **Architecture Notes**: Document that `ScheduleExecutor` has direct repo writes (see architecture review debate below), which diverges from the pure event-driven pattern used by other handlers
- Category: BLOCKING - CLAUDE.md is stale and misleading for agent-assisted development
- **Confidence: HIGH** - Unchallenged. Architecture reviewer's finding about ScheduleExecutor's layering violation (direct repo writes) makes the CLAUDE.md update even more important -- the architectural deviation should be explicitly documented so future developers understand the inconsistency.

**3. README.md MCP Tools table missing all 6 scheduling tools** - `/Users/dean/Sandbox/delegate/README.md:70-76`
- Problem: The README MCP Tools table lists only DelegateTask, TaskStatus, TaskLogs, CancelTask. The PR adds ScheduleTask, ListSchedules, GetSchedule, CancelSchedule, PauseSchedule, ResumeSchedule. None appear in the README.
- Impact: Users reading the README will not discover the scheduling capability. This is the user-facing entry point.
- Fix: Add scheduling tools to the MCP Tools table, or add a separate "Scheduling" section under Usage with examples similar to the existing "Task Dependencies" section.
- Category: BLOCKING - user-facing documentation incomplete
- **Confidence: HIGH** - Unchallenged.

**4. ROADMAP.md still shows scheduling as "Research" status** - `/Users/dean/Sandbox/delegate/docs/ROADMAP.md:203-300`
- Problem: The roadmap lists v0.4.0 Task Scheduling with status "Research" (line 412: `| v0.4.0 | Research | Task Resumption + Scheduling |`). The scheduling portion is now implemented. The v0.4.0 section (line 244-300) describes scheduling as a future feature with tentative implementation details, estimated timelines, and success criteria with unchecked boxes.
- Impact: Contributors and users consulting the roadmap will plan work around features they believe don't exist yet. The success criteria (line 296-299) should reflect actual implementation status.
- Fix: Update v0.4.0 to split Task Resumption (still research) from Task Scheduling (now implemented). Update the version timeline table. Check the applicable success criteria boxes. Consider moving scheduling to its own released version entry or marking it as completed within v0.4.0.
- Category: BLOCKING - roadmap contradicts reality
- **Confidence: HIGH** - Unchallenged.

### MEDIUM

**5. No dedicated scheduling documentation file** - Missing file
- Problem: Task Dependencies has a dedicated `docs/TASK-DEPENDENCIES.md` (572 lines, referenced from CLAUDE.md, README.md, and FEATURES.md). The scheduling feature is equally complex (6 MCP tools, cron expressions, missed run policies, timezone handling, execution history) but has no equivalent documentation file.
- Impact: Users have no single place to learn about scheduling API, patterns, and troubleshooting. The MCP tool descriptions in `mcp-adapter.ts` are the only "documentation", which is insufficient for user consumption.
- Fix: Create `docs/SCHEDULING.md` covering:
  - Quick start examples (cron and one-time)
  - All 6 MCP tools with full parameter descriptions
  - Cron expression syntax guide (5-field standard)
  - Timezone support and IANA identifiers
  - Missed run policies with behavior descriptions
  - Execution history and auditing
  - Concurrent execution prevention behavior (and its limitation: memory-only, not persisted across restarts -- per security reviewer M2 and quality reviewer M6)
  - Known limitations (no task-to-schedule back-reference, per schedule-handler.ts:575 comments)
  - Integration with task dependencies
  - Troubleshooting guide
- Category: Should-fix - significant feature gap in documentation
- **Confidence: HIGH** - Quality reviewer's finding P2 (zero tests for ScheduleHandler/ScheduleExecutor) and the multiple behavioral subtleties found across all reviews (infinite retrigger bug, concurrent execution limits, missed run edge cases) strongly reinforce the need for a comprehensive reference document.

**6. No release notes for this feature** - Missing file in `docs/releases/`
- Problem: The project has a strict release process documented in CLAUDE.md (line 72-112) that requires `docs/releases/RELEASE_NOTES_v{version}.md`. CI will fail without it. There are no release notes for the scheduling feature. The package.json version should be updated to reflect this feature addition.
- Impact: If this branch is merged as part of a release, CI will fail. Even if not released immediately, the feature should have release notes drafted.
- Fix: Create release notes following existing pattern. At minimum, draft `docs/RELEASE_NOTES_v0.4.0.md` or whatever version this feature targets.
- Category: Should-fix - blocks release process
- **Confidence: HIGH** - Unchallenged. CI enforcement is mechanical.

**7. FEATURES.md "Last Updated" date is stale** - `/Users/dean/Sandbox/delegate/docs/FEATURES.md:6`
- Problem: Line 6 reads `Last Updated: November 2025`. This PR significantly changes the feature set.
- Impact: Readers cannot trust the currency of the document.
- Fix: Update to current date.
- Category: Should-fix - minor but misleading
- **Confidence: HIGH** - Trivial fact.

---

## Issues in Code You Touched (Should Fix)

### MEDIUM

**8. Schedule-related JSDoc incomplete on ScheduleExecutor public methods** - `/Users/dean/Sandbox/delegate/src/services/schedule-executor.ts:131-147`
- Problem: Public methods `markScheduleRunning`, `isScheduleRunning`, and `getRunningTaskId` lack `@param` and `@returns` JSDoc tags. The `start()` and `stop()` methods have minimal documentation.
- Impact: IDE autocomplete and developer experience degraded for consumers of this API.
- Fix: Add full JSDoc with `@param`, `@returns`, and `@example` tags to all public methods.
- Category: Should-fix while touching this code
- **Confidence: MEDIUM** - TypeScript reviewer's findings about missing exhaustive checks and quality reviewer's H3 (infinite retrigger) suggest the code's behavior is non-obvious and would benefit from better documentation. However, one could argue that fixing the bugs (which all reviewers agree on) reduces the need for documenting subtle failure modes.

**9. MCP adapter tool descriptions lack parameter documentation consistency** - `/Users/dean/Sandbox/delegate/src/adapters/mcp-adapter.ts:361-496`
- Problem: The schedule tool definitions in the tools/list handler have inconsistent `description` fields. Some properties have descriptions (e.g., `ScheduleTask.prompt`), others don't (e.g., `CancelSchedule.scheduleId` has a description but `PauseSchedule.scheduleId` doesn't repeat it meaningfully). The `ListSchedules` tool properties `limit` and `offset` have terse descriptions compared to the existing task tools.
- Impact: LLM clients consuming MCP tool definitions get inconsistent guidance for parameter usage.
- Fix: Ensure every property in every tool definition has a clear, consistent `description` field.
- Category: Should-fix - affects MCP tool discoverability
- **Confidence: HIGH** - This is an MCP server. Tool descriptions are the primary API documentation surface for LLM consumers. Consistency directly affects usability.

---

## Debate Challenges and Cross-Review Analysis

### Challenges I raise against other reviewers

**Challenge 1: Performance reviewer's #4 (Zod validation on every row) conflicts with Security reviewer's H2 (unsafe JSON deserialization)**

The performance reviewer suggests removing Zod validation from `rowToSchedule()` on the hot path (`findDue` every 60 seconds) to save CPU. However, the security reviewer flags the exact opposite problem: `task_template` is deserialized via `JSON.parse()` without Zod validation, calling it "unsafe deserialization" (OWASP A08).

These findings are in direct tension. You cannot simultaneously remove validation for performance AND add validation for security. The resolution should be:
- Validate `task_template` JSON structure at the **write boundary** (when saving to DB), not on every read
- Trust the validated data on reads from your own database (performance win)
- This satisfies both concerns: security gets validation, performance gets fast reads
- **This decision needs to be documented** in `docs/SCHEDULING.md` or architecture docs so future developers understand the validation strategy

**Challenge 2: Database reviewer's #4 (INSERT OR REPLACE risk) is overstated**

The database reviewer flags `INSERT OR REPLACE` as a data integrity risk due to potential ID collisions. Schedule IDs use `crypto.randomUUID()` (v4 UUID). The probability of collision is approximately 1 in 2^122. For a task scheduling system that might create thousands of schedules over its lifetime, this is not a realistic attack surface or data integrity concern.

The real issue (correctly identified by the architecture reviewer) is that `save()` is used for both creation and update, which is a semantic API design problem, not a collision risk problem. The documentation impact: the API semantics should be documented clearly.

**Challenge 3: Dependencies reviewer's suggestion to switch to `croner` has documentation implications**

If the dependency is changed from `cron-parser` to `croner`, the cron expression semantics may differ (field ordering, extension syntax support, edge cases). From a documentation perspective, I support explicitly documenting which cron syntax is supported and any limitations, regardless of which library is chosen. This reinforces my finding #5 (need for `docs/SCHEDULING.md`).

### Findings from other reviewers that reinforce my documentation findings

**Strong reinforcement: Quality reviewer's H3 (infinite retrigger on getNextRunTime failure)**

At `/Users/dean/Sandbox/delegate/src/services/handlers/schedule-handler.ts:299-306`, when `getNextRunTime` fails for a CRON schedule, the old `nextRunAt` is retained (already past), causing the executor to re-trigger the schedule on every 60-second tick indefinitely. This behavioral subtlety is exactly the kind of thing that needs to be documented in a troubleshooting guide. Even after the bug is fixed, the missed-run behavior, error recovery, and schedule state transitions are complex enough to warrant comprehensive documentation.

**Strong reinforcement: Architecture reviewer's CRITICAL (dual-write pattern)**

The dual-write between MCPAdapter (`mcp-adapter.ts:938`) and ScheduleHandler (`schedule-handler.ts:210`) was independently found by architecture, performance, and quality reviewers. When this is resolved, the chosen pattern (adapter-saves vs handler-saves) must be documented in CLAUDE.md's architecture notes, because it establishes the precedent for how future features should integrate with the event-driven system.

**Reinforcement: Security reviewer's M2 (in-memory concurrent execution guard)**

The `runningSchedules` Map is memory-only and does not survive process restarts. This is a known limitation that directly affects user expectations. It must be documented, whether in SCHEDULING.md or in the code comments. Quality reviewer M6 independently flagged the same concern.

### Final Debate Consensus (Round 2)

After exchanging challenges with all reviewers (database, performance, security, architecture), the following consensus emerged with direct documentation implications:

**1. Zod validation strategy must be documented (4 reviewers vs 1)**

Security, database, architecture, and documentation reviewers all challenged the performance reviewer's suggestion to remove Zod validation from the read path. The consensus resolution: validate `task_template` JSON structure at the **write boundary** (when saving to DB), trust validated data on reads. This validation strategy is a non-obvious architectural decision that must be documented in CLAUDE.md or `docs/SCHEDULING.md` so future developers do not re-introduce validation-on-read or remove write-boundary validation.

**2. Sequential processing is intentional -- needs code/doc comment (architecture challenge)**

The architecture reviewer identified that the performance reviewer's `Promise.allSettled` suggestion for parallel schedule execution would break the `runningSchedules` concurrency guard in `schedule-executor.ts`. Sequential processing is a correctness requirement, not a performance oversight. This non-obvious design constraint must be documented either in code comments at the executor's tick loop or in `docs/SCHEDULING.md`.

**3. Dual-write is the highest-consensus finding (5 reviewers)**

Architecture, performance, quality, security, and documentation reviewers all independently identified or agreed on the dual-write between `mcp-adapter.ts:938` and `schedule-handler.ts:210`. When resolved, the chosen persistence pattern (adapter-saves vs handler-saves) establishes a precedent for all future features. The resolution must be documented in CLAUDE.md's Architecture Notes section. This reinforces finding #2 (CLAUDE.md update).

**4. Infinite retrigger is a documentation-worthy behavioral subtlety (5 reviewers)**

Quality (H3), architecture, performance, security, and typescript reviewers all flagged or confirmed the infinite retrigger bug at `schedule-handler.ts:299-306`. Even after the code fix, the missed-run recovery behavior and schedule state transitions are complex enough to warrant a troubleshooting section in `docs/SCHEDULING.md`. This reinforces finding #5 (dedicated scheduling docs).

**5. ScheduleExecutor's direct repo writes are a documented architectural exception**

The architecture reviewer flagged and the performance reviewer defended the ScheduleExecutor's direct repository writes (bypassing the event-driven pattern). CLAUDE.md currently states "All components communicate via EventBus - no direct state management" (line 51). This statement is now inaccurate. Whether the direct writes are kept or refactored, CLAUDE.md must be updated to reflect reality. This reinforces finding #2 (CLAUDE.md update).

**6. In-memory concurrency guard limitation needs user-facing documentation**

Security (M2) and quality (M6) independently flagged that `runningSchedules` is memory-only. The architecture reviewer agreed this is a known limitation. Users must understand that process restarts can allow duplicate concurrent executions. This must appear in `docs/SCHEDULING.md` under "Known Limitations". This reinforces finding #5.

---

## Pre-existing Issues (Not Blocking)

### MEDIUM

**10. README.md testing section contradicts CLAUDE.md** - `/Users/dean/Sandbox/delegate/README.md:166-183`
- Problem: README lines 171-183 show `npm test` as the primary test command ("Run all tests (safe, sequential)") and lists `npm run test:unit` and `npm run validate`. CLAUDE.md explicitly states `npm test` is blocked and will print a warning. These commands appear to be stale from an older version.
- Impact: Users following README instructions will hit the blocked `npm test` safeguard and be confused.
- Fix: Update README testing section to match CLAUDE.md's grouped test approach.
- Category: Pre-existing - not introduced by this PR
- **Confidence: HIGH** - Verifiable contradiction between two files.

**11. README.md project structure missing several directories** - `/Users/dean/Sandbox/delegate/README.md:186-202`
- Problem: The project structure tree doesn't show `src/utils/`, `src/core/events/`, `src/core/errors.ts`, or `src/core/dependency-graph.ts`. These are significant components.
- Impact: New contributors get an incomplete picture of the codebase.
- Fix: Update the project structure tree to include key directories and files.
- Category: Pre-existing
- **Confidence: HIGH**

### LOW

**12. ROADMAP.md version ordering inconsistency** - `/Users/dean/Sandbox/delegate/docs/ROADMAP.md:13-14`
- Problem: v0.2.5 (Enhanced Worktree Safety) appears after v0.3.0 which is already released. The roadmap lists v0.2.5 as "Planning" but v0.3.0+ is released. This version ordering is confusing.
- Impact: Minor confusion about planned work.
- Fix: Either release v0.2.5 content under a different version or archive it.
- Category: Pre-existing
- **Confidence: HIGH**

---

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 4 | 0 | 0 |
| Should Fix | 0 | 0 | 4 | 0 |
| Pre-existing | 0 | 0 | 2 | 1 |

**Documentation Score**: 3/10

The implementation quality of the scheduling feature is solid -- the code is well-commented, follows existing patterns, uses proper JSDoc in core modules, and has consistent architecture comments. However, the documentation layer has not been updated at all. Every major documentation file (FEATURES.md, CLAUDE.md, README.md, ROADMAP.md) either actively contradicts the new feature or omits it entirely. There is no dedicated scheduling documentation file equivalent to the existing `docs/TASK-DEPENDENCIES.md`.

The gap between code quality and documentation quality on this PR is stark. Cross-review analysis reinforces this: multiple behavioral subtleties identified by other reviewers (infinite retrigger, memory-only concurrent execution guard, dual-write pattern, validation strategy) all need to be documented for the feature to be maintainable.

**Recommendation**: **CHANGES_REQUESTED**

All findings are **HIGH confidence** (unchallenged or reinforced by cross-review evidence).

The 4 HIGH blocking issues must be resolved before merge:
1. FEATURES.md must acknowledge scheduling exists (and remove the "NOT Implemented" claim)
2. CLAUDE.md must be updated with new handlers, tools, and file locations
3. README.md must expose the scheduling tools to users
4. ROADMAP.md must reflect that scheduling is implemented, not in research

The 4 MEDIUM should-fix issues (dedicated docs file, release notes, stale date, JSDoc/MCP descriptions) should ideally be addressed but are not merge-blocking on their own.
