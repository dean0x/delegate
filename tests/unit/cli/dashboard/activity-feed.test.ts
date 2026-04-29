/**
 * Tests for buildActivityFeed helper
 * ARCHITECTURE: Tests behavior — merge ordering, time bucketing, verb mapping per kind, limit
 */

import { describe, expect, it } from 'vitest';
import { buildActivityFeed } from '../../../../src/cli/dashboard/activity-feed.js';

// ============================================================================
// Test fixtures
// ============================================================================

const now = Date.now();
const T1 = now - 1000; // 1s ago
const T2 = now - 2000; // 2s ago
const T3 = now - 3000; // 3s ago
const T4 = now - 4000; // 4s ago
const T5 = now - 5000; // 5s ago

const taskBase = {
  prompt: 'Do something',
  priority: 'normal' as const,
  createdAt: now - 10000,
};

const loopBase = {
  strategy: 'retry' as const,
  taskTemplate: { prompt: 'Optimize', priority: 'normal' as const },
  exitCondition: 'npm test',
  evalTimeout: 60000,
  evalMode: 'shell' as const,
  workingDirectory: '/tmp',
  maxIterations: 10,
  maxConsecutiveFailures: 3,
  cooldownMs: 0,
  freshContext: true,
  createdAt: now - 10000,
};

// ============================================================================
// buildActivityFeed
// ============================================================================

