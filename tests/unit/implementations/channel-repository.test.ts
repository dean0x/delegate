import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CHANNEL_NAME_REGEX,
  type Channel,
  ChannelId,
  type ChannelMember,
  ChannelMemberStatus,
  type ChannelMessage,
  ChannelStatus,
  createChannel,
  updateChannel,
} from '../../../src/core/domain.js';
import { SQLiteChannelRepository } from '../../../src/implementations/channel-repository.js';
import { Database } from '../../../src/implementations/database.js';

describe('SQLiteChannelRepository', () => {
  let db: Database;
  let repo: SQLiteChannelRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    repo = new SQLiteChannelRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  function buildChannel(overrides: Partial<Parameters<typeof createChannel>[0]> = {}): Channel {
    return createChannel({
      name: `test-${crypto.randomUUID().slice(0, 8)}`,
      members: [
        { name: 'architect', agent: 'claude' },
        { name: 'reviewer', agent: 'codex' },
      ],
      communicationMode: 'broadcast',
      topic: 'Code review',
      ...overrides,
    });
  }

  function buildMember(overrides: Partial<ChannelMember> = {}): ChannelMember {
    return Object.freeze({
      name: 'new-member',
      agent: 'claude' as const,
      tmuxSession: 'beat-channel-test-new-member',
      status: ChannelMemberStatus.ACTIVE,
      joinedAt: Date.now(),
      ...overrides,
    });
  }

  // ============================================================================
  // T1: CRUD — Save and FindById Round-Trip
  // ============================================================================

  describe('save + findById', () => {
    it('saves and retrieves a channel with all fields and members', async () => {
      const channel = buildChannel({
        name: 'auth-review',
        members: [
          { name: 'architect', agent: 'claude', systemPrompt: 'You are an architect' },
          { name: 'reviewer', agent: 'codex' },
        ],
        communicationMode: 'directed',
        topic: 'Auth module review',
        maxRounds: 5,
        createdBy: 'task-123',
      });

      const saveResult = await repo.save(channel);
      expect(saveResult.ok).toBe(true);

      const findResult = await repo.findById(channel.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) throw new Error('unexpected');
      const found = findResult.value!;

      expect(found.id).toBe(channel.id);
      expect(found.name).toBe('auth-review');
      expect(found.communicationMode).toBe('directed');
      expect(found.topic).toBe('Auth module review');
      expect(found.status).toBe(ChannelStatus.ACTIVE);
      expect(found.maxRounds).toBe(5);
      expect(found.currentRound).toBe(0);
      expect(found.createdBy).toBe('task-123');
      expect(found.createdAt).toBe(channel.createdAt);
      expect(found.updatedAt).toBe(channel.updatedAt);

      expect(found.members).toHaveLength(2);
      const [m1, m2] = found.members;
      expect(m1.name).toBe('architect');
      expect(m1.agent).toBe('claude');
      expect(m1.systemPrompt).toBe('You are an architect');
      expect(m1.tmuxSession).toBe('beat-channel-auth-review-architect');
      expect(m1.status).toBe(ChannelMemberStatus.ACTIVE);
      expect(m1.joinedAt).toBe(channel.members[0].joinedAt);

      expect(m2.name).toBe('reviewer');
      expect(m2.agent).toBe('codex');
      expect(m2.systemPrompt).toBeUndefined();
      expect(m2.tmuxSession).toBe('beat-channel-auth-review-reviewer');
    });
  });

  // ============================================================================
  // T2: CRUD — FindByName
  // ============================================================================

  describe('findByName', () => {
    it('finds a channel by name with members', async () => {
      const channel = buildChannel({ name: 'auth-review' });
      await repo.save(channel);

      const result = await repo.findByName('auth-review');
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unexpected');
      expect(result.value!.id).toBe(channel.id);
      expect(result.value!.members).toHaveLength(2);
    });

    it('returns null for nonexistent name', async () => {
      const result = await repo.findByName('nonexistent');
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unexpected');
      expect(result.value).toBeNull();
    });
  });

  // ============================================================================
  // T3: CRUD — FindAll Pagination
  // ============================================================================

  describe('findAll', () => {
    it('paginates results ordered by created_at DESC', async () => {
      const channels: Channel[] = [];
      for (let i = 0; i < 5; i++) {
        const ch = buildChannel({ name: `chan-${i}` });
        channels.push(ch);
        await repo.save(ch);
      }

      const page1 = await repo.findAll(2, 0);
      expect(page1.ok).toBe(true);
      if (!page1.ok) throw new Error('unexpected');
      expect(page1.value).toHaveLength(2);

      const page2 = await repo.findAll(2, 2);
      expect(page2.ok).toBe(true);
      if (!page2.ok) throw new Error('unexpected');
      expect(page2.value).toHaveLength(2);

      const allIds = [...page1.value.map((c) => c.id), ...page2.value.map((c) => c.id)];
      expect(new Set(allIds).size).toBe(4);
    });

    it('uses DEFAULT_LIMIT when no limit specified', async () => {
      const channel = buildChannel();
      await repo.save(channel);

      const result = await repo.findAll();
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unexpected');
      expect(result.value).toHaveLength(1);
    });
  });

  // ============================================================================
  // T4: CRUD — FindByStatus
  // ============================================================================

  describe('findByStatus', () => {
    it('filters channels by status', async () => {
      const ch1 = buildChannel({ name: 'active-1' });
      const ch2 = buildChannel({ name: 'active-2' });
      const ch3 = buildChannel({ name: 'active-3' });
      await repo.save(ch1);
      await repo.save(ch2);
      await repo.save(ch3);

      await repo.updateStatus(ch1.id, ChannelStatus.PAUSED);
      await repo.updateStatus(ch2.id, ChannelStatus.PAUSED);

      const activeResult = await repo.findByStatus(ChannelStatus.ACTIVE);
      expect(activeResult.ok).toBe(true);
      if (!activeResult.ok) throw new Error('unexpected');
      expect(activeResult.value).toHaveLength(1);

      const pausedResult = await repo.findByStatus(ChannelStatus.PAUSED);
      expect(pausedResult.ok).toBe(true);
      if (!pausedResult.ok) throw new Error('unexpected');
      expect(pausedResult.value).toHaveLength(2);

      const destroyedResult = await repo.findByStatus(ChannelStatus.DESTROYED);
      expect(destroyedResult.ok).toBe(true);
      if (!destroyedResult.ok) throw new Error('unexpected');
      expect(destroyedResult.value).toHaveLength(0);
    });
  });

  // ============================================================================
  // T5: CRUD — Delete with Cascade
  // ============================================================================

  describe('delete', () => {
    it('cascade-removes all members when channel is deleted', async () => {
      const channel = buildChannel({
        name: 'to-delete',
        members: [
          { name: 'agent-a', agent: 'claude' },
          { name: 'agent-b', agent: 'codex' },
          { name: 'agent-c', agent: 'claude' },
        ],
      });
      await repo.save(channel);

      const deleteResult = await repo.delete(channel.id);
      expect(deleteResult.ok).toBe(true);

      const findResult = await repo.findById(channel.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) throw new Error('unexpected');
      expect(findResult.value).toBeNull();

      const memberRows = db.getDatabase().prepare('SELECT * FROM channel_members WHERE channel_id = ?').all(channel.id);
      expect(memberRows).toHaveLength(0);
    });
  });

  // ============================================================================
  // T6: Updates — UpdateStatus
  // ============================================================================

  describe('updateStatus', () => {
    it('updates status and updatedAt', async () => {
      const channel = buildChannel();
      await repo.save(channel);

      const result = await repo.updateStatus(channel.id, ChannelStatus.PAUSED);
      expect(result.ok).toBe(true);

      const found = await repo.findById(channel.id);
      expect(found.ok).toBe(true);
      if (!found.ok) throw new Error('unexpected');
      expect(found.value!.status).toBe(ChannelStatus.PAUSED);
      expect(found.value!.updatedAt).toBeGreaterThanOrEqual(channel.updatedAt);
    });
  });

  // ============================================================================
  // T7: Updates — UpdateRound
  // ============================================================================

  describe('updateRound', () => {
    it('updates currentRound and updatedAt', async () => {
      const channel = buildChannel();
      await repo.save(channel);

      const result = await repo.updateRound(channel.id, 5);
      expect(result.ok).toBe(true);

      const found = await repo.findById(channel.id);
      expect(found.ok).toBe(true);
      if (!found.ok) throw new Error('unexpected');
      expect(found.value!.currentRound).toBe(5);
      expect(found.value!.updatedAt).toBeGreaterThanOrEqual(channel.updatedAt);
    });

    it('rejects negative round value', async () => {
      const result = await repo.updateRound(ChannelId('ch-any'), -1);
      expect(result.ok).toBe(false);
    });

    it('rejects fractional round value', async () => {
      const result = await repo.updateRound(ChannelId('ch-any'), 2.5);
      expect(result.ok).toBe(false);
    });
  });

  // ============================================================================
  // T8: Members — AddMember
  // ============================================================================

  describe('addMember', () => {
    it('adds a member to an existing channel', async () => {
      const channel = buildChannel({
        name: 'add-member-test',
        members: [{ name: 'original', agent: 'claude' }],
      });
      await repo.save(channel);

      const newMember = buildMember({
        name: 'new-agent',
        agent: 'codex',
        systemPrompt: 'Help with testing',
        tmuxSession: 'beat-channel-add-member-test-new-agent',
      });

      const addResult = await repo.addMember(channel.id, newMember);
      expect(addResult.ok).toBe(true);

      const found = await repo.findById(channel.id);
      expect(found.ok).toBe(true);
      if (!found.ok) throw new Error('unexpected');
      expect(found.value!.members).toHaveLength(2);

      const added = found.value!.members.find((m) => m.name === 'new-agent');
      expect(added).toBeDefined();
      expect(added!.agent).toBe('codex');
      expect(added!.systemPrompt).toBe('Help with testing');
      expect(added!.tmuxSession).toBe('beat-channel-add-member-test-new-agent');
      expect(added!.status).toBe(ChannelMemberStatus.ACTIVE);
    });
  });

  // ============================================================================
  // T9: Members — UpdateMemberStatus
  // ============================================================================

  describe('updateMemberStatus', () => {
    it('updates a specific member status by name', async () => {
      const channel = buildChannel({ name: 'member-status-test' });
      await repo.save(channel);

      const result = await repo.updateMemberStatus(channel.id, 'architect', ChannelMemberStatus.IDLE);
      expect(result.ok).toBe(true);

      const found = await repo.findById(channel.id);
      expect(found.ok).toBe(true);
      if (!found.ok) throw new Error('unexpected');
      const architect = found.value!.members.find((m) => m.name === 'architect');
      expect(architect!.status).toBe(ChannelMemberStatus.IDLE);
    });
  });

  describe('batchUpdateMemberStatuses', () => {
    it('updates multiple members to the same status in one call', async () => {
      const channel = buildChannel({
        name: 'batch-status-test',
        members: [
          { name: 'alpha', agent: 'claude' },
          { name: 'beta', agent: 'claude' },
          { name: 'gamma', agent: 'claude' },
        ],
      });
      await repo.save(channel);

      const result = await repo.batchUpdateMemberStatuses(channel.id, ['alpha', 'beta'], ChannelMemberStatus.DESTROYED);
      expect(result.ok).toBe(true);

      const found = await repo.findById(channel.id);
      expect(found.ok).toBe(true);
      if (!found.ok) throw new Error('unexpected');
      const alpha = found.value!.members.find((m) => m.name === 'alpha');
      const beta = found.value!.members.find((m) => m.name === 'beta');
      const gamma = found.value!.members.find((m) => m.name === 'gamma');
      expect(alpha!.status).toBe(ChannelMemberStatus.DESTROYED);
      expect(beta!.status).toBe(ChannelMemberStatus.DESTROYED);
      // gamma was not in the batch — status unchanged
      expect(gamma!.status).toBe(ChannelMemberStatus.ACTIVE);
    });

    it('is a no-op when memberNames is empty', async () => {
      const channel = buildChannel({ name: 'batch-noop-test' });
      await repo.save(channel);

      const result = await repo.batchUpdateMemberStatuses(channel.id, [], ChannelMemberStatus.DESTROYED);
      expect(result.ok).toBe(true);

      // Members unchanged
      const found = await repo.findById(channel.id);
      expect(found.ok).toBe(true);
      if (!found.ok) throw new Error('unexpected');
      for (const member of found.value!.members) {
        expect(member.status).toBe(ChannelMemberStatus.ACTIVE);
      }
    });
  });

  // ============================================================================
  // T10: Members — Eager Loading
  // ============================================================================

  describe('eager member loading', () => {
    it('loads all members with full fields on findById', async () => {
      const channel = buildChannel({
        name: 'eager-test',
        members: [
          { name: 'agent-a', agent: 'claude', systemPrompt: 'prompt-a' },
          { name: 'agent-b', agent: 'codex' },
          { name: 'agent-c', agent: 'claude', systemPrompt: 'prompt-c' },
        ],
      });
      await repo.save(channel);

      const found = await repo.findById(channel.id);
      expect(found.ok).toBe(true);
      if (!found.ok) throw new Error('unexpected');
      expect(found.value!.members).toHaveLength(3);

      const names = found.value!.members.map((m) => m.name);
      expect(names).toContain('agent-a');
      expect(names).toContain('agent-b');
      expect(names).toContain('agent-c');

      for (const member of found.value!.members) {
        expect(member.tmuxSession).toMatch(/^beat-channel-eager-test-/);
        expect(member.status).toBe(ChannelMemberStatus.ACTIVE);
        expect(member.joinedAt).toBeGreaterThan(0);
      }
    });
  });

  // ============================================================================
  // T11: Aggregates — Count and CountByStatus
  // ============================================================================

  describe('count and countByStatus', () => {
    it('returns correct counts', async () => {
      const ch1 = buildChannel({ name: 'cnt-1' });
      const ch2 = buildChannel({ name: 'cnt-2' });
      const ch3 = buildChannel({ name: 'cnt-3' });
      const ch4 = buildChannel({ name: 'cnt-4' });
      await repo.save(ch1);
      await repo.save(ch2);
      await repo.save(ch3);
      await repo.save(ch4);

      await repo.updateStatus(ch3.id, ChannelStatus.PAUSED);
      await repo.updateStatus(ch4.id, ChannelStatus.DESTROYED);

      const countResult = await repo.count();
      expect(countResult.ok).toBe(true);
      if (!countResult.ok) throw new Error('unexpected');
      expect(countResult.value).toBe(4);

      const byStatusResult = await repo.countByStatus();
      expect(byStatusResult.ok).toBe(true);
      if (!byStatusResult.ok) throw new Error('unexpected');
      expect(byStatusResult.value.active).toBe(2);
      expect(byStatusResult.value.paused).toBe(1);
      expect(byStatusResult.value.destroyed).toBe(1);
    });
  });

  // ============================================================================
  // T12: Constraint — Duplicate Channel Name
  // ============================================================================

  describe('unique constraints', () => {
    it('rejects duplicate channel name', async () => {
      const ch1 = buildChannel({ name: 'unique-name' });
      const ch2 = buildChannel({ name: 'unique-name' });

      await repo.save(ch1);
      const result = await repo.save(ch2);
      expect(result.ok).toBe(false);
    });

    // T13: Constraint — Duplicate Member Name in Channel
    it('rejects duplicate member name within same channel', async () => {
      const channel = buildChannel({
        name: 'dup-member',
        members: [{ name: 'architect', agent: 'claude' }],
      });
      await repo.save(channel);

      const dupMember = buildMember({
        name: 'architect',
        tmuxSession: 'beat-channel-dup-member-architect',
      });
      const result = await repo.addMember(channel.id, dupMember);
      expect(result.ok).toBe(false);
    });
  });

  // ============================================================================
  // T14: Constraint — Invalid Agent via Direct SQL
  // ============================================================================

  describe('CHECK constraints', () => {
    it('rejects invalid agent via direct SQL', () => {
      const channel = buildChannel({ name: 'check-test', members: [] });
      // Save channel first (no members)
      db.getDatabase()
        .prepare(
          `INSERT INTO channels (id, name, status, current_round, created_at, updated_at)
         VALUES (?, ?, 'active', 0, ?, ?)`,
        )
        .run(channel.id, channel.name, channel.createdAt, channel.updatedAt);

      expect(() =>
        db
          .getDatabase()
          .prepare(
            `INSERT INTO channel_members (channel_id, name, agent, tmux_session, status, joined_at)
           VALUES (?, 'bad', 'gemini', 'beat-channel-test-bad', 'active', ?)`,
          )
          .run(channel.id, Date.now()),
      ).toThrow();
    });
  });

  // ============================================================================
  // T15: Not Found — FindById
  // ============================================================================

  describe('not found', () => {
    it('returns null for nonexistent ID', async () => {
      const result = await repo.findById(ChannelId('ch-nonexistent'));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unexpected');
      expect(result.value).toBeNull();
    });
  });

  // ============================================================================
  // T15b: No-Op Updates — Non-Existent Channel/Member
  // ============================================================================

  describe('no-op updates (nonexistent targets)', () => {
    it('updateStatus returns ok for nonexistent channel (silent no-op)', async () => {
      const result = await repo.updateStatus(ChannelId('ch-nonexistent'), ChannelStatus.PAUSED);
      expect(result.ok).toBe(true);
    });

    it('updateRound returns ok for nonexistent channel (silent no-op)', async () => {
      const result = await repo.updateRound(ChannelId('ch-nonexistent'), 3);
      expect(result.ok).toBe(true);
    });

    it('updateMemberStatus returns ok for nonexistent channel (silent no-op)', async () => {
      const result = await repo.updateMemberStatus(ChannelId('ch-nonexistent'), 'architect', ChannelMemberStatus.IDLE);
      expect(result.ok).toBe(true);
    });

    it('updateMemberStatus returns ok for nonexistent member in existing channel (silent no-op)', async () => {
      const channel = buildChannel({ name: 'noop-member-test' });
      await repo.save(channel);

      const result = await repo.updateMemberStatus(channel.id, 'no-such-member', ChannelMemberStatus.IDLE);
      expect(result.ok).toBe(true);

      // Existing members are unaffected
      const found = await repo.findById(channel.id);
      expect(found.ok).toBe(true);
      if (!found.ok) throw new Error('unexpected');
      for (const member of found.value!.members) {
        expect(member.status).toBe(ChannelMemberStatus.ACTIVE);
      }
    });
  });

  // ============================================================================
  // T16: Zero Members — Save and Retrieve
  // ============================================================================

  describe('zero members', () => {
    it('saves and retrieves a channel with no members', async () => {
      const channel = buildChannel({ name: 'empty-channel', members: [] });
      await repo.save(channel);

      const found = await repo.findById(channel.id);
      expect(found.ok).toBe(true);
      if (!found.ok) throw new Error('unexpected');
      expect(found.value!.members).toHaveLength(0);
      expect(found.value!.name).toBe('empty-channel');
    });
  });

  // ============================================================================
  // T17: Migration — Applies Cleanly
  // ============================================================================

  describe('migration', () => {
    it('creates channels and channel_members tables with correct schema', () => {
      const channelCols = db.getDatabase().prepare("PRAGMA table_info('channels')").all() as Array<{
        name: string;
        type: string;
        notnull: number;
      }>;

      const colNames = channelCols.map((c) => c.name);
      expect(colNames).toContain('id');
      expect(colNames).toContain('name');
      expect(colNames).toContain('communication_mode');
      expect(colNames).toContain('topic');
      expect(colNames).toContain('status');
      expect(colNames).toContain('max_rounds');
      expect(colNames).toContain('current_round');
      expect(colNames).toContain('created_by');
      expect(colNames).toContain('created_at');
      expect(colNames).toContain('updated_at');

      const memberCols = db.getDatabase().prepare("PRAGMA table_info('channel_members')").all() as Array<{
        name: string;
        type: string;
        notnull: number;
      }>;

      const memberColNames = memberCols.map((c) => c.name);
      expect(memberColNames).toContain('id');
      expect(memberColNames).toContain('channel_id');
      expect(memberColNames).toContain('name');
      expect(memberColNames).toContain('agent');
      expect(memberColNames).toContain('system_prompt');
      expect(memberColNames).toContain('tmux_session');
      expect(memberColNames).toContain('status');
      expect(memberColNames).toContain('joined_at');
    });

    it('creates idx_channel_messages_channel_created index for ORDER BY created_at DESC', () => {
      const indexes = db.getDatabase().prepare("PRAGMA index_list('channel_messages')").all() as Array<{
        name: string;
        unique: number;
        origin: string;
      }>;
      const indexNames = indexes.map((i) => i.name);
      expect(indexNames).toContain('idx_channel_messages_channel_created');

      // Verify the index covers (channel_id, created_at) columns
      const indexInfo = db
        .getDatabase()
        .prepare("PRAGMA index_info('idx_channel_messages_channel_created')")
        .all() as Array<{
        seqno: number;
        cid: number;
        name: string;
      }>;
      const indexCols = indexInfo.map((c) => c.name);
      expect(indexCols).toContain('channel_id');
      expect(indexCols).toContain('created_at');
    });
  });

  // ============================================================================
  // T18: Save Atomicity — Transaction Behavior
  // ============================================================================

  describe('transaction atomicity', () => {
    it('rolls back both channel and members on member insert failure', async () => {
      const channel = buildChannel({
        name: 'atomic-test',
        members: [{ name: 'valid', agent: 'claude' }],
      });

      // First save succeeds
      await repo.save(channel);

      // Second save with same ID should fail (PK violation on channel), rolling back members too
      const result = await repo.save(channel);
      expect(result.ok).toBe(false);

      // Original channel is intact
      const found = await repo.findById(channel.id);
      expect(found.ok).toBe(true);
      if (!found.ok) throw new Error('unexpected');
      expect(found.value!.members).toHaveLength(1);
    });
  });

  // ============================================================================
  // T19: Domain Factory — tmuxSession Derivation
  // ============================================================================

  describe('tmuxSession derivation', () => {
    it('derives session name as beat-channel-{channelName}-{memberName}', () => {
      const channel = createChannel({
        name: 'auth-review',
        members: [{ name: 'architect', agent: 'claude' }],
      });

      expect(channel.members[0].tmuxSession).toBe('beat-channel-auth-review-architect');
      // Verify it passes SESSION_NAME_REGEX
      expect(/^beat-[a-z0-9-]+$/.test(channel.members[0].tmuxSession)).toBe(true);
    });
  });

  // ============================================================================
  // T20: Domain Factory — ID Format and Frozen
  // ============================================================================

  describe('createChannel factory properties', () => {
    it('generates ch- prefixed UUID, active status, frozen', () => {
      const channel = createChannel({ name: 'test', members: [] });

      expect(channel.id).toMatch(/^ch-[0-9a-f-]{36}$/);
      expect(channel.status).toBe(ChannelStatus.ACTIVE);
      expect(channel.currentRound).toBe(0);
      expect(Object.isFrozen(channel)).toBe(true);
    });
  });

  // ============================================================================
  // updateChannel
  // ============================================================================

  describe('updateChannel', () => {
    it('returns frozen updated channel with new updatedAt', () => {
      const channel = createChannel({ name: 'update-test', members: [] });
      const updated = updateChannel(channel, { status: ChannelStatus.PAUSED, currentRound: 3 });

      expect(updated.status).toBe(ChannelStatus.PAUSED);
      expect(updated.currentRound).toBe(3);
      expect(updated.id).toBe(channel.id);
      expect(updated.name).toBe(channel.name);
      expect(updated.updatedAt).toBeGreaterThanOrEqual(channel.updatedAt);
      expect(Object.isFrozen(updated)).toBe(true);
    });
  });

  // ============================================================================
  // CHANNEL_NAME_REGEX
  // ============================================================================

  describe('CHANNEL_NAME_REGEX', () => {
    it('matches valid patterns', () => {
      expect(CHANNEL_NAME_REGEX.test('a')).toBe(true);
      expect(CHANNEL_NAME_REGEX.test('abc')).toBe(true);
      expect(CHANNEL_NAME_REGEX.test('a-b')).toBe(true);
      expect(CHANNEL_NAME_REGEX.test('my-channel-123')).toBe(true);
      expect(CHANNEL_NAME_REGEX.test('0')).toBe(true);
    });

    it('rejects invalid patterns', () => {
      expect(CHANNEL_NAME_REGEX.test('')).toBe(false);
      expect(CHANNEL_NAME_REGEX.test('-start')).toBe(false);
      expect(CHANNEL_NAME_REGEX.test('end-')).toBe(false);
      expect(CHANNEL_NAME_REGEX.test('has_underscore')).toBe(false);
      expect(CHANNEL_NAME_REGEX.test('HAS-UPPER')).toBe(false);
      expect(CHANNEL_NAME_REGEX.test('has space')).toBe(false);
    });

    it('accepts name at the 64-char maximum boundary', () => {
      const name = 'a' + 'b'.repeat(63); // 64 chars
      expect(name).toHaveLength(64);
      expect(CHANNEL_NAME_REGEX.test(name)).toBe(true);
    });

    it('rejects name exceeding the 64-char maximum', () => {
      const name = 'a' + 'b'.repeat(64); // 65 chars
      expect(name).toHaveLength(65);
      expect(CHANNEL_NAME_REGEX.test(name)).toBe(false);
    });
  });

  // ============================================================================
  // P2: Batch Member Loading (findAll / findByStatus)
  // ============================================================================

  describe('performance', () => {
    it('findAll loads members for all channels in two queries (batch hydration)', async () => {
      // Save 3 channels with distinct members to verify cross-channel grouping
      const ch1 = buildChannel({
        name: 'batch-1',
        members: [
          { name: 'a1', agent: 'claude' },
          { name: 'a2', agent: 'codex' },
        ],
      });
      const ch2 = buildChannel({ name: 'batch-2', members: [{ name: 'b1', agent: 'claude' }] });
      const ch3 = buildChannel({ name: 'batch-3', members: [] });
      await repo.save(ch1);
      await repo.save(ch2);
      await repo.save(ch3);

      const result = await repo.findAll();
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unexpected');

      const byName = new Map(result.value.map((c) => [c.name, c]));
      // Members are correctly attributed to their own channel
      expect(byName.get('batch-1')!.members).toHaveLength(2);
      expect(byName.get('batch-2')!.members).toHaveLength(1);
      expect(byName.get('batch-3')!.members).toHaveLength(0);
      // No member cross-contamination
      const ch1Members = byName.get('batch-1')!.members.map((m) => m.name);
      expect(ch1Members).toContain('a1');
      expect(ch1Members).toContain('a2');
      expect(ch1Members).not.toContain('b1');
    });

    it('findByStatus loads members for matching channels via batch hydration', async () => {
      const active = buildChannel({ name: 'batch-active', members: [{ name: 'x1', agent: 'claude' }] });
      const paused = buildChannel({
        name: 'batch-paused',
        members: [
          { name: 'y1', agent: 'codex' },
          { name: 'y2', agent: 'claude' },
        ],
      });
      await repo.save(active);
      await repo.save(paused);
      await repo.updateStatus(paused.id, ChannelStatus.PAUSED);

      const result = await repo.findByStatus(ChannelStatus.PAUSED);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unexpected');
      expect(result.value).toHaveLength(1);
      expect(result.value[0].members).toHaveLength(2);
      const names = result.value[0].members.map((m) => m.name);
      expect(names).toContain('y1');
      expect(names).toContain('y2');
    });

    it('handles 50 channels with 3 members each via findAll', async () => {
      for (let i = 0; i < 50; i++) {
        const ch = buildChannel({
          name: `perf-${i}`,
          members: [
            { name: `m0-${i}`, agent: 'claude' },
            { name: `m1-${i}`, agent: 'codex' },
            { name: `m2-${i}`, agent: 'claude' },
          ],
        });
        await repo.save(ch);
      }

      const start = Date.now();
      const result = await repo.findAll(50);
      const elapsed = Date.now() - start;

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unexpected');
      expect(result.value).toHaveLength(50);
      expect(result.value[0].members).toHaveLength(3);
      expect(elapsed).toBeLessThan(500);
    });

    // P3: Pagination Prevents Full Scan
    it('pagination returns only requested number of results', async () => {
      for (let i = 0; i < 20; i++) {
        await repo.save(buildChannel({ name: `page-${i}`, members: [] }));
      }

      const result = await repo.findAll(10);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unexpected');
      expect(result.value).toHaveLength(10);
    });
  });

  // ============================================================================
  // T12: Channel Messages — saveMessage + getMessages
  // ============================================================================

  describe('saveMessage + getMessages', () => {
    function buildMessage(channelId: ChannelId, overrides: Partial<ChannelMessage> = {}): ChannelMessage {
      return Object.freeze({
        id: `cm-${crypto.randomUUID()}`,
        channelId,
        fromMember: 'architect',
        toMember: null,
        round: 1,
        summary: 'Hello from architect',
        createdAt: Date.now(),
        ...overrides,
      });
    }

    it('saves a message and retrieves it via getMessages', async () => {
      const channel = buildChannel({ name: 'msg-save-test' });
      await repo.save(channel);

      const msg = buildMessage(channel.id, {
        fromMember: 'architect',
        toMember: 'reviewer',
        round: 1,
        summary: 'Code looks good!',
      });

      const saveResult = await repo.saveMessage(msg);
      expect(saveResult.ok).toBe(true);

      const getResult = await repo.getMessages(channel.id);
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) throw new Error('unexpected');
      expect(getResult.value).toHaveLength(1);

      const found = getResult.value[0]!;
      expect(found.id).toBe(msg.id);
      expect(found.channelId).toBe(channel.id);
      expect(found.fromMember).toBe('architect');
      expect(found.toMember).toBe('reviewer');
      expect(found.round).toBe(1);
      expect(found.summary).toBe('Code looks good!');
      expect(found.createdAt).toBe(msg.createdAt);
    });

    it('returns messages newest-first (ORDER BY created_at DESC)', async () => {
      const channel = buildChannel({ name: 'msg-order-test' });
      await repo.save(channel);

      const now = Date.now();
      const oldest = buildMessage(channel.id, { summary: 'oldest', createdAt: now - 2000 });
      const middle = buildMessage(channel.id, { summary: 'middle', createdAt: now - 1000 });
      const newest = buildMessage(channel.id, { summary: 'newest', createdAt: now });

      await repo.saveMessage(oldest);
      await repo.saveMessage(middle);
      await repo.saveMessage(newest);

      const result = await repo.getMessages(channel.id);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unexpected');
      expect(result.value).toHaveLength(3);
      // newest-first
      expect(result.value[0]!.summary).toBe('newest');
      expect(result.value[1]!.summary).toBe('middle');
      expect(result.value[2]!.summary).toBe('oldest');
    });

    it('respects the limit parameter', async () => {
      const channel = buildChannel({ name: 'msg-limit-test' });
      await repo.save(channel);

      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        await repo.saveMessage(buildMessage(channel.id, { summary: `msg-${i}`, createdAt: now + i }));
      }

      const result = await repo.getMessages(channel.id, 3);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unexpected');
      expect(result.value).toHaveLength(3);
    });

    it('returns empty array when channel has no messages', async () => {
      const channel = buildChannel({ name: 'msg-empty-test' });
      await repo.save(channel);

      const result = await repo.getMessages(channel.id);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unexpected');
      expect(result.value).toHaveLength(0);
    });

    it('CASCADE deletes messages when channel is deleted', async () => {
      const channel = buildChannel({ name: 'msg-cascade-test' });
      await repo.save(channel);
      await repo.saveMessage(buildMessage(channel.id));
      await repo.saveMessage(buildMessage(channel.id));

      // Verify messages exist before delete
      const beforeDelete = await repo.getMessages(channel.id);
      expect(beforeDelete.ok).toBe(true);
      if (!beforeDelete.ok) throw new Error('unexpected');
      expect(beforeDelete.value).toHaveLength(2);

      // Delete channel — ON DELETE CASCADE should remove messages
      await repo.delete(channel.id);

      const afterDelete = await repo.getMessages(channel.id);
      expect(afterDelete.ok).toBe(true);
      if (!afterDelete.ok) throw new Error('unexpected');
      expect(afterDelete.value).toHaveLength(0);
    });

    it('prunes to MAX_MESSAGES_PER_CHANNEL=500 keeping newest messages', async () => {
      const channel = buildChannel({ name: 'msg-prune-test' });
      await repo.save(channel);

      const now = Date.now();
      // Insert 501 messages — the oldest one should be pruned
      for (let i = 0; i < 501; i++) {
        await repo.saveMessage(
          buildMessage(channel.id, {
            id: `cm-prune-${i}`,
            summary: `msg-${i}`,
            // Spread timestamps so ordering is deterministic: i=0 is oldest, i=500 is newest
            createdAt: now + i,
          }),
        );
      }

      // After pruning, only 500 remain
      const result = await repo.getMessages(channel.id, 600);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unexpected');
      expect(result.value).toHaveLength(500);

      // The oldest message (i=0) must have been pruned
      const ids = result.value.map((m) => m.id);
      expect(ids).not.toContain('cm-prune-0');
      // The newest message (i=500) must still be present
      expect(ids).toContain('cm-prune-500');
    });

    it('maps toMember=null for broadcast messages and preserves string for directed', async () => {
      const channel = buildChannel({ name: 'msg-tomember-test' });
      await repo.save(channel);

      const broadcast = buildMessage(channel.id, { toMember: null, summary: 'broadcast' });
      const directed = buildMessage(channel.id, { toMember: 'reviewer', summary: 'directed' });

      await repo.saveMessage(broadcast);
      await repo.saveMessage(directed);

      const result = await repo.getMessages(channel.id);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unexpected');
      // Newest-first: directed was saved last (slightly later timestamp via test execution order)
      const byId = new Map(result.value.map((m) => [m.id, m]));
      expect(byId.get(broadcast.id)!.toMember).toBeNull();
      expect(byId.get(directed.id)!.toMember).toBe('reviewer');
    });

    it('getMessages clamps limit to MAX_MESSAGES_PER_CHANNEL (500)', async () => {
      const channel = buildChannel({ name: 'msg-limit-clamp-test' });
      await repo.save(channel);

      // Insert 10 messages — well below 500, so all are returned even with an absurd limit
      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        await repo.saveMessage(buildMessage(channel.id, { summary: `msg-${i}`, createdAt: now + i }));
      }

      // Passing Infinity or a huge number is clamped to MAX_MESSAGES_PER_CHANNEL
      const result = await repo.getMessages(channel.id, Infinity);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unexpected');
      // All 10 messages are returned (well within the 500 cap)
      expect(result.value).toHaveLength(10);
    });

    it('save succeeds even when fewer than MAX messages exist (prune guard skips)', async () => {
      const channel = buildChannel({ name: 'msg-prune-guard-test' });
      await repo.save(channel);

      // Insert a small number — count never exceeds 500, so prune is never attempted
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        const result = await repo.saveMessage(buildMessage(channel.id, { summary: `msg-${i}`, createdAt: now + i }));
        // save must succeed even though prune path is not triggered
        expect(result.ok).toBe(true);
      }

      const getResult = await repo.getMessages(channel.id);
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) throw new Error('unexpected');
      expect(getResult.value).toHaveLength(5);
    });
  });
});
