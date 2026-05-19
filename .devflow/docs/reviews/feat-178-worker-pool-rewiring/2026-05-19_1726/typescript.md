# TypeScript Review Report

**Branch**: feat/178-worker-pool-rewiring -> main
**Date**: 2026-05-19

## Issues in Your Changes (BLOCKING)

### HIGH

**`any` type in TmuxConnectorPort.spawn() config parameter** - `src/core/tmux-types.ts:92`
**Confidence**: 95%
- Problem: The `spawn()` method on the core port interface uses `any` for the `config` parameter with a biome-ignore suppression. The JSDoc comments on lines 82-83 state the intent was `unknown`, but the actual type is `any`. This disables type checking at every call site that uses the port interface, defeating the purpose of the port abstraction. The comment on line 88 says "kept as any here" while line 82 says "uses `unknown` for config" -- these are contradictory.
- Fix: Use `unknown` as the JSDoc already claims, and have the concrete `TmuxConnector.spawn()` accept `TmuxSpawnConfig` with a type assertion at the implementation boundary:
  ```typescript
  // In TmuxConnectorPort (core/tmux-types.ts):
  spawn(config: unknown, callbacks: SpawnCallbacks): Result<TmuxHandle, AutobeatError>;

  // In TmuxConnector (implementations/tmux/tmux-connector.ts):
  spawn(config: unknown, callbacks: SpawnCallbacks): Result<TmuxHandle, AutobeatError> {
    const typedConfig = config as TmuxSpawnConfig; // assertion at implementation boundary
    // ... rest of method
  }
  ```
  This preserves the layer separation while keeping `any` out of the port interface. Call sites in the implementations layer that construct config objects get full type safety from their local `TmuxSpawnConfig` imports; the `unknown` port only affects the DI boundary where the concrete type is already known.

**`as unknown as TmuxSpawnConfig` double-cast in ProcessSpawnerAdapter** - `src/implementations/process-spawner-adapter.ts:60`
**Confidence**: 90%
- Problem: The `buildTmuxCommand` method constructs a partial object literal and casts it through `as unknown as TmuxSpawnConfig`. This bypasses all structural checks -- if `TmuxSpawnConfig` gains required fields, this code will silently produce an incomplete config object at runtime. The cast hides the fact that the returned config is missing fields that `TmuxSpawnConfig` requires (e.g., `staleness`, `env`, `width`, `height`).
- Fix: Since this adapter is specifically for test mocks that inject `ProcessSpawner`, define a minimal test-compatible type or use `Partial<TmuxSpawnConfig>` with an explicit comment. Better yet, since the config flows into `TmuxConnectorPort.spawn()` which accepts `any`/`unknown` and the mock connector ignores the config anyway, return a plain object without the cast:
  ```typescript
  buildTmuxCommand(
    options: SpawnOptions & { sessionsDir: string },
  ): Result<{ readonly config: TmuxSpawnConfig; readonly prompt: string }> {
    const taskId = (options.taskId ?? 'task-unknown') as TaskId;
    // Test adapter: config is a minimal stub passed to MockTmuxConnector
    // which ignores config internals. Full type safety is enforced in
    // real adapters (ClaudeAdapter, CodexAdapter).
    const config: Partial<TmuxSpawnConfig> = {
      name: `beat-${taskId}`,
      command: 'echo',
      cwd: options.workingDirectory || process.cwd(),
      taskId,
      sessionsDir: options.sessionsDir,
      agent: 'claude' as const,
      agentArgs: [],
    };
    return ok({ config: config as TmuxSpawnConfig, prompt: options.prompt });
  }
  ```
  The single `as TmuxSpawnConfig` is still needed but `Partial<>` makes the intent explicit and catches any fields whose names you mistype.

**`as any` cast on `fs.watch` in bootstrap** - `src/bootstrap.ts:529`
**Confidence**: 85%
- Problem: `fs.watch as any` casts away the type system entirely. The biome-ignore comment states "fs.watch overloads don't match WatchFn structurally" but uses `any` rather than addressing the structural mismatch.
- Fix: Define a narrow adapter function that matches `WatchFn` exactly, avoiding the cast:
  ```typescript
  const watchFn: WatchFn = (path, options, listener) => fs.watch(path, options, listener);
  ```
  Or if `WatchFn` is close but not identical, use a targeted `as WatchFn` cast instead of `as any`, which at least preserves the output type.

### MEDIUM

