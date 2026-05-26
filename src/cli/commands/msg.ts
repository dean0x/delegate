/**
 * msg CLI command — send a message to a channel member.
 *
 * Usage:
 *   beat msg <channel-name>[/<member-name>] <message text...>
 *
 * ARCHITECTURE: Pure parsing function exported for testability;
 * handler is side-effecting and not exported.
 *
 * ADR-001: Channel name validated against CHANNEL_NAME_REGEX.
 */

import { CHANNEL_NAME_REGEX, type ChannelId, ChannelStatus } from '../../core/domain.js';
import { err, ok, type Result } from '../../core/result.js';
import { exitOnError, withReadOnlyContext, withServices } from '../services.js';
import * as ui from '../ui.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ParsedMsgArgs {
  /** Channel name (validated against CHANNEL_NAME_REGEX) */
  readonly channelName: string;
  /** Optional target member name */
  readonly memberName?: string;
  /** Message text */
  readonly message: string;
}

// ─── Pure parsing ─────────────────────────────────────────────────────────────

/**
 * Parse msg command arguments.
 * ARCHITECTURE: Pure function — no side effects, returns Result for testability.
 *
 * Syntax: <channel-name>[/<member-name>] <message text...>
 * - Split target on first '/' only
 * - Empty member after '/' is an error
 * - Message is args[1..] joined with spaces
 */
export function parseMsgArgs(args: readonly string[]): Result<ParsedMsgArgs, string> {
  const target = args[0];
  if (!target) {
    return err('Usage: beat msg <channel-name>[/<member-name>] <message text...>');
  }

  const messageWords = args.slice(1);
  if (messageWords.length === 0) {
    return err('Message text is required. Usage: beat msg <target> <message...>');
  }
  const message = messageWords.join(' ');

  // Split target on first '/' only
  const slashIndex = target.indexOf('/');
  let channelName: string;
  let memberName: string | undefined;

  if (slashIndex === -1) {
    channelName = target;
  } else {
    channelName = target.slice(0, slashIndex);
    const memberPart = target.slice(slashIndex + 1);
    if (!memberPart) {
      return err(`Empty member name after '/' in "${target}". Use: channel-name/member-name`);
    }
    memberName = memberPart;
  }

  if (!channelName) {
    return err(`Channel name cannot be empty in target "${target}"`);
  }

  if (!CHANNEL_NAME_REGEX.test(channelName)) {
    return err(
      `Invalid channel name "${channelName}": must be lowercase alphanumeric with interior hyphens, max 64 chars`,
    );
  }

  return ok({ channelName, memberName, message });
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handleMsgCommand(args: string[]): Promise<void> {
  const parsed = parseMsgArgs(args);
  if (!parsed.ok) {
    ui.error(parsed.error);
    process.exit(1);
  }
  const { channelName, memberName, message } = parsed.value;

  // Resolve channel name → ID via read-only context
  const ctx = withReadOnlyContext();
  let channelId: ChannelId;
  let channelStatus: ChannelStatus;
  try {
    const channelResult = await ctx.channelRepository.findByName(channelName);
    const channel = exitOnError(channelResult, undefined, `Failed to look up channel "${channelName}"`);

    if (!channel) {
      ui.error(`Channel "${channelName}" not found`);
      process.exit(1);
    }

    // Fast-fail on terminal statuses before calling the service
    if (channel.status === ChannelStatus.DESTROYED) {
      ui.error(
        `Channel "${channelName}" is destroyed. Create a new channel with: beat channel create ${channelName} ...`,
      );
      process.exit(1);
    }
    if (channel.status === ChannelStatus.COMPLETED) {
      ui.error(`Channel "${channelName}" has completed and no longer accepts messages.`);
      process.exit(1);
    }

    channelId = channel.id;
    channelStatus = channel.status;
  } finally {
    ctx.close();
  }

  const s = ui.createSpinner();
  s.start('Sending message...');
  const { channelService } = await withServices(s);

  if (!channelService) {
    s.stop('Failed');
    ui.error('Channel service unavailable.');
    process.exit(1);
  }

  if (channelStatus === ChannelStatus.PAUSED) {
    s.stop('Failed');
    ui.error(`Channel "${channelName}" is paused. Resume with: beat channel resume ${channelName}`);
    process.exit(1);
  }

  const result = await channelService.sendMessage(channelId, message, memberName);
  exitOnError(result, s, 'Failed to send message');
  s.stop('Sent');

  const target = memberName ? `${channelName}/${memberName}` : channelName;
  ui.success(`Message sent to ${target}`);
  process.exit(0);
}
