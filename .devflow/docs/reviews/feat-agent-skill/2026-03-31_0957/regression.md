# Regression Review Report

**Branch**: feat-agent-skill -> main
**Date**: 2026-03-31
**Commits**: 2 (a4a1775 feat: add agent orchestration skill and skill installer, 498049b style: fix pre-existing biome lint and format issues)

## Issues in Your Changes (BLOCKING)

### CRITICAL

No critical issues found.

### HIGH

No high issues found.

## Issues in Code You Touched (Should Fix)

No issues found.

## Pre-existing Issues (Not Blocking)

No issues found.

## Suggestions (Lower Confidence)

- **Duplicate skill-path display blocks in `initCommand`** - `src/cli/commands/init.ts:477-482` and `src/cli/commands/init.ts:488-493` (Confidence: 65%) -- The interactive and non-interactive branches of `initCommand` have identical `skillPaths` rendering blocks. This is not a regression but a duplication smell; extracting a helper would reduce future maintenance risk if the display format changes and only one branch is updated. Not blocking since both branches are tested and behavior is correct.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Regression Score**: 9/10
**Recommendation**: APPROVED

## Analysis Details

### What Changed

1. **New skill files** (`skills/autobeat/`): 6 new markdown documentation files (SKILL.md plus 5 reference docs). Pure additive, no runtime code -- zero regression risk.

2. **`package.json`**: Added `"skills"` to the `files` array. This ensures the `skills/` directory is included in the npm package. Verified that existing entries (`dist`, `README.md`, `LICENSE`) are unchanged. No risk to existing package consumers since the directory is additive.

3. **`src/adapters/mcp-adapter.ts`**: Added `instructions: MCP_INSTRUCTIONS` to the MCP Server constructor's `InitializeResult`. The `instructions` field is an optional string in the MCP SDK spec -- adding it does not change existing tool behavior. All 99 adapter tests pass.

4. **`src/adapters/mcp-instructions.ts`**: New file exporting a constant string. No side effects, no state mutation.

5. **`src/cli/commands/init.ts`**: Extended with skill install capability:
   - New types: `skillPaths` on `InitResult`, `installSkills`/`skillsAgents` on `InitOptions`, 5 new optional deps on `InitDeps`.
   - New functions: `resolveSkillSource`, `getSkillTargetDirs`, `defaultSkillsExist`, `defaultCopySkills`, `parseSkillsAgents`, `runSkillInstall`.
   - Existing `runInit` gains two new insertion points (non-interactive and interactive paths).
   - New CLI flags: `--install-skills`, `--skills-agents`.
   - All new deps are **optional** (`?` suffix), so existing callers with no skill deps continue to work identically -- the skill install path is skipped.
   - `initCommand` display code extended with skill path output in both interactive and non-interactive branches.

6. **Test changes in `tests/unit/cli.test.ts`, `agent-exit-condition-evaluator.test.ts`, `composite-exit-condition-evaluator.test.ts`, `loop-manager.test.ts`**: These are purely **formatting/style** changes from the second commit (biome lint fixes). Import reordering, array flattening, object literal reformatting. No behavioral changes. All tests pass.

7. **`tests/unit/cli-init.test.ts`**: 15 new test cases covering all skill install branches (interactive install, cancel, decline, update, multi-agent, error; non-interactive install, explicit agents, invalid agents, no flag, auto-update with --yes). Coverage appears thorough.

### Regression Risk Assessment

| Area | Risk | Rationale |
|------|------|-----------|
| Existing `beat init` flow (no skill flags) | None | All new `InitDeps` fields are optional; existing code paths untouched |
| Existing MCP tool behavior | None | `instructions` is additive to InitializeResult; tool handlers unchanged |
| Existing test behavior | None | Style-only reformatting; all 425 affected tests pass |
| npm package size | Low | `skills/` directory adds ~30KB of markdown docs |
| `resolveSkillSource` path resolution | Low | Uses `import.meta.url` + relative traversal; works from both `dist/` and `src/` |

### Test Verification

All test suites for affected files were executed and pass:

- `tests/unit/cli-init.test.ts`: **46 passed** (15 new + 31 existing)
- `tests/unit/cli.test.ts`: **205 passed** (formatting only, all existing)
- `tests/unit/adapters/mcp-adapter.test.ts`: **99 passed** (all existing)
- `tests/unit/services/agent-exit-condition-evaluator.test.ts`: **20 passed** (formatting only)
- `tests/unit/services/composite-exit-condition-evaluator.test.ts`: **4 passed** (formatting only)
- `tests/unit/services/loop-manager.test.ts`: **51 passed** (formatting only)
- Build: **TypeScript compilation succeeds** with no errors
