import { AGENT_PROVIDERS, type AgentProvider, isAgentProvider } from '../../core/agents.js';
import { LoopStrategy, Priority, ScheduleId, ScheduleStatus, ScheduleType } from '../../core/domain.js';
import type { ScheduleExecution, ScheduleRepository, ScheduleService } from '../../core/interfaces.js';
import { err, ok, type Result } from '../../core/result.js';
import { toMissedRunPolicy, toOptimizeDirection, truncatePrompt } from '../../utils/format.js';
import { validatePath } from '../../utils/validation.js';
import { exitOnError, exitOnNull, withReadOnlyContext, withServices } from '../services.js';
import * as ui from '../ui.js';

/**
 * Parsed arguments from CLI schedule create command.
 * Discriminated union on `isPipeline`: pipeline variant has `pipelineSteps`,
 * non-pipeline variant has `prompt`. Eliminates non-null assertions in handlers.
 */
interface ParsedScheduleBaseArgs {
  readonly scheduleType: 'cron' | 'one_time';
  readonly cronExpression?: string;
  readonly scheduledAt?: string;
  readonly timezone?: string;
  readonly missedRunPolicy?: 'skip' | 'catchup' | 'fail';
  readonly priority?: 'P0' | 'P1' | 'P2';
  readonly workingDirectory?: string;
  readonly maxRuns?: number;
  readonly expiresAt?: string;
  readonly afterScheduleId?: string;
  readonly agent?: AgentProvider;
}

/**
 * Parsed loop config for scheduled loop creation (v0.8.0)
 */
interface ParsedLoopConfig {
  readonly strategy: LoopStrategy;
  readonly exitCondition: string;
  readonly evalDirection?: 'minimize' | 'maximize';
  readonly evalTimeout?: number;
  readonly maxIterations?: number;
  readonly maxConsecutiveFailures?: number;
  readonly cooldownMs?: number;
  readonly freshContext: boolean;
  readonly gitBranch?: string;
  readonly prompt?: string;
  readonly pipelineSteps?: readonly string[];
}

type ParsedScheduleCreateArgs =
  | (ParsedScheduleBaseArgs & {
      readonly isPipeline: true;
      readonly isLoop?: false;
      readonly pipelineSteps: readonly string[];
    })
  | (ParsedScheduleBaseArgs & { readonly isPipeline: false; readonly isLoop?: false; readonly prompt: string })
  | (ParsedScheduleBaseArgs & { readonly isLoop: true; readonly loopConfig: ParsedLoopConfig });

/**
 * Parse and validate schedule create arguments.
 * ARCHITECTURE: Pure function — no side effects, returns Result for testability
 */
