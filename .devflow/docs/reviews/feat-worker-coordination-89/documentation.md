# Documentation Review Report

**Branch**: feat/worker-coordination-89 -> main
**Date**: 2026-03-17
**PR**: #94
**Commits**: 7324e28 feat: SQLite worker coordination + output persistence (#89), 0c496f3 fix: address self-review issues

---

## Issues in Your Changes (BLOCKING)

### CRITICAL

**EVENT_FLOW.md Recovery Flow section is now actively misleading** - `docs/architecture/EVENT_FLOW.md:183-206`
- Problem: The "Recovery Flow" section (Section 4) documents the old 30-minute staleness heuristic that this PR explicitly replaces with PID-based crash detection. The diagram states "IF task age > 30 minutes (STALE): Mark as FAILED" and "IF task age < 30 minutes (RECENT): Re-queue for recovery". This directly contradicts the new `recovery-manager.ts` behavior, which uses `WorkerRepository.findByTaskId()` + `isProcessAlive(ownerPid)` and never re-queues RUNNING tasks.
- Impact: Developers relying on architecture docs will misunderstand the recovery system. The old behavior (re-queueing recent tasks) no longer exists, making the diagram harmful.
- Fix: Rewrite Section 4 to document the new two-phase PID-based recovery:
  ```
  ### 4. Recovery Flow (Server Restart)

  Server Startup
      |
      v
  1. RecoveryManager.recover()
     - Phase 0: Scan workers table, check ownerPid liveness
       Dead owner? -> Unregister worker, mark task FAILED (exitCode -1)
       Alive owner? -> Leave alone (running in another process)
     - Phase 1: Re-queue QUEUED tasks (duplicate check via queue.contains())
     - Phase 2: PID-based RUNNING task recovery
       Has worker row + alive ownerPid? -> Skip (alive in another process)
       No worker row or dead ownerPid? -> Mark FAILED immediately

  WHY: Replaces 30-minute staleness heuristic.
  PID-based detection is definitive - no false positives.
  ```

**EVENT_FLOW.md "Stale Task Detection" safeguard section is now stale** - `docs/architecture/EVENT_FLOW.md:302-318`
- Problem: Section "2. Stale Task Detection (RecoveryManager)" under "Critical Safeguards" states: "30-minute threshold - old tasks marked FAILED, recent tasks re-queued" with example showing "Age > 30 min (7 tasks): MARK AS FAILED / Age < 30 min (3 tasks): RE-QUEUE". This safeguard description is now completely wrong. The 30-minute threshold no longer exists.
- Impact: This is referenced as a critical safeguard with a code reference to `src/services/recovery-manager.ts:88-175`. The code at those lines now implements PID-based detection, not a staleness heuristic.
- Fix: Replace with PID-based crash detection description:
  ```
  ### 2. PID-Based Crash Detection (RecoveryManager)

  **Problem**: Crashed tasks stuck in RUNNING status cause fork-bomb on restart.

  **Solution**: Workers table tracks ownerPid; on startup, process.kill(pid, 0)
  determines if the owning process is alive.

  Server restart with 10 RUNNING tasks:
    Worker alive (3 tasks):    SKIP (running in another process)
    Worker dead/missing (7):   MARK AS FAILED immediately

  Result: No re-queueing of RUNNING tasks. Definitive crash detection.

  **Code**: `src/services/recovery-manager.ts`
  ```

**EVENT_FLOW.md "Future Improvements" references now-replaced stale detection** - `docs/architecture/EVENT_FLOW.md:496-500`
- Problem: States "RecoveryManager stale detection - see JSDoc in src/services/recovery-manager.ts" as a future improvement removal target. The stale detection has already been removed and replaced.
- Impact: Implies the old system still exists and needs future replacement.
- Fix: Update to reference the new PID-based system, or remove the line if no future improvement is needed for recovery.

### HIGH

**CLAUDE.md File Locations table missing new WorkerRepository** - `CLAUDE.md:142-158`
- Problem: The "File Locations" quick reference table does not include the new `worker-repository.ts` file or the updated `recovery-manager.ts` role. This PR adds a significant new component (`WorkerRepository`) that developers need to find quickly.
- Impact: Developers using CLAUDE.md as a navigation guide will not know `WorkerRepository` exists or where to find it.
- Fix: Add the following entries to the File Locations table:
  ```markdown
  | Worker repository | `src/implementations/worker-repository.ts` |
  | Resource monitor | `src/implementations/resource-monitor.ts` |
  | Process connector | `src/services/process-connector.ts` |
  | Recovery manager | `src/services/recovery-manager.ts` |
  ```

**CLAUDE.md Database section missing `workers` table** - `CLAUDE.md:120-127`
- Problem: The Database section lists `schedules` and `schedule_executions` tables but does not mention the new `workers` table added by migration v9. This table is central to the cross-process coordination feature.
- Impact: Developers modifying database code won't know about the `workers` table from the project guide.
- Fix: Add to the Database section:
  ```markdown
  - `workers` table: active worker tracking for cross-process coordination, PID-based recovery
  ```

**FEATURES.md Crash Recovery section is outdated** - `docs/FEATURES.md:50-55`
- Problem: The "Crash Recovery" subsection describes "State Recovery: Resumes interrupted tasks after crashes" and "Status Reconciliation: Marks crashed RUNNING tasks as FAILED". While partially correct, it omits the new PID-based mechanism and still implies tasks may be "resumed" (re-queued), which no longer happens for RUNNING tasks.
- Impact: Users reading FEATURES.md get an incomplete picture of the crash recovery capabilities.
- Fix: Update to:
  ```markdown
  ### Crash Recovery
  - **PID-Based Detection**: Worker table tracks process IDs; dead processes detected instantly on startup
  - **Cross-Process Awareness**: Workers in other live processes are left untouched during recovery
  - **Duplicate Prevention**: Prevents re-queuing already processed tasks
  - **Status Reconciliation**: Marks crashed RUNNING tasks as FAILED (exit code -1)
  ```

### MEDIUM

**FEATURES.md Resource Management section does not mention cross-process coordination** - `docs/FEATURES.md:23-42`
- Problem: The "Dynamic Worker Pool" and "Settling Workers Tracking" sections describe per-process worker management. The PR replaces the in-memory worker count check with a global DB count via `WorkerRepository.getGlobalCount()` for max worker enforcement. This cross-process resource check is a significant capability upgrade not reflected in FEATURES.md.
- Impact: Users won't know that multiple Autobeat processes sharing the same DB now coordinate worker limits globally.
- Fix: Add a subsection under Resource Management:
  ```markdown
  ### Cross-Process Worker Coordination (v1.0)
  - **Global Worker Count**: Max worker limit enforced via database, not just in-memory count
  - **Worker Registration**: All active workers tracked in SQLite `workers` table
  - **Multi-Process Safety**: Multiple Autobeat instances sharing the same DB coordinate resource limits
  ```

**FEATURES.md Output Management section does not mention periodic DB persistence** - `docs/FEATURES.md:56-68`
- Problem: The "Output Management" section mentions "Output Repository: Persistent storage of all task output" but does not describe the new periodic flush mechanism (every 500ms) or the cross-process output retrieval fallback added in `TaskManagerService.getLogs()`.
- Impact: Users won't know output is now continuously persisted to DB (not just at completion) and accessible cross-process.
- Fix: Add to the Output Management section:
  ```markdown
  - **Periodic Persistence**: Output flushed to database every 500ms during execution
  - **Cross-Process Logs**: Task logs retrievable from any process via database fallback
  - **Memory Cleanup**: In-memory buffers freed after final flush on task completion
  ```

**ROADMAP.md v1.0.0 entry references "Distributed Processing" but this PR uses "v1.0" comments** - `docs/ROADMAP.md:182-192` vs `src/bootstrap.ts:247`
- Problem: The PR's bootstrap comment says "Register WorkerRepository for cross-process coordination (v1.0)" and `WorkerRegistration` doc comment says "Worker registration for cross-process coordination". However, the ROADMAP places v1.0.0 as "Distributed Processing" focused on multi-server support with Redis. The current worker coordination is single-server, multi-process. Using "v1.0" in source comments creates confusion about which version this feature targets.
- Impact: Minor confusion about whether this feature is part of the distributed processing milestone or a current-version feature.
- Fix: In source comments, use a more specific label like "(worker coordination)" instead of "(v1.0)" to avoid version ambiguity, or update ROADMAP to clarify that single-server multi-process coordination ships before v1.0.

**WorkerPool completion flow not updated in EVENT_FLOW.md** - `docs/architecture/EVENT_FLOW.md:93-119`
- Problem: The "Task Completion Flow" section shows `WorkerPool.onWorkerExit()` as the first step but does not mention the new cleanup steps: `ProcessConnector.stopFlushing()`, `ProcessConnector.flushOutput()` (final flush), `OutputCapture.clear()` (memory cleanup), and `WorkerRepository.unregister()`. These are significant lifecycle changes.
- Impact: Developers tracing completion flow through architecture docs will miss the output persistence and worker unregistration steps.
- Fix: Expand the Task Completion Flow to include:
  ```
  1. WorkerPool.onWorkerExit()
     - Stop periodic output flushing
     - Final flush output to DB
     - Clear in-memory buffer
     - Clean up worker state (maps, monitor count, DB unregister)
  ```

---

## Issues in Code You Touched (Should Fix)

### MEDIUM

**EventBus description in EVENT_FLOW.md still mentions request-response** - `docs/architecture/EVENT_FLOW.md:8-15`
- Problem: The architecture overview diagram shows "Request-response: request() + respond()" in the EventBus description. Per session 84 notes, the request-response infrastructure was removed (~170 lines of dead code). This is pre-existing but directly adjacent to the recovery flow that changed.
- Impact: New developers may try to use request-response patterns that no longer exist.
- Fix: Remove the "Request-response: request() + respond()" line from the EventBus diagram and update Section "Request-Response Pattern Details" (lines 208-224) to note this was removed.

### LOW

**FEATURES.md "Architecture" subsection mentions "Output" handler** - `docs/FEATURES.md:157`
- Problem: Lists "Event Handlers: Specialized handlers (Persistence, Queue, Worker, Output)" but there is no separate Output handler -- output capture is handled by `ProcessConnector` and `BufferedOutputCapture`. This was likely pre-existing but worth noting since the PR significantly changes output flow.
- Impact: Minor confusion about handler naming.
- Fix: Update to "Event Handlers: Specialized handlers (Persistence, Queue, Worker, Dependency, Schedule, Checkpoint)" to reflect actual handler list.

---

## Pre-existing Issues (Not Blocking)

### MEDIUM

**TASK_ARCHITECTURE.md "What's Missing" section is stale** - `docs/architecture/TASK_ARCHITECTURE.md:718-735`
- Problem: Lists items like "CLI Integration" for dependencies and "Dependency Failure Handling" as TODOs, but these were implemented in v0.6.0 (cascade cancellation). Also references "MCP Tool Integration" as missing, but `DelegateTask` already supports `dependsOn`.
- Impact: Developers reading this doc will think features are missing when they already exist.
- Fix: Update the "What's Missing / TODO" section to reflect current state.

**EVENT_FLOW.md request-response section describes removed infrastructure** - `docs/architecture/EVENT_FLOW.md:208-224`
- Problem: The "Request-Response Pattern Details" section describes `eventBus.request()` and `eventBus.respond()` with code examples. This infrastructure was removed in PR #91.
- Impact: Misleading reference material.
- Fix: Remove or mark as historical.

### LOW

**FEATURES.md still references "No Artificial Limits"** - `docs/FEATURES.md:29`
- Problem: States "No Artificial Limits: Uses all available system resources" but `maxWorkers` config exists and is now enforced globally via DB count.
- Impact: Minor inaccuracy in feature description.
- Fix: Remove or qualify with "within configured maxWorkers limit".

---

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 3 | 2 | 0 | 0 |
| Should Fix | 0 | 0 | 1 | 1 |
| Pre-existing | 0 | 0 | 2 | 1 |

**Documentation Score**: 4/10

The inline code documentation is excellent -- `WorkerRepository`, `WorkerRegistration`, `ProcessConnector`, and `RecoveryManager` all have clear JSDoc comments explaining architecture decisions, edge cases, and rationale. The new code follows the project's documentation patterns well (ARCHITECTURE comments, Edge Case labels).

However, the external documentation (EVENT_FLOW.md, FEATURES.md, CLAUDE.md) has significant drift. The recovery flow documentation now actively contradicts the code -- it describes a 30-minute staleness heuristic that was the specific thing this PR replaced. Three sections in EVENT_FLOW.md describe behavior that no longer exists. CLAUDE.md lacks references to the new `workers` table and `WorkerRepository`.

**Recommendation**: CHANGES_REQUESTED

The three CRITICAL issues in EVENT_FLOW.md are the primary concern. The recovery flow documentation now describes the opposite of what the code does. This is the textbook case of "outdated documentation is worse than no documentation" -- a developer reading these architecture docs will form an incorrect mental model of crash recovery. The two HIGH issues in CLAUDE.md (missing File Locations entries and missing `workers` table documentation) should also be addressed to maintain the project guide's usefulness.
