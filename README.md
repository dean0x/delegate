# Autobeat: Autonomous Coding Agent Orchestration Framework

[![Website](https://img.shields.io/badge/Website-autobeat-6366f1)](https://dean0x.github.io/x/autobeat/)

One goal in. Finished work out. No human in the loop.

```bash
beat orchestrate "Migrate the payment module to a standalone microservice with its own database, API, and test suite"
```

Autobeat gives you four composable primitives -delegation, eval loops, persistence, and resource management -and lets you wire them together however you want. Loops inside loops. Pipelines inside orchestrators. Agents spawning agents. The framework doesn't prescribe your workflow. It gives you the building blocks and gets out of the way.

The orchestrator mode is where it all comes together: a meta-agent that uses Autobeat's own tools recursively to break down goals, spawn workers, handle failures, and iterate until everything passes. Fully autonomous. Nothing else works like this.

## How It Works

The orchestrator is a meta-agent -a coding agent whose tools are Autobeat's own primitives. Each iteration, it:

1. Reads its persistent state file (plan, worker status, what passed, what failed)
2. Breaks the goal into subtasks and delegates to worker agents
3. Enforces execution ordering with task dependencies
4. Creates eval loops for tasks that need verification
5. Retries failed workers with enriched context from their logs
6. Updates its state and continues until the goal is met or it determines it can't be

The orchestrator runs as a loop. Workers it spawns can themselves be loops. Loops all the way down.

## Why This Architecture

Every other orchestration framework builds infrastructure the agent could do itself -worktree management, CI parsing, PR automation, inter-agent messaging. Every line of that code becomes technical debt as models improve.

Autobeat provides four primitives that agents *can't* do for themselves:

1. **Persistence** -crash-proof SQLite state that survives restarts
2. **Delegation** -spawn background agents with dependency ordering
3. **Eval loops** -run, score, iterate until optimal
4. **Resource management** -autoscaling workers, CPU/memory monitoring

Everything else -worktrees, CI, PRs, code review, testing, deployment -is the agent's job. As models get smarter, the framework automatically gets more powerful without changing a line of code.

## Quick Start

### Install

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "autobeat": {
      "command": "npx",
      "args": ["-y", "autobeat", "mcp", "start"]
    }
  }
}
```

Restart your MCP client to connect. Autobeat works with Claude Code, Codex, Gemini, Ollama, and any MCP-compatible agent.

### Prerequisites

- Node.js 20.0.0+
- At least one coding agent CLI installed (`claude`, `codex`, or `gemini`)

### First Run

```bash
# Initialize — detects installed agents, sets defaults, installs agent skills
beat init

# Orchestrate -fire and forget
beat orchestrate "Add real-time collaborative editing to the document editor"

# Or run a single task in the foreground
beat run "Fix the failing test in parser.test.ts" -f
```

## Orchestrate Mode

The flagship. One command, autonomous execution.

```bash
# Detached (default) -runs in the background
beat orchestrate "Set up a GraphQL API with subscriptions, pagination, and integration tests"

# Foreground -blocks and shows progress, Ctrl+C cancels
beat orchestrate "Migrate the database schema" --foreground

# Interactive -foreground TTY session with live output
beat orchestrate -i "Build the auth system"

# With options
beat orchestrate "Redesign the dashboard" \
  --agent claude \
  --max-workers 5 \
  --max-iterations 50 \
  --max-depth 3 \
  --system-prompt "Use functional patterns, no classes"
```

### Custom Orchestrators

Scaffold a custom orchestrator with state file, exit condition, and system prompt:

```bash
beat orchestrate init "Migrate payments to microservice"
```

### Monitor and Control

```bash
beat orchestrate status <id>     # Plan, steps, iteration count
beat orchestrate list             # All orchestrations
beat orchestrate cancel <id>     # Stop gracefully
```

## Eval Loops

The Karpathy loop for coding agents. Run a task, evaluate the result, iterate until optimal.

**Retry strategy** -run until a condition passes:

```bash
beat loop "Fix the failing tests" --until "npm test"
```

**Optimize strategy** -score output, seek the best:

```bash
beat loop "Optimize the bundle size" \
  --eval "node measure-bundle.js" \
  --direction minimize \
  --max-iterations 10
```

**Agent eval** -let an AI judge the result instead of a shell command:

```bash
beat loop "Fix the failing tests" --eval-mode agent --strategy retry
beat loop "Optimize the algorithm" --eval-mode agent --strategy optimize --maximize \
  --eval-prompt "Score the solution on correctness and efficiency (0-100)"
```

**Pipeline loops** -repeat a multi-step workflow:

```bash
beat loop "Implement and verify the feature" \
  --pipeline \
  --step "Implement the changes" \
  --step "Run the test suite" \
  --step "Fix any failures" \
  --until "npm test"
```

Each iteration starts with fresh context by default. The loop tracks the best result, reverts failures, and stops when the exit condition is met or safety limits are hit.

## Task Delegation

Spawn background coding agents with dependency ordering:

```bash
# Fire and forget
beat run "npm run build" --priority P1
# → task-abc123

