# Consistency Review Report

**Branch**: feat/178-worker-pool-rewiring -> main
**Date**: 2026-05-19

## Issues in Your Changes (BLOCKING)

### HIGH

**Accidental empty file `=` committed to repo root** - `=:1`
**Confidence**: 95%
- Problem: An empty file named `=` was added to the repository root. This is almost certainly an artifact of a shell mishap (e.g., a redirect without a filename). It is not in `.gitignore` and will be committed and shipped.
- Fix: Remove the file and add it to `.gitignore` if needed:
  ```bash
  git rm =
  ```

**`AgentAdapter.spawn()` and `AgentAdapter.kill()` remain on the interface but are dead code for tmux workers** - `src/core/agents.ts:285-298`
**Confidence**: 82%
- Problem: The `AgentAdapter` interface still declares `spawn()` (returns `ChildProcess`), `spawnInteractive()`, and `kill(pid)` alongside the new `buildTmuxCommand()`. The worker pool now exclusively uses `buildTmuxCommand()` and `TmuxConnectorPort` for lifecycle. The old methods are only used by `ProcessSpawnerAdapter` (test shim) and `spawnInteractive` (interactive orchestrator). This creates an inconsistency: two parallel spawn paths coexist on the same interface, and the `ChildProcess` import in `agents.ts` is now a core-layer dependency on Node's `child_process` module that the tmux migration intended to remove.
- Fix: This is a transitional state acknowledged in the PR. Mark the old methods with `@deprecated` JSDoc to signal that consumers should migrate. Consider splitting the interface (e.g., `AgentAdapter` for tmux, `LegacyAgentAdapter` for process-based) in a follow-up. This is not a deferral (avoids PF-001) -- it is a suggestion to add deprecation markers to the code that is already in the diff.

### MEDIUM

**`.gitignore` removed `.docs/` and `.memory/` entries** - `.gitignore:60,67`
**Confidence**: 85%
- Problem: Two `.gitignore` entries were removed: `.docs/` and `.memory/`. The removal of `.docs/` may be intentional (replaced by `.devflow/docs/`), but `.memory/` removal has no corresponding replacement. If `.memory/` files exist locally, they could accidentally be committed.
- Fix: Verify whether `.memory/` is still used. If so, restore the entry. If it was renamed or consolidated, confirm no local files would leak.

