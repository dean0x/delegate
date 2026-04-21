/**
 * CLI command: beat orchestrate
 * ARCHITECTURE: Autonomous orchestration mode with detach pattern (v0.9.0)
 * Pattern: Follows run.ts detach pattern for fire-and-forget orchestration
 */

import { bootstrap } from '../../bootstrap.js';
import type { AgentProvider } from '../../core/agents.js';
import { AGENT_PROVIDERS, isAgentProvider } from '../../core/agents.js';
import type { Container } from '../../core/container.js';
import type { LoopId } from '../../core/domain.js';
import { OrchestratorId, OrchestratorStatus } from '../../core/domain.js';
import type { EventBus } from '../../core/events/event-bus.js';
import type { LoopCancelledEvent, LoopCompletedEvent } from '../../core/events/events.js';
import type { OrchestrationService } from '../../core/interfaces.js';
import { scaffoldCustomOrchestrator } from '../../core/orchestrator-scaffold.js';
import { readStateFile } from '../../core/orchestrator-state.js';
import { err, ok, type Result } from '../../core/result.js';
import { validatePath } from '../../utils/validation.js';
import { createDetachLogDir, createDetachLogFile, pollLogFileForId, spawnDetachedProcess } from '../detach-helpers.js';
import { errorMessage, withReadOnlyContext, withServices } from '../services.js';
import * as ui from '../ui.js';

// ============================================================================
// Helpers
// ============================================================================

function stepStatusIcon(status: string): string {
  switch (status) {
    case 'completed':
      return 'done';
    case 'failed':
      return 'FAIL';
    case 'in_progress':
      return '...';
    default:
      return '   ';
  }
}

/**
 * Subscribe to EventBus events for a specific loop and wait for terminal state.
 * Returns 0 on LoopCompleted, 1 on LoopCancelled or if eventBus is unavailable.
 * Mirrors waitForTaskCompletion in run.ts.
 */
export function waitForLoopCompletion(container: Container, loopId: LoopId): Promise<number> {
  const eventBusResult = container.get<EventBus>('eventBus');
  if (!eventBusResult.ok) {
    ui.error(`Failed to get event bus: ${eventBusResult.error.message}`);
    return Promise.resolve(1);
  }
  const eventBus = eventBusResult.value;

  return new Promise((resolve) => {
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

    const completedSub = eventBus.subscribe<LoopCompletedEvent>('LoopCompleted', async (event) => {
      if (event.loopId !== loopId) return;
      resolveOnce(0);
    });
    if (completedSub.ok) subscriptionIds.push(completedSub.value);

    const cancelledSub = eventBus.subscribe<LoopCancelledEvent>('LoopCancelled', async (event) => {
      if (event.loopId !== loopId) return;
      resolveOnce(1);
    });
    if (cancelledSub.ok) subscriptionIds.push(cancelledSub.value);
  });
}

// ============================================================================
// Arg parsing — pure functions
// ============================================================================

/** Parse and validate an integer flag value within [min, max]. */
function parseIntFlag(name: string, value: string, min: number, max: number): Result<number, string> {
  const val = parseInt(value, 10);
  if (isNaN(val) || val < min || val > max) return err(`${name} must be ${min}-${max}`);
  return ok(val);
}

