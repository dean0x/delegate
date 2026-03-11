# Backbeat - Task Delegation And Management Framework

[![npm version](https://img.shields.io/npm/v/backbeat.svg)](https://www.npmjs.com/package/backbeat)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen)](https://nodejs.org/)
[![CI](https://github.com/dean0x/backbeat/actions/workflows/ci.yml/badge.svg)](https://github.com/dean0x/backbeat/actions/workflows/ci.yml)
[![MCP](https://img.shields.io/badge/MCP-Compatible-purple)](https://modelcontextprotocol.io/)

## Why Backbeat Exists

**The Problem**: Claude Code is incredibly powerful, but you can only work on one thing at a time with a single claude code instance. This kills true multitasking and orchestration.

**Our Belief**: AI should scale with your ambition, not limit it. Why use only one Claude instance?

**The Vision**: Transform your machine or dedicated server into an AI powerhouse where you orchestrate multiple Claude Code instances through one main session. Work on authentication in repo A while simultaneously building APIs in repo B, all coordinated through your primary Claude Code interface - no context pollution, no workflow interruption.

## Features

- **Event-Driven Architecture**: Coordinates components through events, eliminating race conditions
- **Intelligent Resource Management**: Monitors CPU and memory in real-time, spawning workers when resources are available
- **Task Persistence & Recovery**: SQLite storage with automatic crash recovery
- **Task Dependencies**: DAG-based dependency resolution with cycle detection
- **Task Scheduling**: Cron and one-time scheduling with timezone support and missed run policies
- **Task Resumption**: Resume failed/completed tasks with enriched context from automatic checkpoints

See **[FEATURES.md](./docs/FEATURES.md)** for complete feature list.

## Quick Start

### Prerequisites

- Node.js 20.0.0+
- npm 10.0.0+
- Claude Code CLI installed (`claude` command available)

### System Requirements

**Minimum** (for development/testing):
- 8+ CPU cores
- 16GB RAM
- 100GB SSD

**Recommended** (for production):
- 32+ CPU cores
- 64GB+ RAM
- 500GB+ NVMe SSD
- Dedicated Linux server (Ubuntu 22.04+)

### Installation

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "backbeat": {
      "command": "npx",
      "args": ["-y", "backbeat", "mcp", "start"]
    }
  }
}
```

Restart Claude Code to connect to Backbeat.

## Usage

### MCP Tools

Once configured, use these tools in Claude Code:

| Tool | Description | Usage |
|------|-------------|-------|
| **DelegateTask** | Submit tasks to background instances | `DelegateTask({ prompt: "...", priority: "P1" })` |
| **TaskStatus** | Get real-time task status | `TaskStatus({ taskId })` |
| **TaskLogs** | Stream or retrieve execution logs | `TaskLogs({ taskId })` |
| **CancelTask** | Cancel tasks with resource cleanup | `CancelTask({ taskId, reason })` |
| **RetryTask** | Retry a failed or completed task | `RetryTask({ taskId })` |
| **ScheduleTask** | Schedule recurring or one-time tasks | `ScheduleTask({ prompt: "...", scheduleType: "cron", cronExpression: "0 2 * * *" })` |
| **ListSchedules** | List schedules with optional status filter | `ListSchedules({ status: "active" })` |
| **GetSchedule** | Get schedule details and execution history | `GetSchedule({ scheduleId })` |
| **CancelSchedule** | Cancel an active schedule (optionally cancel in-flight tasks) | `CancelSchedule({ scheduleId, reason, cancelTasks? })` |
| **PauseSchedule** | Pause a schedule (resumable) | `PauseSchedule({ scheduleId })` |
| **ResumeSchedule** | Resume a paused schedule | `ResumeSchedule({ scheduleId })` |
| **ResumeTask** | Resume a failed/completed task with checkpoint context | `ResumeTask({ taskId, additionalContext? })` |
| **CreatePipeline** | Create sequential task pipelines | `CreatePipeline({ steps: [...] })` |
| **SchedulePipeline** | Create recurring/one-time scheduled pipelines | `SchedulePipeline({ steps: [...], cronExpression: "0 9 * * *" })` |

### CLI Commands

| Command | Description |
|---------|-------------|
| `beat mcp start` | Start the MCP server |
| `beat run <task>` | Submit new task (fire-and-forget by default) |
| `beat run <task> -f` | Submit task and stream output (foreground mode) |
| `beat list` / `beat ls` | List all tasks |
| `beat status [task-id]` | Check task status (all tasks if no ID) |
| `beat logs <task-id>` | View task output |
| `beat cancel <task-id>` | Cancel running task |
| `beat retry <task-id>` | Retry a failed or completed task |
| `beat resume <task-id>` | Resume a task from its checkpoint |
| `beat schedule create <prompt>` | Create a cron or one-time schedule |
| `beat schedule list` | List schedules with optional status filter |
| `beat schedule get <id>` | Get schedule details and execution history |
| `beat schedule pause <id>` | Pause an active schedule |
| `beat schedule resume <id>` | Resume a paused schedule |
| `beat schedule cancel <id>` | Cancel a schedule |
| `beat pipeline <prompt> ...` | Create chained one-time schedules |
| `beat config show\|set\|reset\|path` | Manage configuration |
| `beat help` | Show help |

### Task Dependencies

Create workflows where tasks wait for dependencies to complete:

```bash
# Step 1: Create build task (fire-and-forget by default)
beat run "npm run build" --priority P1
# → task-abc123

# Step 2: Create test task that waits for build
beat run "npm test" --deps task-abc123
# Task waits for build to complete before running

# Step 3: Create deploy task that waits for tests
beat run "npm run deploy" --deps task-def456
# Execution order: build → test → deploy
```

**Multiple dependencies** (parallel execution):

```typescript
// lint and format run in parallel
const lint = await DelegateTask({ prompt: "npm run lint" });
const format = await DelegateTask({ prompt: "npm run format" });

// commit waits for both to complete
const commit = await DelegateTask({
  prompt: "git commit -m 'Formatted and linted'",
  dependsOn: [lint.taskId, format.taskId]
});
```

**Session continuation** (pass output context through dependency chains):

```typescript
// Build task runs first
const build = await DelegateTask({ prompt: "npm run build" });

// Test task receives build's output/git state in its prompt
const test = await DelegateTask({
  prompt: "npm test",
  dependsOn: [build.taskId],
  continueFrom: build.taskId
});
```

When `continueFrom` is set, the dependent task's prompt is automatically enriched with the dependency's checkpoint context (output summary, git state, errors) before execution.

See **[Task Dependencies Documentation](./docs/TASK-DEPENDENCIES.md)** for advanced patterns (diamond dependencies, error handling, failure propagation).

### Task Scheduling

Schedule tasks for future or recurring execution:

```typescript
// Recurring: daily backup at 2am EST
await ScheduleTask({
  prompt: "Backup database to S3",
  scheduleType: "cron",
  cronExpression: "0 2 * * *",
  timezone: "America/New_York",
  missedRunPolicy: "catchup"
});

// One-time: deploy tomorrow at 8am UTC
await ScheduleTask({
  prompt: "Deploy to production",
  scheduleType: "one_time",
  scheduledAt: "2026-02-19T08:00:00Z"
});
```

**Schedule types**: `cron` (5-field expressions) and `one_time` (ISO 8601 datetime). **Missed run policies**: `skip`, `catchup`, `fail`. Supports IANA timezones and concurrent execution prevention.

### Task Resumption

Resume failed or completed tasks with enriched context from automatic checkpoints:

```bash
# Resume a failed task
beat resume task-abc123

# Resume with additional instructions
beat resume task-abc123 --context "Try a different approach this time"
```

```typescript
// Via MCP
await ResumeTask({
  taskId: "task-abc123",
  additionalContext: "Focus on the database migration step"
});
```

Checkpoints are captured automatically on task completion/failure, preserving the last 50 lines of output. Resumed tasks receive the full checkpoint context in their prompt and track lineage via `parentTaskId` and `retryOf` fields.

## Architecture

**Event-driven system** with autoscaling workers and SQLite persistence. Components communicate through a central EventBus, eliminating race conditions and direct state management.

**Task Lifecycle**: `Queued` → `Running` → `Completed` / `Failed` / `Cancelled`

See **[Architecture Documentation](./docs/architecture/)** for implementation details.

## Configuration

Configuration priority: **environment variables > config file > defaults**.

### Config File

Persistent configuration stored at `~/.backbeat/config.json`:

```bash
beat config show             # Show resolved configuration
beat config set timeout 300000  # Set a value
beat config reset timeout    # Revert to default
beat config path             # Print config file location
```

### Environment Variables

| Variable | Default | Range | Description |
|----------|---------|-------|-------------|
| `TASK_TIMEOUT` | 1800000 (30min) | 1000-3600000 | Task timeout in milliseconds |
| `MAX_OUTPUT_BUFFER` | 10485760 (10MB) | 1024-1073741824 | Output buffer size in bytes |
| `CPU_CORES_RESERVED` | 2 | 1-32 | CPU cores reserved for system |
| `MEMORY_RESERVE` | 2684354560 (2.5GB) | 0-68719476736 | Memory reserve in bytes |
| `LOG_LEVEL` | info | debug/info/warn/error | Logging verbosity |

### Per-Task Configuration

Override limits for individual tasks:

```typescript
// Long-running task with larger buffer
await DelegateTask({
  prompt: "analyze large dataset",
  timeout: 7200000,           // 2 hours
  maxOutputBuffer: 104857600  // 100MB
});

// Quick task with minimal resources
await DelegateTask({
  prompt: "run eslint",
  timeout: 30000,             // 30 seconds
  maxOutputBuffer: 1048576    // 1MB
});
```

## Development

### Available Scripts

```bash
npm run dev        # Development mode with auto-reload
npm run build      # Build TypeScript
npm start          # Run built server
npm run typecheck  # Type checking
npm run clean      # Clean build artifacts
```

### Testing

Tests are grouped to prevent memory exhaustion. `npm test` is blocked as a safety measure.

```bash
# Grouped tests (fast, safe to run individually)
npm run test:core           # Core domain logic (~3s)
npm run test:handlers       # Service handlers (~3s)
npm run test:repositories   # Data layer (~2s)
npm run test:adapters       # MCP adapter (~2s)
npm run test:implementations # Other implementations (~2s)
npm run test:cli            # CLI tests (~2s)
npm run test:integration    # Integration tests

# Full suite (local terminal / CI only)
npm run test:all            # All tests
npm run test:coverage       # With coverage
```

### Project Structure

```
backbeat/
├── src/
│   ├── core/                # Core interfaces and types
│   ├── implementations/     # Service implementations
│   ├── services/            # Business logic & event handlers
│   ├── adapters/            # MCP adapter
│   ├── bootstrap.ts         # Dependency injection
│   ├── cli.ts               # CLI interface
│   └── index.ts             # Entry point
├── dist/                    # Compiled JavaScript
├── tests/
│   ├── unit/                # Unit tests
│   └── integration/         # Integration tests
└── docs/                    # Documentation
```

## Roadmap

- [x] v0.2.0 - Autoscaling and persistence
- [x] v0.2.1 - Event-driven architecture and CLI
- [x] v0.2.3 - Stability improvements
- [x] v0.3.0 - Task dependency resolution
- [x] v0.3.2 - Settling workers and spawn burst protection
- [x] v0.3.3 - Test infrastructure and memory management
- [x] v0.4.0 - Task scheduling and task resumption
- [x] v0.5.0 - Multi-agent support (Claude, Codex, Gemini)
- [x] v0.6.0 - Scheduled pipelines
- [ ] v0.6.1 - Task/pipeline loops

See **[ROADMAP.md](./docs/ROADMAP.md)** for detailed plans and timelines.

## Troubleshooting

### Claude CLI not found

Ensure `claude` CLI is in your PATH:
```bash
which claude
```

### Server won't start

Check logs in stderr and verify Node.js version:
```bash
node --version  # Should be v20.0.0+
```

### Tasks fail immediately

Run in development mode to see detailed logs:
```bash
npm run dev
```

## Contributing

Contributions are welcome! Please read our contributing guidelines before submitting PRs.

## License

MIT License - see LICENSE file for details

## Support

- Report issues: [GitHub Issues](https://github.com/dean0x/backbeat/issues)

## Acknowledgments

Built with the [Model Context Protocol SDK](https://modelcontextprotocol.io)
