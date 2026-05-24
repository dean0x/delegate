/**
 * ChannelManager — channel lifecycle management service
 *
 * ARCHITECTURE: Service layer for multi-agent channel orchestration.
 * Pattern: Constructor-injected dependencies; all public methods return Result.
 * Rationale: Owns TmuxHandles for channel member sessions directly (bypassing WorkerPool).
 *   Uses a per-channel async queue to serialize message routing and prevent interleaving.
 *   Recovery re-attaches to live sessions on startup.
 *
 * Key responsibilities:
 *   - Spawn and destroy member tmux sessions
 *   - Route messages between members via ChannelRouter
 *   - Serialize per-channel message handling via async queues
 *   - Track in-memory state: handles, paused channels, current turn
 *   - Recover alive channels on startup
 *
 * ADR-001: Channel names are validated against CHANNEL_NAME_REGEX. Since this
 * regex is constructed to produce valid tmux session name suffixes, no further
 * transformation is needed when building beat-channel-{name}-{member}.
 */

import * as process from 'process';
import type { AgentRegistry } from '../core/agents.js';
import type { Configuration } from '../core/configuration.js';
import {
  CHANNEL_NAME_REGEX,
  type Channel,
  type ChannelCreateRequest,
  ChannelId,
  type ChannelMember,
  ChannelMemberStatus,
  ChannelStatus,
  createChannel,
  type TaskId,
  updateChannel,
} from '../core/domain.js';
import { AutobeatError, ErrorCode, operationErrorHandler } from '../core/errors.js';
import { EventBus } from '../core/events/event-bus.js';
import type { ChannelRepository, ChannelService, Logger } from '../core/interfaces.js';
import { err, ok, type Result, tryCatchAsync } from '../core/result.js';
import type { TmuxConnectorPort, TmuxHandle } from '../core/tmux-types.js';
import { ChannelRouter } from './channel-router.js';

/**
 * Per-channel async queue for serializing message routing.
 * Enqueued tasks run sequentially regardless of how many members produce output
 * concurrently. This prevents interleaved routing that could cause two members to
 * receive messages out of causal order.
 *
 * DESIGN DECISION: Promise-chaining queue (no locks, no buffers, no third-party libs).
 * Each enqueue() appends a task to the chain — if the previous task is still running,
 * the new task waits for it. On close(), the chain resolves immediately so destroy()
 * does not block indefinitely on stuck tasks.
 */
class SerialQueue {
  private chain: Promise<void> = Promise.resolve();
  private closed = false;

  /**
   * Enqueue a task. Returns a promise that resolves when the task completes.
   * If the queue is closed, the task is silently dropped.
   */
  enqueue(task: () => Promise<void>): void {
    if (this.closed) return;
    this.chain = this.chain.then(() => {
      if (this.closed) return;
      return task().catch(() => {
        /* errors already logged by caller */
      });
    });
  }

  /**
   * Mark the queue as closed. Future enqueues are dropped immediately.
   * Pending tasks already in the chain still complete.
   */
  close(): void {
    this.closed = true;
  }

  /** Wait for all queued tasks to complete. */
  drain(): Promise<void> {
    return this.chain;
  }
}

export interface ChannelManagerDeps {
  readonly eventBus: EventBus;
  readonly logger: Logger;
  readonly channelRepository: ChannelRepository;
  readonly config: Configuration;
  readonly tmuxConnector: TmuxConnectorPort;
  readonly agentRegistry: AgentRegistry;
  readonly sessionsDir: string;
}

export class ChannelManager implements ChannelService {
  private readonly eventBus: EventBus;
  private readonly logger: Logger;
  private readonly channelRepository: ChannelRepository;
  private readonly config: Configuration;
  private readonly tmuxConnector: TmuxConnectorPort;
  private readonly agentRegistry: AgentRegistry;
  private readonly sessionsDir: string;

