# Architecture Review Report

**Branch**: feat/177-agent-adapter-migration -> main
**Date**: 2026-05-19

## Issues in Your Changes (BLOCKING)

### HIGH

**`buildTmuxCommand` not on `AgentAdapter` interface** - `src/core/agents.ts:273`
**Confidence**: 92%
- Problem: `buildTmuxCommand()` is implemented on both `BaseAgentAdapter` (line 114) and `ProcessSpawnerAdapter` (line 46), but is NOT declared on the `AgentAdapter` interface (lines 273-310). Consumers holding an `AgentAdapter` reference (which is the standard — `AgentRegistry.get()` returns `Result<AgentAdapter>`) cannot call `buildTmuxCommand()` without a type assertion or downcast. Phase 3 (WorkerPool rewiring) will need to call this method on adapters retrieved from the registry, forcing either unsafe casts or a refactor at that point.
- Fix: Add `buildTmuxCommand` to the `AgentAdapter` interface:
  ```typescript
  // In src/core/agents.ts, AgentAdapter interface:
  import type { TmuxSpawnConfig } from '../implementations/tmux/types.js';

  buildTmuxCommand(
    options: SpawnOptions & { sessionsDir: string },
  ): Result<{ readonly config: TmuxSpawnConfig; readonly prompt: string }>;
  ```
  Note: this creates a dependency from core → implementations for the `TmuxSpawnConfig` type. If this dependency direction is undesirable, extract `TmuxSpawnConfig` into `src/core/` or define a narrower return type in core. The current approach of leaving it off the interface will force Phase 3 to either add it then (touching every consumer) or use unsafe casts.

