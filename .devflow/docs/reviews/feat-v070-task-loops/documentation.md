# Documentation Review Report

**Branch**: feat/v070-task-loops -> main
**Date**: 2026-03-21

## Issues in Your Changes (BLOCKING)

### CRITICAL

**Release notes v0.7.0 contain wrong version content** - `docs/releases/RELEASE_NOTES_v0.7.0.md:1-74`
**Confidence**: 98%
- Problem: The release notes file `docs/releases/RELEASE_NOTES_v0.7.0.md` describes "SQLite Worker Coordination" features (worker table, PID-based crash detection) which are v0.6.0 features, not v0.7.0 loop features. The title says "v0.7.0" but the entire body is about a different release. This will actively mislead users reading the release notes.
- Fix: Replace the content with actual v0.7.0 release notes covering task/pipeline loops, retry/optimize strategies, 4 MCP tools, 4 CLI commands, 4 events, and migration v10. The FEATURES.md and ROADMAP.md already have correct v0.7.0 content that can be used as a source.

### HIGH

**Stale event count in events.ts file header comment** - `src/core/events/events.ts:5`
**Confidence**: 95%
- Problem: The file header comment says "25 event types remain after Phase 1 simplification" but the file now contains 29 event types (25 original + 4 new loop events). This comment was not updated when loop events were added.
- Fix: Update line 5 from:
  ```
   * 25 event types remain after Phase 1 simplification.
  ```
  to:
  ```
   * 29 event types (25 from Phase 1 + 4 loop events in v0.7.0).
  ```

**CLAUDE.md not updated with loop-related file locations** - `CLAUDE.md:140-160`
**Confidence**: 92%
- Problem: The CLAUDE.md "File Locations" table lists schedule-related files (repository, handler, executor, manager) but omits the corresponding loop files. CLAUDE.md is the primary project guide for Claude Code, and missing file locations reduce developer productivity. Four new core files are missing:
  - `src/implementations/loop-repository.ts` (622 lines)
  - `src/services/handlers/loop-handler.ts` (1106 lines)
  - `src/services/loop-manager.ts` (327 lines)
- Fix: Add rows to the File Locations table:
  ```
  | Loop repository | `src/implementations/loop-repository.ts` |
  | Loop handler | `src/services/handlers/loop-handler.ts` |
  | Loop manager | `src/services/loop-manager.ts` |
  ```

**CLAUDE.md not updated with loop MCP tools** - `CLAUDE.md:136-138`
**Confidence**: 90%
- Problem: The MCP Tools section lists all tools using PascalCase but does not include the 4 new loop tools: `CreateLoop`, `LoopStatus`, `ListLoops`, `CancelLoop`. This is the authoritative tool reference for Claude Code working on the project.
- Fix: Update line 138 to:
  ```
  All tools use PascalCase: `DelegateTask`, `TaskStatus`, `TaskLogs`, `CancelTask`, `ScheduleTask`, `ListSchedules`, `GetSchedule`, `CancelSchedule`, `PauseSchedule`, `ResumeSchedule`, `CreatePipeline`, `SchedulePipeline`, `CreateLoop`, `LoopStatus`, `ListLoops`, `CancelLoop`
  ```

**CLAUDE.md not updated with loop handler in Architecture Notes** - `CLAUDE.md:54-61`
**Confidence**: 88%
- Problem: The Architecture Notes section lists all event handlers (`DependencyHandler`, `QueueHandler`, `WorkerHandler`, `PersistenceHandler`, `ScheduleHandler`, `ScheduleExecutor`) but omits the new `LoopHandler`. The handler-setup.ts was updated to mention 7 handlers (from 6), and FEATURES.md correctly lists Loop in the handlers, but CLAUDE.md was not updated.
- Fix: Add `LoopHandler` to the handler list:
  ```
  - `LoopHandler` -> loop lifecycle and iteration engine
  ```

