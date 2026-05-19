# TypeScript Review Report

**Branch**: feat-135-custom-orchestrators -> main
**Date**: 2026-04-22

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

### MEDIUM

**Missing exhaustive `default: never` check in `OrchestrateParsed` switch** - `src/cli/commands/orchestrate.ts:678`
**Confidence**: 82%
- Problem: The `switch (parsed.kind)` at line 678 handles all five variants of the `OrchestrateParsed` union (`create`, `init`, `status`, `list`, `cancel`) but has no `default` case with a `never` assertion. This PR added the `init` variant to the union type -- if a future variant is added, the compiler will not flag the missing case.
- Fix: Add a `default` branch with a `never` assertion:
  ```typescript
  default: {
    const _exhaustive: never = parsed;
    throw new Error(`Unhandled subcommand kind: ${(_exhaustive as OrchestrateParsed).kind}`);
  }
  ```

Note: The switch existed before this PR and already lacked the check, but this PR modifies the union type and the switch body, making it "code you touched" territory. The project's CLAUDE.md explicitly references the exhaustive-switch-with-never pattern.

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`MCPToolResponse.content[].type` typed as `string` rather than a literal union** - `src/adapters/mcp-adapter.ts:521`
**Confidence**: 80%
- Problem: The `MCPToolResponse` interface defines `content: { type: string; text: string }[]`. Every usage in the file writes `type: 'text' as const`, suggesting `type` should be a literal `'text'` or a union of known MCP content types. This would eliminate the need for `as const` assertions scattered across all handlers.
- This is not in changed lines -- pre-existing across the entire MCP adapter.

### LOW

**Error message discarded in `parseOrchestrateArgs` for `init` branch** - `src/cli/commands/orchestrate.ts:303`
**Confidence**: 80%
- Problem: When `parseOrchestrateInitArgs` returns an `err`, the specific error message is discarded (`return null`) and the user sees a generic usage message instead of the actual parsing error (e.g., "Unknown agent: gpt4"). This follows the exact same pattern as the `create` branch at line 310 -- pre-existing design.

## Suggestions (Lower Confidence)

- **`ScaffoldParams.agent` typed as `string` instead of `AgentProvider`** - `src/core/orchestrator-scaffold.ts:29` (Confidence: 65%) -- The MCP adapter validates `agent` as `AgentProvider` via Zod, and the CLI validates it with `isAgentProvider()`, but `ScaffoldParams` accepts `string`. Using `AgentProvider` would make the interface narrower. However, the downstream `DelegationInstructionParams.agent` is also `string` (consistent), and the prompt layer only does string interpolation, so narrowing here would require cascading changes for no runtime benefit.

- **Duplicated `agentFlag`/`modelFlag` string construction** - `src/adapters/mcp-adapter.ts:3295-3296` and `src/cli/commands/orchestrate.ts:602-603` (Confidence: 62%) -- Both the MCP handler and the CLI handler independently build ` --agent ${agent}` / ` --model ${model}` strings. This is a minor duplication; the snippet builder (`buildDelegationInstructions`) already handles flag threading for the instruction text, but these usages are for the usage/output strings, not the instruction snippets.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 1 | 1 |

**TypeScript Score**: 9/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The TypeScript quality is strong:
- All interfaces use `readonly` modifiers consistently
- No `any` types anywhere in the new code -- `unknown` used properly at MCP boundaries
- Result types used throughout with proper error handling
- Zod validation at boundaries (MCP schema) with type-safe data extraction
- Clean discriminated union pattern for `OrchestrateParsed` with `kind` discriminant
- Pure functions with explicit return types (`Result<ScaffoldResult>`)
- `tryCatch` wrapper used correctly in the scaffold function
- `import type` not needed here since all imports are runtime values

The single blocking MEDIUM item is the missing exhaustive check in the switch statement, which is a low-effort defensive improvement given the union type was modified in this PR.