**Branded type not used for WorkerId construction** - `src/implementations/event-driven-worker-pool.ts:434`
**Confidence**: 82%
- Problem: `const workerId: WorkerId = 'worker-beat-${task.id}' as WorkerId` uses a raw `as` assertion instead of the `WorkerId()` branded constructor used elsewhere in the codebase (e.g., `WorkerId(data.worker_id)` in `worker-repository.ts:197`). This bypasses any validation the branded constructor provides.
- Fix: Use the branded constructor consistently:
  ```typescript
  const workerId = WorkerId(`worker-beat-${task.id}`);
  ```

**`options.taskId ?? 'task-unknown'` fallback with `as TaskId` cast** - `src/implementations/process-spawner-adapter.ts:50`
**Confidence**: 80%
- Problem: If `options.taskId` is undefined, the string `'task-unknown'` is cast to `TaskId`. This creates a fake branded type value that could propagate into DB operations or event emission. The `TaskId` branded type exists to prevent exactly this kind of arbitrary string.
- Fix: Either require `taskId` on the adapter input type, or return an error when it's missing:
  ```typescript
  if (!options.taskId) {
    return err(new AutobeatError(ErrorCode.INVALID_OPERATION, 'taskId is required for buildTmuxCommand'));
  }
  const taskId = options.taskId as TaskId;
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`completionHandled` is mutable on an otherwise `readonly`-patterned interface** - `src/implementations/event-driven-worker-pool.ts:45`
**Confidence**: 82%
- Problem: `WorkerState` has `readonly handle` and `readonly task` but `completionHandled: boolean` (no `readonly`). This is intentionally mutable (it's a flag that gets set to `true`), but the inconsistency with the other fields makes the design intent unclear. Consider documenting that this is an intentional mutation point.
- Fix: This is acceptable as-is since it is a guard flag, but adding a brief inline note like `/** Mutable: set once to guard against double completion */` would clarify intent beyond the existing G2 comment. Alternatively, since `cleanupFn`, `timeoutTimer`, `heartbeatTimer`, and `flushInterval` are also mutable, the `readonly` on `handle` and `task` is the exception rather than the rule -- the pattern is already consistent.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`getFromContainer` uses `as T` unsafe cast** - `src/bootstrap.ts:162`
**Confidence**: 85%
- Problem: `return result.value as T` casts `unknown` to an arbitrary generic without runtime validation. This is a pre-existing pattern throughout bootstrap factory functions. Not introduced by this PR.
- Note: The pattern is consistent with how the DI container works in this codebase, but it means container misregistration silently produces wrong types at runtime.

## Suggestions (Lower Confidence)

- **Narrower type for `sendControlKeys` `keys` parameter** - `src/core/tmux-types.ts:71`, `src/implementations/tmux/tmux-session-manager.ts:233` (Confidence: 65%) -- The `keys` parameter is `string` but only well-known tmux key names should be passed (`'C-c'`, `'Enter'`). A string literal union type like `type TmuxControlKey = 'C-c' | 'Enter' | 'C-d'` would prevent accidental misuse, though it would need to be expanded as new keys are needed.

- **`TmuxSessionManagerCorePort` could include `sendControlKeys` optionally** - `src/core/tmux-types.ts:65-72` (Confidence: 60%) -- `sendControlKeys` is on `TmuxSessionManagerCorePort` but only `isAlive` is used by `RecoveryManager`. If `sendControlKeys` is only used by `TmuxConnector` (which imports the full port), the core port could be slimmed to just `isAlive`.

- **Non-null assertion on `tmuxSessionManager!`** - `src/bootstrap.ts:521` (Confidence: 75%) -- `const tmuxSessionManager = options.tmuxConnector ? undefined : new TmuxSessionManager(...)` followed by `tmuxSessionManager!` inside the else branch at line 521. The logic guarantees non-null, but the `!` assertion is fragile if the conditional is refactored. Consider restructuring to avoid the assertion.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 3 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**TypeScript Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The core typing architecture is solid -- port interfaces in `core/tmux-types.ts`, branded types for domain IDs, `Result` types throughout, and good use of `import type`. The three HIGH issues all involve `any` types or unsafe casts that could be replaced with `unknown` or narrower alternatives. The `TmuxConnectorPort.spawn()` `any` parameter is the most impactful since it defines the contract for all consumers of the port interface. The `ProcessSpawnerAdapter` double-cast and `fs.watch as any` are localized but still bypass type checking unnecessarily. Fixing the `any` usage and branded type consistency would bring this to a strong 9/10. avoids PF-001 (all issues surfaced, none deferred).
