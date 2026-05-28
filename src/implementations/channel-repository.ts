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
  type ChannelMessage,
  ChannelStatus,
  type CommunicationMode,
} from '../core/domain.js';
import { operationErrorHandler } from '../core/errors.js';
import type { ChannelRepository } from '../core/interfaces.js';
import { ok, Result, tryCatchAsync } from '../core/result.js';
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

const ChannelMessageRowSchema = z.object({
  id: z.string().min(1),
  channel_id: z.string().min(1),
  from_member: z.string().min(1),
  to_member: z.string().nullable(),
  round: z.number().int().nonnegative(),
  summary: z.string(),
  created_at: z.number().int().positive(),
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

interface ChannelMessageRow {
  readonly id: string;
  readonly channel_id: string;
  readonly from_member: string;
  readonly to_member: string | null;
  readonly round: number;
  readonly summary: string;
  readonly created_at: number;
}

export class SQLiteChannelRepository implements ChannelRepository {
  private static readonly DEFAULT_LIMIT = 100;
  private static readonly DEFAULT_MESSAGE_LIMIT = 50;
  /**
   * Maximum messages retained per channel.
   * After INSERT, oldest rows beyond this bound are pruned inline.
   * DECISION: 500 is generous for dashboard display (default view shows 50) while
   * preventing unbounded growth in long-running channels.
   */
  private static readonly MAX_MESSAGES_PER_CHANNEL = 500;

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
  private readonly saveMessageStmt: SQLite.Statement;
  private readonly countMessagesStmt: SQLite.Statement;
  private readonly pruneMessagesStmt: SQLite.Statement;
  private readonly getMessagesStmt: SQLite.Statement;
  private readonly findUpdatedSinceStmt: SQLite.Statement;
  /**
   * Cache of IN-clause member lookup statements keyed by placeholder count.
   * Avoids re-preparing the same SQL on every dashboard poll tick.
   */
  private readonly membersByChannelIdsStmtCache: Map<number, SQLite.Statement> = new Map();

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

    this.saveMessageStmt = this.db.prepare(`
      INSERT INTO channel_messages (id, channel_id, from_member, to_member, round, summary, created_at)
      VALUES (@id, @channel_id, @from_member, @to_member, @round, @summary, @created_at)
    `);

    this.countMessagesStmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM channel_messages WHERE channel_id = ?
    `);

    this.pruneMessagesStmt = this.db.prepare(`
      DELETE FROM channel_messages
      WHERE channel_id = ?
        AND id NOT IN (
          SELECT id FROM channel_messages
          WHERE channel_id = ?
          ORDER BY created_at DESC
          LIMIT ?
        )
    `);

    this.getMessagesStmt = this.db.prepare(`
      SELECT * FROM channel_messages WHERE channel_id = ? ORDER BY created_at DESC LIMIT ?
    `);

    // idx_channels_updated_at (migration v31) covers WHERE + ORDER BY
    this.findUpdatedSinceStmt = this.db.prepare(`
      SELECT * FROM channels
      WHERE updated_at >= ?
      ORDER BY updated_at DESC
      LIMIT ?
    `);
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
      return this.hydrateChannelRows(rows);
    }, operationErrorHandler('find all channels'));
  }

  async findByStatus(status: ChannelStatus, limit?: number, offset?: number): Promise<Result<readonly Channel[]>> {
    const effectiveLimit = limit ?? SQLiteChannelRepository.DEFAULT_LIMIT;
    const effectiveOffset = offset ?? 0;
    return tryCatchAsync(
      async () => {
        const rows = this.findByStatusStmt.all(status, effectiveLimit, effectiveOffset) as ChannelRow[];
        return this.hydrateChannelRows(rows);
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

  async batchUpdateMemberStatuses(
    channelId: ChannelId,
    memberNames: readonly string[],
    status: ChannelMemberStatus,
  ): Promise<Result<void>> {
    if (memberNames.length === 0) return ok(undefined);
    return tryCatchAsync(
      async () => {
        const batchUpdate = this.db.transaction(() => {
          for (const memberName of memberNames) {
            this.updateMemberStatusStmt.run(status, channelId, memberName);
          }
        });
        batchUpdate();
      },
      operationErrorHandler('batch update channel member statuses', { channelId, status }),
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

  async findUpdatedSince(sinceMs: number, limit: number): Promise<Result<readonly Channel[]>> {
    return tryCatchAsync(
      async () => {
        const rows = this.findUpdatedSinceStmt.all(sinceMs, limit) as ChannelRow[];
        // Skip member hydration — sole consumer (activity feed) never reads members.
        // hydrateChannelRows fires an extra IN-clause query per call; at 1-second
        // poll frequency that adds unnecessary write overhead.
        return rows.map((row) => this.rowToChannelWithMembers(row, []));
      },
      operationErrorHandler('find channels updated since', { sinceMs }),
    );
  }

  // ============================================================================
  // Channel message persistence (Phase 9 Dashboard)
  // ============================================================================

  /**
   * Persist a single ChannelMessage summary row.
   * ARCHITECTURE: INSERT only — message history is append-only.
   * Called by ChannelMessagePersistenceHandler; best-effort — errors surface as err().
   */
  async saveMessage(msg: ChannelMessage): Promise<Result<void>> {
    return tryCatchAsync(
      async () => {
        // Wrap INSERT + COUNT + conditional DELETE in a single transaction.
        // Prevents concurrent ChannelMessageSent events from double-pruning the same channel.
        // Best-effort semantics preserved: prune errors are caught inside so the transaction
        // still commits the INSERT if pruning throws.
        const saveAndPrune = this.db.transaction(() => {
          this.saveMessageStmt.run({
            id: msg.id,
            channel_id: msg.channelId,
            from_member: msg.fromMember,
            to_member: msg.toMember ?? null,
            round: msg.round,
            summary: msg.summary,
            created_at: msg.createdAt,
          });
          // Prune oldest rows beyond MAX_MESSAGES_PER_CHANNEL to prevent unbounded growth.
          // Guard: only prune once channel has accumulated enough messages to warrant a scan.
          try {
            const countRow = this.countMessagesStmt.get(msg.channelId) as { count: number };
            if (countRow.count > SQLiteChannelRepository.MAX_MESSAGES_PER_CHANNEL) {
              this.pruneMessagesStmt.run(
                msg.channelId,
                msg.channelId,
                SQLiteChannelRepository.MAX_MESSAGES_PER_CHANNEL,
              );
            }
          } catch {
            // Prune failure is intentionally swallowed — the message was saved successfully.
          }
        });
        saveAndPrune();
      },
      operationErrorHandler('save channel message', { messageId: msg.id, channelId: msg.channelId }),
    );
  }

  /**
   * Retrieve message summaries for a channel, newest-first.
   * ARCHITECTURE: Returns readonly array, max `limit` rows (default 50).
   * Used by dashboard detail view for message history display.
   */
  async getMessages(channelId: ChannelId, limit?: number): Promise<Result<readonly ChannelMessage[]>> {
    const effectiveLimit = Math.max(
      1,
      Math.min(
        limit ?? SQLiteChannelRepository.DEFAULT_MESSAGE_LIMIT,
        SQLiteChannelRepository.MAX_MESSAGES_PER_CHANNEL,
      ),
    );
    return tryCatchAsync(
      async () => {
        const rows = this.getMessagesStmt.all(channelId, effectiveLimit) as ChannelMessageRow[];
        return rows.map((row) => this.rowToChannelMessage(row));
      },
      operationErrorHandler('get channel messages', { channelId }),
    );
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
   * Batch-hydrates channel rows with their members in two queries total:
   * one for channels (already fetched by caller) and one IN-clause fetch for all
   * members, grouped by channel_id in-memory.
   *
   * PERFORMANCE: O(1) queries regardless of row count, safe for 1-second dashboard
   * poll loop. Called by findAll() and findByStatus().
   */
  private hydrateChannelRows(rows: ChannelRow[]): readonly Channel[] {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const membersByChannelId = this.findMembersByChannelIds(ids);
    return rows.map((row) => this.rowToChannelWithMembers(row, membersByChannelId.get(row.id) ?? []));
  }

  /**
   * Fetches all members for the given channel IDs in a single IN-clause query.
   * Returns a Map keyed by channel_id for O(1) lookup.
   *
   * ARCHITECTURE: Builds the SQL dynamically from the id list; better-sqlite3
   * does not support array binding directly. The id list is always bounded by
   * DEFAULT_LIMIT (100) so the IN clause is safe.
   * Prepared statements are cached by arity to avoid re-preparing on every poll tick.
   */
  private findMembersByChannelIds(ids: readonly string[]): Map<string, ChannelMemberRow[]> {
    const arity = ids.length;
    let stmt = this.membersByChannelIdsStmtCache.get(arity);
    if (!stmt) {
      const placeholders = ids.map(() => '?').join(', ');
      stmt = this.db.prepare(
        `SELECT * FROM channel_members WHERE channel_id IN (${placeholders}) ORDER BY joined_at ASC`,
      );
      this.membersByChannelIdsStmtCache.set(arity, stmt);
      // Evict the oldest entry when the cache exceeds DEFAULT_LIMIT arities.
      // In practice arity is always ≤ DEFAULT_LIMIT (100), but guard against
      // callers passing unexpectedly large slices.
      if (this.membersByChannelIdsStmtCache.size > SQLiteChannelRepository.DEFAULT_LIMIT) {
        const firstKey = this.membersByChannelIdsStmtCache.keys().next().value;
        if (firstKey !== undefined) {
          this.membersByChannelIdsStmtCache.delete(firstKey);
        }
      }
    }
    const memberRows = stmt.all(...ids) as ChannelMemberRow[];

    const byChannelId = new Map<string, ChannelMemberRow[]>();
    for (const row of memberRows) {
      let list = byChannelId.get(row.channel_id);
      if (!list) {
        list = [];
        byChannelId.set(row.channel_id, list);
      }
      list.push(row);
    }
    return byChannelId;
  }

  /**
   * Converts a raw DB row to a Channel domain object using pre-fetched member rows.
   * Used by hydrateChannelRows() to avoid per-channel queries in list operations.
   */
  private rowToChannelWithMembers(row: ChannelRow, memberRows: ChannelMemberRow[]): Channel {
    const validated = ChannelRowSchema.parse(row);
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

  /**
   * Converts a raw DB row to a Channel domain object, loading members via a
   * separate query.
   *
   * Used only for single-channel lookups (findById, findByName) where N+1 is
   * not a concern. List operations (findAll, findByStatus) use hydrateChannelRows()
   * instead to batch-load members in a single IN-clause query.
   */
  private rowToChannel(row: ChannelRow): Channel {
    const validated = ChannelRowSchema.parse(row);
    const memberRows = this.findMembersByChannelIdStmt.all(validated.id) as ChannelMemberRow[];
    return this.rowToChannelWithMembers(row, memberRows);
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

  private rowToChannelMessage(row: ChannelMessageRow): ChannelMessage {
    const validated = ChannelMessageRowSchema.parse(row);
    return Object.freeze({
      id: validated.id,
      channelId: ChannelId(validated.channel_id),
      fromMember: validated.from_member,
      toMember: validated.to_member ?? null,
      round: validated.round,
      summary: validated.summary,
      createdAt: validated.created_at,
    });
  }
}
