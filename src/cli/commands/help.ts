import pc from 'picocolors';
import { VERSION } from '../../generated/version.js';
import { stdout } from '../ui.js';

// Help writes to stdout (Unix convention), so styling must check stdout TTY — not stderr
const isStdoutTTY = process.stdout.isTTY === true;
const bold = (s: string): string => (isStdoutTTY ? pc.bold(s) : s);
const cyan = (s: string): string => (isStdoutTTY ? pc.cyan(s) : s);

export function showHelp(): void {
  stdout(`${bold(`Autobeat v${VERSION}`)} ${cyan('Task Delegation MCP Server')}

${bold('Usage:')}
  beat <command> [options...]

${bold('Setup:')}
  ${cyan('init')}                       Interactive first-time setup (select default agent)
    -a, --agent AGENT          Non-interactive: set default agent directly
    -y, --yes                  Overwrite existing config without prompting

${bold('MCP Server Commands:')}
  ${cyan('mcp start')}              Start the MCP server
  ${cyan('mcp test')}               Test server startup and validation
  ${cyan('mcp config')}             Show MCP configuration for Claude

${bold('Task Commands:')}
  ${cyan('run')} <prompt> [options]       Delegate a task (fire-and-forget; runs in current directory)
    -f, --foreground           Stream output and wait for task completion
    -p, --priority P0|P1|P2    Task priority (P0=critical, P1=high, P2=normal)
    -w, --working-directory D  Working directory for task execution
    -a, --agent AGENT          AI agent to use (claude, codex, gemini)
    --deps TASK_IDS            Comma-separated task IDs this task depends on (alias: --depends-on)
    -c, --continue TASK_ID     Continue from a dependency's checkpoint (alias: --continue-from)
    -t, --timeout MS           Task timeout in milliseconds
    -b, --buffer BYTES         Max output buffer size (1KB-1GB, default: 10MB)
                               (alias: --max-output-buffer)

  ${cyan('list')}, ${cyan('ls')}                     List all tasks
  ${cyan('status')} [task-id]             Get status of task(s)
    --system-prompt              Also display the system prompt used for the task
  ${cyan('logs')} <task-id> [--tail N]    Get output logs for a task (optionally limit to last N lines)
  ${cyan('cancel')} <task-id> [reason]    Cancel a running task with optional reason
  ${cyan('retry')} <task-id>              Retry a failed or completed task
  ${cyan('resume')} <task-id> [--context "additional instructions"]
                               Resume a failed/completed task with checkpoint context

${bold('Schedule Commands:')}
  ${cyan('schedule create')} <prompt> [options]   Create a scheduled task
    --cron "0 9 * * 1-5"              Cron expression (implies --type cron)
    --at "2025-03-01T09:00:00Z"       ISO 8601 datetime (implies --type one_time)
    --type cron|one_time               Explicit type (optional if --cron or --at given)
    --timezone "America/New_York"      IANA timezone (default: UTC)
    --missed-run-policy skip|catchup|fail  (default: skip)
    -p, --priority P0|P1|P2           Task priority
    -w, --working-directory DIR        Working directory
    --max-runs N                       Max executions for cron schedules
    --expires-at "ISO8601"             Schedule expiration
    --after <schedule-id>              Chain: wait for this schedule's task to complete

  ${cyan('schedule list')} [--status active|paused|...] [--limit N]
  ${cyan('schedule status')} <schedule-id> [--history] [--history-limit N]
  ${cyan('schedule cancel')} <schedule-id> [reason]
  ${cyan('schedule pause')} <schedule-id>
  ${cyan('schedule resume')} <schedule-id>

${bold('Agent Commands:')}
  ${cyan('agents list')}                List available AI agents
  ${cyan('agents check')}               Check agent auth status and readiness
  ${cyan('agents config set')} <agent> apiKey <key>   Store an API key for an agent
  ${cyan('agents config show')} <agent>               Show stored config for an agent
  ${cyan('agents config reset')} <agent>              Remove stored config for an agent

${bold('Pipeline Commands:')}
  ${cyan('pipeline')} <prompt> [<prompt>]...   Create chained one-time schedules
    Example: pipeline "set up db" "run migrations" "seed data"

${bold('Loop Commands:')}
  ${cyan('loop')} <prompt> --until <cmd>           Retry loop (run until exit condition passes)
  ${cyan('loop')} <prompt> --eval <cmd> --minimize|--maximize
                                         Optimize loop (minimize/maximize a score)
  ${cyan('loop')} --pipeline --step "..." --step "..." --until <cmd>
                                         Pipeline loop (multi-step iterations)
    --max-iterations N                   Max iterations (0 = unlimited, default: 10)
    --max-failures N                     Max consecutive failures (default: 3)
    --cooldown N                         Cooldown between iterations in ms (default: 0)
    --eval-timeout N                     Eval script timeout in ms (default: 60000)
    --checkpoint                         Use checkpoints between iterations (default: fresh context)

  ${cyan('loop list')} [--status running|completed|failed|cancelled]
  ${cyan('loop status')} <loop-id> [--history] [--history-limit N]
  ${cyan('loop cancel')} <loop-id> [--cancel-tasks] [reason]

${bold('Configuration:')}
  ${cyan('config show')}                Show current configuration (resolved values)
  ${cyan('config set')} <key> <value>   Set a config value (persisted to ~/.autobeat/config.json)
  ${cyan('config reset')} <key>         Remove a key from config file (revert to default)
  ${cyan('config path')}                Print config file location

  ${cyan('migrate')}                    Migrate from backbeat to autobeat (data, config, MCP)
  ${cyan('dashboard')}, ${cyan('dash')}               Interactive terminal dashboard (requires TTY)
  ${cyan('help')}                       Show this help message

${bold('Examples:')}
  beat init                                            # Interactive setup
  beat init --agent claude                            # Non-interactive (CI/scripting)
  beat mcp start                                      # Start MCP server
  beat run "analyze this codebase"                    # Fire-and-forget (default)
  beat run "fix the bug" --foreground                 # Stream output, wait
  beat run "analyze code" --agent codex               # Use Codex instead of Claude
  beat run "run tests" --deps task-abc123             # Wait for dependency
  beat agents list                                    # List available agents
  beat list                                           # List all tasks

  # Scheduling
  beat schedule create "run tests" --cron "0 9 * * 1-5"
  beat schedule create "deploy" --at "2025-03-01T09:00:00Z"
  beat schedule list --status active
  beat schedule pause <id>

  # Pipeline (sequential chained tasks)
  beat pipeline "setup db" "run migrations" "seed data"

  # Resume failed task with context
  beat resume <task-id> --context "Try a different approach"

  # Configuration
  beat config show
  beat config set timeout 300000
  beat config reset timeout

Repository: https://github.com/dean0x/autobeat`);
}
