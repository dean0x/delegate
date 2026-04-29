/**
 * Tests for detail views — LoopDetail, TaskDetail, ScheduleDetail, OrchestrationDetail,
 * and the DetailView dispatcher component.
 * Tests behavior (visible content), not rendering internals.
 */

import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatElapsed } from '../../../../src/cli/dashboard/format.js';
import type { DashboardData } from '../../../../src/cli/dashboard/types.js';
import { DetailView } from '../../../../src/cli/dashboard/views/detail-view.js';
import { LoopDetail } from '../../../../src/cli/dashboard/views/loop-detail.js';
import { OrchestrationDetail } from '../../../../src/cli/dashboard/views/orchestration-detail.js';
import { ScheduleDetail } from '../../../../src/cli/dashboard/views/schedule-detail.js';
import { TaskDetail } from '../../../../src/cli/dashboard/views/task-detail.js';
import type {
  Loop,
  LoopIteration,
  Orchestration,
  OrchestratorId,
  Pipeline,
  PipelineId,
  PipelineStatus,
  PipelineStepDefinition,
  Schedule,
  Task,
  TaskId,
  TaskUsage,
} from '../../../../src/core/domain.js';
import {
  LoopStatus,
  LoopStrategy,
  OrchestratorStatus,
  PipelineStatus,
  ScheduleStatus,
  ScheduleType,
  TaskStatus,
} from '../../../../src/core/domain.js';
import type { ScheduleExecution } from '../../../../src/core/interfaces.js';

// ============================================================================
// Test fixtures
// ============================================================================

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-abc-123' as Task['id'],
    prompt: 'Write comprehensive unit tests for the auth module',
    status: TaskStatus.RUNNING,
    priority: 'normal' as Task['priority'],
    agent: 'claude',
    model: 'claude-3-5-sonnet',
    workingDirectory: '/projects/myapp',
    createdAt: Date.now() - 120_000,
    startedAt: Date.now() - 90_000,
    timeout: 300_000,
    ...overrides,
  } as Task;
}

function makeLoop(overrides: Partial<Loop> = {}): Loop {
  return {
    id: 'loop-xyz-456' as Loop['id'],
    strategy: LoopStrategy.OPTIMIZE,
    taskTemplate: { prompt: 'Optimize the sorting algorithm', priority: 'normal' as Task['priority'] },
    exitCondition: 'npm test && npm run benchmark',
    evalDirection: 'maximize',
    evalTimeout: 60_000,
    evalMode: 'shell' as Loop['evalMode'],
    workingDirectory: '/projects/algo',
    maxIterations: 20,
    maxConsecutiveFailures: 3,
    cooldownMs: 1_000,
    freshContext: true,
    currentIteration: 7,
    bestScore: 0.92,
    bestIterationId: 5,
    bestIterationCommitSha: 'abc123def456',
    consecutiveFailures: 0,
    status: LoopStatus.RUNNING,
    gitBranch: 'loop-optimize',
    gitStartCommitSha: 'deadbeef1234',
    createdAt: Date.now() - 300_000,
    updatedAt: Date.now() - 60_000,
    ...overrides,
  } as Loop;
}

function makeLoopIteration(overrides: Partial<LoopIteration> = {}): LoopIteration {
  return {
    id: 1,
    loopId: 'loop-xyz-456' as LoopIteration['loopId'],
    iterationNumber: 1,
    taskId: 'task-iter-1' as LoopIteration['taskId'],
    status: 'pass',
    score: 0.78,
    gitCommitSha: 'aabbccdd',
    startedAt: Date.now() - 200_000,
    completedAt: Date.now() - 150_000,
    ...overrides,
  } as LoopIteration;
}

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'schedule-abc' as Schedule['id'],
    taskTemplate: { prompt: 'Deploy to staging' } as Schedule['taskTemplate'],
    scheduleType: ScheduleType.CRON,
    cronExpression: '0 9 * * 1-5',
    timezone: 'America/New_York',
    missedRunPolicy: 'skip' as Schedule['missedRunPolicy'],
    status: ScheduleStatus.ACTIVE,
    runCount: 5,
    maxRuns: 100,
    nextRunAt: Date.now() + 3_600_000,
    lastRunAt: Date.now() - 3_600_000,
    createdAt: Date.now() - 86_400_000,
    updatedAt: Date.now() - 3_600_000,
    ...overrides,
  } as Schedule;
}

function makeScheduleExecution(overrides: Partial<ScheduleExecution> = {}): ScheduleExecution {
  return {
    id: 1,
    scheduleId: 'schedule-abc' as ScheduleExecution['scheduleId'],
    taskId: 'task-exec-1' as ScheduleExecution['taskId'],
    scheduledFor: Date.now() - 7_200_000,
    executedAt: Date.now() - 7_200_000,
    status: 'completed',
    createdAt: Date.now() - 7_200_000,
    ...overrides,
  } as ScheduleExecution;
}

