# Consistency Review Report

**Branch**: feat-134-system-prompt-support -> main
**Date**: 2026-04-17T16:41:00

## Issues in Your Changes (BLOCKING)

### HIGH

**Version references use v1.4.0 but current version is v1.3.1 and no version bump occurred** - Multiple files
**Confidence**: 95%
- Locations: `src/adapters/mcp-adapter.ts:106,281,391`, `src/core/domain.ts:115,210,274,689,802`, `src/core/agents.ts:247`, `src/implementations/base-agent-adapter.ts:186`, `src/implementations/database.ts:948`, `src/implementations/event-driven-worker-pool.ts:305`, `src/services/orchestration-manager.ts:219,236`
- Problem: 15+ comments reference "v1.4.0" across source files, but `package.json` is at `1.3.1`. The project previously had a v1.4.0 branch that was consolidated into v1.3.0 (Session 279 in memory). This feature will ship in whatever the next version bump is -- referencing v1.4.0 presumes a version that has not been decided. The existing pattern for `jsonSchema` and `orchestratorId` uses the actual released version (e.g., `// JSON schema for structured output (v1.3.0)`, `// Orchestration attribution (v1.3.0)`). Using an unreleased version number creates PF-009-type desync.
- Fix: Either remove version references entirely (they'll be added at release time) or use a placeholder like `(v1.x.0)` or `(next minor)`. The established codebase pattern is to reference the version only after it has been assigned. Migration v23 description is the most critical since it persists in the database.

**New `@design` JSDoc tag introduced without codebase precedent** - Multiple files
**Confidence**: 82%
- Locations: `src/adapters/mcp-adapter.ts:121,402`, `src/implementations/database.ts:943`, `src/implementations/base-agent-adapter.ts:59`, `src/implementations/loop-repository.ts:121`, `src/implementations/claude-adapter.ts:40`, `src/implementations/codex-adapter.ts:32`, `src/implementations/gemini-adapter.ts:41`, `src/services/orchestrator-prompt.ts:7`
- Problem: The codebase has 55 occurrences of `DECISION:` and `ARCHITECTURE:` comment markers across 25 files. This PR introduces a new `@design` JSDoc tag pattern (9 occurrences) that did not exist on `main`. The project's memory files (`feedback_design_decision_jsdoc.md`) specify: "add `DECISION:` or `ARCHITECTURE:` JSDoc comments at every non-obvious choice point." The new `@design` tag is not an established project convention.
- Fix: Replace `@design` with the existing `DECISION:` pattern. For example:
  ```typescript
  // Before (new pattern):
  /** @design system_prompt is persisted per-task (not per-agent) so retry/resume... */
  
  // After (existing pattern):
  /** DECISION: system_prompt is persisted per-task (not per-agent) so retry/resume... */
  ```

### MEDIUM

**CLI flag `--system-prompt` lacks short alias, unlike `--agent`/`--model`** - `src/cli.ts:180`, `src/cli/commands/orchestrate.ts:162`, `src/cli/commands/loop.ts:318`
**Confidence**: 80%
- Problem: The existing pattern for optional CLI flags is to provide both long and short forms: `--agent`/`-a`, `--model`/`-m`, `--priority`/`-p`, `--working-directory`/`-w`, `--foreground`/`-f`. The new `--system-prompt` flag only has the long form. While not all flags have short aliases (e.g., `--depends-on`, `--timeout`), the flags for agent configuration (`--agent`, `--model`) consistently do, and `--system-prompt` is in the same category.
- Fix: Consider adding `-s` or `--sp` as a short alias for `--system-prompt` in `cli.ts`, `orchestrate.ts`, and `loop.ts`. If `-s` conflicts, no alias is acceptable but should be a deliberate decision.

**`beat status --system-prompt` flag undocumented in help text** - `src/cli.ts:225-238`
**Confidence**: 85%
- Problem: The `beat run` command documents `--system-prompt` in its help text (line 208), but `beat status` accepts `--system-prompt` as a boolean flag without any help text or usage documentation. When `beat status` is invoked without arguments or with `--help`, the user has no way to discover this flag.
- Fix: Add help text for `beat status` or document the `--system-prompt` flag in the existing `beat status` usage pattern.

**`DECISION` comment in `orchestration-manager.ts:219` uses inline comment style instead of JSDoc block** - `src/services/orchestration-manager.ts:219-221`
**Confidence**: 80%
- Problem: The new DECISION comment at line 219 uses `//` inline comments. The existing DECISION comments in the same file (lines 62-67, 170-175, 251-254) use `//` style consistently, so this is internally consistent with the file. However, the PR also introduces `@design` JSDoc in other files for the same kind of decision documentation. This inconsistency within the PR itself (two different patterns for documenting decisions) reduces clarity.
- Fix: Pick one pattern and apply it throughout the PR. Given the existing codebase uses `DECISION:` inline comments, convert `@design` JSDoc to `DECISION:` inline comments for consistency.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Loop auto-commit included in PR branch** - commit `ebc9603`
**Confidence**: 90%
- Problem: Commit `ebc9603` ("Loop loop-76aa2848-... iteration 1 -- pass") is an auto-generated loop commit that modified 4 source files. This is a development artifact, not a deliberate feature commit. The project memory (Session 279) documents this as a known gotcha: "A loop auto-committed changes mid-session; soft-reset and recommitted properly." Including this in the PR muddies the commit history.
- Fix: Before merging, consider squashing all commits or interactive-rebasing to drop the loop commit and fold its changes into the proper feature commits.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**PF-006: `ProcessSpawnerAdapter` does not handle `systemPrompt` field** - `src/implementations/process-spawner-adapter.ts`
**Confidence**: 88%
- Problem: Known pitfall PF-006 documents that `ProcessSpawnerAdapter.spawn` destructures only `{ prompt, workingDirectory, taskId, model }` and silently discards extra fields. The new `systemPrompt` field in `SpawnOptions` will be silently dropped by this adapter. This is a pre-existing architectural issue (not introduced by this PR) but is worsened by adding another field that will be silently discarded.
- Fix: Address in a separate PR as part of PF-006 resolution (either update the adapter or remove/deprecate it).

## Suggestions (Lower Confidence)

- **`includeSystemPrompt` naming inconsistency between CLI and MCP** - `src/cli.ts:231` vs `src/adapters/mcp-adapter.ts:123` (Confidence: 65%) -- The CLI uses `--system-prompt` as a boolean flag on `beat status` (shows system prompt), but the MCP schema uses `includeSystemPrompt`. The semantics are the same but the naming differs: the CLI flag implies the field itself while the MCP field uses `include` prefix. This is minor since CLI and MCP have different conventions.

- **Migration v23 description hardcodes v1.4.0** - `src/implementations/database.ts:948` (Confidence: 75%) -- The migration description string `'Add system_prompt column to tasks table (v1.4.0)'` persists in the database. If this ships as a different version, the migration description will be permanently inaccurate. Unlike source code comments, migration descriptions cannot be updated after deployment.

- **`console.error` used for structured logging in `gemini-adapter.ts`** - `src/implementations/gemini-adapter.ts:66-72,90-96,102-107` (Confidence: 70%) -- The existing codebase convention uses injected `Logger` for structured logging. The `GeminiAdapter` inherits from `BaseAgentAdapter` which has `protected readonly config: Configuration` but no logger. The `getSystemPromptConfig` method uses `console.error(JSON.stringify(...))` instead. This matches the existing pattern in `base-agent-adapter.ts:232` for orchestratorId warnings, so it is internally consistent with the adapter layer, though inconsistent with the broader service layer.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Consistency Score**: 6/10
**Recommendation**: CHANGES_REQUESTED

The `systemPrompt` field addition follows the established pattern for optional fields (matching `jsonSchema` and `orchestratorId` in domain types, Zod schemas, DB persistence, CLI flags, and MCP tools). The core threading is consistent. The two HIGH issues -- hardcoded v1.4.0 references (15+ occurrences) and a new `@design` JSDoc convention that diverges from the established `DECISION:`/`ARCHITECTURE:` pattern -- should be addressed before merge. The v1.4.0 references are particularly concerning given PF-009 (release notes desync from code) is a known pitfall, and embedding an unreleased version in migration descriptions persists permanently in the database.
