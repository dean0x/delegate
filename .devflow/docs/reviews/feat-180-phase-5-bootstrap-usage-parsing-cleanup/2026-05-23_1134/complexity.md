# Complexity Review Report

**Branch**: feat/180-phase-5-bootstrap-usage-parsing-cleanup -> main
**Date**: 2026-05-23

## Issues in Your Changes (BLOCKING)

### HIGH

**`spawnAndDeliverPrompt` has 6 parameters (object param pattern warranted)** - `orchestrate-interactive.ts:181-188`
**Confidence**: 85%
- Problem: The function takes 6 positional parameters (`tmuxConnector`, `adapter`, `orchestration`, `orchestrationService`, `container`, `params`). Five of the six are service-level objects that the caller unpacks and passes individually. The complexity threshold for parameters is 5+.
- Fix: Consolidate the services into a single context object parameter:
  ```typescript
  interface SpawnPromptContext {
    readonly tmuxConnector: TmuxConnectorPort;
    readonly adapter: AgentAdapter;
    readonly orchestration: Orchestration;
    readonly orchestrationService: OrchestrationService;
    readonly container: Container;
    readonly userPrompt: string;
    readonly systemPrompt: string | undefined;
    readonly sessionsDir: string;
  }

  async function spawnAndDeliverPrompt(ctx: SpawnPromptContext): Promise<SpawnedSession | null> { ... }
  ```

**`spawnAndDeliverPrompt` duplicates finalize+dispose+exit teardown pattern (3 occurrences)** - `orchestrate-interactive.ts:200-206,249-255,263-270`
**Confidence**: 82%
- Problem: Three error branches in `spawnAndDeliverPrompt` repeat the same 3-line teardown: `orchestrationService.finalizeInteractiveOrchestration(...)` + `container.dispose()` + `process.exit(1)`. This is the same error-exit pattern that the function was extracted to reduce. Each copy is a maintenance risk if the teardown sequence changes.
- Fix: Extract a local helper:
  ```typescript
  async function exitOnFailure(msg: string): never {
    ui.error(msg);
    await orchestrationService.finalizeInteractiveOrchestration(orchestration.id, {
      exitCode: null, cancelled: false,
    });
    await container.dispose();
    process.exit(1);
  }
  ```
  Then each error branch becomes a single `await exitOnFailure(...)` call.

### MEDIUM

**Double `as unknown as` cast to access env on TmuxSpawnCoreConfig** - `orchestrate-interactive.ts:219-225`
**Confidence**: 85%
- Problem: Two layers of `as unknown as` are used to access `env` from the opaque `TmuxSpawnCoreConfig`, then to reconstruct it. The comment acknowledges the type boundary is "intentionally opaque at this call site." This kind of double-cast chain adds cognitive load, and any change to the underlying type silently invalidates these casts.
- Fix: Either (a) widen `TmuxSpawnCoreConfig` to include an optional `env` field (since both callers need it), or (b) add a utility function like `stripEnvKey(config, key)` that encapsulates the cast once. If the design intent is to keep `env` off the core config type, the utility function isolates the cast to one location.

**`spawn()` persistent session reuse block: 4-level nesting** - `event-driven-worker-pool.ts:234-261`
**Confidence**: 80%
- Problem: The persistent session reuse block in `spawn()` has 4 levels of nesting (`if psk` -> `if existing` -> `if alive` -> `if reuseResult`). The comment on line 232 says "Use early returns to keep nesting shallow" but the nesting is still 4 deep at its core. Maximum nesting is at the warning threshold (4).
- Fix: This is borderline given the comments and clear structure. An early-return extraction could flatten it:
  ```typescript
  if (!psk) { /* skip */ }
  else if (this.reuseInProgress.has(psk)) { this.logger.warn(...); }
  else {
    const reuseResult = this.tryReuseSession(task, psk, prompt);
    if (reuseResult) return reuseResult;
  }
  ```
  Where `tryReuseSession` handles the existence/liveness/reuse chain.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`handleOrchestrateInteractive` is 176 lines (line 280-456)** - `orchestrate-interactive.ts:280-456`
