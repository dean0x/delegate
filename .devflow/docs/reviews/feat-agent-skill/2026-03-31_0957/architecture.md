# Architecture Review Report

**Branch**: feat-agent-skill -> main
**Date**: 2026-03-31
**Commits reviewed**: a4a1775 (feat: add agent orchestration skill and skill installer), 498049b (style: fix pre-existing biome lint and format issues)

## Issues in Your Changes (BLOCKING)

### HIGH

**Duplicated skill-path rendering logic in initCommand** - `src/cli/commands/init.ts:477-482,488-493`
**Confidence**: 90%
- Problem: The `initCommand` function contains two identical blocks for rendering installed skill paths -- one in the interactive branch and one in the non-interactive branch. This violates DRY and means any future change to the display format must be applied in two places.
- Fix: Extract a shared helper function:
```typescript
function displaySkillPaths(paths: readonly string[]): void {
  if (paths.length > 0) {
    ui.success('Agent skills installed:');
    for (const skillPath of paths) {
      ui.step(`  ${skillPath}`);
    }
  }
}
```
Then call `displaySkillPaths(result.skillPaths ?? [])` in both branches. Note: this also resolves the variable shadowing of `p` (the `@clack/prompts` import) by the loop variable `p` inside `for (const p of result.skillPaths)`.

### MEDIUM

**Optional deps erode InitDeps contract clarity** - `src/cli/commands/init.ts:46-53`
**Confidence**: 85%
- Problem: Five new optional properties were added to `InitDeps` (`confirmSkillInstall?`, `selectSkillAgents?`, `copySkills?`, `skillsExist?`, `confirmSkillUpdate?`). The runtime logic then defensively checks for their presence (`if (deps.confirmSkillInstall)`, `if (!deps.copySkills)`, etc.) creating implicit feature detection. This weakens the contract -- callers cannot easily tell which dependency combination is required for skill installation to work. The existing non-optional deps (`checkAuth`, `selectAgent`, etc.) follow a cleaner contract.
- Fix: Consider a composition approach -- either make all skill deps required and provide no-op defaults in `createDefaultDeps`, or group them into a separate `SkillInstallDeps` interface that is either entirely present or absent:
```typescript
export interface SkillInstallDeps {
  readonly confirmSkillInstall: () => Promise<boolean | 'cancelled'>;
  readonly selectSkillAgents: (defaultAgent: AgentProvider) => Promise<readonly AgentProvider[] | 'cancelled'>;
  readonly copySkills: (agents: readonly AgentProvider[], projectRoot: string) => CopyResult;
  readonly skillsExist: (agents: readonly AgentProvider[], projectRoot: string) => boolean;
  readonly confirmSkillUpdate: () => Promise<boolean | 'cancelled'>;
}

export interface InitDeps {
  // ... existing required deps ...
  readonly skillInstall?: SkillInstallDeps;
}
```
This makes the presence check a single `if (deps.skillInstall)` rather than five scattered checks.

**process.cwd() as projectRoot couples to runtime context** - `src/cli/commands/init.ts:277`
**Confidence**: 82%
- Problem: `runSkillInstall` hardcodes `const projectRoot = process.cwd()` rather than accepting it as a parameter or through deps. This makes it impossible to test with a custom project root without changing the process working directory, and couples the function to the global process state. The existing deps pattern in this file provides a clear DI approach that this function does not follow.
- Fix: Accept `projectRoot` as a parameter to `runSkillInstall`, or add it to `InitDeps`/`InitOptions`. In production, `createDefaultDeps` or `initCommand` can supply `process.cwd()`.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Variable shadowing: `p` in initCommand** - `src/cli/commands/init.ts:479,490`
**Confidence**: 92%
- Problem: The loop `for (const p of result.skillPaths)` shadows the module-level `import * as p from '@clack/prompts'`. While this works because the inner `p` is block-scoped and the outer `p` is not needed in that block, it is confusing and a biome/eslint shadow rule would flag it. The same shadow occurs in both identical blocks (lines 479 and 490).
- Fix: Rename the loop variable to `skillPath` or `installedPath`:
```typescript
for (const skillPath of result.skillPaths) {
  ui.step(`  ${skillPath}`);
}
```

## Pre-existing Issues (Not Blocking)

No critical pre-existing architectural issues found in the reviewed files.

## Suggestions (Lower Confidence)

- **MCP_INSTRUCTIONS as hardcoded string vs generated from skill content** - `src/adapters/mcp-instructions.ts` (Confidence: 65%) -- The MCP instructions and the skill content (skills/autobeat/SKILL.md) describe overlapping concepts. If these drift apart over time, connecting agents will receive instructions that disagree with the installed skills. Consider generating MCP_INSTRUCTIONS from the skill content, or at minimum adding a comment noting the relationship.

- **Partial failure semantics in defaultCopySkills** - `src/cli/commands/init.ts:160-166` (Confidence: 70%) -- If copying to the second of three directories fails, the first directory has already been written but the function returns an error. The caller receives `ok: false` despite partial writes. This could leave the file system in an inconsistent state. Consider cleaning up already-installed directories on failure, or returning partial success information.

- **AGENT_SKILL_DIRS mapping may need extension mechanism** - `src/cli/commands/init.ts:60-64` (Confidence: 62%) -- The hardcoded mapping from agent providers to skill directories works for three providers, but adding a new agent would require modifying this constant. If the project expects more agent providers, consider co-locating skill directory configuration with the agent definition in `core/agents.ts`.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Architecture Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The PR introduces two well-designed features: (1) an MCP instructions string for connecting agents, and (2) a skill installer integrated into the `beat init` CLI flow. Both follow the project's established patterns -- dependency injection for testability, Result-style error handling, and clear separation of concerns between types/logic/CLI-entry layers. The skill content itself (SKILL.md and references/) is comprehensive and well-structured.

The conditions for approval are:
1. Extract the duplicated skill-path rendering in `initCommand` (HIGH)
2. Rename the `p` loop variable to avoid shadowing the `@clack/prompts` import (MEDIUM, quick fix)

The optional deps fragmentation (MEDIUM) is a design consideration worth addressing but should not block this PR.
