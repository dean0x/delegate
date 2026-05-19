# TypeScript Review Report

**Branch**: feat/177-agent-adapter-migration -> main
**Date**: 2026-05-19

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Unsafe branded-type cast circumvents TaskId type safety** - `src/implementations/base-agent-adapter.ts:137`
**Confidence**: 90%
- Problem: `(options.taskId ?? '') as TaskId` casts an empty string to the branded `TaskId` type when `taskId` is undefined. `TaskId` is `string & { readonly __brand: 'TaskId' }` (branded type per domain.ts:9), so this bypass defeats the entire point of branding — downstream consumers (tmux hooks, connector, session manager) will receive an empty-string task ID that looks valid to the type checker but is semantically meaningless. The empty string also produces a tmux session name of `beat-task-` (line 131), which passes `SESSION_NAME_REGEX` but carries no identifying information.
- Fix: Either require `taskId` in the method signature (since tmux always operates on a concrete task), or return an error when `taskId` is missing:
```typescript
// Option A: Make taskId required in the signature
buildTmuxCommand(options: SpawnOptions & { sessionsDir: string; taskId: string }): Result<...>

// Option B: Guard at runtime (preserves SpawnOptions shape)
if (!options.taskId) {
  return err(agentMisconfigured(this.provider, 'taskId is required for tmux mode'));
}
// Then use options.taskId directly — TypeScript narrows it to string
const taskId = TaskId(options.taskId);
```

**`buildTmuxCommand` not on `AgentAdapter` interface — structural gap between implementations** - `src/core/agents.ts:273`, `src/implementations/base-agent-adapter.ts:114`, `src/implementations/process-spawner-adapter.ts:46`
**Confidence**: 82%
- Problem: `buildTmuxCommand` is implemented on both `BaseAgentAdapter` (public method) and `ProcessSpawnerAdapter` (standalone implementation of `AgentAdapter`), but the `AgentAdapter` interface at agents.ts:273 does not declare it. Code that only holds an `AgentAdapter` reference (e.g., code resolving from `AgentRegistry`) cannot call `buildTmuxCommand` without a type assertion or downcast. Since both concrete implementations already provide the method, the intent appears to be that all adapters expose this capability. The current state forces callers to use `(adapter as BaseAgentAdapter).buildTmuxCommand(...)` or similar patterns, which undermines the Strategy pattern that `AgentAdapter` was designed to enable.
- Fix: Add `buildTmuxCommand` to the `AgentAdapter` interface:
```typescript
export interface AgentAdapter {
  // ... existing members ...

  /**
   * Produce a TmuxSpawnConfig + prompt for tmux session setup.
   * Returns err(INVALID_OPERATION) for adapters that do not support tmux.
   */
  buildTmuxCommand(
    options: SpawnOptions & { sessionsDir: string },
  ): Result<{ readonly config: TmuxSpawnConfig; readonly prompt: string }>;
}
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Type assertion `as TmuxAgentType` is safe post-guard but could use a type narrowing helper** - `src/implementations/base-agent-adapter.ts:136`
**Confidence**: 65% (moved to Suggestions)

## Pre-existing Issues (Not Blocking)

(none above CRITICAL threshold)

## Suggestions (Lower Confidence)

- **Narrowing helper instead of `as TmuxAgentType` cast** - `src/implementations/base-agent-adapter.ts:136` (Confidence: 65%) -- The runtime guard at line 118 (`this.provider !== 'claude' && this.provider !== 'codex'`) correctly narrows the provider to `'claude' | 'codex'`, but TypeScript does not narrow `this.provider` through a negative check on `this`. The `as TmuxAgentType` cast is safe given the guard, but a small type predicate helper (`isTmuxAgent(provider: AgentProvider): provider is TmuxAgentType`) would let the compiler verify narrowing without the cast.

- **`buildTmuxArgs` default returns `[]` in base class with no override enforcement** - `src/implementations/base-agent-adapter.ts:105` (Confidence: 62%) -- The default `buildTmuxArgs` returns `[]` instead of being `abstract`. A new adapter subclass that forgets to override it would silently produce an agent process with no args. Since this is Phase 2 with only Claude and Codex, the risk is low and the guard at line 118 prevents other adapters from reaching this code path.

- **Test FakeAdapter uses `as any` for provider** - `tests/unit/implementations/build-tmux-command.test.ts:389` (Confidence: 72%) -- The biome-ignore comment acknowledges the `as any`, and this is test code exercising an intentionally invalid provider. The `any` is justified by the testing context, but `as unknown as AgentProvider` would be slightly safer while still allowing the invalid value.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**TypeScript Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The branded-type cast and missing interface method are the two findings that warrant attention. The branded-type bypass (`'' as TaskId`) is the more concerning of the two -- it silently produces an invalid task ID that passes type checks. The interface gap is a design consideration that becomes important as Phase 3 consumers need to call `buildTmuxCommand` through the `AgentAdapter` abstraction. Both issues are addressable without structural changes to the PR. (avoids PF-002 -- Gemini removal is a clean break with zero users, which is correct per pitfall guidance.)
