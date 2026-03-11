import { AGENT_PROVIDERS, type AgentProvider, isAgentProvider } from '../../core/agents.js';
import { ScheduleId } from '../../core/domain.js';
import type { ScheduleService } from '../../core/interfaces.js';
import { validatePath } from '../../utils/validation.js';
import { withServices } from '../services.js';
import * as ui from '../ui.js';

export async function handleScheduleCommand(subCmd: string | undefined, scheduleArgs: string[]) {
  if (!subCmd) {
    ui.error('Usage: beat schedule <create|list|get|cancel|pause|resume>');
    process.exit(1);
  }

  const s = ui.createSpinner();
  s.start('Initializing...');
  const { scheduleService } = await withServices(s);
  s.stop('Ready');

  switch (subCmd) {
    case 'create':
      await scheduleCreate(scheduleService, scheduleArgs);
      break;
    case 'list':
      await scheduleList(scheduleService, scheduleArgs);
      break;
    case 'get':
      await scheduleGet(scheduleService, scheduleArgs);
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

async function scheduleCreate(service: ScheduleService, scheduleArgs: string[]) {
  let promptWords: string[] = [];
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

  for (let i = 0; i < scheduleArgs.length; i++) {
    const arg = scheduleArgs[i];
    const next = scheduleArgs[i + 1];

    if (arg === '--type' && next) {
      if (next !== 'cron' && next !== 'one_time') {
        ui.error('--type must be "cron" or "one_time"');
        process.exit(1);
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
        ui.error('--missed-run-policy must be "skip", "catchup", or "fail"');
        process.exit(1);
      }
      missedRunPolicy = next as 'skip' | 'catchup' | 'fail';
      i++;
    } else if ((arg === '--priority' || arg === '-p') && next) {
      if (!['P0', 'P1', 'P2'].includes(next)) {
        ui.error('Priority must be P0, P1, or P2');
        process.exit(1);
      }
      priority = next as 'P0' | 'P1' | 'P2';
      i++;
    } else if ((arg === '--working-directory' || arg === '-w') && next) {
      const pathResult = validatePath(next);
      if (!pathResult.ok) {
        ui.error(`Invalid working directory: ${pathResult.error.message}`);
        process.exit(1);
      }
      workingDirectory = pathResult.value;
      i++;
    } else if (arg === '--max-runs' && next) {
      maxRuns = parseInt(next);
      if (isNaN(maxRuns) || maxRuns < 1) {
        ui.error('--max-runs must be a positive integer');
        process.exit(1);
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
        ui.error(`--agent requires an agent name (${AGENT_PROVIDERS.join(', ')})`);
        process.exit(1);
      }
      if (!isAgentProvider(next)) {
        ui.error(`Unknown agent: "${next}". Available agents: ${AGENT_PROVIDERS.join(', ')}`);
        process.exit(1);
      }
      agent = next;
      i++;
    } else if (arg === '--pipeline') {
      isPipeline = true;
    } else if (arg === '--step' && next) {
      pipelineSteps.push(next);
      i++;
    } else if (arg.startsWith('-')) {
      ui.error(`Unknown flag: ${arg}`);
      process.exit(1);
    } else {
      promptWords.push(arg);
    }
  }

  // Infer type from --cron / --at flags
  if (cronExpression && scheduledAt) {
    ui.error('Cannot specify both --cron and --at');
    process.exit(1);
  }
  const inferredType = cronExpression ? 'cron' : scheduledAt ? 'one_time' : undefined;
  if (scheduleType && inferredType && scheduleType !== inferredType) {
    ui.error(`--type ${scheduleType} conflicts with ${cronExpression ? '--cron' : '--at'}`);
    process.exit(1);
  }
  scheduleType = scheduleType ?? inferredType;
  if (!scheduleType) {
    ui.error('Provide --cron, --at, or --type');
    process.exit(1);
  }

  const { ScheduleType, MissedRunPolicy, Priority } = await import('../../core/domain.js');

  // Pipeline mode: --pipeline with --step flags
  if (isPipeline) {
    if (pipelineSteps.length < 2) {
      ui.error('Pipeline requires at least 2 --step flags');
      process.exit(1);
    }

    const result = await service.createScheduledPipeline({
      steps: pipelineSteps.map((prompt) => ({ prompt })),
      scheduleType: scheduleType === 'cron' ? ScheduleType.CRON : ScheduleType.ONE_TIME,
      cronExpression,
      scheduledAt,
      timezone,
      missedRunPolicy:
        missedRunPolicy === 'catchup'
          ? MissedRunPolicy.CATCHUP
          : missedRunPolicy === 'fail'
            ? MissedRunPolicy.FAIL
            : missedRunPolicy
              ? MissedRunPolicy.SKIP
              : undefined,
      priority: priority ? Priority[priority] : undefined,
      workingDirectory,
      maxRuns,
      expiresAt,
      afterScheduleId: afterScheduleId ? ScheduleId(afterScheduleId) : undefined,
      agent,
    });

    if (result.ok) {
      ui.success(`Scheduled pipeline created: ${result.value.id}`);
      const details = [
        `Type: ${result.value.scheduleType}`,
        `Steps: ${result.value.pipelineSteps?.length ?? 0}`,
        `Status: ${result.value.status}`,
      ];
      if (result.value.nextRunAt) details.push(`Next run: ${new Date(result.value.nextRunAt).toISOString()}`);
      if (result.value.cronExpression) details.push(`Cron: ${result.value.cronExpression}`);
      if (agent) details.push(`Agent: ${agent}`);
      ui.info(details.join(' | '));
      process.exit(0);
    } else {
      ui.error(`Failed to create scheduled pipeline: ${result.error.message}`);
      process.exit(1);
    }
    return;
  }

  // Single-task mode
  const prompt = promptWords.join(' ');
  if (!prompt) {
    ui.error('Usage: beat schedule create <prompt> --cron "..." | --at "..." [options]');
    ui.info('  Pipeline: beat schedule create --pipeline --step "lint" --step "test" --cron "0 9 * * *"');
    process.exit(1);
  }

  const result = await service.createSchedule({
    prompt,
    scheduleType: scheduleType === 'cron' ? ScheduleType.CRON : ScheduleType.ONE_TIME,
    cronExpression,
    scheduledAt,
    timezone,
    missedRunPolicy:
      missedRunPolicy === 'catchup'
        ? MissedRunPolicy.CATCHUP
        : missedRunPolicy === 'fail'
          ? MissedRunPolicy.FAIL
          : missedRunPolicy
            ? MissedRunPolicy.SKIP
            : undefined,
    priority: priority ? Priority[priority] : undefined,
    workingDirectory,
    maxRuns,
    expiresAt,
    afterScheduleId: afterScheduleId ? ScheduleId(afterScheduleId) : undefined,
    agent,
  });

  if (result.ok) {
    ui.success(`Schedule created: ${result.value.id}`);
    const details = [`Type: ${result.value.scheduleType}`, `Status: ${result.value.status}`];
    if (result.value.nextRunAt) details.push(`Next run: ${new Date(result.value.nextRunAt).toISOString()}`);
    if (result.value.cronExpression) details.push(`Cron: ${result.value.cronExpression}`);
    if (result.value.afterScheduleId) details.push(`After: ${result.value.afterScheduleId}`);
    if (agent) details.push(`Agent: ${agent}`);
    ui.info(details.join(' | '));
    process.exit(0);
  } else {
    ui.error(`Failed to create schedule: ${result.error.message}`);
    process.exit(1);
  }
}

async function scheduleList(service: ScheduleService, scheduleArgs: string[]) {
  let status: string | undefined;
  let limit: number | undefined;

  for (let i = 0; i < scheduleArgs.length; i++) {
    const arg = scheduleArgs[i];
    const next = scheduleArgs[i + 1];

    if (arg === '--status' && next) {
      status = next;
      i++;
    } else if (arg === '--limit' && next) {
      limit = parseInt(next);
      i++;
    }
  }

  const { ScheduleStatus } = await import('../../core/domain.js');
  const statusEnum = status ? (status as keyof typeof ScheduleStatus) : undefined;

  const result = await service.listSchedules(
    statusEnum ? ScheduleStatus[statusEnum.toUpperCase() as keyof typeof ScheduleStatus] : undefined,
    limit,
  );

  if (result.ok) {
    const schedules = result.value;
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
  } else {
    ui.error(`Failed to list schedules: ${result.error.message}`);
    process.exit(1);
  }
}

async function scheduleGet(service: ScheduleService, scheduleArgs: string[]) {
  const scheduleId = scheduleArgs[0];
  if (!scheduleId) {
    ui.error('Usage: beat schedule get <schedule-id> [--history] [--history-limit N]');
    process.exit(1);
  }

  const includeHistory = scheduleArgs.includes('--history');
  let historyLimit: number | undefined;
  const hlIdx = scheduleArgs.indexOf('--history-limit');
  if (hlIdx !== -1 && scheduleArgs[hlIdx + 1]) {
    historyLimit = parseInt(scheduleArgs[hlIdx + 1]);
  }

  const result = await service.getSchedule(ScheduleId(scheduleId), includeHistory, historyLimit);

  if (result.ok) {
    const { schedule, history } = result.value;
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
    lines.push(
      `Prompt:      ${schedule.taskTemplate.prompt.substring(0, 100)}${schedule.taskTemplate.prompt.length > 100 ? '...' : ''}`,
    );
    if (schedule.taskTemplate.agent) lines.push(`Agent:       ${schedule.taskTemplate.agent}`);

    if (schedule.pipelineSteps && schedule.pipelineSteps.length > 0) {
      lines.push(`Pipeline:    ${schedule.pipelineSteps.length} steps`);
      for (let i = 0; i < schedule.pipelineSteps.length; i++) {
        const step = schedule.pipelineSteps[i];
        const stepInfo = `  Step ${i + 1}: ${step.prompt.substring(0, 60)}${step.prompt.length > 60 ? '...' : ''}`;
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
  } else {
    ui.error(`Failed to get schedule: ${result.error.message}`);
    process.exit(1);
  }
}

async function scheduleCancel(service: ScheduleService, scheduleArgs: string[]) {
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
  if (result.ok) {
    ui.success(`Schedule ${scheduleId} cancelled`);
    if (cancelTasks) ui.info('In-flight tasks also cancelled');
    if (reason) ui.info(`Reason: ${reason}`);
  } else {
    ui.error(`Failed to cancel schedule: ${result.error.message}`);
    process.exit(1);
  }
}

async function schedulePause(service: ScheduleService, scheduleArgs: string[]) {
  const scheduleId = scheduleArgs[0];
  if (!scheduleId) {
    ui.error('Usage: beat schedule pause <schedule-id>');
    process.exit(1);
  }

  const result = await service.pauseSchedule(ScheduleId(scheduleId));
  if (result.ok) {
    ui.success(`Schedule ${scheduleId} paused`);
  } else {
    ui.error(`Failed to pause schedule: ${result.error.message}`);
    process.exit(1);
  }
}

async function scheduleResume(service: ScheduleService, scheduleArgs: string[]) {
  const scheduleId = scheduleArgs[0];
  if (!scheduleId) {
    ui.error('Usage: beat schedule resume <schedule-id>');
    process.exit(1);
  }

  const result = await service.resumeSchedule(ScheduleId(scheduleId));
  if (result.ok) {
    ui.success(`Schedule ${scheduleId} resumed`);
  } else {
    ui.error(`Failed to resume schedule: ${result.error.message}`);
    process.exit(1);
  }
}
