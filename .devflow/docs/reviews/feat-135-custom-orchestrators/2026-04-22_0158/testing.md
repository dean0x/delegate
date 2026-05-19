# Testing Review Report

**Branch**: feat-135-custom-orchestrators -> main
**Date**: 2026-04-22

## Issues in Your Changes (BLOCKING)

### MEDIUM

**No test for snippet-vs-prompt content drift** - `tests/unit/services/orchestrator-prompt-snippets.test.ts`
**Confidence**: 85%
- Problem: The three new snippet builders (`buildDelegationInstructions`, `buildStateManagementInstructions`, `buildConstraintInstructions`) produce text that is intentionally similar to — but not derived from — the text inside `buildOrchestratorPrompt`. The DECISION comment (orchestrator-prompt.ts:12-14) acknowledges this design: "no risk of output drift." However, there is no test that asserts the snippet builders remain semantically consistent with the corresponding sections inside `buildOrchestratorPrompt`. If either side is edited independently in the future, the two paths will diverge silently. The non-regression test at line 141 only checks that `buildOrchestratorPrompt` still works; it does not compare snippet builder output against the main prompt builder output.
- Fix: Add a test that extracts the WORKER MANAGEMENT / STATE FILE / CONSTRAINTS sections from `buildOrchestratorPrompt().systemPrompt` and asserts key lines also appear in the corresponding snippet builder output. This does not need to be character-identical — checking shared structural markers (e.g., `beat run`, `beat status`, `STATE FILE:`, `Max concurrent workers`) in both outputs would catch accidental drift.

```typescript
it('delegation snippet shares key content with buildOrchestratorPrompt systemPrompt', () => {
  const { systemPrompt } = buildOrchestratorPrompt(params);
  const snippet = buildDelegationInstructions({ agent: undefined, model: undefined });
  // Both should contain the same core CLI commands
  for (const marker of ['beat run', 'beat status', 'beat logs', 'beat cancel', 'AGENT EVAL MODE']) {
    expect(systemPrompt).toContain(marker);
    expect(snippet).toContain(marker);
  }
});
```

**MCP adapter test does not cover scaffoldCustomOrchestrator failure path** - `tests/unit/adapters/init-custom-orchestrator.test.ts`
**Confidence**: 82%
- Problem: The `handleInitCustomOrchestrator` method in `mcp-adapter.ts` has three error branches: (1) Zod validation failure, (2) `validatePath` failure, (3) `scaffoldCustomOrchestrator` returning `err()`. The test suite covers branches 1 and 2 but not branch 3 (lines 3282-3292 of mcp-adapter.ts). If `scaffoldCustomOrchestrator` fails due to I/O errors (e.g., disk full, permissions), the test suite does not verify the adapter returns `isError: true` with the correct error message format.
- Fix: Add a test that forces `scaffoldCustomOrchestrator` to return an error. Since the test already mocks `getStateDir`, one approach is to mock `writeStateFile` to throw, then verify the adapter catches and returns the error.

```typescript
it('returns error when scaffold fails (I/O error)', async () => {
  // Mock writeStateFile to throw for this test
  const writeStateFile = await import('../../../src/core/orchestrator-state.js');
  const spy = vi.spyOn(writeStateFile, 'writeStateFile').mockImplementation(() => {
    throw new Error('ENOSPC: no space left on device');
  });

  const response = await adapter.callTool('InitCustomOrchestrator', { goal: 'Test goal' });

  expect(response.isError).toBe(true);
  const body = JSON.parse(response.content[0].text);
  expect(body.success).toBe(false);
  expect(body.error).toContain('no space left');

  spy.mockRestore();
});
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**handleOrchestrateInit CLI handler has no test coverage** - `src/cli/commands/orchestrate.ts:578-639`
**Confidence**: 83%
- Problem: The new `handleOrchestrateInit` function (lines 578-639) covers path validation, scaffolding, and formatted output to stdout. Only `parseOrchestrateInitArgs` (the arg parsing function) is tested in `orchestrate-init.test.ts`. The handler itself — which calls `validatePath`, `scaffoldCustomOrchestrator`, and writes formatted output — has zero test coverage. This is consistent with how other handlers (`handleOrchestrateStatus`, `handleOrchestrateCancel`) are also untested, but since `init` is a new addition and has non-trivial logic (path validation + error branches + formatted output), it would benefit from at least a smoke test.
- Fix: This follows the existing pattern in the codebase where CLI handlers are not unit-tested directly (only their arg parsers are). If this is an accepted pattern, this is informational. If handler-level testing is desired, a test using `vi.spyOn(process.stdout, 'write')` and the mock for `getStateDir` would cover the success path.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Scaffold test skips error branch intentionally (comment at line 186-189)** - `tests/unit/core/orchestrator-scaffold.test.ts:185-193`
**Confidence**: 85%
- Problem: The test at line 185 ("returns a Result object (never throws)") only verifies the happy path and explicitly comments that the error branch is avoided because "vitest's isolate:false config causes doMock() to pollute the module cache across files." This is a legitimate constraint, but it means the `tryCatch` error wrapping in `scaffoldCustomOrchestrator` (lines 58-82 of orchestrator-scaffold.ts) is never exercised. The function's primary design guarantee — "any internal error must be caught and returned as err(Error)" — is untested.
- Fix: Consider testing the error path in the MCP adapter test (init-custom-orchestrator.test.ts) instead, where the mock is already set up via `vi.mock` at the file level. Alternatively, a dedicated test file with its own `vi.mock` setup (not `vi.doMock`) could exercise this path without the module cache pollution issue.

## Suggestions (Lower Confidence)

- **Redundant "tool listing" test** - `tests/unit/adapters/init-custom-orchestrator.test.ts:237-247` (Confidence: 65%) -- The "InitCustomOrchestrator appears in tools list" test just repeats the happy-path call and checks it doesn't return INVALID_TOOL. The comment acknowledges this ("tested indirectly"). Consider removing this test or replacing it with a direct tools/list assertion if the pattern becomes available.

- **CLI init test could verify flag ordering edge cases** - `tests/unit/cli/orchestrate-init.test.ts` (Confidence: 62%) -- The combined flags test (line 195) only tests goal-first ordering. There is no test for flags-before-goal ordering (e.g., `['-a', 'claude', 'Build auth']`). The parser supports this because goal words are collected from non-flag positional args, but it is not tested.

- **State file cleanup not tested in scaffold tests** - `tests/unit/core/orchestrator-scaffold.test.ts` (Confidence: 60%) -- The scaffold creates files in a temp directory but does not verify that multiple calls accumulate files (a user-facing concern mentioned in the docs at line 271). This is a very minor edge case and likely not worth testing.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Testing Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The test suite for this PR is well-structured and follows project conventions. Four test files totaling 883 lines cover the three new modules (scaffold, snippet builders, MCP tool, CLI arg parsing). Tests follow AAA structure, use real temp directories for I/O verification, and avoid brittle implementation-coupling. The blocking items are the missing drift-detection test between snippet builders and the main prompt builder, and the untested error branch in the MCP adapter handler. Neither is a show-stopper but both represent behavioral coverage gaps in newly introduced code.
