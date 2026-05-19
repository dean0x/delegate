# Complexity Review Report

**Branch**: feat-agent-skill -> main
**Date**: 2026-03-31T09:57

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Duplicated skill-path display logic in `initCommand`** - `src/cli/commands/init.ts:472-495`
**Confidence**: 90%
- Problem: The interactive and non-interactive branches of `initCommand` contain an identical 5-line block for displaying installed skill paths (lines 477-482 and 488-493). The only difference between the two branches is the final output call (`ui.outro` vs `ui.success`). This copy-paste duplication increases maintenance surface and is a complexity smell.
- Fix: Extract the shared skill-path display into a helper, then call it before the branch:
```typescript
if ('agent' in result) {
  if (result.status.hint) {
    ui.info(result.status.hint);
  }
  if (result.skillPaths && result.skillPaths.length > 0) {
    ui.success('Agent skills installed:');
    for (const skillPath of result.skillPaths) {
      ui.step(`  ${skillPath}`);
    }
  }
  if (isInteractive) {
    ui.outro(`Default agent set to '${result.agent}'. Config: ${CONFIG_FILE_PATH}`);
  } else {
    ui.success(`Default agent set to '${result.agent}'`);
  }
}
```

**`runSkillInstall` has high cyclomatic complexity (11 branches)** - `src/cli/commands/init.ts:272-342`
**Confidence**: 82%
- Problem: The `runSkillInstall` function has 11 branching points across 70 lines: 4-way `if/else if` for agent selection, nested `if` for cancellation and falsy checks inside the interactive branch, a nested `if/else if` for the existing-skills-update flow, and final guards for missing `copySkills` and error handling. While each individual branch is straightforward, the combined cyclomatic complexity is elevated for a single function. The deepest nesting is 3 levels (line 317-328: `if skillsExist -> if yes / else if confirmSkillUpdate -> if cancelled / if !updateResult`).
- Fix: Consider splitting into two functions -- one for resolving the target agent list (the first `if/else if` chain), and one for the copy-with-update-check flow. This would reduce each function to ~5 branches. However, this is a should-fix, not blocking, given the clear comments and early returns that keep readability reasonable.

## Issues in Code You Touched (Should Fix)

_None identified._

## Pre-existing Issues (Not Blocking)

_None identified._

## Suggestions (Lower Confidence)

- **`InitDeps` interface has 10 members, 5 optional** - `src/cli/commands/init.ts:39-54` (Confidence: 65%) -- The interface has grown to 10 fields with 5 optional members for skill installation. This is approaching the threshold where a sub-interface (e.g., `SkillInstallDeps`) could reduce cognitive load, but the current design works because optional members clearly delineate the skill-install capability.

- **`runInit` return type complexity** - `src/cli/commands/init.ts:22-30` (Confidence: 62%) -- The `InitResult` discriminated union now has 3 variants, and the success variant carries an optional `skillPaths`. The consumer in `initCommand` uses `'agent' in result` and `'skillPaths' in result` type narrowing. This works but could be simplified with a more explicit discriminant (e.g., a `type: 'success' | 'cancelled' | 'error'` field). Low priority since the current approach is idiomatic TypeScript.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Complexity Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Rationale

The PR adds an agent orchestration skill system with skill-installer integration into the `beat init` CLI command. The vast majority of the changeset (1,491 of 2,368 lines) is static Markdown documentation/reference files in `skills/autobeat/` which carry zero runtime complexity. The new `mcp-instructions.ts` is a single exported string constant -- also zero complexity.

The actual logic changes are concentrated in `src/cli/commands/init.ts` (+278 lines) and its tests (+305 lines). The architecture follows the project's established dependency-injection pattern with `InitDeps`, making the new skill-install flow fully testable without mocks. The `runSkillInstall` function is the most complex addition at ~11 branches, but uses early returns consistently and has clear section comments. The test coverage is thorough with 24 new test cases covering interactive, non-interactive, cancellation, update, and error paths.

The two MEDIUM findings (duplicated display logic and elevated cyclomatic complexity in `runSkillInstall`) are real but non-blocking. The duplication is a 5-line copy that is easy to extract. The cyclomatic complexity is at the upper end of acceptable for a CLI flow function with multiple user-interaction paths. Neither warrants blocking the merge.

Overall, this is a well-structured addition that respects the existing patterns and keeps complexity proportional to the feature scope.
