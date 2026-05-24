/**
 * SQLite-based channel repository implementation
 * ARCHITECTURE: Pure Result pattern for all operations, pure data access layer
 * Pattern: Repository pattern with prepared statements for performance
 * Rationale: Efficient channel persistence for multi-agent channels (Phase 6, epic #175)
 */

import SQLite from 'better-sqlite3';
import { z } from 'zod';
import { AGENT_PROVIDERS_TUPLE, type AgentProvider } from '../core/agents.js';
import {
  type Channel,
  ChannelId,
  type ChannelMember,
  ChannelMemberStatus,
  ChannelStatus,
  type CommunicationMode,
} from '../core/domain.js';
import { operationErrorHandler } from '../core/errors.js';
import type { ChannelRepository } from '../core/interfaces.js';
import { Result, tryCatchAsync } from '../core/result.js';
import { Database } from './database.js';

// ============================================================================
// Zod schemas for boundary validation
// Pattern: Parse, don't validate — ensures type safety at system boundary
// Hoisted to module level to avoid recreation on every row conversion
// ============================================================================

const ChannelRowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  communication_mode: z.enum(['broadcast', 'directed', 'round-robin']).nullable(),
  topic: z.string().nullable(),
  status: z.enum(['active', 'paused', 'completed', 'destroyed']),
  max_rounds: z.number().nullable(),
  current_round: z.number(),
  created_by: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});

const ChannelMemberRowSchema = z.object({
  id: z.number(),
  channel_id: z.string().min(1),
  name: z.string().min(1),
  agent: z.enum(AGENT_PROVIDERS_TUPLE),
  system_prompt: z.string().nullable(),
  tmux_session: z.string().min(1),
  status: z.enum(['active', 'idle', 'destroyed']),
  joined_at: z.number(),
});

// ============================================================================
// Row types for type-safe database interaction
// ============================================================================

interface ChannelRow {
  readonly id: string;
  readonly name: string;
  readonly communication_mode: string | null;
  readonly topic: string | null;
  readonly status: string;
  readonly max_rounds: number | null;
  readonly current_round: number;
  readonly created_by: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

interface ChannelMemberRow {
  readonly id: number;
  readonly channel_id: string;
  readonly name: string;
  readonly agent: string;
  readonly system_prompt: string | null;
  readonly tmux_session: string;
  readonly status: string;
  readonly joined_at: number;
}

export class SQLiteChannelRepository implements ChannelRepository {
  private static readonly DEFAULT_LIMIT = 100;

  private readonly db: SQLite.Database;
  private readonly saveChannelStmt: SQLite.Statement;
  private readonly saveMemberStmt: SQLite.Statement;
  private readonly findByIdStmt: SQLite.Statement;
  private readonly findByNameStmt: SQLite.Statement;
  private readonly findAllStmt: SQLite.Statement;
  private readonly findByStatusStmt: SQLite.Statement;
  private readonly findMembersByChannelIdStmt: SQLite.Statement;
  private readonly updateStatusStmt: SQLite.Statement;
  private readonly updateRoundStmt: SQLite.Statement;
  private readonly updateMemberStatusStmt: SQLite.Statement;
  private readonly deleteStmt: SQLite.Statement;
  private readonly countStmt: SQLite.Statement;
  private readonly countByStatusStmt: SQLite.Statement;

