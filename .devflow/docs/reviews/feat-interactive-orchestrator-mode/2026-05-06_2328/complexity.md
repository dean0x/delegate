# Complexity Review Report

**Branch**: feat-interactive-orchestrator-mode -> main
**Date**: 2026-05-06

## Issues in Your Changes (BLOCKING)

### HIGH

**`handleOrchestrateInteractive` exceeds 130 lines with high cyclomatic complexity** - `src/cli/commands/orchestrate.ts:684-823`
**Confidence**: 90%
- Problem: This function is ~140 lines long with 6 `if (!result.ok)` early-exit branches, a SIGINT handler installation/restoration block, a 3-way status determination branch, conditional event emission (nested `if`), and conditional UI output (3-way `if/else`). Cyclomatic complexity is approximately 12. The function handles setup, service calls, DI container lookups, process spawning, signal coordination, process exit awaiting, status determination, DB update, event emission, UI output, cleanup, and process exit -- at least 7 distinct concerns in one function.
- Fix: Extract phases into named helper functions. For example:
  ```typescript
  // Phase 1: setup + spawn
  const spawnCtx = await setupInteractiveSpawn(parsed);
  // Phase 2: run + wait
  const exitCode = await awaitInteractiveChild(spawnCtx);
  // Phase 3: finalize (status, DB, events, UI)
  await finalizeInteractiveOrchestration(spawnCtx, exitCode);
  ```
  Each phase would be 20-40 lines with clear responsibility. The SIGINT handler block is especially suitable for extraction since it has well-defined install/restore boundaries.

### MEDIUM

**Duplicated input validation between `createOrchestration` and `createInteractiveOrchestration`** - `src/services/orchestration-manager.ts:330-368`
**Confidence**: 88%
- Problem: Lines 333-352 of `createInteractiveOrchestration` are a near-identical copy of lines 74-94 in `createOrchestration` (goal validation, working directory validation, agent resolution). Similarly, the state file setup (lines 354-368) duplicates lines 101-124. This is ~35 lines of duplicated validation and ~15 lines of duplicated state file setup. Violations compound: when validation rules change, both methods must be updated.
- Fix: Extract shared validation and state file setup into private helpers:
  ```typescript
  private validateAndResolveRequest(request: OrchestratorCreateRequest): Result<{
    validatedWorkingDirectory: string;
    agent: AgentProvider;
  }> { ... }
  
  private setupStateFile(goal: string): Result<string> { ... }
  ```
  Both `createOrchestration` and `createInteractiveOrchestration` would call these helpers, reducing each method by ~50 lines.

**`handleOrchestrateInit` output block duplication** - `src/cli/commands/orchestrate.ts:862-923`
**Confidence**: 82%
- Problem: The `if (isInteractive) { ... } else { ... }` block contains two large `process.stdout.write([ ... ].join('\n'))` calls totaling 60+ lines. Both branches share the same 12-line "instruction snippets" suffix (delegation, state management, constraints). The non-interactive branch adds the exit condition and loop command, while the interactive branch adds the interactive command -- the structural difference is only ~5 lines.
- Fix: Build the shared instruction snippet array once, then prepend the mode-specific header lines:
  ```typescript
  const commonSnippets = [
    '--- Delegation Instructions ---', s.instructions.delegation,
    '', '--- State Management Instructions ---', s.instructions.stateManagement,
    '', '--- Constraint Instructions ---', s.instructions.constraints, '',
  ];
  const header = isInteractive ? [...interactiveHeader] : [...standardHeader];
  process.stdout.write(['', ...header, '', ...commonSnippets].join('\n'));
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`orchestrate.ts` file length: 1000 lines** - `src/cli/commands/orchestrate.ts`
**Confidence**: 85%
- Problem: The file is exactly 1000 lines, well above the 500-line warning threshold. It contains 17 functions spanning arg parsing (pure), detach handling, foreground handling, status, list, cancel, interactive handling, init scaffolding, and the main dispatcher. Adding the interactive mode brought it from ~680 lines to 1000 lines. This makes navigation and cognitive load challenging.
- Fix: Consider splitting into `orchestrate-interactive.ts` (handleOrchestrateInteractive + parseOrchestrateInteractiveArgs) and keeping the rest in `orchestrate.ts`. The interactive mode is a self-contained code path with no shared state beyond the arg types and `withServices`.

**`orchestration-manager.ts` file length: 529 lines with two large create methods** - `src/services/orchestration-manager.ts`
**Confidence**: 80%
- Problem: `createOrchestration` is ~230 lines and `createInteractiveOrchestration` is ~90 lines. Together with `cancelOrchestration` (~70 lines), the service class is dense. The interactive method adds 96 lines of new code with significant overlap with the standard path. This is at the threshold rather than clearly over it, but the shared validation duplication exacerbates the cognitive load.
- Fix: Address the validation duplication noted in Blocking issues above. That alone would reduce the file by ~40 lines and make each method easier to follow independently.

## Pre-existing Issues (Not Blocking)

_No critical pre-existing complexity issues detected in the reviewed files._

## Suggestions (Lower Confidence)

- **Container lookups in `handleOrchestrateInteractive` bypass DI pattern** - `src/cli/commands/orchestrate.ts:731-733` (Confidence: 65%) -- Two `container.get()` calls retrieve `eventBus` and `orchestrationRepository` directly, bypassing the service layer that already exposes operations on those. If orchestrationService already provided finalization methods, these raw lookups would be unnecessary.

- **`parseOrchestrateArgs` growing dispatch complexity** - `src/cli/commands/orchestrate.ts:369-421` (Confidence: 62%) -- The dispatcher function now has 6 branches (status, list, cancel, init, interactive-subcommand, interactive-in-args) plus the default create path. The two interactive detection paths (subcommand position vs. flag position) add ambiguity. Consider a flag-first approach where `--interactive` is always stripped before dispatching.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Complexity Score**: 6/10
**Recommendation**: CHANGES_REQUESTED

The `handleOrchestrateInteractive` function is the primary concern -- at ~140 lines with cyclomatic complexity ~12, it bundles too many concerns into a single function. The duplicated validation between the two create methods compounds the maintainability cost. The refactoring for `resolveSpawnConfig` in `base-agent-adapter.ts` is well-executed (extracts shared logic, reduces spawn/spawnInteractive to thin wrappers) and serves as a good model for addressing these findings.