function makeOrchestration(overrides: Partial<Orchestration> = {}): Orchestration {
  return {
    id: 'orchestrator-zzz-789' as Orchestration['id'],
    goal: 'Refactor the entire authentication system to use OAuth 2.0',
    status: OrchestratorStatus.RUNNING,
    agent: 'claude',
    model: 'claude-3-opus',
    stateFilePath: '/tmp/orch-state.json',
    workingDirectory: '/projects/auth',
    maxDepth: 5,
    maxWorkers: 3,
    maxIterations: 20,
    createdAt: Date.now() - 600_000,
    updatedAt: Date.now() - 60_000,
    ...overrides,
  } as Orchestration;
}

function makeDashboardData(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    tasks: [],
    loops: [],
    schedules: [],
    orchestrations: [],
    pipelines: [],
    taskCounts: { total: 0, byStatus: {} },
    loopCounts: { total: 0, byStatus: {} },
    scheduleCounts: { total: 0, byStatus: {} },
    orchestrationCounts: { total: 0, byStatus: {} },
    pipelineCounts: { total: 0, byStatus: {} },
    ...overrides,
  };
}

// ============================================================================
// LoopDetail tests
// ============================================================================

describe('LoopDetail', () => {
  it('shows loop ID', () => {
    const loop = makeLoop();
    const { lastFrame } = render(<LoopDetail loop={loop} iterations={undefined} scrollOffset={0} />);
    expect(lastFrame()).toContain('loop-xyz-456');
  });

  it('shows loop strategy', () => {
    const loop = makeLoop({ strategy: LoopStrategy.OPTIMIZE });
    const { lastFrame } = render(<LoopDetail loop={loop} iterations={undefined} scrollOffset={0} />);
    expect(lastFrame()).toContain('optimize');
  });

  it('shows iteration progress', () => {
    const loop = makeLoop({ currentIteration: 7, maxIterations: 20 });
    const { lastFrame } = render(<LoopDetail loop={loop} iterations={undefined} scrollOffset={0} />);
    expect(lastFrame()).toContain('7/20');
  });

  it('shows best score', () => {
    const loop = makeLoop({ bestScore: 0.92 });
    const { lastFrame } = render(<LoopDetail loop={loop} iterations={undefined} scrollOffset={0} />);
    expect(lastFrame()).toContain('0.92');
  });

  it('shows eval mode', () => {
    const loop = makeLoop({ evalMode: 'shell' as Loop['evalMode'] });
    const { lastFrame } = render(<LoopDetail loop={loop} iterations={undefined} scrollOffset={0} />);
    expect(lastFrame()).toContain('shell');
  });

  it('shows git branch when present', () => {
    const loop = makeLoop({ gitBranch: 'loop-optimize' });
    const { lastFrame } = render(<LoopDetail loop={loop} iterations={undefined} scrollOffset={0} />);
    expect(lastFrame()).toContain('loop-optimize');
  });

  it('shows exit condition', () => {
    const loop = makeLoop({ exitCondition: 'npm test && npm run benchmark' });
    const { lastFrame } = render(<LoopDetail loop={loop} iterations={undefined} scrollOffset={0} />);
    expect(lastFrame()).toContain('npm test');
  });

  it('shows "No iterations yet" when iterations is undefined', () => {
    const loop = makeLoop();
    const { lastFrame } = render(<LoopDetail loop={loop} iterations={undefined} scrollOffset={0} />);
    expect(lastFrame()).toContain('No iterations yet');
  });

  it('shows "No iterations yet" when iterations is empty', () => {
    const loop = makeLoop();
    const { lastFrame } = render(<LoopDetail loop={loop} iterations={[]} scrollOffset={0} />);
    expect(lastFrame()).toContain('No iterations yet');
  });

  it('shows iteration count in history section', () => {
    const loop = makeLoop();
    const iter = makeLoopIteration();
    const { lastFrame } = render(<LoopDetail loop={loop} iterations={[iter]} scrollOffset={0} />);
    expect(lastFrame()).toContain('(1 total)');
  });

  it('shows iteration status in history table', () => {
    const loop = makeLoop();
    const iter = makeLoopIteration({ status: 'pass' });
    const { lastFrame } = render(<LoopDetail loop={loop} iterations={[iter]} scrollOffset={0} />);
    expect(lastFrame()).toContain('pass');
  });

  it('shows iteration score in history table', () => {
    const loop = makeLoop();
    const iter = makeLoopIteration({ score: 0.78 });
    const { lastFrame } = render(<LoopDetail loop={loop} iterations={[iter]} scrollOffset={0} />);
    expect(lastFrame()).toContain('0.78');
  });

  it('shows iteration number in history table', () => {
    const loop = makeLoop();
    const iter = makeLoopIteration({ iterationNumber: 3 });
    const { lastFrame } = render(<LoopDetail loop={loop} iterations={[iter]} scrollOffset={0} />);
    expect(lastFrame()).toContain('3');
  });

  it('shows Iteration History section header', () => {
    const loop = makeLoop();
    const { lastFrame } = render(<LoopDetail loop={loop} iterations={undefined} scrollOffset={0} />);
    expect(lastFrame()).toContain('Iteration History');
  });
});

