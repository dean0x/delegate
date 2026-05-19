# Documentation Review Report

**Branch**: feat/135-custom-orchestrators -> main
**Date**: 2026-04-22

## Issues in Your Changes (BLOCKING)

### HIGH

**CLAUDE.md Documentation Structure section not updated with new docs file** - `CLAUDE.md:301-308`
**Confidence**: 95%
- Problem: A new documentation file `docs/CUSTOM_ORCHESTRATORS.md` (291 lines) was added but the Documentation Structure section in CLAUDE.md was not updated to include it. This section serves as the canonical index of documentation files and is consulted by developers and AI agents navigating the project.
- Fix: Add `- docs/CUSTOM_ORCHESTRATORS.md - Custom orchestrator guide` to the Documentation Structure list in CLAUDE.md.

**docs/CUSTOM_ORCHESTRATORS.md flag table has inaccurate description for --working-directory** - `docs/CUSTOM_ORCHESTRATORS.md:59`
**Confidence**: 90%
- Problem: The flag table describes `--working-directory` as "Working directory embedded in state path". This is incorrect. The state path is always `~/.autobeat/orchestrator-state/state-<timestamp>-<uuid>.json` regardless of the working directory value. The working directory is used in the MCP tool's usage instructions as a suggested `workingDirectory` field for the subsequent `CreateLoop` call, and in the CLI it is validated but not included in the suggested loop command output at all.
- Fix: Change the description to "Working directory for the subsequent loop command" or similar wording that accurately describes its purpose.

### MEDIUM

**CLI suggested loop command omits --working-directory but MCP usage includes it** - `src/cli/commands/orchestrate.ts:614` and `docs/CUSTOM_ORCHESTRATORS.md:38-46`
**Confidence**: 85%
- Problem: The CLI Quick Start example in the docs shows the ready-to-use loop command without a `--working-directory` flag, which matches the CLI implementation (line 614). However, the MCP Quick Start example (line 98) includes `workingDirectory` in the CreateLoop call. The documentation does not explain this asymmetry. Users following the CLI path will not get the working directory threaded into their loop, while MCP users will.
- Fix: Either (a) add `--working-directory` to the CLI's suggested loop command output and update the docs to show it, or (b) add a note in the docs explaining that the CLI user should manually add `--working-directory` to their loop command if needed.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**JSDoc on buildFinalPrompts cross-references InitCustomOrchestrator without explaining the relationship** - `src/services/orchestration-manager.ts:298-300`
**Confidence**: 80%
- Problem: The updated JSDoc on `buildFinalPrompts` says "For full custom orchestrators, prefer InitCustomOrchestrator which provides instruction snippets (from orchestrator-prompt.ts snippet builders) + state file scaffolding." This is a comment on a private method that is only reachable through `CreateOrchestrator`. Advising callers of this private method to "prefer InitCustomOrchestrator" does not make sense -- the method is internal and its callers cannot choose a different tool. The DECISION comment on the original prompt (lines 295-297) is clear and sufficient.
- Fix: Remove the added sentence (lines 298-300) or rephrase it as an architectural note: "Note: The snippet builders used here are also exported for InitCustomOrchestrator (custom orchestrator scaffolding)."

## Pre-existing Issues (Not Blocking)

_None at CRITICAL severity._

## Suggestions (Lower Confidence)

- **docs/CUSTOM_ORCHESTRATORS.md Quick Start CLI example calls `beat orchestrate init` twice** - `docs/CUSTOM_ORCHESTRATORS.md:30,196` (Confidence: 70%) -- The Quick Start section first shows a bare `beat orchestrate init "..."` to demonstrate output, then below shows `INIT_OUTPUT=$(beat orchestrate init "..." ...)` to capture output for scripting. This could confuse readers into thinking they need to run init twice. Consider consolidating into a single scripting-oriented example.

- **docs/CUSTOM_ORCHESTRATORS.md Example 1 runs init twice** - `docs/CUSTOM_ORCHESTRATORS.md:192-198` (Confidence: 70%) -- Example 1 (Code Review Orchestrator) calls `beat orchestrate init` on line 192 as a standalone command, then immediately calls it again on line 196 with `INIT_OUTPUT=$(...)`. The first call creates orphaned state files that are never used. Consider showing only the `INIT_OUTPUT=$(...)` pattern.

- **MCP tool description uses a long single-line string without line breaks** - `src/adapters/mcp-adapter.ts:1587-1588` (Confidence: 65%) -- The InitCustomOrchestrator tool `description` field is a single long string. Other tools in the codebase sometimes split descriptions across lines for readability. Minor style consistency point.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Documentation Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The new `docs/CUSTOM_ORCHESTRATORS.md` is well-structured with clear examples covering CLI, MCP, building blocks, state file reference, cleanup guidance, and a comparison table. Code-level documentation (JSDoc, DECISION comments) is thorough and follows project conventions. The main issues are: (1) the CLAUDE.md Documentation Structure index was not updated with the new file, (2) the flag table contains an inaccurate description for `--working-directory`, and (3) there is a CLI/MCP documentation asymmetry around working directory handling that could confuse users.
