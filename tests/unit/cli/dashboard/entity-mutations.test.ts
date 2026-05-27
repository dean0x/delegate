/**
 * Tests for cancelEntity, pauseOrResumeEntity, and deleteEntity dispatch functions.
 * Pattern: Each test verifies the correct service/repo method is called based on entity kind and status.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  cancelEntity,
  deleteEntity,
  pauseOrResumeEntity,
} from '../../../../src/cli/dashboard/keyboard/entity-mutations.js';
import type { DashboardMutationContext } from '../../../../src/cli/dashboard/types.js';
import { ChannelStatus, LoopStatus, ScheduleStatus } from '../../../../src/core/domain.js';
import { ok } from '../../../../src/core/result.js';

function makeChannelService(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    destroyChannel: vi.fn().mockResolvedValue(ok(undefined)),
    pauseChannel: vi.fn().mockResolvedValue(ok(undefined)),
    resumeChannel: vi.fn().mockResolvedValue(ok(undefined)),
    ...overrides,
  };
}

function makeChannelRepo(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    delete: vi.fn().mockResolvedValue(ok(undefined)),
    ...overrides,
  };
}

function makeMutations(overrides: Partial<Record<string, unknown>> = {}): DashboardMutationContext {
  return {
    orchestrationService: {} as DashboardMutationContext['orchestrationService'],
    loopService: {
      pauseLoop: vi.fn().mockResolvedValue(ok(undefined)),
      resumeLoop: vi.fn().mockResolvedValue(ok(undefined)),
      cancelLoop: vi.fn().mockResolvedValue(ok(undefined)),
    } as unknown as DashboardMutationContext['loopService'],
    scheduleService: {
      pauseSchedule: vi.fn().mockResolvedValue(ok(undefined)),
      resumeSchedule: vi.fn().mockResolvedValue(ok(undefined)),
      cancelSchedule: vi.fn().mockResolvedValue(ok(undefined)),
    } as unknown as DashboardMutationContext['scheduleService'],
    taskManager: {} as DashboardMutationContext['taskManager'],
    orchestrationRepo: {} as DashboardMutationContext['orchestrationRepo'],
    loopRepo: {} as DashboardMutationContext['loopRepo'],
    taskRepo: {} as DashboardMutationContext['taskRepo'],
    scheduleRepo: {} as DashboardMutationContext['scheduleRepo'],
    ...overrides,
  } as DashboardMutationContext;
}

describe('pauseOrResumeEntity', () => {
  it('pauses active schedule', async () => {
    const mutations = makeMutations();
    const refreshNow = vi.fn();
    await pauseOrResumeEntity('schedule', 'sched-1', ScheduleStatus.ACTIVE, mutations, refreshNow);
    expect(mutations.scheduleService.pauseSchedule).toHaveBeenCalledWith('sched-1');
    expect(refreshNow).toHaveBeenCalled();
  });

  it('resumes paused schedule', async () => {
    const mutations = makeMutations();
    const refreshNow = vi.fn();
    await pauseOrResumeEntity('schedule', 'sched-2', ScheduleStatus.PAUSED, mutations, refreshNow);
    expect(mutations.scheduleService.resumeSchedule).toHaveBeenCalledWith('sched-2');
    expect(refreshNow).toHaveBeenCalled();
  });

  it('skips terminal schedule (no service call, no refresh)', async () => {
    const mutations = makeMutations();
    const refreshNow = vi.fn();
    await pauseOrResumeEntity('schedule', 'sched-3', ScheduleStatus.COMPLETED, mutations, refreshNow);
    expect(mutations.scheduleService.pauseSchedule).not.toHaveBeenCalled();
    expect(mutations.scheduleService.resumeSchedule).not.toHaveBeenCalled();
    expect(refreshNow).not.toHaveBeenCalled();
  });

  it('pauses running loop', async () => {
    const mutations = makeMutations();
    const refreshNow = vi.fn();
    await pauseOrResumeEntity('loop', 'loop-1', LoopStatus.RUNNING, mutations, refreshNow);
    expect(mutations.loopService.pauseLoop).toHaveBeenCalledWith('loop-1');
    expect(refreshNow).toHaveBeenCalled();
  });

  it('resumes paused loop', async () => {
    const mutations = makeMutations();
    const refreshNow = vi.fn();
    await pauseOrResumeEntity('loop', 'loop-2', LoopStatus.PAUSED, mutations, refreshNow);
    expect(mutations.loopService.resumeLoop).toHaveBeenCalledWith('loop-2');
    expect(refreshNow).toHaveBeenCalled();
  });

  it('skips terminal loop (no service call, no refresh)', async () => {
    const mutations = makeMutations();
    const refreshNow = vi.fn();
    await pauseOrResumeEntity('loop', 'loop-3', LoopStatus.FAILED, mutations, refreshNow);
    expect(mutations.loopService.pauseLoop).not.toHaveBeenCalled();
    expect(mutations.loopService.resumeLoop).not.toHaveBeenCalled();
    expect(refreshNow).not.toHaveBeenCalled();
  });

  it('skips non-pauseable entity kind (task)', async () => {
    const mutations = makeMutations();
    const refreshNow = vi.fn();
    await pauseOrResumeEntity('task', 'task-1', 'running', mutations, refreshNow);
    expect(refreshNow).not.toHaveBeenCalled();
  });

  it('skips non-pauseable entity kind (orchestration)', async () => {
    const mutations = makeMutations();
    const refreshNow = vi.fn();
    await pauseOrResumeEntity('orchestration', 'orch-1', 'running', mutations, refreshNow);
    expect(refreshNow).not.toHaveBeenCalled();
  });

  it('swallows service errors without crashing', async () => {
    const mutations = makeMutations({
      scheduleService: {
        pauseSchedule: vi.fn().mockRejectedValue(new Error('DB error')),
        resumeSchedule: vi.fn(),
        cancelSchedule: vi.fn(),
      },
    });
    const refreshNow = vi.fn();
    await expect(
      pauseOrResumeEntity(
        'schedule',
        'sched-err',
        ScheduleStatus.ACTIVE,
        mutations as DashboardMutationContext,
        refreshNow,
      ),
    ).resolves.toBeUndefined();
    expect(refreshNow).not.toHaveBeenCalled();
  });

  it('pauses active channel', async () => {
    const channelService = makeChannelService();
    const mutations = makeMutations({ channelService });
    const refreshNow = vi.fn();
    await pauseOrResumeEntity('channel', 'chan-1', ChannelStatus.ACTIVE, mutations, refreshNow);
    expect(channelService.pauseChannel).toHaveBeenCalledWith('chan-1');
    expect(refreshNow).toHaveBeenCalled();
  });

  it('resumes paused channel', async () => {
    const channelService = makeChannelService();
    const mutations = makeMutations({ channelService });
    const refreshNow = vi.fn();
    await pauseOrResumeEntity('channel', 'chan-2', ChannelStatus.PAUSED, mutations, refreshNow);
    expect(channelService.resumeChannel).toHaveBeenCalledWith('chan-2');
    expect(refreshNow).toHaveBeenCalled();
  });

  it('skips channel pause/resume when terminal (destroyed)', async () => {
    const channelService = makeChannelService();
    const mutations = makeMutations({ channelService });
    const refreshNow = vi.fn();
    await pauseOrResumeEntity('channel', 'chan-3', ChannelStatus.DESTROYED, mutations, refreshNow);
    expect(channelService.pauseChannel).not.toHaveBeenCalled();
    expect(channelService.resumeChannel).not.toHaveBeenCalled();
    expect(refreshNow).not.toHaveBeenCalled();
  });

  it('skips channel pause/resume when channelService is absent', async () => {
    const mutations = makeMutations({ channelService: undefined });
    const refreshNow = vi.fn();
    await pauseOrResumeEntity('channel', 'chan-4', ChannelStatus.ACTIVE, mutations, refreshNow);
    expect(refreshNow).not.toHaveBeenCalled();
  });
});

describe('cancelEntity (channel)', () => {
  it('destroys active channel', async () => {
    const channelService = makeChannelService();
    const mutations = makeMutations({ channelService });
    const refreshNow = vi.fn();
    await cancelEntity('channel', 'chan-1', ChannelStatus.ACTIVE, mutations, refreshNow);
    expect(channelService.destroyChannel).toHaveBeenCalledWith('chan-1', 'user-requested');
    expect(refreshNow).toHaveBeenCalled();
  });

  it('is no-op when channel is already destroyed (terminal)', async () => {
    const channelService = makeChannelService();
    const mutations = makeMutations({ channelService });
    const refreshNow = vi.fn();
    await cancelEntity('channel', 'chan-2', ChannelStatus.DESTROYED, mutations, refreshNow);
    expect(channelService.destroyChannel).not.toHaveBeenCalled();
    expect(refreshNow).not.toHaveBeenCalled();
  });

  it('is no-op when channel is already completed (terminal)', async () => {
    const channelService = makeChannelService();
    const mutations = makeMutations({ channelService });
    const refreshNow = vi.fn();
    await cancelEntity('channel', 'chan-3', ChannelStatus.COMPLETED, mutations, refreshNow);
    expect(channelService.destroyChannel).not.toHaveBeenCalled();
    expect(refreshNow).not.toHaveBeenCalled();
  });

  it('is no-op when channelService is absent', async () => {
    const mutations = makeMutations({ channelService: undefined });
    const refreshNow = vi.fn();
    await cancelEntity('channel', 'chan-4', ChannelStatus.ACTIVE, mutations, refreshNow);
    expect(refreshNow).not.toHaveBeenCalled();
  });

  it('swallows service errors without crashing', async () => {
    const mutations = makeMutations({
      channelService: makeChannelService({
        destroyChannel: vi.fn().mockRejectedValue(new Error('channel service unavailable')),
      }),
    });
    const refreshNow = vi.fn();
    await expect(
      cancelEntity('channel', 'chan-err', ChannelStatus.ACTIVE, mutations, refreshNow),
    ).resolves.toBeUndefined();
    expect(refreshNow).not.toHaveBeenCalled();
  });
});

describe('deleteEntity (channel)', () => {
  it('deletes a destroyed channel', async () => {
    const channelRepo = makeChannelRepo();
    const mutations = makeMutations({ channelRepo });
    const refreshNow = vi.fn();
    await deleteEntity('channel', 'chan-1', ChannelStatus.DESTROYED, mutations, refreshNow);
    expect(channelRepo.delete).toHaveBeenCalledWith('chan-1');
    expect(refreshNow).toHaveBeenCalled();
  });

  it('deletes a completed channel', async () => {
    const channelRepo = makeChannelRepo();
    const mutations = makeMutations({ channelRepo });
    const refreshNow = vi.fn();
    await deleteEntity('channel', 'chan-2', ChannelStatus.COMPLETED, mutations, refreshNow);
    expect(channelRepo.delete).toHaveBeenCalledWith('chan-2');
    expect(refreshNow).toHaveBeenCalled();
  });

  it('is no-op when channel is non-terminal (active)', async () => {
    const channelRepo = makeChannelRepo();
    const mutations = makeMutations({ channelRepo });
    const refreshNow = vi.fn();
    await deleteEntity('channel', 'chan-3', ChannelStatus.ACTIVE, mutations, refreshNow);
    expect(channelRepo.delete).not.toHaveBeenCalled();
    expect(refreshNow).not.toHaveBeenCalled();
  });

  it('is no-op when channelRepo is absent', async () => {
    const mutations = makeMutations({ channelRepo: undefined });
    const refreshNow = vi.fn();
    await deleteEntity('channel', 'chan-4', ChannelStatus.DESTROYED, mutations, refreshNow);
    expect(refreshNow).not.toHaveBeenCalled();
  });
});
