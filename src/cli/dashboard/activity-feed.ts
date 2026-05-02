/**
 * Activity feed helper — merges entity findUpdatedSince results into a unified feed
 * ARCHITECTURE: Pure function, no React imports, no side effects
 * Pattern: Functional core — sort + merge + limit
 */

import type { ActivityEntry } from '../../core/domain.js';

// ============================================================================
// Verb mapping helpers
// ============================================================================

function taskAction(status: string): string {
  return status; // task statuses map directly: completed, failed, running, queued, cancelled
}

function loopAction(status: string, currentIteration?: number): string {
  if (status === 'running' && currentIteration !== undefined) {
    return `iteration ${currentIteration}`;
  }
  return status;
}

function orchestrationAction(status: string): string {
  // Active orchestration is "planning" (it's running an agent loop)
  if (status === 'running' || status === 'planning') {
    return 'planning';
  }
  return status;
}

function scheduleAction(status: string): string {
  return status; // active, paused, completed, cancelled, expired
}

function pipelineAction(status: string, failedStep?: number): string {
  if (status === 'failed' && failedStep !== undefined) {
    return `failed step ${failedStep}`;
  }
  if (status === 'running') {
    return 'started';
  }
  return status; // completed, cancelled, pending
}

// ============================================================================
// buildActivityFeed
// ============================================================================

interface TaskLike {
  readonly id: string;
  readonly status: string;
  readonly updatedAt?: number;
  readonly createdAt?: number;
}

interface LoopLike {
  readonly id: string;
  readonly status: string;
  readonly updatedAt?: number;
  readonly createdAt?: number;
  readonly currentIteration?: number;
}

interface OrchestrationLike {
  readonly id: string;
  readonly status: string;
  readonly updatedAt?: number;
  readonly createdAt?: number;
}

interface ScheduleLike {
  readonly id: string;
  readonly status: string;
  readonly updatedAt?: number;
  readonly createdAt?: number;
}

interface PipelineLike {
  readonly id: string;
  readonly status: string;
  readonly updatedAt?: number;
  readonly createdAt?: number;
  /** Index (0-based) of the step that failed, if any */
  readonly failedStep?: number;
}

interface BuildActivityFeedArgs {
  readonly tasks: readonly TaskLike[];
  readonly loops: readonly LoopLike[];
  readonly orchestrations: readonly OrchestrationLike[];
  readonly schedules: readonly ScheduleLike[];
  readonly pipelines: readonly PipelineLike[];
  readonly limit: number;
}

/**
 * Merge entity arrays into a time-sorted activity feed.
 *
 * - All five entity kinds are merged into a single array
 * - Sorted descending by updatedAt (most recent first)
 * - Limited to `limit` entries after sort
 * - Action verbs are mapped per-kind based on status
 */
export function buildActivityFeed(args: BuildActivityFeedArgs): readonly ActivityEntry[] {
  const { tasks, loops, orchestrations, schedules, pipelines, limit } = args;

  const entries: ActivityEntry[] = [];

  for (const task of tasks) {
    entries.push({
      timestamp: task.updatedAt ?? task.createdAt ?? 0,
      kind: 'task',
      entityId: task.id,
      status: task.status,
      action: taskAction(task.status),
    });
  }

  for (const loop of loops) {
    entries.push({
      timestamp: loop.updatedAt ?? loop.createdAt ?? 0,
      kind: 'loop',
      entityId: loop.id,
      status: loop.status,
      action: loopAction(loop.status, loop.currentIteration),
    });
  }

  for (const orch of orchestrations) {
    entries.push({
      timestamp: orch.updatedAt ?? orch.createdAt ?? 0,
      kind: 'orchestration',
      entityId: orch.id,
      status: orch.status,
      action: orchestrationAction(orch.status),
    });
  }

  for (const sched of schedules) {
    entries.push({
      timestamp: sched.updatedAt ?? sched.createdAt ?? 0,
      kind: 'schedule',
      entityId: sched.id,
      status: sched.status,
      action: scheduleAction(sched.status),
    });
  }

  for (const pipeline of pipelines) {
    entries.push({
      timestamp: pipeline.updatedAt ?? pipeline.createdAt ?? 0,
      kind: 'pipeline',
      entityId: pipeline.id,
      status: pipeline.status,
      action: pipelineAction(pipeline.status, pipeline.failedStep),
    });
  }

  // Sort descending by timestamp (epoch ms — plain numeric comparison)
  entries.sort((a, b) => b.timestamp - a.timestamp);

  // Apply limit
  return entries.slice(0, limit);
}