  constructor(database: Database) {
    this.db = database.getDatabase();

    this.saveChannelStmt = this.db.prepare(`
      INSERT INTO channels (id, name, communication_mode, topic, status, max_rounds, current_round, created_by, created_at, updated_at)
      VALUES (@id, @name, @communication_mode, @topic, @status, @max_rounds, @current_round, @created_by, @created_at, @updated_at)
    `);

    this.saveMemberStmt = this.db.prepare(`
      INSERT INTO channel_members (channel_id, name, agent, system_prompt, tmux_session, status, joined_at)
      VALUES (@channel_id, @name, @agent, @system_prompt, @tmux_session, @status, @joined_at)
    `);

    this.findByIdStmt = this.db.prepare(`SELECT * FROM channels WHERE id = ?`);

    this.findByNameStmt = this.db.prepare(`SELECT * FROM channels WHERE name = ?`);

    this.findAllStmt = this.db.prepare(`SELECT * FROM channels ORDER BY created_at DESC LIMIT ? OFFSET ?`);

    this.findByStatusStmt = this.db.prepare(
      `SELECT * FROM channels WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    );

    this.findMembersByChannelIdStmt = this.db.prepare(
      `SELECT * FROM channel_members WHERE channel_id = ? ORDER BY joined_at ASC`,
    );

    this.updateStatusStmt = this.db.prepare(`UPDATE channels SET status = ?, updated_at = ? WHERE id = ?`);

    this.updateRoundStmt = this.db.prepare(`UPDATE channels SET current_round = ?, updated_at = ? WHERE id = ?`);

    this.updateMemberStatusStmt = this.db.prepare(
      `UPDATE channel_members SET status = ? WHERE channel_id = ? AND name = ?`,
    );

    this.deleteStmt = this.db.prepare(`DELETE FROM channels WHERE id = ?`);

    this.countStmt = this.db.prepare(`SELECT COUNT(*) as count FROM channels`);

    this.countByStatusStmt = this.db.prepare(`SELECT status, COUNT(*) as count FROM channels GROUP BY status`);
  }

  // ============================================================================
  // Channel CRUD (async, wrapped in tryCatchAsync)
  // ============================================================================

  /**
   * Persists a channel and all its members in a single transaction.
   *
   * Member count is bounded by the service layer before save() is called.
   * Channels with large member sets (e.g. thousands) would execute a proportional
   * number of INSERT statements. The service layer must enforce MAX_CHANNEL_MEMBERS
   * before invoking save() to keep transaction size predictable.
   */
  async save(channel: Channel): Promise<Result<void>> {
    return tryCatchAsync(
      async () => {
        const saveAll = this.db.transaction(() => {
          this.saveChannelStmt.run(this.channelToDbFormat(channel));
          for (const member of channel.members) {
            this.saveMemberStmt.run(this.memberToDbFormat(channel.id, member));
          }
        });
        saveAll();
      },
      operationErrorHandler('save channel', { channelId: channel.id }),
    );
  }

  async findById(id: ChannelId): Promise<Result<Channel | null>> {
    return tryCatchAsync(
      async () => {
        const row = this.findByIdStmt.get(id) as ChannelRow | undefined;
        if (!row) return null;
        return this.rowToChannel(row);
      },
      operationErrorHandler('find channel by id', { channelId: id }),
    );
  }

  async findByName(name: string): Promise<Result<Channel | null>> {
    return tryCatchAsync(
      async () => {
        const row = this.findByNameStmt.get(name) as ChannelRow | undefined;
        if (!row) return null;
        return this.rowToChannel(row);
      },
      operationErrorHandler('find channel by name', { name }),
    );
  }

  async findAll(limit?: number, offset?: number): Promise<Result<readonly Channel[]>> {
    const effectiveLimit = limit ?? SQLiteChannelRepository.DEFAULT_LIMIT;
    const effectiveOffset = offset ?? 0;
    return tryCatchAsync(async () => {
      const rows = this.findAllStmt.all(effectiveLimit, effectiveOffset) as ChannelRow[];
      return rows.map((row) => this.rowToChannel(row));
    }, operationErrorHandler('find all channels'));
  }

  async findByStatus(status: ChannelStatus, limit?: number, offset?: number): Promise<Result<readonly Channel[]>> {
    const effectiveLimit = limit ?? SQLiteChannelRepository.DEFAULT_LIMIT;
    const effectiveOffset = offset ?? 0;
    return tryCatchAsync(
      async () => {
        const rows = this.findByStatusStmt.all(status, effectiveLimit, effectiveOffset) as ChannelRow[];
        return rows.map((row) => this.rowToChannel(row));
      },
      operationErrorHandler('find channels by status', { status }),
    );
  }

  async updateStatus(id: ChannelId, status: ChannelStatus): Promise<Result<void>> {
    return tryCatchAsync(
      async () => {
        this.updateStatusStmt.run(status, Date.now(), id);
      },
      operationErrorHandler('update channel status', { channelId: id, status }),
    );
  }

  /**
   * Updates the current round counter for a channel.
   *
   * CALLER OBLIGATION: Caller must ensure `round` does not exceed the channel's
   * `maxRounds` value. This repository layer does not perform that check to avoid
   * an extra DB read on every round increment. Enforce the upper bound at the
   * service layer before calling this method.
   */
  async updateRound(id: ChannelId, round: number): Promise<Result<void>> {
    return tryCatchAsync(
      async () => {
        if (!Number.isInteger(round) || round < 0) {
          throw new Error(`updateRound: round must be a non-negative integer, got ${round} (type: ${typeof round})`);
        }
        this.updateRoundStmt.run(round, Date.now(), id);
      },
      operationErrorHandler('update channel round', { channelId: id, round }),
    );
  }

  async addMember(channelId: ChannelId, member: ChannelMember): Promise<Result<void>> {
    return tryCatchAsync(
      async () => {
        this.saveMemberStmt.run(this.memberToDbFormat(channelId, member));
      },
      operationErrorHandler('add channel member', { channelId, memberName: member.name }),
    );
  }

  async updateMemberStatus(
    channelId: ChannelId,
    memberName: string,
    status: ChannelMemberStatus,
  ): Promise<Result<void>> {
    return tryCatchAsync(
      async () => {
        this.updateMemberStatusStmt.run(status, channelId, memberName);
      },
      operationErrorHandler('update channel member status', { channelId, memberName, status }),
    );
  }

  async delete(id: ChannelId): Promise<Result<void>> {
    return tryCatchAsync(
      async () => {
        this.deleteStmt.run(id);
      },
      operationErrorHandler('delete channel', { channelId: id }),
    );
  }

  async count(): Promise<Result<number>> {
    return tryCatchAsync(async () => {
      const row = this.countStmt.get() as { count: number };
      return row.count;
    }, operationErrorHandler('count channels'));
  }

  async countByStatus(): Promise<Result<Record<string, number>>> {
    return tryCatchAsync(async () => {
      const rows = this.countByStatusStmt.all() as Array<{ status: string; count: number }>;
      const result: Record<string, number> = {};
      for (const row of rows) {
        result[row.status] = row.count;
      }
      return result;
    }, operationErrorHandler('count channels by status'));
  }

  // ============================================================================
  // Row conversion helpers
  // Pattern: Validate at boundary — ensures data integrity from database
  // ============================================================================

  private channelToDbFormat(channel: Channel): Record<string, unknown> {
    return {
      id: channel.id,
      name: channel.name,
      communication_mode: channel.communicationMode ?? null,
      topic: channel.topic ?? null,
      status: channel.status,
      max_rounds: channel.maxRounds ?? null,
      current_round: channel.currentRound,
      created_by: channel.createdBy ?? null,
      created_at: channel.createdAt,
      updated_at: channel.updatedAt,
    };
  }

  private memberToDbFormat(channelId: ChannelId, member: ChannelMember): Record<string, unknown> {
    return {
      channel_id: channelId,
      name: member.name,
      agent: member.agent,
      system_prompt: member.systemPrompt ?? null,
      tmux_session: member.tmuxSession,
      status: member.status,
      joined_at: member.joinedAt,
    };
  }

  /**
   * Converts a raw DB row to a Channel domain object, loading members via a
   * separate query.
   *
   * N+1 LOAD: Each call issues a separate `findMembersByChannelIdStmt` query.
   * findAll(100) = 101 queries total. Acceptable for Phase 6 baseline — channels
   * are bounded by DEFAULT_LIMIT=100 and member counts are small in practice.
   * Optimize to a single batch IN-clause fetch if findAll/findByStatus become
   * hot paths under production load.
   */
  private rowToChannel(row: ChannelRow): Channel {
    const validated = ChannelRowSchema.parse(row);
    const memberRows = this.findMembersByChannelIdStmt.all(validated.id) as ChannelMemberRow[];
    const members = memberRows.map((mr) => this.rowToMember(mr));

    return Object.freeze({
      id: ChannelId(validated.id),
      name: validated.name,
      members: Object.freeze(members),
      communicationMode: validated.communication_mode ?? undefined,
      topic: validated.topic ?? undefined,
      status: validated.status as ChannelStatus,
      maxRounds: validated.max_rounds ?? undefined,
      currentRound: validated.current_round,
      createdBy: validated.created_by ?? undefined,
      createdAt: validated.created_at,
      updatedAt: validated.updated_at,
    });
  }

  private rowToMember(row: ChannelMemberRow): ChannelMember {
    const validated = ChannelMemberRowSchema.parse(row);
    return Object.freeze({
      name: validated.name,
      agent: validated.agent as AgentProvider,
      systemPrompt: validated.system_prompt ?? undefined,
      tmuxSession: validated.tmux_session,
      status: validated.status as ChannelMemberStatus,
      joinedAt: validated.joined_at,
    });
  }
}