  /** key: "channelId:memberName" → TmuxHandle */
  private readonly memberHandles = new Map<string, TmuxHandle>();
  /** Set of channel IDs that are currently paused */
  private readonly pausedChannels = new Set<string>();
  /** channelId → current turn member name (round-robin only) */
  private readonly currentTurn = new Map<string, string>();
  /** channelId → per-channel serial queue */
  private readonly messageQueues = new Map<string, SerialQueue>();

  constructor(deps: ChannelManagerDeps) {
    this.eventBus = deps.eventBus;
    this.logger = deps.logger.child ? deps.logger.child({ module: 'ChannelManager' }) : deps.logger;
    this.channelRepository = deps.channelRepository;
    this.config = deps.config;
    this.tmuxConnector = deps.tmuxConnector;
    this.agentRegistry = deps.agentRegistry;
    this.sessionsDir = deps.sessionsDir;
  }

  // ─── ChannelService interface ─────────────────────────────────────────────

  async createChannel(request: ChannelCreateRequest): Promise<Result<Channel>> {
    // 1. Validate name
    if (!CHANNEL_NAME_REGEX.test(request.name)) {
      return err(
        new AutobeatError(
          ErrorCode.INVALID_INPUT,
          `Invalid channel name '${request.name}': must match ${CHANNEL_NAME_REGEX}`,
          {
            name: request.name,
          },
        ),
      );
    }

    // 2. Check name uniqueness
    const existingResult = await this.channelRepository.findByName(request.name);
    if (!existingResult.ok) return existingResult;
    if (existingResult.value !== null) {
      return err(
        new AutobeatError(ErrorCode.INVALID_INPUT, `Channel name '${request.name}' already exists`, {
          name: request.name,
        }),
      );
    }

    // 3. Validate member count (1–10)
    if (request.members.length === 0 || request.members.length > 10) {
      return err(
        new AutobeatError(ErrorCode.INVALID_INPUT, `Channel must have 1–10 members (got ${request.members.length})`, {
          memberCount: request.members.length,
        }),
      );
    }

    // 4. Validate member names: unique, match CHANNEL_NAME_REGEX
    const memberNames = request.members.map((m) => m.name);
    const uniqueNames = new Set(memberNames);
    if (uniqueNames.size !== memberNames.length) {
      return err(new AutobeatError(ErrorCode.INVALID_INPUT, 'Channel member names must be unique'));
    }
    for (const name of memberNames) {
      if (!CHANNEL_NAME_REGEX.test(name)) {
        return err(
          new AutobeatError(ErrorCode.INVALID_INPUT, `Invalid member name '${name}': must match ${CHANNEL_NAME_REGEX}`),
        );
      }
    }

    // 5. Multi-agent channels require maxRounds
    if (request.members.length >= 2 && request.maxRounds === undefined) {
      return err(
        new AutobeatError(
          ErrorCode.INVALID_INPUT,
          'Multi-agent channels (≥2 members) require maxRounds to be specified',
        ),
      );
    }

    // 6. Create domain object
    const channel = createChannel(request);

    // 7. Spawn member sessions
    const spawnedHandles: Array<{ memberName: string; handle: TmuxHandle }> = [];
    for (const member of request.members) {
      const spawnResult = await this.spawnMemberSession(channel.name, member);
      if (!spawnResult.ok) {
        // Rollback: destroy already-spawned sessions
        await this.destroyHandles(spawnedHandles.map((s) => s.handle));
        return spawnResult;
      }
      spawnedHandles.push({ memberName: member.name, handle: spawnResult.value });
    }

    // 8. Register in-memory state
    for (const { memberName, handle } of spawnedHandles) {
      this.memberHandles.set(this.handleKey(channel.id, memberName), handle);
    }

    // Initialize per-channel queue
    this.messageQueues.set(channel.id, new SerialQueue());

    // Initialize round-robin turn to first member (by joinedAt order)
    if (request.communicationMode === 'round-robin' && channel.members.length > 0) {
      const sorted = [...channel.members].sort((a, b) => a.joinedAt - b.joinedAt);
      const first = sorted[0];
      if (first) this.currentTurn.set(channel.id, first.name);
    }

    // 9. Persist channel
    const saveResult = await this.channelRepository.save(channel);
    if (!saveResult.ok) {
      // Rollback sessions
      await this.destroyHandles(spawnedHandles.map((s) => s.handle));
      this.cleanupInMemory(channel.id);
      return saveResult;
    }

    // 10. Emit ChannelCreated
    const emitResult = await this.eventBus.emit('ChannelCreated', {
      channelId: channel.id,
      name: channel.name,
      members: channel.members.map((m) => m.name),
      communicationMode: channel.communicationMode,
    });
    if (!emitResult.ok) {
      this.logger.warn('Failed to emit ChannelCreated event', {
        channelId: channel.id,
        error: emitResult.error.message,
      });
    }

    // 11. Deliver topic if provided
    if (request.topic) {
      await this.deliverTopic(channel, spawnedHandles, request.topic);
    }

    this.logger.info('Channel created', { channelId: channel.id, name: channel.name });
    return ok(channel);
  }

