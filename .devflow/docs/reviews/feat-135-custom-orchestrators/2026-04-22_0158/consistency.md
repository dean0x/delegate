# Consistency Review Report

**Branch**: feat-135-custom-orchestrators -> main
**Date**: 2026-04-22T01:58:00Z

## Issues in Your Changes (BLOCKING)

### MEDIUM

**`type: 'text' as const` deviates from codebase norm** -- `src/adapters/mcp-adapter.ts:3237,3261,3287,3313,3326`
**Confidence**: 92%
- Problem: The new `handleInitCustomOrchestrator` handler uses `type: 'text' as const` in all 5 of its response literals. The rest of the file uses `type: 'text'` (90 occurrences on main, 0 uses of `as const` on main). The `default` case at line 646 also picked up `as const` in this PR, making 5 total new occurrences.
- Fix: Replace `type: 'text' as const` with `type: 'text'` in all 5 locations within `handleInitCustomOrchestrator` and the `default` case to match the established codebase pattern. TypeScript already narrows the literal type from the object literal context -- `as const` is unnecessary and inconsistent.

**`validatePath` called with `mustExist=true` unlike all existing handlers** -- `src/adapters/mcp-adapter.ts:3255`, `src/cli/commands/orchestrate.ts:580`
**Confidence**: 82%
- Problem: Both new call sites use `validatePath(path, undefined, true)` (requiring directory existence), while every existing handler in the codebase calls `validatePath(path)` with the default `mustExist=false`. The `CreateOrchestrator` handler at line 3026 validates the same `workingDirectory` field with `validatePath(data.workingDirectory)` (no `mustExist`). This means `InitCustomOrchestrator` rejects a non-existent working directory while `CreateOrchestrator` accepts it -- inconsistent behavior for the same conceptual field.
- Fix: Use `validatePath(data.workingDirectory)` (without the third argument) to match the existing pattern in `handleCreateOrchestrator` and all other handlers. If strict existence checking is intentionally desired for `init`, add a DECISION comment explaining why it differs.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Validation error format diverges from dominant pattern** -- `src/adapters/mcp-adapter.ts:3232-3248`
**Confidence**: 80%
- Problem: The new handler formats Zod validation errors as `JSON.stringify({ success: false, error: parseResult.error.errors.map(...).join('; ') })`. The 24 other handlers in the file use the pattern `Validation error: ${parseResult.error.message}` as a plain text string. The new handler follows `handleConfigureAgent` (the only other handler with this format), but `ConfigureAgent` is the exception, not the rule. Two handlers using the structured JSON format vs 24 using the plain string creates an inconsistent API surface for MCP consumers.
- Fix: Either adopt the dominant pattern (`Validation error: ${parseResult.error.message}`) for consistency with 24 other handlers, or document the DECISION that stateless handlers intentionally use the structured format. The existing DECISION comment references "Follows ConfigureAgent precedent" which partially addresses this, but the 24-to-2 ratio warrants explicit justification.

## Pre-existing Issues (Not Blocking)

None found.

## Suggestions (Lower Confidence)

- **Unused `workingDirectory` resolution in MCP handler** - `src/adapters/mcp-adapter.ts:3273` (Confidence: 70%) -- The resolved `workingDirectory` is validated and defaulted to `process.cwd()` but is only used in the `usage` hint string, never passed to `scaffoldCustomOrchestrator`. If the intent is to associate the working directory with the scaffolding output, it should be part of `ScaffoldParams`. If it is only cosmetic (for the usage hint), the validation and default logic is heavier than needed.

- **Snippet builders duplicate content with `buildOrchestratorPrompt` template** - `src/services/orchestrator-prompt.ts:71-150` (Confidence: 65%) -- The DECISION comment states "Identical to what buildOrchestratorPrompt inlines -- kept in sync as a single source of truth via this exported function." However, `buildOrchestratorPrompt` still uses its own inline template variables rather than calling these builders. The "single source of truth" claim is aspirational -- drift is possible if the main prompt builder is edited without updating the snippet builders (or vice versa). The non-regression test in `orchestrator-prompt-snippets.test.ts` mitigates this somewhat.

- **`parseOrchestrateInitArgs` silently swallows error on `init` subcommand** - `src/cli/commands/orchestrate.ts:301-304` (Confidence: 65%) -- When `parseOrchestrateInitArgs` returns an error, `parseOrchestrateArgs` returns `null`, which triggers the generic usage message. The specific error message from the parser (e.g., "Unknown agent") is lost. The `create` subcommand has the same pattern (line 309-311), so this is consistent, but it reduces usability.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Consistency Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The new code is well-structured and follows the project's core architectural patterns (Result types, DECISION comments, event-driven design separation, pure function extraction). The three blocking findings are moderate -- `type: 'text' as const`, `validatePath` argument inconsistency, and validation error format divergence -- but they are straightforward to fix and bring the new code in line with existing conventions.
