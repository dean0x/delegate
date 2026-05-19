# TypeScript Review Report

**Branch**: feat-agent-skill -> main
**Date**: 2026-03-31T09:57

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

**Variable shadowing: `p` shadows imported `@clack/prompts` namespace** - `src/cli/commands/init.ts:479,490`
**Confidence**: 90%
- Problem: The `for (const p of result.skillPaths)` loop variable `p` shadows the top-level import `import * as p from '@clack/prompts'` at line 9. This appears in two identical blocks (interactive and non-interactive branches at lines 479 and 490). While the shadowed import is not used within the loop body, this is fragile -- if someone adds a `p.log()` or `p.note()` call inside the loop during future maintenance, it would call `String.prototype` methods on a path string instead of `@clack/prompts` methods, causing a silent type error or runtime crash.
- Fix: Rename the loop variable to something unambiguous:
```typescript
for (const skillPath of result.skillPaths) {
  ui.step(`  ${skillPath}`);
}
```

### MEDIUM

**`let` used where control-flow narrowing could use `const` with early return** - `src/cli/commands/init.ts:280`
**Confidence**: 80%
- Problem: `let agents: readonly AgentProvider[]` is declared and then assigned through a multi-branch `if/else if/else` chain. Per project conventions (immutable by default, no mutations), this could be restructured to avoid `let`. The current code is correct but deviates from the codebase's preference for `const` everywhere.
- Fix: Extract the agent-determination logic into a helper that returns early from each branch:
```typescript
function resolveTargetAgents(
  defaultAgent: AgentProvider,
  options: InitOptions,
  deps: InitDeps,
): Promise<{ ok: true; agents: readonly AgentProvider[] } | { ok: false; result: ... }> { ... }
```
Alternatively, accept this as a pragmatic exception since the function already has clear control flow.

**Duplicated skill-path display blocks in `initCommand`** - `src/cli/commands/init.ts:477-482,488-493`
**Confidence**: 85%
- Problem: Two identical code blocks display skill paths in interactive vs non-interactive branches. This violates DRY and risks divergence if one is updated but not the other.
- Fix: Extract a helper function:
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
Then call `displaySkillPaths(result.skillPaths ?? [])` in both branches.

**`process.cwd()` called inside `runSkillInstall` rather than injected** - `src/cli/commands/init.ts:277`
**Confidence**: 82%
- Problem: `runSkillInstall` reads `process.cwd()` directly rather than receiving it as a parameter or through `InitDeps`. This is inconsistent with the function's otherwise excellent dependency injection pattern -- every other external interaction (`copySkills`, `skillsExist`, `confirmSkillInstall`) is injected via `deps`. Tests cannot verify the `projectRoot` behavior without actually being in a specific directory, though the current tests work around this because `copySkills` is mocked.
- Fix: Add `projectRoot` as a parameter or add a `getProjectRoot` function to `InitDeps`.

**`parseSkillsAgents` uses union return type instead of Result pattern** - `src/cli/commands/init.ts:175`
**Confidence**: 80%
- Problem: `parseSkillsAgents` returns `readonly AgentProvider[] | string`, where `string` represents an error message. The project convention (per CLAUDE.md) mandates Result types for business logic. The caller uses `typeof parsed === 'string'` as the discriminator, which is unusual and less type-safe than `parsed.ok`.
- Fix: Return `Result<readonly AgentProvider[], string>`:
```typescript
export function parseSkillsAgents(value: string): Result<readonly AgentProvider[], string> {
  // ...
  if (!isAgentProvider(part)) {
    return err(`Unknown agent: "${part}". Available: ${AGENT_PROVIDERS.join(', ')}`);
  }
  return ok(parts as AgentProvider[]);
}
```

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none -- style changes in cli.test.ts, agent-exit-condition-evaluator.test.ts, composite-exit-condition-evaluator.test.ts, and loop-manager.test.ts are formatting-only cleanups with no TypeScript concerns)

## Suggestions (Lower Confidence)

- **`runSkillInstall` return type could use a discriminated union** - `src/cli/commands/init.ts:276` (Confidence: 70%) -- The three-variant return type `{ code: 0; skillPaths } | { code: 0; reason } | { code: 1; reason }` relies on structural property checks (`'skillPaths' in result`) rather than a discriminant field. A `type: 'success' | 'skipped' | 'error'` tag would make exhaustive matching clearer.

- **`MCP_INSTRUCTIONS` string length is unconstrained** - `src/adapters/mcp-instructions.ts:8` (Confidence: 65%) -- The 79-line instruction string is injected into MCP InitializeResult. MCP spec does not specify a max length for instructions, but some MCP clients may truncate or fail on very large instruction payloads. Consider documenting the expected size constraint or adding a build-time assertion.

- **`AGENT_SKILL_DIRS` could derive from a single source of truth** - `src/cli/commands/init.ts:60-64` (Confidence: 60%) -- The mapping of agents to their skill directories is hardcoded. If a new agent is added to `AGENT_PROVIDERS`, this record would need manual updating. Consider using `satisfies Record<AgentProvider, ...>` (already done via the type annotation, but worth a compile-time completeness check if `AgentProvider` grows).

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 3 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**TypeScript Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The code is well-structured with excellent dependency injection, proper readonly annotations, and thorough test coverage (26+ new tests). The `InitDeps` interface pattern for testability is exemplary. The HIGH issue (variable shadowing of `p`) should be addressed before merge as it is a real maintenance hazard. The MEDIUM issues are style/convention items that would strengthen consistency with the project's established patterns.
