# Autobeat v1.1.0 — Agent Eval Mode & Skill System

Loops can now delegate exit condition evaluation to an AI agent instead of a shell command. A new skill system provides structured reference files for AI agents, with an installer that copies them to agent-specific directories.

---

## Agent Eval Mode

Loops support a new `evalMode: 'agent'` option that replaces shell-based exit condition evaluation with an AI agent. The agent reads iteration output and decides:

- **Retry strategy**: pass or fail
- **Optimize strategy**: numeric score (0-100)

```bash
# Retry loop with agent evaluation
beat loop "Refactor the auth module" --strategy retry --eval-mode agent

# Optimize loop with custom evaluation prompt
beat loop "Optimize the query" --strategy optimize --maximize \
  --eval-mode agent --eval-prompt "Score based on query execution time"
```

MCP:
```json
{
  "tool": "CreateLoop",
  "arguments": {
    "prompt": "Refactor the auth module",
    "strategy": "retry",
    "evalMode": "agent",
    "evalPrompt": "Check if all tests pass and code is clean"
  }
}
```

### Architecture

- `AgentExitConditionEvaluator`: handles agent-based evaluation by spawning an agent to review iteration output
- `CompositeExitConditionEvaluator`: dispatches to shell or agent evaluator based on `evalMode`
- Database: Migration 15 adds `eval_mode` and `eval_prompt` columns to `loops`, `eval_feedback` to `loop_iterations`

---

## Skill System & Installer

### Agent Orchestration Skill

Structured skill files in `skills/autobeat/` provide AI agents with:

- Capability hierarchy decision tree (Task < Pipeline < Loop < Orchestrator)
- Complete MCP tool and CLI command reference
- Composition patterns and anti-patterns
- Reference guides for orchestration, loops, dependencies, and monitoring

### Skill Installer

```bash
# Install skills for all detected agents
beat init --install-skills

# Target specific agents
beat init --install-skills --skills-agents claude,codex
```

Agent-specific paths:
- Claude: `.claude/skills/autobeat/`
- Codex: `.agents/skills/autobeat/`
- Gemini: `.gemini/skills/autobeat/`

### MCP Instructions

Server-side instructions are injected into the MCP protocol, giving connected agents structured context about Autobeat's capabilities without requiring skill file installation.

### New MCP Tools

- **ListAgents**: list available agents with registration and auth status
- **ConfigureAgent**: check auth status (`check`), store API key (`set`), or reset stored key (`reset`) for an agent

---

## Bug Fixes

- **CRON schedule nextRunAt**: `createSchedule()` factory now populates `nextRunAt` for CRON schedules immediately. Previously returned `undefined` until the handler persisted it. ([#128](https://github.com/dean0x/autobeat/pull/128))

---

## What's Changed Since v1.0.0

- **feat**: Agent eval mode for loop exit conditions ([#126](https://github.com/dean0x/autobeat/pull/126))
- **feat**: Agent orchestration skill and skill installer ([#127](https://github.com/dean0x/autobeat/pull/127))
- **fix**: Populate nextRunAt on CRON schedule creation ([#128](https://github.com/dean0x/autobeat/pull/128))

---

## Migration Notes

- **Fully additive**: No breaking changes. No existing APIs, CLI commands, or MCP tools were changed or removed.
- **Database**: Migration 15 adds eval columns. Auto-applied on startup. No user action needed.
- **Existing workflows**: All existing commands work exactly as before. Agent eval mode is opt-in via `evalMode: 'agent'`.

---

## Installation

```bash
npm install -g autobeat@1.1.0
```

Or use npx:
```json
{
  "mcpServers": {
    "autobeat": {
      "command": "npx",
      "args": ["-y", "autobeat@1.1.0", "mcp", "start"]
    }
  }
}
```

---

## Links

- NPM Package: https://www.npmjs.com/package/autobeat
- Documentation: https://github.com/dean0x/autobeat/blob/main/docs/FEATURES.md
- Issues: https://github.com/dean0x/autobeat/issues