**`handleWorkerCompletion` changed from `async` to synchronous `void` but still calls `.catch()` on promises** - `src/implementations/event-driven-worker-pool.ts:620`
**Confidence**: 80%
- Problem: The method was `private async handleWorkerCompletion(...)` and is now `private handleWorkerCompletion(...): void`. The DECISION comment explains this is intentional (fire-and-forget emit to avoid async callback chain reordering). However, this changes the function signature pattern. Other handler methods in the same file (`handleWorkerTimeout`) remain `async`. The inconsistency between sibling handler methods could confuse maintainers.
- Fix: Add a brief inline comment at the method declaration noting why this method specifically is synchronous while `handleWorkerTimeout` is async. The DECISION comment at the emit site covers the rationale, but a one-liner at the signature would help readers scanning the class shape.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`TmuxConnectorPort.spawn()` uses `unknown` config parameter -- type safety gap at interface boundary** - `src/core/tmux-types.ts:93`
**Confidence**: 83%
- Problem: `TmuxConnectorPort.spawn(config: unknown, ...)` uses `unknown` to avoid pulling `TmuxSpawnConfig` into core. The concrete `TmuxConnector.spawn()` casts with `rawConfig as TmuxSpawnConfig` without runtime validation. This is documented as an ARCHITECTURE EXCEPTION but is inconsistent with the project's "validate at boundaries" principle and the `parse, don't validate` guideline from CLAUDE.md. The existing codebase uses typed interfaces and Result types to avoid unsafe casts.
- Fix: The ARCHITECTURE EXCEPTION comment is good documentation. Consider adding a minimal runtime assertion (e.g., check `config` has `taskId` and `sessionsDir` properties before casting) to catch misuse early. This would align with the boundary validation pattern without pulling the full `TmuxSpawnConfig` type into core.

**`TmuxSpawnConfig` comment says "will move to src/core" but the type remained in `src/implementations/tmux/types.ts`** - `src/core/agents.ts:12-13`, `src/core/agents.ts:320-322`
**Confidence**: 80%
- Problem: The old comment in `agents.ts` said "TmuxSpawnConfig will move to src/core when Phase 3 establishes it as a first-class domain concept." The new comment says "stays in src/implementations/tmux/types.ts" but the `buildTmuxCommand` JSDoc at line 322 still says "The concrete type will move to src/core when Phase 3 (WorkerPool rewiring) establishes it as a first-class domain concept." Phase 3 is this PR -- the JSDoc is now stale.
- Fix: Update the `buildTmuxCommand` JSDoc (line 320-322) to match the decision that `TmuxSpawnConfig` stays in `src/implementations/tmux/types.ts`:
  ```typescript
  * ARCHITECTURE: TmuxSpawnConfig is imported as a type-only reference from the tmux layer
  * (src/implementations/tmux/types.ts). It stays there because it references
  * implementation-level types (TmuxAgentType, TmuxSessionConfig).
  ```

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`RecoveryManager.recoverRunningTasks()` error message still says "Worker process crashed" for tmux workers** - `src/services/recovery-manager.ts:499`
**Confidence**: 80%
- Problem: When marking crashed tasks in `recoverRunningTasks()`, the error message is hardcoded to `'Worker process crashed during execution'` regardless of whether the worker was tmux-based or process-based. The `handleDeadWorker()` method correctly differentiates the message (`'Tmux session died'` vs `'Worker process died'`), but `recoverRunningTasks()` does not apply the same pattern.
- Fix: Apply the same `isTmuxWorker` conditional message pattern:
  ```typescript
  const isTmuxWorker = workerRegistration?.pid === 0;
  const errorMsg = isTmuxWorker
    ? 'Tmux session crashed during execution'
    : 'Worker process crashed during execution';
  ```

## Suggestions (Lower Confidence)

- **Duplicate mock adapter factories** - `tests/fixtures/mock-agent.ts:29` and `tests/unit/implementations/event-driven-worker-pool.test.ts:34` (Confidence: 70%) -- The `createMockTmuxAgentAdapter` in fixtures and `createMockAgentRegistry` in the unit test both construct near-identical mock adapters with `buildTmuxCommand`. Consider consolidating the unit test helper to use `createTmuxAgentRegistry` from fixtures, similar to how `createMockTmuxConnector` was already consolidated.

- **`SAFE_PATH_REGEX` now allows spaces but the comment in tmux-hooks references are unchanged** - `src/implementations/tmux/types.ts:281` (Confidence: 65%) -- The regex was updated to allow spaces for macOS paths. Verify that all call sites that embed paths (e.g., `tmux-hooks.ts`) use single-quote escaping consistently with the relaxed regex.

- **`processSpawner` option in `BootstrapOptions` is still documented and functional but not used by the tmux path** - `src/bootstrap.ts:83` (Confidence: 62%) -- The `processSpawner` injection point exists for backward compatibility with test mocks, but the worker pool now uses `tmuxConnector`. The two injection paths (`processSpawner` wraps to `ProcessSpawnerAdapter` which errors on `buildTmuxCommand`; `tmuxConnector` goes direct) could be confusing. Consider whether `processSpawner` should be deprecated.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | - | 2 | 2 | - |
| Should Fix | - | - | 2 | - |
| Pre-existing | - | - | 1 | - |

**Consistency Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The migration from process-based to tmux-based workers is internally consistent: naming conventions, Result types, event patterns, and error handling all follow existing codebase patterns. The new code uses `DECISION` comments (matching the established convention), properly injects dependencies via the constructor, and maintains the event-driven architecture. The main consistency gaps are: (1) the accidental `=` file, (2) stale JSDoc claiming `TmuxSpawnConfig` will move to core when that decision has already been made against moving it, (3) mixed sync/async handler methods in the same class without clear signaling, and (4) the `unknown` type at the port boundary conflicting with the project's type safety posture.
