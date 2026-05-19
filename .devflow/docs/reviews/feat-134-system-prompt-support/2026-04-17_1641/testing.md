# Testing Review Report

**Branch**: feat-134-system-prompt-support -> main
**Date**: 2026-04-17T16:41

## Issues in Your Changes (BLOCKING)

### CRITICAL

**No tests for per-agent getSystemPromptConfig behavior (3 adapters)** -- Confidence: 95%
- `src/implementations/claude-adapter.ts:44-49`, `src/implementations/codex-adapter.ts:37-42`, `src/implementations/gemini-adapter.ts:52-110`
- Problem: The core feature -- per-agent system prompt injection -- has zero test coverage. `getSystemPromptConfig` is the behavioral pivot point of the entire feature. Each adapter declares a different injection strategy: Claude uses `--append-system-prompt` args, Codex uses `-c developer_instructions=<text>` args, and Gemini uses `GEMINI_SYSTEM_MD` env var with a file-write + fallback-to-prompt-prepend path. None of these are tested.
  - Claude: No test verifies `--append-system-prompt` appears in spawn args when `systemPrompt` is provided.
  - Codex: No test verifies `-c developer_instructions=<text>` appears in spawn args when `systemPrompt` is provided.
  - Gemini: No test verifies `GEMINI_SYSTEM_MD` env var injection, base-cache reading, combined file write, staleness warning, or the prependToPrompt fallback path (no cache found).
- Fix: Add tests to `tests/unit/implementations/agent-adapters.test.ts` following the existing `model passthrough` pattern. Example for Claude:
  ```typescript
  describe('system prompt passthrough', () => {
    it('ClaudeAdapter: should include --append-system-prompt in args when systemPrompt provided', () => {
      const mockChild = createMockChildProcess(1234);
      mockSpawn.mockReturnValue(mockChild);
      const adapter = new ClaudeAdapter(testConfig, 'claude');
      adapter.spawn({
        prompt: 'test prompt',
        workingDirectory: '/workspace',
        taskId: 'task-1',
        systemPrompt: 'You are a code reviewer',
      });
      const [, args] = mockSpawn.mock.calls[0];
      expect(args).toContain('--append-system-prompt');
      expect(args).toContain('You are a code reviewer');
      adapter.dispose();
    });
    // ... similar for Codex (-c developer_instructions=...) and Gemini (env var)
  });
  ```

**No tests for task-repository system_prompt persistence round-trip** -- Confidence: 95%
- `src/implementations/task-repository.ts:40,68,102,108,134,142-199,264,422`
- Problem: Migration v23 adds `system_prompt` column and the repository has been updated to save/read it. However, no tests verify that `systemPrompt` round-trips through save/findById. The existing `model field persistence` test suite (lines 305-370 in task-repository.test.ts) provides the exact template -- but `system_prompt` was not given equivalent coverage. Without this, a typo in the SQL parameter binding (`@systemPrompt` vs column `system_prompt`) would silently lose the system prompt on persist.
- Fix: Add a `system_prompt field persistence` describe block in `tests/unit/implementations/task-repository.test.ts` following the `model field persistence` pattern:
  ```typescript
  describe('system_prompt field persistence', () => {
    it('should save and retrieve task with systemPrompt', async () => {
      const task = createTestTask({ id: 'task-with-sp', systemPrompt: 'You are a reviewer' });
      await repo.save(task);
      const result = await repo.findById(TaskId('task-with-sp'));
      expect(result.ok).toBe(true);
      expect(result.value!.systemPrompt).toBe('You are a reviewer');
    });
    it('should save and retrieve task without systemPrompt as undefined', async () => { ... });
    it('should preserve systemPrompt in findAll results', async () => { ... });
  });
  ```

### HIGH

