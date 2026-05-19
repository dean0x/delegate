# Complexity Review Report

**Branch**: feat-135-custom-orchestrators -> main
**Date**: 2026-04-22

## Issues in Your Changes (BLOCKING)

### HIGH

**handleInitCustomOrchestrator is 99 lines with repetitive error-response boilerplate (3 early-return blocks)** - `src/adapters/mcp-adapter.ts:3230`
**Confidence**: 85%
- Problem: The function spans lines 3230-3329 (99 lines). Three separate error branches each construct the same `{ content: [{ type: 'text', text: JSON.stringify(...) }], isError: true }` structure, inflating the function and making the pattern hard to scan. This is at the upper end of the WARNING threshold (50-200 lines) and the high end of cyclomatic complexity (estimated 6 branches: schema parse fail, path validation fail, scaffold fail, plus agent/model conditionals).
- Fix: Extract a private helper like the existing pattern in the adapter (many handlers share this shape). For example:
  ```typescript
  private errorResponse(error: string): MCPToolResponse {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error }, null, 2) }],
      isError: true,
    };
  }
  ```
  This would reduce the function to approximately 50-60 lines and make each error branch a one-liner. Note: this is a codebase-wide improvement opportunity (the pattern repeats across many handlers), so a standalone cleanup PR may be more appropriate than addressing it only here.

### MEDIUM

**parseOrchestrateInitArgs duplicates parseOrchestrateCreateArgs if-else chain (5 of 7 branches identical)** - `src/cli/commands/orchestrate.ts:226`
**Confidence**: 82%
- Problem: `parseOrchestrateInitArgs` (lines 226-274, 48 lines) shares 5 out of 7 flag-parsing branches with the existing `parseOrchestrateCreateArgs` (lines 142-216, 74 lines). Both parse `--working-directory`, `--agent`, `--model`, `--max-depth`, and `--max-workers` with identical logic. The only differences are that `init` lacks `--foreground`, `--max-iterations`, and `--system-prompt`. This near-duplication increases maintenance cost: a bug fix or new shared flag must be applied in two places.
- Fix: Extract a shared `parseCommonOrchestrateFlags` helper that returns the common fields, then each variant adds its specific fields. For example:
  ```typescript
  function parseCommonOrchestrateFlags(args: readonly string[]): Result<{
    workingDirectory?: string; agent?: AgentProvider; model?: string;
    maxDepth?: number; maxWorkers?: number; goalWords: string[];
    remaining: readonly string[];
  }, string> { /* shared logic */ }
  ```
  Both `parseOrchestrateCreateArgs` and `parseOrchestrateInitArgs` would call this then handle their unique flags from the remaining args.

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

### HIGH

**mcp-adapter.ts is 3514 lines** - `src/adapters/mcp-adapter.ts`
**Confidence**: 90%
- Problem: The file far exceeds the CRITICAL threshold of 500 lines. Adding `handleInitCustomOrchestrator` (+99 lines), the tool schema definition (+43 lines), and the JSON Schema listing (+30 lines) brings the total to 3514 lines. Each new MCP tool adds approximately 150-200 lines to this single file.
- Impact: Navigation, code review, and merge conflicts become increasingly expensive. This is a known pre-existing issue that grows with each feature.
- Note: Informational only. The new code follows the established pattern and does not worsen the file's internal complexity per function -- just its aggregate size.

### MEDIUM

**orchestrate.ts is 702 lines** - `src/cli/commands/orchestrate.ts`
**Confidence**: 85%
- Problem: The file exceeds the CRITICAL threshold of 500 lines. It now contains parsing and handling for 5 subcommands (create, status, list, cancel, init). The new `init` code adds approximately 130 lines (parser + handler + help text).
- Note: Informational only. Each function within the file is individually well-sized.

## Suggestions (Lower Confidence)

- **handleOrchestrateInit output block could use a template** - `src/cli/commands/orchestrate.ts:606` (Confidence: 65%) -- The 33-line `process.stdout.write([...].join('\n'))` call (lines 606-638) mixes presentation structure (labels, borders, heredoc syntax) with data. A template approach or dedicated formatter function would improve readability, but the current approach is straightforward and only used once.

- **Snippet builder text content near-duplicates buildOrchestratorPrompt inline text** - `src/services/orchestrator-prompt.ts:71-150` (Confidence: 60%) -- The three exported snippet builders produce text that closely mirrors (but is not character-identical to) the inline template strings in `buildOrchestratorPrompt`. The main builder uses its own `stateFileSection`, `delegationSection`, etc. variables. This is acknowledged in the DECISION comment (line 11-14) and the non-regression tests verify no drift. The two paths serve different consumers (full orchestrator vs. custom orchestrator snippets), so some divergence is expected. No action needed now, but worth monitoring if the texts drift further.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 1 | 1 | 0 |

**Complexity Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The new code is well-structured at the individual function level. The core scaffolding function (`scaffoldCustomOrchestrator`, 83 lines) is clean, uses `tryCatch` for error handling, and delegates to focused helpers. The three snippet builder functions are pure, small, and independently testable. The primary concerns are: (1) the MCP handler's repetitive error-response boilerplate inflates it to 99 lines -- extracting a shared error helper would bring it well under the 50-line threshold, and (2) the CLI arg parser duplicates 5 flag-parsing branches from the existing `create` parser -- extracting shared flag parsing would eliminate the duplication. Neither issue is critical, and both follow existing codebase patterns, but addressing them would improve maintainability.
