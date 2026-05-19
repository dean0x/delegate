# Architecture Review Report

**Branch**: feat/177-agent-adapter-migration -> main
**Date**: 2026-05-19
**PR**: #187

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Core interface imports implementation-layer type via inline `import()`** - `src/core/agents.ts:324-326`
**Confidence**: 85%
- Problem: The `AgentAdapter` interface in `src/core/agents.ts` (core layer) references `TmuxSpawnConfig` via an inline `import('../implementations/tmux/types.js').TmuxSpawnConfig`. This creates a dependency from the core domain interface to the implementations layer. The JSDoc acknowledges this as temporary ("The concrete type will move to src/core when Phase 3 establishes it as a first-class domain concept"), but as shipped, this violates Clean Architecture's Dependency Rule: core must not depend on implementations.
- Impact: The violation is compile-time only (type-only import, zero runtime cost) and is explicitly flagged with a migration plan in the JSDoc. However, if Phase 3 is delayed, this inverted dependency becomes permanent. Any consumer of `AgentAdapter` now transitively knows about the tmux layer's type structure.
- Fix: Extract `TmuxSpawnConfig` (or a minimal subset like `AgentSessionConfig`) into `src/core/` now, and re-export from `src/implementations/tmux/types.ts`. This costs ~5 lines and eliminates the layering violation immediately rather than deferring to Phase 3.

```typescript
// src/core/agent-session-config.ts (new, minimal)
import type { TaskId } from './domain.js';
export type AgentSessionAgentType = 'claude' | 'codex';
export interface AgentSessionConfig {
  readonly name: string;
  readonly command: string;
  readonly agentArgs: readonly string[];
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly agent: AgentSessionAgentType;
  readonly taskId: TaskId;
  readonly sessionsDir: string;
}

// src/implementations/tmux/types.ts
import type { AgentSessionConfig } from '../../core/agent-session-config.js';
export interface TmuxSpawnConfig extends AgentSessionConfig {
  readonly staleness?: Partial<StalenessConfig>;
  readonly width?: number;
  readonly height?: number;
}
```

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

_No critical pre-existing architectural issues found in the reviewed files._

## Suggestions (Lower Confidence)

- **`buildTmuxCommand` makes `AgentAdapter` no longer a clean strategy interface** - `src/core/agents.ts:311-327` (Confidence: 70%) -- The `AgentAdapter` interface previously followed a clean Strategy pattern: all implementations had meaningful behaviors for all methods (spawn, spawnInteractive, kill, dispose, cleanup). Adding `buildTmuxCommand` introduces a method that `ProcessSpawnerAdapter` must stub with `INVALID_OPERATION`, which is an ISP borderline violation (callers of the interface now see a method they may never need). An alternative would be a separate `TmuxCapableAdapter` interface that extends `AgentAdapter`, and a type guard `isTmuxCapable(adapter)` at call sites. This is a design trade-off rather than a defect -- the current approach works and is documented. Noting for consideration as the tmux migration progresses.

- **Migration v28 runs `UPDATE tasks SET agent = NULL` before table rebuild** - `src/implementations/database.ts:1074-1077` (Confidence: 65%) -- The UPDATE on `tasks` and the CREATE/INSERT/DROP/RENAME on `loops` run within a single migration transaction. If the loops rebuild fails partway through, the tasks UPDATE is rolled back too (SQLite transaction semantics). This is correct. However, it would be clearer to document in the migration description that both tables are modified in v28 -- the current description mentions `tasks.agent column` which is good. No action needed; noting for transparency.

- **`buildTmuxArgs` is non-abstract with an empty default** - `src/implementations/base-agent-adapter.ts:112-113` (Confidence: 62%) -- The JSDoc explains the design choice (ProcessSpawnerAdapter does not extend BaseAgentAdapter). This is architecturally sound given the constraint. However, if a new adapter extends `BaseAgentAdapter` and forgets to override `buildTmuxArgs`, it will silently produce an empty args array rather than failing at compile time. The `buildTmuxCommand` guard (checking `this.provider !== 'claude' && this.provider !== 'codex'`) catches this at runtime. Acceptable for now; compile-time safety would be preferable if the adapter count grows.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Architecture Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Rationale

The PR makes two well-scoped architectural changes:

1. **Gemini adapter removal**: Clean break forward with proper migration (avoids PF-002 -- no backward-compatibility scaffolding for a never-published feature transition). The `AgentProvider` type is correctly narrowed to `'claude' | 'codex'`, the migration maps existing data, and docs/skills are updated consistently.

2. **`buildTmuxCommand` on AgentAdapter**: Adds tmux config assembly as a pure function on the adapter interface. The three-tier arg system (buildArgs for headless, buildInteractiveArgs for TTY, buildTmuxArgs for tmux) follows the established pattern. The `taskId` guard and explicit narrowing (replacing `as TmuxAgentType` cast) are good defensive improvements.

The single MEDIUM finding is the core-to-implementations type import. While it has zero runtime impact and is explicitly documented as temporary, fixing it now (5 lines) is cheaper than carrying technical debt into Phase 3. The PR should not be blocked for this, but the type should be extracted before the tmux migration is complete.