export function parseScheduleCreateArgs(scheduleArgs: string[]): Result<ParsedScheduleCreateArgs, string> {
  const promptWords: string[] = [];
  let scheduleType: 'cron' | 'one_time' | undefined;
  let cronExpression: string | undefined;
  let scheduledAt: string | undefined;
  let timezone: string | undefined;
  let missedRunPolicy: 'skip' | 'catchup' | 'fail' | undefined;
  let priority: 'P0' | 'P1' | 'P2' | undefined;
  let workingDirectory: string | undefined;
  let maxRuns: number | undefined;
  let expiresAt: string | undefined;
  let afterScheduleId: string | undefined;
  let agent: AgentProvider | undefined;
  let isPipeline = false;
  const pipelineSteps: string[] = [];

  // Loop-specific flags (v0.8.0)
  let isLoop = false;
  let untilCmd: string | undefined;
  let evalCmd: string | undefined;
  let explicitStrategy: LoopStrategy | undefined;
  let loopDirection: 'minimize' | 'maximize' | undefined;
  let loopMaxIterations: number | undefined;
  let loopMaxFailures: number | undefined;
  let loopCooldown: number | undefined;
  let loopEvalTimeout: number | undefined;
  let loopContinueContext = false;
  let loopGitBranch: string | undefined;

  for (let i = 0; i < scheduleArgs.length; i++) {
    const arg = scheduleArgs[i];
    const next = scheduleArgs[i + 1];

    if (arg === '--type' && next) {
      if (next !== 'cron' && next !== 'one_time') {
        return err('--type must be "cron" or "one_time"');
      }
      scheduleType = next;
      i++;
    } else if (arg === '--cron' && next) {
      cronExpression = next;
      i++;
    } else if (arg === '--at' && next) {
      scheduledAt = next;
      i++;
    } else if (arg === '--timezone' && next) {
      timezone = next;
      i++;
    } else if (arg === '--missed-run-policy' && next) {
      if (!['skip', 'catchup', 'fail'].includes(next)) {
        return err('--missed-run-policy must be "skip", "catchup", or "fail"');
      }
      missedRunPolicy = next as 'skip' | 'catchup' | 'fail';
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
    } else if (arg === '--max-runs' && next) {
      maxRuns = parseInt(next, 10);
      if (isNaN(maxRuns) || maxRuns < 1) {
        return err('--max-runs must be a positive integer');
      }
      i++;
    } else if (arg === '--expires-at' && next) {
      expiresAt = next;
      i++;
    } else if (arg === '--after' && next) {
      afterScheduleId = next;
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
    } else if (arg === '--pipeline') {
      isPipeline = true;
    } else if (arg === '--step' && next) {
      pipelineSteps.push(next);
      i++;
    } else if (arg === '--loop') {
      isLoop = true;
    } else if (arg === '--until' && next) {
      untilCmd = next;
      i++;
    } else if (arg === '--eval' && next) {
      evalCmd = next;
      i++;
    } else if (arg === '--strategy' && next) {
      // Explicit strategy override (alternative to --until/--eval inference)
      if (next !== 'retry' && next !== 'optimize') {
        return err('--strategy must be "retry" or "optimize"');
      }
      explicitStrategy = next === 'retry' ? LoopStrategy.RETRY : LoopStrategy.OPTIMIZE;
      i++;
    } else if (arg === '--direction' && next) {
      if (next !== 'minimize' && next !== 'maximize') {
        return err('--direction must be "minimize" or "maximize"');
      }
      loopDirection = next;
      i++;
    } else if (arg === '--max-iterations' && next) {
      loopMaxIterations = parseInt(next, 10);
      if (isNaN(loopMaxIterations) || loopMaxIterations < 0) {
        return err('--max-iterations must be >= 0 (0 = unlimited)');
      }
      i++;
    } else if (arg === '--max-failures' && next) {
      loopMaxFailures = parseInt(next, 10);
      if (isNaN(loopMaxFailures) || loopMaxFailures < 0) {
        return err('--max-failures must be >= 0');
      }
      i++;
    } else if (arg === '--cooldown' && next) {
      loopCooldown = parseInt(next, 10);
      if (isNaN(loopCooldown) || loopCooldown < 0) {
        return err('--cooldown must be >= 0 (ms)');
      }
      i++;
    } else if (arg === '--eval-timeout' && next) {
      loopEvalTimeout = parseInt(next, 10);
      if (isNaN(loopEvalTimeout) || loopEvalTimeout < 1000) {
        return err('--eval-timeout must be >= 1000 (ms)');
      }
      i++;
    } else if (arg === '--continue-context') {
      loopContinueContext = true;
    } else if (arg === '--git-branch' && next) {
      loopGitBranch = next;
      i++;
    } else if (arg.startsWith('-')) {
      return err(`Unknown flag: ${arg}`);
    } else {
      promptWords.push(arg);
    }
  }

  // Infer type from --cron / --at flags
  if (cronExpression && scheduledAt) {
    return err('Cannot specify both --cron and --at');
  }
  let inferredType: 'cron' | 'one_time' | undefined;
  if (cronExpression) {
    inferredType = 'cron';
  } else if (scheduledAt) {
    inferredType = 'one_time';
  }
  if (scheduleType && inferredType && scheduleType !== inferredType) {
    return err(`--type ${scheduleType} conflicts with ${cronExpression ? '--cron' : '--at'}`);
  }
  scheduleType = scheduleType ?? inferredType;
  if (!scheduleType) {
    return err('Provide --cron, --at, or --type');
  }

  // Loop mode (v0.8.0)
  if (isLoop) {
    // Validate loop exit condition
    if (untilCmd && evalCmd) {
      return err('Cannot specify both --until and --eval. Use --until for retry, --eval for optimize.');
    }
    if (!untilCmd && !evalCmd) {
      return err('--loop requires --until <cmd> or --eval <cmd> --direction minimize|maximize');
    }

    const isOptimize = !!evalCmd;
    const exitCondition = isOptimize ? evalCmd! : untilCmd!;

    if (isOptimize && !loopDirection) {
      return err('--direction minimize|maximize is required with --eval (optimize strategy)');
    }
    if (!isOptimize && loopDirection) {
      return err('--direction is only valid with --eval (optimize strategy)');
    }

    const loopConfig: ParsedLoopConfig = {
      strategy: explicitStrategy ?? (isOptimize ? LoopStrategy.OPTIMIZE : LoopStrategy.RETRY),
      exitCondition,
      evalDirection: loopDirection,
      evalTimeout: loopEvalTimeout,
      maxIterations: loopMaxIterations,
      maxConsecutiveFailures: loopMaxFailures,
      cooldownMs: loopCooldown,
      freshContext: !loopContinueContext,
      gitBranch: loopGitBranch,
      prompt: promptWords.join(' ') || undefined,
      pipelineSteps: isPipeline && pipelineSteps.length >= 2 ? pipelineSteps : undefined,
    };

    // Pipeline validation for loop mode
    if (isPipeline && pipelineSteps.length < 2) {
      return err('Pipeline requires at least 2 --step flags');
    }

    const shared = {
      scheduleType,
      cronExpression,
      scheduledAt,
      timezone,
      missedRunPolicy,
      priority,
      workingDirectory,
      maxRuns,
      expiresAt,
      afterScheduleId,
      agent,
    };

    return ok({ ...shared, isLoop: true as const, loopConfig });
  }

  // Pipeline mode
  if (isPipeline) {
    if (pipelineSteps.length < 2) {
      return err('Pipeline requires at least 2 --step flags');
    }
  } else if (pipelineSteps.length > 0) {
    return err(
      '--step requires --pipeline. Did you mean: beat schedule create --pipeline --step "..." --step "..." --cron "..."',
    );
  }

  // Non-pipeline mode: prompt is required
  const prompt = promptWords.join(' ');
  if (!isPipeline && !prompt) {
    return err(
      'Usage: beat schedule create <prompt> --cron "..." | --at "..." [options]\n  Pipeline: beat schedule create --pipeline --step "lint" --step "test" --cron "0 9 * * *"',
    );
  }

  const shared = {
    scheduleType,
    cronExpression,
    scheduledAt,
    timezone,
    missedRunPolicy,
    priority,
    workingDirectory,
    maxRuns,
    expiresAt,
    afterScheduleId,
    agent,
  };

  if (isPipeline) {
    return ok({ ...shared, isPipeline: true as const, pipelineSteps });
  }
  return ok({ ...shared, isPipeline: false as const, prompt });
}

