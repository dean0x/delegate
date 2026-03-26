/**
 * CLI command: beat orchestrate
 * ARCHITECTURE: Autonomous orchestration mode with detach pattern (v0.9.0)
 * Pattern: Follows run.ts detach pattern for fire-and-forget orchestration
 */

import { spawn } from 'child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { bootstrap } from '../../bootstrap.js';
import type { AgentProvider } from '../../core/agents.js';
import { AGENT_PROVIDERS, isAgentProvider } from '../../core/agents.js';
import type { Container } from '../../core/container.js';
import { OrchestratorId, OrchestratorStatus } from '../../core/domain.js';
import type { EventBus } from '../../core/events/event-bus.js';
import type { LoopCancelledEvent, LoopCompletedEvent } from '../../core/events/events.js';
import type { OrchestrationService } from '../../core/interfaces.js';
import { readStateFile } from '../../core/orchestrator-state.js';
import { err, ok, type Result } from '../../core/result.js';
import { createReadOnlyContext } from '../read-only-context.js';
import { errorMessage, exitOnError, exitOnNull } from '../services.js';
import * as ui from '../ui.js';

// ============================================================================
// Arg parsing — pure function
// ============================================================================

interface OrchestrateCreateParsed {
  readonly kind: 'create';
  readonly goal: string;
  readonly workingDirectory?: string;
  readonly agent?: AgentProvider;
  readonly maxDepth?: number;
  readonly maxWorkers?: number;
  readonly maxIterations?: number;
  readonly foreground: boolean;
}

interface OrchestrateStatusParsed {
  readonly kind: 'status';
  readonly orchestratorId: string;
}

interface OrchestrateListParsed {
  readonly kind: 'list';
  readonly status?: string;
}

interface OrchestrateCancelParsed {
  readonly kind: 'cancel';
  readonly orchestratorId: string;
  readonly reason?: string;
}

type OrchestrateParsed =
  | OrchestrateCreateParsed
  | OrchestrateStatusParsed
  | OrchestrateListParsed
  | OrchestrateCancelParsed;

export function parseOrchestrateCreateArgs(args: readonly string[]): Result<OrchestrateCreateParsed, string> {
  let workingDirectory: string | undefined;
  let agent: AgentProvider | undefined;
  let maxDepth: number | undefined;
  let maxWorkers: number | undefined;
  let maxIterations: number | undefined;
  let foreground = false;
  const goalWords: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--foreground' || arg === '-f') {
      foreground = true;
    } else if (arg === '--working-directory' || arg === '-w') {
      const next = args[i + 1];
      if (!next || next.startsWith('-')) return err('--working-directory requires a path');
      workingDirectory = next;
      i++;
    } else if (arg === '--agent' || arg === '-a') {
      const next = args[i + 1];
      if (!next || next.startsWith('-')) return err(`--agent requires a name (${AGENT_PROVIDERS.join(', ')})`);
      if (!isAgentProvider(next)) return err(`Unknown agent: "${next}". Available: ${AGENT_PROVIDERS.join(', ')}`);
      agent = next;
      i++;
    } else if (arg === '--max-depth') {
      const next = args[i + 1];
      const val = parseInt(next, 10);
      if (isNaN(val) || val < 1 || val > 10) return err('--max-depth must be 1-10');
      maxDepth = val;
      i++;
    } else if (arg === '--max-workers') {
      const next = args[i + 1];
      const val = parseInt(next, 10);
      if (isNaN(val) || val < 1 || val > 20) return err('--max-workers must be 1-20');
      maxWorkers = val;
      i++;
    } else if (arg === '--max-iterations') {
      const next = args[i + 1];
      const val = parseInt(next, 10);
      if (isNaN(val) || val < 1 || val > 200) return err('--max-iterations must be 1-200');
      maxIterations = val;
      i++;
    } else if (arg.startsWith('-')) {
      return err(`Unknown flag: ${arg}`);
    } else {
      goalWords.push(arg);
    }
  }

  const goal = goalWords.join(' ');
  if (!goal) return err('goal is required');

  return ok({
    kind: 'create' as const,
    goal,
    workingDirectory,
    agent,
    maxDepth,
    maxWorkers,
    maxIterations,
    foreground,
  });
}

function parseOrchestrateArgs(subCommand: string | undefined, subArgs: readonly string[]): OrchestrateParsed | null {
  if (subCommand === 'status') {
    const id = subArgs[0];
    if (!id) return null;
    return { kind: 'status', orchestratorId: id };
  }

  if (subCommand === 'list' || subCommand === 'ls') {
    let status: string | undefined;
    for (let i = 0; i < subArgs.length; i++) {
      if (subArgs[i] === '--status' && subArgs[i + 1]) {
        status = subArgs[i + 1];
        break;
      }
    }
    return { kind: 'list', status };
  }

  if (subCommand === 'cancel') {
    const id = subArgs[0];
    if (!id) return null;
    const reason = subArgs.slice(1).join(' ') || undefined;
    return { kind: 'cancel', orchestratorId: id, reason };
  }

  // Default: create mode — subCommand is part of the goal
  const allArgs = subCommand ? [subCommand, ...subArgs] : [...subArgs];
  const result = parseOrchestrateCreateArgs(allArgs);
  if (!result.ok) return null;
  return result.value;
}

