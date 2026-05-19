# Complexity Review Report

**Branch**: feat/ollama-runtime-integration-translate-proxy -> main
**Date**: 2026-05-04

## Issues in Your Changes (BLOCKING)

### MEDIUM

**`agentsConfigSet` repeated `loadAgentConfig` calls add redundant I/O and increase cognitive load** - `src/cli/commands/agents.ts:189,210,218,222`
**Confidence**: 85%
- Problem: After the `saveAgentConfig` call at line 175, the function calls `loadAgentConfig(agent)` four separate times across lines 189, 210, 218, and 222. Each call reads the config file from disk (`readFileSync` + `JSON.parse`). Beyond the unnecessary I/O, the repeated `const config = loadAgentConfig(agent)` pattern across adjacent blocks increases the function's cognitive complexity -- the reader must verify that each `config` binding refers to the same state. The function is now ~114 lines (lines 113-227) with 12+ distinct conditional branches, putting it in the "warning" zone for function length and cyclomatic complexity.
- Fix: Load config once after save and reuse the binding:
  ```typescript
  // After saveAgentConfig + success message (line 185)
  const postSaveConfig = loadAgentConfig(agent);

  // Probe connectivity
  if ((key === 'baseUrl' || key === 'apiKey' || key === 'proxy') && value !== '') {
    const effectiveBaseUrl = key === 'baseUrl' ? value : postSaveConfig.baseUrl;
    if (effectiveBaseUrl) { /* ... probe ... */ }
  }

  // Warn proxy missing fields
  if (key === 'proxy' && value !== '') {
    if (!postSaveConfig.baseUrl) ui.note('proxy requires baseUrl to be set', 'Warning');
    if (!postSaveConfig.apiKey) ui.note('proxy requires apiKey to be set', 'Warning');
    if (!postSaveConfig.model) ui.note('proxy requires model to be set', 'Warning');
  }

  // Warn mutual exclusivity
  if (key === 'runtime' && value !== '' && postSaveConfig.proxy)
    ui.note('runtime and proxy are mutually exclusive -- runtime takes precedence', 'Warning');
  if (key === 'proxy' && value !== '' && postSaveConfig.runtime)
    ui.note('runtime and proxy are mutually exclusive -- runtime takes precedence', 'Warning');
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`spawn()` function length now ~120 lines with growing responsibilities** - `src/implementations/base-agent-adapter.ts:220-349`
**Confidence**: 82%
- Problem: The `spawn()` method was already long before this PR (~90 lines). With the addition of runtime resolution, conditional auth/model/baseUrl suppression, and the runtime command wrapping (lines 234-237, 255-258, 262, 296-297, 331-333), it has grown to ~130 lines. The method handles: config loading, runtime resolution, binary verification, auth resolution, model resolution, system prompt injection, environment construction (env stripping, baseUrl injection, orchestrator ID validation), command wrapping, and process spawning. The cyclomatic complexity is approximately 12-14 with the new runtime conditionals. This is in the "warning" range per the complexity metrics (function length > 50, complexity > 10).
- Fix: The new `resolveRuntime()` extraction is a good step. A complementary improvement would be to extract the env construction block (lines 290-329) into a `resolveEnvironment()` method, and the system prompt block (lines 264-285) into `resolveSystemPrompt()`. This would bring `spawn()` closer to a coordinator that calls well-named sub-methods, each under 30 lines.

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **MCP `ConfigureAgent` set-action handler length** - `src/adapters/mcp-adapter.ts:3502-3665` (Confidence: 70%) -- The `case 'set'` block is ~163 lines with repetitive save-attempt patterns for each config key. As config keys grow (now 5: apiKey, baseUrl, model, proxy, runtime), this block scales linearly. A data-driven approach mapping key names to save/label logic would reduce duplication and lower cyclomatic complexity.

- **Repeated agent-runtime validation across 3 layers** - `src/core/configuration.ts:268`, `src/cli/commands/agents.ts:156`, `src/adapters/mcp-adapter.ts:3524`, `src/implementations/base-agent-adapter.ts:189` (Confidence: 65%) -- The `isRuntimeSupportedForAgent` check + identical error message pattern appears in 4 locations (configuration helper, CLI command, MCP handler, and base adapter). The adapter check is correctly a last-line defense, but the CLI and MCP layers have near-identical validation + error formatting that could share a single validation function returning a Result.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Complexity Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The new `resolveRuntime()` method is well-structured with early returns, an exhaustive guard, and clear return types -- good complexity management. The `agentsConfigSet` redundant config loads (BLOCKING, MEDIUM) should be consolidated before merge. The `spawn()` growth is a "should fix while here" concern that would benefit from further method extraction but does not block this PR.
