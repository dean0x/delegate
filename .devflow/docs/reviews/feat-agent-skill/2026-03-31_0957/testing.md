# Testing Review Report

**Branch**: feat-agent-skill -> main
**Date**: 2026-03-31

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

### MEDIUM

**No unit tests for exported utility functions in init.ts** - `src/cli/commands/init.ts:109-186`
**Confidence**: 85%
- Problem: Five new exported functions were added (`resolveSkillSource`, `getSkillTargetDirs`, `defaultSkillsExist`, `defaultCopySkills`, `AGENT_SKILL_DIRS` constant) but none have direct unit tests. The test file `cli-init.test.ts` thoroughly tests the high-level `runInit()` flow by injecting mock `copySkills`/`skillsExist` deps, which is good for integration coverage. However, the exported pure functions (`getSkillTargetDirs`, `parseSkillsAgents`) and the `AGENT_SKILL_DIRS` mapping are exercised only indirectly through production default deps, and `resolveSkillSource`/`defaultCopySkills`/`defaultSkillsExist` have zero test coverage since the tests always inject stubs.
- Fix: Add a dedicated describe block for the utility functions. `getSkillTargetDirs` and `AGENT_SKILL_DIRS` are pure and trivially testable:
  ```ts
  describe('getSkillTargetDirs', () => {
    it('should deduplicate .agents/ when codex and gemini both selected', () => {
      const dirs = getSkillTargetDirs(['codex', 'gemini'], '/project');
      // codex -> .agents/, gemini -> .gemini/ + .agents/
      // .agents/ should appear only once
      expect(dirs.filter(d => d.includes('.agents/'))).toHaveLength(1);
      expect(dirs).toHaveLength(2); // .agents/ and .gemini/
    });
  });
  ```
  `resolveSkillSource` and `defaultCopySkills` touch the filesystem, so those are better tested in integration, but at minimum `getSkillTargetDirs` and the deduplication logic deserve direct unit tests since they encode correctness-critical mapping rules.

**No test coverage for MCP_INSTRUCTIONS or `instructions` field in adapter** - `src/adapters/mcp-adapter.ts:403`, `src/adapters/mcp-instructions.ts`
**Confidence**: 82%
- Problem: A new `instructions` field was added to the MCP InitializeResult in `mcp-adapter.ts`, and a new 79-line `MCP_INSTRUCTIONS` constant was created. The adapter test file has 99 tests but none verify that the `instructions` field is set on the server's initialize response. This is a user-facing behavioral change (MCP clients will now receive instructions during initialization).
- Fix: Add a test in `mcp-adapter.test.ts` that verifies the MCP server passes instructions:
  ```ts
  it('should include instructions in MCP initialization', () => {
    // Verify the MCP server is initialized with instructions
    expect(MCP_INSTRUCTIONS).toBeTruthy();
    expect(typeof MCP_INSTRUCTIONS).toBe('string');
    expect(MCP_INSTRUCTIONS.length).toBeGreaterThan(100);
  });
  ```
  Alternatively, if the test infrastructure allows inspection of the Server constructor args, verify `instructions` is a non-empty string.

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **`parseSkillsAgents` returns a union type (string | array) instead of Result** - `src/cli/commands/init.ts:175` (Confidence: 65%) -- The project uses Result types consistently (per CLAUDE.md guidelines), but `parseSkillsAgents` returns `string | AgentProvider[]` as a poor-man's Result. The tests handle this correctly via `typeof result === 'string'`, but it is inconsistent with the project's Result pattern. Low priority since it is an internal function.

- **No edge case test for `parseSkillsAgents` with empty string input** - `tests/unit/cli-init.test.ts` (Confidence: 62%) -- The `parseSkillsAgents` tests cover valid inputs, unknown agents, and `''`-filtering in `"claude,,codex"`, but do not test a fully empty string input `parseSkillsAgents('')`. The `.filter(Boolean)` handles it, but explicit coverage would prevent regression.

- **Duplicated skill-path display logic in `initCommand`** - `src/cli/commands/init.ts:477-482,488-493` (Confidence: 68%) -- The interactive and non-interactive branches of `initCommand` duplicate the exact same 5-line block for displaying installed skill paths. This is not a test issue directly, but the lack of tests for `initCommand` means this duplication cannot regress under test protection.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Testing Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The new test coverage is well-structured and follows excellent patterns:
- 46 tests for `cli-init.test.ts` (up from prior count), covering interactive, non-interactive, cancellation, error, and multi-agent skill install flows
- Dependency injection via `InitDeps` avoids brittle `vi.mock()` -- clean and maintainable
- Good behavioral coverage of the `runInit()` orchestration logic
- The `parseSkillsAgents` and `parseInitArgs` tests are thorough for the new flags

The two MEDIUM findings are about coverage gaps for newly exported utility functions and the MCP instructions integration. Neither is blocking since the high-level behavioral tests provide indirect coverage, but direct unit tests for `getSkillTargetDirs` deduplication logic and an adapter-level test for `instructions` would strengthen confidence.

Changes to existing test files (`cli.test.ts`, `composite-exit-condition-evaluator.test.ts`, `loop-manager.test.ts`, `agent-exit-condition-evaluator.test.ts`) are purely formatting/style fixes (biome lint) with no behavioral changes -- verified safe.
