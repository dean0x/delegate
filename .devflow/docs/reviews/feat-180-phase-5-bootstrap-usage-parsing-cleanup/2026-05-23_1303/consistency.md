# Consistency Review Report

**Branch**: feat/180-phase-5-bootstrap-usage-parsing-cleanup -> main
**Date**: 2026-05-23

## Issues in Your Changes (BLOCKING)

(none)

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Two `failWith` closures with different signatures** - `orchestrate-interactive.ts:134,199` (Confidence: 65%) -- The first `failWith` accepts `(msg: string)` while the second accepts `(msg: string, handleToDestroy?: TmuxHandle)`. Both are scoped to different functions (`resolveContainerDeps` vs `spawnAndDeliverPrompt`) so there is no ambiguity, but a shared abstraction could reduce duplication. This is a stylistic preference -- the scoped closures are contextually appropriate since each captures different cleanup logic.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Consistency Score**: 9/10
**Recommendation**: APPROVED

## Detailed Analysis

### Pattern Consistency Assessment

**1. Naming Conventions** -- All additions follow existing camelCase patterns. New interfaces (`SpawnPromptContext`, `AttachAndFinalizeContext`) match the codebase convention of `PascalCase` for types and `camelCase` for variables/methods. The `tryReuseSession` private method follows the `verb+Noun` pattern used by `cleanupPersistentSession`, `cleanupWorkerState`, `setupTimeoutForWorker`, etc.

**2. Error Handling Patterns** -- The `failWith` closure pattern in `orchestrate-interactive.ts` is a new local pattern for this file, but it replaces inline `ui.error() + container.dispose() + process.exit(1)` blocks that were repeated verbatim 3-4 times. The extracted pattern is consistent with the DRY principle and does not deviate from how other CLI commands handle fatal exits (they all call `process.exit` directly). The `Promise<never>` return type is correctly applied to communicate the no-return semantics.

**3. Return Type Consistency** -- `resolveContainerDeps` changes from `Promise<ContainerDeps | null>` to `Promise<ContainerDeps>`, and `spawnAndDeliverPrompt` changes from `Promise<SpawnedSession | null>` to `Promise<SpawnedSession>`. Both functions call `process.exit(1)` on failure, making `null` unreachable. Removing the `| null` union makes the type system accurately reflect runtime behavior. The null guard checks (`if (!deps) return`, `if (!session) return`) in the caller are correspondingly removed -- correct and consistent.

**4. Context Object Pattern** -- Converting `spawnAndDeliverPrompt` from positional parameters to a context object (`SpawnPromptContext`) and `attachAndFinalize` to `AttachAndFinalizeContext` follows a pattern already used in this codebase (`LaunchParams` in the same file, `StreamCallbackContext` in translation-proxy, `DashboardMutationContext` in dashboard). All fields are marked `readonly`, matching the existing interface convention for these context/params types.

**5. Interface Removal: `updateInteractiveOrchestrationPid`** -- Removed from `OrchestrationService` interface, its implementation, and all tests. No orphaned references remain in `src/` or `tests/`. Tests that previously called it now use `orchestrationRepo.update(updateOrchestration(..., { pid: 99999 }))` to seed the DB directly, which correctly isolates the test to the cancel path without depending on removed API surface. This is a clean break forward (avoids PF-002).

**6. `TmuxSpawnCoreConfig.env` Addition** -- Adding `readonly env?: Record<string, string>` to the core type eliminates the `as unknown as` double cast that was previously needed to access `env`. This improves type safety and matches the existing optional field pattern (`persistent?: boolean`) on the same interface. The JSDoc comment explains why the field exists and how callers interact with it.

**7. `PersistentSessionEntry` Expansion** -- Adding `taskIdRef` and `agentProvider` fields to this interface is consistent with the `readonly` field pattern used on all its existing members (`handle`, `workerId`). The DESIGN DECISION comment block follows the same format used for other design decisions in this file.

**8. `tryReuseSession` Extraction** -- The logic extracted from `spawn()` into `tryReuseSession()` preserves all the original guard semantics (reuseInProgress check, existence check, liveness check, reuse-or-fallthrough). The extraction maintains the same log messages, structured logging context objects, and `return null` sentinel pattern. The `Worker | null` return type mirrors the `ok(null)` sentinel pattern in `reuseSession()`.

**9. `reuseSession` B1-x Fixes** -- The five numbered fixes (B1-1 through B1-5) follow a consistent pattern: each fix has a JSDoc annotation explaining the bug, the fix is inline with a comment referencing the fix label, and a corresponding regression test exists. The fix labels are used consistently across the implementation and tests (e.g., `B1-1` in both `reuseSession()` JSDoc and `it('B1-1: ...')` test names).

**10. Test Pattern Consistency** -- New tests in `event-driven-worker-pool.test.ts` follow the established structure: descriptive `it(...)` names with regression labels, the `buildPersistentTask` helper, `vi.advanceTimersByTimeAsync` for timer advancement, and `Promise.all([pool.spawn(...), vi.advanceTimersByTimeAsync(...)])` for concurrent reuse tests. The test for `B1-2` correctly uses a manual `sendKeysCallCount` tracker rather than `mockReturnValueOnce` chains -- matching the pattern established in the existing reuse tests where call ordering across `/clear` and prompt delivery matters.

**11. Dead Code Removal** -- The removed `updateInteractiveOrchestrationPid` test suite (lines 585-707 in old file) is cleanly excised. No commented-out code, no TODO markers left behind. The SIGTERM fallback path tests are preserved and adapted to seed PID via repo directly.

**12. `EXIT_CALLBACK_DEADLINE_MS` Constant** -- The magic number `2000` (previously inline in `setTimeout(resolve, 2000)`) is extracted to a named constant with a JSDoc description. This matches the codebase pattern of extracting timing constants (e.g., `CLEAR_SETTLE_MS` in the same file).