// ============================================================================
// Detach mode (fire-and-forget)
// ============================================================================

function handleOrchestrateDetach(args: readonly string[]): void {
  const logDir = path.join(homedir(), '.autobeat', 'detach-logs');
  try {
    mkdirSync(logDir, { recursive: true });
  } catch (error) {
    ui.error(`Failed to create log directory: ${logDir}: ${errorMessage(error)}`);
    process.exit(1);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = Math.random().toString(36).substring(2, 8);
  const logFile = path.join(logDir, `orchestrate-${timestamp}-${suffix}.log`);
  let logFd: number;
  try {
    logFd = openSync(logFile, 'w');
  } catch (error) {
    ui.error(`Failed to create log file: ${logFile}: ${errorMessage(error)}`);
    process.exit(1);
  }

  // Re-spawn with --foreground
  const childArgs = [
    process.argv[1],
    'orchestrate',
    '--foreground',
    ...args.filter((a) => a !== '--foreground' && a !== '-f'),
  ];
  try {
    const child = spawn(process.argv[0], childArgs, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      cwd: process.cwd(),
      env: process.env,
    });

    child.unref();

    if (!child.pid) {
      closeSync(logFd);
      ui.error('Failed to spawn background process');
      process.exit(1);
    }

    ui.info(`Background process started (PID: ${child.pid})`);
    ui.info(`Log file: ${logFile}`);
    closeSync(logFd);

    // Poll log file for orchestration ID (max 15s at 200ms intervals)
    const maxAttempts = 75;
    let attempt = 0;
    const idPattern = /Orchestration ID:\s+(orchestrator-\S+)/;
    const errorPattern = /^❌/m;

    const s = ui.createSpinner();
    s.start('Waiting for orchestration ID...');

    const pollInterval = setInterval(() => {
      attempt++;
      try {
        const content = readFileSync(logFile, 'utf-8');

        const match = content.match(idPattern);
        if (match) {
          clearInterval(pollInterval);
          const id = match[1];
          s.stop(`Orchestration started: ${id}`);
          ui.info(`Check status:   beat orchestrate status ${id}`);
          ui.info(`Cancel:         beat orchestrate cancel ${id}`);
          process.exit(0);
        }

        if (errorPattern.test(content)) {
          clearInterval(pollInterval);
          s.stop('Background process error');
          const lines = content.split('\n').filter((l) => l.trim().length > 0);
          const lastLines = lines.slice(-5);
          ui.error('Background process encountered an error:');
          for (const line of lastLines) {
            process.stderr.write(`  ${line}\n`);
          }
          process.exit(1);
        }
      } catch {
        // Log file not yet readable
      }

      if (attempt >= maxAttempts) {
        clearInterval(pollInterval);
        s.stop('Orchestration ID not yet available (background process still starting)');
        ui.info(`Check log file: ${logFile}`);
        process.exit(0);
      }
    }, 200);
  } catch (error) {
    closeSync(logFd);
    ui.error(`Failed to spawn background process: ${errorMessage(error)}`);
    process.exit(1);
  }
}

// ============================================================================
// Foreground mode (blocking)
// ============================================================================