// ============================================================================
// TaskDetail tests
// ============================================================================

describe('TaskDetail', () => {
  it('shows task ID', () => {
    const task = makeTask();
    const { lastFrame } = render(<TaskDetail task={task} />);
    expect(lastFrame()).toContain('task-abc-123');
  });

  it('shows task status', () => {
    const task = makeTask({ status: TaskStatus.COMPLETED });
    const { lastFrame } = render(<TaskDetail task={task} />);
    expect(lastFrame()).toContain('completed');
  });

  it('shows task priority', () => {
    const task = makeTask({ priority: 'high' as Task['priority'] });
    const { lastFrame } = render(<TaskDetail task={task} />);
    expect(lastFrame()).toContain('high');
  });

  it('shows agent when present', () => {
    const task = makeTask({ agent: 'claude' as Task['agent'] });
    const { lastFrame } = render(<TaskDetail task={task} />);
    expect(lastFrame()).toContain('claude');
  });

  it('shows model when present', () => {
    const task = makeTask({ model: 'claude-3-5-sonnet' });
    const { lastFrame } = render(<TaskDetail task={task} />);
    expect(lastFrame()).toContain('claude-3-5-sonnet');
  });

  it('shows prompt text', () => {
    const task = makeTask({ prompt: 'Write comprehensive unit tests for the auth module' });
    const { lastFrame } = render(<TaskDetail task={task} />);
    expect(lastFrame()).toContain('Write comprehensive unit tests');
  });

  it('shows working directory when present', () => {
    const task = makeTask({ workingDirectory: '/projects/myapp' });
    const { lastFrame } = render(<TaskDetail task={task} />);
    expect(lastFrame()).toContain('/projects/myapp');
  });

  it('shows timeout when present', () => {
    const task = makeTask({ timeout: 300_000 });
    const { lastFrame } = render(<TaskDetail task={task} />);
    expect(lastFrame()).toContain('300000ms');
  });

  it('shows dependencies when present', () => {
    const task = makeTask({ dependsOn: ['task-dep-1' as Task['id'], 'task-dep-2' as Task['id']] });
    const { lastFrame } = render(<TaskDetail task={task} />);
    expect(lastFrame()).toContain('task-dep-1');
    expect(lastFrame()).toContain('task-dep-2');
  });

  it('shows dependency state when present', () => {
    const task = makeTask({ dependencyState: 'blocked' });
    const { lastFrame } = render(<TaskDetail task={task} />);
    expect(lastFrame()).toContain('blocked');
  });

  it('shows retry count when present', () => {
    const task = makeTask({ retryCount: 2 });
    const { lastFrame } = render(<TaskDetail task={task} />);
    expect(lastFrame()).toContain('2');
  });

  it('shows exit code when present', () => {
    const task = makeTask({ exitCode: 1 });
    const { lastFrame } = render(<TaskDetail task={task} />);
    expect(lastFrame()).toContain('1');
  });

  it('shows error message when error is an Error instance', () => {
    const task = makeTask({ error: new Error('Process crashed unexpectedly'), status: TaskStatus.FAILED });
    const { lastFrame } = render(<TaskDetail task={task} />);
    expect(lastFrame()).toContain('Process crashed unexpectedly');
  });

  it('shows elapsed time for running tasks with startedAt', () => {
    const startedAt = Date.now() - 90_000; // 1m 30s ago
    const task = makeTask({ status: TaskStatus.RUNNING, startedAt });
    const { lastFrame } = render(<TaskDetail task={task} />);
    const frame = lastFrame() ?? '';
    // Should contain elapsed format — 1m 30s or similar
    expect(frame).toMatch(/\d+[ms]/);
  });

  it('shows Task Detail header', () => {
    const task = makeTask();
    const { lastFrame } = render(<TaskDetail task={task} />);
    expect(lastFrame()).toContain('Task Detail');
  });
});

// ============================================================================
// ScheduleDetail tests
// ============================================================================

