# Complexity Review Report

**Branch**: feature/agent-config-passthrough -> main
**Date**: 2026-04-03

## Issues in Your Changes (BLOCKING)

### HIGH

**ConfigureAgent `set` action — linear save-then-check pattern with early returns creates implicit partial-write state** - `src/adapters/mcp-adapter.ts:2983-3065`
**Confidence**: 82%
- Problem: The `set` action in `handleConfigureAgent` saves `apiKey`, `baseUrl`, and `model` sequentially with early-return on each failure. If `apiKey` saves successfully but `baseUrl` fails, the method returns an error while the apiKey has already been persisted to disk. The caller sees `isError: true` and may assume nothing was changed, but one field was written. This is a partial-write scenario that the user cannot easily recover from since the error message does not indicate which fields were saved.
- Fix: Either batch all writes atomically (e.g., build the merged config object first, then write once) or include the list of already-saved fields in the error response so the caller knows the current state:
  ```typescript
  // Option A: Batch write
  const fieldsToSave: Array<{ key: 'apiKey'|'baseUrl'|'model'; value: string }> = [];
  if (apiKey) fieldsToSave.push({ key: 'apiKey', value: apiKey });
  if (baseUrl !== undefined) fieldsToSave.push({ key: 'baseUrl', value: baseUrl });
  if (model !== undefined) fieldsToSave.push({ key: 'model', value: model });
  // Save all at once via a single config write...

  // Option B: Include partial state in error
  // On failure: { success: false, error: ..., savedFields: messages }
  ```

### MEDIUM

**Duplicated Claude baseUrl warning logic across 3 locations** - `src/adapters/mcp-adapter.ts:2960-2971`, `src/adapters/mcp-adapter.ts:3035-3047`, `src/adapters/mcp-adapter.ts:260-264`
**Confidence**: 88%
- Problem: The Claude-specific warning (`"Warning: Claude requires an API key when using a custom baseUrl..."`) is copy-pasted with identical logic in three separate places: the `check` action, the `set` action, and the `ListAgents` tool handler. Each repeats the same `agent === 'claude' && baseUrl && !apiKey` condition with the same warning string. If the warning text or condition needs to change (e.g., when adding a new agent with similar constraints), all three must be updated in sync.
- Fix: Extract to a shared helper:
  ```typescript
  function getClaudeBaseUrlWarning(
    provider: AgentProvider,
    baseUrl: string | undefined,
    apiKey: string | undefined,
  ): string | undefined {
    if (provider === 'claude' && baseUrl && !apiKey) {
      return 'Warning: Claude requires an API key when using a custom baseUrl. The base URL will be ignored with login-based auth.';
    }
    return undefined;
  }
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`handleConfigureAgent` method cyclomatic complexity growing** - `src/adapters/mcp-adapter.ts:2932-3086`
**Confidence**: 85%
- Problem: The `handleConfigureAgent` method is now 154 lines with 3 switch branches, each containing nested conditionals for error handling and Claude-specific warning logic. The `set` case alone has 5 levels of nesting (switch > case > if(apiKey) > if(!result.ok) > return). While currently manageable, this method is on the cusp of exceeding reasonable cognitive complexity for a single handler. The method handles: input validation, 3 save operations with error handling, warning computation, and response construction.
- Fix: Extract the `set` case into a private method `handleConfigureAgentSet(agent, apiKey, baseUrl, model)` and the `check` case into `handleConfigureAgentCheck(agent)`. Each case body is self-contained enough to be a standalone method.

**`mcp-adapter.ts` total file length at 3086 lines** - `src/adapters/mcp-adapter.ts`
**Confidence**: 80%
- Problem: This file continues to grow with each feature (now 3086 lines). The `model` field addition touched 15+ locations in this single file (Zod schemas, tool listings, handler methods). While each individual addition is small, the aggregate file complexity makes it harder to navigate and reason about. The file mixes schema definitions, tool registration, and handler logic.
- Fix: Consider extracting Zod schemas and tool listing definitions into separate files (e.g., `mcp-schemas.ts`, `mcp-tool-definitions.ts`), keeping `mcp-adapter.ts` focused on the dispatch and handler logic. This is not urgent but should be tracked as tech debt.

## Pre-existing Issues (Not Blocking)

No critical pre-existing complexity issues identified in the reviewed files.

## Suggestions (Lower Confidence)

- **Model resolution has 3-layer priority chain with no validation feedback** - `src/implementations/base-agent-adapter.ts:258-262` (Confidence: 65%) — `resolveModel` returns `undefined` when no model is configured at any level, and the caller passes this to `buildArgs` which silently omits the flag. If a user misconfigures a model name (typo), there is no validation or feedback until the CLI process fails. Consider logging the resolved model at debug level in `spawn()`.

- **`saveAgentConfig` loads config twice when called in sequence** - `src/core/configuration.ts` (Confidence: 70%) — Each call to `saveAgentConfig` calls `loadConfigFile()` to read the current config, then writes. When the `set` action calls it 3 times in sequence (apiKey, baseUrl, model), the file is read 3 times and written 3 times. This is functionally correct but wasteful for a hot path in an interactive CLI. Could batch into a single read-modify-write cycle.

- **`AGENT_BASE_URL_ENV` map for Gemini uses `GEMINI_BASE_URL`** - `src/core/agents.ts:84-89` (Confidence: 62%) — The Gemini CLI may not actually support `GEMINI_BASE_URL` as an env var (this is not a standard Google-documented variable like `ANTHROPIC_BASE_URL` is for Anthropic). If the env var name is incorrect, the `resolveBaseUrl()` logic would silently fail to inject the URL. Worth verifying against Gemini CLI documentation.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Complexity Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The changes are well-structured and follow the existing codebase patterns consistently. The `model` field passthrough is implemented uniformly across all surfaces (MCP, CLI, domain, DB, adapters). The main complexity concerns are: (1) partial-write risk in the ConfigureAgent `set` action that could confuse users on failure, and (2) warning logic duplication that will become a maintenance burden if the pattern needs to change. Neither is blocking for merge, but both should be addressed before the next release.