**Confidence**: 82%
- Problem: Even after extracting `resolveContainerDeps` and `spawnAndDeliverPrompt`, the main handler is 176 lines. The function covers TTY check, tmux validation, service bootstrap, dependency resolution, orchestration creation, adapter resolution, session spawning, session name storage, SIGINT handling, tmux attach, detach detection, exit wait, finalization, status reporting, cleanup, and exit. That is 16 distinct responsibilities in a single function. The complexity threshold for "warning" is 50 lines and "critical" is 200 lines.
- Fix: The Phase 4 block (lines 370-449) covering SIGINT + attach + finalize could be extracted into `attachAndFinalize(handle, agentState, exitPromise, ...)`. This would bring `handleOrchestrateInteractive` under 120 lines and isolate the SIGINT lifecycle management.

**`resolveContainerDeps` repeats dispose+exit pattern 3 times** - `orchestrate-interactive.ts:133-162`
**Confidence**: 80%
- Problem: Three sequential container.get() calls each repeat the same `ui.error + container.dispose() + process.exit(1)` teardown. Each block is structurally identical, differing only in the error message string.
- Fix: Extract a helper or use a loop over required keys:
  ```typescript
  function getOrDie<T>(container: Container, key: string, label: string): T {
    const result = container.get<T>(key);
    if (!result.ok) {
      ui.error(`Failed to get ${label}: ${result.error.message}`);
      await container.dispose();
      process.exit(1);
    }
    return result.value;
  }
  ```

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`event-driven-worker-pool.ts` is 1021 lines** - `event-driven-worker-pool.ts`
**Confidence**: 90%
- Problem: The file is well past the 500-line "critical" threshold. It contains the class, 5 interfaces, 1 constant, and 18+ methods. The Phase 5 additions (persistent session reuse, TaskIdRef) added ~80 net lines, pushing it further over.
- Impact: Large files are harder to navigate, review, and maintain. The file has clear section separators which help, but the sheer size means any change requires reading a large context.
- Fix: Consider extracting the persistent session reuse logic (reuseSession, cleanupPersistentSession, persistentSessions map, reuseInProgress set) into a separate `PersistentSessionManager` class that the worker pool delegates to.

## Suggestions (Lower Confidence)

- **`base-agent-adapter.ts` resolveSpawnConfig is 53 lines** - `base-agent-adapter.ts:319-385` (Confidence: 65%) -- At the warning threshold. The 6-step resolution chain is sequential and well-documented, but could benefit from extracting the runtime/auth/model/systemPrompt steps into a pipeline.

- **Magic number 2000ms deadline in exit wait** - `orchestrate-interactive.ts:427` (Confidence: 62%) -- The `Promise.race` with a 2000ms deadline is a magic number. Consider extracting `const EXIT_CALLBACK_DEADLINE_MS = 2000` as was done with `CLEAR_SETTLE_MS` in the worker pool.

- **`reuseSession` return type `Result<Worker | null>` uses null as sentinel** - `event-driven-worker-pool.ts:315` (Confidence: 70%) -- Using `null` inside a `Result` as a "fall through" sentinel is unconventional. A discriminated union (`{ kind: 'reused'; worker: Worker } | { kind: 'fallthrough' }`) would be more explicit, but the current approach is documented and tested.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 1 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Complexity Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The refactoring in `orchestrate-interactive.ts` is a net positive -- extracting `resolveContainerDeps`, `spawnAndDeliverPrompt`, and replacing the polling loop with `Promise.race(exitPromise, deadline)` all reduce complexity versus the pre-PR state. The `TaskIdRef` pattern in the worker pool is well-documented and tested with regression tests.

Conditions:
1. Consider consolidating `spawnAndDeliverPrompt` parameters into a context object (HIGH).
2. Extract the repeated finalize+dispose+exit teardown pattern (HIGH).
3. The `as unknown as` double cast for env stripping should be isolated to a utility (MEDIUM).
