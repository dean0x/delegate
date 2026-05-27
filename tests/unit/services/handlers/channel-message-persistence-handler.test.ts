/**
 * Unit tests for ChannelMessagePersistenceHandler
 * ARCHITECTURE: Real in-memory SQLite + InMemoryEventBus — no process spawning.
 * Pattern: Behavior-driven, testing observable side-effects (message row saved / not saved).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelId, createChannel } from '../../../../src/core/domain.js';
import { InMemoryEventBus } from '../../../../src/core/events/event-bus.js';
import { SQLiteChannelRepository } from '../../../../src/implementations/channel-repository.js';
import { Database } from '../../../../src/implementations/database.js';
import { ChannelMessagePersistenceHandler } from '../../../../src/services/handlers/channel-message-persistence-handler.js';
import { createTestConfiguration } from '../../../fixtures/factories.js';
import { TestLogger } from '../../../fixtures/test-doubles.js';
import { flushEventLoop } from '../../../utils/event-helpers.js';

describe('ChannelMessagePersistenceHandler', () => {
  let handler: ChannelMessagePersistenceHandler;
  let eventBus: InMemoryEventBus;
  let db: Database;
  let channelRepo: SQLiteChannelRepository;
  let logger: TestLogger;
  let channelId: ChannelId;

  beforeEach(async () => {
    logger = new TestLogger();
    const config = createTestConfiguration();
    eventBus = new InMemoryEventBus(config, logger);
    db = new Database(':memory:');
    channelRepo = new SQLiteChannelRepository(db);

    // Create a real channel so FK constraints pass
    const channel = createChannel({
      name: 'test-ch',
      members: [{ name: 'architect', agent: 'claude' }],
    });
    await channelRepo.save(channel);
    channelId = channel.id;

    const createResult = await ChannelMessagePersistenceHandler.create({
      channelRepository: channelRepo,
      eventBus,
      logger,
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) throw new Error('Handler creation failed');
    handler = createResult.value;
  });

  afterEach(() => {
    eventBus.dispose();
    db.close();
  });

  describe('ChannelMessageSent — with summary', () => {
    it('persists message when event has a summary', async () => {
      await eventBus.emit('ChannelMessageSent', {
        channelId,
        from: 'architect',
        to: 'reviewer',
        round: 1,
        summary: 'Code looks good!',
      });
      await flushEventLoop();

      const result = await channelRepo.getMessages(channelId);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unexpected');
      expect(result.value).toHaveLength(1);
      const msg = result.value[0]!;
      expect(msg.fromMember).toBe('architect');
      expect(msg.toMember).toBe('reviewer');
      expect(msg.round).toBe(1);
      expect(msg.summary).toBe('Code looks good!');
    });

    it('uses cm-{uuid} ID format', async () => {
      await eventBus.emit('ChannelMessageSent', {
        channelId,
        from: 'architect',
        to: 'all',
        round: 2,
        summary: 'Broadcast message',
      });
      await flushEventLoop();

      const result = await channelRepo.getMessages(channelId);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unexpected');
      const msg = result.value[0]!;
      expect(msg.id).toMatch(/^cm-[0-9a-f-]{36}$/);
    });

    it('maps to=all to toMember=null', async () => {
      await eventBus.emit('ChannelMessageSent', {
        channelId,
        from: 'architect',
        to: 'all',
        round: 1,
        summary: 'Broadcast',
      });
      await flushEventLoop();

      const result = await channelRepo.getMessages(channelId);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unexpected');
      expect(result.value[0]!.toMember).toBeNull();
    });

    it('maps directed to=memberName to toMember string', async () => {
      await eventBus.emit('ChannelMessageSent', {
        channelId,
        from: 'architect',
        to: 'reviewer',
        round: 1,
        summary: 'Directed message',
      });
      await flushEventLoop();

      const result = await channelRepo.getMessages(channelId);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unexpected');
      expect(result.value[0]!.toMember).toBe('reviewer');
    });
  });

  describe('ChannelMessageSent — without summary', () => {
    it('skips persistence when event has no summary', async () => {
      await eventBus.emit('ChannelMessageSent', {
        channelId,
        from: 'architect',
        to: 'reviewer',
        round: 1,
        // No summary field
      });
      await flushEventLoop();

      const result = await channelRepo.getMessages(channelId);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unexpected');
      // No rows should have been inserted
      expect(result.value).toHaveLength(0);
    });
  });

  describe('field mapping correctness', () => {
    it('uses event timestamp as createdAt', async () => {
      const before = Date.now();
      await eventBus.emit('ChannelMessageSent', {
        channelId,
        from: 'architect',
        to: 'all',
        round: 3,
        summary: 'Timing test',
      });
      await flushEventLoop();
      const after = Date.now();

      const result = await channelRepo.getMessages(channelId);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unexpected');
      const msg = result.value[0]!;
      expect(msg.createdAt).toBeGreaterThanOrEqual(before);
      expect(msg.createdAt).toBeLessThanOrEqual(after);
    });

    it('correctly maps channelId field', async () => {
      await eventBus.emit('ChannelMessageSent', {
        channelId,
        from: 'architect',
        to: 'all',
        round: 1,
        summary: 'Channel id test',
      });
      await flushEventLoop();

      const result = await channelRepo.getMessages(channelId);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unexpected');
      expect(result.value[0]!.channelId).toBe(channelId);
    });
  });
});
