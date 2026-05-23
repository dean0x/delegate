# Complexity Review Report

**Branch**: feat/180-phase-5-bootstrap-usage-parsing-cleanup -> main
**Date**: 2026-05-23

## Issues in Your Changes (BLOCKING)

### HIGH

**`handleOrchestrateInteractive` exceeds 250 lines with deep nesting** - `src/cli/commands/orchestrate-interactive.ts:131-387`
**Confidence**: 92%
- Problem: The function spans 256 lines (131-387). The entire body is wrapped in a try/catch with 8 sequential guard-and-exit blocks (lines 154-289), each following the pattern: get result, check error, print error, dispose, exit. This creates a long procedural chain with 3 levels of nesting at baseline. The function handles: container setup, dependency resolution (3 container.get calls), orchestration creation, tmux session spawn, prompt delivery, session name storage, SIGINT handler registration, tmux attach, detach detection, exit code polling, finalization, and cleanup. No single concern is extracted.
- Impact: Difficult to understand, test, or modify. A new developer would need significant time to trace the flow. The sequential error-handling blocks are nearly identical, inviting copy-paste bugs.
- Fix: Extract phases into named helper functions. The function has clear lifecycle stages:
  1. `resolveContainerDeps(container)` -- returns `{ tmuxConnector, sessionsDir, agentRegistry }` or exits
  2. `spawnAndDeliverPrompt(tmuxConnector, adapter, ...)` -- returns handle or exits
  3. `attachAndWaitForSession(handle, ...)` -- returns exit code and cancelled flag
  4. `finalizeOrchestration(...)` -- cleanup

  Each helper would be under 50 lines. The main function becomes a readable pipeline.

**Polling loop in `handleOrchestrateInteractive` uses interval/deadline pattern** - `src/cli/commands/orchestrate-interactive.ts:344-358`
**Confidence**: 85%
- Problem: After tmux detach, the code uses a manual `setInterval`/`setTimeout` polling loop to wait for the `onExit` callback:
  ```typescript
  let poll: NodeJS.Timeout;
  const deadline = setTimeout(() => { clearInterval(poll); resolve(); }, 2000);
  poll = setInterval(() => {
    if (agentExited) { clearInterval(poll); clearTimeout(deadline); resolve(); }
  }, 50);
  ```
  This is 15 lines to express "wait up to 2s for a boolean to become true." The timer variables are declared with `let` and mutually reference each other, creating temporal coupling.
- Impact: Fragile pattern -- swapping the declaration order of `poll` and `deadline` would cause a ReferenceError. Unnecessarily complex for what it does.
- Fix: Use a simple bounded `for` loop with `await`:
  ```typescript
  for (let i = 0; i < 40 && !agentExited; i++) {
    await new Promise<void>(r => setTimeout(r, 50));
  }
  ```
  Same semantics (40 * 50ms = 2000ms), 3 lines, no timer cleanup needed.

### MEDIUM

**`spawn()` method nesting reaches 5 levels in persistent session reuse path** - `src/implementations/event-driven-worker-pool.ts:193-219`
**Confidence**: 82%
- Problem: The persistent session reuse check in `spawn()` nests to 5 levels: `if (psk)` -> `if (!reuseInProgress)` -> `else` -> `if (existing)` -> `if (aliveResult.ok && aliveResult.value)`. While each condition is individually simple, the overall structure is hard to scan:
  ```
  if (psk) {
    if (this.reuseInProgress.has(psk)) {
      // warn
    } else {
      const existing = this.persistentSessions.get(psk);
      if (existing) {
        const aliveResult = ...
        if (aliveResult.ok && aliveResult.value) {
          return await this.reuseSession(...)
        }
        // cleanup
      }
    }
  }
  ```
- Impact: 5-level nesting at the warning threshold. The else branch contains the substantive logic, which is a cognitive anti-pattern (positive branch is a log, negative branch is the real work).
- Fix: Use early-continue pattern. Invert the `reuseInProgress` check:
  ```typescript
  if (psk && !this.reuseInProgress.has(psk)) {
    const existing = this.persistentSessions.get(psk);
    if (existing) {
      const aliveResult = this.tmuxConnector.isAlive(existing.handle);
      if (aliveResult.ok && aliveResult.value) {
        return await this.reuseSession(task, psk, existing, prompt);
      }
      this.persistentSessions.delete(psk);
    }
  } else if (psk) {
    this.logger.warn('Concurrent reuse attempt...', { ... });
  }
  ```
  Maximum nesting: 3 levels.

