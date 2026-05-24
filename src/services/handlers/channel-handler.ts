/**
 * ChannelHandler — event-driven round tracking and termination enforcement
 *
 * ARCHITECTURE: Event-driven pattern for channel lifecycle management.
 * Pattern: Factory pattern for async initialization (matches ScheduleHandler, LoopHandler).
 * Rationale: Tracks conversation rounds and enforces maxRounds termination bounds.
 *   Members' turns are tracked in-memory via a per-channel participation set.
 *   Crash handling integrates with round tracking to exclude dead members.
 *
 * Round counting rules:
 *   - broadcast/directed: a round is complete when all active members have spoken
 *     since the last round increment. The participation set is reset on each increment.
 *   - round-robin: a round is complete when the turn cycles back to the first member.
 *     The handler relies on the from field in ChannelMessageSent events.
 *   - external messages (from === 'external') do not count as member turns.
 */

import type { ChannelId } from '../../core/domain.js';
import { ChannelMemberStatus } from '../../core/domain.js';
import { AutobeatError, ErrorCode } from '../../core/errors.js';
import { EventBus } from '../../core/events/event-bus.js';
import type {
  ChannelDestroyedEvent,
  ChannelMemberCrashedEvent,
  ChannelMessageSentEvent,
} from '../../core/events/events.js';
import { BaseEventHandler } from '../../core/events/handlers.js';
import type { ChannelRepository, Logger } from '../../core/interfaces.js';
import { err, ok, type Result } from '../../core/result.js';

export interface ChannelHandlerDeps {
  readonly channelRepository: ChannelRepository;
  readonly eventBus: EventBus;
  readonly logger: Logger;
}

export class ChannelHandler extends BaseEventHandler {
  /**
   * Per-channel tracking set: channelId → Set<memberName>
   * Tracks which members have spoken in the current round (broadcast/directed modes).
   * Reset to an empty set on each round increment and on channel destruction.
   *
   * For round-robin: we track the "first active member" at the time of the last round
   * increment. When a message arrives from that member again, a round has completed.
   */
  private readonly roundParticipants: Map<string, Set<string>> = new Map();

  /**
   * For round-robin channels: channelId → name of first active member (round start).
   * A new round is detected when from === firstMember (a full cycle completed).
   * Populated on first message for a round-robin channel.
   */
  private readonly rrFirstMember: Map<string, string> = new Map();
  /**
   * Tracks whether we've seen the first member speak already in the current round.
   * Without this flag, the very first message in round 0 would immediately trigger
   * a round increment (since first member === rrFirstMember for that channel).
   */
  private readonly rrFirstMemberSeen: Map<string, boolean> = new Map();

  private readonly channelRepository: ChannelRepository;
  private readonly eventBus: EventBus;

  private constructor(deps: ChannelHandlerDeps) {
    super(deps.logger, 'ChannelHandler');
    this.channelRepository = deps.channelRepository;
    this.eventBus = deps.eventBus;
  }

  /**
   * Factory method — creates a fully initialized ChannelHandler.
   * ARCHITECTURE: Factory pattern guarantees handler is ready before use.
   */
  static async create(deps: ChannelHandlerDeps): Promise<Result<ChannelHandler, AutobeatError>> {
    const handlerLogger = deps.logger.child ? deps.logger.child({ module: 'ChannelHandler' }) : deps.logger;
    const handler = new ChannelHandler({ ...deps, logger: handlerLogger });

    const subscribeResult = handler.subscribeToEvents();
    if (!subscribeResult.ok) return subscribeResult;

    handlerLogger.info('ChannelHandler initialized');
    return ok(handler);
  }

  /**
   * Subscribe to all relevant channel events.
   * ARCHITECTURE: Called by factory after construction.
   */
  private subscribeToEvents(): Result<void, AutobeatError> {
    const subscriptions = [
      this.eventBus.subscribe('ChannelMessageSent', this.handleChannelMessageSent.bind(this)),
      this.eventBus.subscribe('ChannelMemberCrashed', this.handleChannelMemberCrashed.bind(this)),
      this.eventBus.subscribe('ChannelDestroyed', this.handleChannelDestroyed.bind(this)),
    ];

    for (const result of subscriptions) {
      if (!result.ok) {
        return err(
          new AutobeatError(
            ErrorCode.SYSTEM_ERROR,
            `ChannelHandler: failed to subscribe to events: ${result.error.message}`,
            { error: result.error },
          ),
        );
      }
    }

    return ok(undefined);
  }

  // ─── Event handlers ──────────────────────────────────────────────────────────

