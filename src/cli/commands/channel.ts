/**
 * Channel CLI commands
 *
 * ARCHITECTURE: Provides CLI surface for the channel service layer (Phase 7).
 * Pure argument parsing functions are exported for testability; subcommand
 * handlers are side-effecting and not exported.
 *
 * ADR-001: Channel name validation uses CHANNEL_NAME_REGEX to ensure channel
 * names are valid tmux session name suffixes (no transformation required).
 */

import { AGENT_PROVIDERS, isAgentProvider } from '../../core/agents.js';
import { CHANNEL_NAME_REGEX, ChannelId, ChannelStatus, type CommunicationMode } from '../../core/domain.js';
import type { ChannelRepository } from '../../core/interfaces.js';
import { err, ok, type Result } from '../../core/result.js';
import { validatePath } from '../../utils/validation.js';
import { exitOnError, exitOnNull, withReadOnlyContext, withServices } from '../services.js';
import * as ui from '../ui.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Parsed member from --member name:agent[:prompt] flag.
 * Prompt may contain colons — split on first two colons only.
 */
interface ParsedMember {
  readonly name: string;
  readonly agent: string;
  readonly systemPrompt?: string;
}

/**
 * Single-agent channel creation (--agent flag, no --member flags).
 * Member name equals channel name; no mode or maxRounds required.
 */
interface ParsedChannelCreateSingle {
  readonly mode: 'single';
  readonly name: string;
  readonly agent: string;
  readonly topic?: string;
  readonly workingDirectory?: string;
  readonly systemPrompt?: string;
}

/**
 * Multi-agent channel creation (one or more --member flags).
 * Requires --max-rounds; accepts --mode.
 */
interface ParsedChannelCreateMulti {
  readonly mode: 'multi';
  readonly name: string;
  readonly members: readonly ParsedMember[];
  readonly communicationMode?: CommunicationMode;
  readonly maxRounds: number;
  readonly topic?: string;
  readonly workingDirectory?: string;
}

export type ParsedChannelCreate = ParsedChannelCreateSingle | ParsedChannelCreateMulti;

// ─── Pure parsing functions ────────────────────────────────────────────────────

/**
 * Parse and validate channel create arguments.
 * ARCHITECTURE: Pure function — no side effects, returns Result for testability.
 *
 * Two modes:
 * - Single-agent: --agent <provider> flag present, no --member flags.
 *   Member name = channel name. No --mode or --max-rounds required.
 * - Multi-agent: --member name:agent[:prompt] flags. Requires --max-rounds.
 *   Accepts --mode broadcast|directed|round-robin.
 * Mutual exclusion: --agent + --member together → error.
 */
