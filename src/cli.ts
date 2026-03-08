#!/usr/bin/env node

// Set process title for easy identification in ps/pgrep/pkill
process.title = 'beat-cli';

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  agentsConfigReset,
  agentsConfigSet,
  agentsConfigShow,
  checkAgents,
  listAgents,
} from './cli/commands/agents.js';
import { cancelTask } from './cli/commands/cancel.js';
import { configPath, configReset, configSet, configShow } from './cli/commands/config.js';
import { showHelp } from './cli/commands/help.js';
import { initCommand } from './cli/commands/init.js';
import { getTaskLogs } from './cli/commands/logs.js';
import { handleMcpStart, handleMcpTest, showConfig } from './cli/commands/mcp.js';
import { handlePipelineCommand } from './cli/commands/pipeline.js';
import { handleResumeCommand } from './cli/commands/resume.js';
import { retryTask } from './cli/commands/retry.js';
import { handleDetachMode, runTask } from './cli/commands/run.js';
import { handleScheduleCommand } from './cli/commands/schedule.js';
import { getTaskStatus } from './cli/commands/status.js';
import * as ui from './cli/ui.js';
import { AGENT_PROVIDERS, isAgentProvider } from './core/agents.js';
import { validateBufferSize, validatePath, validateTimeout } from './utils/validation.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// CLI with subcommand pattern
const args = process.argv.slice(2);
const mainCommand = args[0];
const subCommand = args[1];

