# Performance Review Report

**Branch**: feat/177-agent-adapter-migration -> main
**Date**: 2026-05-19

## Issues in Your Changes (BLOCKING)

_No blocking performance issues found._

## Issues in Code You Touched (Should Fix)

_No should-fix performance issues found._

## Pre-existing Issues (Not Blocking)

_No critical pre-existing performance issues in reviewed files._

## Suggestions (Lower Confidence)

- **loadAgentConfig reads from disk on every spawn** - `src/implementations/base-agent-adapter.ts:329` (Confidence: 65%) -- `resolveSpawnConfig` calls `loadAgentConfig()` which does `readFileSync` + `JSON.parse` on every invocation. This is inherited by the new `buildTmuxCommand()` method. Not a concern for typical workloads (one read per task spawn), but could matter if dozens of tasks are spawned in rapid succession (e.g., a large pipeline). A once-per-session cache with invalidation on config write would eliminate redundant disk reads. This is pre-existing behavior, not introduced by this PR.

- **Migration v28 table recreation on large loops tables** - `src/implementations/database.ts:1070` (Confidence: 60%) -- The CREATE-INSERT-DROP-RENAME pattern for migration v28 copies all rows from `loops` to `loops_new`. For databases with many loops, this is O(n) with full table scan. This is the standard SQLite pattern for CHECK constraint changes (ALTER TABLE cannot modify constraints), runs once at migration time within a transaction, and the loops table is typically small. Acceptable.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Performance Score**: 9/10
**Recommendation**: APPROVED

## Analysis Notes

### What was reviewed

52 files changed (+813, -907 lines). Key performance-relevant changes:

1. **`buildTmuxCommand()` on BaseAgentAdapter** (`src/implementations/base-agent-adapter.ts:114-142`) -- New method producing a `TmuxSpawnConfig` for Phase 3 tmux session setup. Pure config assembly with no I/O beyond the inherited `resolveSpawnConfig()` call. Array spread patterns (`[...buildTmuxArgs(), ...systemPromptArgs]`) are identical to the existing `spawn()` and `spawnInteractive()` methods. No hot-path concern.

2. **`buildTmuxArgs()` on Claude/Codex adapters** (`claude-adapter.ts:29-32`, `codex-adapter.ts:25-28`) -- Lightweight arg builders returning small frozen arrays. No allocation concern.

3. **TmuxConnector agentArgs forwarding** (`tmux-connector.ts:166`) -- Changed from hardcoded `[]` to `config.agentArgs`. This passes through to `generateWrapper()` which embeds args in a shell script. No performance change; the wrapper script is generated once per session.

4. **Migration v28 table recreation** (`database.ts:1070-1143`) -- Standard SQLite table recreation to narrow a CHECK constraint. Runs once per database upgrade within a transaction. Index recreation included. Acceptable O(n) cost for a one-time migration.

5. **Gemini adapter deletion** (-175 lines) -- Removes sync filesystem operations (`readFileSync`, `writeFileSync`, `statSync`, `existsSync`) from the `GeminiBasePromptCache` class. This is a net performance improvement: one fewer adapter in the `InMemoryAgentRegistry` array, fewer constructors at bootstrap, and removal of the sync I/O `GeminiBasePromptCache` constructor that called `mkdirSync` eagerly.

6. **Bootstrap simplification** (`bootstrap.ts:454`) -- Adapter array reduced from 3 to 2 entries. Marginal improvement in registry iteration and memory footprint.

### Feature knowledge alignment

The PR description mentions "Tmux layer uses fs.watch for push-based completion (no polling)." The existing tmux connector code confirms this: watchers detect sentinel files and message files via `fs.watch`, with staleness timers as a fallback. The new `buildTmuxCommand()` method does not interact with the watcher path -- it only produces config consumed by the existing connector. No polling introduced.

### Decisions context

PF-002 (clean break for zero-user features) is consistent with the Gemini removal approach -- no migration path for gemini config, clean type narrowing. Not cited as a finding since it supports the implementation rather than flagging an issue.
