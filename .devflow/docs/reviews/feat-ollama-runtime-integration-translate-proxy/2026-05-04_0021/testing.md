# Testing Review Report

**Branch**: feat/ollama-runtime-integration-translate-proxy -> main
**Date**: 2026-05-04
**PR**: #157

## Issues in Your Changes (BLOCKING)

### HIGH

**Missing `isRuntimeSupportedForAgent` unit tests** - `src/core/configuration.ts:268`
**Confidence**: 90%
- Problem: The new exported function `isRuntimeSupportedForAgent` is used across 3 layers (MCP adapter, CLI, base-agent-adapter) but has zero dedicated unit tests. Tests in `agent-adapters.test.ts` exercise it indirectly through `resolveRuntime`, but there is no direct test for the function itself with all 3 agent providers (claude, codex, gemini) confirming the `RUNTIME_AGENT_SUPPORT` lookup behaves correctly. If the support map changes, no test will break to signal a contract violation.
- Fix: Add a describe block in `tests/unit/implementations/agent-config.test.ts`:
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

**No MCP `ConfigureAgent` tests for `runtime` field validation or `proxy` rename** - `src/adapters/mcp-adapter.ts:3522-3543`
**Confidence**: 92%
- Problem: The MCP adapter added two new code paths in the `ConfigureAgent` tool handler: (1) runtime-agent compatibility validation that returns an error when an unsupported agent is paired with a runtime (lines 3522-3543), and (2) runtime write/clear logic (lines 3596-3603). The existing `ConfigureAgent` callTool tests in `mcp-adapter.test.ts` cover none of this new behavior. The `proxy` rename of the `translate` field in the Zod schema and handler logic also has no MCP-level test coverage (the old `translate` field was apparently also untested at the MCP layer). This means the MCP boundary validation -- the primary surface users interact with -- is untested for the entire runtime feature.
- Fix: Add callTool-level tests for `ConfigureAgent` with runtime:
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

### MEDIUM

**`resolveRuntime` tests use `as unknown` cast to access protected method** - `tests/unit/implementations/agent-adapters.test.ts:1181`
**Confidence**: 85%
- Problem: All 7 `resolveRuntime` unit tests cast the adapter to `unknown` and then to a custom type to access the protected method directly: `(adapter as unknown as { resolveRuntime(c: AgentConfig, m?: string): unknown }).resolveRuntime(...)`. This couples tests to the internal method signature rather than testing observable behavior through the public `spawn()` API. While there are 10 `spawn with ollama runtime` tests that exercise the public API, the `resolveRuntime` unit tests are fragile -- a rename or signature change to the protected method will break them without changing any behavior. This is a testing anti-pattern flagged by the testing skill: "Tests verify behavior, not implementation details."
- Fix: Consider removing the `resolveRuntime` describe block and instead ensuring the `spawn with ollama runtime` tests cover all the same edge cases (model priority, unsupported agent error, no-model case). Alternatively, if direct unit testing of the resolution logic is desired, expose a minimal public method or test through spawn.

**No test for codex spawn with ollama runtime** - `tests/unit/implementations/agent-adapters.test.ts:1257`
**Confidence**: 82%
- Problem: The `spawn with ollama runtime` describe block creates only a `ClaudeAdapter` (line 1269). Since `resolveRuntime` is in the base class and delegates to `buildArgs` per adapter, the ollama wrapping behavior with CodexAdapter (which has different `buildArgs`, `envPrefixesToStrip`, and auth resolution) is not tested through the public `spawn()` API. The `resolveRuntime` unit tests confirm codex returns `ok` (line 1203-1210), but the full spawn integration (command wrapping, env suppression, inner args) is only verified for Claude.
- Fix: Add at least one integration-level spawn test with `CodexAdapter` + ollama runtime to verify the spawn wrapping works correctly with Codex-specific args and env stripping:
  ```typescript
  it('wraps codex spawn with ollama launch', () => {
    saveAgentConfig('codex', 'runtime', 'ollama');
    const codexAdapter = new CodexAdapter(testConfig);
    const result = codexAdapter.spawn({ prompt: 'test', workingDirectory: '/workspace', taskId: 'task-1' });
    expect(result.ok).toBe(true);
    expect(mockSpawn.mock.calls[0][0]).toBe('ollama');
    expect(mockSpawn.mock.calls[0][1][1]).toBe('codex');
    codexAdapter.dispose();
  });
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`proxyUrl` non-null assertion in `ProxyManager.start()`** - `src/translation/proxy/proxy-manager.ts:118,157`
**Confidence**: 80%
- Problem: The refactored `start()` method uses `this.proxyUrl!` (non-null assertion) in two places. While the code flow guarantees `this.port` is set at those points, this is a test smell indicator: the assertion makes it harder to test invariant violations. If future code rearrangement moves the assignment, the assertion will silently pass `undefined` as `string`. However, this is existing code refactored (not new logic), so it is informational.
- Fix: No test change needed, but consider using the explicit format `\`http://127.0.0.1:${this.port}\`` instead of the non-null assertion to avoid the implicit contract dependency.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**ConfigureAgent MCP tool lacks integration-level test coverage for `set` action with `proxy`** - `tests/unit/adapters/mcp-adapter.test.ts`
**Confidence**: 80%
- Problem: The `proxy` field (renamed from `translate`) has no callTool-level test in the MCP adapter test suite. The proxy configuration save/load is tested at the unit level in `agent-config.test.ts`, and `loadProxyConfig` is tested in `bootstrap-proxy-integration.test.ts`, but the MCP boundary where users interact -- `ConfigureAgent` with `action: "set", proxy: "openai"` -- has no test. This predates this PR (the old `translate` field also lacked MCP tests).
- Fix: Add `ConfigureAgent` callTool tests for proxy set/clear in a future PR.

## Suggestions (Lower Confidence)

- **No test for mutual exclusivity warning in ConfigureAgent `check` action** - `src/adapters/mcp-adapter.ts:3648` (Confidence: 70%) -- When both runtime and proxy are configured, the `set` action emits a warning, but the `check` action does not surface this conflict. Consider whether `check` should also warn, and if so, add a test.

- **Property-based testing for `isRuntimeSupportedForAgent`** - `src/core/configuration.ts:268` (Confidence: 62%) -- As more runtimes and agents are added, a property test asserting the support matrix size matches `RUNTIME_TARGETS.length * AGENT_PROVIDERS.length` checked values would catch misconfigurations. Low priority given the current single-runtime scope.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Testing Score**: 6/10

The new runtime feature has solid unit-level test coverage for the core `resolveRuntime` logic and spawn wrapping (17 new tests across `agent-adapters.test.ts`), plus good config persistence tests (`agent-config.test.ts`: 6 new tests) and bootstrap integration (`bootstrap-proxy-integration.test.ts`: 1 new test). However, the MCP boundary -- the primary user-facing surface -- lacks any test coverage for the new `runtime` field and the `proxy` rename. The `isRuntimeSupportedForAgent` utility function also lacks direct unit tests. The testing approach for `resolveRuntime` uses implementation-coupled casts to access a protected method, which is a durability concern.

**Recommendation**: CHANGES_REQUESTED
