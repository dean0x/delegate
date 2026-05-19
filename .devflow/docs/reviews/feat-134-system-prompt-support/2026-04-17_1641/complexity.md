# Complexity Review Report

**Branch**: feat/134-system-prompt-support -> main
**Date**: 2026-04-17T16:41
**Commits**: 7 (c43d303..ef16f93)
**Files changed**: 22 (+571, -82)

## Issues in Your Changes (BLOCKING)

### HIGH

**`BaseAgentAdapter.spawn()` method growing beyond complexity threshold (109 lines, ~15 branch points)** - `src/implementations/base-agent-adapter.ts:156-264`
**Confidence**: 85%
- Problem: The `spawn()` method is now 109 lines with approximately 15 decision points (CLI existence check, auth resolution, model resolution, system prompt resolution with nested if/else, env stripping, orchestratorId regex validation, orchestratorId format logging, pid check). Each feature added to spawn (v1.3.0: orchestratorId validation, v1.4.0: systemPrompt handling) adds another conditional block. The system prompt block (lines 186-205) introduces a new 3-way branch (no prompt / prependToPrompt / args+env injection) that interacts with the existing `effectivePrompt -> transformPrompt -> buildArgs` chain.
- Impact: The method is the single most critical code path in the system (every task runs through it). A future feature addition (e.g., structured logging config, per-task timeout env vars) will push it past the 50-line function warning threshold doubled. Reviewing spawn-related bugs requires holding all 15 branches in mind.
- Fix: Extract the system prompt resolution block (lines 186-205) into a private method `resolveSystemPrompt()` that returns `{ effectivePrompt, args, env }`. Similarly, the orchestratorId validation block (lines 227-238) is a self-contained concern that could be `private validateOrchestratorId(id: string | undefined): string | undefined`. This would reduce spawn() to ~80 lines and isolate the two newest concerns for independent testing.

```typescript
// Suggested extraction (sketch):
private resolveSystemPrompt(
  prompt: string,
  systemPrompt: string | undefined,
  taskId: string | undefined,
): { effectivePrompt: string; args: readonly string[]; env: Record<string, string> } {
  if (!systemPrompt) return { effectivePrompt: prompt, args: [], env: {} };
  const systemPromptPath = path.join(os.homedir(), '.autobeat', 'system-prompts', `${taskId ?? 'unknown'}.md`);
  const config = this.getSystemPromptConfig(systemPrompt, systemPromptPath);
  if (config.prependToPrompt) {
    return { effectivePrompt: `${systemPrompt}\n\n${prompt}`, args: [], env: {} };
  }
  return { effectivePrompt: prompt, args: config.args, env: config.env };
}
```

### MEDIUM

**`GeminiAdapter.getSystemPromptConfig()` — 3 exit paths with filesystem I/O inside try/catch** - `src/implementations/gemini-adapter.ts:52-110`
**Confidence**: 82%
- Problem: The method has 3 distinct return paths: (1) cache exists + readable -> write combined file + return env, (2) cache exists + read fails -> return prependToPrompt, (3) no cache -> return prependToPrompt. Path 1 includes a staleness check with its own `console.error` branch. The method mixes I/O concerns (existsSync, statSync, readFileSync, mkdirSync, writeFileSync) with business logic (staleness calculation, content combination, fallback decision). At 58 lines it is within tolerance but the cyclomatic complexity (5 decision points plus implicit exception paths from 5 filesystem operations) makes it harder to reason about than its length suggests.
- Impact: The three filesystem operations inside the try block (statSync, readFileSync, writeFileSync) each throw on different failure modes (permission denied vs. disk full vs. ENOENT race), but all are caught by the same catch handler. A writeFileSync failure means the combined file was not written, but the staleness warning was already emitted — potentially confusing diagnostic output.
- Fix: Extract the "read and combine base cache" logic into a private helper `readBaseCacheAndCombine(baseCachePath, systemPrompt, systemPromptPath): Result<string>` that returns ok(combined path) or err(reason). This separates the I/O pipeline from the fallback decision logic, making each independently testable.

