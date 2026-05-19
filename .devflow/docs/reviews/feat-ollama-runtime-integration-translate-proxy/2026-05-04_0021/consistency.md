# Consistency Review Report

**Branch**: feat-ollama-runtime-integration-translate-proxy -> main
**Date**: 2026-05-04
**PR**: #157

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Zod vs raw JSON schema description mismatch for `runtime`** - `src/adapters/mcp-adapter.ts:1768` vs `src/adapters/mcp-adapter.ts:397`
**Confidence**: 95%
- Problem: The Zod schema description for `runtime` (line 397) includes the clause "Mutually exclusive with proxy -- runtime takes precedence. Empty string clears." but the raw JSON fallback schema (line 1768) omits the mutual exclusivity note, only saying "Empty string clears." The `proxy` descriptions match across both schemas, making `runtime` the inconsistent one.
- Fix: Add the missing clause to the raw JSON fallback description at line 1768:
```typescript
runtime: {
  type: 'string',
  description:
    'Runtime to wrap agent spawns (set action). Supported: "ollama". Wraps spawn with `ollama launch`. Supported agents: claude, codex. Mutually exclusive with proxy — runtime takes precedence. Empty string clears.',
},
```

**Redundant `loadAgentConfig` calls in CLI `agentsConfigSet` for `proxy` path** - `src/cli/commands/agents.ts:189,210,222`
**Confidence**: 85%
- Problem: When `key === 'proxy' && value !== ''`, `loadAgentConfig(agent)` is called three separate times (line 189 for connectivity probe, line 210 for missing-field warnings, line 222 for mutual exclusivity check). Each call performs `readFileSync` + `JSON.parse`. The MCP adapter's `set` action loads config once (line 3629) and derives all effective values from that single load. This is a pattern inconsistency between the CLI and MCP code paths for the same feature.
- Fix: Load config once after save succeeds and reuse across all post-save warning blocks:
```typescript
// After line 206 (end of connectivity probe block):
const postSaveConfig = (key === 'proxy' || key === 'runtime') && value !== '' ? loadAgentConfig(agent) : null;

// Warn when proxy is set but required fields are missing
if (key === 'proxy' && value !== '' && postSaveConfig) {
  if (!postSaveConfig.baseUrl) ui.note('proxy requires baseUrl to be set', 'Warning');
  if (!postSaveConfig.apiKey) ui.note('proxy requires apiKey to be set', 'Warning');
  if (!postSaveConfig.model) ui.note('proxy requires model to be set', 'Warning');
  if (postSaveConfig.runtime) ui.note('runtime and proxy are mutually exclusive — runtime takes precedence', 'Warning');
}

if (key === 'runtime' && value !== '' && postSaveConfig) {
  if (postSaveConfig.proxy) ui.note('runtime and proxy are mutually exclusive — runtime takes precedence', 'Warning');
}
```

### LOW

**Hardcoded 'ollama' binary name in `checkAgents` display** - `src/cli/commands/agents.ts:101`
**Confidence**: 82%
- Problem: The `checkAgents` function hardcodes `isCommandInPath('ollama')` and displays "ollama CLI" regardless of the `agentConfig.runtime` value. While currently there is only one runtime target (`'ollama'`), the rest of the feature was designed to be extensible via `RUNTIME_TARGETS` and the exhaustive switch in `resolveRuntime`. The display code does not follow this extensible pattern -- if a second runtime were added, this block would still check for and display "ollama."
- Fix: Use `agentConfig.runtime` for the binary name (since runtimes are named after their CLI binary):
```typescript
if (agentConfig.runtime) {
  const runtimeBinary = agentConfig.runtime; // runtime name IS the binary name
  const found = isCommandInPath(runtimeBinary);
  const status = found ? ui.cyan('[found]') : '[not found]';
  ui.info(`  ${ui.dim(`runtime: ${agentConfig.runtime} — ${runtimeBinary} CLI ${status}`)}`);
}
```

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **MCP `ConfigureAgent` missing `runtime` in connectivity probe trigger** - `src/adapters/mcp-adapter.ts:3657` (Confidence: 65%) -- The connectivity probe fires when `baseUrl`, `apiKey`, or `proxy` is set, but not when `runtime` is set. This is likely intentional (runtime uses local Ollama, not a remote URL), but the asymmetry with the CLI path (which also skips probing for runtime) should be documented with a comment.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 1 |
| Should Fix | - | - | 0 | - |
| Pre-existing | - | - | 0 | 0 |

**Consistency Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The rename from `translate` to `proxy` is thorough and complete across all layers (configuration, MCP adapter, CLI, bootstrap, tests, instructions). No stale `TRANSLATE_TARGETS` or `TranslateTarget` references remain. The new `runtime` feature follows the established patterns well: const tuple for targets, derived union type, exhaustive switch guard, Zod enum with clear sentinel, CLI and MCP validation at boundaries, and tests covering all code paths.

The conditions are minor: sync the Zod and raw JSON schema descriptions for `runtime`, and consolidate the redundant `loadAgentConfig` calls in the CLI path to match the single-load pattern already used in the MCP adapter.