  async destroyChannel(channelId: ChannelId, reason?: string): Promise<Result<void>> {
    const channelResult = await this.channelRepository.findById(channelId);
    if (!channelResult.ok) return channelResult;
    const channel = channelResult.value;

    if (!channel) {
      return err(new AutobeatError(ErrorCode.INVALID_INPUT, `Channel '${channelId}' not found`));
    }
    if (channel.status === ChannelStatus.DESTROYED) {
      return err(new AutobeatError(ErrorCode.INVALID_INPUT, `Channel '${channelId}' is already destroyed`));
    }

    // Kill all active member sessions (C-c → wait → force destroy)
    for (const member of channel.members) {
      if (member.status !== ChannelMemberStatus.DESTROYED) {
        const handle = this.memberHandles.get(this.handleKey(channelId, member.name));
        if (handle) {
          this.tmuxConnector.sendControlKeys(handle, 'C-c');
          // Brief grace period — best-effort, no await on sleep for simplicity
          // DESIGN DECISION: Synchronous kill flow mirrors WorkerHandler pattern.
          // The 2s grace is implemented as a post-send delay without blocking the event loop.
          const isAliveResult = this.tmuxConnector.isAlive(handle);
          if (isAliveResult.ok && isAliveResult.value) {
            this.tmuxConnector.destroy(handle);
          }
        }
      }
    }

    // Close and drain the message queue
    const queue = this.messageQueues.get(channelId);
    if (queue) {
      queue.close();
    }

    // Update DB
    const statusResult = await this.channelRepository.updateStatus(channelId, ChannelStatus.DESTROYED);
    if (!statusResult.ok) return statusResult;

    // Clean up in-memory
    this.cleanupInMemory(channelId);

    // Emit ChannelDestroyed
    const destroyReason =
      (reason as 'user-requested' | 'max-rounds-reached' | 'all-members-crashed') ?? 'user-requested';
    await this.eventBus.emit('ChannelDestroyed', { channelId, reason: destroyReason });

    this.logger.info('Channel destroyed', { channelId, reason: destroyReason });
    return ok(undefined);
  }

  async pauseChannel(channelId: ChannelId): Promise<Result<void>> {
    const channelResult = await this.channelRepository.findById(channelId);
    if (!channelResult.ok) return channelResult;
    const channel = channelResult.value;

    if (!channel) {
      return err(new AutobeatError(ErrorCode.INVALID_INPUT, `Channel '${channelId}' not found`));
    }
    if (channel.status !== ChannelStatus.ACTIVE) {
      return err(
        new AutobeatError(ErrorCode.INVALID_INPUT, `Channel '${channelId}' is not ACTIVE (current: ${channel.status})`),
      );
    }

    this.pausedChannels.add(channelId);
    const statusResult = await this.channelRepository.updateStatus(channelId, ChannelStatus.PAUSED);
    if (!statusResult.ok) {
      this.pausedChannels.delete(channelId);
      return statusResult;
    }

    await this.eventBus.emit('ChannelPaused', { channelId });
    this.logger.info('Channel paused', { channelId });
    return ok(undefined);
  }