**CLAUDE.md not updated with loop database tables** - `CLAUDE.md:120-127`
**Confidence**: 88%
- Problem: The Database section documents the `workers`, `schedules`, and `schedule_executions` tables but does not mention the new `loops` and `loop_iterations` tables added in migration v10.
- Fix: Add:
  ```
  - `loops` table: loop definitions, strategy, exit condition, state (migration v10)
  - `loop_iterations` table: per-iteration execution records, scores, status (migration v10)
  ```

### MEDIUM

**Roadmap says v0.7.0 "Released" but package.json is still 0.6.0** - `docs/ROADMAP.md:3-5`
**Confidence**: 85%
- Problem: The ROADMAP.md header says "Current Status: v0.7.0" with "Status: Released (2026-03-21)" but `package.json` still has `"version": "0.6.0"`. This could confuse contributors or CI checking version alignment. The release hasn't actually happened yet (branch is pending PR merge).
- Fix: Change ROADMAP.md status to "In Progress" or "Ready" rather than "Released" until the version bump is merged and the release workflow is triggered. Alternatively, bump `package.json` version to `0.7.0` as part of this PR.

**Help command missing loop examples** - `src/cli/commands/help.ts:104-131`
**Confidence**: 82%
- Problem: The Examples section at the bottom of the help output includes examples for scheduling, pipeline, resume, and configuration, but no examples for the new loop commands. Loop commands are documented in the Loop Commands section above, but concrete usage examples help users get started faster.
- Fix: Add loop examples:
  ```
  # Loops
  beat loop "fix failing tests" --until "npm test"
  beat loop "optimize bundle" --eval "du -b dist/main.js | cut -f1" --direction minimize
  beat loop list --status running
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**FEATURES.md design patterns header still says "v0.6.0"** - `docs/FEATURES.md:155`
**Confidence**: 80%
- Problem: The section header reads "Design Patterns (v0.6.0 Hybrid Event Model)" even though the content was updated to include v0.7.0 changes (Loop handler added, event count updated to 29). The version in the header is now stale.
- Fix: Either remove the version from the header (`Design Patterns (Hybrid Event Model)`) or update it to reflect the latest changes (`Design Patterns (v0.7.0 Hybrid Event Model)`).

## Pre-existing Issues (Not Blocking)

No critical pre-existing documentation issues found.

## Suggestions (Lower Confidence)

- **No dedicated docs/LOOPS.md** - (Confidence: 70%) -- The project has `docs/TASK-DEPENDENCIES.md` for the v0.3.0 dependency feature. The loop feature is similarly complex (retry/optimize strategies, pipeline loops, exit condition evaluation, checkpoint context enrichment) and could benefit from a dedicated API reference document. However, FEATURES.md covers the feature list comprehensively, and this is a matter of documentation strategy preference.

- **CLAUDE.md Documentation Structure section missing loop docs reference** - `CLAUDE.md:162-169` (Confidence: 65%) -- The "Documentation Structure" section at the bottom of CLAUDE.md doesn't reference any loop-specific documentation. If a `docs/LOOPS.md` is created, it should be added here.

- **CLI loop.ts missing file-level JSDoc** - `src/cli/commands/loop.ts:1` (Confidence: 62%) -- Unlike `loop-handler.ts`, `loop-manager.ts`, and `loop-repository.ts` which all have descriptive file-level JSDoc comments explaining architecture and patterns, `loop.ts` jumps straight into imports with no file-level documentation.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 1 | 4 | 1 | - |
| Should Fix | - | - | 1 | - |
| Pre-existing | - | - | - | - |

**Documentation Score**: 5/10
**Recommendation**: CHANGES_REQUESTED

The code-level documentation (inline JSDoc, architectural comments, Zod schema annotations) is excellent throughout the new loop files. However, the release notes contain entirely wrong content (v0.6.0 features masquerading as v0.7.0), the events.ts header has a stale count, and CLAUDE.md -- the project's primary developer guide -- was not updated with new file locations, MCP tools, handlers, or database tables. These gaps will actively mislead developers and users.