describe('ScheduleDetail', () => {
  it('shows schedule ID', () => {
    const schedule = makeSchedule();
    const { lastFrame } = render(<ScheduleDetail schedule={schedule} executions={undefined} scrollOffset={0} />);
    expect(lastFrame()).toContain('schedule-abc');
  });

  it('shows schedule type', () => {
    const schedule = makeSchedule({ scheduleType: ScheduleType.CRON });
    const { lastFrame } = render(<ScheduleDetail schedule={schedule} executions={undefined} scrollOffset={0} />);
    expect(lastFrame()).toContain('cron');
  });

  it('shows cron expression when present', () => {
    const schedule = makeSchedule({ cronExpression: '0 9 * * 1-5' });
    const { lastFrame } = render(<ScheduleDetail schedule={schedule} executions={undefined} scrollOffset={0} />);
    expect(lastFrame()).toContain('0 9 * * 1-5');
  });

  it('shows timezone', () => {
    const schedule = makeSchedule({ timezone: 'America/New_York' });
    const { lastFrame } = render(<ScheduleDetail schedule={schedule} executions={undefined} scrollOffset={0} />);
    expect(lastFrame()).toContain('America/New_York');
  });

  it('shows missed run policy', () => {
    const schedule = makeSchedule({ missedRunPolicy: 'skip' as Schedule['missedRunPolicy'] });
    const { lastFrame } = render(<ScheduleDetail schedule={schedule} executions={undefined} scrollOffset={0} />);
    expect(lastFrame()).toContain('skip');
  });

  it('shows run progress', () => {
    const schedule = makeSchedule({ runCount: 5, maxRuns: 100 });
    const { lastFrame } = render(<ScheduleDetail schedule={schedule} executions={undefined} scrollOffset={0} />);
    expect(lastFrame()).toContain('5/100');
  });

  it('shows "No executions yet" when executions is undefined', () => {
    const schedule = makeSchedule();
    const { lastFrame } = render(<ScheduleDetail schedule={schedule} executions={undefined} scrollOffset={0} />);
    expect(lastFrame()).toContain('No executions yet');
  });

  it('shows execution count in history section', () => {
    const schedule = makeSchedule();
    const exec = makeScheduleExecution();
    const { lastFrame } = render(<ScheduleDetail schedule={schedule} executions={[exec]} scrollOffset={0} />);
    expect(lastFrame()).toContain('(1 total)');
  });

  it('shows execution status in history table', () => {
    const schedule = makeSchedule();
    const exec = makeScheduleExecution({ status: 'completed' });
    const { lastFrame } = render(<ScheduleDetail schedule={schedule} executions={[exec]} scrollOffset={0} />);
    expect(lastFrame()).toContain('completed');
  });

  it('shows Execution History section header', () => {
    const schedule = makeSchedule();
    const { lastFrame } = render(<ScheduleDetail schedule={schedule} executions={undefined} scrollOffset={0} />);
    expect(lastFrame()).toContain('Execution History');
  });

  it('shows Schedule Detail header', () => {
    const schedule = makeSchedule();
    const { lastFrame } = render(<ScheduleDetail schedule={schedule} executions={undefined} scrollOffset={0} />);
    expect(lastFrame()).toContain('Schedule Detail');
  });
});

// ============================================================================
// OrchestrationDetail tests
// ============================================================================

describe('OrchestrationDetail', () => {
  it('shows orchestration ID', () => {
    const orch = makeOrchestration();
    const { lastFrame } = render(<OrchestrationDetail orchestration={orch} />);
    expect(lastFrame()).toContain('orchestrator-zzz-789');
  });

  it('shows goal text', () => {
    const orch = makeOrchestration({ goal: 'Refactor the entire authentication system to use OAuth 2.0' });
    const { lastFrame } = render(<OrchestrationDetail orchestration={orch} />);
    expect(lastFrame()).toContain('Refactor the entire authentication system');
  });

  it('shows agent when present', () => {
    const orch = makeOrchestration({ agent: 'claude' as Orchestration['agent'] });
    const { lastFrame } = render(<OrchestrationDetail orchestration={orch} />);
    expect(lastFrame()).toContain('claude');
  });

  it('shows model when present', () => {
    const orch = makeOrchestration({ model: 'claude-3-opus' });
    const { lastFrame } = render(<OrchestrationDetail orchestration={orch} />);
    expect(lastFrame()).toContain('claude-3-opus');
  });

  it('shows max depth', () => {
    const orch = makeOrchestration({ maxDepth: 5 });
    const { lastFrame } = render(<OrchestrationDetail orchestration={orch} />);
    expect(lastFrame()).toContain('5');
  });

  it('shows max workers', () => {
    const orch = makeOrchestration({ maxWorkers: 3 });
    const { lastFrame } = render(<OrchestrationDetail orchestration={orch} />);
    expect(lastFrame()).toContain('3');
  });

  it('shows working directory', () => {
    const orch = makeOrchestration({ workingDirectory: '/projects/auth' });
    const { lastFrame } = render(<OrchestrationDetail orchestration={orch} />);
    expect(lastFrame()).toContain('/projects/auth');
  });

  it('shows state file path', () => {
    const orch = makeOrchestration({ stateFilePath: '/tmp/orch-state.json' });
    const { lastFrame } = render(<OrchestrationDetail orchestration={orch} />);
    expect(lastFrame()).toContain('/tmp/orch-state.json');
  });

  it('shows loop ID when present', () => {
    const orch = makeOrchestration({ loopId: 'loop-linked-abc' as Orchestration['loopId'] });
    const { lastFrame } = render(<OrchestrationDetail orchestration={orch} />);
    expect(lastFrame()).toContain('loop-linked-abc');
  });

  it('shows Orchestration Detail header', () => {
    const orch = makeOrchestration();
    const { lastFrame } = render(<OrchestrationDetail orchestration={orch} />);
    expect(lastFrame()).toContain('Orchestration Detail');
  });
});