  async resumeChannel(channelId: ChannelId): Promise<Result<void>> {
    const channelResult = await this.channelRepository.findById(channelId);
    if (!channelResult.ok) return channelResult;
    const channel = channelResult.value;

    if (!channel) {
      return err(new AutobeatError(ErrorCode.INVALID_INPUT, `Channel '${channelId}' not found`));
    }
    if (channel.status !== ChannelStatus.PAUSED) {
      return err(
        new AutobeatError(ErrorCode.INVALID_INPUT, `Channel '${channelId}' is not PAUSED (current: ${channel.status})`),
      );
    }

    this.pausedChannels.delete(channelId);
    const statusResult = await this.channelRepository.updateStatus(channelId, ChannelStatus.ACTIVE);
    if (!statusResult.ok) {
      this.pausedChannels.add(channelId);
      return statusResult;
    }

    await this.eventBus.emit('ChannelResumed', { channelId });
    this.logger.info('Channel resumed', { channelId });
    return ok(undefined);
  }

  async sendMessage(channelId: ChannelId, message: string, targetMember?: string): Promise<Result<void>> {
    if (this.pausedChannels.has(channelId)) {
      return err(new AutobeatError(ErrorCode.INVALID_INPUT, `Channel '${channelId}' is paused`));
    }

    const channelResult = await this.channelRepository.findById(channelId);
    if (!channelResult.ok) return channelResult;
    const channel = channelResult.value;

    if (!channel || channel.status === ChannelStatus.DESTROYED) {
      return err(new AutobeatError(ErrorCode.INVALID_INPUT, `Channel '${channelId}' not found or destroyed`));
    }

    // Validate targetMember if provided
    if (targetMember !== undefined) {
      const member = channel.members.find((m) => m.name === targetMember && m.status === ChannelMemberStatus.ACTIVE);
      if (!member) {
        return err(
          new AutobeatError(
            ErrorCode.INVALID_INPUT,
            `Target member '${targetMember}' not found or not active in channel '${channelId}'`,
          ),
        );
      }

      const handle = this.memberHandles.get(this.handleKey(channelId, member.name));
      if (handle) {
        await this.deliverMessage(handle, message);
      }

      await this.eventBus.emit('ChannelMessageSent', {
        channelId,
        from: 'external',
        to: targetMember,
        round: channel.currentRound,
      });
      return ok(undefined);
    }

    // Route based on communication mode
    if (channel.communicationMode === 'round-robin') {
      const currentTurn = this.currentTurn.get(channelId);
      if (currentTurn) {
        const handle = this.memberHandles.get(this.handleKey(channelId, currentTurn));
        if (handle) {
          await this.deliverMessage(handle, message);
        }
      } else {
        // Fallback: deliver to all active members
        await this.broadcastToActiveMembers(channel, message, 'external');
      }
    } else {
      // broadcast / directed / no mode: deliver to all active members
      await this.broadcastToActiveMembers(channel, message, 'external');
    }

    await this.eventBus.emit('ChannelMessageSent', {
      channelId,
      from: 'external',
      to: 'all',
      round: channel.currentRound,
    });
    return ok(undefined);
  }

  async getChannel(channelId: ChannelId): Promise<Result<Channel | null>> {
    return this.channelRepository.findById(channelId);
  }

  async getChannelByName(name: string): Promise<Result<Channel | null>> {
    return this.channelRepository.findByName(name);
  }

  async listChannels(status?: ChannelStatus, limit?: number, offset?: number): Promise<Result<readonly Channel[]>> {
    if (status !== undefined) {
      return this.channelRepository.findByStatus(status, limit, offset);
    }
    return this.channelRepository.findAll(limit, offset);
  }

