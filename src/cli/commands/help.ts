import { readFileSync } from 'fs';
import path from 'path';
import pc from 'picocolors';
import { stdout } from '../ui.js';

// Help writes to stdout (Unix convention), so styling must check stdout TTY — not stderr
const isStdoutTTY = process.stdout.isTTY === true;
const bold = (s: string): string => (isStdoutTTY ? pc.bold(s) : s);
const cyan = (s: string): string => (isStdoutTTY ? pc.cyan(s) : s);

export function showHelp(dirname: string) {
  const pkg = JSON.parse(readFileSync(path.join(dirname, '..', 'package.json'), 'utf-8'));
  const v = pkg.version ?? '0.0.0';

  stdout(`${bold(`Backbeat v${v}`)} ${cyan('Task Delegation MCP Server')}

${bold('Usage:')}
  beat <command> [options...]

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
  ${cyan('schedule get')} <schedule-id> [--history] [--history-limit N]
  ${cyan('schedule cancel')} <schedule-id> [reason]
  ${cyan('schedule pause')} <schedule-id>
  ${cyan('schedule resume')} <schedule-id>

${bold('Agent Commands:')}
  ${cyan('agents list')}                List available AI agents

${bold('Pipeline Commands:')}
  ${cyan('pipeline')} <prompt> [<prompt>]...   Create chained one-time schedules
    Example: pipeline "set up db" "run migrations" "seed data"

${bold('Configuration:')}
  ${cyan('config show')}                Show current configuration (resolved values)
  ${cyan('config set')} <key> <value>   Set a config value (persisted to ~/.backbeat/config.json)
  ${cyan('config reset')} <key>         Remove a key from config file (revert to default)
  ${cyan('config path')}                Print config file location

  ${cyan('help')}                       Show this help message

${bold('Examples:')}
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

Repository: https://github.com/dean0x/backbeat`);
}
