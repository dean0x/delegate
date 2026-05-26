/**
 * ChannelManager — channel lifecycle management service
 *
 * ARCHITECTURE: Service layer for multi-agent channel orchestration.
 * Pattern: Factory pattern (ChannelManager.create()) for async initialization — constructor
 *   only assigns dependencies; subscribeToEvents() surfaces subscription failures.
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

import { type AgentRegistry, isAgentProvider } from '../core/agents.js';
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
  TaskId,
} from '../core/domain.js';
import { AutobeatError, ErrorCode } from '../core/errors.js';
import { EventBus } from '../core/events/event-bus.js';
import type { ChannelDestroyedEvent, ChannelDestroyReason, ChannelMemberCrashedEvent } from '../core/events/events.js';
import type { ChannelRepository, ChannelService, Logger } from '../core/interfaces.js';
import { err, ok, type Result } from '../core/result.js';
import type { TmuxConnectorPort, TmuxHandle, TmuxSessionManagerCorePort } from '../core/tmux-types.js';
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
  enqueue(task: () => Promise<void>, onError?: (e: unknown) => void): void {
    if (this.closed) return;
    this.chain = this.chain.then(() => {
      if (this.closed) return;
      return task().catch((e: unknown) => {
        onError?.(e);
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

  /**
   * Wait for all queued tasks to complete, with an optional timeout.
   * If the timeout elapses before all tasks finish, the promise resolves anyway
   * (best-effort drain — callers must not rely on full completion).
   */
  async drain(timeoutMs = 5_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    await Promise.race([this.chain, timeout]);
    clearTimeout(timer);
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
  /**
   * Optional session manager for batch liveness checks during recovery.
   * When provided, recoverChannels() calls listSessions() once and builds a
   * Set<string> for O(1) membership tests — reducing N sequential tmux
   * has-session execs to a single call. Falls back to per-member isAlive()
   * when absent (e.g. in tests that do not need the optimisation).
   */
  readonly tmuxSessionManager?: TmuxSessionManagerCorePort;
}

export class ChannelManager implements ChannelService {
  private readonly eventBus: EventBus;
  private readonly logger: Logger;
  private readonly channelRepository: ChannelRepository;
  private readonly config: Configuration;
  private readonly tmuxConnector: TmuxConnectorPort;
  private readonly tmuxSessionManager: TmuxSessionManagerCorePort | undefined;
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
  /**
   * Reverse lookup: sessionName → channelId.
   * Maintained alongside memberHandles for O(1) session-to-channel lookup in
   * handleMemberOutputAsync / handleMemberExitAsync (hot path — called on every
   * agent output and every session exit).
   */
  private readonly sessionToChannel = new Map<string, ChannelId>();
  /**
   * In-memory channel metadata cache: channelId → Channel.
   * Populated on createChannel/recoverChannels; invalidated on member crash
   * (via ChannelMemberCrashed event) and on channel destroy (via cleanupInMemory).
   * Eliminates the DB read inside routeAndDeliverMessage for every agent output.
   * currentRound in the cache may be arbitrarily stale — it reflects the round
   * at create/recover time and is never refreshed. This is acceptable because it
   * is only used for informational event payload (ChannelHandler uses its own
   * tracking, not the round field, for termination logic).
   */
  private readonly channelCache = new Map<string, Channel>();

  private constructor(deps: ChannelManagerDeps) {
    this.eventBus = deps.eventBus;
    this.logger = deps.logger;
    this.channelRepository = deps.channelRepository;
    this.config = deps.config;
    this.tmuxConnector = deps.tmuxConnector;
    this.tmuxSessionManager = deps.tmuxSessionManager;
    this.agentRegistry = deps.agentRegistry;
    this.sessionsDir = deps.sessionsDir;
  }