**Pre-existing `cli.ts` arg parsing loop extended with another `else if` branch** - `src/cli.ts:86-188`
**Confidence**: 80%
- Problem: The `for` loop that parses foreground CLI args (lines 86-188) is now 102 lines with 11 `else if` branches — one per flag (`--priority`, `--working-directory`, `--depends-on`, `--continue-from`, `--timeout`, `--max-output-buffer`, `--agent`, `--model`, `--system-prompt`, unknown flag check, positional arg). The `--system-prompt` branch (lines 180-188) follows the exact same pattern as the existing branches. The issue is not the new branch itself, but the cumulative pattern: this loop grows by ~8 lines with every new flag.
- Impact: Adding the next CLI flag will push this loop past the critical 50-line function threshold. Each branch follows an identical pattern (check next arg, validate, assign, increment i) that screams for a declarative flag definition approach.
- Fix: This is a pre-existing architectural pattern; the PR merely extends it. A refactor to a declarative flag registry (e.g., `const flags = [{ names: ['--priority', '-p'], validate: ..., assign: ... }]`) would reduce the loop to ~20 lines. Not blocking for this PR since the pattern is well-established, but should be addressed before the next flag addition.

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`cli.ts` top-level command dispatch: 20+ `else if` chain** - `src/cli.ts:50-358`
**Confidence**: 85%
- Problem: The main CLI entry point uses a flat `if/else if` chain with 20+ branches for command routing (`mcp`, `run`, `status`, `logs`, `cancel`, `retry`, `list`, `schedule`, `pipeline`, `orchestrate`, `loop`, `agents`, `resume`, `init`, `config`, `migrate`, `dashboard`, `help`, `--version`). This PR adds one more branch (`refresh-base-prompt` under `agents`) and one more flag (`--system-prompt`) but does not introduce the pattern.
- Impact: No immediate impact from this PR. Long-term, adding a new top-level command requires scanning the entire if/else chain. A command registry pattern would be more maintainable.

**`parseLoopCreateArgs()` function: 118 lines, 19+ local variables** - `src/cli/commands/loop.ts:211-363`
**Confidence**: 82%
- Problem: This function declares 19 mutable local variables (one per flag), iterates over args, then constructs a `RawLoopFlags` object from all of them. The PR adds `systemPrompt` as the 20th variable. Each variable follows the same pattern: declare, parse inside loop, pass to flags struct.
- Impact: Pre-existing; the PR adds one more variable following the established pattern. The function would benefit from the same declarative flag registry refactor mentioned above.

## Suggestions (Lower Confidence)

- **`orchestration-manager.ts` createOrchestration system prompt override** - `src/services/orchestration-manager.ts:219-222` (Confidence: 70%) — The `finalSystemPrompt = request.systemPrompt ?? orchestratorSystemPrompt` null coalesce is clean and well-documented, but the semantic is "replace entirely" which differs from the other agents' "append" semantic. The DECISION comment explains the rationale well. Consider whether a future `systemPromptMode: 'replace' | 'append'` field would be warranted if users request append behavior.

- **Magic number: 30-day staleness threshold** - `src/implementations/gemini-adapter.ts:58` (Confidence: 65%) — `30 * 24 * 60 * 60 * 1000` is a magic value. Consider extracting to a named constant at the module level (e.g., `const GEMINI_BASE_CACHE_STALENESS_MS = 30 * 24 * 60 * 60 * 1000`). Minor readability improvement; the inline comment partially mitigates.

- **`refreshBasePrompt()` function length** - `src/cli/commands/agents.ts:222-302` (Confidence: 62%) — At 80 lines with process spawning, file verification, metadata writing, and user output, this function does a lot. However, it is a CLI command handler (not a hot path) and reads linearly top-to-bottom with clear step progression. The complexity is inherent to the task (spawn external process, verify output, write metadata).

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 2 | 0 |

**Complexity Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The system prompt feature is threaded cleanly through 22 files with consistent patterns. The new code largely follows existing conventions (field addition to interfaces, Zod schemas, CLI flag parsing). The primary complexity concern is the `BaseAgentAdapter.spawn()` method which is accumulating responsibilities with each feature release. Extracting the system prompt resolution and orchestratorId validation into private methods would keep spawn() under the complexity threshold and make each concern independently testable. The Gemini adapter's `getSystemPromptConfig()` has reasonable complexity for its task but would benefit from separating I/O from decision logic. The orchestration-manager override logic is a single null-coalesce with a well-documented design decision -- minimal added complexity.
