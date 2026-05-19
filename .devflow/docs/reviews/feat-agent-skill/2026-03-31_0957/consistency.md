# Consistency Review Report

**Branch**: feat-agent-skill -> main
**Date**: 2026-03-31T09:57

## Issues in Your Changes (BLOCKING)

### HIGH

**Variable `p` shadows module-level import `* as p from '@clack/prompts'`** - `src/cli/commands/init.ts:479`, `src/cli/commands/init.ts:490`
**Confidence**: 90%
- Problem: The file imports `* as p from '@clack/prompts'` on line 9. The new `for (const p of result.skillPaths)` loop variable on lines 479 and 490 shadows the module-level `p` binding. While the loop body only uses `p` as a string (not calling `p.confirm` etc.), this creates a naming collision with the `@clack/prompts` namespace. If anyone later adds clack prompt calls inside this block, the shadowed variable will cause a confusing runtime error. Other files in the codebase (e.g., `src/cli/commands/agents.ts:133`) also use `for (const p of providers)` but that file does not import `@clack/prompts` as `p`.
- Fix: Rename the loop variable to `skillPath` to avoid shadowing:
  ```typescript
  for (const skillPath of result.skillPaths) {
    ui.step(`  ${skillPath}`);
  }
  ```

### MEDIUM

**Duplicated skill-paths display block in `initCommand`** - `src/cli/commands/init.ts:477-482`, `src/cli/commands/init.ts:488-493`
**Confidence**: 85%
- Problem: The exact same 5-line block for displaying installed skill paths is copy-pasted between the interactive and non-interactive branches of `initCommand`. The existing code in this function already distinguishes the two branches only by their final call (`ui.outro` vs `ui.success`), but the skill display logic is identical. This violates DRY and is inconsistent with how other display logic in this file is structured (e.g., `result.status.hint` display is also duplicated, but was pre-existing).
- Fix: Extract into a helper or move the shared block above the `if (isInteractive)` branch:
  ```typescript
  if ('agent' in result) {
    // Shared display logic
    if (result.status.hint) {
      ui.info(result.status.hint);
    }
    if (result.skillPaths && result.skillPaths.length > 0) {
      ui.success('Agent skills installed:');
      for (const skillPath of result.skillPaths) {
        ui.step(`  ${skillPath}`);
      }
    }
    // Branch-specific ending
    if (isInteractive) {
      ui.outro(`Default agent set to '${result.agent}'. Config: ${CONFIG_FILE_PATH}`);
    } else {
      ui.success(`Default agent set to '${result.agent}'`);
    }
  }
  ```

**`parseSkillsAgents` returns union `readonly AgentProvider[] | string` instead of project `Result` type** - `src/cli/commands/init.ts:175`
**Confidence**: 82%
- Problem: The project has a canonical `Result<T, E>` type in `src/core/result.ts` with `ok`/`err` constructors. Other CLI command files (`loop.ts`, `schedule.ts`, `orchestrate.ts`) all use `Result<T, E>` for their parsing functions. The new `parseSkillsAgents` returns a raw union type (`readonly AgentProvider[] | string`) and the caller discriminates with `typeof parsed === 'string'`. This is inconsistent with the established pattern and the project's explicit engineering principle "Always use Result types."
- Fix: Use the project's `Result` type:
  ```typescript
  import { type Result, ok, err } from '../../core/result.js';

  export function parseSkillsAgents(value: string): Result<readonly AgentProvider[], string> {
    const parts = value.split(',').map((s) => s.trim()).filter(Boolean);
    for (const part of parts) {
      if (!isAgentProvider(part)) {
        return err(`Unknown agent in --skills-agents: "${part}". Available: ${AGENT_PROVIDERS.join(', ')}`);
      }
    }
    return ok(parts as AgentProvider[]);
  }
  ```
  And update the caller:
  ```typescript
  const parsed = parseSkillsAgents(options.skillsAgents);
  if (!parsed.ok) {
    return { code: 1, reason: parsed.error };
  }
  agents = parsed.value;
  ```

**`defaultCopySkills` uses ad-hoc `{ ok: true/false }` shape instead of project `Result` type** - `src/cli/commands/init.ts:148-170`
**Confidence**: 80%
- Problem: The function returns `{ ok: true; paths: readonly string[] } | { ok: false; error: string }`. While structurally similar to `Result`, it is not using the project's `Result<T, E>` type and its `ok()`/`err()` constructors. The `saveConfig` dependency already uses a similar ad-hoc shape (`{ ok: true } | { ok: false; error: string }`), which is a pre-existing inconsistency. However, the new code adds more surface area with this same ad-hoc pattern rather than aligning with the canonical type. Note: since this function returns `paths` as a property (not `value`), it cannot directly use `Result<readonly string[], string>` without a structural change -- this is a design choice that deviates from the codebase norm but may be intentional for the DI boundary.
- Fix: Consider using `Result<readonly string[], string>` and accessing `result.value` at the call site. Alternatively, document why the ad-hoc shape is preferred here (DI interface boundary).

## Issues in Code You Touched (Should Fix)

_None identified._

## Pre-existing Issues (Not Blocking)

### LOW

**Hint display block already duplicated pre-PR** - `src/cli/commands/init.ts:474-476`, `src/cli/commands/init.ts:485-487`
**Confidence**: 85%
- Problem: The `result.status.hint` display logic was already duplicated between the interactive and non-interactive branches before this PR. The new skill-paths block compounds the duplication.
- Fix: If refactoring the skill-paths display, consolidate the hint display at the same time (see MEDIUM finding above).

## Suggestions (Lower Confidence)

- **`MCP_INSTRUCTIONS` as a template literal with no dynamic content** - `src/adapters/mcp-instructions.ts:8` (Confidence: 65%) -- The instructions string is a static template literal but could be a plain string constant. The escaped backtick on line 22 (`\`continueFrom\``) suggests template literal was chosen for readability but using a plain string with `\`` would also work and avoid accidental interpolation risk. Minor preference.

- **Skill documentation references `OrchestratorStatus` with `orchestrationId` param name** - `skills/autobeat/references/monitoring.md:62` (Confidence: 70%) -- The MCP instructions use `orchestrationId` but the capability-matrix uses `orchestratorId`. Verify which parameter name the actual schema expects.

- **Test utility `makeSkillDeps` duplicates most of `makeDeps`** - `tests/unit/cli-init.test.ts:228-236` (Confidence: 62%) -- Minor: `makeSkillDeps` wraps `makeDeps` with overrides, which is a reasonable pattern. However, it defaults `selectSkillAgents` to always return `['claude']` which may not match all test scenarios. This is a test-only concern.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 3 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | - | 0 | 1 |

**Consistency Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The PR introduces a well-structured skill installer feature with good dependency injection and test coverage. The main consistency concerns are: (1) a variable shadowing the `@clack/prompts` namespace import `p`, (2) code duplication in the display logic, and (3) deviation from the project's canonical `Result<T, E>` type in two new functions. The skill documentation files are well-organized and consistent with each other internally. The formatting changes in test files (biome lint fixes) are consistent with project style enforcement.