export async function handleScheduleCommand(subCmd: string | undefined, scheduleArgs: string[]): Promise<void> {
  if (!subCmd) {
    ui.error('Usage: beat schedule <create|list|get|cancel|pause|resume>');
    process.exit(1);
  }

  // Read-only subcommands: lightweight context, no full bootstrap
  if (subCmd === 'list' || subCmd === 'get') {
    const s = ui.createSpinner();
    s.start(subCmd === 'list' ? 'Fetching schedules...' : 'Fetching schedule...');
    const ctx = withReadOnlyContext(s);
    s.stop('Ready');

    try {
      if (subCmd === 'list') {
        await scheduleList(ctx.scheduleRepository, scheduleArgs);
      } else {
        await scheduleGet(ctx.scheduleRepository, scheduleArgs);
      }
    } finally {
      ctx.close();
    }
    process.exit(0);
  }

  // Mutation subcommands: full bootstrap
  const s = ui.createSpinner();
  s.start('Initializing...');
  const { scheduleService } = await withServices(s);
  s.stop('Ready');

  switch (subCmd) {
    case 'create':
      await scheduleCreate(scheduleService, scheduleArgs);
      break;
    case 'cancel':
      await scheduleCancel(scheduleService, scheduleArgs);
      break;
    case 'pause':
      await schedulePause(scheduleService, scheduleArgs);
      break;
    case 'resume':
      await scheduleResume(scheduleService, scheduleArgs);
      break;
    default:
      ui.error(`Unknown schedule subcommand: ${subCmd}`);
      process.stderr.write('Valid subcommands: create, list, get, cancel, pause, resume\n');
      process.exit(1);
  }
  process.exit(0);
}

