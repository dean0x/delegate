# Security Review Report

**Branch**: feat/interactive-orchestrator-mode -> main
**Date**: 2026-05-06
**PR**: #159

## Issues in Your Changes (BLOCKING)

### HIGH

**PID stored in DB without validation -- enables SIGTERM to arbitrary process** - `src/services/orchestration-manager.ts:419-424`
**Confidence**: 85%
- Problem: `updateInteractiveOrchestrationPid` accepts any `number` and stores it in the DB without validation. The `cancelOrchestration` path at line 480 then calls `process.kill(orchestration.pid, 'SIGTERM')` on whatever PID is stored. While the PID originates from a trusted source (`spawnResult.value.pid`), there is no validation at the service boundary that the PID is positive, non-zero, and belongs to a process owned by the current user. If the DB is corrupted or the API is called with a crafted PID value (e.g., PID 1 to kill init), it would send SIGTERM to an arbitrary process.

  The existing codebase validates `orchestratorId` format with a regex (`ORCHESTRATOR_ID_RE` in `base-agent-adapter.ts:336`) before injecting it into env vars. The same defense-in-depth approach should apply to PIDs before `process.kill`.
- Fix: Add a PID range check before storing and before killing:
  ```typescript
  // In updateInteractiveOrchestrationPid:
  if (!Number.isInteger(pid) || pid <= 0) {
    return err(new AutobeatError(ErrorCode.INVALID_INPUT, `Invalid PID: ${pid}`));
  }

  // In cancelOrchestration, before process.kill:
  if (orchestration.pid && orchestration.pid > 0) {
    try {
      process.kill(orchestration.pid, 'SIGTERM');
    } catch { /* ESRCH */ }
  }
  ```

### MEDIUM

**Migration v25 lacks CHECK constraint on `mode` column** - `src/implementations/database.ts:993-994`
**Confidence**: 85%
- Problem: The `mode` column is added as bare `TEXT DEFAULT NULL` without a CHECK constraint restricting values to `('standard', 'interactive')`. The codebase has a strong pattern of using CHECK constraints for defense-in-depth on enum-like columns (see migrations v2, v3, v4, v11, v14, v22). This is a deviation from the established security pattern. A corrupted or manually edited DB row with an unexpected mode value (e.g., `'admin'`) could bypass mode-specific branching in `cancelOrchestration` and `checkOrchestrationLiveness`.
- Fix:
  ```sql
  ALTER TABLE orchestrations ADD COLUMN mode TEXT DEFAULT NULL
    CHECK(mode IS NULL OR mode IN ('standard', 'interactive'));
  ```

**`--dangerously-skip-permissions` in interactive mode exposes user to unrestricted agent actions** - `src/implementations/claude-adapter.ts:29-32`
**Confidence**: 80%
- Problem: `buildInteractiveArgs` includes `--dangerously-skip-permissions` which gives the Claude CLI full autonomy (file writes, command execution, network access) without per-action approval. Unlike headless mode (where `--print` limits interaction to stdout-only), interactive mode shows the user a live session. The `--dangerously-skip-permissions` flag means the agent will execute actions without prompting the user for confirmation, even though the user is watching the terminal. This is an intentional design choice (matching headless behavior), but in interactive mode the user might reasonably expect to be prompted before destructive actions.
- Fix: This is likely a conscious design decision. If it is intentional, add a DECISION comment explaining the rationale. If the intent is for users to maintain approval control in interactive sessions, remove the flag:
  ```typescript
  // DECISION: --dangerously-skip-permissions is intentional for interactive mode.
  // Interactive orchestrators delegate sub-tasks and need uninterrupted execution.
  // The user can interrupt via Ctrl+C at any time.
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**SIGINT handler restoration uses unchecked type cast** - `src/cli/commands/orchestrate.ts:779`
**Confidence**: 82%
- Problem: The line `process.on('SIGINT', handler as NodeJS.SignalsListener)` uses an unchecked type cast. `process.listeners()` returns `Function[]`, and the cast to `NodeJS.SignalsListener` is assumed safe. While this is unlikely to cause a security issue in practice, if a non-SIGINT handler were accidentally stored in the array (due to a concurrent mutation), it would be reattached with incorrect expectations. The more concerning aspect: between `removeAllListeners('SIGINT')` at line 765 and handler restoration at line 778-781, there is a window where the default SIGINT behavior (process termination) is suppressed. If the child process hangs indefinitely and the user presses Ctrl+C multiple times, the parent process becomes unkillable via SIGINT.
- Fix: Add a safety mechanism for a second Ctrl+C:
  ```typescript
  let sigintCount = 0;
  process.on('SIGINT', () => {
    sigintCount++;
    cancelled = true;
    if (sigintCount >= 2) {
      // Force exit on double Ctrl+C
      process.exit(130);
    }
  });
  ```

## Pre-existing Issues (Not Blocking)

No critical pre-existing security issues found in the changed files.

## Suggestions (Lower Confidence)

- **PID reuse race condition** - `src/services/orchestration-manager.ts:476-484` (Confidence: 65%) -- Between the time a PID is stored and `cancelOrchestration` is invoked, the original process may have exited and the OS may have reused the PID for an unrelated process. The SIGTERM would then kill the wrong process. This is inherent to PID-based process management and difficult to fully mitigate, but could be partially addressed by also storing the process start time and comparing it before killing.

- **No TTY validation on cancel path** - `src/services/orchestration-manager.ts:476` (Confidence: 60%) -- The cancel path sends SIGTERM to the interactive session's PID, which is expected to be running on a TTY. If the process was backgrounded or the TTY was disconnected, SIGTERM delivery semantics may differ. This is edge-case behavior that is unlikely to be exploitable.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Security Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The main concern is the PID validation gap. The interactive mode stores a PID in the database and later uses `process.kill()` on it without range validation at the service boundary. While the PID currently originates from a trusted source, defense-in-depth requires validation at the storage and kill boundaries. The missing CHECK constraint on the `mode` column is a consistency issue with the established schema pattern. The `--dangerously-skip-permissions` flag usage should be documented as a conscious design decision.