async function handleOrchestrateForeground(parsed: OrchestrateCreateParsed): Promise<void> {
  let container: Container | undefined;
  const s = ui.createSpinner();
  try {
    s.start('Initializing...');
    const containerResult = await bootstrap({ mode: 'run' });
    if (!containerResult.ok) {
      s.stop('Initialization failed');
      ui.error(`Bootstrap failed: ${containerResult.error.message}`);
      process.exit(1);
    }
    container = containerResult.value;

    const serviceResult = container.get<OrchestrationService>('orchestrationService');
    if (!serviceResult.ok) {
      s.stop('Initialization failed');
      ui.error(`Failed to get orchestration service: ${serviceResult.error.message}`);
      await container.dispose();
      process.exit(1);
    }
    const service = serviceResult.value;
    s.stop('Ready');

    // Create orchestration
    const result = await service.createOrchestration({
      goal: parsed.goal,
      workingDirectory: parsed.workingDirectory,
      agent: parsed.agent,
      maxDepth: parsed.maxDepth,
      maxWorkers: parsed.maxWorkers,
      maxIterations: parsed.maxIterations,
    });

    if (!result.ok) {
      ui.error(`Failed to create orchestration: ${result.error.message}`);
      await container.dispose();
      process.exit(1);
    }

    const orchestration = result.value;
    // CRITICAL: "Orchestration ID:" pattern is used by detach-mode polling
    ui.success(`Orchestration ID: ${orchestration.id}`);
    ui.info(`Loop ID: ${orchestration.loopId ?? 'none'}`);
    ui.info(`State file: ${orchestration.stateFilePath}`);

    // Wait for loop completion
    if (!orchestration.loopId) {
      ui.error('No loop ID — cannot monitor');
      await container.dispose();
      process.exit(1);
    }

    const eventBusResult = container.get<EventBus>('eventBus');
    if (!eventBusResult.ok) {
      ui.error(`Failed to get event bus: ${eventBusResult.error.message}`);
      await container.dispose();
      process.exit(1);
    }
    const eventBus = eventBusResult.value;

    const exitCode = await new Promise<number>((resolve) => {
      let resolved = false;
      const subscriptionIds: string[] = [];

      const cleanup = () => {
        for (const id of subscriptionIds) {
          eventBus.unsubscribe(id);
        }
      };

      const resolveOnce = (code: number) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve(code);
      };

      // Handle SIGINT
      const sigintHandler = () => {
        process.stderr.write('\nCancelling orchestration...\n');
        service.cancelOrchestration(orchestration.id, 'User interrupted (SIGINT)');
      };
      process.on('SIGINT', sigintHandler);

      // Watch for loop completion
      const completedSub = eventBus.subscribe<LoopCompletedEvent>('LoopCompleted', async (event) => {
        if (event.loopId !== orchestration.loopId) return;
        process.removeListener('SIGINT', sigintHandler);
        resolveOnce(0);
      });
      if (completedSub.ok) subscriptionIds.push(completedSub.value);

      // Watch for loop cancellation
      const cancelledSub = eventBus.subscribe<LoopCancelledEvent>('LoopCancelled', async (event) => {
        if (event.loopId !== orchestration.loopId) return;
        process.removeListener('SIGINT', sigintHandler);
        resolveOnce(1);
      });
      if (cancelledSub.ok) subscriptionIds.push(cancelledSub.value);
    });

    const waitSpinner = ui.createSpinner();
    if (exitCode === 0) {
      waitSpinner.stop('Orchestration completed');
    } else {
      waitSpinner.error('Orchestration terminated');
    }

    await container.dispose();
    process.exit(exitCode);
  } catch (error) {
    s.stop('Failed');
    ui.error(errorMessage(error));
    if (container) await container.dispose();
    process.exit(1);
  }
}

// ============================================================================
// Subcommand handlers
// ============================================================================

async function handleOrchestrateStatus(orchestratorId: string): Promise<void> {
  const ctx = exitOnError(createReadOnlyContext());
  try {
    // Use raw DB query since ReadOnlyContext doesn't include orchestration repo yet
    const db = ctx as unknown as { close: () => void };
    // Import orchestration repository for read-only query
    const { SQLiteOrchestrationRepository } = await import('../../implementations/orchestration-repository.js');
    const { Database } = await import('../../implementations/database.js');

    // Create a fresh database connection for orchestration queries
    const database = new Database();
    const repo = new SQLiteOrchestrationRepository(database);

    const result = await repo.findById(OrchestratorId(orchestratorId));
    if (!result.ok) {
      ui.error(`Failed to get orchestration: ${result.error.message}`);
      database.close();
      ctx.close();
      process.exit(1);
    }

    if (!result.value) {
      ui.error(`Orchestration ${orchestratorId} not found`);
      database.close();
      ctx.close();
      process.exit(1);
    }

    const o = result.value;
    ui.stdout(
      JSON.stringify(
        {
          id: o.id,
          goal: o.goal,
          status: o.status,
          loopId: o.loopId,
          stateFilePath: o.stateFilePath,
          workingDirectory: o.workingDirectory,
          agent: o.agent,
          maxDepth: o.maxDepth,
          maxWorkers: o.maxWorkers,
          maxIterations: o.maxIterations,
          createdAt: new Date(o.createdAt).toISOString(),
          updatedAt: new Date(o.updatedAt).toISOString(),
          completedAt: o.completedAt ? new Date(o.completedAt).toISOString() : null,
        },
        null,
        2,
      ),
    );

    // Try to read and display state file plan
    const stateResult = readStateFile(o.stateFilePath);
    if (stateResult.ok) {
      const state = stateResult.value;
      ui.info(`\nState: ${state.status} (iteration ${state.iterationCount})`);
      if (state.plan.length > 0) {
        ui.info('Plan:');
        for (const step of state.plan) {
          const statusIcon =
            step.status === 'completed'
              ? 'done'
              : step.status === 'failed'
                ? 'FAIL'
                : step.status === 'in_progress'
                  ? '...'
                  : '   ';
          ui.info(`  [${statusIcon}] ${step.id}: ${step.description}${step.taskId ? ` (${step.taskId})` : ''}`);
        }
      }
    }

    database.close();
    ctx.close();
  } catch (error) {
    ui.error(errorMessage(error));
    ctx.close();
    process.exit(1);
  }
}