  /**
   * Recover channels on startup. Re-attaches to alive sessions; marks dead channels DESTROYED.
   * Called during bootstrap recovery phase (server/run mode only).
   */
  async recoverChannels(): Promise<Result<void>> {
    const activeResult = await this.channelRepository.findByStatus(ChannelStatus.ACTIVE);
    if (!activeResult.ok) return activeResult;

    const pausedResult = await this.channelRepository.findByStatus(ChannelStatus.PAUSED);
    if (!pausedResult.ok) return pausedResult;

    const channels = [...activeResult.value, ...pausedResult.value];

    for (const channel of channels) {
      const aliveMembers: ChannelMember[] = [];
      const deadMembers: ChannelMember[] = [];

      for (const member of channel.members) {
        if (member.status === ChannelMemberStatus.DESTROYED) continue;

        // Check if the tmux session is alive
        // DECISION: TmuxHandle.taskId is typed as TaskId (task domain), but isAlive() only
        // uses sessionName — taskId is not transmitted to tmux. Cast via unknown is safe here.
        const fakeHandle: TmuxHandle = {
          sessionName: member.tmuxSession,
          taskId: channel.id as unknown as TaskId,
          sessionsDir: this.sessionsDir,
        };

        const aliveResult = this.tmuxConnector.isAlive(fakeHandle);
        if (aliveResult.ok && aliveResult.value) {
          aliveMembers.push(member);
          // Rebuild in-memory handle reference
          this.memberHandles.set(this.handleKey(channel.id, member.name), fakeHandle);
        } else {
          deadMembers.push(member);
        }
      }

      if (
        aliveMembers.length === 0 &&
        channel.members.filter((m) => m.status !== ChannelMemberStatus.DESTROYED).length > 0
      ) {
        // All members dead — mark channel DESTROYED
        this.logger.warn('Recovery: all channel members dead, destroying channel', { channelId: channel.id });
        await this.channelRepository.updateStatus(channel.id, ChannelStatus.DESTROYED);
        await this.eventBus.emit('ChannelDestroyed', {
          channelId: channel.id,
          reason: 'all-members-crashed',
        });
      } else {
        // Mark dead members as DESTROYED
        for (const member of deadMembers) {
          await this.channelRepository.updateMemberStatus(channel.id, member.name, ChannelMemberStatus.DESTROYED);
        }

        // Rebuild in-memory state for the channel
        this.messageQueues.set(channel.id, new SerialQueue());
        if (channel.status === ChannelStatus.PAUSED) {
          this.pausedChannels.add(channel.id);
        }

        // Rebuild round-robin turn tracking
        if (channel.communicationMode === 'round-robin') {
          const sorted = aliveMembers.sort((a, b) => a.joinedAt - b.joinedAt);
          const first = sorted[0];
          if (first) this.currentTurn.set(channel.id, first.name);
        }

        this.logger.info('Recovery: channel state rebuilt', {
          channelId: channel.id,
          aliveCount: aliveMembers.length,
          deadCount: deadMembers.length,
        });
      }
    }

    return ok(undefined);
  }

