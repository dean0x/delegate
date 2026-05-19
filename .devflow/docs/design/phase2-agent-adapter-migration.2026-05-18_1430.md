---
title: "Phase 2: Agent Adapter Migration"
issue: "#177"
epic: "#175"
created: 2026-05-18
status: draft
depends_on: "#176 (Phase 1: tmux Abstraction Layer — merged)"
blocks: "#178 (Phase 3: Worker Pool Rewiring)"
---

# Phase 2: Agent Adapter Migration — Implementation Plan

## Scope

Two tracks in one PR:
- **Track A**: Add `buildTmuxCommand()` to agent adapters — produces `TmuxSpawnConfig` for Phase 3 to consume
- **Track B**: Clean Gemini removal — delete adapter, update type system, database migration v28

## Architecture Decisions

### AD-1: Adapters as config producers
`buildTmuxCommand()` returns `TmuxSpawnConfig` — does NOT call `TmuxConnector`. The worker pool (Phase 3) will consume the config. This keeps adapters in the Template Method pattern (config factory, not process manager).

### AD-2: Keep spawn()/spawnInteractive() alive
AC #6 says "remove old spawn() methods" but the worker pool (Phase 3, #178) still calls `adapter.spawn()`. Removing now breaks the codebase between phases. `spawn()` is removed in Phase 5 cleanup.

### AD-3: New buildTmuxArgs() Template Method
Claude tmux needs `--output-format stream-json` (for hook-based structured output parsing). Interactive args don't include this flag. Three arg methods for three modes:
- `buildArgs()` = headless (`--print`, `--output-format json`)
- `buildInteractiveArgs()` = user terminal (no format flags)
- `buildTmuxArgs()` = tmux session (`--output-format stream-json`)

### AD-4: Reuse resolveSpawnConfig() chain
Auth, model, runtime, env, system prompt resolution shared across all spawn paths. Zero duplication.

### AD-5: ProxiedClaudeAdapter inherits for free
Only overrides resolveBaseUrl/resolveModel/resolveAuth. `buildTmuxCommand()` flows through the same chain. Zero changes needed.

### AD-6: Atomic Gemini removal
TypeScript compiler catches all missed references. Incremental removal leaves broken intermediate states. One commit, compiler-guided.

### AD-7: Migration v28 for CHECK constraint
Gemini shipped with DB presence (loops.judge_agent CHECK). PF-002 does NOT apply. Table recreation follows v22/v26 pattern.

## Track A: buildTmuxCommand()

### Step A1: Add buildTmuxArgs() to BaseAgentAdapter

**File**: `src/implementations/base-agent-adapter.ts`

Add new protected method (Template Method, subclasses can override):
```typescript
protected buildTmuxArgs(prompt: string, model?: string): readonly string[] {
  return this.buildInteractiveArgs(prompt, model);
}
```

Default delegates to `buildInteractiveArgs()`. Subclasses override only when tmux args differ.

### Step A2: Override buildTmuxArgs() in ClaudeAdapter

**File**: `src/implementations/claude-adapter.ts`

```typescript
protected buildTmuxArgs(prompt: string, model?: string): readonly string[] {
  const modelArgs: string[] = model ? ['--model', model] : [];
  return ['--dangerously-skip-permissions', '--output-format', 'stream-json', ...modelArgs, '--', prompt];
}
```

Issue AC #1: `--dangerously-skip-permissions --output-format stream-json` (no `--print`).

### Step A3: No changes to CodexAdapter

CodexAdapter's `buildInteractiveArgs()` already returns `['--full-auto', ...modelArgs, '--', prompt]` — exactly what issue AC #2 requires. The default `buildTmuxArgs()` delegation is correct.

### Step A4: Add buildTmuxCommand() to BaseAgentAdapter

**File**: `src/implementations/base-agent-adapter.ts`

```typescript
buildTmuxCommand(options: SpawnOptions & { sessionsDir: string }): Result<TmuxSpawnConfig> {
  const configResult = this.resolveSpawnConfig(options);
  if (!configResult.ok) return configResult;
  const cfg = configResult.value;

  const finalPrompt = this.transformPrompt(cfg.effectivePrompt);
  const args = [...this.buildTmuxArgs(finalPrompt, cfg.resolvedModel), ...cfg.systemPromptArgs];
  const spawnArgs = cfg.runtimePrependArgs.length > 0 ? [...cfg.runtimePrependArgs, ...args] : args;

  return ok({
    name: `beat-task-${options.taskId}`,
    command: cfg.command,
    agentArgs: spawnArgs,
    cwd: cfg.workingDirectory,
    env: cfg.env,
    agent: this.provider as TmuxAgentType,
    taskId: options.taskId,
    sessionsDir: options.sessionsDir,
  });
}
```

