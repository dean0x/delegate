import { AGENT_PROVIDERS, type AgentProvider, isAgentProvider } from '../../core/agents.js';
import { EvalMode, LoopId, LoopStatus, LoopStrategy, Priority } from '../../core/domain.js';
import type { LoopService } from '../../core/interfaces.js';
import { err, ok, type Result } from '../../core/result.js';
import { toOptimizeDirection, truncatePrompt } from '../../utils/format.js';
import { validatePath } from '../../utils/validation.js';
import { exitOnError, exitOnNull, withReadOnlyContext, withServices } from '../services.js';
import * as ui from '../ui.js';

/**
 * Parsed arguments from CLI loop create command.
 * Discriminated union on `isPipeline`: pipeline variant has `pipelineSteps`,
 * non-pipeline variant has `prompt`. Matches schedule parser pattern.
 */
interface ParsedLoopBaseArgs {
  readonly strategy: LoopStrategy;
  readonly exitCondition: string;
  readonly evalMode: EvalMode;
  readonly evalPrompt?: string;
  readonly evalDirection?: 'minimize' | 'maximize';
  readonly evalTimeout?: number;
  readonly workingDirectory?: string;
  readonly maxIterations?: number;
  readonly maxConsecutiveFailures?: number;
  readonly cooldownMs?: number;
  readonly freshContext: boolean;
  readonly priority?: 'P0' | 'P1' | 'P2';
  readonly agent?: AgentProvider;
  readonly gitBranch?: string;
  readonly systemPrompt?: string;
}

type ParsedLoopArgs =
  | (ParsedLoopBaseArgs & { readonly isPipeline: true; readonly pipelineSteps: readonly string[] })
  | (ParsedLoopBaseArgs & { readonly isPipeline: false; readonly prompt: string });

/**
 * Raw flags parsed from the CLI token stream before mode-specific validation.
 * Passed to parseAgentModeArgs() or parseShellModeArgs() for final assembly.
 */
interface RawLoopFlags {
  readonly promptWords: readonly string[];
  readonly untilCmd: string | undefined;
  readonly evalCmd: string | undefined;
  readonly evalMode: EvalMode | undefined;
  readonly evalPrompt: string | undefined;
  readonly strategyFlag: string | undefined;
  readonly minimizeFlag: boolean;
  readonly maximizeFlag: boolean;
  readonly maxIterations: number | undefined;
  readonly maxFailures: number | undefined;
  readonly cooldown: number | undefined;
  readonly evalTimeout: number | undefined;
  readonly continueContext: boolean;
  readonly isPipeline: boolean;
  readonly pipelineSteps: readonly string[];
  readonly priority: 'P0' | 'P1' | 'P2' | undefined;
  readonly workingDirectory: string | undefined;
  readonly agent: AgentProvider | undefined;
  readonly gitBranch: string | undefined;
  readonly systemPrompt: string | undefined;
}

/**
 * Validate and assemble ParsedLoopArgs for agent eval mode.
 * Called when --eval-mode agent is provided (or inferred).
 */
function parseAgentModeArgs(flags: RawLoopFlags): Result<ParsedLoopArgs, string> {
  if (flags.untilCmd || flags.evalCmd) {
    return err('--until and --eval are not valid with --eval-mode agent. Use --strategy retry|optimize instead.');
  }
  if (!flags.strategyFlag) {
    return err('--strategy retry|optimize is required with --eval-mode agent');
  }
  // Validate direction flags: allowed only with optimize strategy
  if (flags.minimizeFlag && flags.maximizeFlag) {
    return err('Cannot specify both --minimize and --maximize');
  }
  if ((flags.minimizeFlag || flags.maximizeFlag) && flags.strategyFlag !== 'optimize') {
    return err('--minimize/--maximize are only valid with --strategy optimize');
  }

  // Pipeline mode validation
  if (flags.isPipeline) {
    if (flags.pipelineSteps.length < 2) {
      return err('Pipeline requires at least 2 --step flags');
    }
  } else if (flags.pipelineSteps.length > 0) {
    return err(
      '--step requires --pipeline. Did you mean: beat loop --pipeline --step "..." --step "..." --eval-mode agent --strategy retry',
    );
  }

  // Non-pipeline mode: prompt is required
  const prompt = flags.promptWords.join(' ');
  if (!flags.isPipeline && !prompt) {
    return err('Usage: beat loop <prompt> --eval-mode agent --strategy retry|optimize [options]');
  }

  const direction: 'minimize' | 'maximize' | undefined = flags.minimizeFlag
    ? 'minimize'
    : flags.maximizeFlag
      ? 'maximize'
      : undefined;

  const shared = {
    strategy: flags.strategyFlag === 'optimize' ? LoopStrategy.OPTIMIZE : LoopStrategy.RETRY,
    exitCondition: '',
    evalMode: EvalMode.AGENT,
    evalPrompt: flags.evalPrompt,
    evalDirection: direction,
    evalTimeout: flags.evalTimeout,
    workingDirectory: flags.workingDirectory,
    maxIterations: flags.maxIterations,
    maxConsecutiveFailures: flags.maxFailures,
    cooldownMs: flags.cooldown,
    freshContext: !flags.continueContext,
    priority: flags.priority,
    agent: flags.agent,
    gitBranch: flags.gitBranch,
    systemPrompt: flags.systemPrompt,
  };
  if (flags.isPipeline) {
    return ok({ ...shared, isPipeline: true as const, pipelineSteps: flags.pipelineSteps as string[] });
  }
  return ok({ ...shared, isPipeline: false as const, prompt });
}

