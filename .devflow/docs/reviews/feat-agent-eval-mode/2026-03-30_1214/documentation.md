# Documentation Review Report

**Branch**: feat-agent-eval-mode -> main
**Date**: 2026-03-30T12:14

## Issues in Your Changes (BLOCKING)

### HIGH

**FEATURES.md not updated for agent eval mode** - `docs/FEATURES.md:327-376`
**Confidence**: 95%
- Problem: The PR adds a significant new feature (agent eval mode with `evalMode`, `evalPrompt`, `evalFeedback`, new CLI flags `--eval-mode`, `--eval-prompt`, `--strategy`, and a new DB migration v15) but `docs/FEATURES.md` is not updated. The Loop Strategies section (line 338-340) still describes only shell-based evaluation. The Configuration section (line 351-356) does not mention `evalMode`, `evalPrompt`, or the increased eval timeout for agent mode (600s vs 300s). The CLI Commands section (line 358-366) does not list the new `--eval-mode agent --strategy retry|optimize` usage. The Database Schema section (line 374-375) does not mention Migration 15.
- Fix: Add agent eval mode to the Loop Strategies subsection. Add `evalMode`, `evalPrompt`, and eval timeout differences to Configuration. Add agent eval CLI examples to CLI Commands. Add Migration 15 to Database Schema.

**README.md Eval Loops section omits agent eval mode** - `README.md:105-135`
**Confidence**: 92%
- Problem: The README "Eval Loops" section only shows shell-based `--until` and `--eval` examples. Agent eval mode is a user-facing feature with distinct CLI flags (`--eval-mode agent --strategy retry`) but has no mention or example in the README. Users discovering the feature will not know it exists.
- Fix: Add an "Agent eval" example after the existing shell examples:
  ```markdown
  **Agent eval** -let an AI judge the result:

  ```bash
  beat loop "Fix the failing tests" --eval-mode agent --strategy retry
  ```
  ```

**CHANGELOG.md [Unreleased] section empty** - `CHANGELOG.md:7-9`
**Confidence**: 90%
- Problem: The CHANGELOG `[Unreleased]` section says "Nothing yet." despite this branch adding a substantial feature: agent eval mode with new `evalMode`/`evalPrompt` fields, `CompositeExitConditionEvaluator`, `AgentExitConditionEvaluator`, DB migration v15, new CLI flags, and stale-state guard in LoopHandler. All of these are notable changes that should be documented in the changelog.
- Fix: Add an `[Unreleased]` entry with the feature, database migration, and new CLI flags. Example:
  ```markdown
  ## [Unreleased]

  ### Features
  - **Agent eval mode**: New `--eval-mode agent` loop evaluation strategy that delegates exit condition judgment to a separate AI agent instead of a shell command
  - **Custom eval prompts**: `--eval-prompt` flag for agent eval mode customization
  - **Stale state guard**: Re-fetches loop/iteration state after potentially slow agent eval to prevent processing cancelled loops

  ### Database
  - **Migration 15**: `eval_mode`, `eval_prompt` columns on `loops` table; `eval_feedback` column on `loop_iterations` table
  ```

### MEDIUM

**CLAUDE.md File Locations table missing new files** - `CLAUDE.md:147-167`
**Confidence**: 85%
- Problem: The File Locations quick reference table in CLAUDE.md does not include the two new service files (`src/services/agent-exit-condition-evaluator.ts`, `src/services/composite-exit-condition-evaluator.ts`). These are architecturally significant new components (strategy and composite patterns for eval routing) that future developers would want to locate quickly.
- Fix: Add entries to the File Locations table:
  ```markdown
  | Agent eval evaluator | `src/services/agent-exit-condition-evaluator.ts` |
  | Composite evaluator | `src/services/composite-exit-condition-evaluator.ts` |
  ```

