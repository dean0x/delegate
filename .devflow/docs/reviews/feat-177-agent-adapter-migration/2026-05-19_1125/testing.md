# Testing Review Report

**Branch**: feat/177-agent-adapter-migration -> main
**Date**: 2026-05-19

## Issues in Your Changes (BLOCKING)

### HIGH

**Missing error path test for buildTmuxCommand when CLI not in PATH** - `tests/unit/implementations/build-tmux-command.test.ts`
**Confidence**: 85%
- Problem: The `buildTmuxCommand()` method calls `this.resolveSpawnConfig(options)` which checks `isCommandInPath()`. When the CLI binary is not found, it returns an error. The `agent-adapters.test.ts` file thoroughly tests this error path for `spawn()` (e.g., "should fail spawn when CLI not in PATH"), but the new `build-tmux-command.test.ts` does not include an equivalent negative test for `buildTmuxCommand()`. Since buildTmuxCommand shares resolveSpawnConfig with spawn, this is a behavioral gap -- a user calling buildTmuxCommand when the CLI is missing would get an error, and there is no test asserting the error code/message for that scenario.
- Fix: Add a test in the `buildTmuxCommand() -- ClaudeAdapter` or `CodexAdapter` section:
```typescript
it('returns err when CLI not in PATH', () => {
  mockIsCommandInPath.mockReturnValue(false);
  const adapter = new ClaudeAdapter(testConfig);
  const result = adapter.buildTmuxCommand(baseOptions);
  
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe(ErrorCode.AGENT_MISCONFIGURED);
  expect(result.error.message).toContain('not found in PATH');
  adapter.dispose();
});
```

**Missing test for CodexAdapter tmux model passthrough** - `tests/unit/implementations/build-tmux-command.test.ts`
**Confidence**: 82%
- Problem: ClaudeAdapter has a test for `with model: config.agentArgs includes --model <value>` (line 209), but CodexAdapter's `buildTmuxCommand()` section has no equivalent model test. The `buildTmuxArgs()` implementation for CodexAdapter (codex-adapter.ts:26) includes model handling (`const modelArgs: string[] = model ? ['--model', model] : [];`), so this is a real behavioral path that lacks test coverage.
- Fix: Add to the `buildTmuxCommand() -- CodexAdapter` describe block:
```typescript
it('with model: config.agentArgs includes --model <value>', () => {
  const result = adapter.buildTmuxCommand({ ...baseOptions, model: 'gpt-4o' });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const args = result.value.config.agentArgs;
  const modelIndex = args.indexOf('--model');
  expect(modelIndex).toBeGreaterThanOrEqual(0);
  expect(args[modelIndex + 1]).toBe('gpt-4o');
});
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**No adapter.dispose() call in two return-shape tests** - `tests/unit/implementations/build-tmux-command.test.ts:78-104`
**Confidence**: 85%
- Problem: The `buildTmuxCommand() return shape` describe block creates adapters with `new ClaudeAdapter(testConfig)` in each test but never calls `adapter.dispose()`. Unlike the per-adapter describe blocks (lines 109-265), which use `beforeEach`/`afterEach` for setup/teardown, these tests create and abandon adapters. While the `killTimeouts` map in BaseAgentAdapter is empty for these tests (no process spawned), this inconsistency could mask resource leaks if future adapter constructors acquire resources.
- Fix: Either add `afterEach` cleanup in the describe block, or inline `adapter.dispose()` at the end of each test body (consistent with the ProxiedClaudeAdapter tests which call `adapter.dispose()` per-test).

## Pre-existing Issues (Not Blocking)

_No pre-existing CRITICAL issues found._

## Suggestions (Lower Confidence)

- **Missing baseUrl/proxy env injection test for buildTmuxCommand** - `tests/unit/implementations/build-tmux-command.test.ts` (Confidence: 70%) -- The agent-adapters.test.ts file has extensive baseUrl passthrough tests for spawn(), but buildTmuxCommand has only the ProxiedClaudeAdapter env test. A direct baseUrl-from-config test for the tmux path would increase confidence in env assembly parity.

- **No negative test for CodexAdapter tmux with ollama runtime** - `tests/unit/implementations/build-tmux-command.test.ts` (Confidence: 65%) -- The ClaudeAdapter section tests ollama runtime integration (line 252), but CodexAdapter does not. Since both adapters share the runtime resolution path via BaseAgentAdapter, one test may be sufficient, but coverage could be strengthened.

- **Performance tests use timing assertions** - `tests/unit/implementations/database.test.ts:268,293` (Confidence: 60%) -- The `expect(duration).toBeLessThan(100)` and `expect(duration).toBeLessThan(50)` assertions are timing-sensitive and could be flaky on slow CI machines or under load. These are pre-existing tests (not added in this PR), noted for awareness.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 0 | - |
| Should Fix | - | 0 | 1 | - |
| Pre-existing | - | - | 0 | 0 |

**Testing Score**: 8/10
**Recommendation**: CHANGES_REQUESTED

### Overall Assessment

The test changes in this PR are well-structured and thorough. Key positives:

1. **New `build-tmux-command.test.ts`** (413 lines, 30 tests) -- Comprehensive coverage of the new `buildTmuxCommand()` method across Claude, Codex, ProxiedClaude, and ProcessSpawnerAdapter. Tests follow the project's established pattern of Result-type assertions with early-return guards. The unsupported-provider guard test using a FakeAdapter subclass is a strong boundary test.

2. **Migration v28 tests** (6 tests) -- Properly validates the CHECK constraint change at the database level, covering positive (claude, codex, NULL) and negative (gemini) cases, plus index and column preservation verification.

3. **Gemini removal cleanup** -- All Gemini references removed consistently across ~25 test files. Test assertions updated from 3-provider to 2-provider expectations. No orphaned Gemini test doubles or fixtures remain.

4. **Connector agentArgs forwarding** (2 tests) -- Verifies the key behavioral change: `TmuxConnector.spawn()` now passes `config.agentArgs` to `hooks.generateWrapper` instead of hardcoded `[]`.

5. **Test quality** -- Tests focus on behavior (CLI args produced, env vars set, error codes returned) rather than implementation. Proper AAA structure. Dependency injection through config isolation (`_testSetConfigDir`). Consistent teardown with `dispose()` and `rmSync()`.

The two HIGH findings are genuine coverage gaps for the new `buildTmuxCommand()` feature -- error path testing and Codex model passthrough parity with Claude.