**No tests for Gemini fallback path (prependToPrompt)** -- Confidence: 92%
- `src/implementations/gemini-adapter.ts:99-109`, `src/implementations/base-agent-adapter.ts:197-199`
- Problem: When `gemini-base.md` cache does not exist, the adapter returns `{ prependToPrompt: true }` and the base class prepends the system prompt to the user prompt. This is a graceful degradation path that silently changes behavior -- the user's prompt is modified. No test verifies this fallback fires correctly or that the base class concatenation produces `"${systemPrompt}\n\n${prompt}"`.
- Fix: Test the Gemini adapter's `getSystemPromptConfig` with no cache file, asserting `prependToPrompt === true`. Then test a full `spawn()` call on GeminiAdapter with `systemPrompt` set but no cache, verifying the spawn `args` include the concatenated prompt.

**No tests for includeSystemPrompt flag on MCP status tools** -- Confidence: 90%
- `src/adapters/mcp-adapter.ts:123,402,1684,1726,2515,2556`
- Problem: `TaskStatus` and `LoopStatus` MCP tools gained an `includeSystemPrompt` boolean flag that controls whether `systemPrompt` appears in the response. The default is `false` (compact responses). No test verifies: (1) the field is omitted by default, (2) setting `includeSystemPrompt: true` includes it. The existing MCP adapter tests use `simulate*` helpers but none exercise the new flag.
- Fix: Add tests to `tests/unit/adapters/mcp-adapter.test.ts` in the `MCPAdapter - Protocol Compliance` section:
  ```typescript
  it('TaskStatus should omit systemPrompt by default', async () => { ... });
  it('TaskStatus should include systemPrompt when includeSystemPrompt=true', async () => { ... });
  it('LoopStatus should omit systemPrompt by default', async () => { ... });
  it('LoopStatus should include systemPrompt when includeSystemPrompt=true', async () => { ... });
  ```

**No tests for CLI --system-prompt flag parsing** -- Confidence: 90%
- `src/cli.ts:180-188`, `src/cli/commands/loop.ts:318-323`, `src/cli/commands/orchestrate.ts:162-166`
- Problem: Three CLI commands now accept `--system-prompt`: `beat run`, `beat loop`, and `beat orchestrate`. The loop and orchestrate parsers are pure functions (`parseLoopCreateArgs`, `parseOrchestrateCreateArgs`) that are already tested for other flags. But no tests verify that `--system-prompt` is parsed correctly, that missing the prompt string after the flag returns an error, or that the parsed value is threaded through to the service call.
- Fix: Add tests to `tests/unit/cli.test.ts` and `tests/unit/cli/orchestrate.test.ts`:
  ```typescript
  // orchestrate.test.ts
  it('should parse --system-prompt', () => {
    const result = parseOrchestrateCreateArgs(['goal', '--system-prompt', 'You are a reviewer']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.systemPrompt).toBe('You are a reviewer');
  });
  it('should error when --system-prompt has no value', () => {
    const result = parseOrchestrateCreateArgs(['goal', '--system-prompt']);
    expect(result.ok).toBe(false);
  });
  ```

### MEDIUM

**Orchestrator prompt test suite updated for new return type but missing systemPrompt-specific tests** -- Confidence: 85%
- `tests/unit/services/orchestrator-prompt.test.ts:22-28`
- Problem: The test suite was correctly updated to destructure `{ systemPrompt, userPrompt }` from `buildOrchestratorPrompt()`, and it verifies the goal goes to `userPrompt` and role instructions go to `systemPrompt`. This is good. However, there is no test verifying the contract that callers rely on: that the system prompt ends with a predictable boundary (the `RESILIENCE` section) so that `request.systemPrompt ?? orchestratorSystemPrompt` replacement in `orchestration-manager.ts:257` works as intended.
- Fix: Consider adding a test that asserts `systemPrompt` ends with a known marker (e.g., ends with text containing "terminate after a few iterations") to protect against accidental prompt structure changes.