async function scheduleCreate(service: ScheduleService, scheduleArgs: string[]): Promise<void> {
  const parsed = parseScheduleCreateArgs(scheduleArgs);
  if (!parsed.ok) {
    ui.error(parsed.error);
    process.exit(1);
  }
  const args = parsed.value;

  const baseOptions = {
    scheduleType: args.scheduleType === 'cron' ? ScheduleType.CRON : ScheduleType.ONE_TIME,
    cronExpression: args.cronExpression,
    scheduledAt: args.scheduledAt,
    timezone: args.timezone,
    missedRunPolicy: args.missedRunPolicy ? toMissedRunPolicy(args.missedRunPolicy) : undefined,
    priority: args.priority ? Priority[args.priority] : undefined,
    workingDirectory: args.workingDirectory,
    maxRuns: args.maxRuns,
    expiresAt: args.expiresAt,
    afterScheduleId: args.afterScheduleId ? ScheduleId(args.afterScheduleId) : undefined,
    agent: args.agent,
  };

  // Scheduled loop (v0.8.0)
  if (args.isLoop) {
    const lc = args.loopConfig;
    const result = await service.createScheduledLoop({
      loopConfig: {
        prompt: lc.prompt,
        strategy: lc.strategy,
        exitCondition: lc.exitCondition,
        evalDirection: toOptimizeDirection(lc.evalDirection),
        evalTimeout: lc.evalTimeout,
        workingDirectory: args.workingDirectory,
        maxIterations: lc.maxIterations,
        maxConsecutiveFailures: lc.maxConsecutiveFailures,
        cooldownMs: lc.cooldownMs,
        freshContext: lc.freshContext,
        pipelineSteps: lc.pipelineSteps,
        gitBranch: lc.gitBranch,
        priority: args.priority ? Priority[args.priority] : undefined,
        agent: args.agent,
      },
      ...baseOptions,
    });

    const created = exitOnError(result, undefined, 'Failed to create scheduled loop');
    ui.success(`Scheduled loop created: ${created.id}`);
    const details = [`Type: ${created.scheduleType}`, `Status: ${created.status}`, `Strategy: ${lc.strategy}`];
    if (created.nextRunAt) details.push(`Next run: ${new Date(created.nextRunAt).toISOString()}`);
    if (created.cronExpression) details.push(`Cron: ${created.cronExpression}`);
    ui.info(details.join(' | '));
    return;
  }

  if (args.isPipeline) {
    const result = await service.createScheduledPipeline({
      ...baseOptions,
      steps: args.pipelineSteps.map((prompt) => ({ prompt })),
    });

    const pipeline = exitOnError(result, undefined, 'Failed to create scheduled pipeline');
    ui.success(`Scheduled pipeline created: ${pipeline.id}`);
    const details = [
      `Type: ${pipeline.scheduleType}`,
      `Steps: ${pipeline.pipelineSteps?.length ?? 0}`,
      `Status: ${pipeline.status}`,
    ];
    if (pipeline.nextRunAt) details.push(`Next run: ${new Date(pipeline.nextRunAt).toISOString()}`);
    if (pipeline.cronExpression) details.push(`Cron: ${pipeline.cronExpression}`);
    if (args.agent) details.push(`Agent: ${args.agent}`);
    ui.info(details.join(' | '));
    return;
  }

  const result = await service.createSchedule({
    ...baseOptions,
    prompt: args.prompt,
  });

  const created = exitOnError(result, undefined, 'Failed to create schedule');
  ui.success(`Schedule created: ${created.id}`);
  const details = [`Type: ${created.scheduleType}`, `Status: ${created.status}`];
  if (created.nextRunAt) details.push(`Next run: ${new Date(created.nextRunAt).toISOString()}`);
  if (created.cronExpression) details.push(`Cron: ${created.cronExpression}`);
  if (created.afterScheduleId) details.push(`After: ${created.afterScheduleId}`);
  if (args.agent) details.push(`Agent: ${args.agent}`);
  ui.info(details.join(' | '));
}