**Runtime type-assertion cast `this.provider as TmuxAgentType` bypasses type safety** - `src/implementations/base-agent-adapter.ts:138`
**Confidence**: 85%
- Problem: `buildTmuxCommand()` performs a runtime string check (`if (this.provider !== 'claude' && this.provider !== 'codex')`) on line 118-120, then casts with `this.provider as TmuxAgentType` on line 138. The runtime guard is correct, but the `as` cast bypasses the compiler. If `AgentProvider` is later extended with a new value (e.g., a future agent), the runtime check would need to be updated manually — the compiler would not flag it because the `as` cast suppresses the error. This is a mild DIP concern: the guard should narrow the type rather than assert it.
- Fix: Use a type-narrowing helper that the compiler can verify:
  ```typescript
  function isTmuxCompatible(provider: AgentProvider): provider is TmuxAgentType {
    return provider === 'claude' || provider === 'codex';
  }
  ```
  Then use it:
  ```typescript
  if (!isTmuxCompatible(this.provider)) {
    return err(agentMisconfigured(this.provider, 'tmux mode is not supported for this agent'));
  }
  // this.provider is now narrowed to TmuxAgentType — no cast needed
  agent: this.provider,
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`TmuxSpawnConfig` import from `./tmux/types.js` in `base-agent-adapter.ts` creates upward coupling** - `src/implementations/base-agent-adapter.ts:38`
**Confidence**: 82%
- Problem: `BaseAgentAdapter` (the abstract base for all agent adapters) imports `TmuxSpawnConfig` and `TmuxAgentType` directly from `./tmux/types.js`. This couples the agent adapter layer to the tmux implementation layer. The tmux layer was designed as "a pure infrastructure module" (per feature knowledge) with `TmuxConnectorPort` intentionally kept in `types.ts` rather than `core/interfaces.ts` pending Phase 3. Now that `buildTmuxCommand` references these types, there is an upward coupling: the base adapter (which lives at the same level as the tmux module) depends on tmux-specific types. This is acceptable for Phase 2 but should be tracked for Phase 3 cleanup when the dependency direction is established by actual WorkerPool consumers.
- Fix: No immediate code change required. When Phase 3 lands, either (a) promote `TmuxSpawnConfig` and `TmuxAgentType` to `src/core/` types, or (b) introduce a narrower `TmuxCommandResult` interface in core that the adapter returns. The current import path is pragmatic for an unreleased API (avoids PF-002: no backward-compat for unreleased features).

## Pre-existing Issues (Not Blocking)

(None at CRITICAL severity in reviewed files.)

## Suggestions (Lower Confidence)

- **`TmuxSpawnConfig.env` typed as optional but always populated** - `src/implementations/tmux/types.ts:37` / `src/implementations/base-agent-adapter.ts:135` (Confidence: 65%) -- `TmuxSpawnConfig.env` is typed as `Record<string, string>?` (optional via `TmuxSessionConfig`), but `buildTmuxCommand` always populates it via `buildSpawnEnv`. Phase 3 consumers would benefit from a non-optional `env` on `TmuxSpawnConfig` to avoid unnecessary null checks. Low priority since the config is assembled in one place.

- **Three arg-building methods could share validation** - `src/implementations/base-agent-adapter.ts` (Confidence: 62%) -- `buildArgs`, `buildInteractiveArgs`, and `buildTmuxArgs` are three separate abstract/virtual methods with slightly different flag sets. A table-driven approach (mode -> flags mapping) could reduce the surface area for bugs when adding a new mode. However, the current Template Method pattern is clear and well-tested with 30+ new tests. The three methods have distinct flag semantics (headless vs interactive vs tmux) that may resist unification.

- **Barrel export reorder in `tmux/index.ts` is cosmetic but may cause merge conflicts** - `src/implementations/tmux/index.ts:16-18` (Confidence: 70%) -- The diff moves `TmuxValidator` exports after the shell utilities export. This is alphabetical cleanup but creates a merge conflict surface if other branches touch the same barrel. Minor concern.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 0 | - |
| Should Fix | - | 0 | 1 | - |
| Pre-existing | - | - | 0 | 0 |

**Architecture Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Rationale

This PR executes a well-structured architectural migration:

1. **Gemini removal is clean and thorough** -- `AgentProvider` narrowed to `'claude' | 'codex'`, `GeminiAdapter` deleted, bootstrap wiring updated, MCP tool descriptions purged, CLI subcommand removed, migration v28 handles existing data gracefully (maps gemini judge_agent to NULL). No dangling Gemini references remain in non-migration source code. This is a correct clean break (avoids PF-002 -- Gemini support was released but is being intentionally dropped per the epic).

2. **Template Method pattern for `buildTmuxArgs` is the right design** -- Adding a third arg-building method (`buildTmuxArgs`) alongside `buildArgs` (headless) and `buildInteractiveArgs` (terminal) follows the established Template Method pattern in `BaseAgentAdapter`. Each mode has genuinely different flag semantics (tmux omits `--print`/`--quiet` and the prompt, since the prompt is delivered via `send-keys`). The override in `ClaudeAdapter` (`--output-format stream-json`) and `CodexAdapter` (`--full-auto` without `--quiet`) are agent-specific and belong in the subclasses.

3. **`buildTmuxCommand` properly reuses `resolveSpawnConfig`** -- The new method shares the full resolution chain (runtime, auth, model, system prompt, env assembly) with `spawn()` and `spawnInteractive()`, avoiding duplication. The three-way split (resolve config once, build mode-specific args, assemble result) is clean.

4. **`TmuxConnector` change is minimal and correct** -- The single-line change from `agentArgs: []` to `agentArgs: config.agentArgs` bridges adapter-produced args into the wrapper script. The `TmuxSpawnConfig` type was extended with `agentArgs: readonly string[]` to carry this data.

5. **Migration v28 is safe** -- The table-recreation pattern with `CASE WHEN judge_agent = 'gemini' THEN NULL` handles the data migration correctly, and indexes are recreated.

The two HIGH findings (missing interface declaration and type-assertion cast) are both Phase 3 preparation concerns. They do not create bugs today but will require attention when WorkerPool integration lands. The conditions for approval are:

- Add `buildTmuxCommand` to the `AgentAdapter` interface (or document the intentional omission with a JSDoc DECISION comment explaining why and when it will be added)
- Replace the `as TmuxAgentType` cast with a proper type-narrowing guard
