# TypeScript Review Report

**Branch**: feat/180-phase-5-bootstrap-usage-parsing-cleanup -> main
**Date**: 2026-05-23

## Issues in Your Changes (BLOCKING)

### HIGH

**Double `as unknown` cast bypasses type safety for env stripping** - `src/cli/commands/orchestrate-interactive.ts:219-224`
**Confidence**: 85%
- Problem: The code uses `rawTmuxConfig as unknown as { env?: Record<string, string> }` to access `env`, then casts the modified config back through `as unknown as TmuxSpawnCoreConfig`. This double cast completely disables type checking. The comment acknowledges the type boundary is "intentionally opaque" but the cast could silently break if `TmuxSpawnCoreConfig` or its impl-level extension changes shape.
- Fix: Define a narrow intersection type at the call site to make the cast targeted rather than opaque:

```typescript
// Narrow the cast to exactly the fields we need, keeping type safety
// for the rest of the config object.
interface TmuxConfigWithEnv extends TmuxSpawnCoreConfig {
  env?: Record<string, string>;
}
const configWithEnv = rawTmuxConfig as TmuxConfigWithEnv;
const tmuxConfig: TmuxSpawnCoreConfig = configWithEnv.env
  ? {
      ...configWithEnv,
      env: Object.fromEntries(
        Object.entries(configWithEnv.env).filter(([k]) => k !== 'AUTOBEAT_WORKER'),
      ),
    }
  : rawTmuxConfig;
```

This avoids the double `as unknown` while still accessing `env`. Alternatively, add `env` as an optional field to `TmuxSpawnCoreConfig` itself if it is always present on real configs.

### MEDIUM

**WorkerState widens readonly `taskId` to mutable without type-level enforcement** - `src/implementations/event-driven-worker-pool.ts:77-84`
**Confidence**: 82%
- Problem: `Worker.taskId` is declared `readonly` in the base interface (`src/core/domain.ts:145`). `WorkerState` re-declares `taskId: TaskId` (mutable) and `task: Task` (mutable). TypeScript allows this because interfaces can widen inherited properties. However, any consumer holding a `Worker` reference (returned from `spawn()`, `getWorker()`, etc.) expects `taskId` to be immutable. If a downstream consumer caches `worker.taskId` and the pool mutates it via `reuseSession()`, the cached value silently diverges from the live state. The design comment acknowledges this tradeoff but it is not enforced at the type level.
- Fix: This is an architectural trade-off that is well-documented in comments (lines 73-75). The immediate risk is low because external consumers receive `Worker` (readonly) not `WorkerState`. No code change required, but consider adding a JSDoc `@internal` tag to `WorkerState` to signal it is not part of the public API:

```typescript
/** @internal Implementation-only state — never exposed outside the worker pool. */
interface WorkerState extends Worker {
```

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **`resolveContainerDeps` calls `process.exit(1)` but return type is `Promise<ContainerDeps | null>`** - `src/cli/commands/orchestrate-interactive.ts:133` (Confidence: 65%) -- The function returns `null` on failure in its signature, but every failure path calls `process.exit(1)` before returning. The `null` return is unreachable, making the null-check at the call site (`if (!deps) return;`) dead code. The `never` return type (via `process.exit`) is not captured. This is a common CLI pattern and not a bug, but it creates a type lie -- callers think they need to handle `null` when they never will.

- **`spawnAndDeliverPrompt` has the same `process.exit` + `null` return pattern** - `src/cli/commands/orchestrate-interactive.ts:181` (Confidence: 65%) -- Same observation as above. The `Promise<SpawnedSession | null>` return type implies `null` is a valid return for the caller to handle, but every failure path calls `process.exit(1)`. Consider extracting a `never`-typed helper for the exit pattern if this is a recurring convention.

- **`_simulateOutput` and `_simulateExit` test helpers use original task ID as key** - `tests/unit/implementations/event-driven-worker-pool.test.ts:1003` (Confidence: 70%) -- In the `onOutput callback routes output to the current iteration task` test, `tmuxConnector._simulateOutput(task1.id, ...)` is called after reuse to task2. The test works because the mock connector routes by registration order, but the test name and comment say "output arriving after reuse" while using `task1.id` as the key. This could be confusing to future readers -- the output is not actually arriving "for task1" but through the same connector subscription.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**TypeScript Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

Conditions:
1. The double `as unknown` cast in `orchestrate-interactive.ts:219-224` should be replaced with a targeted type approach. The current implementation works but defeats TypeScript's type safety guarantees at a boundary where runtime shape mismatches would be silent.

Overall the TypeScript quality is solid: Result types used consistently, discriminated unions for error handling, type-safe branded IDs, well-documented design decisions. The `TaskIdRef` mutable-ref pattern is a pragmatic solution to the stale-closure problem with good regression test coverage. The `WorkerState` mutable widening is documented and contained within the module boundary.