# Chain with dependencies
beat run "npm test" --deps task-abc123
beat run "npm run deploy" --deps task-def456
# Execution: build → test → deploy
```

**Session continuation** passes output context through the chain:

```typescript
const build = await DelegateTask({ prompt: "npm run build" });
const test = await DelegateTask({
  prompt: "npm test",
  dependsOn: [build.taskId],
  continueFrom: build.taskId  // receives build's checkpoint context
});
```

## Multi-Agent Pipelines

Chain steps across different agents. Schedule them on cron.

```bash
# Sequential pipeline
beat pipeline "Design the API schema" \
  --step "Implement the endpoints" \
  --step "Write integration tests" \
  --step "Review for security issues"

# Scheduled pipeline -runs every day at 2am
beat schedule create "Run nightly checks" \
  --cron "0 2 * * *" \
  --pipeline \
  --step "Run the full test suite" \
  --step "Check for security vulnerabilities" \
  --step "Generate coverage report"
```

Each step can use a different agent, working directory, and priority.

## Scheduling

```bash
# Cron schedule
beat schedule create "Backup the database" --cron "0 2 * * *" --timezone "America/New_York"

# One-time schedule
beat schedule create "Deploy to production" --at "2026-04-01T08:00:00Z"

# Manage
beat schedule list
beat schedule pause <id>
beat schedule resume <id>
beat schedule cancel <id>
```

## Agent Configuration

Four agent runtimes are supported: **Claude**, **Codex**, **Gemini**, and **Ollama** (local LLMs). Each agent can be configured with an API key, base URL, default model, proxy, and runtime.

```bash
beat agents list                    # Show available agents
beat agents check                   # Auth status for all agents
```

### API Keys

By default, agents use CLI login-based auth (e.g., `claude login`). To use your own API key instead:

```bash
beat agents config set claude apiKey "sk-ant-your-key"
beat agents config set codex apiKey "sk-your-openai-key"
beat agents config set gemini apiKey "your-gemini-key"
```

Auth resolution order: **environment variable** > **stored config** > **CLI login**.

| Agent | Env var (highest priority) |
|-------|---------------------------|
| claude | `ANTHROPIC_API_KEY` |
| codex | `OPENAI_API_KEY` |
| gemini | `GEMINI_API_KEY` |

### Model Selection

Set a default model per agent, or override per task:

```bash
# Default model for all Claude tasks
beat agents config set claude model "claude-sonnet-4-5-20250514"

# Override per task
beat run "Fix the tests" --agent claude --model "claude-sonnet-4-5-20250514"
beat orchestrate "Refactor auth" --agent claude --model "claude-sonnet-4-5-20250514"
```

Resolution order: **per-task `--model`** > **agent config model** > **CLI default**.

### Custom Base URL

Route requests through a proxy, gateway, or local endpoint:

```bash
beat agents config set claude baseUrl "https://my-proxy.example.com/v1"
beat agents config set codex baseUrl "http://localhost:8080/v1"
```

Or via environment variables (takes precedence over config):

| Agent | Env var |
|-------|---------|
| claude | `ANTHROPIC_BASE_URL` |
| codex | `OPENAI_BASE_URL` |
| gemini | `GEMINI_BASE_URL` |

**Note**: Claude's login-based auth does not work with a custom `baseUrl` — you must also set an `apiKey`. Autobeat warns if `baseUrl` is set without one.

### API Translation Proxy

Run Claude-targeting agents on any OpenAI-compatible backend (OpenRouter, Together, vLLM, etc.). The proxy translates Anthropic Messages API to OpenAI Chat Completions format transparently.

```bash
beat agents config set claude proxy openai
beat agents config set claude baseUrl "https://openrouter.ai/api/v1"
beat agents config set claude apiKey "sk-or-your-key"
```

### Ollama Runtime

Wrap agent spawns with `ollama launch` for local LLM execution. The runtime manages the Ollama process lifecycle alongside the agent.

```bash
beat agents config set gemini runtime ollama
beat agents config set gemini model "llama3:8b"
```

Proxy and runtime are mutually exclusive — setting one clears the other.

### Using Local LLMs

Most local inference servers (Ollama, llama.cpp, vLLM, LM Studio) expose an OpenAI-compatible API. Point the codex agent at your local server:

```bash
beat agents config set codex baseUrl "http://localhost:11434/v1"
beat agents config set codex apiKey "any-string"
beat agents config set codex model "llama3"

