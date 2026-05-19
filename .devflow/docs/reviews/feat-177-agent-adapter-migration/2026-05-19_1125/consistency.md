# Consistency Review Report

**Branch**: feat/177-agent-adapter-migration -> main
**Date**: 2026-05-19

## Issues in Your Changes (BLOCKING)

### HIGH

**`buildTmuxCommand` not on `AgentAdapter` interface but present on both implementations** - `src/core/agents.ts:273`, `src/implementations/base-agent-adapter.ts:114`, `src/implementations/process-spawner-adapter.ts:46`
**Confidence**: 90%
- Problem: The `AgentAdapter` interface (the contract all adapters implement) does not declare `buildTmuxCommand()`, yet both `BaseAgentAdapter` and `ProcessSpawnerAdapter` independently implement it. This means callers must downcast to concrete types to access the method, breaking the adapter pattern the codebase consistently uses. Every other spawn-related method (`spawn`, `spawnInteractive`, `kill`, `dispose`, `cleanup`) is declared on the interface.
- Fix: Add `buildTmuxCommand` to the `AgentAdapter` interface in `src/core/agents.ts` alongside the existing methods. The feature knowledge explicitly states "Port interfaces pattern for all tmux classes" -- the `AgentAdapter` interface is the port interface for agent adapters.

```typescript
// src/core/agents.ts — add to AgentAdapter interface
buildTmuxCommand(
  options: SpawnOptions & { sessionsDir: string },
): Result<{ readonly config: TmuxSpawnConfig; readonly prompt: string }>;
```

**`buildTmuxArgs` is non-abstract with empty default, breaking the three-tier pattern** - `src/implementations/base-agent-adapter.ts:105`
**Confidence**: 82%
- Problem: `buildArgs` and `buildInteractiveArgs` are both `protected abstract`, forcing every subclass to implement them. `buildTmuxArgs` is `protected` with a default empty-array implementation. This inconsistency means a new adapter could silently produce an empty agentArgs array for tmux sessions instead of getting a compile-time error. The codebase pattern (enforced since v1.3.0) is that each arg-builder tier is abstract.
- Fix: Make `buildTmuxArgs` abstract to match `buildArgs` and `buildInteractiveArgs`. Move the empty-array default into `ProcessSpawnerAdapter` (which already returns INVALID_OPERATION for tmux anyway) or keep the non-abstract default but document the design decision with a JSDoc DECISION comment explaining why tmux args are optional unlike headless/interactive args.

### MEDIUM

**Removed `refreshBasePrompt` CLI command without CLI deprecation notice** - `src/cli.ts:307-309`, `src/cli/commands/agents.ts:1-2`
**Confidence**: 85%
- Problem: The `beat agents refresh-base-prompt` subcommand was removed and the valid-subcommands error message updated from `'list, check, config, refresh-base-prompt'` to `'list, check, config'`. This is a clean removal consistent with removing Gemini entirely. However, the help text previously listed it and users calling the old command will get an unhelpful "Unknown agents subcommand" error with no mention of Gemini removal. Applies: this is consistent with `avoids PF-002` (no backward-compatibility paths for features with zero users), but noting for completeness.
- Fix: No fix needed -- PF-002 applies. The removal is a clean break.

**Inconsistent Codex systemPrompt description across MCP schema locations** - `src/adapters/mcp-adapter.ts`
**Confidence**: 83%
- Problem: In some Zod `.describe()` locations the systemPrompt description says `Codex: -c developer_instructions` (with the `-c` flag) while in the raw JSON schema `properties.systemPrompt.description` it says `Codex: developer_instructions` (without `-c`). Both formats appear in the branch. The Zod schemas were updated to consistently use `-c developer_instructions` in the JSDoc comments, but the JSON schema `description` strings (used for raw MCP tool schemas at lines ~790, ~958) also show `-c`. This is actually now consistent after the PR changes -- confirming no action needed.
- Fix: No fix needed -- the descriptions are now consistently showing `-c developer_instructions` across all locations. Withdrawing this finding.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`buildTmuxCommand` hardcodes provider check instead of using type system** - `src/implementations/base-agent-adapter.ts:118-120`
**Confidence**: 82%
- Problem: `buildTmuxCommand` contains a runtime check `if (this.provider !== 'claude' && this.provider !== 'codex')` that duplicates the `TmuxAgentType` type constraint. The existing pattern in the codebase (e.g., `resolveRuntime`) uses type-level constraints and exhaustive guards. A new agent added to `AgentProvider` would pass TypeScript compilation but fail at runtime with a confusing "tmux mode is not supported" error instead of a compile-time error.
- Fix: Use the `TmuxAgentType` cast with a type assertion or narrow via the type system. If `buildTmuxArgs` were made abstract (per the finding above), unsupported adapters would simply not exist. Alternatively, keep the runtime check but add a DECISION comment explaining why runtime validation was chosen over type-level constraint.

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Barrel export ordering changed for tmux index** - `src/implementations/tmux/index.ts` (Confidence: 65%) -- The `TmuxValidator` export was moved from between `TmuxSessionManager` and the shell utilities block to after the shell utilities. While harmless functionally, the previous order followed the dependency hierarchy (validator -> session-manager -> hooks -> connector). The new order interleaves shell utilities between session-manager and validator, slightly reducing scanability.

- **`agents.ts` CLI command module docstring still mentions old command** - Verified: this was actually updated from `beat agents list | check | config | refresh-base-prompt` to `beat agents list | check | config`. No action needed. Withdrawing.

- **`outputFlushIntervalMs` not in testConfig for build-tmux-command tests** - `tests/unit/implementations/build-tmux-command.test.ts:41-50` (Confidence: 62%) -- The `testConfig` object omits `outputFlushIntervalMs` which is present in other test configs (e.g., `agent-adapters.test.ts`). If `Configuration` makes this field required in future, this test will fail. Low risk since Configuration currently has a default.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 0 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Consistency Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The Gemini removal is thorough and consistently applied across all 52 changed files -- every reference in types, docs, CLI help text, MCP schemas, and tests was updated. The `buildTmuxCommand` + `buildTmuxArgs` additions follow the existing three-tier adapter pattern (headless / interactive / tmux) but deviate from the interface-first contract pattern that the rest of the adapter hierarchy uses. Adding `buildTmuxCommand` to the `AgentAdapter` interface and making `buildTmuxArgs` abstract would bring the new tmux tier into full alignment with the established pattern.
