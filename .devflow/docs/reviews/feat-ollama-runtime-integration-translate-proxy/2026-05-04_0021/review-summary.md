# Code Review Summary

**Branch**: feat-ollama-runtime-integration-translate-proxy → main
**Date**: 2026-05-04T00:21
**Reviewers**: 8 specialized agents (architecture, complexity, consistency, performance, regression, security, testing, typescript)

## Merge Recommendation: CHANGES_REQUESTED

The PR introduces two well-scoped features (translate→proxy rename, ollama runtime support) with solid implementation quality and comprehensive test coverage. However, three blocking issues must be addressed before merge:

1. **Backward compatibility break** (HIGH regression) — `translate` config key is silently lost on upgrade
2. **Missing MCP test coverage** (HIGH testing) — No callTool tests for `ConfigureAgent` runtime/proxy functionality
3. **Missing utility function tests** (HIGH testing) — `isRuntimeSupportedForAgent` has zero dedicated unit tests

Additionally, 2 MEDIUM issues should be fixed while this code is in review: redundant config file reads in `agentsConfigSet`, and hardcoded `'ollama'` binary name in `checkAgents`.

---

## Issue Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW | Total |
|----------|----------|------|--------|-----|-------|
| **Blocking** | 0 | 3 | 3 | 0 | **6** |
| **Should Fix** | 0 | 0 | 4 | 0 | **4** |
| **Pre-existing** | 0 | 0 | 3 | 2 | **5** |

---

## Blocking Issues (Must Fix Before Merge)

### HIGH: Backward Compatibility — `translate` Config Lost on Upgrade
**Location**: `src/core/configuration.ts:298` (loadAgentConfig)
**Confidence**: 85% (Regression agent)
**Problem**: The PR renames the `translate` config field to `proxy` but does not provide a migration path. Users who previously configured `translate: "openai"` in `~/.autobeat/config.json` will have that field silently ignored after upgrade — their proxy stops working with no error or warning.
**Impact**: Production regression for existing users with proxy configurations.
**Fix**: Add backward compatibility shim in `loadAgentConfig`:
```typescript
// After reading record.proxy:
const proxyRaw = record.proxy ?? record.translate; // backward compat
proxy: (PROXY_TARGETS as readonly string[]).includes(proxyRaw as string)
  ? (proxyRaw as ProxyTarget)
  : undefined,
```
Alternatively, document as a breaking change in CHANGELOG with migration command: `beat agents config set claude proxy openai`.

---

### HIGH: Missing MCP `ConfigureAgent` Test Coverage for Runtime
**Location**: `src/adapters/mcp-adapter.ts:3522-3603` (runtime validation & write logic)
**Confidence**: 92% (Testing agent)
**Problem**: The MCP adapter's `ConfigureAgent` tool handler now validates runtime-agent compatibility and performs runtime save/clear operations, but there are zero callTool-level tests. The MCP boundary is the primary surface users interact with; this feature is untested at that layer.
**Impact**: Runtime configuration could fail in production without test visibility.
**Fix**: Add callTool tests for `ConfigureAgent`:
```typescript
it('rejects unsupported agent-runtime combination', async () => {
  const result = await adapter.callTool('ConfigureAgent', {
    agent: 'gemini', action: 'set', runtime: 'ollama',
  });
  expect(result.isError).toBe(true);
  const body = JSON.parse(result.content[0].text);
  expect(body.error).toContain("does not support agent 'gemini'");
});

it('saves runtime for supported agent', async () => {
  const result = await adapter.callTool('ConfigureAgent', {
    agent: 'claude', action: 'set', runtime: 'ollama',
  });
  expect(result.isError).toBeFalsy();
  const body = JSON.parse(result.content[0].text);
  expect(body.success).toBe(true);
});

it('warns when both runtime and proxy are set', async () => {
  saveAgentConfig('claude', 'proxy', 'openai');
  const result = await adapter.callTool('ConfigureAgent', {
    agent: 'claude', action: 'set', runtime: 'ollama',
  });
  const body = JSON.parse(result.content[0].text);
  expect(body.warnings).toContain(expect.stringContaining('mutually exclusive'));
});
```

---