beat run --agent codex "Refactor the utils module"
```

### Manage Config

```bash
beat agents config show              # Show all agent configs
beat agents config show claude       # Show config for one agent
beat agents config reset claude      # Clear all stored config for an agent
```

Config is stored in `~/.autobeat/config.json`.

## All MCP Tools

| Tool | What It Does |
|------|-------------|
| **CreateOrchestrator** | Autonomous goal execution with worker management |
| **OrchestratorStatus** | Orchestration plan, steps, and iteration state |
| **ListOrchestrators** | List orchestrations with status filter |
| **CancelOrchestrator** | Cancel an orchestration and its workers |
| **InitCustomOrchestrator** | Scaffold a custom orchestrator (state file, exit condition, system prompt) |
| **DelegateTask** | Spawn a background coding agent |
| **TaskStatus** | Real-time task status |
| **TaskLogs** | Execution logs |
| **CancelTask** | Cancel with cleanup |
| **RetryTask** | Retry a task |
| **ResumeTask** | Resume from checkpoint |
| **CreateLoop** | Iterative eval loop (retry or optimize) |
| **LoopStatus** | Loop details and iteration history |
| **ListLoops** | List loops with status filter |
| **CancelLoop** | Cancel a loop |
| **PauseLoop** / **ResumeLoop** | Pause and resume loops |
| **ScheduleLoop** | Schedule a recurring loop |
| **CreatePipeline** | Sequential multi-step pipeline |
| **PipelineStatus** | Pipeline details and step progress |
| **ListPipelines** | List pipelines with status filter |
| **CancelPipeline** | Cancel a pipeline and its in-flight tasks |
| **ScheduleTask** | Cron or one-time task schedule |
| **SchedulePipeline** | Scheduled pipeline |
| **ListSchedules** / **ScheduleStatus** | Schedule management |
| **PauseSchedule** / **ResumeSchedule** | Schedule lifecycle |
| **CancelSchedule** | Cancel schedule and optionally in-flight tasks |
| **ListAgents** | List agents with auth status and config |
| **ConfigureAgent** | Check, set, or reset agent config (apiKey, baseUrl, model, proxy, runtime) |

## All CLI Commands

```
beat orchestrate <goal> [options]     Autonomous orchestration (detached)
beat orchestrate <goal> -f            Foreground orchestration
beat orchestrate -i <goal>            Interactive TTY session
beat orchestrate init <goal>          Scaffold custom orchestrator
beat orchestrate status <id>          Orchestration details
beat orchestrate list                 List orchestrations
beat orchestrate cancel <id>          Cancel orchestration

beat run <prompt> [options]           Single task (detached or -f foreground)
beat list                             List tasks
beat status [id]                      Task status
beat logs <id>                        Task logs
beat cancel <id>                      Cancel task
beat retry <id>                       Retry task
beat resume <id>                      Resume from checkpoint

beat loop <prompt> --until <cmd>      Retry loop
beat loop <prompt> --eval <cmd>       Optimize loop
beat loop list                        List loops
beat loop status <id>                 Loop details
beat loop pause <id>                  Pause loop
beat loop resume <id>                 Resume loop
beat loop cancel <id>                 Cancel loop

beat schedule create <prompt>         Create schedule
beat schedule list                    List schedules
beat schedule status <id>             Schedule details
beat schedule pause/resume/cancel     Schedule lifecycle

beat pipeline <prompt> --step ...     Create pipeline

beat agents list                      List available agents
beat agents check                     Auth status for all agents
beat agents config show [agent]       Show agent config
beat agents config set <agent> <key> <value>  Set agent config
beat agents config reset <agent>      Clear agent config

beat dashboard                        Interactive terminal dashboard
beat init                             Interactive setup
beat config show|set|reset|path       Configuration
beat help                             Help
```

## Configuration

Configuration priority: **environment variables > config file > defaults**.

```bash
beat config show                    # Show resolved config
beat config set timeout 300000      # Set a value
beat config reset timeout           # Revert to default
```

| Variable | Default | Description |
|----------|---------|-------------|
| `TASK_TIMEOUT` | 1800000 (30min) | Task timeout in ms |
| `MAX_OUTPUT_BUFFER` | 10485760 (10MB) | Output buffer size |
| `CPU_CORES_RESERVED` | 2 | CPU cores reserved for system |
| `MEMORY_RESERVE` | 2684354560 (2.5GB) | Memory reserve in bytes |
| `LOG_LEVEL` | info | Logging verbosity |

## Architecture

Event-driven system with autoscaling workers and SQLite persistence. Components communicate through a central EventBus with specialized handlers.

**Task Lifecycle**: `Queued` → `Running` → `Completed` / `Failed` / `Cancelled`

Four agent runtimes: Claude, Codex, Gemini, and Ollama (local LLMs). API translation proxy enables cross-platform agent execution. Per-task agent selection. Crash recovery restores all in-flight work on restart.

See **[Architecture Documentation](./docs/architecture/)** for details.

## Development

```bash
npm run dev          # Development mode with auto-reload
npm run build        # Build TypeScript
npm run test:core    # Core tests (~3s)
npm run test:all     # Full suite (3,600+ tests)
```

See **[FEATURES.md](./docs/FEATURES.md)** for the complete feature list and **[ROADMAP.md](./docs/ROADMAP.md)** for what's next.

## License

MIT

## Support

- Issues: [GitHub Issues](https://github.com/dean0x/autobeat/issues)
- Built with the [Model Context Protocol SDK](https://modelcontextprotocol.io)