/**
 * Validate and assemble ParsedLoopArgs for shell eval mode (default).
 * Called when --eval-mode shell is provided or no --eval-mode flag is given.
 */
function parseShellModeArgs(flags: RawLoopFlags): Result<ParsedLoopArgs, string> {
  if (flags.strategyFlag) {
    return err('--strategy is only valid with --eval-mode agent');
  }

  if (flags.untilCmd && flags.evalCmd) {
    return err('Cannot specify both --until and --eval. Use --until for retry strategy, --eval for optimize strategy.');
  }
  if (!flags.untilCmd && !flags.evalCmd) {
    return err(
      'Provide --until <cmd> for retry strategy, --eval <cmd> --minimize|--maximize for optimize strategy, or --eval-mode agent --strategy retry|optimize for agent evaluation.',
    );
  }

  const isOptimize = !!flags.evalCmd;
  const exitCondition = isOptimize ? flags.evalCmd! : flags.untilCmd!;

  // Validate direction flags for optimize
  if (flags.minimizeFlag && flags.maximizeFlag) {
    return err('Cannot specify both --minimize and --maximize');
  }
  const direction: 'minimize' | 'maximize' | undefined = flags.minimizeFlag
    ? 'minimize'
    : flags.maximizeFlag
      ? 'maximize'
      : undefined;
  if (isOptimize && !direction) {
    return err('--minimize or --maximize is required with --eval (optimize strategy)');
  }
  if (!isOptimize && direction) {
    return err('--minimize/--maximize is only valid with --eval (optimize strategy)');
  }

  // Pipeline mode
  if (flags.isPipeline) {
    if (flags.pipelineSteps.length < 2) {
      return err('Pipeline requires at least 2 --step flags');
    }
  } else if (flags.pipelineSteps.length > 0) {
    return err(
      '--step requires --pipeline. Did you mean: beat loop --pipeline --step "..." --step "..." --until "..."',
    );
  }

  // Non-pipeline mode: prompt is required
  const prompt = flags.promptWords.join(' ');
  if (!flags.isPipeline && !prompt) {
    return err('Usage: beat loop <prompt> --until <cmd> [options]');
  }

  const shared = {
    strategy: isOptimize ? LoopStrategy.OPTIMIZE : LoopStrategy.RETRY,
    exitCondition,
    evalMode: EvalMode.SHELL,
    evalDirection: direction,
    evalTimeout: flags.evalTimeout,
    workingDirectory: flags.workingDirectory,
    maxIterations: flags.maxIterations,
    maxConsecutiveFailures: flags.maxFailures,
    cooldownMs: flags.cooldown,
    freshContext: !flags.continueContext,
    priority: flags.priority,
    agent: flags.agent,
    gitBranch: flags.gitBranch,
    systemPrompt: flags.systemPrompt,
  };

  if (flags.isPipeline) {
    return ok({ ...shared, isPipeline: true as const, pipelineSteps: flags.pipelineSteps as string[] });
  }
  return ok({ ...shared, isPipeline: false as const, prompt });
}

/**
 * Parse and validate loop create arguments
 * ARCHITECTURE: Pure function — no side effects, returns Result for testability
 * Delegates mode-specific validation to parseAgentModeArgs() / parseShellModeArgs().
 */