// ============================================================================
// DetailView dispatcher tests
// ============================================================================

describe('DetailView', () => {
  it('shows entity-not-found when data is null', () => {
    const { lastFrame } = render(
      <DetailView entityType="loops" entityId="loop-missing" data={null} scrollOffset={0} />,
    );
    expect(lastFrame()).toContain('Entity not found');
  });

  it('shows entity-not-found when entity ID does not match', () => {
    const data = makeDashboardData({ loops: [makeLoop()] });
    const { lastFrame } = render(
      <DetailView entityType="loops" entityId="loop-does-not-exist" data={data} scrollOffset={0} />,
    );
    expect(lastFrame()).toContain('Entity not found');
  });

  it('dispatches to LoopDetail for loops entityType', () => {
    const loop = makeLoop();
    const data = makeDashboardData({ loops: [loop] });
    const { lastFrame } = render(<DetailView entityType="loops" entityId={loop.id} data={data} scrollOffset={0} />);
    expect(lastFrame()).toContain('Loop Detail');
    expect(lastFrame()).toContain(loop.id);
  });

  it('dispatches to TaskDetail for tasks entityType', () => {
    const task = makeTask();
    const data = makeDashboardData({ tasks: [task] });
    const { lastFrame } = render(<DetailView entityType="tasks" entityId={task.id} data={data} scrollOffset={0} />);
    expect(lastFrame()).toContain('Task Detail');
    expect(lastFrame()).toContain(task.id);
  });

  it('dispatches to ScheduleDetail for schedules entityType', () => {
    const schedule = makeSchedule();
    const data = makeDashboardData({ schedules: [schedule] });
    const { lastFrame } = render(
      <DetailView entityType="schedules" entityId={schedule.id} data={data} scrollOffset={0} />,
    );
    expect(lastFrame()).toContain('Schedule Detail');
    expect(lastFrame()).toContain(schedule.id);
  });

  it('dispatches to OrchestrationDetail for orchestrations entityType', () => {
    const orch = makeOrchestration();
    const data = makeDashboardData({ orchestrations: [orch] });
    const { lastFrame } = render(
      <DetailView entityType="orchestrations" entityId={orch.id} data={data} scrollOffset={0} />,
    );
    expect(lastFrame()).toContain('Orchestration Detail');
    expect(lastFrame()).toContain(orch.id);
  });

  it('passes iterations to LoopDetail from data', () => {
    const loop = makeLoop();
    const iter = makeLoopIteration({ iterationNumber: 7 });
    const data = makeDashboardData({
      loops: [loop],
      iterations: [iter],
    });
    const { lastFrame } = render(<DetailView entityType="loops" entityId={loop.id} data={data} scrollOffset={0} />);
    expect(lastFrame()).toContain('(1 total)');
  });

  it('passes executions to ScheduleDetail from data', () => {
    const schedule = makeSchedule();
    const exec = makeScheduleExecution({ status: 'completed' });
    const data = makeDashboardData({
      schedules: [schedule],
      executions: [exec],
    });
    const { lastFrame } = render(
      <DetailView entityType="schedules" entityId={schedule.id} data={data} scrollOffset={0} />,
    );
    expect(lastFrame()).toContain('(1 total)');
  });
});

// ============================================================================
// formatElapsed tests
// ============================================================================

describe('formatElapsed', () => {
  const FROZEN_NOW = 1_700_000_000_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "0s" for future timestamps', () => {
    expect(formatElapsed(FROZEN_NOW + 5_000)).toBe('0s');
  });

  it('returns seconds for elapsed < 60s', () => {
    expect(formatElapsed(FROZEN_NOW - 45_000)).toBe('45s');
  });

  it('returns "1m 30s" for 90 seconds elapsed', () => {
    expect(formatElapsed(FROZEN_NOW - 90_000)).toBe('1m 30s');
  });

  it('returns "2m" for exactly 120 seconds elapsed', () => {
    expect(formatElapsed(FROZEN_NOW - 120_000)).toBe('2m');
  });

  it('returns "1h 5m" for 65 minutes elapsed', () => {
    expect(formatElapsed(FROZEN_NOW - 65 * 60_000)).toBe('1h 5m');
  });

  it('returns "2h" for exactly 2 hours elapsed', () => {
    expect(formatElapsed(FROZEN_NOW - 2 * 3_600_000)).toBe('2h');
  });

  it('returns "0s" for exactly now', () => {
    expect(formatElapsed(FROZEN_NOW)).toBe('0s');
  });
});

// ============================================================================
// Phase C: TaskDetail enhancements — orchestrator attribution, dependencies, usage
// ============================================================================