export function parseChannelCreateArgs(args: readonly string[]): Result<ParsedChannelCreate, string> {
  // First positional argument is the channel name
  const positional: string[] = [];
  const members: ParsedMember[] = [];
  let agentFlag: string | undefined;
  let communicationMode: CommunicationMode | undefined;
  let maxRounds: number | undefined;
  let topic: string | undefined;
  let workingDirectory: string | undefined;
  let systemPrompt: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if ((arg === '--agent' || arg === '-a') && next !== undefined) {
      agentFlag = next;
      i++;
    } else if (arg === '--member' && next !== undefined) {
      const memberResult = parseMemberFlag(next);
      if (!memberResult.ok) return memberResult;
      members.push(memberResult.value);
      i++;
    } else if (arg === '--mode' && next !== undefined) {
      if (next !== 'broadcast' && next !== 'directed' && next !== 'round-robin') {
        return err(`--mode must be broadcast, directed, or round-robin (got "${next}")`);
      }
      communicationMode = next as CommunicationMode;
      i++;
    } else if (arg === '--max-rounds' && next !== undefined) {
      const n = Number(next);
      if (!Number.isInteger(n) || n < 1 || n > 10000) {
        return err('--max-rounds must be an integer between 1 and 10000');
      }
      maxRounds = n;
      i++;
    } else if (arg === '--topic' && next !== undefined) {
      topic = next;
      i++;
    } else if ((arg === '--working-directory' || arg === '-w') && next !== undefined) {
      workingDirectory = next;
      i++;
    } else if (arg === '--system-prompt' && next !== undefined) {
      systemPrompt = next;
      i++;
    } else if (arg.startsWith('-')) {
      return err(`Unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  const channelName = positional[0];
  if (!channelName) {
    return err('Usage: beat channel create <name> --agent <provider> | --member name:agent[:prompt]...');
  }

  // Validate channel name
  if (!CHANNEL_NAME_REGEX.test(channelName)) {
    return err(
      `Invalid channel name "${channelName}": must be lowercase alphanumeric with interior hyphens, max 64 chars`,
    );
  }

  // Mutual exclusion: --agent + --member
  if (agentFlag !== undefined && members.length > 0) {
    return err('--agent and --member are mutually exclusive. Use --agent for single-agent, --member for multi-agent.');
  }

  // Single-agent mode
  if (agentFlag !== undefined) {
    if (!isAgentProvider(agentFlag)) {
      return err(`Unknown agent: "${agentFlag}". Available agents: ${AGENT_PROVIDERS.join(', ')}`);
    }
    if (maxRounds !== undefined) {
      return err('--max-rounds is only valid for multi-agent channels (--member). Use --agent for single-agent.');
    }
    if (communicationMode !== undefined) {
      return err('--mode is only valid for multi-agent channels (--member). Use --agent for single-agent.');
    }
    return ok({
      mode: 'single' as const,
      name: channelName,
      agent: agentFlag,
      topic,
      workingDirectory,
      systemPrompt,
    });
  }

  // Multi-agent mode
  if (members.length === 0) {
    return err('Provide --agent <provider> for single-agent or --member name:agent[:prompt] for multi-agent channels.');
  }

  if (maxRounds === undefined) {
    return err('--max-rounds is required for multi-agent channels');
  }

  // Validate all member agents
  for (const member of members) {
    if (!isAgentProvider(member.agent)) {
      return err(
        `Unknown agent "${member.agent}" for member "${member.name}". Available: ${AGENT_PROVIDERS.join(', ')}`,
      );
    }
    if (!CHANNEL_NAME_REGEX.test(member.name)) {
      return err(
        `Invalid member name "${member.name}": must be lowercase alphanumeric with interior hyphens, max 64 chars`,
      );
    }
  }

  // --system-prompt is single-agent only
  if (systemPrompt !== undefined) {
    return err(
      '--system-prompt is only valid for single-agent channels (--agent). Use --member name:agent:prompt for per-member prompts.',
    );
  }

  return ok({
    mode: 'multi' as const,
    name: channelName,
    members,
    communicationMode,
    maxRounds,
    topic,
    workingDirectory,
  });
}

/**
 * Parse a --member flag value: name:agent[:prompt]
 * Prompt may contain colons — split on first colon only after agent.
 */
function parseMemberFlag(value: string): Result<ParsedMember, string> {
  // Split on first colon to get name
  const firstColon = value.indexOf(':');
  if (firstColon === -1) {
    return err(`--member requires format "name:agent[:prompt]", got "${value}"`);
  }

  const name = value.slice(0, firstColon);
  const rest = value.slice(firstColon + 1);

  if (!name) {
    return err(`--member name cannot be empty in "${value}"`);
  }

  // Split rest on first colon to get agent and optional prompt
  const secondColon = rest.indexOf(':');
  let agent: string;
  let systemPrompt: string | undefined;

  if (secondColon === -1) {
    agent = rest;
  } else {
    agent = rest.slice(0, secondColon);
    const promptPart = rest.slice(secondColon + 1);
    systemPrompt = promptPart || undefined;
  }

  if (!agent) {
    return err(`--member agent cannot be empty in "${value}"`);
  }

  return ok({ name, agent, systemPrompt });
}

// ─── Subcommand router ────────────────────────────────────────────────────────

export async function handleChannelCommand(subCmd: string | undefined, channelArgs: string[]): Promise<void> {
  if (subCmd === 'list') {
    await handleChannelList(channelArgs);
    return;
  }
  if (subCmd === 'status') {
    await handleChannelStatus(channelArgs);
    return;
  }
  if (subCmd === 'destroy') {
    await handleChannelDestroy(channelArgs);
    return;
  }
  if (subCmd === 'pause') {
    await handleChannelPause(channelArgs);
    return;
  }
  if (subCmd === 'resume') {
    await handleChannelResume(channelArgs);
    return;
  }

  // Default: create (subCmd is the channel name or a flag)
  const createArgs = subCmd ? [subCmd, ...channelArgs] : channelArgs;
  await handleChannelCreate(createArgs);
}

// ─── Resolve channel by ID or name ───────────────────────────────────────────

/**
 * Resolve a channel ID or name string to a ChannelId.
 * IDs start with 'ch-'; names are resolved via findByName().
 */
async function resolveChannelId(idOrName: string, channelRepository: ChannelRepository): Promise<ChannelId | null> {
  if (idOrName.startsWith('ch-')) {
    return ChannelId(idOrName);
  }
  const result = await channelRepository.findByName(idOrName);
  if (!result.ok) return null;
  if (!result.value) return null;
  return result.value.id;
}

// ─── Create ──────────────────────────────────────────────────────────────────

async function handleChannelCreate(args: string[]): Promise<void> {
  const parsed = parseChannelCreateArgs(args);
  if (!parsed.ok) {
    ui.error(parsed.error);
    process.exit(1);
  }
  const createArgs = parsed.value;

  const s = ui.createSpinner();
  s.start('Creating channel...');
  const { channelService } = await withServices(s);

  if (!channelService) {
    s.stop('Failed');
    ui.error('Channel service unavailable. Ensure the server is properly configured.');
    process.exit(1);
  }

  let result;
  if (createArgs.mode === 'single') {
    result = await channelService.createChannel({
      name: createArgs.name,
      members: [
        {
          name: createArgs.name,
          agent: createArgs.agent as import('../../core/agents.js').AgentProvider,
          systemPrompt: createArgs.systemPrompt,
        },
      ],
      topic: createArgs.topic,
      workingDirectory: createArgs.workingDirectory,
    });
  } else {
    result = await channelService.createChannel({
      name: createArgs.name,
      members: createArgs.members.map((m) => ({
        name: m.name,
        agent: m.agent as import('../../core/agents.js').AgentProvider,
        systemPrompt: m.systemPrompt,
      })),
      communicationMode: createArgs.communicationMode,
      maxRounds: createArgs.maxRounds,
      topic: createArgs.topic,
      workingDirectory: createArgs.workingDirectory,
    });
  }

  const channel = exitOnError(result, s, 'Failed to create channel');
  s.stop('Channel created');

  ui.success(`Channel created: ${channel.id}`);
  const details = [`Name: ${channel.name}`, `Members: ${channel.members.length}`, `Status: ${channel.status}`];
  if (channel.communicationMode) details.push(`Mode: ${channel.communicationMode}`);
  if (channel.maxRounds !== undefined) details.push(`Max rounds: ${channel.maxRounds}`);
  ui.info(details.join(' | '));
  process.exit(0);
}

// ─── List ─────────────────────────────────────────────────────────────────────

async function handleChannelList(args: string[]): Promise<void> {
  let statusFilter: string | undefined;
  let limit: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === '--status' && next) {
      statusFilter = next;
      i++;
    } else if (arg === '--limit' && next) {
      limit = parseInt(next, 10);
      i++;
    }
  }

  const validStatuses = Object.values(ChannelStatus);
  let statusValue: ChannelStatus | undefined;
  if (statusFilter) {
    const normalized = statusFilter.toLowerCase();
    statusValue = validStatuses.find((v) => v === normalized);
    if (!statusValue) {
      ui.error(`Invalid status: ${statusFilter}. Valid values: ${validStatuses.join(', ')}`);
      process.exit(1);
    }
  }

  const s = ui.createSpinner();
  s.start('Fetching channels...');
  const ctx = withReadOnlyContext(s);
  s.stop('Ready');

  try {
    const result = statusValue
      ? await ctx.channelRepository.findByStatus(statusValue, limit)
      : await ctx.channelRepository.findAll(limit);
    const channels = exitOnError(result, undefined, 'Failed to list channels');

    if (channels.length === 0) {
      ui.info('No channels found');
    } else {
      for (const ch of channels) {
        const memberSummary = ch.members.map((m) => m.name).join(', ');
        ui.step(
          `${ui.dim(ch.id)}  ${ui.colorStatus(ch.status.padEnd(10))}  ${ch.name}  members: ${ch.members.length} (${memberSummary})`,
        );
      }
      ui.info(`${channels.length} channel${channels.length === 1 ? '' : 's'}`);
    }
  } finally {
    ctx.close();
  }
  process.exit(0);
}

// ─── Status ───────────────────────────────────────────────────────────────────

async function handleChannelStatus(args: string[]): Promise<void> {
  const idOrName = args[0];
  if (!idOrName) {
    ui.error('Usage: beat channel status <channel-id|name>');
    process.exit(1);
  }

  const s = ui.createSpinner();
  s.start('Fetching channel...');
  const ctx = withReadOnlyContext(s);
  s.stop('Ready');

  try {
    const channelId = await resolveChannelId(idOrName, ctx.channelRepository);
    if (!channelId) {
      const findResult = await ctx.channelRepository.findByName(idOrName);
      if (!findResult.ok) {
        ui.error(`Failed to look up channel: ${findResult.error.message}`);
        process.exit(1);
      }
    }

    const resolvedId = channelId;
    if (!resolvedId) {
      ui.error(`Channel not found: ${idOrName}`);
      process.exit(1);
    }

    const channelResult = await ctx.channelRepository.findById(resolvedId);
    const channel = exitOnNull(
      exitOnError(channelResult, undefined, 'Failed to get channel'),
      undefined,
      `Channel ${idOrName} not found`,
    );

    const lines: string[] = [];
    lines.push(`ID:            ${channel.id}`);
    lines.push(`Name:          ${channel.name}`);
    lines.push(`Status:        ${ui.colorStatus(channel.status)}`);
    lines.push(`Members:       ${channel.members.length}`);
    if (channel.communicationMode) lines.push(`Mode:          ${channel.communicationMode}`);
    if (channel.maxRounds !== undefined) {
      lines.push(`Rounds:        ${channel.currentRound}/${channel.maxRounds}`);
    } else {
      lines.push(`Round:         ${channel.currentRound}`);
    }
    if (channel.topic) lines.push(`Topic:         ${channel.topic}`);
    lines.push(`Created:       ${new Date(channel.createdAt).toISOString()}`);

    if (channel.members.length > 0) {
      lines.push('Members:');
      for (const m of channel.members) {
        lines.push(`  ${m.name}  ${m.agent}  ${ui.colorStatus(m.status)}`);
      }
    }

    ui.note(lines.join('\n'), 'Channel Details');
  } finally {
    ctx.close();
  }
  process.exit(0);
}

// ─── Destroy ─────────────────────────────────────────────────────────────────

async function handleChannelDestroy(args: string[]): Promise<void> {
  const idOrName = args[0];
  if (!idOrName) {
    ui.error('Usage: beat channel destroy <channel-id|name> [reason]');
    process.exit(1);
  }
  const reason = args.slice(1).join(' ') || undefined;

  const s = ui.createSpinner();
  s.start('Destroying channel...');
  const { channelService } = await withServices(s);

  if (!channelService) {
    s.stop('Failed');
    ui.error('Channel service unavailable.');
    process.exit(1);
  }

  // Resolve name → ID if needed
  const ctx = withReadOnlyContext();
  let channelId: ChannelId;
  try {
    const resolved = await resolveChannelId(idOrName, ctx.channelRepository);
    if (!resolved) {
      s.stop('Not found');
      ui.error(`Channel not found: ${idOrName}`);
      process.exit(1);
    }
    channelId = resolved;
  } finally {
    ctx.close();
  }

  const result = await channelService.destroyChannel(channelId, reason ? 'user-requested' : 'user-requested');
  exitOnError(result, s, 'Failed to destroy channel');
  s.stop('Destroyed');
  ui.success(`Channel ${idOrName} destroyed`);
  if (reason) ui.info(`Reason: ${reason}`);
  process.exit(0);
}

// ─── Pause ───────────────────────────────────────────────────────────────────

async function handleChannelPause(args: string[]): Promise<void> {
  const idOrName = args[0];
  if (!idOrName) {
    ui.error('Usage: beat channel pause <channel-id|name>');
    process.exit(1);
  }

  const s = ui.createSpinner();
  s.start('Pausing channel...');
  const { channelService } = await withServices(s);

  if (!channelService) {
    s.stop('Failed');
    ui.error('Channel service unavailable.');
    process.exit(1);
  }

  const ctx = withReadOnlyContext();
  let channelId: ChannelId;
  try {
    const resolved = await resolveChannelId(idOrName, ctx.channelRepository);
    if (!resolved) {
      s.stop('Not found');
      ui.error(`Channel not found: ${idOrName}`);
      process.exit(1);
    }
    channelId = resolved;
  } finally {
    ctx.close();
  }

  const result = await channelService.pauseChannel(channelId);
  exitOnError(result, s, 'Failed to pause channel');
  s.stop('Paused');
  ui.success(`Channel ${idOrName} paused`);
  process.exit(0);
}

// ─── Resume ──────────────────────────────────────────────────────────────────

async function handleChannelResume(args: string[]): Promise<void> {
  const idOrName = args[0];
  if (!idOrName) {
    ui.error('Usage: beat channel resume <channel-id|name>');
    process.exit(1);
  }

  const s = ui.createSpinner();
  s.start('Resuming channel...');
  const { channelService } = await withServices(s);

  if (!channelService) {
    s.stop('Failed');
    ui.error('Channel service unavailable.');
    process.exit(1);
  }

  const ctx = withReadOnlyContext();
  let channelId: ChannelId;
  try {
    const resolved = await resolveChannelId(idOrName, ctx.channelRepository);
    if (!resolved) {
      s.stop('Not found');
      ui.error(`Channel not found: ${idOrName}`);
      process.exit(1);
    }
    channelId = resolved;
  } finally {
    ctx.close();
  }

  const result = await channelService.resumeChannel(channelId);
  exitOnError(result, s, 'Failed to resume channel');
  s.stop('Resumed');
  ui.success(`Channel ${idOrName} resumed`);
  process.exit(0);
}