export function parseLoopCreateArgs(loopArgs: string[]): Result<ParsedLoopArgs, string> {
  const promptWords: string[] = [];
  let untilCmd: string | undefined;
  let evalCmd: string | undefined;
  let evalMode: EvalMode | undefined;
  let evalPrompt: string | undefined;
  let strategyFlag: string | undefined;
  let minimizeFlag = false;
  let maximizeFlag = false;
  let maxIterations: number | undefined;
  let maxFailures: number | undefined;
  let cooldown: number | undefined;
  let evalTimeout: number | undefined;
  let continueContext = false;
  let isPipeline = false;
  const pipelineSteps: string[] = [];
  let priority: 'P0' | 'P1' | 'P2' | undefined;
  let workingDirectory: string | undefined;
  let agent: AgentProvider | undefined;
  let gitBranch: string | undefined;
  let systemPrompt: string | undefined;

  for (let i = 0; i < loopArgs.length; i++) {
    const arg = loopArgs[i];
    const next = loopArgs[i + 1];

    if (arg === '--until' && next) {
      untilCmd = next;
      i++;
    } else if (arg === '--eval' && next) {
      evalCmd = next;
      i++;
    } else if (arg === '--eval-mode' && next) {
      if (next !== EvalMode.SHELL && next !== EvalMode.AGENT) {
        return err('--eval-mode must be "shell" or "agent"');
      }
      evalMode = next as EvalMode;
      i++;
    } else if (arg === '--eval-prompt' && next) {
      evalPrompt = next;
      i++;
    } else if (arg === '--strategy' && next) {
      if (next !== 'retry' && next !== 'optimize') {
        return err('--strategy must be "retry" or "optimize"');
      }
      strategyFlag = next;
      i++;
    } else if (arg === '--minimize') {
      minimizeFlag = true;
    } else if (arg === '--maximize') {
      maximizeFlag = true;
    } else if (arg === '--max-iterations' && next) {
      maxIterations = parseInt(next, 10);
      if (isNaN(maxIterations) || maxIterations < 0) {
        return err('--max-iterations must be >= 0 (0 = unlimited)');
      }
      i++;
    } else if (arg === '--max-failures' && next) {
      maxFailures = parseInt(next, 10);
      if (isNaN(maxFailures) || maxFailures < 0) {
        return err('--max-failures must be >= 0');
      }
      i++;
    } else if (arg === '--cooldown' && next) {
      cooldown = parseInt(next, 10);
      if (isNaN(cooldown) || cooldown < 0) {
        return err('--cooldown must be >= 0 (ms)');
      }
      i++;
    } else if (arg === '--eval-timeout' && next) {
      evalTimeout = parseInt(next, 10);
      if (isNaN(evalTimeout) || evalTimeout < 1000) {
        return err('--eval-timeout must be >= 1000 (ms)');
      }
      i++;
    } else if (arg === '--checkpoint') {
      continueContext = true;
    } else if (arg === '--pipeline') {
      isPipeline = true;
    } else if (arg === '--step' && next) {
      pipelineSteps.push(next);
      i++;
    } else if ((arg === '--priority' || arg === '-p') && next) {
      if (!['P0', 'P1', 'P2'].includes(next)) {
        return err('Priority must be P0, P1, or P2');
      }
      priority = next as 'P0' | 'P1' | 'P2';
      i++;
    } else if ((arg === '--working-directory' || arg === '-w') && next) {
      const pathResult = validatePath(next);
      if (!pathResult.ok) {
        return err(`Invalid working directory: ${pathResult.error.message}`);
      }
      workingDirectory = pathResult.value;
      i++;
    } else if (arg === '--agent' || arg === '-a') {
      if (!next || next.startsWith('-')) {
        return err(`--agent requires an agent name (${AGENT_PROVIDERS.join(', ')})`);
      }
      if (!isAgentProvider(next)) {
        return err(`Unknown agent: "${next}". Available agents: ${AGENT_PROVIDERS.join(', ')}`);
      }
      agent = next;
      i++;
    } else if (arg === '--git-branch' && next) {
      gitBranch = next;
      i++;
    } else if (arg === '--system-prompt') {
      if (next === undefined) {
        return err('--system-prompt requires a prompt string');
      }
      systemPrompt = next;
      i++;
    } else if (arg.startsWith('-')) {
      return err(`Unknown flag: ${arg}`);
    } else {
      promptWords.push(arg);
    }
  }

  // Validate --eval-prompt requires --eval-mode agent
  if (evalPrompt && evalMode !== EvalMode.AGENT) {
    return err('--eval-prompt requires --eval-mode agent');
  }

  const flags: RawLoopFlags = {
    promptWords,
    untilCmd,
    evalCmd,
    evalMode,
    evalPrompt,
    strategyFlag,
    minimizeFlag,
    maximizeFlag,
    maxIterations,
    maxFailures,
    cooldown,
    evalTimeout,
    continueContext,
    isPipeline,
    pipelineSteps,
    priority,
    workingDirectory,
    agent,
    gitBranch,
    systemPrompt,
  };

  if (evalMode === EvalMode.AGENT) {
    return parseAgentModeArgs(flags);
  }
  return parseShellModeArgs(flags);
}