interface OrchestrateCreateParsed {
  readonly kind: 'create';
  readonly goal: string;
  readonly workingDirectory?: string;
  readonly agent?: AgentProvider;
  readonly model?: string;
  readonly maxDepth?: number;
  readonly maxWorkers?: number;
  readonly maxIterations?: number;
  readonly foreground: boolean;
  readonly systemPrompt?: string;
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

interface OrchestrateInitParsed {
  readonly kind: 'init';
  readonly goal: string;
  readonly workingDirectory?: string;
  readonly agent?: AgentProvider;
  readonly model?: string;
  readonly maxWorkers?: number;
  readonly maxDepth?: number;
}

type OrchestrateParsed =
  | OrchestrateCreateParsed
  | OrchestrateStatusParsed
  | OrchestrateListParsed
  | OrchestrateCancelParsed
  | OrchestrateInitParsed;

export function parseOrchestrateCreateArgs(args: readonly string[]): Result<OrchestrateCreateParsed, string> {
  let workingDirectory: string | undefined;
  let agent: AgentProvider | undefined;
  let model: string | undefined;
  let maxDepth: number | undefined;
  let maxWorkers: number | undefined;
  let maxIterations: number | undefined;
  let foreground = false;
  let systemPrompt: string | undefined;
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
    } else if (arg === '--model' || arg === '-m') {
      const next = args[i + 1];
      if (!next || next.startsWith('-')) return err('--model requires a model name (e.g. claude-opus-4-5)');
      model = next;
      i++;
    } else if (arg === '--system-prompt') {
      const next = args[i + 1];
      if (next === undefined) return err('--system-prompt requires a prompt string');
      systemPrompt = next;
      i++;
    } else if (arg === '--max-depth') {
      const parsed = parseIntFlag('--max-depth', args[i + 1], 1, 10);
      if (!parsed.ok) return parsed;
      maxDepth = parsed.value;
      i++;
    } else if (arg === '--max-workers') {
      const parsed = parseIntFlag('--max-workers', args[i + 1], 1, 20);
      if (!parsed.ok) return parsed;
      maxWorkers = parsed.value;
      i++;
    } else if (arg === '--max-iterations') {
      const parsed = parseIntFlag('--max-iterations', args[i + 1], 1, 200);
      if (!parsed.ok) return parsed;
      maxIterations = parsed.value;
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
    kind: 'create',
    goal,
    workingDirectory,
    agent,
    model,
    maxDepth,
    maxWorkers,
    maxIterations,
    foreground,
    systemPrompt,
  });
}

/**
 * Parse args for `beat orchestrate init`.
 * Accepts the same flags as `create` minus --foreground, --max-iterations, and --system-prompt
 * since those are irrelevant to scaffolding (no loop is created here).
 *
 * DECISION: `init` naming matches the existing subcommand style (status/list/cancel).
 * No bootstrap() call needed — purely file I/O + string generation, no DB/event bus required.
 */
