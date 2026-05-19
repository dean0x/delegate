# Regression Review Report

**Branch**: feat-135-custom-orchestrators -> main
**Date**: 2026-04-22T01:58
**PR**: #148

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

### MEDIUM

(none)

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Snippet drift risk between buildOrchestratorPrompt and snippet builders** - `src/services/orchestrator-prompt.ts` (Confidence: 65%) -- The new snippet builders (`buildDelegationInstructions`, `buildStateManagementInstructions`, `buildConstraintInstructions`) produce text that is *semantically equivalent* but not *structurally identical* to what `buildOrchestratorPrompt` inlines. For example, the snippet builder's delegation block starts with `WORKER MANAGEMENT (via beat CLI):` while the main prompt's section is titled identically but embedded inside a larger template with different surrounding context (ROLE, WORKING DIRECTORY, DECISION PROTOCOL sections). The DECISION comment at line 11-15 claims "no risk of output drift", and the non-regression snapshot test at lines 141-207 of `orchestrator-prompt-snippets.test.ts` validates this. The risk is that future edits to one location may forget the other, but this is a maintenance concern rather than a current regression.

- **parseOrchestrateInitArgs returns null on error, swallowing the error message** - `src/cli/commands/orchestrate.ts:301-304` (Confidence: 70%) -- When `parseOrchestrateInitArgs` returns `err(message)`, the caller `parseOrchestrateArgs` converts it to `null`, which triggers the generic usage message. The specific error reason (e.g., "Unknown agent: gpt4") is lost. This follows the same pattern as `parseOrchestrateCreateArgs` (line 308-310), so it is consistent with existing behavior rather than a regression introduced by this PR.

- **`beat orchestrate init "init something"` would be ambiguous** - `src/cli/commands/orchestrate.ts:301` (Confidence: 60%) -- If a user's goal starts with the literal word "init" (e.g., `beat orchestrate init "init the database"`), the subcommand dispatch intercepts "init" as the subcommand and the remaining text becomes the goal. This is the correct and expected behavior (the goal is "init the database" not "init init the database"). This follows the same dispatch pattern as `status`, `list`, and `cancel`. Not a regression.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | - | 0 | 0 |

**Regression Score**: 9/10
**Recommendation**: APPROVED

## Analysis Notes

### Regression Checklist

- [x] **No exports removed** -- Zero `^-export` lines in diff. All existing exports preserved.
- [x] **No files deleted** -- Zero `^D` entries in `--name-status`. Purely additive change set.
- [x] **Return types backward compatible** -- No function signature changes to existing functions.
- [x] **Default values unchanged** -- `buildOrchestratorPrompt` still uses its own internal variables; no defaults changed.
- [x] **Side effects preserved** -- `orchestration-manager.ts` only has a comment change (line 298). No behavioral changes to event emissions, DB writes, or loop creation.
- [x] **All consumers of changed code updated** -- The new snippet builders are new exports with no pre-existing consumers.
- [x] **Migration complete across codebase** -- No migration needed. The new snippet builders are additive; `buildOrchestratorPrompt` was NOT refactored to call them (it retains its own inline templates).
- [x] **CLI options preserved** -- All existing subcommands (`create`, `status`, `list`, `cancel`) unchanged. `init` is additive.
- [x] **Commit message matches implementation** -- 9 commits, each accurately describes its content (feat, fix, test, docs).
- [x] **No new TODOs** -- Zero `^\+.*TODO` lines in diff.

### Key Observations

1. **buildOrchestratorPrompt is untouched** -- The existing prompt builder (lines 167-298 of `orchestrator-prompt.ts`) was NOT modified. It still constructs prompts using its own internal template variables (`agentFlag`, `modelFlag`, `agentModelFlags`, `stateFileSection`, etc.). The three new snippet builders are entirely separate, exported functions that produce equivalent text for external consumption. No risk of output drift for existing orchestrations.

2. **orchestration-manager.ts has a comment-only change** -- The only modification to `buildFinalPrompts` (the method that calls `buildOrchestratorPrompt`) is an updated JSDoc comment at line 298-300 pointing to `InitCustomOrchestrator`. No code logic changed.

3. **MCP adapter: additive routing** -- The new `InitCustomOrchestrator` case is added at line 638 in the switch statement, between `CancelOrchestrator` and `ConfigureAgent`. The new handler is synchronous (returns `MCPToolResponse` directly, not `Promise`). All existing cases are untouched.

4. **CLI: additive subcommand** -- The `init` subcommand is checked before the default `create` fallback (line 301-305), consistent with how `status`, `list`, and `cancel` are dispatched. The default path (`create`) falls through unchanged.

5. **Non-regression test included** -- `orchestrator-prompt-snippets.test.ts` lines 141-207 explicitly verify that `buildOrchestratorPrompt` output remains character-identical after the refactoring. This guards against future drift.

6. **New test files are properly wired into test:orchestration** -- `package.json` line 22 adds both `orchestrator-scaffold.test.ts` and `orchestrator-prompt-snippets.test.ts` to the orchestration test group.