async function scheduleList(repo: ScheduleRepository, scheduleArgs: string[]): Promise<void> {
  let status: string | undefined;
  let limit: number | undefined;

  for (let i = 0; i < scheduleArgs.length; i++) {
    const arg = scheduleArgs[i];
    const next = scheduleArgs[i + 1];

    if (arg === '--status' && next) {
      status = next;
      i++;
    } else if (arg === '--limit' && next) {
      limit = parseInt(next, 10);
      i++;
    }
  }

  const validStatuses = Object.values(ScheduleStatus);

  let statusValue: ScheduleStatus | undefined;
  if (status) {
    const normalized = status.toLowerCase();
    statusValue = validStatuses.find((v) => v === normalized);
    if (!statusValue) {
      ui.error(`Invalid status: ${status}. Valid values: ${validStatuses.join(', ')}`);
      process.exit(1);
    }
  }

  const result = statusValue ? await repo.findByStatus(statusValue, limit) : await repo.findAll(limit);
  const schedules = exitOnError(result, undefined, 'Failed to list schedules');

  if (schedules.length === 0) {
    ui.info('No schedules found');
  } else {
    for (const s of schedules) {
      const nextRun = s.nextRunAt ? new Date(s.nextRunAt).toISOString() : 'none';
      ui.step(
        `${ui.dim(s.id)}  ${ui.colorStatus(s.status.padEnd(10))}  ${s.scheduleType}  runs: ${s.runCount}${s.maxRuns ? '/' + s.maxRuns : ''}  next: ${nextRun}`,
      );
    }
    ui.info(`${schedules.length} schedule${schedules.length === 1 ? '' : 's'}`);
  }
}