  /**
   * Factory method — creates a fully initialized ChannelManager with event subscriptions.
   * ARCHITECTURE: Factory pattern guarantees subscriptions are established before use
   *   and surfaces failures via Result instead of silently failing in a constructor.
   *   Pattern matches ChannelHandler, ScheduleHandler, LoopHandler (async Promise<Result>).
   */
  static async create(deps: ChannelManagerDeps): Promise<Result<ChannelManager, AutobeatError>> {
    const manager = new ChannelManager(deps);

    const subscribeResult = manager.subscribeToEvents();
    if (!subscribeResult.ok) return subscribeResult;

    manager.logger.debug('ChannelManager initialized');
    return ok(manager);
  }

  /**
   * Subscribe to all relevant channel lifecycle events.
   * ARCHITECTURE: Called by factory after construction; checks all subscribe Results.
   */
  private subscribeToEvents(): Result<void, AutobeatError> {
    // Subscribe to ChannelDestroyed so that event-driven destroy paths (max-rounds-reached,
    // all-members-crashed) trigger session teardown and DB status update.
    // DESIGN DECISION: destroyChannel() updates DB before emitting, so when our own destroy
    // path fires this handler the status is already DESTROYED — we skip. Only the
    // ChannelHandler-initiated paths (where DB is still ACTIVE) need handling here.
    const destroyedResult = this.eventBus.subscribe('ChannelDestroyed', async (event: ChannelDestroyedEvent) => {
      await this.handleChannelDestroyedEvent(event).catch((e: unknown) => {
        const error = e instanceof Error ? e : new Error(String(e));
        this.logger.error('Failed to handle ChannelDestroyed event', error, { channelId: event.channelId });
      });
    });
    if (!destroyedResult.ok) {
      return err(
        new AutobeatError(
          ErrorCode.SYSTEM_ERROR,
          `ChannelManager: failed to subscribe to ChannelDestroyed: ${destroyedResult.error.message}`,
          { error: destroyedResult.error },
        ),
      );
    }

    // Invalidate the channel cache when a member crashes so that the next
    // routeAndDeliverMessage call sees the updated member status (DESTROYED).
    // ChannelHandler writes the status update to DB; we must not serve stale
    // membership data from channelCache after that point.
    const crashedResult = this.eventBus.subscribe('ChannelMemberCrashed', async (event: ChannelMemberCrashedEvent) => {
      this.channelCache.delete(event.channelId);
    });
    if (!crashedResult.ok) {
      return err(
        new AutobeatError(
          ErrorCode.SYSTEM_ERROR,
          `ChannelManager: failed to subscribe to ChannelMemberCrashed: ${crashedResult.error.message}`,
          { error: crashedResult.error },
        ),
      );
    }

    return ok(undefined);
  }

  // ─── ChannelService interface ─────────────────────────────────────────────

  async createChannel(request: ChannelCreateRequest): Promise<Result<Channel>> {
    // 1–5. Validate request fields
    const validationResult = await this.validateCreateRequest(request);
    if (!validationResult.ok) return validationResult;

    // 6. Create domain object
    const channel = createChannel(request);

    // 7. Spawn member sessions (with rollback on failure)
    const workingDirectory = request.workingDirectory ?? process.cwd();
    const spawnResult = await this.spawnMembersWithRollback(channel.name, request.members, workingDirectory);
    if (!spawnResult.ok) return spawnResult;
    const spawnedHandles = spawnResult.value;

    // 8. Register in-memory state
    this.registerInMemoryState(channel, spawnedHandles);

    // 9. Persist channel
    const saveResult = await this.channelRepository.save(channel);
    if (!saveResult.ok) {
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
      this.logger.error('Failed to emit ChannelCreated event', emitResult.error, { channelId: channel.id });
      await this.destroyHandles(spawnedHandles.map((s) => s.handle));
      this.cleanupInMemory(channel.id);
      const deleteResult = await this.channelRepository.delete(channel.id);
      if (!deleteResult.ok) {
        this.logger.warn('Failed to delete channel record during ChannelCreated rollback', {
          channelId: channel.id,
          error: deleteResult.error.message,
        });
      }
      return err(emitResult.error);
    }

    // 11. Deliver topic if provided
    if (request.topic) {
      await this.deliverTopic(channel, spawnedHandles, request.topic);
    }

    this.logger.info('Channel created', { channelId: channel.id, name: channel.name });
    return ok(channel);
  }