async function handleOrchestrateList(status?: string): Promise<void> {
  const { Database } = await import('../../implementations/database.js');
  const { SQLiteOrchestrationRepository } = await import('../../implementations/orchestration-repository.js');

  const database = new Database();
  const repo = new SQLiteOrchestrationRepository(database);

  const orchStatus = status ? (status as OrchestratorStatus) : undefined;
  const result = orchStatus ? await repo.findByStatus(orchStatus) : await repo.findAll();

  if (!result.ok) {
    ui.error(`Failed to list orchestrations: ${result.error.message}`);
    database.close();
    process.exit(1);
  }

  if (result.value.length === 0) {
    ui.info('No orchestrations found');
    database.close();
    return;
  }

  for (const o of result.value) {
    const goal = o.goal.length > 60 ? o.goal.substring(0, 60) + '...' : o.goal;
    ui.stdout(`${o.id}  ${o.status.padEnd(10)}  ${goal}`);
  }

  database.close();
}

async function handleOrchestrateCancel(orchestratorId: string, reason?: string): Promise<void> {
  const s = ui.createSpinner();
  s.start('Initializing...');
  const containerResult = await bootstrap({ mode: 'cli' });
  if (!containerResult.ok) {
    s.stop('Initialization failed');
    ui.error(`Bootstrap failed: ${containerResult.error.message}`);
    process.exit(1);
  }
  const container = containerResult.value;

  // Resolve task manager first to ensure handlers are wired
  const tmResult = await container.resolve('taskManager');
  if (!tmResult.ok) {
    s.stop('Initialization failed');
    ui.error(`Failed to initialize: ${tmResult.error.message}`);
    await container.dispose();
    process.exit(1);
  }

  const serviceResult = container.get<OrchestrationService>('orchestrationService');
  if (!serviceResult.ok) {
    s.stop('Initialization failed');
    ui.error(`Failed to get orchestration service: ${serviceResult.error.message}`);
    await container.dispose();
    process.exit(1);
  }
  const service = serviceResult.value;
  s.stop('Ready');

  const result = await service.cancelOrchestration(OrchestratorId(orchestratorId), reason);
  if (!result.ok) {
    ui.error(`Failed to cancel: ${result.error.message}`);
    await container.dispose();
    process.exit(1);
  }

  ui.success(`Orchestration ${orchestratorId} cancelled`);
  await container.dispose();
}

// ============================================================================
// Main command handler
// ============================================================================

export async function handleOrchestrateCommand(
  subCommand: string | undefined,
  subArgs: readonly string[],
): Promise<void> {
  const parsed = parseOrchestrateArgs(subCommand, subArgs);

  if (!parsed) {
    ui.error('Usage: beat orchestrate "<goal>" [options]');
    process.stderr.write(
      [
        '',
        'Subcommands:',
        '  beat orchestrate "<goal>"              Start orchestration (detached)',
        '  beat orchestrate "<goal>" --foreground  Start orchestration (blocking)',
        '  beat orchestrate status <id>            Show orchestration details',
        '  beat orchestrate list [--status <s>]    List orchestrations',
        '  beat orchestrate cancel <id> [reason]   Cancel orchestration',
        '',
        'Options:',
        '  -f, --foreground               Block and wait for completion',
        '  -w, --working-directory DIR    Working directory for workers',
        '  -a, --agent AGENT              AI agent (claude, codex, gemini)',
        '  --max-depth N                  Max delegation depth (1-10, default: 3)',
        '  --max-workers N                Max concurrent workers (1-20, default: 5)',
        '  --max-iterations N             Max orchestrator iterations (1-200, default: 50)',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }

  switch (parsed.kind) {
    case 'create': {
      if (parsed.foreground) {
        await handleOrchestrateForeground(parsed);
      } else {
        // Collect args for re-spawn (excluding --foreground since we add it)
        const rawArgs = subCommand ? [subCommand, ...subArgs] : [...subArgs];
        handleOrchestrateDetach(rawArgs);
      }
      break;
    }
    case 'status':
      await handleOrchestrateStatus(parsed.orchestratorId);
      break;
    case 'list':
      await handleOrchestrateList(parsed.status);
      break;
    case 'cancel':
      await handleOrchestrateCancel(parsed.orchestratorId, parsed.reason);
      break;
  }
}
