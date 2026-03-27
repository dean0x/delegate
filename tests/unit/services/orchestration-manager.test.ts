/**
 * Unit tests for OrchestrationManagerService
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

import { OrchestratorId, OrchestratorStatus } from '../../../src/core/domain.js';
import { Database } from '../../../src/implementations/database.js';
import { SQLiteLoopRepository } from '../../../src/implementations/loop-repository.js';
import { SQLiteOrchestrationRepository } from '../../../src/implementations/orchestration-repository.js';
import { LoopManagerService } from '../../../src/services/loop-manager.js';
import { OrchestrationManagerService } from '../../../src/services/orchestration-manager.js';
import { createTestConfiguration } from '../../fixtures/factories.js';
import { TestEventBus, TestLogger } from '../../fixtures/test-doubles.js';

describe('OrchestrationManagerService - Unit Tests', () => {
  let db: Database;
  let loopRepo: SQLiteLoopRepository;
  let orchestrationRepo: SQLiteOrchestrationRepository;
  let eventBus: TestEventBus;
  let logger: TestLogger;
  let loopService: LoopManagerService;
  let service: OrchestrationManagerService;
  const config = createTestConfiguration({ defaultAgent: 'claude' });

  beforeEach(() => {
    db = new Database(':memory:');
    loopRepo = new SQLiteLoopRepository(db);
    orchestrationRepo = new SQLiteOrchestrationRepository(db);
    eventBus = new TestEventBus();
    logger = new TestLogger();
    loopService = new LoopManagerService(eventBus, logger, loopRepo, config);
    service = new OrchestrationManagerService({ eventBus, logger, orchestrationRepo, loopService, config });

    // Simulate LoopHandler: persist loop on LoopCreated event
    // ARCHITECTURE: In production, LoopHandler saves the loop to DB on LoopCreated.
    // In unit tests, we simulate this behavior to enable orchestration creation.
    eventBus.subscribe('LoopCreated', async (event: Record<string, unknown>) => {
      const loop = (event as { loop: Parameters<typeof loopRepo.save>[0] }).loop;
      if (loop) {
        await loopRepo.save(loop);
      }
    });
  });

  afterEach(() => {
    eventBus.dispose();
    db.close();
  });

  describe('createOrchestration()', () => {
    it('should create orchestration with loop and state file', async () => {
      const result = await service.createOrchestration({
        goal: 'Build the auth system',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const orch = result.value;
      expect(orch.id).toMatch(/^orchestrator-/);
      expect(orch.goal).toBe('Build the auth system');
      expect(orch.status).toBe(OrchestratorStatus.RUNNING);
      expect(orch.loopId).toBeDefined();
      expect(orch.stateFilePath).toContain('.autobeat');
      expect(orch.maxDepth).toBe(3);
      expect(orch.maxWorkers).toBe(5);
      expect(orch.maxIterations).toBe(50);
    });

    it('should create loop with correct configuration', async () => {
      const result = await service.createOrchestration({
        goal: 'Build auth',
        maxIterations: 20,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Verify the LoopCreated event was emitted
      const loopEvents = eventBus.getEmittedEvents('LoopCreated');
      expect(loopEvents.length).toBe(1);
    });

    it('should emit OrchestrationCreated event', async () => {
      const result = await service.createOrchestration({ goal: 'Test goal' });

      expect(result.ok).toBe(true);
      const events = eventBus.getEmittedEvents('OrchestrationCreated');
      expect(events.length).toBe(1);
    });

    it('should reject empty goal', async () => {
      const result = await service.createOrchestration({ goal: '' });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('goal is required');
    });

    it('should reject goal exceeding 8000 characters', async () => {
      const result = await service.createOrchestration({ goal: 'x'.repeat(8001) });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('8000 characters');
    });

    it('should use custom maxDepth and maxWorkers', async () => {
      const result = await service.createOrchestration({
        goal: 'Custom config',
        maxDepth: 7,
        maxWorkers: 15,
        maxIterations: 100,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.maxDepth).toBe(7);
      expect(result.value.maxWorkers).toBe(15);
      expect(result.value.maxIterations).toBe(100);
    });
  });

  describe('getOrchestration()', () => {
    it('should retrieve an existing orchestration', async () => {
      const createResult = await service.createOrchestration({ goal: 'Test' });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const getResult = await service.getOrchestration(createResult.value.id);
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;
      expect(getResult.value.id).toBe(createResult.value.id);
    });

    it('should return error for non-existent orchestration', async () => {
      const result = await service.getOrchestration(OrchestratorId('orchestrator-nonexistent'));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('not found');
    });
  });

  describe('listOrchestrations()', () => {
    it('should list all orchestrations', async () => {
      await service.createOrchestration({ goal: 'Goal 1' });
      await service.createOrchestration({ goal: 'Goal 2' });

      const result = await service.listOrchestrations();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(2);
    });

    it('should filter by status', async () => {
      await service.createOrchestration({ goal: 'Running' });

      const result = await service.listOrchestrations(OrchestratorStatus.RUNNING);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(1);
    });
  });

  describe('cancelOrchestration()', () => {
    it('should cancel a running orchestration', async () => {
      const createResult = await service.createOrchestration({ goal: 'To cancel' });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const cancelResult = await service.cancelOrchestration(createResult.value.id, 'No longer needed');
      expect(cancelResult.ok).toBe(true);

      // Should emit OrchestrationCancelled event
      const events = eventBus.getEmittedEvents('OrchestrationCancelled');
      expect(events.length).toBe(1);
    });

    it('should reject cancelling a completed orchestration', async () => {
      const createResult = await service.createOrchestration({ goal: 'Already done' });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      // Manually mark as completed
      const orch = createResult.value;
      const { updateOrchestration } = await import('../../../src/core/domain.js');
      const completed = updateOrchestration(orch, {
        status: OrchestratorStatus.COMPLETED,
        completedAt: Date.now(),
      });
      await orchestrationRepo.update(completed);

      const cancelResult = await service.cancelOrchestration(orch.id);
      expect(cancelResult.ok).toBe(false);
      if (cancelResult.ok) return;
      expect(cancelResult.error.message).toContain('not active');
    });
  });
});
