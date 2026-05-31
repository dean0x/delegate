/**
 * Unit tests for ChannelManager
 * ARCHITECTURE: MockTmuxConnector + mock ChannelRepository + real EventBus
 * Pattern: Behavioral testing — assert observable state and events, not internals.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Channel,
  type ChannelCreateRequest,
  ChannelId,
  ChannelMemberStatus,
  ChannelStatus,
  TaskId,
} from '../../../src/core/domain.js';
import { InMemoryEventBus } from '../../../src/core/events/event-bus.js';
import type { ChannelRepository } from '../../../src/core/interfaces.js';
import { ok } from '../../../src/core/result.js';
import type { TmuxHandle } from '../../../src/core/tmux-types.js';
import { ChannelManager } from '../../../src/services/channel-manager.js';
import { createTestConfiguration } from '../../fixtures/factories.js';
import { createMockTmuxConnector } from '../../fixtures/mocks.js';
import { TestLogger } from '../../fixtures/test-doubles.js';
import { flushEventLoop } from '../../utils/event-helpers.js';

// ─── Test doubles ─────────────────────────────────────────────────────────────

function createMockAgentRegistry() {
  return {
    get: vi.fn().mockReturnValue({
      ok: true,
      value: {
        buildTmuxCommand: vi.fn().mockReturnValue(
          ok({
            config: {
              taskId: 'mock-task',
              sessionsDir: '/tmp/sessions',
              name: 'beat-mock',
              command: 'claude',
              agentArgs: ['--print'],
              persistent: true,
            },
            prompt: '',
          }),
        ),
      },
    }),
    list: vi.fn().mockReturnValue([]),
  };
}

type MockChannelMap = Map<string, Channel>;

function createMockChannelRepo(initialChannels: Channel[] = []): ChannelRepository & { _channels: MockChannelMap } {
  const channels: MockChannelMap = new Map(initialChannels.map((c) => [c.id, c]));

  return {
    _channels: channels,
    save: vi.fn().mockImplementation(async (channel: Channel) => {
      channels.set(channel.id, channel);
      return ok(undefined);
    }),
    findById: vi.fn().mockImplementation(async (id: string) => ok(channels.get(id) ?? null)),
    findByName: vi.fn().mockImplementation(async (name: string) => {
      const found = [...channels.values()].find((c) => c.name === name);
      return ok(found ?? null);
    }),
    findAll: vi.fn().mockResolvedValue(ok([])),
    findByStatus: vi.fn().mockImplementation(async (status: ChannelStatus) => {
      const found = [...channels.values()].filter((c) => c.status === status);
      return ok(found);
    }),
    updateStatus: vi.fn().mockImplementation(async (id: string, status: ChannelStatus) => {
      const ch = channels.get(id);
      if (ch) channels.set(id, { ...ch, status });
      return ok(undefined);
    }),
    updateRound: vi.fn().mockImplementation(async (id: string, round: number) => {
      const ch = channels.get(id);
      if (ch) channels.set(id, { ...ch, currentRound: round });
      return ok(undefined);
    }),
    addMember: vi.fn().mockResolvedValue(ok(undefined)),
    updateMemberStatus: vi
      .fn()
      .mockImplementation(async (id: string, memberName: string, status: ChannelMemberStatus) => {
        const ch = channels.get(id);
        if (ch) {
          channels.set(id, {
            ...ch,
            members: ch.members.map((m) => (m.name === memberName ? { ...m, status } : m)),
          });
        }
        return ok(undefined);
      }),
    batchUpdateMemberStatuses: vi
      .fn()
      .mockImplementation(async (id: string, memberNames: string[], status: ChannelMemberStatus) => {
        const ch = channels.get(id);
        if (ch) {
          const nameSet = new Set(memberNames);
          channels.set(id, {
            ...ch,
            members: ch.members.map((m) => (nameSet.has(m.name) ? { ...m, status } : m)),
          });
        }
        return ok(undefined);
      }),
    delete: vi.fn().mockResolvedValue(ok(undefined)),
    count: vi.fn().mockResolvedValue(ok(0)),
    countByStatus: vi.fn().mockResolvedValue(ok({})),
  };
}

// ─── Channel Manager tests ────────────────────────────────────────────────────

describe('ChannelManager', () => {
  let eventBus: InMemoryEventBus;
  let logger: TestLogger;
  let tmuxConnector: ReturnType<typeof createMockTmuxConnector>;
  let agentRegistry: ReturnType<typeof createMockAgentRegistry>;
  let channelRepo: ReturnType<typeof createMockChannelRepo>;
  let manager: ChannelManager;
  const sessionsDir = '/tmp/sessions';

  beforeEach(async () => {
    logger = new TestLogger();
    const config = createTestConfiguration();
    eventBus = new InMemoryEventBus(config, logger);
    tmuxConnector = createMockTmuxConnector();
    agentRegistry = createMockAgentRegistry();
    channelRepo = createMockChannelRepo();

    const managerResult = await ChannelManager.create({
      eventBus,
      logger,
      channelRepository: channelRepo,
      config,
      tmuxConnector: tmuxConnector as ReturnType<typeof createMockTmuxConnector>,
      agentRegistry: agentRegistry as ReturnType<typeof createMockAgentRegistry>,
      sessionsDir,
    });
    if (!managerResult.ok) {
      throw new Error(`Failed to create ChannelManager: ${managerResult.error.message}`);
    }
    manager = managerResult.value;
  });

  afterEach(() => {
    // Dispose to clean up any timers/state
    manager.dispose();
  });

  // ─── create() ───────────────────────────────────────────────────────────────

  describe('createChannel()', () => {
    it('creates a single-agent channel with no communication mode', async () => {
      const request: ChannelCreateRequest = {
        name: 'my-channel',
        members: [{ name: 'agent1', agent: 'claude' }],
      };

      const result = await manager.createChannel(request);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.name).toBe('my-channel');
      expect(result.value.status).toBe(ChannelStatus.ACTIVE);
      expect(result.value.members).toHaveLength(1);
      expect(tmuxConnector.spawn).toHaveBeenCalledOnce();
    });

    it('creates a broadcast channel with multiple members', async () => {
      const request: ChannelCreateRequest = {
        name: 'broadcast-ch',
        members: [
          { name: 'alice', agent: 'claude' },
          { name: 'bob', agent: 'claude' },
          { name: 'carol', agent: 'claude' },
        ],
        communicationMode: 'broadcast',
        maxRounds: 5,
      };

      const result = await manager.createChannel(request);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(tmuxConnector.spawn).toHaveBeenCalledTimes(3);
      // Channel persisted to repo
      expect(channelRepo.save).toHaveBeenCalled();
    });

    it('emits ChannelCreated event after successful creation', async () => {
      const createdEvents: unknown[] = [];
      eventBus.subscribe('ChannelCreated', async (event) => {
        createdEvents.push(event);
      });

      const request: ChannelCreateRequest = {
        name: 'event-ch',
        members: [{ name: 'agent1', agent: 'claude' }],
      };

      await manager.createChannel(request);
      await flushEventLoop();

      expect(createdEvents).toHaveLength(1);
    });

    it('rejects duplicate channel name', async () => {
      // Pre-populate repo with existing channel
      const existingChannel: Channel = {
        id: ChannelId('ch-existing'),
        name: 'taken-name',
        members: [],
        status: ChannelStatus.ACTIVE,
        currentRound: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      channelRepo._channels.set('ch-existing', existingChannel);
      vi.mocked(channelRepo.findByName).mockImplementation(async (name: string) => {
        const found = [...channelRepo._channels.values()].find((c) => c.name === name);
        return ok(found ?? null);
      });

      const result = await manager.createChannel({
        name: 'taken-name',
        members: [{ name: 'a', agent: 'claude' }],
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_INPUT');
    });

    it('rejects invalid channel name (uppercase)', async () => {
      const result = await manager.createChannel({
        name: 'UPPERCASE',
        members: [{ name: 'a', agent: 'claude' }],
      });
      expect(result.ok).toBe(false);
    });

    it('rejects duplicate member names', async () => {
      const result = await manager.createChannel({
        name: 'ch-dup',
        members: [
          { name: 'agent', agent: 'claude' },
          { name: 'agent', agent: 'claude' },
        ],
        communicationMode: 'broadcast',
        maxRounds: 5,
      });
      expect(result.ok).toBe(false);
    });

    it('rejects more than 10 members', async () => {
      const members = Array.from({ length: 11 }, (_, i) => ({ name: `m${i}`, agent: 'claude' as const }));
      const result = await manager.createChannel({
        name: 'too-many',
        members,
        communicationMode: 'broadcast',
        maxRounds: 5,
      });
      expect(result.ok).toBe(false);
    });

    it('rejects zero members', async () => {
      const result = await manager.createChannel({
        name: 'no-members',
        members: [],
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_INPUT');
    });

    it('rejects multi-agent channel without maxRounds', async () => {
      const result = await manager.createChannel({
        name: 'no-max',
        members: [
          { name: 'a', agent: 'claude' },
          { name: 'b', agent: 'claude' },
        ],
        communicationMode: 'broadcast',
        // maxRounds intentionally omitted
      });
      expect(result.ok).toBe(false);
    });

    it('delivers topic to all members after broadcast channel creation', async () => {
      const result = await manager.createChannel({
        name: 'topic-ch',
        members: [
          { name: 'alice', agent: 'claude' },
          { name: 'bob', agent: 'claude' },
        ],
        communicationMode: 'broadcast',
        maxRounds: 5,
        topic: 'Discuss the architecture',
      });
      expect(result.ok).toBe(true);

      // Topic delivered to all members
      expect(tmuxConnector.pasteContent).toHaveBeenCalled();
    });

    it('delivers topic to first member only for round-robin channel', async () => {
      const result = await manager.createChannel({
        name: 'rr-topic',
        members: [
          { name: 'alice', agent: 'claude' },
          { name: 'bob', agent: 'claude' },
        ],
        communicationMode: 'round-robin',
        maxRounds: 5,
        topic: 'Start the discussion',
      });
      expect(result.ok).toBe(true);

      // Topic delivered to exactly 1 member (first in round-robin)
      expect(tmuxConnector.pasteContent).toHaveBeenCalledOnce();
    });

    it('rolls back spawned sessions when a later member spawn fails', async () => {
      // First spawn succeeds, second fails
      let spawnCallCount = 0;
      vi.mocked(tmuxConnector.spawn).mockImplementation(
        (config: { name: string; taskId: string; sessionsDir: string }) => {
          spawnCallCount++;
          if (spawnCallCount === 1) {
            return ok<TmuxHandle>({
              sessionName: config.name,
              taskId: TaskId(config.taskId),
              sessionsDir: config.sessionsDir,
            });
          }
          return { ok: false, error: new Error('Spawn failed on second member') };
        },
      );

      const result = await manager.createChannel({
        name: 'rollback-spawn',
        members: [
          { name: 'first', agent: 'claude' },
          { name: 'second', agent: 'claude' },
        ],
        communicationMode: 'broadcast',
        maxRounds: 5,
      });

      expect(result.ok).toBe(false);
      // The first successfully-spawned session must be destroyed to avoid leaking
      expect(tmuxConnector.destroy).toHaveBeenCalledOnce();
    });

    it('rolls back spawned sessions and cleans up in-memory state when save() fails', async () => {
      vi.mocked(channelRepo.save).mockResolvedValueOnce({
        ok: false,
        error: new Error('DB write failed'),
      });

      const result = await manager.createChannel({
        name: 'rollback-save',
        members: [
          { name: 'x', agent: 'claude' },
          { name: 'y', agent: 'claude' },
        ],
        communicationMode: 'broadcast',
        maxRounds: 5,
      });

      expect(result.ok).toBe(false);
      // Both spawned sessions must be destroyed
      expect(tmuxConnector.destroy).toHaveBeenCalledTimes(2);
    });
  });

  // ─── destroyChannel() ───────────────────────────────────────────────────────

  describe('destroyChannel()', () => {
    it('kills all active member sessions and updates DB status', async () => {
      // Create the channel first
      const createResult = await manager.createChannel({
        name: 'destroy-me',
        members: [
          { name: 'alice', agent: 'claude' },
          { name: 'bob', agent: 'claude' },
        ],
        communicationMode: 'broadcast',
        maxRounds: 10,
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const channelId = createResult.value.id;

      const destroyResult = await manager.destroyChannel(channelId, 'user-requested');
      expect(destroyResult.ok).toBe(true);

      // Sessions force-destroyed directly (no C-c grace period — no timer available)
      expect(tmuxConnector.destroy).toHaveBeenCalled();

      // DB status updated
      expect(channelRepo.updateStatus).toHaveBeenCalledWith(channelId, ChannelStatus.DESTROYED);
    });

    it('emits ChannelDestroyed event', async () => {
      const destroyedEvents: unknown[] = [];
      eventBus.subscribe('ChannelDestroyed', async (event) => {
        destroyedEvents.push(event);
      });

      const createResult = await manager.createChannel({
        name: 'evented-destroy',
        members: [{ name: 'a', agent: 'claude' }],
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      await manager.destroyChannel(createResult.value.id);
      await flushEventLoop();

      expect(destroyedEvents).toHaveLength(1);
    });

    it('handles ChannelDestroyed event from ChannelHandler when DB is still ACTIVE', async () => {
      // Create a channel so in-memory handles are registered
      const createResult = await manager.createChannel({
        name: 'handler-destroy',
        members: [
          { name: 'alice', agent: 'claude' },
          { name: 'bob', agent: 'claude' },
        ],
        communicationMode: 'broadcast',
        maxRounds: 3,
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const channelId = createResult.value.id;

      // Clear prior destroy/status calls from channel creation
      vi.mocked(tmuxConnector.destroy).mockClear();
      vi.mocked(channelRepo.updateStatus).mockClear();

      // Emit ChannelDestroyed with reason 'max-rounds-reached' — simulates ChannelHandler
      // initiating a destroy while DB is still ACTIVE (channel not yet marked DESTROYED).
      await eventBus.emit('ChannelDestroyed', {
        channelId,
        reason: 'max-rounds-reached',
      });
      await flushEventLoop();

      // ChannelManager must tear down all active member sessions
      expect(tmuxConnector.destroy).toHaveBeenCalled();
      // And update DB status to DESTROYED
      expect(channelRepo.updateStatus).toHaveBeenCalledWith(channelId, ChannelStatus.DESTROYED);
    });

    it('returns err(INVALID_INPUT) for already destroyed channel', async () => {
      // Save a destroyed channel directly
      const destroyedChannel: Channel = {
        id: ChannelId('ch-dead'),
        name: 'dead-channel',
        members: [],
        status: ChannelStatus.DESTROYED,
        currentRound: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      channelRepo._channels.set('ch-dead', destroyedChannel);

      const result = await manager.destroyChannel(ChannelId('ch-dead'));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_INPUT');
    });
  });

  // ─── sendMessage() ──────────────────────────────────────────────────────────

  describe('sendMessage()', () => {
    it('delivers message to all active members in broadcast mode', async () => {
      const createResult = await manager.createChannel({
        name: 'send-ch',
        members: [
          { name: 'a', agent: 'claude' },
          { name: 'b', agent: 'claude' },
          { name: 'c', agent: 'claude' },
        ],
        communicationMode: 'broadcast',
        maxRounds: 10,
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      // Clear spawn-time calls (topic delivery if any)
      vi.mocked(tmuxConnector.pasteContent).mockClear();

      const sendResult = await manager.sendMessage(createResult.value.id, 'hello everyone');
      expect(sendResult.ok).toBe(true);

      // All 3 members should receive the message
      expect(tmuxConnector.pasteContent).toHaveBeenCalledTimes(3);
      // Every delivered content must equal the sent message
      for (const [, content] of vi.mocked(tmuxConnector.pasteContent).mock.calls) {
        expect(content).toBe('hello everyone');
      }
    });

    it('delivers message to specific target member when targetMember is provided', async () => {
      const createResult = await manager.createChannel({
        name: 'targeted-ch',
        members: [
          { name: 'a', agent: 'claude' },
          { name: 'b', agent: 'claude' },
        ],
        communicationMode: 'broadcast',
        maxRounds: 10,
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      vi.mocked(tmuxConnector.pasteContent).mockClear();

      const sendResult = await manager.sendMessage(createResult.value.id, 'hello b only', 'b');
      expect(sendResult.ok).toBe(true);

      // Only 1 member (b) should receive it
      expect(tmuxConnector.pasteContent).toHaveBeenCalledOnce();
      const call = vi.mocked(tmuxConnector.pasteContent).mock.calls[0] as [TmuxHandle, string];
      expect(call[0].sessionName).toContain('b');
    });

    it('returns err when channel is paused', async () => {
      const createResult = await manager.createChannel({
        name: 'paused-send',
        members: [{ name: 'a', agent: 'claude' }],
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      await manager.pauseChannel(createResult.value.id);
      const sendResult = await manager.sendMessage(createResult.value.id, 'blocked');

      expect(sendResult.ok).toBe(false);
    });

    it('returns err for unknown targetMember', async () => {
      const createResult = await manager.createChannel({
        name: 'unknown-target',
        members: [{ name: 'a', agent: 'claude' }],
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const sendResult = await manager.sendMessage(createResult.value.id, 'hello', 'nonexistent');
      expect(sendResult.ok).toBe(false);
    });
  });

  // ─── pause() / resume() ─────────────────────────────────────────────────────

  describe('pause() and resume()', () => {
    it('pauses an active channel', async () => {
      const createResult = await manager.createChannel({
        name: 'pause-me',
        members: [{ name: 'a', agent: 'claude' }],
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const pauseResult = await manager.pauseChannel(createResult.value.id);
      expect(pauseResult.ok).toBe(true);

      expect(channelRepo.updateStatus).toHaveBeenCalledWith(createResult.value.id, ChannelStatus.PAUSED);
    });

    it('resumes a paused channel', async () => {
      const createResult = await manager.createChannel({
        name: 'resume-me',
        members: [{ name: 'a', agent: 'claude' }],
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      await manager.pauseChannel(createResult.value.id);
      const resumeResult = await manager.resumeChannel(createResult.value.id);

      expect(resumeResult.ok).toBe(true);
      expect(channelRepo.updateStatus).toHaveBeenCalledWith(createResult.value.id, ChannelStatus.ACTIVE);
    });

    it('returns err when pausing an already paused channel', async () => {
      const createResult = await manager.createChannel({
        name: 'already-paused',
        members: [{ name: 'a', agent: 'claude' }],
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      await manager.pauseChannel(createResult.value.id);
      const secondPause = await manager.pauseChannel(createResult.value.id);
      expect(secondPause.ok).toBe(false);
    });

    it('returns err when resuming an already active channel', async () => {
      const createResult = await manager.createChannel({
        name: 'already-active',
        members: [{ name: 'a', agent: 'claude' }],
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      // Channel is already active — resuming should fail
      const resumeResult = await manager.resumeChannel(createResult.value.id);
      expect(resumeResult.ok).toBe(false);
    });

    it('emits ChannelPaused and ChannelResumed events', async () => {
      const pausedEvents: unknown[] = [];
      const resumedEvents: unknown[] = [];
      eventBus.subscribe('ChannelPaused', async (e) => pausedEvents.push(e));
      eventBus.subscribe('ChannelResumed', async (e) => resumedEvents.push(e));

      const createResult = await manager.createChannel({
        name: 'event-pause',
        members: [{ name: 'a', agent: 'claude' }],
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      await manager.pauseChannel(createResult.value.id);
      await flushEventLoop();
      expect(pausedEvents).toHaveLength(1);

      await manager.resumeChannel(createResult.value.id);
      await flushEventLoop();
      expect(resumedEvents).toHaveLength(1);
    });
  });

  // ─── getChannel() / getChannelByName() / listChannels() ─────────────────────

  describe('query methods', () => {
    it('getChannel returns the channel by ID', async () => {
      const createResult = await manager.createChannel({
        name: 'query-ch',
        members: [{ name: 'a', agent: 'claude' }],
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const getResult = await manager.getChannel(createResult.value.id);
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;
      expect(getResult.value?.name).toBe('query-ch');
    });

    it('getChannelByName returns channel by name', async () => {
      await manager.createChannel({
        name: 'named-ch',
        members: [{ name: 'a', agent: 'claude' }],
      });

      const result = await manager.getChannelByName('named-ch');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value?.name).toBe('named-ch');
    });

    it('listChannels returns channels filtered by status', async () => {
      await manager.createChannel({
        name: 'list-ch',
        members: [{ name: 'a', agent: 'claude' }],
      });

      const result = await manager.listChannels(ChannelStatus.ACTIVE);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── Recovery ───────────────────────────────────────────────────────────────

  describe('recoverChannels()', () => {
    it('marks all-dead channels as DESTROYED without sessions', async () => {
      // Simulate an ACTIVE channel in DB with dead sessions
      const deadChannel: Channel = {
        id: ChannelId('ch-dead-recovery'),
        name: 'dead-channel',
        members: [
          {
            name: 'a',
            agent: 'claude',
            tmuxSession: 'beat-channel-dead-channel-a',
            status: ChannelMemberStatus.ACTIVE,
            joinedAt: Date.now(),
          },
        ],
        communicationMode: undefined,
        status: ChannelStatus.ACTIVE,
        currentRound: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      channelRepo._channels.set('ch-dead-recovery', deadChannel);
      vi.mocked(channelRepo.findByStatus).mockImplementation(async (status: ChannelStatus) => {
        if (status === ChannelStatus.ACTIVE) return ok([deadChannel]);
        return ok([]);
      });

      // Sessions are dead
      vi.mocked(tmuxConnector.isAlive).mockReturnValue(ok(false));

      const destroyedEvents: unknown[] = [];
      eventBus.subscribe('ChannelDestroyed', async (e) => destroyedEvents.push(e));

      await manager.recoverChannels();
      await flushEventLoop();

      expect(destroyedEvents).toHaveLength(1);
    });

    it('rebuilds in-memory state for alive channels', async () => {
      const aliveChannel: Channel = {
        id: ChannelId('ch-alive-recovery'),
        name: 'alive-channel',
        members: [
          {
            name: 'a',
            agent: 'claude',
            tmuxSession: 'beat-channel-alive-channel-a',
            status: ChannelMemberStatus.ACTIVE,
            joinedAt: Date.now(),
          },
        ],
        communicationMode: undefined,
        status: ChannelStatus.ACTIVE,
        currentRound: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      channelRepo._channels.set('ch-alive-recovery', aliveChannel);
      vi.mocked(channelRepo.findByStatus).mockImplementation(async (status: ChannelStatus) => {
        if (status === ChannelStatus.ACTIVE) return ok([aliveChannel]);
        return ok([]);
      });

      // Sessions are alive
      vi.mocked(tmuxConnector.isAlive).mockReturnValue(ok(true));

      const destroyedEvents: unknown[] = [];
      eventBus.subscribe('ChannelDestroyed', async (e) => destroyedEvents.push(e));

      await manager.recoverChannels();
      await flushEventLoop();

      // Channel was alive — should not be destroyed
      expect(destroyedEvents).toHaveLength(0);
    });

    it('uses batch listSessions() when tmuxSessionManager is provided', async () => {
      // Two members — one alive, one dead
      const mixedChannel: Channel = {
        id: ChannelId('ch-mixed-recovery'),
        name: 'mixed-channel',
        members: [
          {
            name: 'alive-member',
            agent: 'claude',
            tmuxSession: 'beat-channel-mixed-channel-alive-member',
            status: ChannelMemberStatus.ACTIVE,
            joinedAt: Date.now(),
          },
          {
            name: 'dead-member',
            agent: 'claude',
            tmuxSession: 'beat-channel-mixed-channel-dead-member',
            status: ChannelMemberStatus.ACTIVE,
            joinedAt: Date.now(),
          },
        ],
        communicationMode: undefined,
        status: ChannelStatus.ACTIVE,
        currentRound: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const sessionManagerMock = {
        isAlive: vi.fn(),
        sendControlKeys: vi.fn(),
        listSessions: vi
          .fn()
          .mockReturnValue(ok([{ name: 'beat-channel-mixed-channel-alive-member', created: Date.now() / 1000 }])),
        destroySession: vi.fn(),
      };

      const config = createTestConfiguration();
      const localEventBus = new InMemoryEventBus(config, logger);
      const localChannelRepo = createMockChannelRepo();
      vi.mocked(localChannelRepo.findByStatus).mockImplementation(async (status: ChannelStatus) => {
        if (status === ChannelStatus.ACTIVE) return ok([mixedChannel]);
        return ok([]);
      });

      const localManagerResult = await ChannelManager.create({
        eventBus: localEventBus,
        logger,
        channelRepository: localChannelRepo,
        config,
        tmuxConnector: tmuxConnector as ReturnType<typeof createMockTmuxConnector>,
        agentRegistry: agentRegistry as ReturnType<typeof createMockAgentRegistry>,
        sessionsDir,
        tmuxSessionManager: sessionManagerMock,
      });
      if (!localManagerResult.ok) {
        throw new Error(`Failed to create ChannelManager: ${localManagerResult.error.message}`);
      }
      const localManager = localManagerResult.value;

      await localManager.recoverChannels();
      await flushEventLoop();

      // listSessions() called once — not N times
      expect(sessionManagerMock.listSessions).toHaveBeenCalledOnce();
      // isAlive on the connector should NOT have been called (batch path used instead)
      expect(tmuxConnector.isAlive).not.toHaveBeenCalled();
      // Dead member batch-updated via batchUpdateMemberStatuses
      expect(localChannelRepo.batchUpdateMemberStatuses).toHaveBeenCalledOnce();

      localManager.dispose();
    });

    it('preserves paused state for PAUSED channels with alive sessions after recovery', async () => {
      const pausedChannel: Channel = {
        id: ChannelId('ch-paused-recovery'),
        name: 'paused-channel',
        members: [
          {
            name: 'a',
            agent: 'claude',
            tmuxSession: 'beat-channel-paused-channel-a',
            status: ChannelMemberStatus.ACTIVE,
            joinedAt: Date.now(),
          },
        ],
        communicationMode: undefined,
        status: ChannelStatus.PAUSED,
        currentRound: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      channelRepo._channels.set('ch-paused-recovery', pausedChannel);
      vi.mocked(channelRepo.findByStatus).mockImplementation(async (status: ChannelStatus) => {
        if (status === ChannelStatus.PAUSED) return ok([pausedChannel]);
        return ok([]);
      });

      // Sessions are alive
      vi.mocked(tmuxConnector.isAlive).mockReturnValue(ok(true));

      await manager.recoverChannels();
      await flushEventLoop();

      // Channel was PAUSED and alive — sendMessage must return a paused error,
      // confirming that pausedChannels.add() was called during recovery.
      const sendResult = await manager.sendMessage(ChannelId('ch-paused-recovery'), 'hello');
      expect(sendResult.ok).toBe(false);
      if (sendResult.ok) return;
      expect(sendResult.error.code).toBe('INVALID_INPUT');
    });

    it('falls back to per-member isAlive() when listSessions() fails', async () => {
      const channel: Channel = {
        id: ChannelId('ch-fallback-recovery'),
        name: 'fallback-channel',
        members: [
          {
            name: 'a',
            agent: 'claude',
            tmuxSession: 'beat-channel-fallback-channel-a',
            status: ChannelMemberStatus.ACTIVE,
            joinedAt: Date.now(),
          },
        ],
        communicationMode: undefined,
        status: ChannelStatus.ACTIVE,
        currentRound: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const failingSessionManager = {
        isAlive: vi.fn(),
        sendControlKeys: vi.fn(),
        listSessions: vi.fn().mockReturnValue({ ok: false, error: new Error('no tmux server') }),
        destroySession: vi.fn(),
      };

      const config = createTestConfiguration();
      const localEventBus = new InMemoryEventBus(config, logger);
      const localChannelRepo = createMockChannelRepo();
      vi.mocked(localChannelRepo.findByStatus).mockImplementation(async (status: ChannelStatus) => {
        if (status === ChannelStatus.ACTIVE) return ok([channel]);
        return ok([]);
      });
      // Session alive via per-member fallback
      vi.mocked(tmuxConnector.isAlive).mockReturnValue(ok(true));

      const localManagerResult = await ChannelManager.create({
        eventBus: localEventBus,
        logger,
        channelRepository: localChannelRepo,
        config,
        tmuxConnector: tmuxConnector as ReturnType<typeof createMockTmuxConnector>,
        agentRegistry: agentRegistry as ReturnType<typeof createMockAgentRegistry>,
        sessionsDir,
        tmuxSessionManager: failingSessionManager,
      });
      if (!localManagerResult.ok) {
        throw new Error(`Failed to create ChannelManager: ${localManagerResult.error.message}`);
      }
      const localManager = localManagerResult.value;

      await localManager.recoverChannels();

      // listSessions() was attempted but failed — fallback to isAlive
      expect(failingSessionManager.listSessions).toHaveBeenCalledOnce();
      expect(tmuxConnector.isAlive).toHaveBeenCalled();

      localManager.dispose();
    });
  });

  // ─── dispose() ──────────────────────────────────────────────────────────────

  describe('dispose()', () => {
    it('destroys all member sessions for all active channels', async () => {
      await manager.createChannel({
        name: 'dispose-ch-1',
        members: [
          { name: 'a', agent: 'claude' },
          { name: 'b', agent: 'claude' },
        ],
        communicationMode: 'broadcast',
        maxRounds: 5,
      });
      await manager.createChannel({
        name: 'dispose-ch-2',
        members: [{ name: 'c', agent: 'claude' }],
      });

      // Clear destroy calls from any prior test setup
      vi.mocked(tmuxConnector.destroy).mockClear();

      manager.dispose();

      // 3 sessions total (2 from first channel, 1 from second) must be destroyed
      expect(tmuxConnector.destroy).toHaveBeenCalledTimes(3);
    });
  });
});