export async function handleLoopCommand(subCmd: string | undefined, loopArgs: string[]): Promise<void> {
  // Subcommand routing
  if (subCmd === 'list') {
    await handleLoopList(loopArgs);
    return;
  }

  if (subCmd === 'status') {
    await handleLoopStatus(loopArgs);
    return;
  }

  if (subCmd === 'cancel') {
    await handleLoopCancel(loopArgs);
    return;
  }

  if (subCmd === 'pause') {
    await handleLoopPause(loopArgs);
    return;
  }

  if (subCmd === 'resume') {
    await handleLoopResume(loopArgs);
    return;
  }

  if (subCmd === 'get') {
    ui.error("'beat loop get' has been renamed to 'beat loop status'. Run: beat loop status <loop-id>");
    process.exit(1);
  }

  // Default: create a loop (subCmd is the first word of the prompt or a flag)
  // Re-insert subCmd back into args for prompt parsing
  const createArgs = subCmd ? [subCmd, ...loopArgs] : loopArgs;
  await handleLoopCreate(createArgs);
}

// ============================================================================
// Loop create — full bootstrap with event bus
// ============================================================================

async function handleLoopCreate(loopArgs: string[]): Promise<void> {
  const parsed = parseLoopCreateArgs(loopArgs);
  if (!parsed.ok) {
    ui.error(parsed.error);
    process.exit(1);
  }
  const args = parsed.value;

  const s = ui.createSpinner();
  s.start('Creating loop...');
  const { loopService } = await withServices(s);

  const result = await loopService.createLoop({
    prompt: args.isPipeline ? undefined : args.prompt,
    strategy: args.strategy,
    exitCondition: args.exitCondition || undefined,
    evalMode: args.evalMode,
    evalPrompt: args.evalPrompt,
    evalDirection: toOptimizeDirection(args.evalDirection),
    evalTimeout: args.evalTimeout,
    workingDirectory: args.workingDirectory,
    maxIterations: args.maxIterations,
    maxConsecutiveFailures: args.maxConsecutiveFailures,
    cooldownMs: args.cooldownMs,
    freshContext: args.freshContext,
    pipelineSteps: args.isPipeline ? args.pipelineSteps : undefined,
    priority: args.priority ? Priority[args.priority] : undefined,
    agent: args.agent,
    gitBranch: args.gitBranch,
    systemPrompt: args.systemPrompt,
  });

  const loop = exitOnError(result, s, 'Failed to create loop');
  s.stop('Loop created');

  ui.success(`Loop created: ${loop.id}`);
  const details = [
    `Strategy: ${loop.strategy}`,
    `Status: ${loop.status}`,
    `Max iterations: ${loop.maxIterations === 0 ? 'unlimited' : loop.maxIterations}`,
  ];
  if (loop.pipelineSteps && loop.pipelineSteps.length > 0) {
    details.push(`Pipeline steps: ${loop.pipelineSteps.length}`);
  }
  if (args.agent) details.push(`Agent: ${args.agent}`);
  ui.info(details.join(' | '));
  process.exit(0);
}

// ============================================================================
// Loop list — read-only context
// ============================================================================

