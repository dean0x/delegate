# Consistency Review Report

**Branch**: feat/180-phase-5-bootstrap-usage-parsing-cleanup -> main
**Date**: 2026-05-23

## Issues in Your Changes (BLOCKING)

### HIGH

**Double `as unknown as` cast bypasses type system at TmuxSpawnCoreConfig boundary** - `src/cli/commands/orchestrate-interactive.ts:219,224`
**Confidence**: 85%
- Problem: The code uses `as unknown as { env?: Record<string, string> }` to reach through the `TmuxSpawnCoreConfig` type boundary to access `env`, then casts the modified result back via `as unknown as TmuxSpawnCoreConfig`. This is the only occurrence of `as unknown as` in the entire `src/` directory. The codebase consistently avoids double casts -- this introduces a pattern that differs from how other call sites interact with TmuxSpawnCoreConfig.
- Impact: The double cast defeats TypeScript's type checker entirely at this boundary. If TmuxSpawnConfig's `env` field is renamed or restructured, this code will silently break at runtime with no compiler warning. The detailed JSDoc comment explaining why the cast is needed signals that the type boundary itself is the root issue.
- Fix: Expose `env` as an optional field on `TmuxSpawnCoreConfig` (it is already populated by `buildTmuxCommand` in `base-agent-adapter.ts:142`), or add a dedicated method like `buildTmuxCommandForInteractive()` that returns a config with `AUTOBEAT_WORKER` already stripped. Either approach eliminates the double cast:
  ```typescript
  // Option 1: Add env to TmuxSpawnCoreConfig (it's already populated at runtime)
  // In src/core/tmux-types.ts:
  export interface TmuxSpawnCoreConfig {
    // ... existing fields ...
    readonly env?: Record<string, string>;
  }
  
  // Then in orchestrate-interactive.ts (no casts needed):
  const existingEnv = rawTmuxConfig.env;
  const tmuxConfig: TmuxSpawnCoreConfig = existingEnv
    ? { ...rawTmuxConfig, env: Object.fromEntries(...) }
    : rawTmuxConfig;
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**JSDoc line length exceeds readable threshold in `finalizeInteractiveOrchestration`** - `src/core/interfaces.ts:904`
**Confidence**: 82%
- Problem: The updated JSDoc first line reads: `Finalize an interactive orchestration after the tmux session ends (or child process exits for pre-Phase 5), or on spawn failure.` This is a single 108-character line. Other JSDoc comments in the same interface wrap at roughly 80-90 characters, and multi-clause descriptions are split across lines (see `updateInteractiveOrchestrationPid` and `updateInteractiveOrchestrationSessionName` JSDoc comments above it for comparison).
- Fix: Break the line to match the style of adjacent comments:
  ```typescript
  /**
   * Finalize an interactive orchestration after the tmux session ends
   * (or child process exits for pre-Phase 5), or on spawn failure.
   ```

## Pre-existing Issues (Not Blocking)

No pre-existing consistency issues at CRITICAL severity were found in the reviewed files.

## Suggestions (Lower Confidence)

- **`reuseSession` return type `Result<Worker | null>` uses null-sentinel pattern mixed with Result error channel** - `src/implementations/event-driven-worker-pool.ts:315` (Confidence: 70%) -- The function returns `ok(null)` on failure (to signal "fall through") while other functions in the same class use `err(...)` for failures. The null-sentinel within a Result is documented and intentional (avoids propagating errors that should trigger fresh spawn), and tests verify it, but it introduces a pattern that differs from the rest of the class. The existing pattern is `err(...)` for failures (11 occurrences) vs `ok(null)` for "graceful fallback" (5 occurrences, all new in this PR). This is a deliberate design choice with clear documentation, so it stays in the suggestion bucket.

- **Phase comment terminology varies: "Phase 5 fix" vs "Phase 5"** - `src/implementations/event-driven-worker-pool.ts:55,668` (Confidence: 62%) -- Two DESIGN DECISION comments use "Phase 5 fix" while five others use "Phase 5" without qualifier. The distinction is meaningful (the "fix" suffix calls out a bug fix within Phase 5), but elsewhere in the codebase phase annotations do not append "fix". Minor; no functional impact.

- **`resolveContainerDeps` calls `process.exit(1)` inside a helper then returns `null` -- mixed control flow** - `src/cli/commands/orchestrate-interactive.ts:133` (Confidence: 65%) -- The function's JSDoc says "Returns null and calls process.exit(1) on any failure" but `process.exit` is a hard stop that never returns. The `null` return type is unreachable after `process.exit`. This is consistent with how other CLI commands work (they call `process.exit` then have unreachable code), so it is not a violation -- but the `| null` return type and the caller's `if (!deps) return` guard at line 305 create the illusion of recoverable flow. Documented as CLI pattern.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 0 | - |
| Should Fix | - | 0 | 1 | - |
| Pre-existing | - | - | 0 | 0 |

**Consistency Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The PR demonstrates strong consistency in several areas:
- Error handling patterns (Result types, structured logging) are maintained throughout
- DESIGN DECISION annotations follow the established project convention
- Test structure mirrors existing acceptance criteria naming (AC-N, EC-N)
- The refactoring of `orchestrate-interactive.ts` into extracted functions (`resolveContainerDeps`, `spawnAndDeliverPrompt`) improves readability while preserving the existing CLI error-handling idiom
- The `TaskIdRef` mutable-ref pattern is well-documented and internally consistent
- The `reuseSession` null-sentinel change from `err()` to `ok(null)` is a deliberate, documented deviation with clear rationale (avoids PF-001 -- the design choice is explicitly justified in comments rather than deferred)
- Mock factory update (`cleanupPersistentSession: vi.fn()`) keeps test helpers aligned with the `WorkerPool` interface

The blocking HIGH issue is the double `as unknown as` cast, which bypasses the type system at a boundary where the runtime value already carries the `env` field. This is fixable by widening `TmuxSpawnCoreConfig` to include the optional `env` field that `buildTmuxCommand` already populates.