### HIGH: Missing Unit Tests for `isRuntimeSupportedForAgent`
**Location**: `src/core/configuration.ts:268` (new exported function)
**Confidence**: 90% (Testing agent)
**Problem**: The new `isRuntimeSupportedForAgent` function is used across 3 layers (MCP adapter, CLI, base-agent-adapter) with zero dedicated unit tests. It is exercised indirectly through `resolveRuntime` integration tests, but there is no direct test of the function itself verifying the `RUNTIME_AGENT_SUPPORT` lookup for all agent providers.
**Impact**: Contract violations in the support matrix (e.g., accidentally enabling gemini+ollama) would not be caught by tests.
**Fix**: Add describe block in `tests/unit/implementations/agent-config.test.ts`:
```typescript
describe('isRuntimeSupportedForAgent', () => {
  it('returns true for claude with ollama', () => {
    expect(isRuntimeSupportedForAgent('ollama', 'claude')).toBe(true);
  });
  it('returns true for codex with ollama', () => {
    expect(isRuntimeSupportedForAgent('ollama', 'codex')).toBe(true);
  });
  it('returns false for gemini with ollama', () => {
    expect(isRuntimeSupportedForAgent('ollama', 'gemini')).toBe(false);
  });
});
```

---

## Should-Fix Issues (Recommended Fixes)

### MEDIUM: Redundant `loadAgentConfig` Calls in `agentsConfigSet`
**Location**: `src/cli/commands/agents.ts:189, 210, 218, 222`
**Confidence**: 85% (Complexity, Consistency, Performance agents)
**Problem**: After `saveAgentConfig` succeeds (line 175), the function calls `loadAgentConfig(agent)` up to 4 separate times in independent conditional blocks. Each call performs `existsSync + readFileSync + JSON.parse` on the same file. Beyond unnecessary I/O, this increases cognitive complexity — readers must verify each `config` binding refers to the same state. The function is now ~114 lines with 12+ conditional branches.
**Fix**: Load config once after save and reuse:
```typescript
// After saveAgentConfig + success message (line 185)
const postSaveConfig = loadAgentConfig(agent);

// Then replace all subsequent loadAgentConfig calls with postSaveConfig:
if ((key === 'baseUrl' || key === 'apiKey' || key === 'proxy') && value !== '') {
  const effectiveBaseUrl = key === 'baseUrl' ? value : postSaveConfig.baseUrl;
  if (effectiveBaseUrl) { /* probe connectivity */ }
}

if (key === 'proxy' && value !== '') {
  if (!postSaveConfig.baseUrl) ui.note('proxy requires baseUrl to be set', 'Warning');
  if (!postSaveConfig.apiKey) ui.note('proxy requires apiKey to be set', 'Warning');
  if (!postSaveConfig.model) ui.note('proxy requires model to be set', 'Warning');
  if (postSaveConfig.runtime) ui.note('runtime and proxy are mutually exclusive — runtime takes precedence', 'Warning');
}

if (key === 'runtime' && value !== '') {
  if (postSaveConfig.proxy) ui.note('runtime and proxy are mutually exclusive — runtime takes precedence', 'Warning');
}
```

---

### MEDIUM: Hardcoded `'ollama'` Binary Check in `checkAgents`
**Location**: `src/cli/commands/agents.ts:101-103`
**Confidence**: 85% (TypeScript agent)
**Problem**: When `agentConfig.runtime` is truthy, the code unconditionally checks `isCommandInPath('ollama')` regardless of the actual runtime value. The `Runtime` type is extensible via `RUNTIME_TARGETS`, but `checkAgents` hardcodes `'ollama'`. If a second runtime is added, this function would still report `ollama` availability.
**Fix**: Use the runtime value dynamically:
```typescript
if (agentConfig.runtime) {
  const runtimeBinary = agentConfig.runtime; // runtime name IS the binary name
  const found = isCommandInPath(runtimeBinary);
  const status = found ? ui.cyan('[found]') : '[not found]';
  ui.info(`  ${ui.dim(`runtime: ${agentConfig.runtime} — ${runtimeBinary} CLI ${status}`)}`);
}
```

---

### MEDIUM: Zod vs Raw JSON Schema Description Mismatch for `runtime`
**Location**: `src/adapters/mcp-adapter.ts:1768` (raw JSON fallback schema) vs line 397 (Zod schema)
**Confidence**: 95% (Consistency agent)
**Problem**: The Zod schema description for `runtime` includes "Mutually exclusive with proxy — runtime takes precedence" but the raw JSON fallback schema omits this note. The `proxy` descriptions match across both.
**Fix**: Add missing clause to raw JSON schema at line 1768:
```typescript
runtime: {
  type: 'string',
  description:
    'Runtime to wrap agent spawns (set action). Supported: "ollama". Wraps spawn with `ollama launch`. Supported agents: claude, codex. Mutually exclusive with proxy — runtime takes precedence. Empty string clears.',
},
```

---