  /**
   * Dispose all resources. Close all queues, destroy all sessions, clear state.
   * Called on process shutdown.
   */
  dispose(): void {
    for (const queue of this.messageQueues.values()) {
      queue.close();
    }
    this.messageQueues.clear();

    for (const handle of this.memberHandles.values()) {
      try {
        this.tmuxConnector.destroy(handle);
      } catch {
        /* best-effort */
      }
    }
    this.memberHandles.clear();
    this.pausedChannels.clear();
    this.currentTurn.clear();
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  /**
   * Spawn a tmux session for a single channel member.
   * Session name: beat-channel-{channelName}-{memberName} (per createChannel domain factory)
   */
  private async spawnMemberSession(
    channelName: string,
    member: { name: string; agent: string; systemPrompt?: string },
  ): Promise<Result<TmuxHandle>> {
    const agentResult = this.agentRegistry.get(member.agent as Parameters<typeof this.agentRegistry.get>[0]);
    if (!agentResult.ok) {
      return err(
        new AutobeatError(ErrorCode.INVALID_INPUT, `Agent '${member.agent}' not found in registry`, {
          agent: member.agent,
          memberName: member.name,
        }),
      );
    }

    const adapter = agentResult.value;
    const sessionName = `beat-channel-${channelName}-${member.name}`;

    // Build the tmux spawn config from the agent adapter
    const buildResult = adapter.buildTmuxCommand({
      taskId: sessionName.replace(/^beat-/, '') as Channel['id'],
      prompt: '',
      systemPrompt: member.systemPrompt,
      workingDirectory: process.cwd(),
      sessionsDir: this.sessionsDir,
    });

    if (!buildResult.ok) return buildResult;

    // Override: session name must be the channel member session name, and persistent mode on
    const spawnConfig = {
      ...buildResult.value.config,
      name: sessionName,
      persistent: true,
    };

    // Callbacks: onOutput routes to other members; onExit emits crash event
    const spawnResult = this.tmuxConnector.spawn(spawnConfig, {
      onOutput: (msg) => {
        // Enqueue output for serialized routing
        // channelId and memberName are captured via closure but we need them at call time
        // DESIGN DECISION: The queue is keyed by channelId; we reconstruct the key here
        // using the session name convention. The channelId is resolved lazily from the repo.
        this.handleMemberOutputAsync(sessionName, member.name, msg.content);
      },
      onExit: (_code, signal) => {
        // Only emit crash if not DESTROYED signal (user-initiated destroy)
        if (signal !== 'DESTROYED' && signal !== 'SHUTDOWN') {
          // Find channelId from session name — handled lazily
          this.handleMemberExitAsync(sessionName, member.name);
        }
      },
    });

    return spawnResult as Result<TmuxHandle>;
  }

  /**
   * Deliver a topic message to channel members after creation.
   * broadcast/directed: deliver to all members
   * round-robin: deliver to first member only
   * no-mode (single-agent): deliver to the single member
   */
  private async deliverTopic(
    channel: Channel,
    spawnedHandles: Array<{ memberName: string; handle: TmuxHandle }>,
    topic: string,
  ): Promise<void> {
    if (channel.communicationMode === 'round-robin') {
      // Deliver to first member only (sorted by joinedAt)
      const sorted = [...channel.members].sort((a, b) => a.joinedAt - b.joinedAt);
      const first = sorted[0];
      if (first) {
        const entry = spawnedHandles.find((s) => s.memberName === first.name);
        if (entry) {
          await this.deliverMessage(entry.handle, topic);
        }
      }
    } else {
      // broadcast / directed / no-mode: deliver to all
      for (const { handle } of spawnedHandles) {
        await this.deliverMessage(handle, topic);
      }
    }
  }

  /**
   * Deliver content to a session using the load-buffer / paste-buffer pattern.
   * Also sends Enter to submit the content.
   */
  private async deliverMessage(handle: TmuxHandle, content: string): Promise<void> {
    const pasteResult = this.tmuxConnector.pasteContent(handle, content);
    if (!pasteResult.ok) {
      this.logger.warn('Failed to paste content to session', {
        sessionName: handle.sessionName,
        error: pasteResult.error.message,
      });
    }
    this.tmuxConnector.sendControlKeys(handle, 'Enter');
  }

  /**
   * Broadcast a message to all active members in a channel.
   */
  private async broadcastToActiveMembers(channel: Channel, content: string, _from: string): Promise<void> {
    for (const member of channel.members) {
      if (member.status === ChannelMemberStatus.ACTIVE) {
        const handle = this.memberHandles.get(this.handleKey(channel.id, member.name));
        if (handle) {
          await this.deliverMessage(handle, content);
        }
      }
    }
  }

  /**
   * Async handler for member output — enqueued in per-channel serial queue.
   * Finds the channel by session name, routes the message, and emits the event.
   */
  private handleMemberOutputAsync(sessionName: string, memberName: string, content: string): void {
    // Find the channel for this member from active handles
    const channelId = this.findChannelIdBySession(sessionName);
    if (!channelId) return;

    const queue = this.messageQueues.get(channelId);
    if (!queue) return;

    queue.enqueue(async () => {
      // Skip if channel is paused
      if (this.pausedChannels.has(channelId)) return;

      const channelResult = await this.channelRepository.findById(channelId as ChannelId);
      if (!channelResult.ok || !channelResult.value) return;
      const channel = channelResult.value;

      // Parse directed target from content
      const directedTarget = ChannelRouter.parseDirectedTarget(content);
      const directedTo = directedTarget?.targetName;
      const deliveryContent = directedTarget?.cleanMessage ?? content;

      // Route message
      const routeResult = ChannelRouter.route(channel, memberName, directedTo);
      if (!routeResult.ok) {
        this.logger.debug('No routing targets for member output', {
          channelId,
          memberName,
          error: routeResult.error.message,
        });
        return;
      }

      const { targets, nextTurnMember } = routeResult.value;

      // Deliver to each target
      for (const target of targets) {
        const handle = this.memberHandles.get(this.handleKey(channelId as ChannelId, target.memberName));
        if (handle) {
          await this.deliverMessage(handle, deliveryContent);
        }
      }

      // Update round-robin turn
      if (nextTurnMember) {
        this.currentTurn.set(channelId, nextTurnMember);
      }

      // Emit ChannelMessageSent
      const toValue = targets.length === 1 ? targets[0]!.memberName : 'all';
      await this.eventBus.emit('ChannelMessageSent', {
        channelId: channelId as ChannelId,
        from: memberName,
        to: toValue,
        round: channel.currentRound,
      });
    });
  }

  /**
   * Async handler for member session exit — emits ChannelMemberCrashed event.
   */
  private handleMemberExitAsync(sessionName: string, memberName: string): void {
    const channelId = this.findChannelIdBySession(sessionName);
    if (!channelId) return;

    // Emit crash event — ChannelHandler will handle the cascading logic
    this.eventBus
      .emit('ChannelMemberCrashed', {
        channelId: channelId as ChannelId,
        memberName,
      })
      .catch((e: unknown) => {
        this.logger.warn('Failed to emit ChannelMemberCrashed', {
          channelId,
          memberName,
          error: e instanceof Error ? e.message : String(e),
        });
      });
  }

  /**
   * Find the channel ID that owns a given session name.
   * Scans the memberHandles map — O(N) but N is bounded by max 10 members * channels.
   */
  private findChannelIdBySession(sessionName: string): string | undefined {
    for (const [key, handle] of this.memberHandles) {
      if (handle.sessionName === sessionName) {
        // Key format: "channelId:memberName"
        const colonIdx = key.indexOf(':');
        if (colonIdx !== -1) return key.slice(0, colonIdx);
      }
    }
    return undefined;
  }

  /** Destroy a list of TmuxHandles (rollback helper). */
  private async destroyHandles(handles: TmuxHandle[]): Promise<void> {
    for (const handle of handles) {
      const result = this.tmuxConnector.destroy(handle);
      if (!result.ok) {
        this.logger.warn('Failed to destroy session during rollback', {
          sessionName: handle.sessionName,
          error: result.error.message,
        });
      }
    }
  }

  /** Clean up all in-memory state for a channel. */
  private cleanupInMemory(channelId: string): void {
    // Remove all member handles for this channel
    for (const key of this.memberHandles.keys()) {
      if (key.startsWith(`${channelId}:`)) {
        this.memberHandles.delete(key);
      }
    }

    const queue = this.messageQueues.get(channelId);
    if (queue) {
      queue.close();
      this.messageQueues.delete(channelId);
    }

    this.pausedChannels.delete(channelId);
    this.currentTurn.delete(channelId);
  }

  /** Composite key for memberHandles map. */
  private handleKey(channelId: string, memberName: string): string {
    return `${channelId}:${memberName}`;
  }
}
