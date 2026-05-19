# Architecture Review Report

**Branch**: feat-ollama-runtime-integration-translate-proxy -> main
**Date**: 2026-05-04T00:21
**PR**: #157

## Issues in Your Changes (BLOCKING)

### HIGH

**Runtime resolution lives in BaseAgentAdapter but only handles claude-scoped concerns** - `src/implementations/base-agent-adapter.ts:200-210`
**Confidence**: 82%
- Problem: `resolveRuntime()` hardcodes `'ollama'` in a switch-like `if` block with ollama-specific args (`launch`, `--model`, `--yes`, `--`). While the exhaustive guard at line 214 (`const _exhaustive: never`) protects against new runtimes slipping through without handling, the method conflates base-class runtime orchestration with ollama-specific argument assembly. If a second runtime is added (e.g. `vllm`), the base class method grows conditionally per runtime, violating OCP.
- Fix: This is acceptable at one runtime. If a second runtime is added, extract a `RuntimeResolver` strategy interface (or a `runtimeArgBuilder` map keyed by `Runtime`) so each runtime contributes its own arg-construction logic without branching in the base class. No action needed now -- flag for tracking.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Double loadAgentConfig call in bootstrap proxy section** - `src/bootstrap.ts:412-415`
**Confidence**: 85%
- Problem: `loadAgentConfig('claude')` is called at line 412 to check `runtime`, and then `loadProxyConfig('claude')` internally calls `loadAgentConfig('claude')` again at line 66-67 of `proxy-manager.ts`. This is two synchronous `readFileSync + JSON.parse` calls for the same config within 3 lines. The proxy section comment says "loaded once... to avoid redundant reads" but that pattern is only followed inside `spawn()`, not here.
- Fix: Pass `claudeConfig` into `loadProxyConfig` or refactor `loadProxyConfig` to accept an `AgentConfig`:
```typescript
// proxy-manager.ts
export function loadProxyConfig(provider: AgentProvider, agentConfig?: AgentConfig): ProxyConfig | null {
  if (provider !== 'claude') return null;
  const config = agentConfig ?? loadAgentConfig(provider);
  if (!config.proxy) return null;
  // ...
}
```
Then in bootstrap:
```typescript
const claudeConfig = loadAgentConfig('claude');
const proxyConfig = claudeConfig.runtime ? null : loadProxyConfig('claude', claudeConfig);
```

**Proxy/runtime mutual exclusivity enforced at warning level only -- no hard guard in bootstrap adapter selection** - `src/bootstrap.ts:411-457`
**Confidence**: 80%
- Problem: When both `proxy` and `runtime` are configured, bootstrap skips the proxy (line 415: `claudeConfig.runtime ? null : loadProxyConfig()`), and the MCP adapter emits a warning (line 3648-3649). However, the `agentRegistry` factory at line 452-453 still uses `proxyPort` to decide between `ProxiedClaudeAdapter` and `ClaudeAdapter`. Since runtime suppresses the proxy, `proxyPort` is undefined and `ClaudeAdapter` is used. The spawn-time `resolveRuntime` then wraps with ollama. This works correctly by coincidence of the ordering, but the intent ("runtime takes precedence") is spread across three locations (bootstrap proxy skip, MCP warning, spawn-time resolution) with no single point of truth.
- Fix: Add a clarifying DECISION comment near the `agentRegistry` factory explaining that when runtime is set, the proxy is skipped at bootstrap so `ClaudeAdapter` is always used, and runtime wrapping happens at spawn time. This documents the distributed precedence logic.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**loadAgentConfig reads from disk on every call with no caching** - `src/core/configuration.ts:283-305`
**Confidence**: 85%
- Problem: Each `loadAgentConfig()` call does `readFileSync + JSON.parse`. In `spawn()` it is called once and passed down (good pattern, documented). But in the CLI `agents.ts` commands, there are multiple calls per execution (e.g. `agentsConfigSet` calls `loadAgentConfig` up to 3 times at lines 189, 210, 218/222). For a CLI command this is negligible. However, as the config surface grows (now 5 keys per agent), this pattern invites duplication.
- No action needed -- informational only. The spawn-time single-load pattern is correct. CLI paths are cold-path and negligible.

## Suggestions (Lower Confidence)

- **Runtime-specific install hints are hardcoded in BaseAgentAdapter** - `src/implementations/base-agent-adapter.ts:248` (Confidence: 65%) -- The ollama download URL is hardcoded in the base class error message. If a second runtime is added, this becomes another branching point. Consider a `RUNTIME_INSTALL_HINTS` map similar to `AGENT_AUTH.loginHint`.

- **ProxiedClaudeAdapter not aware of runtime existence** - `src/translation/proxy/proxied-claude-adapter.ts` (Confidence: 60%) -- ProxiedClaudeAdapter overrides `resolveModel`, `resolveAuth`, and `resolveBaseUrl` but does not override `resolveRuntime`. If someone configures both proxy and runtime on a ProxiedClaudeAdapter, the base class `resolveRuntime` would wrap ollama around a proxy-configured adapter. This is moot because bootstrap prevents this combination (proxy skipped when runtime set), but a defensive guard or comment in ProxiedClaudeAdapter would make the invariant explicit.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 0 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Architecture Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The PR is architecturally sound. It follows the established patterns well:

1. **Template Method pattern preserved** -- Runtime resolution is added as a new base-class step (`resolveRuntime`) following the same pattern as `resolveAuth`, `resolveBaseUrl`, and `resolveModel`. Each returns a Result type.

2. **Single source of truth for types** -- `RUNTIME_TARGETS`, `Runtime`, `RUNTIME_AGENT_SUPPORT`, and `isRuntimeSupportedForAgent` are all in `configuration.ts` alongside their proxy counterparts, with types derived from const tuples (no manual sync).

3. **Exhaustive guard** -- The `never` guard at `base-agent-adapter.ts:214` ensures compile-time failure if a new runtime target is added without handling. This is the correct pattern.

4. **Layering respected** -- Domain types in `core/configuration.ts`, runtime resolution in `implementations/base-agent-adapter.ts`, bootstrap wiring in `bootstrap.ts`, boundary validation in both CLI and MCP adapter. Dependencies flow inward.

5. **Rename discipline** -- The `translate` -> `proxy` rename is comprehensive across all layers (config, domain, adapters, CLI, MCP, tests, instructions).

The one HIGH finding (OCP concern for the runtime switch) is a forward-looking concern that does not require action at one runtime. The MEDIUM findings are about documentation and minor redundancy. No blocking architectural issues.