**MCP tool description for CreateLoop does not mention agent eval mode** - `src/adapters/mcp-adapter.ts:234-263`
**Confidence**: 82%
- Problem: While the Zod `.describe()` strings on individual fields are updated (e.g., `evalMode`, `evalPrompt`), the top-level `CreateLoop` tool description (registered with MCP server) likely still only mentions shell-based evaluation. MCP clients (LLMs reading tool descriptions) would benefit from knowing agent eval mode exists in the tool's top-level description.
- Fix: Verify and update the `CreateLoop` tool description string to mention both shell and agent eval modes.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Inline comment on exitCondition says "empty string for agent mode" without explaining why** - `src/core/domain.ts:277`
**Confidence**: 80%
- Problem: The comment `// Shell command to evaluate iteration result (empty string for agent mode)` on the `exitCondition` field explains "what" but not "why" the empty string convention was chosen over making it truly optional (`string | undefined`). A future developer might wonder if empty string is a sentinel or a bug.
- Fix: Expand the comment to explain the design decision:
  ```typescript
  readonly exitCondition: string; // Shell command for shell eval mode; empty string for agent mode (kept non-optional for backward compat with existing DB rows)
  ```

## Pre-existing Issues (Not Blocking)

### MEDIUM

**FEATURES.md version label says "Last Updated: March 2026 (v1.0.0)"** - `docs/FEATURES.md:5`
**Confidence**: 85%
- Problem: The "Last Updated" line at the top of FEATURES.md references v1.0.0 but will be outdated once this feature ships (presumably as part of a future version). This is a pre-existing issue with the manual version tracking approach.
- Fix: Update the "Last Updated" line when merging this feature to reflect the new version.

**ExitConditionEvaluator interface has no JSDoc** - `src/core/interfaces.ts:685-687`
**Confidence**: 82%
- Problem: The `ExitConditionEvaluator` interface and its `evaluate` method lack JSDoc documentation. With the addition of agent eval mode, this interface now has two concrete implementations (shell and agent), making documentation about the contract (what `evaluate` should return for retry vs optimize strategies) more important.
- Fix: Add JSDoc to the interface:
  ```typescript
  /**
   * Evaluates the result of a loop iteration to determine pass/fail or score.
   * Implementations: ShellExitConditionEvaluator (shell commands), AgentExitConditionEvaluator (AI agent review).
   */
  export interface ExitConditionEvaluator {
    /** Evaluate iteration result. Returns passed=true for pass/keep, passed=false for fail/discard. */
    evaluate(loop: Loop, taskId: TaskId): Promise<EvalResult>;
  }
  ```

## Suggestions (Lower Confidence)

- **Orchestrator prompt has a minor inconsistency** - `src/services/orchestrator-prompt.ts:45` (Confidence: 70%) -- The shell eval example uses `--strategy retry` which is actually invalid in shell mode (the diff shows `--strategy is only valid with --eval-mode agent`). The orchestrator prompt correctly separates the two modes in the section headers, but the first shell example includes `--strategy retry` which would fail validation.

- **Test file headers could include brief feature context** - `tests/unit/services/agent-exit-condition-evaluator.test.ts:1-7` (Confidence: 65%) -- The test file header comment explains the architecture pattern but does not mention when or why this feature was added (e.g., "Added in v0.9.0 for agent-based loop evaluation"). This context helps when triaging test failures months later.

- **LoopCreateRequest JSDoc for exitCondition could be more precise** - `src/core/domain.ts:298` (Confidence: 62%) -- The comment says "Required for shell mode, optional for agent mode" but does not specify what happens when it is missing in shell mode (validation error from LoopManagerService).

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 3 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 2 | 0 |

**Documentation Score**: 4/10
**Recommendation**: CHANGES_REQUESTED

The code itself has good inline documentation (JSDoc on key methods, ARCHITECTURE comments on new files, clear Zod `.describe()` strings). However, none of the three user-facing documentation artifacts (README.md, docs/FEATURES.md, CHANGELOG.md) have been updated to reflect this significant new feature. Agent eval mode introduces new CLI flags, MCP tool parameters, a database migration, and a new evaluation paradigm -- all of which need to be discoverable by users reading the project documentation. The CLAUDE.md file locations table is also missing the two new service files.