describe('TaskDetail — Phase C enhancements', () => {
  it('shows orchestrator ID when task has orchestratorId', () => {
    const task = makeTask({ orchestratorId: 'orch-parent-001' as Task['orchestratorId'] });
    const { lastFrame } = render(<TaskDetail task={task} animFrame={0} />);
    expect(lastFrame()).toContain('orch-parent-001');
    expect(lastFrame()).toContain('Orchestrator');
  });

  it('does not show Orchestrator field when orchestratorId is absent', () => {
    const task = makeTask({ orchestratorId: undefined });
    const { lastFrame } = render(<TaskDetail task={task} animFrame={0} />);
    expect(lastFrame()).not.toContain('Orchestrator');
  });

  it('shows Dependencies section with blocked-by tasks', () => {
    const task = makeTask();
    const deps = [
      { taskId: 'task-dep-aaa111222333', status: 'completed' },
      { taskId: 'task-dep-bbb444555666', status: 'running' },
    ];
    const { frames } = render(<TaskDetail task={task} animFrame={0} dependencies={deps} />);
    // Use all frames to get full output (ink-testing-library may clip lastFrame by terminal height)
    const allOutput = frames.join('\n');
    expect(allOutput).toContain('Dependencies');
    expect(allOutput).toContain('Blocked by');
    expect(allOutput).toContain('task-dep-aaa');
    expect(allOutput).toContain('completed');
    expect(allOutput).toContain('running');
  });

  it('shows Dependencies section with blocks tasks', () => {
    const task = makeTask();
    const dependents = [{ taskId: 'task-blocked-ccc777', status: 'queued' }];
    const { lastFrame } = render(<TaskDetail task={task} animFrame={0} dependents={dependents} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Dependencies');
    expect(frame).toContain('Blocks');
    expect(frame).toContain('queued');
  });

  it('hides Dependencies section when both arrays are empty', () => {
    const task = makeTask();
    const { lastFrame } = render(<TaskDetail task={task} animFrame={0} dependencies={[]} dependents={[]} />);
    expect(lastFrame()).not.toContain('Dependencies');
  });

  it('hides Dependencies section when props are undefined', () => {
    const task = makeTask();
    const { lastFrame } = render(<TaskDetail task={task} animFrame={0} />);
    expect(lastFrame()).not.toContain('Dependencies');
  });

  it('shows Usage section when usage data has tokens', () => {
    const task = makeTask();
    const usage: TaskUsage = {
      taskId: task.id,
      inputTokens: 45_000,
      outputTokens: 12_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 890_000,
      totalCostUsd: 0.23,
    };
    const { lastFrame } = render(<TaskDetail task={task} animFrame={0} usage={usage} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Usage');
    expect(frame).toContain('In:');
    expect(frame).toContain('Out:');
    expect(frame).toContain('$0.23');
  });

  it('hides Usage section when usage is undefined', () => {
    const task = makeTask();
    const { lastFrame } = render(<TaskDetail task={task} animFrame={0} />);
    expect(lastFrame()).not.toContain('Usage');
  });

  it('hides Usage section when all zeros', () => {
    const task = makeTask();
    const usage: TaskUsage = {
      taskId: task.id,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalCostUsd: 0,
    };
    const { lastFrame } = render(<TaskDetail task={task} animFrame={0} usage={usage} />);
    expect(lastFrame()).not.toContain('Usage');
  });
});

// ============================================================================
// Phase C: LoopDetail enhancements — eval config, best score highlight
// ============================================================================

describe('LoopDetail — Phase C enhancements', () => {
  it('shows evalType when present', () => {
    const loop = makeLoop({ evalType: 'judge' as Loop['evalType'] });
    const { lastFrame } = render(<LoopDetail loop={loop} iterations={undefined} scrollOffset={0} animFrame={0} />);
    expect(lastFrame()).toContain('judge');
    expect(lastFrame()).toContain('Eval Type');
  });

  it('shows judgeAgent when present', () => {
    const loop = makeLoop({ judgeAgent: 'claude' as Loop['judgeAgent'] });
    const { lastFrame } = render(<LoopDetail loop={loop} iterations={undefined} scrollOffset={0} animFrame={0} />);
    expect(lastFrame()).toContain('Judge Agent');
    expect(lastFrame()).toContain('claude');
  });

  it('shows judgePrompt as LongField when present', () => {
    const loop = makeLoop({ judgePrompt: 'Rate the quality of this implementation from 1-10.' });
    const { lastFrame } = render(<LoopDetail loop={loop} iterations={undefined} scrollOffset={0} animFrame={0} />);
    expect(lastFrame()).toContain('Judge Prompt');
    expect(lastFrame()).toContain('Rate the quality');
  });

  it('hides eval config fields when absent', () => {
    const loop = makeLoop({ evalType: undefined, judgeAgent: undefined, judgePrompt: undefined });
    const { lastFrame } = render(<LoopDetail loop={loop} iterations={undefined} scrollOffset={0} animFrame={0} />);
    expect(lastFrame()).not.toContain('Eval Type');
    expect(lastFrame()).not.toContain('Judge Agent');
    expect(lastFrame()).not.toContain('Judge Prompt');
  });

  it('renders iteration with gitDiffSummary below the row', () => {
    const loop = makeLoop({ bestIterationId: undefined });
    const iter = makeLoopIteration({ iterationNumber: 1, gitDiffSummary: '3 files changed, 42 insertions(+)' });
    const { lastFrame } = render(<LoopDetail loop={loop} iterations={[iter]} scrollOffset={0} animFrame={0} />);
    expect(lastFrame()).toContain('3 files changed');
  });
});

// ============================================================================
// Phase C: ScheduleDetail enhancements — pipeline steps section
// ============================================================================

describe('ScheduleDetail — Phase C pipeline steps', () => {
  it('shows Pipeline Steps section when pipelineSteps present', () => {
    const schedule = makeSchedule({
      pipelineSteps: [
        { prompt: 'Setup database migrations', priority: undefined } as unknown as Schedule['pipelineSteps'][0],
        { prompt: 'Generate API endpoints', priority: undefined } as unknown as Schedule['pipelineSteps'][0],
      ],
    });
    const { lastFrame } = render(
      <ScheduleDetail schedule={schedule} executions={undefined} scrollOffset={0} animFrame={0} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Pipeline Steps');
    expect(frame).toContain('Setup database migrations');
    expect(frame).toContain('Generate API endpoints');
    expect(frame).toContain('1.');
    expect(frame).toContain('2.');
  });

  it('hides Pipeline Steps section when pipelineSteps is absent', () => {
    const schedule = makeSchedule({ pipelineSteps: undefined });
    const { lastFrame } = render(
      <ScheduleDetail schedule={schedule} executions={undefined} scrollOffset={0} animFrame={0} />,
    );
    expect(lastFrame()).not.toContain('Pipeline Steps');
  });
});

// ============================================================================
// Phase C: OrchestrationDetail enhancements — progress indicators
// ============================================================================

describe('OrchestrationDetail — Phase C progress indicators', () => {
  it('shows progress section when orchestration has workers limit', () => {
    const orch = makeOrchestration({ maxWorkers: 4, maxDepth: 0, maxIterations: 0 });
    const children = [
      {
        taskId: 'task-run-1' as TaskId,
        kind: 'direct',
        status: 'running',
        prompt: 'p1',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        agent: undefined,
      },
      {
        taskId: 'task-run-2' as TaskId,
        kind: 'direct',
        status: 'running',
        prompt: 'p2',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        agent: undefined,
      },
      {
        taskId: 'task-done-1' as TaskId,
        kind: 'direct',
        status: 'completed',
        prompt: 'p3',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        agent: undefined,
      },
    ];
    const { lastFrame } = render(<OrchestrationDetail orchestration={orch} animFrame={0} children={children} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Progress');
    expect(frame).toContain('Workers');
    expect(frame).toContain('2/4');
  });

  it('shows children count in progress section', () => {
    const orch = makeOrchestration({ maxWorkers: 0, maxDepth: 0, maxIterations: 0 });
    const { lastFrame } = render(
      <OrchestrationDetail orchestration={orch} animFrame={0} children={[]} childrenTotal={42} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Progress');
    expect(frame).toContain('42');
  });
});

// ============================================================================
// Step 9: ProgressBar component
// ============================================================================

import { ProgressBar } from '../../../../src/cli/dashboard/components/progress-bar.js';
import { PipelineDetail } from '../../../../src/cli/dashboard/views/pipeline-detail.js';

describe('ProgressBar', () => {
  it('renders nothing when steps is empty', () => {
    const { lastFrame } = render(<ProgressBar steps={[]} width={40} />);
    expect(lastFrame() ?? '').toBe('');
  });

  it('shows completed count and total', () => {
    const steps = [
      { status: 'completed' as const },
      { status: 'completed' as const },
      { status: 'running' as const },
      { status: 'pending' as const },
      { status: 'pending' as const },
    ];
    const { lastFrame } = render(<ProgressBar steps={steps} width={40} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('2/5');
    expect(frame).toContain('running');
  });

  it('shows failed count when any step has failed status', () => {
    const steps = [{ status: 'completed' as const }, { status: 'failed' as const }, { status: 'pending' as const }];
    const { lastFrame } = render(<ProgressBar steps={steps} width={30} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('failed');
    expect(frame).toContain('1/3');
  });

  it('shows all completed when all steps complete', () => {
    const steps = [{ status: 'completed' as const }, { status: 'completed' as const }];
    const { lastFrame } = render(<ProgressBar steps={steps} width={20} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('2/2');
  });

  it('renders block characters', () => {
    const steps = [{ status: 'completed' as const }, { status: 'running' as const }, { status: 'pending' as const }];
    const { lastFrame } = render(<ProgressBar steps={steps} width={30} />);
    const frame = lastFrame() ?? '';
    // Should contain at least one block character
    expect(frame).toMatch(/[█▓▒░]/);
  });
});

// ============================================================================
// Step 9: PipelineDetail view
// ============================================================================

function makePipeline(overrides: Partial<Pipeline> = {}): Pipeline {
  return {
    id: 'pipeline-test-001' as PipelineId,
    steps: [
      { index: 0, prompt: 'Setup database migrations' },
      { index: 1, prompt: 'Generate API endpoints' },
      { index: 2, prompt: 'Write integration tests' },
    ],
    stepTaskIds: [null, null, null],
    status: PipelineStatus.PENDING as unknown as Pipeline['status'],
    priority: 'normal' as Pipeline['priority'],
    createdAt: Date.now() - 120_000,
    updatedAt: Date.now() - 60_000,
    ...overrides,
  } as unknown as Pipeline;
}

describe('PipelineDetail', () => {
  it('shows pipeline ID', () => {
    const pipeline = makePipeline();
    const { lastFrame } = render(
      <PipelineDetail pipeline={pipeline} stepTasks={[null, null, null]} scrollOffset={0} animFrame={0} />,
    );
    expect(lastFrame()).toContain('pipeline-test-001');
  });

  it('shows Pipeline Detail header', () => {
    const pipeline = makePipeline();
    const { lastFrame } = render(
      <PipelineDetail pipeline={pipeline} stepTasks={[null, null, null]} scrollOffset={0} animFrame={0} />,
    );
    expect(lastFrame()).toContain('Pipeline Detail');
  });

  it('shows stages section with step count', () => {
    const pipeline = makePipeline();
    const { lastFrame } = render(
      <PipelineDetail pipeline={pipeline} stepTasks={[null, null, null]} scrollOffset={0} animFrame={0} />,
    );
    expect(lastFrame()).toContain('Stages');
    expect(lastFrame()).toContain('3 total');
  });

  it('shows progress bar with step statuses', () => {
    const pipeline = makePipeline({
      steps: [
        { index: 0, prompt: 'Step 1' },
        { index: 1, prompt: 'Step 2' },
      ],
      stepTaskIds: ['task-done' as TaskId, null],
    });
    const doneTask = makeTask({ id: 'task-done' as Task['id'], status: TaskStatus.COMPLETED });
    const { lastFrame } = render(
      <PipelineDetail pipeline={pipeline} stepTasks={[doneTask, null]} scrollOffset={0} animFrame={0} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('1/2');
  });

  it('shows step prompts in stage list', () => {
    const pipeline = makePipeline();
    const { lastFrame } = render(
      <PipelineDetail pipeline={pipeline} stepTasks={[null, null, null]} scrollOffset={0} animFrame={0} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Setup database');
  });

  it('shows schedule source when pipeline has scheduleId', () => {
    const pipeline = makePipeline({ scheduleId: 'schedule-parent-123' as Pipeline['scheduleId'] });
    const { lastFrame } = render(
      <PipelineDetail pipeline={pipeline} stepTasks={[null, null, null]} scrollOffset={0} animFrame={0} />,
    );
    expect(lastFrame()).toContain('schedule-parent-123');
  });

  it('shows loop source when pipeline has loopId', () => {
    const pipeline = makePipeline({ loopId: 'loop-parent-456' as Pipeline['loopId'] });
    const { lastFrame } = render(
      <PipelineDetail pipeline={pipeline} stepTasks={[null, null, null]} scrollOffset={0} animFrame={0} />,
    );
    expect(lastFrame()).toContain('loop-parent-456');
  });
});

// ============================================================================
// Step 9: DetailView dispatcher — pipelines route
// ============================================================================

describe('DetailView — pipeline dispatch', () => {
  it('shows NotFound when pipeline entity is not in data', () => {
    const data = makeDashboardData({ pipelines: [] });
    const { lastFrame } = render(
      <DetailView entityType="pipelines" entityId="pipeline-missing" data={data} scrollOffset={0} animFrame={0} />,
    );
    expect(lastFrame()).toContain('Entity not found');
  });

  it('dispatches to PipelineDetail for pipelines entityType', () => {
    const pipeline = makePipeline();
    const data = makeDashboardData({ pipelines: [pipeline as unknown as Pipeline] });
    const { lastFrame } = render(
      <DetailView entityType="pipelines" entityId={pipeline.id} data={data} scrollOffset={0} animFrame={0} />,
    );
    expect(lastFrame()).toContain('Pipeline Detail');
  });

  it('resolves step tasks from data.tasks by stepTaskIds', () => {
    const task = makeTask({ id: 'task-step-001' as Task['id'], status: TaskStatus.COMPLETED });
    const pipeline = makePipeline({
      steps: [{ index: 0, prompt: 'Step with task' }],
      stepTaskIds: [task.id],
    });
    const data = makeDashboardData({
      pipelines: [pipeline as unknown as Pipeline],
      tasks: [task],
    });
    const { lastFrame } = render(
      <DetailView entityType="pipelines" entityId={pipeline.id} data={data} scrollOffset={0} animFrame={0} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Pipeline Detail');
    // Should show 1/1 steps completed in progress bar
    expect(frame).toContain('1/1');
  });
});