Runtime guard: add check that `this.provider` is 'claude' or 'codex' before the cast.

### Step A5: ProcessSpawnerAdapter stub

**File**: `src/implementations/process-spawner-adapter.ts`

```typescript
buildTmuxCommand(): Result<TmuxSpawnConfig> {
  return err(new AutobeatError(ErrorCode.INVALID_OPERATION, 'ProcessSpawnerAdapter does not support tmux'));
}
```

### Step A6: Tests (TDD)

**New file**: `tests/unit/implementations/build-tmux-command.test.ts`

Tests:
1. Claude: agentArgs includes `--dangerously-skip-permissions --output-format stream-json`, excludes `--print`
2. Codex: agentArgs includes `--full-auto`, excludes `--quiet`
3. Session name follows `beat-task-{taskId}` pattern
4. System prompt injection per agent (Claude: `--append-system-prompt`, Codex: `-c developer_instructions=...`)
5. Model override in agentArgs
6. Runtime wrapping (ollama) in command/args
7. ProxiedClaudeAdapter: proxy URL in env
8. Error when CLI binary not in PATH
9. Error when called on unsupported provider

## Track B: Gemini Removal

### Step B1: Migration v28

**File**: `src/implementations/database.ts`

Recreate loops table with `CHECK(judge_agent IS NULL OR judge_agent IN ('claude', 'codex'))`. Map existing `judge_agent='gemini'` rows to NULL.

Follow existing table-recreation pattern (v22, v26).

### Step B2: Remove from type system

**File**: `src/core/agents.ts`

- `AgentProvider = 'claude' | 'codex'`
- `AGENT_PROVIDERS_TUPLE = ['claude', 'codex'] as const`
- Remove 'gemini' from `AGENT_DESCRIPTIONS`, `AGENT_BASE_URL_ENV`, `AGENT_AUTH`

### Step B3: Delete gemini-adapter.ts

**File**: `src/implementations/gemini-adapter.ts` — DELETE

### Step B4: Update bootstrap

**File**: `src/bootstrap.ts`

Remove GeminiAdapter import and registration.

### Step B5: Update all references

Files:
- `src/adapters/mcp-instructions.ts` — remove gemini model examples
- `src/cli.ts` — remove gemini from help text, remove `refresh-base-prompt` command
- `src/cli/commands/help.ts` — remove gemini from agent list
- `src/cli/commands/init.ts` — remove gemini skill dirs
- `src/cli/commands/agents.ts` — remove `refreshBasePrompt()` function
- `src/cli/commands/orchestrate.ts` — remove gemini from help text

### Step B6: Update tests

Remove Gemini test blocks from ~20 test files. Key files:
- `tests/unit/implementations/agent-adapters.test.ts` — delete all Gemini describe blocks
- `tests/unit/implementations/agent-registry.test.ts` — remove gemini from setup
- `tests/unit/core/agents.test.ts` — update provider lists
- `tests/unit/adapters/mcp-adapter.test.ts` — remove gemini tool fixtures
- `tests/unit/services/judge-exit-condition-evaluator.test.ts` — update judge agent tests

## Implementation Order

1. Steps A1-A5 (one commit: additive, no breakage)
2. Step A6 (tests for Track A)
3. Steps B1-B6 (one atomic commit: breaking Gemini removal)

## Out of Scope (Phase 3+)

- TmuxConnector consumption of TmuxSpawnConfig
- Worker pool rewiring (EventDrivenWorkerPool)
- ProcessConnector replacement
- spawn()/spawnInteractive() removal (Phase 5)
- Interactive orchestrator tmux path
- kill() tmux path

## PR Description Guidance

**Title**: `feat(tmux): Phase 2 — Agent adapter migration + Gemini removal (#177)`

**Problem Being Solved**: Autobeat's agent adapters currently produce ChildProcess handles via `--print`/`--quiet` headless flags. Anthropic's metering of programmatic usage (June 15, 2026) requires migration to tmux-based interactive sessions. Gemini support is dropped per epic #175.

**Key Changes to Highlight**:
- New `buildTmuxCommand()` method on adapters produces tmux session config
- Three-tier arg system: headless / interactive / tmux
- Gemini adapter deleted, AgentProvider narrowed to 'claude' | 'codex'
- Migration v28: loops table CHECK constraint updated

**Breaking Changes**:
- `AgentProvider` no longer includes `'gemini'`
- `beat agents refresh-base-prompt` command removed
- Tasks with `agent='gemini'` fail with actionable error

**Reviewer Focus Areas**:
- `buildTmuxCommand()` in base-agent-adapter.ts — correct arg building and TmuxSpawnConfig mapping
- Migration v28 — table recreation pattern correctness
- Atomic Gemini removal — verify zero remaining references