  /**
   * Handle ChannelMessageSent: update round tracking, emit ChannelDestroyed on maxRounds.
   *
   * Round tracking:
   *   - broadcast/directed: increment when all active members have spoken
   *   - round-robin: increment when turn cycles back to first member
   *   - external messages (from === 'external') are not tracked
   */
  private async handleChannelMessageSent(event: ChannelMessageSentEvent): Promise<void> {
    await this.handleEvent(event, async (e) => {
      const { channelId, from } = e;

      // External messages do not count as member turns
      if (from === 'external') return ok(undefined);

      const channelResult = await this.channelRepository.findById(channelId);
      if (!channelResult.ok) return channelResult;
      const channel = channelResult.value;
      if (!channel || channel.status !== 'active') return ok(undefined);

      const { communicationMode, maxRounds } = channel;
      const activeMembers = channel.members.filter((m) => m.status === ChannelMemberStatus.ACTIVE);

      let roundComplete = false;

      if (communicationMode === 'round-robin') {
        // Initialize first-member tracking if not set
        if (!this.rrFirstMember.has(channelId)) {
          const sorted = [...activeMembers].sort((a, b) => a.joinedAt - b.joinedAt);
          const first = sorted[0];
          if (first) {
            this.rrFirstMember.set(channelId, first.name);
            this.rrFirstMemberSeen.set(channelId, false);
          }
        }

        const firstMember = this.rrFirstMember.get(channelId);
        const seenFirst = this.rrFirstMemberSeen.get(channelId) ?? false;

        if (from === firstMember) {
          if (seenFirst) {
            // The first member has spoken again → full cycle completed → increment round
            roundComplete = true;
            this.rrFirstMemberSeen.set(channelId, true); // Still the first for next round
          } else {
            // First time we see the first member — record it but don't increment yet
            this.rrFirstMemberSeen.set(channelId, true);
          }
        }
      } else {
        // broadcast / directed: all active members must speak
        if (!this.roundParticipants.has(channelId)) {
          this.roundParticipants.set(channelId, new Set());
        }
        const participants = this.roundParticipants.get(channelId)!;
        participants.add(from);

        const activeMemberNames = new Set(activeMembers.map((m) => m.name));
        // Round is complete when every active member has spoken at least once
        const allSpoken = [...activeMemberNames].every((name) => participants.has(name));
        if (allSpoken) {
          roundComplete = true;
          participants.clear();
        }
      }

      if (!roundComplete) return ok(undefined);

      const newRound = channel.currentRound + 1;
      const updateResult = await this.channelRepository.updateRound(channelId, newRound);
      if (!updateResult.ok) return updateResult;

      this.logger.info('Channel round incremented', { channelId, round: newRound });

      // Check termination bound
      if (maxRounds !== undefined && newRound >= maxRounds) {
        this.logger.info('Channel reached maxRounds — destroying', { channelId, maxRounds });
        const destroyResult = await this.eventBus.emit('ChannelDestroyed', {
          channelId,
          reason: 'max-rounds-reached',
        });
        if (!destroyResult.ok) return destroyResult;
      }

      return ok(undefined);
    });
  }

  /**
   * Handle ChannelMemberCrashed: mark member DESTROYED, check for all-dead condition.
   */
  private async handleChannelMemberCrashed(event: ChannelMemberCrashedEvent): Promise<void> {
    await this.handleEvent(event, async (e) => {
      const { channelId, memberName } = e;

      // Update member status to DESTROYED
      const statusResult = await this.channelRepository.updateMemberStatus(
        channelId,
        memberName,
        ChannelMemberStatus.DESTROYED,
      );
      if (!statusResult.ok) return statusResult;

      // Remove crashed member from the participation tracking set (broadcast/directed)
      const participants = this.roundParticipants.get(channelId);
      if (participants) {
        participants.delete(memberName);
      }

      // If this was the first member in round-robin, advance to next active member
      if (this.rrFirstMember.get(channelId) === memberName) {
        const channelResult = await this.channelRepository.findById(channelId);
        if (channelResult.ok && channelResult.value) {
          const activeMembers = channelResult.value.members
            .filter((m) => m.name !== memberName && m.status === ChannelMemberStatus.ACTIVE)
            .sort((a, b) => a.joinedAt - b.joinedAt);
          if (activeMembers[0]) {
            this.rrFirstMember.set(channelId, activeMembers[0].name);
            this.rrFirstMemberSeen.set(channelId, false);
          } else {
            this.rrFirstMember.delete(channelId);
          }
        }
      }

      // Fetch updated channel to check all-members-dead condition
      const channelResult = await this.channelRepository.findById(channelId);
      if (!channelResult.ok) return channelResult;
      const channel = channelResult.value;
      if (!channel) return ok(undefined);

      // After updateMemberStatus, check current members in the DB (now reflects the crash)
      const allDead = channel.members.every((m) =>
        m.name === memberName ? true : m.status === ChannelMemberStatus.DESTROYED,
      );

      if (allDead) {
        this.logger.info('All channel members crashed — destroying channel', { channelId });
        const destroyResult = await this.eventBus.emit('ChannelDestroyed', {
          channelId,
          reason: 'all-members-crashed',
        });
        if (!destroyResult.ok) return destroyResult;
      }

      return ok(undefined);
    });
  }

  /**
   * Handle ChannelDestroyed: clear in-memory round tracking state for the channel.
   */
  private async handleChannelDestroyed(event: ChannelDestroyedEvent): Promise<void> {
    await this.handleEvent(event, async (e) => {
      const { channelId } = e;
      this.roundParticipants.delete(channelId);
      this.rrFirstMember.delete(channelId);
      this.rrFirstMemberSeen.delete(channelId);
      this.logger.debug('ChannelHandler: cleared round tracking for destroyed channel', { channelId });
      return ok(undefined);
    });
  }
}
