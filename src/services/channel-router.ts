/**
 * ChannelRouter — pure stateless message routing for multi-agent channels
 *
 * ARCHITECTURE: No I/O, no DI, no side effects. All methods are static.
 * Routing rules are fully deterministic given the channel state.
 * Rationale: Stateless routing logic is trivially unit-testable and can be
 * called from any async context without awaiting.
 *
 * ADR-001: Channel names are already constrained to CHANNEL_NAME_REGEX which
 * ensures compatibility with tmux session names — no transformation needed.
 */

import type { Channel, ChannelMember } from '../core/domain.js';
import { ChannelMemberStatus } from '../core/domain.js';
import { AutobeatError, ErrorCode } from '../core/errors.js';
import { err, ok, type Result } from '../core/result.js';

/**
 * A single routing target — a channel member and their tmux session.
 */
export interface RouteTarget {
  readonly memberName: string;
  readonly tmuxSession: string;
}

/**
 * Result of routing a message through a channel.
 * targets — the members that should receive the message.
 * nextTurnMember — round-robin: the member whose turn it is next (undefined for other modes).
 */
export interface RoutingResult {
  readonly targets: readonly RouteTarget[];
  readonly nextTurnMember?: string;
}

/**
 * Parsed @mention prefix from a directed message.
 */
export interface DirectedTarget {
  readonly targetName: string;
  readonly cleanMessage: string;
}

/**
 * Regex for @mention parsing: @<name>: at the start of the message.
 * Name matches CHANNEL_NAME_REGEX character class: lowercase alphanumeric + hyphens.
 * Must be at position 0 and followed by a colon to distinguish from mid-text @mentions.
 */
const DIRECTED_TARGET_REGEX = /^@([a-z0-9][a-z0-9-]{0,62}):\s*([\s\S]*)$/;

export class ChannelRouter {
  /**
   * Route a message from senderName within the given channel.
   *
   * Routing rules:
   * - no communicationMode: no routing (single-agent external-only channel)
   * - broadcast: all active members except sender
   * - directed: route to directedTo if active, else broadcast fallback
   * - round-robin: next active member in joinedAt-ascending order
   *
   * Returns err() when:
   * - sender is not found in the channel (and mode requires it)
   * - no active targets exist after applying routing rules
   */
  static route(channel: Channel, senderName: string, directedTo?: string): Result<RoutingResult, AutobeatError> {
    const { communicationMode, members } = channel;

    // Single-agent channel with no mode — no routing targets (external messages only)
    if (!communicationMode) {
      return ok({ targets: [] });
    }

    // Validate sender exists in the channel for modes that require it
    const senderExists = members.some((m) => m.name === senderName);
    if (!senderExists) {
      return err(
        new AutobeatError(
          ErrorCode.INVALID_INPUT,
          `Sender '${senderName}' is not a member of channel '${channel.name}'`,
          { senderName, channelId: channel.id },
        ),
      );
    }

    if (communicationMode === 'round-robin') {
      return ChannelRouter.routeRoundRobin(channel, senderName);
    }

    // broadcast and directed both use broadcast-to-active-excluding-sender as base
    const activeTargets = members.filter((m) => m.name !== senderName && m.status === ChannelMemberStatus.ACTIVE);

    if (communicationMode === 'directed' && directedTo !== undefined) {
      // Attempt to route to the specified member
      const targetMember = members.find((m) => m.name === directedTo && m.status === ChannelMemberStatus.ACTIVE);
      if (targetMember) {
        return ok({
          targets: [{ memberName: targetMember.name, tmuxSession: targetMember.tmuxSession }],
        });
      }
      // Fall through to broadcast when directed target not found or destroyed
    }

    if (activeTargets.length === 0) {
      return err(
        new AutobeatError(
          ErrorCode.INVALID_INPUT,
          `No active targets in channel '${channel.name}' for sender '${senderName}'`,
          { senderName, channelId: channel.id },
        ),
      );
    }

    return ok({
      targets: activeTargets.map((m) => ({ memberName: m.name, tmuxSession: m.tmuxSession })),
    });
  }

  /**
   * Route in round-robin mode: find the next active member after sender in joinedAt order.
   */
  private static routeRoundRobin(channel: Channel, senderName: string): Result<RoutingResult, AutobeatError> {
    const nextMember = ChannelRouter.nextRoundRobinMember(channel.members, senderName);
    if (nextMember === undefined) {
      return err(
        new AutobeatError(
          ErrorCode.INVALID_INPUT,
          `No active next member for round-robin in channel '${channel.name}'`,
          { senderName, channelId: channel.id },
        ),
      );
    }

    const targetMember = channel.members.find((m) => m.name === nextMember);
    if (!targetMember) {
      return err(
        new AutobeatError(ErrorCode.SYSTEM_ERROR, `Round-robin next member '${nextMember}' not found in members list`, {
          channelId: channel.id,
        }),
      );
    }

    return ok({
      targets: [{ memberName: targetMember.name, tmuxSession: targetMember.tmuxSession }],
      nextTurnMember: nextMember,
    });
  }

  /**
   * Return the next active member name after currentSpeaker in round-robin order.
   * Members are sorted by joinedAt ascending; the list wraps around.
   *
   * Returns undefined when no active members remain (other than possibly currentSpeaker).
   */
  static nextRoundRobinMember(members: readonly ChannelMember[], currentSpeaker: string): string | undefined {
    // Sort by joinedAt ascending — deterministic order
    const sorted = [...members].sort((a, b) => a.joinedAt - b.joinedAt);
    const activeMembers = sorted.filter((m) => m.status === ChannelMemberStatus.ACTIVE);

    if (activeMembers.length === 0) return undefined;

    const currentIdx = activeMembers.findIndex((m) => m.name === currentSpeaker);
    if (currentIdx === -1) {
      // Current speaker is not in the active list (possibly destroyed mid-turn)
      // Return the first active member
      return activeMembers[0]?.name;
    }

    // Wrap around: next = (currentIdx + 1) % length
    const nextIdx = (currentIdx + 1) % activeMembers.length;
    // If next wraps to same member (only 1 active), there is no one to talk to
    if (nextIdx === currentIdx) return undefined;

    return activeMembers[nextIdx]?.name;
  }

  /**
   * Parse an @mention prefix from the start of a message.
   * Format: @<memberName>: <rest-of-message>
   *
   * Returns null if no @mention prefix is found at position 0.
   */
  static parseDirectedTarget(message: string): DirectedTarget | null {
    if (!message) return null;
    const match = DIRECTED_TARGET_REGEX.exec(message);
    if (!match) return null;

    const targetName = match[1];
    const cleanMessage = (match[2] ?? '').trim();
    if (!targetName) return null;

    return { targetName, cleanMessage };
  }
}
