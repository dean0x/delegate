# Performance Review Report

**Branch**: feat-interactive-orchestrator-mode -> main
**Date**: 2026-05-06

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Sync I/O (readFileSync + spawnSync) on every interactive spawn** - `src/implementations/base-agent-adapter.ts:268`, `src/core/agents.ts:212`
**Confidence**: 82%
- Problem: `resolveSpawnConfig()` calls `loadAgentConfig()` which performs `readFileSync` + `JSON.parse` on the config file, and `isCommandInPath()` which executes `spawnSync('which', ...)`. Both are synchronous blocking operations. In the interactive spawn path, this blocks the event loop briefly during setup. The same pattern existed in `spawn()` before this PR (pre-existing), but was called from worker pool context. The new `spawnInteractive()` uses the same `resolveSpawnConfig()`, inheriting these sync calls.
- Impact: For interactive mode this is a one-time cost at session start (not per-request), so practical impact is negligible. The user is already waiting for the agent to launch. This is informational for the "should fix" category since the code was already structured this way.
- Fix: No action needed for this PR. The sync I/O was a deliberate pre-existing design choice (config loaded once per spawn). If ever called in a hot loop, consider caching `loadAgentConfig` result and `which` binary existence.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**process.env full-copy on every spawn** - `src/implementations/base-agent-adapter.ts:329-333`
**Confidence**: 80%
- Problem: `buildSpawnEnv()` calls `Object.entries(process.env).filter(...)` which copies the entire environment on every spawn. Typical environments have 50-200+ variables.
- Impact: This is O(env_vars * prefix_count) per spawn, which is trivially fast for the expected call frequency (one spawn per interactive session, or one spawn per worker task). Not a practical bottleneck.
- Fix: No action needed. Pre-existing pattern, single-use per spawn invocation.

**Regex compiled on every spawn** - `src/implementations/base-agent-adapter.ts:336`
**Confidence**: 80%
- Problem: `ORCHESTRATOR_ID_RE` is re-compiled inside `buildSpawnEnv()` on every call. While regex compilation is fast, it could be a module-level constant.
- Impact: Negligible -- regex is simple and called at most once per interactive session.
- Fix: Move `const ORCHESTRATOR_ID_RE = /^orchestrator-...$/` to module scope. Pre-existing issue, not introduced by this PR.

## Suggestions (Lower Confidence)

- **Read-then-update pattern in updateInteractiveOrchestrationPid** - `src/services/orchestration-manager.ts:419-424` (Confidence: 65%) -- The method reads the full orchestration row, creates a new object with only `pid` changed, then writes the full row back. A targeted `UPDATE orchestrations SET pid = ? WHERE id = ?` prepared statement would be more efficient, but this pattern is consistent with the rest of the codebase (immutable domain objects + full-row updates) and is called once per session.

- **No exit condition script written for interactive template** - `src/core/orchestrator-scaffold.ts:76-86` (Confidence: 70%) -- The interactive template skips `writeExitConditionScript()`, which avoids an unnecessary sync file write. This is actually a performance win compared to the standard template path. Noted as positive.

- **container.get calls without caching** - `src/cli/commands/orchestrate.ts:695,731-733` (Confidence: 60%) -- Multiple `container.get()` calls to resolve services. These are DI container lookups, typically O(1) map lookups. Not a concern.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | - |
| Should Fix | - | 0 | 1 | - |
| Pre-existing | - | - | 2 | 0 |

**Performance Score**: 9/10
**Recommendation**: APPROVED

The interactive orchestrator mode introduces minimal performance overhead. The main code path is a single `spawn()` call with `stdio: 'inherit'`, which blocks the CLI process on child exit -- this is the correct pattern for an interactive terminal session and introduces no polling, no busy-wait, and no unnecessary I/O.

Key positive performance observations:
1. **Shared `resolveSpawnConfig()`** avoids code duplication without adding overhead -- the resolution chain runs exactly once per spawn.
2. **No loop created for interactive mode** -- eliminates the entire loop iteration machinery, reducing DB writes and event emissions compared to standard orchestration.
3. **Interactive template skips exit condition script** -- avoids unnecessary file I/O during scaffolding.
4. **PID-based liveness check** (`orchestration-liveness.ts:41-45`) is O(1) via `process.kill(pid, 0)` -- much cheaper than the standard mode's multi-hop lookup (loop -> iteration -> task -> worker -> PID).
5. **Migration v25** adds two nullable columns with `DEFAULT NULL` -- zero-cost ALTER TABLE on SQLite (no table rewrite needed).

The sync I/O concerns (readFileSync, spawnSync) are pre-existing patterns inherited from the existing `spawn()` path and are called at most once per interactive session start. No performance regressions introduced.
