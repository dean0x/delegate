# Consistency Review Report

**Branch**: feat/180-phase-5-bootstrap-usage-parsing-cleanup -> main
**Date**: 2026-05-23

## Issues in Your Changes (BLOCKING)

### HIGH

**Stale JSDoc on `updateInteractiveOrchestrationPid` references "child process" and "kill"** - `src/core/interfaces.ts:886-891`
**Confidence**: 85%
- Problem: The JSDoc for `updateInteractiveOrchestrationPid` still says "Store the child process PID for remote cancel support" and "caller should kill the child process since cancel couldn't reach it without a PID." With Phase 5, interactive orchestrations no longer use child processes -- they use tmux sessions. The method is retained for backward compat but the JSDoc misleads readers into thinking child process spawning is still the primary path.
- Fix: Update the JSDoc to clarify this is the legacy PID path retained for backward compatibility, and that `updateInteractiveOrchestrationSessionName` is the preferred Phase 5 method:
```typescript
/**
 * Store the child process PID for remote cancel support (pre-Phase 5 legacy path).
 * Phase 5 orchestrations use updateInteractiveOrchestrationSessionName() instead.
 *
 * @returns ok(true) if PID was stored (orchestration still RUNNING),
 *   ok(false) if status already transitioned (e.g., remote cancel won the race).
 */
```

**Stale JSDoc on `finalizeInteractiveOrchestration` references "child process exits"** - `src/core/interfaces.ts:903`
**Confidence**: 82%
- Problem: The JSDoc says "Finalize an interactive orchestration after the child process exits (or spawn failure)." With Phase 5, it should reference the tmux session ending (or spawn failure). The finalize method is still used but the terminology is inconsistent with the new tmux-based architecture.
- Fix: Update to "Finalize an interactive orchestration after the tmux session ends (or spawn failure)."

### MEDIUM

**`updateInteractiveOrchestrationPid` is defined in interface and implementation but never called from production code** - `src/core/interfaces.ts:892`, `src/services/orchestration-manager.ts:438`
**Confidence**: 85%
- Problem: The method is only referenced in test files. The interactive orchestrator (`orchestrate-interactive.ts`) now exclusively calls `updateInteractiveOrchestrationSessionName`. Keeping an unused method in the public `OrchestrationService` interface is inconsistent with the project's "delete dead code" principle (CLAUDE.md: "Delete dead code -- commented-out code is not version control"). The test usages exercise backward compat scenarios but the production caller was removed. (avoids PF-002 -- if this method was never published to external consumers, it could be safely removed as a clean break)
- Fix: Consider adding a `@deprecated` JSDoc annotation at minimum, or removing the method entirely if backward compat with pre-Phase 5 orchestrations is not required.

**`resolveAuth` JSDoc still references `spawn()` in "step 3"** - `src/implementations/base-agent-adapter.ts:181`
**Confidence**: 82%
- Problem: Line 181 says "3. CLI binary already verified in spawn() -- assume login-based auth" but `spawn()` was removed in this PR. The method should reference `buildTmuxCommand()` (which was already updated in the `@param` JSDoc at line 162 but not in step 3).
- Fix: Change "CLI binary already verified in spawn()" to "CLI binary already verified in resolveSpawnConfig()" or "CLI binary already verified in buildTmuxCommand()".

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Comment in `orchestrate-interactive.ts` line 387 references "cancelOrchestration uses the PID path"** - `src/services/orchestration-manager.ts:387`
**Confidence**: 80%
- Problem: The DECISION comment at line 387 says "carry mode:'interactive' so cancelOrchestration uses the PID path instead of loopService." With Phase 5, cancelOrchestration now prefers the tmux session name path, falling back to PID. The comment is inaccurate.
- Fix: Update to "carry mode:'interactive' so cancelOrchestration uses the tmux session destroy path (with PID fallback) instead of loopService."

## Pre-existing Issues (Not Blocking)

No CRITICAL pre-existing issues found.

## Suggestions (Lower Confidence)

- **Duplicate tmux validation logic** - `src/cli/commands/orchestrate-interactive.ts:100-125` (Confidence: 70%) -- The `validateTmux()` function in orchestrate-interactive.ts duplicates logic that exists in `TmuxValidator`. The DECISION comment explains the rationale (CLI mode skips bootstrap validator), but the version parsing regex and error messages could diverge over time. Consider delegating to TmuxValidator directly.

- **`worker.task` not updated during `reuseSession`** - `src/implementations/event-driven-worker-pool.ts:297-313` (Confidence: 65%) -- When reusing a persistent session, `taskToWorker` is remapped but `existingWorker.task` (the WorkerState's task reference) is not updated to reflect the new task. If downstream code reads `worker.task` (e.g., for timeout setup or logging), it would see the old iteration's task. The `reuseSession` method returns `ok(existingWorker)` directly without re-registering.

- **Inconsistent naming: `sessionName` vs `session_name`** - `src/core/domain.ts:826`, `src/implementations/orchestration-repository.ts:88` (Confidence: 60%) -- The domain type uses `sessionName` (camelCase, consistent with existing fields like `stateFilePath`), while the DB column uses `session_name` (snake_case). This follows the established convention in the codebase (all DB columns are snake_case, domain types camelCase), so this is not a violation -- just noting the pattern is correctly maintained.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Consistency Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The branch demonstrates strong overall consistency: naming conventions follow camelCase/PascalCase project standards, error handling uses Result types throughout, the event-driven pattern is maintained, and the dead code sweep is thorough (ProcessSpawner interface, adapter, test fixtures all removed cleanly). The new `persistent` flag on `TmuxSpawnCoreConfig`, `setEnvironment` on `TmuxConnectorPort`, `cleanupPersistentSession` on `WorkerPool`, and `SetupShimConfig`/`SetupShimManifest` types all follow established patterns in the codebase.

The primary consistency gaps are stale JSDoc comments that still reference the removed child-process-based spawning model. These are documentation drift from the architecture migration and should be updated before merge to prevent confusion for future contributors.
