# Complexity Review Report

**Branch**: feat/134-system-prompt-support -> main
**Date**: 2026-04-20

## Issues in Your Changes (BLOCKING)

No blocking complexity issues found.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`createOrchestration` remains a long method (~230 lines) despite `buildFinalPrompts` extraction** - `src/services/orchestration-manager.ts:60-290`
**Confidence**: 82%
- Problem: The `createOrchestration` method spans lines 60-290 (~230 lines). This PR extracted `buildFinalPrompts` as a private helper (lines 300-326), which is a positive complexity reduction, but the parent method still significantly exceeds the 50-line threshold for functions. The method handles input validation, state file setup, path-traversal-safe cleanup, domain object creation, DB persistence, compensation logic, loop creation, conditional status update with race protection, event emission, and logging -- at least 8 distinct responsibilities in one function.
- Fix: Consider further extraction into named private methods: `validateAndResolveInputs(request)`, `setupStateFiles(goal)`, and `createAndLinkLoop(orchestration, ...)`. Each would be under 30 lines and testable independently. This is not introduced by this PR (the method was already long), but the PR touched it and had the opportunity to reduce further.

## Pre-existing Issues (Not Blocking)

### HIGH

**`mcp-adapter.ts` is 3,337 lines with duplicated JSON schema definitions** - `src/adapters/mcp-adapter.ts`
**Confidence**: 90%
- Problem: The file contains both Zod schemas (lines ~46-490) and hand-written JSON Schema objects (lines ~660-1500) that describe the same tool parameters. Every tool addition requires updating both locations. At 3,337 lines this file is well above the 500-line critical threshold. The diff shows 81 lines changed across both schema representations, illustrating the maintenance burden of the duplication.
- Fix: Generate JSON schemas from Zod schemas using `zod-to-json-schema` or similar. Alternatively, split the file into `mcp-schemas.ts` (Zod), `mcp-json-schemas.ts` (generated), and `mcp-handlers.ts` (handler methods). This would halve the file size and eliminate the dual-maintenance problem.

### MEDIUM

**`schedule-manager.ts` has repetitive validation/emit patterns across 7 methods** - `src/services/schedule-manager.ts`
**Confidence**: 80%
- Problem: At 582 lines, `schedule-manager.ts` has methods `createSchedule`, `createScheduledPipeline`, `createScheduledLoop`, `cancelSchedule`, `pauseSchedule`, `resumeSchedule`, and `createPipeline` that each repeat the same pattern: validate inputs, emit event, handle emit failure, return result. The working directory validation block (lines 50-61 and 256-267) is copy-pasted verbatim. `createScheduledPipeline` and `createPipeline` share the step count validation (2-20) and per-step working directory validation.
- Fix: Extract `validateWorkingDirectory(dir)` and `emitOrFail(eventName, payload)` helpers. Consider a shared `validatePipelineSteps(steps)` for the duplicated step validation logic.

## Suggestions (Lower Confidence)

- **Dual `WORKER MANAGEMENT` and `DELEGATION` sections in orchestrator prompt** - `src/services/orchestrator-prompt.ts:66-70,86-91` (Confidence: 65%) -- The shared `delegationSection` fragment (lines 66-70) and the `WORKER MANAGEMENT` block (lines 86-91) both list the same beat CLI commands with slightly different labels. This near-duplication could drift. Consider using the shared fragment for both or documenting why they intentionally differ.

- **`buildOrchestratorPrompt` uses string interpolation for a 75-line template literal** - `src/services/orchestrator-prompt.ts:78-152` (Confidence: 62%) -- The system prompt is a single template literal with 6 interpolated sections. While the shared fragment extraction in this PR is a clear improvement over the prior inline duplication, the function still builds a complex multi-section string. A template file or structured builder might be more maintainable as the prompt grows.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | 0 |
| Should Fix | - | 0 | 1 | - |
| Pre-existing | - | 1 | 1 | 0 |

**Complexity Score**: 7/10
**Recommendation**: APPROVED

The PR actively reduces complexity in the areas it touches: extracting `buildFinalPrompts` from the long `createOrchestration` method, extracting shared prompt fragments to eliminate duplication in `orchestrator-prompt.ts`, removing arbitrary text length limits from Zod schemas (simplifying validation logic), capturing the adapter cleanup closure at spawn time (eliminating a runtime registry lookup and fallback in `cleanupWorkerState`), and extracting a reusable `setupAdapter` helper in the agent adapter tests. The changes introduce no new complexity concerns. Pre-existing complexity in `mcp-adapter.ts` (3,337 lines with dual schema definitions) and `schedule-manager.ts` (repetitive patterns) remain but are outside the scope of this PR.