  async destroyChannel(channelId: ChannelId, reason?: ChannelDestroyReason): Promise<Result<void>> {
    const channelResult = await this.channelRepository.findById(channelId);
    if (!channelResult.ok) return channelResult;
    const channel = channelResult.value;

    if (!channel) {
      return err(new AutobeatError(ErrorCode.INVALID_INPUT, `Channel '${channelId}' not found`));
    }
    if (channel.status === ChannelStatus.DESTROYED) {
      return err(new AutobeatError(ErrorCode.INVALID_INPUT, `Channel '${channelId}' is already destroyed`));
    }

    // Force-destroy all active member sessions.
    // DESIGN DECISION: No C-c grace period here — unlike WorkerHandler which uses a 2-second
    // timer between C-c and force-kill, channel member cleanup has no async delay available
    // at this point and C-c without a timer has no effect. Go straight to force-destroy.
    for (const member of channel.members) {
      if (member.status !== ChannelMemberStatus.DESTROYED) {
        const handle = this.memberHandles.get(this.handleKey(channelId, member.name));
        if (handle) {
          this.tmuxConnector.destroy(handle);
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
    const destroyReason: ChannelDestroyReason = reason ?? 'user-requested';
    const destroyEmitResult = await this.eventBus.emit('ChannelDestroyed', { channelId, reason: destroyReason });
    if (!destroyEmitResult.ok) {
      this.logger.error('Failed to emit ChannelDestroyed event', destroyEmitResult.error, { channelId });
      return err(destroyEmitResult.error);
    }

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

    const pauseEmitResult = await this.eventBus.emit('ChannelPaused', { channelId });
    if (!pauseEmitResult.ok) {
      this.logger.error('Failed to emit ChannelPaused event', pauseEmitResult.error, { channelId });
      return err(pauseEmitResult.error);
    }
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

    const resumeEmitResult = await this.eventBus.emit('ChannelResumed', { channelId });
    if (!resumeEmitResult.ok) {
      this.logger.error('Failed to emit ChannelResumed event', resumeEmitResult.error, { channelId });
      return err(resumeEmitResult.error);
    }
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
    if (channel.status === ChannelStatus.COMPLETED) {
      return err(new AutobeatError(ErrorCode.INVALID_INPUT, `Channel '${channelId}' is completed`));
    }

    // Validate targetMember before queuing (fast-fail, no async work needed).
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
    }

    // Route through the per-channel SerialQueue so that external sends are
    // serialized with internal member-output messages. Without this, concurrent
    // broadcastToActiveMembers calls could interleave with queued routing tasks,
    // causing members to receive messages out of causal order.
    const queue = this.messageQueues.get(channelId);
    if (!queue) {
      return err(new AutobeatError(ErrorCode.INVALID_INPUT, `Channel '${channelId}' has no message queue`));
    }

    let dispatchError: Error | undefined;
    let delivered = false;
    // Cancellation token: set to true if drain times out before the closure
    // executes. The closure checks this flag before dispatching so a timed-out
    // send does not dispatch after the caller has already received an error.
    let cancelled = false;
    queue.enqueue(async () => {
      if (cancelled) return;
      const dispatchResult = await this.dispatchMessage(channel, message, targetMember);
      delivered = true;
      if (!dispatchResult.ok) {
        dispatchError = dispatchResult.error;
        return;
      }
      const to = targetMember ?? 'all';
      const emitResult = await this.eventBus.emit('ChannelMessageSent', {
        channelId,
        from: 'external',
        to,
        round: channel.currentRound,
      });
      if (!emitResult.ok) {
        this.logger.error('Failed to emit ChannelMessageSent event', emitResult.error, { channelId });
      }
    });

    // Best-effort: wait for the queued task to finish so callers can observe
    // delivery before the promise resolves. The drain timeout ensures we do not
    // block indefinitely if a tmux call hangs.
    await queue.drain(10_000);

    // Guard against drain timeout racing the enqueued task: if the closure never
    // ran (drain expired before execution), cancel it and return an explicit error
    // rather than silently reporting ok() for an undelivered message.
    // ARCHITECTURE: SerialQueue is constructed internally (not injected), so the
    // 10-second drain timeout cannot be shortened in tests without making
    // drainTimeoutMs injectable. This guard is verified by inspection — mock
    // tmuxConnector resolves synchronously so drain() always completes before the
    // timeout in unit tests. A slow-connector test would require a design change.
    if (!delivered) {
      cancelled = true;
      return err(new AutobeatError(ErrorCode.INVALID_INPUT, `Message delivery timed out for channel '${channelId}'`));
    }
    if (dispatchError) return err(dispatchError);
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
    // Issue both status queries in parallel — independent reads, SQLite WAL supports concurrent reads
    const [activeResult, pausedResult] = await Promise.all([
      this.channelRepository.findByStatus(ChannelStatus.ACTIVE),
      this.channelRepository.findByStatus(ChannelStatus.PAUSED),
    ]);
    if (!activeResult.ok) return activeResult;
    if (!pausedResult.ok) return pausedResult;

    const channels = [...activeResult.value, ...pausedResult.value];

    // Batch liveness check: one listSessions() exec instead of N sequential has-session
    // calls — same pattern RecoveryManager uses. Falls back to per-member isAlive()
    // when tmuxSessionManager is absent (e.g. test environments).
    let aliveSessionNames: Set<string> | undefined;
    if (this.tmuxSessionManager) {
      const listResult = this.tmuxSessionManager.listSessions();
      if (listResult.ok) {
        aliveSessionNames = new Set(listResult.value.map((s) => s.name));
      }
      // If listSessions() fails (no tmux server running), aliveSessionNames stays
      // undefined and recoverSingleChannel falls back to per-member isAlive().
    }

    for (const channel of channels) {
      await this.recoverSingleChannel(channel, aliveSessionNames);
    }

    return ok(undefined);
  }

  /**
   * Recover a single channel: classify members as alive/dead, then either destroy
   * the channel (all members dead) or rebuild its in-memory state (some alive).
   *
   * @param aliveSessionNames - Optional pre-built Set of live tmux session names from a
   *   single listSessions() call in recoverChannels(). When provided, liveness is checked
   *   via O(1) Set membership instead of a per-member tmux has-session exec. When absent,
   *   falls back to individual isAlive() calls.
   */
  private async recoverSingleChannel(channel: Channel, aliveSessionNames?: Set<string>): Promise<void> {
    const { aliveMembers, deadMembers } = this.classifyMemberLiveness(channel, aliveSessionNames);

    const nonDestroyedCount = channel.members.filter((m) => m.status !== ChannelMemberStatus.DESTROYED).length;
    if (aliveMembers.length === 0 && nonDestroyedCount > 0) {
      // All members dead — mark channel DESTROYED
      this.logger.warn('Recovery: all channel members dead, destroying channel', { channelId: channel.id });
      await this.channelRepository.updateStatus(channel.id, ChannelStatus.DESTROYED);
      const emitResult = await this.eventBus.emit('ChannelDestroyed', {
        channelId: channel.id,
        reason: 'all-members-crashed',
      });
      if (!emitResult.ok) {
        this.logger.error('Failed to emit ChannelDestroyed during recovery', emitResult.error, {
          channelId: channel.id,
        });
      }
      return;
    }

    // Batch-update dead members to DESTROYED in one transaction — avoids N individual
    // UPDATE statements when multiple members are dead across channels on recovery.
    if (deadMembers.length > 0) {
      const deadNames = deadMembers.map((m) => m.name);
      await this.channelRepository.batchUpdateMemberStatuses(channel.id, deadNames, ChannelMemberStatus.DESTROYED);
    }

    // Rebuild in-memory state
    this.messageQueues.set(channel.id, new SerialQueue());
    this.channelCache.set(channel.id, channel);
    if (channel.status === ChannelStatus.PAUSED) {
      this.pausedChannels.add(channel.id);
    }
    if (channel.communicationMode === 'round-robin') {
      this.initializeRoundRobinTurn(channel.id, aliveMembers);
    }

    this.logger.info('Recovery: channel state rebuilt', {
      channelId: channel.id,
      aliveCount: aliveMembers.length,
      deadCount: deadMembers.length,
    });
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
      const result = this.tmuxConnector.destroy(handle);
      if (!result.ok) {
        this.logger.warn('Failed to destroy session during dispose', {
          sessionName: handle.sessionName,
          error: result.error.message,
        });
      }
    }
    this.memberHandles.clear();
    this.sessionToChannel.clear();
    this.channelCache.clear();
    this.pausedChannels.clear();
    this.currentTurn.clear();
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  /**
   * Register freshly-spawned member handles and the channel itself in the
   * in-memory maps, and initialize round-robin turn order when applicable.
   * Called from createChannel after all members are spawned successfully.
   */
  private registerInMemoryState(
    channel: Channel,
    spawnedHandles: Array<{ memberName: string; handle: TmuxHandle }>,
  ): void {
    for (const { memberName, handle } of spawnedHandles) {
      this.memberHandles.set(this.handleKey(channel.id, memberName), handle);
      this.sessionToChannel.set(handle.sessionName, channel.id);
    }
    this.messageQueues.set(channel.id, new SerialQueue());
    this.channelCache.set(channel.id, channel);
    if (channel.communicationMode === 'round-robin' && channel.members.length > 0) {
      this.initializeRoundRobinTurn(channel.id, channel.members);
    }
  }

  /**
   * Set the initial round-robin turn to the member with the earliest joinedAt
   * timestamp. Safe to call with an empty members array (no-op).
   */
  private initializeRoundRobinTurn(channelId: ChannelId, members: readonly ChannelMember[]): void {
    if (members.length === 0) return;
    const sorted = [...members].sort((a, b) => a.joinedAt - b.joinedAt);
    // Non-null: length guard above ensures sorted is non-empty.
    this.currentTurn.set(channelId, sorted[0]!.name);
  }

  /**
   * Walk a channel's non-destroyed members and classify each as alive or dead
   * using either the pre-built batch session set (O(1) lookup) or individual
   * isAlive() exec calls when the set is unavailable.
   *
   * Side effect: alive members are registered into memberHandles and
   * sessionToChannel so callers can proceed directly to state rebuild.
   */
  private classifyMemberLiveness(
    channel: Channel,
    aliveSessionNames?: Set<string>,
  ): { aliveMembers: ChannelMember[]; deadMembers: ChannelMember[] } {
    const aliveMembers: ChannelMember[] = [];
    const deadMembers: ChannelMember[] = [];

    for (const member of channel.members) {
      if (member.status === ChannelMemberStatus.DESTROYED) continue;

      // DECISION: TmuxHandle.taskId is typed as TaskId (task domain), but isAlive() only
      // uses sessionName — taskId is not transmitted to tmux. A sentinel TaskId derived
      // from the channel id is used so the branded type is satisfied without a double-cast.
      const fakeHandle: TmuxHandle = {
        sessionName: member.tmuxSession,
        taskId: TaskId(channel.id),
        sessionsDir: this.sessionsDir,
      };

      // Use the batch session set when available (O(1)); fall back to per-member exec.
      let isAlive: boolean;
      if (aliveSessionNames) {
        isAlive = aliveSessionNames.has(member.tmuxSession);
      } else {
        const aliveResult = this.tmuxConnector.isAlive(fakeHandle);
        isAlive = aliveResult.ok && aliveResult.value;
      }

      if (isAlive) {
        aliveMembers.push(member);
        this.memberHandles.set(this.handleKey(channel.id, member.name), fakeHandle);
        this.sessionToChannel.set(member.tmuxSession, channel.id);
      } else {
        deadMembers.push(member);
      }
    }

    return { aliveMembers, deadMembers };
  }

  /**
   * Validate a createChannel request (steps 1–5).
   * Returns err on the first validation failure.
   */
  private async validateCreateRequest(request: ChannelCreateRequest): Promise<Result<void>> {
    // 1. Validate channel name
    if (!CHANNEL_NAME_REGEX.test(request.name)) {
      const truncatedName = request.name.slice(0, 64);
      return err(
        new AutobeatError(
          ErrorCode.INVALID_INPUT,
          `Invalid channel name '${truncatedName}': must match ${CHANNEL_NAME_REGEX}`,
          { name: request.name },
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

    // 5b. Validate maxRounds range when provided
    if (request.maxRounds !== undefined && (request.maxRounds < 1 || request.maxRounds > 10000)) {
      return err(
        new AutobeatError(ErrorCode.INVALID_INPUT, `maxRounds must be between 1 and 10000 (got ${request.maxRounds})`, {
          maxRounds: request.maxRounds,
        }),
      );
    }

    return ok(undefined);
  }

  /**
   * Spawn tmux sessions for all channel members in parallel.
   * On any failure, destroys all successfully-spawned sessions before returning the error.
   *
   * DESIGN DECISION: Promise.allSettled parallelizes the spawn calls so channel creation
   * latency is max(spawn_i) rather than sum(spawn_i). Each spawnMemberSession is
   * independent (different session name, no shared state) so concurrent spawns are safe.
   */
  private async spawnMembersWithRollback(
    channelName: string,
    members: ChannelCreateRequest['members'],
    workingDirectory: string,
  ): Promise<Result<Array<{ memberName: string; handle: TmuxHandle }>>> {
    const results = await Promise.allSettled(
      members.map(async (member) => {
        const spawnResult = await this.spawnMemberSession(channelName, member, workingDirectory);
        if (!spawnResult.ok) throw spawnResult.error;
        return { memberName: member.name, handle: spawnResult.value };
      }),
    );

    const spawnedHandles: Array<{ memberName: string; handle: TmuxHandle }> = [];
    let firstError: Error | undefined;

    for (const result of results) {
      if (result.status === 'fulfilled') {
        spawnedHandles.push(result.value);
      } else {
        firstError ??= result.reason instanceof Error ? result.reason : new Error(String(result.reason));
      }
    }

    if (firstError) {
      await this.destroyHandles(spawnedHandles.map((s) => s.handle));
      return err(firstError);
    }

    return ok(spawnedHandles);
  }

  /**
   * Spawn a tmux session for a single channel member.
   * Session name: beat-channel-{channelName}-{memberName} (per createChannel domain factory)
   */
  private async spawnMemberSession(
    channelName: string,
    member: { name: string; agent: string; systemPrompt?: string },
    workingDirectory: string,
  ): Promise<Result<TmuxHandle>> {
    if (!isAgentProvider(member.agent)) {
      return err(
        new AutobeatError(ErrorCode.INVALID_INPUT, `Agent '${member.agent}' is not a valid agent provider`, {
          agent: member.agent,
          memberName: member.name,
        }),
      );
    }
    const agentResult = this.agentRegistry.get(member.agent);
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
      taskId: TaskId(`channel-${channelName}-${member.name}`),
      prompt: '',
      systemPrompt: member.systemPrompt,
      workingDirectory,
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
   * Route and deliver an external message to the appropriate member(s).
   * Returns err if targetMember is specified but not found or not active.
   * Targeted delivery: sends to the named member only.
   * Round-robin: sends to the current turn member (or broadcasts as fallback).
   * Broadcast/directed/other: delivers to all active members.
   */
  private async dispatchMessage(channel: Channel, message: string, targetMember?: string): Promise<Result<void>> {
    if (targetMember !== undefined) {
      const member = channel.members.find((m) => m.name === targetMember && m.status === ChannelMemberStatus.ACTIVE);
      if (!member) {
        return err(
          new AutobeatError(
            ErrorCode.INVALID_INPUT,
            `Target member '${targetMember}' not found or not active in channel '${channel.id}'`,
          ),
        );
      }
      const handle = this.memberHandles.get(this.handleKey(channel.id, member.name));
      if (handle) {
        await this.deliverMessage(handle, message);
      }
      return ok(undefined);
    }

    if (channel.communicationMode === 'round-robin') {
      const currentTurn = this.currentTurn.get(channel.id);
      if (currentTurn) {
        const handle = this.memberHandles.get(this.handleKey(channel.id, currentTurn));
        if (handle) {
          await this.deliverMessage(handle, message);
        }
      } else {
        // Fallback: deliver to all active members
        await this.broadcastToActiveMembers(channel, message);
      }
    } else {
      // broadcast / directed / no mode: deliver to all active members
      await this.broadcastToActiveMembers(channel, message);
    }

    return ok(undefined);
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
      // broadcast / directed / no-mode: deliver to all in parallel — independent sessions
      await Promise.all(spawnedHandles.map(({ handle }) => this.deliverMessage(handle, topic)));
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
      return; // Skip Enter — no content was pasted
    }
    const enterResult = this.tmuxConnector.sendControlKeys(handle, 'Enter');
    if (!enterResult.ok) {
      this.logger.warn('Failed to send Enter after paste', {
        sessionName: handle.sessionName,
        error: enterResult.error.message,
      });
    }
  }

  /**
   * Broadcast a message to all active members in a channel.
   * Delivers in parallel — each member has an independent tmux session so
   * concurrent pasteContent+Enter calls do not interfere with each other.
   */
  private async broadcastToActiveMembers(channel: Channel, content: string): Promise<void> {
    const deliveries: Promise<void>[] = [];
    for (const member of channel.members) {
      if (member.status === ChannelMemberStatus.ACTIVE) {
        const handle = this.memberHandles.get(this.handleKey(channel.id, member.name));
        if (handle) {
          deliveries.push(this.deliverMessage(handle, content));
        }
      }
    }
    await Promise.all(deliveries);
  }

  /**
   * Async handler for member output — enqueued in per-channel serial queue.
   * Finds the channel by session name, routes the message, and emits the event.
   */
  private handleMemberOutputAsync(sessionName: string, memberName: string, content: string): void {
    const channelId = this.findChannelIdBySession(sessionName);
    if (!channelId) return;

    const queue = this.messageQueues.get(channelId);
    if (!queue) return;

    queue.enqueue(
      () => this.routeAndDeliverMessage(channelId, memberName, content),
      (e: unknown) => {
        this.logger.warn('Unhandled error in channel message queue task', {
          channelId,
          memberName,
          error: e instanceof Error ? e.message : String(e),
        });
      },
    );
  }

  /**
   * Full message-routing pipeline for a single queued agent output.
   * Parses directed-target syntax, routes via ChannelRouter, delivers to targets,
   * updates round-robin turn state, and emits ChannelMessageSent.
   */
  private async routeAndDeliverMessage(channelId: ChannelId, memberName: string, content: string): Promise<void> {
    if (this.pausedChannels.has(channelId)) return;

    // Prefer the in-memory cache (populated at create/recover time, invalidated on member
    // crash and channel destroy). Fall back to a DB read only when the cache entry is absent
    // (e.g. first message after a cache invalidation).
    let channel = this.channelCache.get(channelId);
    if (!channel) {
      const channelResult = await this.channelRepository.findById(channelId);
      if (!channelResult.ok || !channelResult.value) return;
      channel = channelResult.value;
      this.channelCache.set(channelId, channel);
    }

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

    // Deliver to all targets in parallel — each target has an independent tmux session
    // so concurrent pasteContent+Enter calls do not interfere with each other.
    const deliveries: Promise<void>[] = [];
    for (const target of targets) {
      const handle = this.memberHandles.get(this.handleKey(channelId, target.memberName));
      if (handle) {
        deliveries.push(this.deliverMessage(handle, deliveryContent));
      }
    }
    await Promise.all(deliveries);

    // Update round-robin turn
    if (nextTurnMember) {
      this.currentTurn.set(channelId, nextTurnMember);
    }

    // Emit ChannelMessageSent
    const toValue = targets.length === 1 ? targets[0]!.memberName : 'all';
    const routedEmitResult = await this.eventBus.emit('ChannelMessageSent', {
      channelId,
      from: memberName,
      to: toValue,
      round: channel.currentRound,
    });
    if (!routedEmitResult.ok) {
      this.logger.error('Failed to emit ChannelMessageSent event', routedEmitResult.error, { channelId, memberName });
    }
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
        channelId,
        memberName,
      })
      .catch((e: unknown) => {
        const error = e instanceof Error ? e : new Error(String(e));
        this.logger.error('Failed to emit ChannelMemberCrashed', error, { channelId, memberName });
      });
  }

  /**
   * React to ChannelDestroyed events emitted by ChannelHandler (max-rounds-reached,
   * all-members-crashed). Performs session teardown and DB status update.
   *
   * When destroyChannel() is the initiator it updates DB *before* emitting, so
   * findById will return status DESTROYED — we skip to avoid double work.
   * Only ChannelHandler-initiated destroys (DB still ACTIVE or PAUSED) need handling.
   */
  private async handleChannelDestroyedEvent(event: ChannelDestroyedEvent): Promise<void> {
    const { channelId } = event;

    const channelResult = await this.channelRepository.findById(channelId);
    if (!channelResult.ok || !channelResult.value) return;
    const channel = channelResult.value;

    // Already DESTROYED — this event was emitted by destroyChannel(); skip.
    if (channel.status === ChannelStatus.DESTROYED) return;

    // Force-destroy all active member sessions (same rationale as destroyChannel — no timer).
    for (const member of channel.members) {
      if (member.status !== ChannelMemberStatus.DESTROYED) {
        const handle = this.memberHandles.get(this.handleKey(channelId, member.name));
        if (handle) {
          this.tmuxConnector.destroy(handle);
        }
      }
    }

    // Update DB status
    const statusResult = await this.channelRepository.updateStatus(channelId, ChannelStatus.DESTROYED);
    if (!statusResult.ok) {
      this.logger.warn('Failed to update channel status to DESTROYED after event-driven destroy', {
        channelId,
        reason: event.reason,
        error: statusResult.error.message,
      });
    }

    // Clean up in-memory state
    this.cleanupInMemory(channelId);

    this.logger.info('Channel torn down via event-driven destroy', { channelId, reason: event.reason });
  }

  /**
   * Find the channel ID that owns a given session name.
   * O(1) lookup via the sessionToChannel reverse-index maintained alongside memberHandles.
   */
  private findChannelIdBySession(sessionName: string): ChannelId | undefined {
    return this.sessionToChannel.get(sessionName);
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
    // Remove all member handles and session→channel entries for this channel.
    // Two-pass to avoid mutating the Map during iteration.
    const prefix = `${channelId}:`;
    const keysToDelete: string[] = [];
    for (const [key, handle] of this.memberHandles) {
      if (key.startsWith(prefix)) {
        this.sessionToChannel.delete(handle.sessionName);
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this.memberHandles.delete(key);
    }

    const queue = this.messageQueues.get(channelId);
    if (queue) {
      queue.close();
      this.messageQueues.delete(channelId);
    }

    this.channelCache.delete(channelId);
    this.pausedChannels.delete(channelId);
    this.currentTurn.delete(channelId);
  }

  /** Composite key for memberHandles map. */
  private handleKey(channelId: string, memberName: string): string {
    return `${channelId}:${memberName}`;
  }
}