async function handleLoopList(loopArgs: string[]): Promise<void> {
  let status: string | undefined;
  let limit: number | undefined;

  for (let i = 0; i < loopArgs.length; i++) {
    const arg = loopArgs[i];
    const next = loopArgs[i + 1];

    if (arg === '--status' && next) {
      status = next;
      i++;
    } else if (arg === '--limit' && next) {
      limit = parseInt(next, 10);
      i++;
    }
  }

  const validStatuses = Object.values(LoopStatus);

  let statusValue: LoopStatus | undefined;
  if (status) {
    const normalized = status.toLowerCase();
    statusValue = validStatuses.find((v) => v === normalized);
    if (!statusValue) {
      ui.error(`Invalid status: ${status}. Valid values: ${validStatuses.join(', ')}`);
      process.exit(1);
    }
  }

  const s = ui.createSpinner();
  s.start('Fetching loops...');
  const ctx = withReadOnlyContext(s);
  s.stop('Ready');

  try {
    const result = statusValue
      ? await ctx.loopRepository.findByStatus(statusValue, limit)
      : await ctx.loopRepository.findAll(limit);
    const loops = exitOnError(result, undefined, 'Failed to list loops');

    if (loops.length === 0) {
      ui.info('No loops found');
    } else {
      for (const l of loops) {
        const prompt = truncatePrompt(l.taskTemplate.prompt || `Pipeline (${l.pipelineSteps?.length ?? 0} steps)`, 50);
        ui.step(
          `${ui.dim(l.id)}  ${ui.colorStatus(l.status.padEnd(10))}  ${l.strategy}  iter: ${l.currentIteration}${l.maxIterations > 0 ? '/' + l.maxIterations : ''}  ${prompt}`,
        );
      }
      ui.info(`${loops.length} loop${loops.length === 1 ? '' : 's'}`);
    }
  } finally {
    ctx.close();
  }
  process.exit(0);
}

// ============================================================================
// Loop status — read-only context
// ============================================================================

async function handleLoopStatus(loopArgs: string[]): Promise<void> {
  const loopId = loopArgs[0];
  if (!loopId) {
    ui.error('Usage: beat loop status <loop-id> [--history] [--history-limit N]');
    process.exit(1);
  }

  const includeHistory = loopArgs.includes('--history');
  let historyLimit: number | undefined;
  const hlIdx = loopArgs.indexOf('--history-limit');
  if (hlIdx !== -1 && loopArgs[hlIdx + 1]) {
    historyLimit = parseInt(loopArgs[hlIdx + 1], 10);
  }

  const s = ui.createSpinner();
  s.start('Fetching loop...');
  const ctx = withReadOnlyContext(s);
  s.stop('Ready');

  try {
    const loopResult = await ctx.loopRepository.findById(LoopId(loopId));
    const found = exitOnError(loopResult, undefined, 'Failed to get loop');
    const loop = exitOnNull(found, undefined, `Loop ${loopId} not found`);

    const lines: string[] = [];
    lines.push(`ID:            ${loop.id}`);
    lines.push(`Status:        ${ui.colorStatus(loop.status)}`);
    lines.push(`Strategy:      ${loop.strategy}`);
    lines.push(`Iteration:     ${loop.currentIteration}${loop.maxIterations > 0 ? '/' + loop.maxIterations : ''}`);
    lines.push(`Failures:      ${loop.consecutiveFailures}/${loop.maxConsecutiveFailures}`);
    if (loop.bestScore !== undefined) lines.push(`Best Score:    ${loop.bestScore}`);
    if (loop.evalDirection) lines.push(`Direction:     ${loop.evalDirection}`);
    lines.push(`Eval Mode:     ${loop.evalMode}`);
    if (loop.evalMode === EvalMode.SHELL) {
      lines.push(`Exit Cond:     ${loop.exitCondition}`);
    } else if (loop.evalPrompt) {
      lines.push(`Eval Prompt:   ${truncatePrompt(loop.evalPrompt, 80)}`);
    }
    lines.push(`Cooldown:      ${loop.cooldownMs}ms`);
    lines.push(`Fresh Context: ${loop.freshContext}`);
    lines.push(`Working Dir:   ${loop.workingDirectory}`);
    if (loop.gitBranch) lines.push(`Git Branch:    ${loop.gitBranch}`);
    if (loop.gitStartCommitSha) lines.push(`Git Start:     ${loop.gitStartCommitSha.slice(0, 8)}`);
    else if (loop.gitBaseBranch) lines.push(`Git Base:      ${loop.gitBaseBranch}`);
    if (loop.scheduleId) lines.push(`Schedule:      ${loop.scheduleId}`);
    lines.push(`Created:       ${new Date(loop.createdAt).toISOString()}`);
    if (loop.completedAt) lines.push(`Completed:     ${new Date(loop.completedAt).toISOString()}`);

    const promptDisplay = loop.taskTemplate.prompt
      ? truncatePrompt(loop.taskTemplate.prompt, 100)
      : `Pipeline (${loop.pipelineSteps?.length ?? 0} steps)`;
    lines.push(`Prompt:        ${promptDisplay}`);
    if (loop.taskTemplate.agent) lines.push(`Agent:         ${loop.taskTemplate.agent}`);

    if (loop.pipelineSteps && loop.pipelineSteps.length > 0) {
      lines.push(`Pipeline:      ${loop.pipelineSteps.length} steps`);
      for (let i = 0; i < loop.pipelineSteps.length; i++) {
        lines.push(`  Step ${i + 1}: ${truncatePrompt(loop.pipelineSteps[i], 60)}`);
      }
    }

    ui.note(lines.join('\n'), 'Loop Details');

    if (includeHistory) {
      const iterationsResult = await ctx.loopRepository.getIterations(LoopId(loopId), historyLimit);
      const iterations = exitOnError(iterationsResult, undefined, 'Failed to fetch iteration history');

      if (iterations.length > 0) {
        ui.step(`Iteration History (${iterations.length} entries)`);
        for (const iter of iterations) {
          const score = iter.score !== undefined ? ` | score: ${iter.score}` : '';
          const task = iter.taskId ? ` | task: ${iter.taskId}` : ' | task: cleaned up';
          const error = iter.errorMessage ? ` | error: ${iter.errorMessage}` : '';
          const feedback = iter.evalFeedback ? ` | feedback: ${truncatePrompt(iter.evalFeedback, 60)}` : '';
          let git = '';
          if (iter.gitCommitSha) {
            git = ` | commit: ${iter.gitCommitSha.slice(0, 8)}`;
          } else if (iter.gitBranch) {
            git = ` | branch: ${iter.gitBranch}`;
          }
          process.stderr.write(
            `  #${iter.iterationNumber} ${ui.colorStatus(iter.status)}${score}${task}${error}${feedback}${git}\n`,
          );
        }
      } else {
        ui.info('No iterations yet');
      }
    }
  } finally {
    ctx.close();
  }
  process.exit(0);
}

