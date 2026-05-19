# Performance Review Report

**Branch**: feature/agent-config-passthrough -> main
**Date**: 2026-04-03

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

**Repeated `loadAgentConfig()` calls during spawn — config file read on every call (3 occurrences)** — Confidence: 85%
- `src/implementations/base-agent-adapter.ts:76`, `src/implementations/base-agent-adapter.ts:101`, `src/implementations/base-agent-adapter.ts:109`
- Problem: `BaseAgentAdapter.spawn()` now calls `loadAgentConfig()` three separate times per spawn: once in `resolveAuth()` (line 76), once in `resolveBaseUrl()` (line 101), and once in `resolveModel()` (line 109). Each call reads `~/.autobeat/config.json` from disk via `readFileSync`, parses JSON, and navigates the nested agent section. For a single spawn this is fast, but under concurrent task delegation (multiple workers spawning in parallel), this triples the config file reads compared to the pre-PR state (which only called `loadAgentConfig` once in `resolveAuth`).
- Fix: Load the agent config once at the start of `spawn()` and pass it to `resolveAuth()`, `resolveBaseUrl()`, and `resolveModel()`:
  ```typescript
  spawn(prompt: string, workingDirectory: string, taskId?: string, model?: string): Result<{ process: ChildProcess; pid: number }> {
    try {
      if (!isCommandInPath(this.command)) { ... }

      // Load config once for all resolution steps
      const agentConfig = loadAgentConfig(this.provider);

      const authResult = this.resolveAuth(agentConfig);
      if (!authResult.ok) return authResult;

      const resolvedModel = this.resolveModel(model, agentConfig);
      const finalPrompt = this.transformPrompt(prompt);
      const args = this.buildArgs(finalPrompt, resolvedModel);

      // ...cleanEnv...
      const baseUrlEnv = this.resolveBaseUrl(agentConfig);
      // ...rest of spawn...
    }
  }
  ```
  Update `resolveAuth`, `resolveBaseUrl`, and `resolveModel` to accept an `AgentConfig` parameter instead of calling `loadAgentConfig` internally.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`loadAgentConfig()` re-read on every `ListAgents` check action** — Confidence: 82%
- `src/adapters/mcp-adapter.ts` (ListAgents handler and ConfigureAgent "check" action)
- Problem: The `ListAgents` tool iterates all agent providers and calls `loadAgentConfig()` for each one, followed by `checkAgentAuth()` which may also inspect config. The `ConfigureAgent` "check" action likewise calls `loadAgentConfig()` then immediately calls `checkAgentAuth()`. For a "set" action, `loadAgentConfig()` is called once per field set, plus one extra for the Claude warning check (line 399). While these are not hot paths (user-initiated actions), the pattern of repeated disk reads for the same data within a single request handler is wasteful. No immediate perf concern, but it creates a pattern that could become costly if copied to hotter code paths.
- Fix: Cache the agent config at the beginning of each handler invocation and reuse it throughout.

## Pre-existing Issues (Not Blocking)

### LOW

**`loadConfigFile()` does synchronous disk I/O with `readFileSync` on every call** — Confidence: 80%
- `src/core/configuration.ts:204-213`
- Problem: `loadConfigFile()` reads and parses `config.json` on every call with no caching. This is called from multiple code paths: spawn, auth resolution, config display. In a heavy workload with many concurrent spawns, this becomes a source of I/O contention. The file is small so each read is fast, but the syscall overhead is unnecessary for data that changes rarely.
- Fix: Consider an in-process cache with a TTL (e.g., 5 seconds) or change-notification invalidation. This is a broader architectural improvement beyond the scope of this PR.

## Suggestions (Lower Confidence)

- **Env filtering in `spawn()` iterates all env vars per spawn** - `src/implementations/base-agent-adapter.ts:141-143` (Confidence: 65%) — The `cleanEnv` construction filters all of `process.env` on every spawn. For typical env sizes this is fine, but if the process inherits a large env (100+ vars), the combined filter+spread could be optimized by caching the clean env once. Not a real issue at current scale.

- **`ConfigureAgent` "set" action performs sequential config writes** - `src/adapters/mcp-adapter.ts` (Confidence: 62%) — When setting multiple fields (apiKey + baseUrl + model), each field triggers a separate `saveAgentConfig()` call that reads the file, modifies it, and writes it back. A batch write API would be more efficient but the operation is user-initiated and infrequent.

- **Migration v16 has no index on the new `model` column** - `src/implementations/database.ts` (Confidence: 60%) — The new `tasks.model` column has no index. If queries ever need to filter by model (e.g., "show all tasks using claude-opus-4-5"), a full table scan would be required. Currently no such query exists, so this is purely speculative.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 0 | - |
| Should Fix | - | 0 | 1 | - |
| Pre-existing | - | - | 0 | 1 |

**Performance Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The HIGH finding (triple `loadAgentConfig` calls per spawn) is a real but bounded concern. Each call does a synchronous `readFileSync` + `JSON.parse` for a small config file, so the absolute overhead is low (sub-millisecond per read). However, tripling the I/O calls per spawn in a system designed for concurrent worker management is a code smell worth fixing before it compounds. The fix is straightforward -- load once, pass through. The rest of the changes are clean: model passthrough is a lightweight string field with no computational overhead, the migration adds a nullable TEXT column (instant in SQLite), and the new Zod schemas add negligible parse-time cost. Overall performance impact of this PR is minimal.
