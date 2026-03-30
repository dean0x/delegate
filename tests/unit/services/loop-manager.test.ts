/**
 * Unit tests for LoopManagerService
 * ARCHITECTURE: Tests service layer with real SQLite (in-memory) and TestEventBus
 * Pattern: Behavior-driven testing with Result pattern validation
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock git-state before importing modules that depend on it
vi.mock('../../../src/utils/git-state.js', () => ({
  captureGitState: vi.fn().mockResolvedValue({ ok: true, value: null }),
  getCurrentCommitSha: vi.fn().mockResolvedValue({ ok: true, value: 'abc1234567890abcdef1234567890abcdef123456' }),
  captureLoopGitContext: vi.fn().mockResolvedValue({ ok: true, value: {} }),
  validateGitRefName: vi.fn().mockReturnValue({ ok: true, value: undefined }),
}));

import type { Loop, LoopCreateRequest } from '../../../src/core/domain.js';
import { createLoop, LoopId, LoopStatus, LoopStrategy, OptimizeDirection } from '../../../src/core/domain.js';
import type { Result } from '../../../src/core/result.js';
import { Database } from '../../../src/implementations/database.js';
import { SQLiteLoopRepository } from '../../../src/implementations/loop-repository.js';
import { LoopManagerService } from '../../../src/services/loop-manager.js';
import { toOptimizeDirection } from '../../../src/utils/format.js';
import { captureGitState, captureLoopGitContext } from '../../../src/utils/git-state.js';
import { createTestConfiguration } from '../../fixtures/factories.js';
import { TestEventBus, TestLogger } from '../../fixtures/test-doubles.js';

describe('LoopManagerService - Unit Tests', () => {
  let db: Database;
  let loopRepo: SQLiteLoopRepository;
  let eventBus: TestEventBus;
  let logger: TestLogger;
  let service: LoopManagerService;

  beforeEach(() => {
    db = new Database(':memory:');
    loopRepo = new SQLiteLoopRepository(db);
    eventBus = new TestEventBus();
    logger = new TestLogger();
    service = new LoopManagerService(eventBus, logger, loopRepo, createTestConfiguration());
  });

  afterEach(() => {
    eventBus.dispose();
    db.close();
  });

  // Helper: create a valid retry loop request
  function retryRequest(overrides: Partial<LoopCreateRequest> = {}): LoopCreateRequest {
    return {
      prompt: 'Fix the failing tests',
      strategy: LoopStrategy.RETRY,
      exitCondition: 'npm test',
      maxIterations: 10,
      maxConsecutiveFailures: 3,
      ...overrides,
    };
  }

  // Helper: create a valid optimize loop request
  function optimizeRequest(overrides: Partial<LoopCreateRequest> = {}): LoopCreateRequest {
    return {
      prompt: 'Optimize the build time',
      strategy: LoopStrategy.OPTIMIZE,
      exitCondition: 'echo 42',
      evalDirection: OptimizeDirection.MINIMIZE,
      maxIterations: 10,
      maxConsecutiveFailures: 3,
      ...overrides,
    };
  }

  describe('toOptimizeDirection()', () => {
    it('should map "minimize" to MINIMIZE', () => {
      expect(toOptimizeDirection('minimize')).toBe(OptimizeDirection.MINIMIZE);
    });

    it('should map "maximize" to MAXIMIZE', () => {
      expect(toOptimizeDirection('maximize')).toBe(OptimizeDirection.MAXIMIZE);
    });

    it('should return undefined for unrecognized values', () => {
      expect(toOptimizeDirection('invalid')).toBeUndefined();
      expect(toOptimizeDirection(undefined)).toBeUndefined();
    });
  });

  describe('createLoop() - retry strategy', () => {
    it('should create a retry loop and emit LoopCreated event', async () => {
      const result = await service.createLoop(retryRequest());

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const loop = result.value;
      expect(loop.strategy).toBe(LoopStrategy.RETRY);
      expect(loop.exitCondition).toBe('npm test');
      expect(loop.status).toBe(LoopStatus.RUNNING);
      expect(loop.maxIterations).toBe(10);
      expect(loop.currentIteration).toBe(0);
      expect(loop.consecutiveFailures).toBe(0);

      // Verify event was emitted
      expect(eventBus.hasEmitted('LoopCreated')).toBe(true);
    });

    it('should use default values for optional fields', async () => {
      const result = await service.createLoop({
        prompt: 'test',
        strategy: LoopStrategy.RETRY,
        exitCondition: 'test -f /tmp/done',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const loop = result.value;
      expect(loop.maxIterations).toBe(10);
      expect(loop.maxConsecutiveFailures).toBe(3);
      expect(loop.cooldownMs).toBe(0);
      expect(loop.freshContext).toBe(true);
      expect(loop.evalTimeout).toBe(60000);
    });
  });

  describe('createLoop() - optimize strategy', () => {
    it('should create an optimize loop with evalDirection', async () => {
      const result = await service.createLoop(optimizeRequest());

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const loop = result.value;
      expect(loop.strategy).toBe(LoopStrategy.OPTIMIZE);
      expect(loop.evalDirection).toBe(OptimizeDirection.MINIMIZE);
    });

    it('should return error when evalDirection missing for optimize strategy', async () => {
      const result = await service.createLoop(optimizeRequest({ evalDirection: undefined }));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('evalDirection is required');
    });
  });

  describe('createLoop() - validation errors', () => {
    it('should return error when prompt is missing for non-pipeline loop', async () => {
      const result = await service.createLoop(retryRequest({ prompt: undefined }));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('prompt is required');
    });

    it('should return error when prompt is empty string', async () => {
      const result = await service.createLoop(retryRequest({ prompt: '   ' }));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('prompt is required');
    });

    it('should return error when exitCondition is missing', async () => {
      const result = await service.createLoop(retryRequest({ exitCondition: '' }));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('exitCondition is required');
    });

    it('should return error when evalDirection provided with retry strategy', async () => {
      const result = await service.createLoop(retryRequest({ evalDirection: OptimizeDirection.MAXIMIZE }));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('not allowed for retry');
    });

    it('should return error when maxIterations is negative', async () => {
      const result = await service.createLoop(retryRequest({ maxIterations: -1 }));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('maxIterations');
    });

    it('should return error when evalTimeout is less than 1000', async () => {
      const result = await service.createLoop(retryRequest({ evalTimeout: 500 }));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('evalTimeout');
    });

    it('should return error when pipelineSteps has fewer than 2 steps', async () => {
      const result = await service.createLoop(retryRequest({ pipelineSteps: ['only one step'] }));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('at least 2 steps');
    });

    it('should return error when pipelineSteps has more than 20 steps', async () => {
      const steps = Array.from({ length: 21 }, (_, i) => `step ${i + 1}`);
      const result = await service.createLoop(retryRequest({ pipelineSteps: steps }));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('cannot exceed 20');
    });

    it('should allow pipeline mode without prompt', async () => {
      const result = await service.createLoop(
        retryRequest({
          prompt: undefined,
          pipelineSteps: ['lint the code', 'run the tests'],
        }),
      );

      expect(result.ok).toBe(true);
    });
  });

  describe('createLoop() - agent eval mode', () => {
    it('should create a retry loop with agent eval mode (no exitCondition required)', async () => {
      const result = await service.createLoop({
        prompt: 'Improve the code',
        strategy: LoopStrategy.RETRY,
        evalMode: 'agent',
        maxIterations: 5,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.evalMode).toBe('agent');
      expect(result.value.strategy).toBe(LoopStrategy.RETRY);
    });

    it('should create an optimize loop with agent eval mode', async () => {
      const result = await service.createLoop({
        prompt: 'Improve code quality score',
        strategy: LoopStrategy.OPTIMIZE,
        evalMode: 'agent',
        evalDirection: OptimizeDirection.MAXIMIZE,
        maxIterations: 5,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.evalMode).toBe('agent');
      expect(result.value.strategy).toBe(LoopStrategy.OPTIMIZE);
    });

    it('should store evalPrompt when provided with agent eval mode', async () => {
      const customPrompt = 'Check test coverage is above 80%.';
      const result = await service.createLoop({
        prompt: 'Write more tests',
        strategy: LoopStrategy.RETRY,
        evalMode: 'agent',
        evalPrompt: customPrompt,
        maxIterations: 3,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.evalPrompt).toBe(customPrompt);
    });

    it('should return error when evalPrompt provided with shell eval mode', async () => {
      const result = await service.createLoop(
        retryRequest({ evalPrompt: 'Some agent prompt' }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('evalPrompt');
    });

    it('should return error when shell mode has empty exitCondition', async () => {
      const result = await service.createLoop(retryRequest({ exitCondition: '' }));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('exitCondition is required');
    });

    it('should allow agent mode with larger evalTimeout (up to 600s)', async () => {
      const result = await service.createLoop({
        prompt: 'Complex code review',
        strategy: LoopStrategy.RETRY,
        evalMode: 'agent',
        evalTimeout: 600000,
        maxIterations: 3,
      });

      expect(result.ok).toBe(true);
    });

    it('should reject evalTimeout over 600s for agent mode', async () => {
      const result = await service.createLoop({
        prompt: 'Complex code review',
        strategy: LoopStrategy.RETRY,
        evalMode: 'agent',
        evalTimeout: 600001,
        maxIterations: 3,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('evalTimeout');
    });

    it('should reject evalTimeout over 300s for shell mode', async () => {
      const result = await service.createLoop(retryRequest({ evalTimeout: 300001 }));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('evalTimeout');
    });
  });

  // Helper: save a loop directly in the repository (bypasses event handler)
  async function saveLoopInRepo(overrides: Partial<Parameters<typeof createLoop>[0]> = {}): Promise<Loop> {
    const loop = createLoop(
      {
        prompt: 'test loop',
        strategy: LoopStrategy.RETRY,
        exitCondition: 'true',
        ...overrides,
      },
      '/tmp',
    );
    await loopRepo.save(loop);
    return loop;
  }

  describe('getLoop()', () => {
    it('should return loop without iterations by default', async () => {
      const loop = await saveLoopInRepo();

      const result = await service.getLoop(loop.id);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.loop.id).toBe(loop.id);
      expect(result.value.iterations).toBeUndefined();
    });

    it('should return loop with iterations when includeHistory is true', async () => {
      const loop = await saveLoopInRepo();

      const result = await service.getLoop(loop.id, true);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.loop.id).toBe(loop.id);
      expect(result.value.iterations).toBeDefined();
    });

    it('should return error when loop not found', async () => {
      const result = await service.getLoop(LoopId('non-existent'));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('not found');
    });
  });

  describe('listLoops()', () => {
    it('should return all loops when no status filter', async () => {
      await saveLoopInRepo();
      await saveLoopInRepo();

      const result = await service.listLoops();

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(2);
    });

    it('should filter by status', async () => {
      const loop1 = await saveLoopInRepo();
      await saveLoopInRepo();

      // Both should be running
      const runningResult = await service.listLoops(LoopStatus.RUNNING);
      expect(runningResult.ok).toBe(true);
      if (!runningResult.ok) return;
      expect(runningResult.value).toHaveLength(2);

      // None should be completed
      const completedResult = await service.listLoops(LoopStatus.COMPLETED);
      expect(completedResult.ok).toBe(true);
      if (!completedResult.ok) return;
      expect(completedResult.value).toHaveLength(0);
    });
  });

  describe('cancelLoop()', () => {
    it('should cancel a running loop and emit LoopCancelled event', async () => {
      const loop = await saveLoopInRepo();

      const cancelResult = await service.cancelLoop(loop.id, 'User requested cancellation');

      expect(cancelResult.ok).toBe(true);
      expect(eventBus.hasEmitted('LoopCancelled')).toBe(true);
    });

    it('should return error when loop not found', async () => {
      const result = await service.cancelLoop(LoopId('non-existent'));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('not found');
    });

    it('should return error when loop is already completed', async () => {
      const loop = await saveLoopInRepo();

      // Update status to completed
      const updated = { ...loop, status: LoopStatus.COMPLETED, updatedAt: Date.now() };
      await loopRepo.update(updated);

      const cancelResult = await service.cancelLoop(loop.id);

      expect(cancelResult.ok).toBe(false);
      if (cancelResult.ok) return;
      expect(cancelResult.error.message).toContain('not running');
    });

    it('should accept cancellation of a PAUSED loop', async () => {
      const loop = await saveLoopInRepo();

      // Update status to PAUSED
      const paused = { ...loop, status: LoopStatus.PAUSED, updatedAt: Date.now() };
      await loopRepo.update(paused);

      const cancelResult = await service.cancelLoop(loop.id, 'No longer needed');

      expect(cancelResult.ok).toBe(true);
      expect(eventBus.hasEmitted('LoopCancelled')).toBe(true);
    });

    it('should reject cancellation of a FAILED loop', async () => {
      const loop = await saveLoopInRepo();

      const failed = { ...loop, status: LoopStatus.FAILED, updatedAt: Date.now() };
      await loopRepo.update(failed);

      const cancelResult = await service.cancelLoop(loop.id);

      expect(cancelResult.ok).toBe(false);
      if (cancelResult.ok) return;
      expect(cancelResult.error.message).toContain('not running');
    });

    it('should reject cancellation of a CANCELLED loop', async () => {
      const loop = await saveLoopInRepo();

      const cancelled = { ...loop, status: LoopStatus.CANCELLED, updatedAt: Date.now() };
      await loopRepo.update(cancelled);

      const cancelResult = await service.cancelLoop(loop.id);

      expect(cancelResult.ok).toBe(false);
      if (cancelResult.ok) return;
      expect(cancelResult.error.message).toContain('not running');
    });
  });

  describe('pauseLoop()', () => {
    it('should pause a RUNNING loop and emit LoopPaused event', async () => {
      const loop = await saveLoopInRepo();

      const pauseResult = await service.pauseLoop(loop.id);

      expect(pauseResult.ok).toBe(true);
      expect(eventBus.hasEmitted('LoopPaused')).toBe(true);
    });

    it('should pass force option to the event', async () => {
      const loop = await saveLoopInRepo();

      const pauseResult = await service.pauseLoop(loop.id, { force: true });

      expect(pauseResult.ok).toBe(true);
      expect(eventBus.hasEmitted('LoopPaused')).toBe(true);
      const emitted = eventBus.getAllEmittedEvents().find((e) => e.type === 'LoopPaused');
      expect(emitted).toBeDefined();
      expect((emitted!.payload as { force: boolean }).force).toBe(true);
    });

    it('should reject pause of a COMPLETED loop', async () => {
      const loop = await saveLoopInRepo();

      const completed = { ...loop, status: LoopStatus.COMPLETED, updatedAt: Date.now() };
      await loopRepo.update(completed);

      const result = await service.pauseLoop(loop.id);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('not running');
    });

    it('should reject pause of a FAILED loop', async () => {
      const loop = await saveLoopInRepo();

      const failed = { ...loop, status: LoopStatus.FAILED, updatedAt: Date.now() };
      await loopRepo.update(failed);

      const result = await service.pauseLoop(loop.id);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('not running');
    });

    it('should reject pause of a CANCELLED loop', async () => {
      const loop = await saveLoopInRepo();

      const cancelled = { ...loop, status: LoopStatus.CANCELLED, updatedAt: Date.now() };
      await loopRepo.update(cancelled);

      const result = await service.pauseLoop(loop.id);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('not running');
    });

    it('should return error when loop not found', async () => {
      const result = await service.pauseLoop(LoopId('non-existent'));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('not found');
    });
  });

  describe('resumeLoop()', () => {
    it('should resume a PAUSED loop and emit LoopResumed event', async () => {
      const loop = await saveLoopInRepo();

      // Set to paused
      const paused = { ...loop, status: LoopStatus.PAUSED, updatedAt: Date.now() };
      await loopRepo.update(paused);

      const resumeResult = await service.resumeLoop(loop.id);

      expect(resumeResult.ok).toBe(true);
      expect(eventBus.hasEmitted('LoopResumed')).toBe(true);
    });

    it('should reject resume of a RUNNING loop', async () => {
      const loop = await saveLoopInRepo();

      const result = await service.resumeLoop(loop.id);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('not paused');
    });

    it('should reject resume of a COMPLETED loop', async () => {
      const loop = await saveLoopInRepo();

      const completed = { ...loop, status: LoopStatus.COMPLETED, updatedAt: Date.now() };
      await loopRepo.update(completed);

      const result = await service.resumeLoop(loop.id);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('not paused');
    });

    it('should return error when loop not found', async () => {
      const result = await service.resumeLoop(LoopId('non-existent'));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('not found');
    });
  });

  // ==========================================================================
  // v0.8.1 Git auto-capture tests
  // ==========================================================================

  describe('createLoop() - git auto-capture (v0.8.1)', () => {
    it('should auto-capture gitStartCommitSha in a git repo even without --git-branch', async () => {
      // Mock: in a git repo, no gitBranch requested
      vi.mocked(captureLoopGitContext).mockResolvedValue({
        ok: true,
        value: { gitStartCommitSha: 'start_sha_1234567890abcdef1234567890abcdef1234' },
      });

      const result = await service.createLoop(retryRequest());

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.gitStartCommitSha).toBe('start_sha_1234567890abcdef1234567890abcdef1234');
      // No gitBranch requested, so gitBaseBranch should be undefined
      expect(result.value.gitBaseBranch).toBeUndefined();
      expect(result.value.gitBranch).toBeUndefined();
    });

    it('should capture gitStartCommitSha and gitBaseBranch with --git-branch', async () => {
      // Mock: captureGitState needed for gitBranch validation (line 178 of loop-manager.ts)
      vi.mocked(captureGitState).mockResolvedValue({
        ok: true,
        value: { branch: 'main', commitSha: 'abc123', dirtyFiles: [] },
      });
      // Mock: captureLoopGitContext for the actual git context capture
      vi.mocked(captureLoopGitContext).mockResolvedValue({
        ok: true,
        value: {
          gitBaseBranch: 'main',
          gitStartCommitSha: 'start_sha_abcdef1234567890abcdef1234567890abcd',
        },
      });

      const result = await service.createLoop(retryRequest({ gitBranch: 'feat/my-loop' }));

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.gitBranch).toBe('feat/my-loop');
      expect(result.value.gitBaseBranch).toBe('main');
      expect(result.value.gitStartCommitSha).toBe('start_sha_abcdef1234567890abcdef1234567890abcd');
    });

    it('should have no git fields in a non-git repo', async () => {
      // Mock: not in a git repo (captureLoopGitContext returns empty context)
      vi.mocked(captureLoopGitContext).mockResolvedValue({ ok: true, value: {} });

      const result = await service.createLoop(retryRequest());

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.gitStartCommitSha).toBeUndefined();
      expect(result.value.gitBaseBranch).toBeUndefined();
      expect(result.value.gitBranch).toBeUndefined();
    });

    it('should have no git fields when captureLoopGitContext fails', async () => {
      // Mock: captureLoopGitContext returns error
      vi.mocked(captureLoopGitContext).mockResolvedValue({
        ok: false,
        error: new Error('git not available'),
      } as Result<{ gitBaseBranch?: string; gitStartCommitSha?: string }>);

      const result = await service.createLoop(retryRequest());

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.gitStartCommitSha).toBeUndefined();
      expect(result.value.gitBaseBranch).toBeUndefined();
    });
  });
});
