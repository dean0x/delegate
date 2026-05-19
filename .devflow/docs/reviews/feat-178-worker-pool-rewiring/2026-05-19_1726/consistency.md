# Consistency Review Report

**Branch**: feat/178-worker-pool-rewiring -> main
**Date**: 2026-05-19

## Issues in Your Changes (BLOCKING)

### HIGH

**ProcessSpawnerAdapter.buildTmuxCommand contradicts AgentAdapter JSDoc contract** - `src/implementations/process-spawner-adapter.ts:47-62`
**Confidence**: 95%
- Problem: The `AgentAdapter.buildTmuxCommand` JSDoc at `src/core/agents.ts:324` explicitly states: "Adapters that do not support tmux (e.g. ProcessSpawnerAdapter) must return err with ErrorCode.INVALID_OPERATION." The PR changed `ProcessSpawnerAdapter.buildTmuxCommand` from returning `err(...)` to returning `ok(...)` with a fabricated config (`command: 'echo'`, `as unknown as TmuxSpawnConfig`). This violates the documented contract. Additionally, the ARCHITECTURE JSDoc at `agents.ts:321-322` says "The concrete type will move to src/core when Phase 3 (WorkerPool rewiring) establishes it as a first-class domain concept" -- Phase 3 is now here, but TmuxSpawnConfig was not moved to core. The JSDoc is now stale on two counts.
- Fix: Either (a) update the `AgentAdapter.buildTmuxCommand` JSDoc to reflect the new behavior ("Adapters used in tests should return a stub config...") and remove the stale "move to src/core" note, OR (b) keep ProcessSpawnerAdapter returning `err(INVALID_OPERATION)` and use the mock adapter from `tests/fixtures/mock-agent.ts` in tests instead. Option (a) is likely correct since the PR deliberately changed this for test compatibility.

**TmuxConnectorPort.spawn JSDoc says `unknown` but actual type is `any`** - `src/core/tmux-types.ts:82,92`
**Confidence**: 92%
- Problem: The JSDoc block at line 82 states "spawn() uses `unknown` for config" but the actual parameter type at line 92 is `any`. The JSDoc and the code disagree. The biome-ignore comment and inline comment both correctly say `any`, but the JSDoc description is inconsistent.
- Fix: Update the JSDoc to match the actual type:
```typescript
 * spawn() uses `any` for config to avoid pulling TmuxSpawnConfig (which
```

### MEDIUM

**Event emission pattern changed from `await` to fire-and-forget** - `src/implementations/event-driven-worker-pool.ts:623-633`
**Confidence**: 85%
- Problem: `handleWorkerCompletion` changed from `async` (with `await this.eventBus.emit(...)`) to synchronous with fire-and-forget `.emit().catch()`. The entire rest of the codebase (all handlers in `src/services/handlers/*.ts`, recovery-manager, etc.) consistently uses `await this.eventBus.emit(...)`. This is an intentional design change per the PR, but it introduces a pattern divergence. The method signature changed from `async ... Promise<void>` to `void`, meaning callers can no longer await completion of event propagation.
- Fix: Add a DECISION comment explaining why fire-and-forget is required here (likely: `handleWorkerCompletion` is called from a synchronous `onExit` callback path where `await` is not possible). Without this comment, future developers will see the inconsistency and either "fix" it back to `await` or propagate the pattern elsewhere incorrectly. Something like:
```typescript
// DECISION: Fire-and-forget emit — this method is called synchronously from
// the tmux onExit callback (via flushOutput().finally()). Awaiting would require
// making the entire callback chain async, which risks re-ordering with other
// synchronous cleanup paths. Errors are logged and do not lose task completion.
```

**`killAll` changed from `Promise.allSettled` to `Promise.all`** - `src/implementations/event-driven-worker-pool.ts:294`
**Confidence**: 82%
- Problem: The old code used `Promise.allSettled` which guaranteed all workers would be attempted even if one kill throws. The new code uses `Promise.all` which will short-circuit on the first rejection. However, since `kill()` returns `Result<void>` (never throws), this is safe in practice -- but it's a subtle behavioral change that breaks the defensive pattern. If `kill()` ever throws (e.g., from an unexpected error in tmuxConnector), remaining workers would not be killed.
- Fix: Either keep `Promise.allSettled` for defensive robustness (matching the original pattern), or add a comment explaining why `Promise.all` is safe:
```typescript
// DECISION: Promise.all is safe here because kill() returns Result<void>
// (catches all errors internally). allSettled is unnecessary overhead.
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**ProcessSpawnerAdapter uses `as unknown as TmuxSpawnConfig` double-cast** - `src/implementations/process-spawner-adapter.ts:60`
**Confidence**: 85%
- Problem: The fabricated config object uses `as unknown as TmuxSpawnConfig` -- a double-cast that bypasses all type checking. This is in production code (not test fixtures). The `mock-agent.ts` test fixture uses the same pattern, which is acceptable in tests but not in an adapter that ships to npm. The config has `command: 'echo'` which would actually execute `echo` in a tmux session if this adapter were ever used at runtime (unlikely but not impossible).
- Fix: Since this adapter is only used in tests, consider either (a) creating a minimal valid `TmuxSpawnConfig` subset type for test stubs, or (b) documenting that this adapter is test-only and the fabricated config is never actually executed by TmuxConnector.

## Pre-existing Issues (Not Blocking)

(none found at CRITICAL severity)

## Suggestions (Lower Confidence)

- **Stale ARCHITECTURE comment in agents.ts** - `src/core/agents.ts:321-322` (Confidence: 75%) -- The comment says "The concrete type will move to src/core when Phase 3 (WorkerPool rewiring) establishes it as a first-class domain concept." Phase 3 is this PR, but TmuxSpawnConfig was intentionally kept in the implementations layer with consumer-facing ports extracted to `core/tmux-types.ts`. The comment should be updated to reflect the actual Phase 3 decision.

- **Duplicated liveness-check logic in RecoveryManager** - `src/services/recovery-manager.ts:169-176,427-432` (Confidence: 70%) -- The tmux-vs-process liveness decision tree (isTmuxWorker ? sessionName ? isTmuxSessionAlive : false : isProcessAlive) is duplicated in both `cleanDeadWorkerRegistrations` and `recoverRunningTasks`. Consider extracting to a private `isWorkerAlive(reg)` method.

- **WorkerState.completionHandled is mutable on an otherwise readonly-leaning interface** - `src/implementations/event-driven-worker-pool.ts:45` (Confidence: 65%) -- Other WorkerState fields like `handle` and `task` are `readonly`, but `completionHandled` is declared as `completionHandled: boolean` (mutable). This is functionally correct (it must be mutated), but the inconsistency in modifier usage is notable.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Consistency Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The PR is well-structured and follows most existing patterns (Result types, DI, structured logging, migration conventions, Zod boundary validation). The core consistency issues are: (1) ProcessSpawnerAdapter now contradicts its own interface JSDoc contract -- the contract or the implementation must be updated to match (avoids PF-001 -- this should not be deferred); (2) the JSDoc/code mismatch on `unknown` vs `any` in TmuxConnectorPort; (3) the event emission pattern shift needs a DECISION comment explaining the divergence from the codebase-wide `await emit()` convention. The migration (v29), worker repository, and recovery manager changes all follow established patterns consistently.