if (mainCommand === 'mcp') {
  if (subCommand === 'start') {
    handleMcpStart(__dirname);
  } else if (subCommand === 'test') {
    handleMcpTest(__dirname);
  } else if (subCommand === 'config') {
    showConfig();
  } else {
    ui.error(`Unknown MCP subcommand: ${subCommand || '(none)'}`);
    process.stderr.write('Valid subcommands: start, test, config\n');
    process.exit(1);
  }
} else if (mainCommand === 'run') {
  const runArgs = args.slice(1);
  const hasForeground = runArgs.includes('--foreground') || runArgs.includes('-f');

  if (!hasForeground) {
    handleDetachMode(runArgs);
  } else {
    const foregroundArgs = runArgs.filter((arg) => arg !== '--foreground' && arg !== '-f');

    const options: {
      priority?: 'P0' | 'P1' | 'P2';
      workingDirectory?: string;
      dependsOn?: readonly string[];
      continueFrom?: string;
      timeout?: number;
      maxOutputBuffer?: number;
      agent?: string;
    } = {};

    let promptWords: string[] = [];

    for (let i = 0; i < foregroundArgs.length; i++) {
      const arg = foregroundArgs[i];

      if (arg === '--priority' || arg === '-p') {
        const next = foregroundArgs[i + 1];
        if (next && ['P0', 'P1', 'P2'].includes(next)) {
          options.priority = next as 'P0' | 'P1' | 'P2';
          i++;
        } else {
          ui.error('Invalid priority. Must be P0, P1, or P2');
          process.exit(1);
        }
      } else if (arg === '--working-directory' || arg === '-w') {
        const next = foregroundArgs[i + 1];
        if (next && !next.startsWith('-')) {
          const pathResult = validatePath(next);
          if (!pathResult.ok) {
            ui.error(`Invalid working directory: ${pathResult.error.message}`);
            process.exit(1);
          }
          options.workingDirectory = pathResult.value;
          i++;
        } else {
          ui.error('Working directory requires a path');
          process.exit(1);
        }
      } else if (arg === '--depends-on' || arg === '--deps') {
        const next = foregroundArgs[i + 1];
        if (next && !next.startsWith('-')) {
          const taskIds = next
            .split(',')
            .map((id) => id.trim())
            .filter((id) => id.length > 0);
          if (taskIds.length === 0) {
            ui.error('--deps requires at least one task ID');
            process.exit(1);
          }
          options.dependsOn = taskIds;
          i++;
        } else {
          ui.error('--deps requires comma-separated task IDs');
          process.exit(1);
        }
      } else if (arg === '--continue-from' || arg === '--continue' || arg === '-c') {
        const next = foregroundArgs[i + 1];
        if (next && !next.startsWith('-')) {
          options.continueFrom = next;
          i++;
        } else {
          ui.error('--continue requires a task ID');
          process.exit(1);
        }
      } else if (arg === '--timeout' || arg === '-t') {
        const next = foregroundArgs[i + 1];
        const timeout = parseInt(next);
        const timeoutResult = validateTimeout(timeout);
        if (!timeoutResult.ok) {
          ui.error(timeoutResult.error.message);
          process.exit(1);
        }
        options.timeout = timeoutResult.value;
        i++;
      } else if (arg === '--max-output-buffer' || arg === '--buffer' || arg === '-b') {
        const next = foregroundArgs[i + 1];
        const buffer = parseInt(next);
        const bufferResult = validateBufferSize(buffer);
        if (!bufferResult.ok) {
          ui.error(bufferResult.error.message);
          process.exit(1);
        }
        options.maxOutputBuffer = bufferResult.value;
        i++;
      } else if (arg === '--agent' || arg === '-a') {
        const next = foregroundArgs[i + 1];
        if (next && !next.startsWith('-')) {
          if (!isAgentProvider(next)) {
            ui.error(`Unknown agent: "${next}". Available agents: ${AGENT_PROVIDERS.join(', ')}`);
            process.exit(1);
          }
          options.agent = next;
          i++;
        } else {
          ui.error(`--agent requires an agent name (${AGENT_PROVIDERS.join(', ')})`);
          process.exit(1);
        }
      } else if (arg.startsWith('-')) {
        ui.error(`Unknown flag: ${arg}`);
        process.exit(1);
      } else {
        promptWords.push(arg);
      }
    }

    const prompt = promptWords.join(' ');
    if (!prompt) {
      ui.error('Usage: beat run "<prompt>" [options]');
      process.stderr.write(
        [
          'Options:',
          '  -f, --foreground              Stream output and wait for completion',
          '  -p, --priority P0|P1|P2      Task priority (P0=critical, P1=high, P2=normal)',
          '  -w, --working-directory DIR   Working directory for task execution',
          '  -a, --agent AGENT            AI agent to use (claude, codex, gemini)',
          '  -t, --timeout MS              Task timeout in milliseconds',
          '  --max-output-buffer BYTES     Maximum output buffer size',
          '',
          'Examples:',
          '  beat run "refactor auth"                     # Fire-and-forget (default)',
          '  beat run "quick fix" --foreground            # Stream output, wait',
          '  beat run "analyze code" --agent codex        # Use Codex instead of Claude',
          '',
        ].join('\n'),
      );
      process.exit(1);
    }

    await runTask(prompt, Object.keys(options).length > 0 ? options : undefined);
  }
} else if (mainCommand === 'status') {
  let taskId: string | undefined;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) {
      taskId = arg;
    }
  }

  await getTaskStatus(taskId);
} else if (mainCommand === 'logs') {
  const taskId = args[1];
  if (!taskId) {
    ui.error('Usage: beat logs <task-id> [--tail N]');
    process.stderr.write(['Example: beat logs abc123', '         beat logs abc123 --tail 50', ''].join('\n'));
    process.exit(1);
  }

  let tail: number | undefined;
  const tailIndex = args.indexOf('--tail');
  if (tailIndex !== -1 && args[tailIndex + 1]) {
    const tailValue = parseInt(args[tailIndex + 1]);
    if (isNaN(tailValue) || tailValue < 1 || tailValue > 1000) {
      ui.error('Invalid tail value. Must be between 1 and 1000');
      process.exit(1);
    }
    tail = tailValue;
  }

  await getTaskLogs(taskId, tail);
} else if (mainCommand === 'cancel') {
  const taskId = args[1];
  if (!taskId) {
    ui.error('Usage: beat cancel <task-id> [reason]');
    process.exit(1);
  }

  const reason = args.slice(2).join(' ') || undefined;
  await cancelTask(taskId, reason);
} else if (mainCommand === 'retry') {
  const taskId = args[1];
  if (!taskId) {
    ui.error('Usage: beat retry <task-id>');
    process.exit(1);
  }

  await retryTask(taskId);
} else if (mainCommand === 'list' || mainCommand === 'ls') {
  await getTaskStatus(undefined);
} else if (mainCommand === 'schedule') {
  await handleScheduleCommand(subCommand, args.slice(2));
} else if (mainCommand === 'pipeline') {
  await handlePipelineCommand(args.slice(1));
} else if (mainCommand === 'agents') {
  if (subCommand === 'list' || !subCommand) {
    await listAgents();
  } else if (subCommand === 'check') {
    await checkAgents();
  } else if (subCommand === 'config') {
    const configAction = args[2];
    if (configAction === 'set') {
      await agentsConfigSet(args[3], args[4], args[5]);
    } else if (configAction === 'show') {
      await agentsConfigShow(args[3]); // optional agent filter
    } else if (configAction === 'reset') {
      await agentsConfigReset(args[3]);
    } else {
      ui.error('Usage: beat agents config <set|show|reset>');
      process.exit(1);
    }
  } else {
    ui.error(`Unknown agents subcommand: ${subCommand}`);
    process.stderr.write('Valid subcommands: list, check, config\n');
    process.exit(1);
  }
} else if (mainCommand === 'resume') {
  const taskId = args[1];
  if (!taskId) {
    ui.error('Usage: beat resume <task-id> [--context "additional instructions"]');
    process.exit(1);
  }

  let additionalContext: string | undefined;
  const contextIndex = args.indexOf('--context');
  if (contextIndex !== -1 && args[contextIndex + 1]) {
    additionalContext = args[contextIndex + 1];
  }

  await handleResumeCommand(taskId, additionalContext);
} else if (mainCommand === 'init') {
  await initCommand(args.slice(1));
} else if (mainCommand === 'config') {
  if (subCommand === 'show') {
    configShow();
  } else if (subCommand === 'set') {
    configSet(args[2], args[3]);
  } else if (subCommand === 'reset') {
    configReset(args[2]);
  } else if (subCommand === 'path') {
    configPath();
  } else {
    ui.error('Usage: beat config <show|set|reset|path>');
    process.exit(1);
  }
} else if (mainCommand === 'help' || mainCommand === '--help' || mainCommand === '-h' || !mainCommand) {
  showHelp(__dirname);
} else if (mainCommand === '--version' || mainCommand === '-v') {
  const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
  ui.stdout(pkg.version);
} else {
  ui.error(`Unknown command: ${mainCommand}`);
  showHelp(__dirname);
  process.exit(1);
}
