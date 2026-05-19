# Complexity Review Report

**Branch**: feat/134-system-prompt-support -> main
**Date**: 2026-04-17
**Scope**: Incremental review (7 commits since ef16f93b)

## Issues in Your Changes (BLOCKING)

### HIGH

**(No HIGH blocking issues found)**

### MEDIUM

**CLI `run` command arg-parsing block is 162 lines with 5 nesting levels** - `src/cli.ts:63-224`
**Confidence**: 82%
- Problem: The `else if (mainCommand === 'run')` block spans 162 lines (lines 63-224) and nests 5 levels deep (if mainCommand > if hasForeground > for loop > if/else-if chain > if validation). The incremental addition of `--system-prompt` (lines 180-188) adds one more branch to an already-long if/else-if chain (now 10 branches). This is a pre-existing pattern that the new code follows consistently, but each addition increases the maintenance burden.
- Fix: This is not introduced by this PR (the pattern existed before `--system-prompt` was added), but the PR extends it. A future refactor could extract flag parsing into a helper (e.g., `parseForegroundArgs(foregroundArgs): Result<RunOptions, string>`) similar to the pattern already used in `parseLoopCreateArgs` and `parseOrchestrateCreateArgs`. Not blocking for this PR since the new code follows the established pattern.

## Issues in Code You Touched (Should Fix)

**(No should-fix issues)**

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`parseLoopCreateArgs` is 153 lines with linear if/else-if chain (21 branches)** - `src/cli/commands/loop.ts:211-363`
**Confidence**: 85%
- Problem: The function has 21 branches in a single for-loop if/else-if chain, making it hard to grok at a glance. The system prompt branch (lines 318-323) was modified in this diff (the `startsWith('-')` guard was changed to `next === undefined`), but the overall length is pre-existing. At 153 lines, this exceeds the 50-line warning threshold for function length.
- Fix: Consider a table-driven parser pattern (map of flag-name to handler function) to flatten the if/else-if chain. Not blocking since the changes in this PR are minimal and correct.

### MEDIUM

**`src/cli.ts` is 359 lines as a single procedural script** - `src/cli.ts:1-359`
**Confidence**: 80%
- Problem: The entire CLI entry point is one large top-level if/else-if chain routing commands. The `run` sub-block alone is 162 lines. The file has grown organically and would benefit from extraction of each command handler into its own module (as was done for `loop.ts`, `orchestrate.ts`, `agents.ts`).
- Fix: Extract the `run` command block into `src/cli/commands/run.ts` with a `parseRunArgs` function, mirroring the existing pattern for other commands. Not blocking.

## Suggestions (Lower Confidence)

- **Duplicate Zod schema descriptions across MCP adapter** - `src/adapters/mcp-adapter.ts:171-182, 276-287, 496-507` (Confidence: 70%) -- The same 3-line system prompt description string is repeated verbatim in 4 Zod schemas (ScheduleTask, SchedulePipeline, ScheduleLoop, DelegateTask). A shared constant would reduce drift risk.

- **`GeminiBasePromptCache` class mixes file I/O and logging** - `src/implementations/gemini-adapter.ts:24-103` (Confidence: 65%) -- The cache class uses `console.error(JSON.stringify(...))` for structured logging rather than the project's Logger interface. This is acceptable for adapter code that runs outside the DI container, but worth noting for consistency.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 2 | 0 |

**Complexity Score**: 8/10
**Recommendation**: APPROVED

## Rationale

The 7 incremental commits are well-structured with low complexity impact:

1. **GeminiBasePromptCache extraction** (abbd413) reduces complexity in `GeminiAdapter` by extracting filesystem operations into a dedicated class. `getSystemPromptConfig` is now 6 lines (down from ~50). This is a clear complexity win.

2. **CLI dash-guard fix** (c003bb7, 399c8e0) changes `!next.startsWith('-')` to `next === undefined` in system-prompt parsers. This simplifies the guard logic (one check instead of two) and is correct -- system prompts can legitimately start with dashes.

3. **Schedule flow threading** (83d57c6) adds `systemPrompt` passthrough in `schedule-manager.ts` and `schedule-handler.ts` -- trivial 1-2 line additions that follow existing field-forwarding patterns.

4. **Test coverage** (841bbfe) adds 186 lines of well-structured tests across 5 test files. Tests are focused on behaviors (arg parsing, field persistence, MCP tool responses) with no complex setup.

5. **Comment tag standardization** (5375614, 399c8e0) replaces `@design` JSDoc tags with `DECISION:` line comments. Purely cosmetic, no complexity impact.

The only complexity concern is the pre-existing CLI arg-parsing pattern, which this PR extends but does not worsen structurally. The new code follows established conventions consistently. No known pitfalls from `.memory/knowledge/pitfalls.md` are reintroduced by these changes.
