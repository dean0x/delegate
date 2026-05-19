# Code Reuse Review Report

**Branch**: feat/agent-skill -> main
**Date**: 2026-03-31

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Content overlap between `mcp-instructions.ts` and `skills/autobeat/SKILL.md`** - `src/adapters/mcp-instructions.ts:1-79`, `skills/autobeat/SKILL.md:1-160`
**Confidence**: 82%
- Problem: `MCP_INSTRUCTIONS` (79 lines) and `SKILL.md` cover the same conceptual content -- when to use each primitive (tasks, pipelines, loops, schedules, orchestrations), monitoring patterns, and key principles. Both describe the same capability hierarchy, the same tool names, and the same usage examples. If either document drifts, the other will become stale.
- Context: These serve different audiences (MCP clients via protocol vs. agents via skill file), so some overlap is expected. However, the "When to Use Each Capability" section in `mcp-instructions.ts` and the "Capability Hierarchy" / "Quick Reference" sections in `SKILL.md` are substantially duplicated in intent and coverage.
- Fix: Consider generating `MCP_INSTRUCTIONS` from SKILL.md at build time, or at minimum add a comment cross-referencing both files so maintainers know to update them in tandem. A shared "capabilities" data structure could also feed both outputs.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Repeated "Unknown agent" error message pattern** - `src/cli/commands/init.ts:202`, `src/cli/commands/init.ts:184`
**Confidence**: 85%
- Problem: The error message template `Unknown agent: "${x}". Available agents: ${AGENT_PROVIDERS.join(', ')}` appears 8 times across the CLI codebase (`init.ts`, `cli.ts`, `agents.ts`, `schedule.ts`, `pipeline.ts`, `loop.ts`, `orchestrate.ts`). The new code in `init.ts` adds two more instances (lines 184 and 202). This is a prime candidate for a shared utility function.
- Fix: Extract a utility function in `src/core/agents.ts` (where `AGENT_PROVIDERS` already lives):
  ```typescript
  export function unknownAgentError(agent: string): string {
    return `Unknown agent: "${agent}". Available agents: ${AGENT_PROVIDERS.join(', ')}`;
  }
  ```
  Then replace all 8+ callsites. This is pre-existing technical debt, but the two new usages in this branch make it worth addressing now.

## Pre-existing Issues (Not Blocking)

### LOW

**`fileURLToPath(import.meta.url)` for package root resolution in two places** - `src/cli.ts:35`, `src/cli/commands/init.ts:109`
**Confidence**: 65%
- Problem: Both `cli.ts` and `init.ts` independently derive filesystem paths from `import.meta.url` using `fileURLToPath`. The `resolveSkillSource()` function in `init.ts` navigates `../../..` from the current file to reach the package root, and `cli.ts` does `dirname(fileURLToPath(...))` for `__dirname`. A shared `resolvePackageRoot()` utility could eliminate the fragile relative path navigation.
- Mitigation: These are used for different purposes (one for `__dirname` equivalence, one for locating the skills directory), so the duplication is mild.

## Suggestions (Lower Confidence)

- **`p.isCancel` / `p.confirm` wrapper pattern** - `src/cli/commands/init.ts:391,401,414,430,445` (Confidence: 68%) -- The pattern of calling a `@clack/prompts` function, checking `p.isCancel`, and returning `'cancelled'` or the boolean result appears 5 times in `createDefaultDeps()`. A helper like `confirmOrCancel(opts)` could reduce the boilerplate. However, each call has slightly different options, so the abstraction may not be worth it yet.

- **`makeSkillDeps` test helper could compose more explicitly** - `tests/unit/cli-init.test.ts:47-55` (Confidence: 62%) -- `makeSkillDeps` is a good compositional helper built on top of `makeDeps`. However, some tests override `copySkills` in the `makeSkillDeps` call while it already has a default. This is fine functionally but could benefit from a brief comment noting that `makeSkillDeps` is the "fully-wired" variant of `makeDeps`.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 1 |

**Code Reuse Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Verdict

The branch introduces well-structured new functionality with good DI patterns and test coverage. The primary code reuse concern is the 8+ repetitions of the "Unknown agent" error message -- extracting that into `src/core/agents.ts` would be a quick win. The content overlap between `mcp-instructions.ts` and `SKILL.md` is worth flagging but acceptable given they serve different distribution channels. No new utility functions duplicate existing ones; `getSkillTargetDirs`, `defaultSkillsExist`, `defaultCopySkills`, `parseSkillsAgents`, and `resolveSkillSource` are all genuinely new functionality with no existing equivalents in the codebase.