async function scheduleGet(repo: ScheduleRepository, scheduleArgs: string[]): Promise<void> {
  const scheduleId = scheduleArgs[0];
  if (!scheduleId) {
    ui.error('Usage: beat schedule get <schedule-id> [--history] [--history-limit N]');
    process.exit(1);
  }

  const includeHistory = scheduleArgs.includes('--history');
  let historyLimit: number | undefined;
  const hlIdx = scheduleArgs.indexOf('--history-limit');
  if (hlIdx !== -1 && scheduleArgs[hlIdx + 1]) {
    historyLimit = parseInt(scheduleArgs[hlIdx + 1], 10);
  }

  const scheduleResult = await repo.findById(ScheduleId(scheduleId));
  const found = exitOnError(scheduleResult, undefined, 'Failed to get schedule');
  const schedule = exitOnNull(found, undefined, `Schedule ${scheduleId} not found`);

  let history: readonly ScheduleExecution[] | undefined;
  if (includeHistory) {
    const historyResult = await repo.getExecutionHistory(ScheduleId(scheduleId), historyLimit);
    history = exitOnError(historyResult, undefined, 'Failed to fetch execution history');
  }

  const lines: string[] = [];
  lines.push(`ID:          ${schedule.id}`);
  lines.push(`Status:      ${ui.colorStatus(schedule.status)}`);
  lines.push(`Type:        ${schedule.scheduleType}`);
  if (schedule.cronExpression) lines.push(`Cron:        ${schedule.cronExpression}`);
  if (schedule.scheduledAt) lines.push(`Scheduled:   ${new Date(schedule.scheduledAt).toISOString()}`);
  lines.push(`Timezone:    ${schedule.timezone}`);
  lines.push(`Missed Policy: ${schedule.missedRunPolicy}`);
  lines.push(`Run Count:   ${schedule.runCount}${schedule.maxRuns ? '/' + schedule.maxRuns : ''}`);
  if (schedule.lastRunAt) lines.push(`Last Run:    ${new Date(schedule.lastRunAt).toISOString()}`);
  if (schedule.nextRunAt) lines.push(`Next Run:    ${new Date(schedule.nextRunAt).toISOString()}`);
  if (schedule.expiresAt) lines.push(`Expires:     ${new Date(schedule.expiresAt).toISOString()}`);
  if (schedule.afterScheduleId) lines.push(`After:       ${schedule.afterScheduleId}`);
  lines.push(`Created:     ${new Date(schedule.createdAt).toISOString()}`);
  lines.push(`Prompt:      ${truncatePrompt(schedule.taskTemplate.prompt, 100)}`);
  if (schedule.taskTemplate.agent) lines.push(`Agent:       ${schedule.taskTemplate.agent}`);

  if (schedule.pipelineSteps && schedule.pipelineSteps.length > 0) {
    lines.push(`Pipeline:    ${schedule.pipelineSteps.length} steps`);
    for (let i = 0; i < schedule.pipelineSteps.length; i++) {
      const step = schedule.pipelineSteps[i];
      const stepInfo = `  Step ${i + 1}: ${truncatePrompt(step.prompt, 60)}`;
      lines.push(stepInfo);
    }
  }

  ui.note(lines.join('\n'), 'Schedule Details');

  if (history && history.length > 0) {
    ui.step(`Execution History (${history.length} entries)`);
    for (const h of history) {
      const scheduled = new Date(h.scheduledFor).toISOString();
      const executed = h.executedAt ? new Date(h.executedAt).toISOString() : 'n/a';
      process.stderr.write(
        `  ${h.status} | scheduled: ${scheduled} | executed: ${executed}${h.taskId ? ' | task: ' + h.taskId : ''}${h.errorMessage ? ' | error: ' + h.errorMessage : ''}\n`,
      );
    }
  }
}

async function scheduleCancel(service: ScheduleService, scheduleArgs: string[]): Promise<void> {
  let cancelTasks = false;
  const filteredArgs: string[] = [];

  for (const arg of scheduleArgs) {
    if (arg === '--cancel-tasks') {
      cancelTasks = true;
    } else {
      filteredArgs.push(arg);
    }
  }

  const scheduleId = filteredArgs[0];
  if (!scheduleId) {
    ui.error('Usage: beat schedule cancel <schedule-id> [--cancel-tasks] [reason]');
    process.exit(1);
  }
  const reason = filteredArgs.slice(1).join(' ') || undefined;

  const result = await service.cancelSchedule(ScheduleId(scheduleId), reason, cancelTasks);
  exitOnError(result, undefined, 'Failed to cancel schedule');
  ui.success(`Schedule ${scheduleId} cancelled`);
  if (cancelTasks) ui.info('In-flight tasks also cancelled');
  if (reason) ui.info(`Reason: ${reason}`);
}

async function schedulePause(service: ScheduleService, scheduleArgs: string[]): Promise<void> {
  const scheduleId = scheduleArgs[0];
  if (!scheduleId) {
    ui.error('Usage: beat schedule pause <schedule-id>');
    process.exit(1);
  }

  const result = await service.pauseSchedule(ScheduleId(scheduleId));
  exitOnError(result, undefined, 'Failed to pause schedule');
  ui.success(`Schedule ${scheduleId} paused`);
}

async function scheduleResume(service: ScheduleService, scheduleArgs: string[]): Promise<void> {
  const scheduleId = scheduleArgs[0];
  if (!scheduleId) {
    ui.error('Usage: beat schedule resume <schedule-id>');
    process.exit(1);
  }

  const result = await service.resumeSchedule(ScheduleId(scheduleId));
  exitOnError(result, undefined, 'Failed to resume schedule');
  ui.success(`Schedule ${scheduleId} resumed`);
}