### MEDIUM: Bootstrap Proxy/Runtime Mutual Exclusivity Spread Across Three Locations
**Location**: `src/bootstrap.ts:411-457` (3 distributed decision points)
**Confidence**: 80% (Architecture agent)
**Problem**: When both `proxy` and `runtime` are configured, the precedence is enforced at: (1) bootstrap proxy skip (line 415), (2) MCP warning (3648-3649), (3) spawn-time resolution. This distributed logic is correct but not immediately obvious. The intent "runtime takes precedence" is spread across three locations with no single point of truth.
**Fix**: Add a clarifying DECISION comment near the `agentRegistry` factory explaining the precedence and distributed enforcement:
```typescript
// DECISION: When runtime is configured, proxy is skipped at bootstrap (line 415)
// so agentRegistry always returns ClaudeAdapter. Runtime wrapping happens at spawn time.
// See resolveRuntime() in base-agent-adapter.ts for the exhaustive runtime dispatch.
const agentRegistry = proxyPort
  ? new ProxiedClaudeAdapter(...)
  : new ClaudeAdapter(...);
```

---

## Pre-existing Issues (Informational)

### MEDIUM: Double `loadAgentConfig` in Bootstrap Proxy Section
**Location**: `src/bootstrap.ts:412` + `src/translation/proxy/proxy-manager.ts:66-67`
**Confidence**: 85% (Architecture agent)
**Problem**: Bootstrap calls `loadAgentConfig('claude')` at line 412, then `loadProxyConfig('claude')` internally calls `loadAgentConfig('claude')` again. Two synchronous file reads of the same config within 3 lines.
**Recommendation**: Pass `claudeConfig` into `loadProxyConfig` to avoid double-read. Not blocking but good cleanup.

---

### MEDIUM: CLI Model Value Not Validated Against MCP Regex
**Location**: `src/cli/commands/agents.ts:175` vs `src/adapters/mcp-adapter.ts` (modelSchema)
**Confidence**: 82% (Security agent)
**Problem**: MCP validates model names with `/^[a-zA-Z0-9._-]+$/` but CLI `beat agents config set <agent> model <value>` does not. While `spawn()` uses array-based args (no injection risk), the inconsistency in boundary validation is worth noting.
**Recommendation**: Add regex validation to CLI path to match MCP boundary.

---

### MEDIUM: Non-null Assertion on `this.proxyUrl!` in ProxyManager
**Location**: `src/translation/proxy/proxy-manager.ts:118, 157`
**Confidence**: 80% (TypeScript agent)
**Problem**: Two uses of `this.proxyUrl!` bypass type narrowing. While current control flow is safe, this is a durability concern. This was introduced by a refactoring in this PR.
**Recommendation**: Use inline template instead: ``const url = `http://127.0.0.1:${this.port}`;``

---

### LOW: `isCommandInPath` Uses Synchronous `spawnSync` in Hot Paths
**Location**: `src/core/agents.ts:212` (pre-existing)
**Confidence**: 80% (Performance agent)
**Problem**: `spawn()` calls `isCommandInPath('ollama')` which does `spawnSync('which')`. Not new in this PR, but part of the spawn path.
**Recommendation**: Pre-existing, negligible impact for spawn path. Note for future optimization.

---

## Key Strengths

1. **Solid Architectural Patterns** — Runtime resolution follows the Template Method pattern established by proxy, auth, baseUrl, and model resolution. Exhaustive `never` guard prevents silent failures on new runtimes. (Architecture score: 8/10)

2. **Comprehensive Rename Coverage** — The `translate` → `proxy` rename is thorough across all layers: configuration, domain types, adapters, CLI, MCP, bootstrap, tests, MCP instructions. No stale references remain. (Consistency score: 8/10)

3. **Strong Type Safety** — Const tuple derivation (`PROXY_TARGETS`, `RUNTIME_TARGETS`), `as const satisfies` for Zod enums, exhaustive guards, no `any` types, proper Result<T> returns. (TypeScript score: 8/10)

4. **Security Posture** — No command injection risks (array-based spawn args), boundary validation via Zod enums and const arrays, proper auth/baseUrl suppression when runtime is active. (Security score: 9/10)

---

## Action Plan

1. **Fix backward compatibility** — Add `record.translate` fallback in `loadAgentConfig` or document as breaking change with migration command
2. **Add MCP test coverage** — 3 callTool tests for `ConfigureAgent` runtime set/clear/mutual-exclusivity
3. **Add utility tests** — 3 unit tests for `isRuntimeSupportedForAgent` covering claude, codex, gemini
4. **Consolidate config loads** — Refactor `agentsConfigSet` to load config once and reuse
5. **Fix hardcoded binary name** — Use `agentConfig.runtime` dynamically in `checkAgents`
6. **Sync schema descriptions** — Add mutual-exclusivity note to raw JSON fallback schema
