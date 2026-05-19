# TypeScript Review Report

**Branch**: feat/177-agent-adapter-migration -> main
**Date**: 2026-05-19

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

### MEDIUM

**Inline `import()` type in interface breaks type-only import convention** - `src/core/agents.ts:325`
**Confidence**: 82%
- Problem: The `buildTmuxCommand` return type uses an inline dynamic `import('../implementations/tmux/types.js').TmuxSpawnConfig` inside the `AgentAdapter` interface. This creates a value-level module resolution dependency from a core interface to an implementation module. While TypeScript resolves this as type-only at compile time, it breaks the project's established pattern where core types do not reference implementation paths. The `base-agent-adapter.ts` correctly uses `import type { TmuxSpawnConfig } from './tmux/types.js'` at the top level, showing the preferred pattern.
- Fix: Add a top-level `import type` and use it directly:
  ```typescript
  // At top of src/core/agents.ts
  import type { TmuxSpawnConfig } from '../implementations/tmux/types.js';
  
  // In the interface
  buildTmuxCommand(options: SpawnOptions & { sessionsDir: string }): Result<{
    readonly config: TmuxSpawnConfig;
    readonly prompt: string;
  }>;
  ```
  Note: The JSDoc on the method already acknowledges this will move to `src/core` in Phase 3. If you prefer to defer to keep the diff minimal, this is acceptable as a tracked architectural debt item -- but the inline import is still unusual for this codebase.

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **`as TaskId` cast on line 158 of base-agent-adapter.ts** - `src/implementations/base-agent-adapter.ts:158` (Confidence: 68%) -- The `options.taskId as TaskId` cast relies on the caller passing a valid TaskId. The taskId guard at line 125 ensures it is non-empty, but does not validate the branded type invariant. A `parseTaskId()` function or branded-type constructor would be safer, though this may be deferred to when TaskId branding is formalized across the codebase.

- **`biome-ignore lint/suspicious/noExplicitAny` in test** - `tests/unit/implementations/build-tmux-command.test.ts:436` (Confidence: 62%) -- The `as any` cast for the FakeAdapter's provider is intentional (testing an invalid provider), and the biome-ignore comment documents the intent. Acceptable for this test scenario.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**TypeScript Score**: 9/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Strengths

1. **Clean Gemini removal** -- `AgentProvider` type narrowed from `'claude' | 'codex' | 'gemini'` to `'claude' | 'codex'`; all downstream references (AGENT_PROVIDERS_TUPLE, AGENT_DESCRIPTIONS, AGENT_AUTH, AGENT_BASE_URL_ENV) are consistent. No remaining 'gemini' references outside historical migration code (avoids PF-002 -- clean break, no backward-compat scaffolding for a dropped feature).

2. **Explicit narrowing over type assertion** -- `buildTmuxCommand` at line 141 uses `this.provider === 'claude' ? 'claude' : 'codex'` to produce `TmuxAgentType` instead of the previous `this.provider as TmuxAgentType` cast. This is the correct TypeScript pattern -- the guard at line 134 ensures only valid values reach the assignment, and the ternary produces a type-safe value.

3. **TaskId guard eliminates empty-string cast** -- The previous code used `(options.taskId ?? '') as TaskId` which could produce an empty branded type. The new guard at line 125 returns an error for missing taskId, making the `as TaskId` cast at line 158 safe (non-empty string guaranteed).

4. **Migration v28 data handling** -- The `CASE WHEN judge_agent = 'gemini' THEN NULL ELSE judge_agent END` in the migration correctly maps existing gemini rows to NULL before applying the narrowed CHECK constraint. The `UPDATE tasks SET agent = NULL WHERE agent = 'gemini'` handles the tasks table which has no DB-level CHECK on agent.

5. **Test coverage** -- `buildTmuxCommand` tests cover return shape, adapter-specific args, error paths (missing taskId, unsupported provider, ProcessSpawnerAdapter), and edge cases (system prompt, model, orchestratorId, ollama runtime). The `it.each` consolidation for the taskId guard test is clean.

6. **`import type` usage** -- The `base-agent-adapter.ts` correctly uses `import type { TmuxAgentType, TmuxSpawnConfig }` for types that are not needed at runtime, following the project's convention.

7. **No `any` types in production code** -- All new code uses proper types. The single `any` in test code is suppressed with a documented biome-ignore comment for an intentionally invalid test scenario.