describe('buildActivityFeed', () => {
  describe('merge ordering', () => {
    it('returns entries sorted descending by timestamp', () => {
      const feed = buildActivityFeed({
        tasks: [
          { ...taskBase, id: 'task-2', status: 'completed', updatedAt: T2 },
          { ...taskBase, id: 'task-1', status: 'running', updatedAt: T1 },
          { ...taskBase, id: 'task-3', status: 'failed', updatedAt: T3 },
        ],
        loops: [],
        orchestrations: [],
        schedules: [],
        pipelines: [],
        limit: 100,
      });

      expect(feed[0].entityId).toBe('task-1'); // most recent
      expect(feed[1].entityId).toBe('task-2');
      expect(feed[2].entityId).toBe('task-3'); // oldest
    });

    it('merges all entity kinds sorted by timestamp', () => {
      const feed = buildActivityFeed({
        tasks: [{ ...taskBase, id: 'task-a', status: 'running', updatedAt: T2 }],
        loops: [{ ...loopBase, id: 'loop-b', status: 'running', currentIteration: 2, updatedAt: T1 }],
        orchestrations: [
          { id: 'orch-c', status: 'running', updatedAt: T4, goal: 'Goal', agent: 'claude', createdAt: now - 10000 },
        ],
        schedules: [{ id: 'sched-d', status: 'active', updatedAt: T3, scheduleType: 'cron', createdAt: now - 10000 }],
        pipelines: [{ id: 'pipe-e', status: 'completed', updatedAt: T5, createdAt: now - 10000 }],
        limit: 100,
      });

      expect(feed).toHaveLength(5);
      expect(feed[0].entityId).toBe('loop-b'); // T1 — most recent
      expect(feed[1].entityId).toBe('task-a'); // T2
      expect(feed[2].entityId).toBe('sched-d'); // T3
      expect(feed[3].entityId).toBe('orch-c'); // T4
      expect(feed[4].entityId).toBe('pipe-e'); // T5 — oldest
    });

    it('returns empty array when all inputs are empty', () => {
      const feed = buildActivityFeed({
        tasks: [],
        loops: [],
        orchestrations: [],
        schedules: [],
        pipelines: [],
        limit: 100,
      });
      expect(feed).toHaveLength(0);
    });
  });

  describe('limit', () => {
    it('truncates to the specified limit after sorting', () => {
      const tasks = Array.from({ length: 10 }, (_, i) => ({
        ...taskBase,
        id: `task-${i}`,
        status: 'completed',
        updatedAt: now - i * 1000,
      }));

      const feed = buildActivityFeed({
        tasks,
        loops: [],
        orchestrations: [],
        schedules: [],
        pipelines: [],
        limit: 3,
      });

      expect(feed).toHaveLength(3);
      // Should be the 3 most recent
      expect(feed[0].entityId).toBe('task-0');
      expect(feed[1].entityId).toBe('task-1');
      expect(feed[2].entityId).toBe('task-2');
    });

    it('returns all entries when count is below limit', () => {
      const feed = buildActivityFeed({
        tasks: [{ ...taskBase, id: 'task-1', status: 'running', updatedAt: T1 }],
        loops: [],
        orchestrations: [],
        schedules: [],
        pipelines: [],
        limit: 50,
      });
      expect(feed).toHaveLength(1);
    });
  });

  describe('task verb mapping', () => {
    it('maps task status "completed" to action "completed"', () => {
      const feed = buildActivityFeed({
        tasks: [{ ...taskBase, id: 'task-1', status: 'completed', updatedAt: T1 }],
        loops: [],
        orchestrations: [],
        schedules: [],
        pipelines: [],
        limit: 100,
      });
      expect(feed[0].action).toBe('completed');
    });

    it('maps task status "failed" to action "failed"', () => {
      const feed = buildActivityFeed({
        tasks: [{ ...taskBase, id: 'task-1', status: 'failed', updatedAt: T1 }],
        loops: [],
        orchestrations: [],
        schedules: [],
        pipelines: [],
        limit: 100,
      });
      expect(feed[0].action).toBe('failed');
    });

    it('maps task status "running" to action "running"', () => {
      const feed = buildActivityFeed({
        tasks: [{ ...taskBase, id: 'task-1', status: 'running', updatedAt: T1 }],
        loops: [],
        orchestrations: [],
        schedules: [],
        pipelines: [],
        limit: 100,
      });
      expect(feed[0].action).toBe('running');
    });

    it('maps task status "queued" to action "queued"', () => {
      const feed = buildActivityFeed({
        tasks: [{ ...taskBase, id: 'task-1', status: 'queued', updatedAt: T1 }],
        loops: [],
        orchestrations: [],
        schedules: [],
        pipelines: [],
        limit: 100,
      });
      expect(feed[0].action).toBe('queued');
    });

    it('maps task status "cancelled" to action "cancelled"', () => {
      const feed = buildActivityFeed({
        tasks: [{ ...taskBase, id: 'task-1', status: 'cancelled', updatedAt: T1 }],
        loops: [],
        orchestrations: [],
        schedules: [],
        pipelines: [],
        limit: 100,
      });
      expect(feed[0].action).toBe('cancelled');
    });

    it('maps task kind correctly', () => {
      const feed = buildActivityFeed({
        tasks: [{ ...taskBase, id: 'task-1', status: 'running', updatedAt: T1 }],
        loops: [],
        orchestrations: [],
        schedules: [],
        pipelines: [],
        limit: 100,
      });
      expect(feed[0].kind).toBe('task');
    });
  });

  describe('loop verb mapping', () => {
    it('maps running loop with currentIteration to "iteration N"', () => {
      const feed = buildActivityFeed({
        tasks: [],
        loops: [{ ...loopBase, id: 'loop-1', status: 'running', currentIteration: 3, updatedAt: T1 }],
        orchestrations: [],
        schedules: [],
        pipelines: [],
        limit: 100,
      });
      expect(feed[0].action).toBe('iteration 3');
    });

    it('maps running loop without currentIteration to "running"', () => {
      const feed = buildActivityFeed({
        tasks: [],
        loops: [{ ...loopBase, id: 'loop-1', status: 'running', updatedAt: T1 }],
        orchestrations: [],
        schedules: [],
        pipelines: [],
        limit: 100,
      });
      expect(feed[0].action).toBe('running');
    });

    it('maps loop "completed" status to action "completed"', () => {
      const feed = buildActivityFeed({
        tasks: [],
        loops: [{ ...loopBase, id: 'loop-1', status: 'completed', updatedAt: T1 }],
        orchestrations: [],
        schedules: [],
        pipelines: [],
        limit: 100,
      });
      expect(feed[0].action).toBe('completed');
    });

    it('maps loop "paused" status to action "paused"', () => {
      const feed = buildActivityFeed({
        tasks: [],
        loops: [{ ...loopBase, id: 'loop-1', status: 'paused', updatedAt: T1 }],
        orchestrations: [],
        schedules: [],
        pipelines: [],
        limit: 100,
      });
      expect(feed[0].action).toBe('paused');
    });

    it('maps loop kind correctly', () => {
      const feed = buildActivityFeed({
        tasks: [],
        loops: [{ ...loopBase, id: 'loop-1', status: 'running', currentIteration: 1, updatedAt: T1 }],
        orchestrations: [],
        schedules: [],
        pipelines: [],
        limit: 100,
      });
      expect(feed[0].kind).toBe('loop');
    });
  });

  describe('orchestration verb mapping', () => {
    const orchBase = { goal: 'Goal', agent: 'claude', createdAt: now - 10000 };

    it('maps orchestration status "running" to action "planning"', () => {
      const feed = buildActivityFeed({
        tasks: [],
        loops: [],
        orchestrations: [{ ...orchBase, id: 'orch-1', status: 'running', updatedAt: T1 }],
        schedules: [],
        pipelines: [],
        limit: 100,
      });
      expect(feed[0].action).toBe('planning');
    });

    it('maps orchestration status "completed" to action "completed"', () => {
      const feed = buildActivityFeed({
        tasks: [],
        loops: [],
        orchestrations: [{ ...orchBase, id: 'orch-1', status: 'completed', updatedAt: T1 }],
        schedules: [],
        pipelines: [],
        limit: 100,
      });
      expect(feed[0].action).toBe('completed');
    });

    it('maps orchestration status "failed" to action "failed"', () => {
      const feed = buildActivityFeed({
        tasks: [],
        loops: [],
        orchestrations: [{ ...orchBase, id: 'orch-1', status: 'failed', updatedAt: T1 }],
        schedules: [],
        pipelines: [],
        limit: 100,
      });
      expect(feed[0].action).toBe('failed');
    });

    it('maps orchestration status "cancelled" to action "cancelled"', () => {
      const feed = buildActivityFeed({
        tasks: [],
        loops: [],
        orchestrations: [{ ...orchBase, id: 'orch-1', status: 'cancelled', updatedAt: T1 }],
        schedules: [],
        pipelines: [],
        limit: 100,
      });
      expect(feed[0].action).toBe('cancelled');
    });

    it('maps orchestration kind correctly', () => {
      const feed = buildActivityFeed({
        tasks: [],
        loops: [],
        orchestrations: [{ ...orchBase, id: 'orch-1', status: 'running', updatedAt: T1 }],
        schedules: [],
        pipelines: [],
        limit: 100,
      });
      expect(feed[0].kind).toBe('orchestration');
    });
  });

  describe('schedule verb mapping', () => {
    const schedBase = { scheduleType: 'cron' as const, createdAt: now - 10000 };

    it('maps schedule status "active" to action "active"', () => {
      const feed = buildActivityFeed({
        tasks: [],
        loops: [],
        orchestrations: [],
        schedules: [{ ...schedBase, id: 'sched-1', status: 'active', updatedAt: T1 }],
        pipelines: [],
        limit: 100,
      });
      expect(feed[0].action).toBe('active');
    });

    it('maps schedule status "completed" to action "completed"', () => {
      const feed = buildActivityFeed({
        tasks: [],
        loops: [],
        orchestrations: [],
        schedules: [{ ...schedBase, id: 'sched-1', status: 'completed', updatedAt: T1 }],
        pipelines: [],
        limit: 100,
      });
      expect(feed[0].action).toBe('completed');
    });

    it('maps schedule kind correctly', () => {
      const feed = buildActivityFeed({
        tasks: [],
        loops: [],
        orchestrations: [],
        schedules: [{ ...schedBase, id: 'sched-1', status: 'active', updatedAt: T1 }],
        pipelines: [],
        limit: 100,
      });
      expect(feed[0].kind).toBe('schedule');
    });
  });

  describe('entry shape', () => {
    it('includes entityId, status, kind, action, and timestamp', () => {
      const feed = buildActivityFeed({
        tasks: [{ ...taskBase, id: 'task-42', status: 'running', updatedAt: T1 }],
        loops: [],
        orchestrations: [],
        schedules: [],
        pipelines: [],
        limit: 100,
      });

      expect(feed[0]).toMatchObject({
        entityId: 'task-42',
        status: 'running',
        kind: 'task',
        action: 'running',
      });
      expect(typeof feed[0].timestamp).toBe('number');
    });

    it('uses updatedAt as the timestamp (epoch ms number)', () => {
      const feed = buildActivityFeed({
        tasks: [{ ...taskBase, id: 'task-1', status: 'running', updatedAt: T1 }],
        loops: [],
        orchestrations: [],
        schedules: [],
        pipelines: [],
        limit: 100,
      });
      expect(feed[0].timestamp).toBe(T1);
    });
  });

  describe('pipeline verb mapping', () => {
    it('maps pipeline status "running" to action "started"', () => {
      const feed = buildActivityFeed({
        tasks: [],
        loops: [],
        orchestrations: [],
        schedules: [],
        pipelines: [{ id: 'pipe-1', status: 'running', updatedAt: T1 }],
        limit: 100,
      });
      expect(feed[0].action).toBe('started');
    });

    it('maps pipeline status "completed" to action "completed"', () => {
      const feed = buildActivityFeed({
        tasks: [],
        loops: [],
        orchestrations: [],
        schedules: [],
        pipelines: [{ id: 'pipe-1', status: 'completed', updatedAt: T1 }],
        limit: 100,
      });
      expect(feed[0].action).toBe('completed');
    });

    it('maps pipeline status "failed" without failedStep to action "failed"', () => {
      const feed = buildActivityFeed({
        tasks: [],
        loops: [],
        orchestrations: [],
        schedules: [],
        pipelines: [{ id: 'pipe-1', status: 'failed', updatedAt: T1 }],
        limit: 100,
      });
      expect(feed[0].action).toBe('failed');
    });

    it('maps pipeline status "failed" with failedStep to "failed step N"', () => {
      const feed = buildActivityFeed({
        tasks: [],
        loops: [],
        orchestrations: [],
        schedules: [],
        pipelines: [{ id: 'pipe-1', status: 'failed', failedStep: 2, updatedAt: T1 }],
        limit: 100,
      });
      expect(feed[0].action).toBe('failed step 2');
    });

    it('maps pipeline status "cancelled" to action "cancelled"', () => {
      const feed = buildActivityFeed({
        tasks: [],
        loops: [],
        orchestrations: [],
        schedules: [],
        pipelines: [{ id: 'pipe-1', status: 'cancelled', updatedAt: T1 }],
        limit: 100,
      });
      expect(feed[0].action).toBe('cancelled');
    });

    it('maps pipeline kind correctly', () => {
      const feed = buildActivityFeed({
        tasks: [],
        loops: [],
        orchestrations: [],
        schedules: [],
        pipelines: [{ id: 'pipe-1', status: 'running', updatedAt: T1 }],
        limit: 100,
      });
      expect(feed[0].kind).toBe('pipeline');
    });
  });
});
