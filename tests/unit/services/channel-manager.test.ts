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
} from '../../../src/core/domain.js';
import { InMemoryEventBus } from '../../../src/core/events/event-bus.js';
import type { ChannelRepository } from '../../../src/core/interfaces.js';
import { ok } from '../../../src/core/result.js';
import { ChannelManager } from '../../../src/services/channel-manager.js';
import { createTestConfiguration } from '../../fixtures/factories.js';
import { TestLogger } from '../../fixtures/test-doubles.js';
import { flushEventLoop } from '../../utils/event-helpers.js';

// ─── Test doubles ─────────────────────────────────────────────────────────────

interface MockTmuxHandle {
  sessionName: string;
  taskId: string;
  sessionsDir: string;
}

function createMockTmuxConnector() {
  const spawnedSessions: string[] = [];
  const destroyedSessions: string[] = [];
  const pastedContent: Array<{ session: string; content: string }> = [];

  const connector = {
    spawn: vi.fn().mockImplementation((config: { name: string; taskId: string; sessionsDir: string }) => {
      spawnedSessions.push(config.name);
      return ok<MockTmuxHandle>({ sessionName: config.name, taskId: config.taskId, sessionsDir: config.sessionsDir });
    }),
    destroy: vi.fn().mockImplementation((handle: MockTmuxHandle) => {
      destroyedSessions.push(handle.sessionName);
      return ok(undefined);
    }),
    sendKeys: vi.fn().mockReturnValue(ok(undefined)),
    sendControlKeys: vi.fn().mockReturnValue(ok(undefined)),
    isAlive: vi.fn().mockReturnValue(ok(true)),
    setEnvironment: vi.fn().mockReturnValue(ok(undefined)),
    pasteContent: vi.fn().mockImplementation((handle: MockTmuxHandle, content: string) => {
      pastedContent.push({ session: handle.sessionName, content });
      return ok(undefined);
    }),
    getActiveHandles: vi.fn().mockReturnValue([]),
    dispose: vi.fn(),
    // Test inspection
    _spawnedSessions: spawnedSessions,
    _destroyedSessions: destroyedSessions,
    _pastedContent: pastedContent,
  };
  return connector;
}

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

    manager = new ChannelManager({
      eventBus,
      logger,
      channelRepository: channelRepo,
      config,
      tmuxConnector: tmuxConnector as ReturnType<typeof createMockTmuxConnector>,
      agentRegistry: agentRegistry as ReturnType<typeof createMockAgentRegistry>,
      sessionsDir,
    });
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
      (channelRepo.findByName as ReturnType<typeof vi.fn>).mockImplementation(async (name: string) => {
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
      (tmuxConnector.pasteContent as ReturnType<typeof vi.fn>).mockClear();

      const sendResult = await manager.sendMessage(createResult.value.id, 'hello everyone');
      expect(sendResult.ok).toBe(true);

      // All 3 members should receive the message
      expect(tmuxConnector.pasteContent).toHaveBeenCalledTimes(3);
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

      (tmuxConnector.pasteContent as ReturnType<typeof vi.fn>).mockClear();

      const sendResult = await manager.sendMessage(createResult.value.id, 'hello b only', 'b');
      expect(sendResult.ok).toBe(true);

      // Only 1 member (b) should receive it
      expect(tmuxConnector.pasteContent).toHaveBeenCalledOnce();
      const call = (tmuxConnector.pasteContent as ReturnType<typeof vi.fn>).mock.calls[0] as [MockTmuxHandle, string];
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
      (channelRepo.findByStatus as ReturnType<typeof vi.fn>).mockImplementation(async (status: ChannelStatus) => {
        if (status === ChannelStatus.ACTIVE) return ok([deadChannel]);
        return ok([]);
      });

      // Sessions are dead
      (tmuxConnector.isAlive as ReturnType<typeof vi.fn>).mockReturnValue(ok(false));

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
      (channelRepo.findByStatus as ReturnType<typeof vi.fn>).mockImplementation(async (status: ChannelStatus) => {
        if (status === ChannelStatus.ACTIVE) return ok([aliveChannel]);
        return ok([]);
      });

      // Sessions are alive
      (tmuxConnector.isAlive as ReturnType<typeof vi.fn>).mockReturnValue(ok(true));

      const destroyedEvents: unknown[] = [];
      eventBus.subscribe('ChannelDestroyed', async (e) => destroyedEvents.push(e));

      await manager.recoverChannels();
      await flushEventLoop();

      // Channel was alive — should not be destroyed
      expect(destroyedEvents).toHaveLength(0);
    });
  });
});