**Duplicate tmux validation logic** - `src/cli/commands/orchestrate-interactive.ts:100-125` and `src/bootstrap.ts:556-568`
**Confidence**: 80%
- Problem: Two independent tmux validation implementations exist:
  1. `validateTmux()` in orchestrate-interactive.ts (lines 100-125): uses `spawnSync('tmux', ['-V'])`, manually parses version with regex
  2. Bootstrap validation (lines 556-568): uses `new TmuxValidator({ exec: tmuxExec }).validate()`

  Both check the same precondition (tmux >= 3.0 installed) but with completely different implementations. The orchestrate-interactive version is a standalone function that bypasses the injected `TmuxValidator` and its `ExecFn` injection point.
- Impact: Maintenance risk -- if minimum version changes, two places must be updated. The CLI version cannot be tested without a real tmux binary (no exec injection), while the bootstrap version can.
- Fix: Reuse `TmuxValidator` in the CLI path. Since CLI mode bootstraps before `handleOrchestrateInteractive`, either:
  (a) Pass the validator through the container (preferred), or
  (b) Instantiate `TmuxValidator` inline with `spawnSync`-based exec, matching bootstrap's pattern.
  This also enables test injection.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Repetitive error-exit pattern in `handleOrchestrateInteractive`** - `src/cli/commands/orchestrate-interactive.ts:155-273`
**Confidence**: 83%
- Problem: 8 occurrences of nearly identical guard blocks:
  ```typescript
  if (!someResult.ok) {
    ui.error(`Failed to ...: ${someResult.error.message}`);
    [optional finalize]
    await container.dispose();
    process.exit(1);
  }
  ```
  Each differs only in the error message string and whether finalization is called. The repetition inflates the function length by ~80 lines.
- Impact: If disposal logic changes (e.g., adding logging), every block must be updated independently. Copy-paste risk is high.
- Fix: Extract a helper:
  ```typescript
  function exitWithError(msg: string, container: Container, exitCode = 1): never {
    ui.error(msg);
    container.dispose().finally(() => process.exit(exitCode));
  }
  ```
  Or use a cleanup registration pattern where error paths throw and a single catch handles cleanup.

## Pre-existing Issues (Not Blocking)

(None at CRITICAL severity in reviewed files.)

## Suggestions (Lower Confidence)

- **`reuseSession` has 4 sequential error paths with cleanup** - `src/implementations/event-driven-worker-pool.ts:252-337` (Confidence: 70%) -- Each failure branch calls `cleanupPersistentSession(key)` then returns `err()`. Could use a single cleanup-on-error wrapper, but the current approach is readable and explicit.

- **`handleTaskTerminal` in loop-handler.ts is 115 lines** - `src/services/handlers/loop-handler.ts:243-356` (Confidence: 65%) -- Pre-existing method that was not meaningfully changed in this PR (only touched indirectly via the `persistentSessionKey` addition in `startSingleTaskIteration`). While it exceeds the 50-line guideline, refactoring it is outside the scope of this change.

- **Magic number 300ms in reuseSession settle delay** - `src/implementations/event-driven-worker-pool.ts:295` (Confidence: 65%) -- `await new Promise<void>((resolve) => setTimeout(resolve, 300))` uses a hardcoded 300ms. Could be a named constant, but the value is documented in the JSDoc header and unlikely to change.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Complexity Score**: 6/10
**Recommendation**: CHANGES_REQUESTED

The dominant issue is `handleOrchestrateInteractive` at 256 lines -- well above the 50-line warning and 200-line critical thresholds. The function is a sequential chain of guard-check-exit blocks with no extraction. The persistent session reuse logic in `spawn()` is well-structured (extracted `reuseSession`, `launchAndRegister`, `cleanupPersistentSession`) and demonstrates good complexity management. The loop-handler changes are minimal and clean. The primary ask is to decompose the interactive orchestrator into lifecycle phases and eliminate the duplicate tmux validation.