**Loop repository TaskRequestSchema updated but no test for systemPrompt round-trip via taskTemplate** -- Confidence: 85%
- `src/implementations/loop-repository.ts:121-125`
- Problem: The loop repository's `TaskRequestSchema` Zod schema was updated to include `systemPrompt`, enabling round-trip through the `task_template` JSON blob. This is important because without it, Zod's `.parse()` would strip the field silently (same pitfall as PF-006 for orchestratorId/jsonSchema). However, no test in `tests/unit/implementations/loop-repository.test.ts` verifies that a loop created with `systemPrompt` in its taskTemplate can be read back with the field intact.
- Fix: Add a test to `tests/unit/implementations/loop-repository.test.ts` that creates a loop with `systemPrompt: 'test prompt'`, retrieves it, and asserts `loop.taskTemplate.systemPrompt === 'test prompt'`.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**No test for base-agent-adapter system prompt temp file cleanup in worker pool** -- Confidence: 82%
- `src/implementations/event-driven-worker-pool.ts:305-312`
- Problem: `cleanupWorkerState` now calls `unlinkSync` on a system-prompt temp file at `~/.autobeat/system-prompts/${taskId}.md`. The try/catch swallows errors (intentional for best-effort cleanup). While the behavior is defensive, no test verifies that: (1) the file is cleaned up after worker completion, (2) missing files do not throw.
- Fix: Add a test in the worker pool test suite that spawns a task with systemPrompt, verifies a file at the expected path, then verifies it is removed after worker completion.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**MCP adapter tests bypass Zod validation layer (existing TODO)** -- Confidence: 85%
- `tests/unit/adapters/mcp-adapter.test.ts` (line ~200 area, noted in existing TODO comment)
- Problem: The `simulate*` helpers in MCP adapter tests call service methods directly, bypassing the adapter's Zod schema validation and tool routing. The existing TODO acknowledges this. The new `systemPrompt` fields added to `DelegateTaskSchema`, `CreateLoopSchema`, and `CreateOrchestratorSchema` would benefit from integration-level tests through `callTool()` to verify Zod accepts and threads the new fields correctly.
- Fix: When prioritizing test improvements, add `callTool()` tests for `DelegateTask` with `systemPrompt` to exercise the full Zod + dispatch pipeline (same pattern as the `Orchestration tools via callTool()` section).

## Suggestions (Lower Confidence)

- **beat agents refresh-base-prompt has no tests** - `src/cli/commands/agents.ts:222-302` (Confidence: 75%) -- This command spawns a real external process and interacts with the filesystem. While it is an operational utility rather than core business logic, the validation branches (unknown agent, non-gemini agent, file not written) could be unit-tested by mocking `spawnSync` and `existsSync`.

- **Gemini cache staleness threshold is a magic number** - `src/implementations/gemini-adapter.ts:58` (Confidence: 65%) -- The 30-day staleness threshold (`30 * 24 * 60 * 60 * 1000`) is hardcoded. This is not a bug, but it may be worth extracting to a constant for documentation and testability.

- **CLI --system-prompt flag may silently eat a system prompt that starts with "-"** - `src/cli.ts:182`, `src/cli/commands/loop.ts:319`, `src/cli/commands/orchestrate.ts:164` (Confidence: 65%) -- All three parsers check `!next.startsWith('-')` to reject missing values after `--system-prompt`. However, a user's system prompt that genuinely starts with a hyphen (e.g., `--system-prompt "- You are a reviewer"`) would be rejected. This matches the existing pattern for other flags (e.g., `--model`), so it is consistent but worth noting.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 2 | 3 | 2 | - |
| Should Fix | - | - | 1 | - |
| Pre-existing | - | - | 1 | - |

**Testing Score**: 3/10
**Recommendation**: CHANGES_REQUESTED

The feature introduces a significant cross-cutting concern (system prompt injection across 3 agent adapters, MCP tools, CLI commands, task persistence, loop templates, and orchestrator prompts) with 22 changed files and 571 new/modified lines. The only test file modified was `orchestrator-prompt.test.ts`, which was correctly updated for the new return type but does not test any system-prompt-specific behavior. All other behavioral paths -- adapter injection strategies, persistence round-trips, MCP flag handling, CLI parsing, and the Gemini fallback -- have zero test coverage. This is a CRITICAL gap for a feature that touches the process-spawn boundary (where bugs are hardest to debug in production).