// ============================================================================
// Loop cancel — full bootstrap
// ============================================================================

async function handleLoopCancel(loopArgs: string[]): Promise<void> {
  let cancelTasks = false;
  const filteredArgs: string[] = [];

  for (const arg of loopArgs) {
    if (arg === '--cancel-tasks') {
      cancelTasks = true;
    } else {
      filteredArgs.push(arg);
    }
  }

  const loopId = filteredArgs[0];
  if (!loopId) {
    ui.error('Usage: beat loop cancel <loop-id> [--cancel-tasks] [reason]');
    process.exit(1);
  }
  const reason = filteredArgs.slice(1).join(' ') || undefined;

  const s = ui.createSpinner();
  s.start('Cancelling loop...');
  const { loopService } = await withServices(s);
  s.stop('Ready');

  const result = await loopService.cancelLoop(LoopId(loopId), reason, cancelTasks);
  exitOnError(result, undefined, 'Failed to cancel loop');
  ui.success(`Loop ${loopId} cancelled`);
  if (cancelTasks) ui.info('In-flight tasks also cancelled');
  if (reason) ui.info(`Reason: ${reason}`);
  process.exit(0);
}

// ============================================================================
// Loop pause — full bootstrap (v0.8.0)
// ============================================================================

async function handleLoopPause(loopArgs: string[]): Promise<void> {
  let force = false;
  const filteredArgs: string[] = [];

  for (const arg of loopArgs) {
    if (arg === '--force') {
      force = true;
    } else {
      filteredArgs.push(arg);
    }
  }

  const loopId = filteredArgs[0];
  if (!loopId) {
    ui.error('Usage: beat loop pause <loop-id> [--force]');
    process.exit(1);
  }

  const s = ui.createSpinner();
  s.start('Pausing loop...');
  const { loopService } = await withServices(s);
  s.stop('Ready');

  const result = await loopService.pauseLoop(LoopId(loopId), { force });
  exitOnError(result, undefined, 'Failed to pause loop');
  ui.success(`Loop ${loopId} paused`);
  if (force) ui.info('Force pause — current iteration cancelled');
  process.exit(0);
}

// ============================================================================
// Loop resume — full bootstrap (v0.8.0)
// ============================================================================

async function handleLoopResume(loopArgs: string[]): Promise<void> {
  const loopId = loopArgs[0];
  if (!loopId) {
    ui.error('Usage: beat loop resume <loop-id>');
    process.exit(1);
  }

  const s = ui.createSpinner();
  s.start('Resuming loop...');
  const { loopService } = await withServices(s);
  s.stop('Ready');

  const result = await loopService.resumeLoop(LoopId(loopId));
  exitOnError(result, undefined, 'Failed to resume loop');
  ui.success(`Loop ${loopId} resumed`);
  process.exit(0);
}