export function parseOrchestrateInitArgs(args: readonly string[]): Result<OrchestrateInitParsed, string> {
  let workingDirectory: string | undefined;
  let agent: AgentProvider | undefined;
  let model: string | undefined;
  let maxDepth: number | undefined;
  let maxWorkers: number | undefined;
  const goalWords: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--working-directory' || arg === '-w') {
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
    } else if (arg === '--model' || arg === '-m') {
      const next = args[i + 1];
      if (!next || next.startsWith('-')) return err('--model requires a model name (e.g. claude-opus-4-5)');
      model = next;
      i++;
    } else if (arg === '--max-depth') {
      const parsed = parseIntFlag('--max-depth', args[i + 1], 1, 10);
      if (!parsed.ok) return parsed;
      maxDepth = parsed.value;
      i++;
    } else if (arg === '--max-workers') {
      const parsed = parseIntFlag('--max-workers', args[i + 1], 1, 20);
      if (!parsed.ok) return parsed;
      maxWorkers = parsed.value;
      i++;
    } else if (arg.startsWith('-')) {
      return err(`Unknown flag: ${arg}`);
    } else {
      goalWords.push(arg);
    }
  }

  const goal = goalWords.join(' ');
  if (!goal) return err('goal is required');

  return ok({ kind: 'init', goal, workingDirectory, agent, model, maxWorkers, maxDepth });
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

  if (subCommand === 'init') {
    const result = parseOrchestrateInitArgs(subArgs);
    if (!result.ok) return null;
    return result.value;
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

async function handleOrchestrateDetach(args: readonly string[]): Promise<void> {
  const logDir = createDetachLogDir();
  const { logFile, logFd } = createDetachLogFile(logDir, 'orchestrate');

  // Re-spawn with --foreground, filtering out any existing --foreground/-f flags
  const childArgs = [
    process.argv[1],
    'orchestrate',
    '--foreground',
    ...args.filter((a) => a !== '--foreground' && a !== '-f'),
  ];
  const pid = spawnDetachedProcess(childArgs, logFd);

  ui.info(`Background process started (PID: ${pid})`);
  ui.info(`Log file: ${logFile}`);

  // Poll log file for orchestration ID (max 15s at 200ms intervals)
  const result = await pollLogFileForId(logFile, {
    idPattern: /Orchestration ID:\s+(orchestrator-\S+)/,
    errorPattern: /^❌/m,
    foundMessage: (id) => `Orchestration started: ${id}`,
    timeoutMessage: 'Orchestration ID not yet available (background process still starting)',
    infoLines: ['Check status:   beat orchestrate status {id}', 'Cancel:         beat orchestrate cancel {id}'],
    maxAttempts: 75,
    pollIntervalMs: 200,
  });

  if (result.type === 'error') {
    process.exit(1);
  }
  process.exit(0);
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
      model: parsed.model,
      maxDepth: parsed.maxDepth,
      maxWorkers: parsed.maxWorkers,
      maxIterations: parsed.maxIterations,
      systemPrompt: parsed.systemPrompt,
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

    // SIGINT stays in parent — references service.cancelOrchestration (closure context)
    const sigintHandler = () => {
      process.stderr.write('\nCancelling orchestration...\n');
      service.cancelOrchestration(orchestration.id, 'User interrupted (SIGINT)');
    };
    process.on('SIGINT', sigintHandler);

    let exitCode: number;
    try {
      exitCode = await waitForLoopCompletion(container, orchestration.loopId);
    } finally {
      process.removeListener('SIGINT', sigintHandler);
    }

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
  const s = ui.createSpinner();
  s.start('Fetching orchestration...');
  const ctx = withReadOnlyContext(s);
  s.stop('Ready');

  const result = await ctx.orchestrationRepository.findById(OrchestratorId(orchestratorId));
  if (!result.ok) {
    ui.error(`Failed to get orchestration: ${result.error.message}`);
    ctx.close();
    process.exit(1);
  }

  if (!result.value) {
    ui.error(`Orchestration ${orchestratorId} not found`);
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
        ...(o.model && { model: o.model }),
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
  // SECURITY: Validate state file path before reading (defense-in-depth — path comes from DB)
  const statePathResult = validatePath(o.stateFilePath);
  if (!statePathResult.ok) {
    ctx.close();
    return;
  }
  const stateResult = readStateFile(statePathResult.value);
  if (stateResult.ok) {
    const state = stateResult.value;
    ui.info(`\nState: ${state.status} (iteration ${state.iterationCount})`);
    if (state.plan.length > 0) {
      ui.info('Plan:');
      for (const step of state.plan) {
        const statusIcon = stepStatusIcon(step.status);
        ui.info(`  [${statusIcon}] ${step.id}: ${step.description}${step.taskId ? ` (${step.taskId})` : ''}`);
      }
    }
  }

  ctx.close();
}

async function handleOrchestrateList(status?: string): Promise<void> {
  const s = ui.createSpinner();
  s.start('Fetching orchestrations...');
  const ctx = withReadOnlyContext(s);
  s.stop('Ready');

  const validStatuses = Object.values(OrchestratorStatus);
  let orchStatus: OrchestratorStatus | undefined;
  if (status) {
    const normalized = status.toLowerCase();
    orchStatus = validStatuses.find((v) => v === normalized);
    if (!orchStatus) {
      ui.error(`Invalid status: "${status}". Valid values: ${validStatuses.join(', ')}`);
      ctx.close();
      process.exit(1);
    }
  }

  const result = orchStatus
    ? await ctx.orchestrationRepository.findByStatus(orchStatus)
    : await ctx.orchestrationRepository.findAll();

  if (!result.ok) {
    ui.error(`Failed to list orchestrations: ${result.error.message}`);
    ctx.close();
    process.exit(1);
  }

  if (result.value.length === 0) {
    ui.info('No orchestrations found');
    ctx.close();
    return;
  }

  for (const o of result.value) {
    const goal = o.goal.length > 60 ? `${o.goal.substring(0, 60)}...` : o.goal;
    ui.stdout(`${o.id}  ${o.status.padEnd(10)}  ${goal}`);
  }

  ctx.close();
}

async function handleOrchestrateCancel(orchestratorId: string, reason?: string): Promise<void> {
  const s = ui.createSpinner();
  s.start('Cancelling orchestration...');
  const { container, orchestrationService } = await withServices(s);
  s.stop('Ready');

  const result = await orchestrationService.cancelOrchestration(OrchestratorId(orchestratorId), reason);
  if (!result.ok) {
    ui.error(`Failed to cancel: ${result.error.message}`);
    await container.dispose();
    process.exit(1);
  }

  ui.success(`Orchestration ${orchestratorId} cancelled`);
  await container.dispose();
}

// ============================================================================
// Init subcommand — custom orchestrator scaffolding
// ============================================================================

/**
 * DECISION: `beat orchestrate init` performs no DB or event-bus operations —
 * it only writes files and prints instructions. bootstrap() is intentionally
 * omitted to keep startup fast and avoid unnecessary DB connections.
 */
function handleOrchestrateInit(parsed: OrchestrateInitParsed): void {
  if (parsed.workingDirectory) {
    const pathResult = validatePath(parsed.workingDirectory, undefined, true);
    if (!pathResult.ok) {
      ui.error(`Invalid working directory: ${pathResult.error.message}`);
      process.exit(1);
    }
  }

  const workingDirectory = parsed.workingDirectory ?? process.cwd();
  const result = scaffoldCustomOrchestrator({
    goal: parsed.goal,
    workingDirectory,
    agent: parsed.agent,
    model: parsed.model,
    maxWorkers: parsed.maxWorkers,
    maxDepth: parsed.maxDepth,
  });

  if (!result.ok) {
    ui.error(`Failed to initialize custom orchestrator: ${result.error.message}`);
    process.exit(1);
  }

  const s = result.value;
  const agentFlag = parsed.agent ? ` --agent ${parsed.agent}` : '';
  const modelFlag = parsed.model ? ` --model ${parsed.model}` : '';

  ui.success('Custom orchestrator scaffolding created');
  process.stdout.write(
    [
      '',
      `State file:       ${s.stateFilePath}`,
      `Exit condition:   ${s.suggestedExitCondition}`,
      '',
      'Ready-to-use loop command:',
      '',
      `  beat loop${agentFlag}${modelFlag} "<your orchestrator prompt>" \\`,
      `    --strategy retry \\`,
      `    --until "${s.suggestedExitCondition}" \\`,
      `    --system-prompt "$(cat <<'PROMPT'`,
      s.instructions.delegation,
      '',
      s.instructions.stateManagement,
      '',
      s.instructions.constraints,
      `PROMPT`,
      `)"`,
      '',
      'Instruction snippets (for manual composition):',
      '',
      '--- Delegation Instructions ---',
      s.instructions.delegation,
      '',
      '--- State Management Instructions ---',
      s.instructions.stateManagement,
      '',
      '--- Constraint Instructions ---',
      s.instructions.constraints,
      '',
    ].join('\n'),
  );
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
        '  beat orchestrate init "<goal>"          Initialize custom orchestrator scaffolding',
        '  beat orchestrate status <id>            Show orchestration details',
        '  beat orchestrate list [--status <s>]    List orchestrations',
        '  beat orchestrate cancel <id> [reason]   Cancel orchestration',
        '',
        'Options:',
        '  -f, --foreground               Block and wait for completion',
        '  -w, --working-directory DIR    Working directory for workers',
        '  -a, --agent AGENT              AI agent (claude, codex, gemini)',
        '  -m, --model MODEL              Model override (e.g. claude-opus-4-5)',
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
        await handleOrchestrateDetach(rawArgs);
      }
      break;
    }
    case 'init':
      handleOrchestrateInit(parsed);
      break;
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
