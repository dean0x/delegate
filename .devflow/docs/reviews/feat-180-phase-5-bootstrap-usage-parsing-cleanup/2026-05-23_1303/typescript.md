# TypeScript Review Report

**Branch**: feat/180-phase-5-bootstrap-usage-parsing-cleanup -> main
**Date**: 2026-05-23
**Cycle**: 3 (incremental after cycle 2 resolved 17/20 issues)

## Prior Resolution Verification

All cycle 2 TypeScript fixes verified as correctly implemented:
- B3-1 (double `as unknown` cast): Resolved by adding `env?: Record<string, string>` to `TmuxSpawnCoreConfig` (tmux-types.ts:85-91). The interactive orchestrator now accesses `rawTmuxConfig.env` directly (orchestrate-interactive.ts:230) with zero casts.
- B3-4 (misleading nullable return): `spawnAndDeliverPrompt` now returns `Promise<SpawnedSession>` (never null), `resolveContainerDeps` returns `Promise<ContainerDeps>` (never null). Both use `failWith(): Promise<never>` helper. Dead-code null checks at call sites removed.
- B5-2 (dead method removal): `updateInteractiveOrchestrationPid` removed from both `OrchestrationService` interface (interfaces.ts:885-907) and `OrchestrationManagerService` implementation (orchestration-manager.ts:438-458). Tests updated to use `updateOrchestration` + direct repo write for the pre-Phase-5 PID seeding path.

## Issues in Your Changes (BLOCKING)

(none)

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **`attachAndFinalize` return type `Promise<never>` is correct but callers lose type narrowing benefit** - `src/cli/commands/orchestrate-interactive.ts:300,480` (Confidence: 60%) -- `attachAndFinalize` correctly returns `Promise<never>` since every path calls `process.exit`. However, at the call site (line 480), `await attachAndFinalize(...)` is the last statement in the try block, so TypeScript does not eliminate the unreachable `catch` block. This is a common CLI pattern and not a bug -- the `never` return is properly typed. No action needed.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**TypeScript Score**: 9/10
**Recommendation**: APPROVED

The TypeScript quality is strong across all changed files:

1. **Type safety**: The double `as unknown` cast from cycle 1 is fully resolved -- `env` is now a first-class field on `TmuxSpawnCoreConfig` with proper JSDoc (tmux-types.ts:85-91). Zero type casts remain in the diff.

2. **`never` return types**: Both `failWith()` helpers and `attachAndFinalize()` correctly use `Promise<never>` to model the divergent control flow from `process.exit(1)`. The nullable return types from cycle 1 (`ContainerDeps | null`, `SpawnedSession | null`) are eliminated, removing dead-code null checks at call sites.

3. **Discriminated Result types**: All fallible operations consistently use `Result<T>` with proper narrowing (e.g., `reuseSession` returns `Result<Worker | null>` with `null` as a sentinel for "fall through to fresh spawn").

4. **Readonly interfaces**: `SpawnPromptContext`, `AttachAndFinalizeContext`, `ContainerDeps`, and `PersistentSessionEntry` all use `readonly` fields. The mutable `WorkerState` widening is properly documented with `@internal` JSDoc (added in cycle 2).

5. **Branded types**: `OrchestratorId`, `TaskId`, `WorkerId` used consistently throughout. The new `orchestrationId` field in `AttachAndFinalizeContext` (line 286) correctly uses the branded `OrchestratorId` type rather than raw `string`.

6. **Test type safety**: Test mock patterns use `ReturnType<typeof vi.fn>` for safe casting, destructuring with type annotations on filter callbacks (e.g., `[event, payload]: [string, { taskId: string }]`), and proper `as unknown as Task` for minimal-field test objects.
