# Architecture Review Report

**Branch**: feat/135-custom-orchestrators -> main
**Date**: 2026-04-22

## Issues in Your Changes (BLOCKING)

### HIGH

**Snippet builders duplicate inline template in buildOrchestratorPrompt -- content will drift** - `src/services/orchestrator-prompt.ts:71-150` and `src/services/orchestrator-prompt.ts:210-241`
**Confidence**: 85%
- Problem: The three new exported snippet builders (`buildDelegationInstructions`, `buildStateManagementInstructions`, `buildConstraintInstructions`) produce text that is nearly identical to but subtly different from the inline template variables inside `buildOrchestratorPrompt`. The DECISION comment at line 12-14 acknowledges this: "buildOrchestratorPrompt continues to use its own internal template variables -- no risk of output drift." However, this claim is incorrect: the state management snippet includes resilience and completion/failure guidance that the inline `stateFileSection` variable at line 184-186 does NOT include (those lines appear separately in the system prompt at lines 270-276). The constraint snippet includes qualitative lines ("Prefer sequential..." and "Max 3 workers...") that the inline `constraintsSection` at line 196-198 does NOT include (those appear separately at lines 240-241). This means there are now two sources of truth for delegation, state management, and constraint text. When one is updated, the other will not be updated -- this is a classic drift bug waiting to happen.
- Fix: Refactor `buildOrchestratorPrompt` to call the snippet builders internally rather than maintaining parallel inline templates. This makes the snippet builders the single source of truth. The system prompt template would compose them:
  ```typescript
  const systemPrompt = `ROLE: ...
  
  ${buildStateManagementInstructions({ stateFilePath })}
  
  ${workingDirectorySection}
  
  ${buildDelegationInstructions({ agent, model })}
  
  ${buildConstraintInstructions({ maxWorkers, maxDepth })}
  
  DECISION PROTOCOL:
  ...`;
  ```
  Note: This requires reconciling the minor text differences between the inline fragments and the snippet builders (e.g., the inline `stateFileSection` is shorter than `buildStateManagementInstructions` output). The non-regression test at `tests/unit/services/orchestrator-prompt-snippets.test.ts:141-207` would catch any character-level changes, which is the correct safety net.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`workingDirectory` validated but unused in MCP handler** - `src/adapters/mcp-adapter.ts:3253-3280`
**Confidence**: 85%
- Problem: The `handleInitCustomOrchestrator` method validates `data.workingDirectory` (lines 3254-3271) and resolves it to a default (line 3273), then passes it into the `usage` string (line 3304). But `workingDirectory` is never passed to `scaffoldCustomOrchestrator` (line 3274-3280) and is not part of `ScaffoldParams`. The CLI handler at `orchestrate.ts:578-594` mirrors this: it validates `workingDirectory` and resolves it but only uses it for display output, never for the scaffold call. Meanwhile, the `CreateOrchestrator` flow in `orchestration-manager.ts` uses `validatedWorkingDirectory` directly in the loop creation (line 216) and prompt building (line 204). The custom orchestrator path does NOT embed `workingDirectory` into the state management snippet or any instruction snippet -- the caller must manually include it in their loop's `--working-directory` flag. This is not necessarily a bug (the usage string mentions it), but it is an architectural asymmetry compared to `CreateOrchestrator` where working directory is wired in automatically.
- Fix: Either (a) add `workingDirectory` to `ScaffoldParams` and embed it in the state management snippet (parallel to how `buildOrchestratorPrompt` uses it), or (b) add a DECISION comment explaining why working directory is intentionally omitted from the scaffold and left to the caller. Option (b) is acceptable if the design intent is to keep the scaffold minimal.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Duplicate state-file setup logic between orchestration-manager.ts and orchestrator-scaffold.ts** - `src/services/orchestration-manager.ts:100-124` and `src/core/orchestrator-scaffold.ts:59-69`
**Confidence**: 82%
- Problem: Both `OrchestrationManagerService.createOrchestration` and `scaffoldCustomOrchestrator` perform the same sequence: `getStateDir()` -> generate filename -> `createInitialState(goal)` -> `writeStateFile(...)` -> `writeExitConditionScript(...)`. The orchestration manager additionally calls `mkdirSync` with mode 0o700 and wraps everything in try/catch for error handling (plus a cleanup helper). The scaffold function relies on `tryCatch` and on `writeStateFile` internally calling `mkdirSync`. This duplication is manageable now but will diverge over time (e.g., if state file permissions need hardening, or if the naming scheme changes).
- Fix: Consider having `OrchestrationManagerService.createOrchestration` call `scaffoldCustomOrchestrator` for the state file setup phase, then proceed with its orchestration-specific logic (DB persistence, loop creation, compensation). This would consolidate the file I/O into one function.

## Suggestions (Lower Confidence)

- **Snippet builders not called by buildOrchestratorPrompt risks "claimed single source of truth" being false** - `src/services/orchestrator-prompt.ts:68-69` (Confidence: 75%) -- The DECISION comment says "kept in sync as a single source of truth via this exported function" but the main prompt builder does not actually call these functions. The claim of single source of truth is aspirational, not structural.

- **No path quoting in suggestedExitCondition** - `src/core/orchestrator-scaffold.ts:70` (Confidence: 65%) -- `suggestedExitCondition` is `node ${exitConditionScript}` without quoting. If the path contains spaces (unlikely for ~/.autobeat but possible on some systems), the shell command would break. The existing `OrchestrationManagerService` uses `JSON.stringify(exitConditionScript)` at line 212 for the same purpose.

- **`parseOrchestrateInitArgs` swallows parse error in `parseOrchestrateArgs`** - `src/cli/commands/orchestrate.ts:301-305` (Confidence: 70%) -- When `parseOrchestrateInitArgs` returns `err(...)`, `parseOrchestrateArgs` returns `null`, which triggers the generic usage message. The specific error from the Result (e.g., "Unknown agent: gpt4") is lost. Other subcommands (`status`, `list`, `cancel`) also return `null` on failure, so this follows existing pattern, but the init parser has richer error messages that would be useful to surface.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 0 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Architecture Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The feature is well-structured overall. The new `orchestrator-scaffold.ts` module follows the correct layer placement (core layer for pure logic, no service dependencies). The extracted snippet builders are clean pure functions. The MCP tool and CLI command both follow established adapter patterns. The primary concern is the dual-source-of-truth between the snippet builders and the inline templates in `buildOrchestratorPrompt` -- this should be resolved before merge to prevent inevitable drift. The working directory asymmetry deserves at least a DECISION comment.
