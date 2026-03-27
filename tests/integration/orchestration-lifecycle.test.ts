/**
 * Integration tests for orchestration lifecycle
 * ARCHITECTURE: Tests the full orchestration creation flow with real implementations
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock git-state before importing modules
vi.mock('../../src/utils/git-state.js', () => ({
  captureGitState: vi.fn().mockResolvedValue({ ok: true, value: null }),
  getCurrentCommitSha: vi.fn().mockResolvedValue({ ok: true, value: 'abc123' }),
  captureLoopGitContext: vi.fn().mockResolvedValue({ ok: true, value: {} }),
  validateGitRefName: vi.fn().mockReturnValue({ ok: true, value: undefined }),
}));

import { existsSync } from 'fs';
import { OrchestratorId, OrchestratorStatus } from '../../src/core/domain.js';
import { readStateFile } from '../../src/core/orchestrator-state.js';
import { Database } from '../../src/implementations/database.js';
import { SQLiteLoopRepository } from '../../src/implementations/loop-repository.js';
import { SQLiteOrchestrationRepository } from '../../src/implementations/orchestration-repository.js';
import { OrchestrationHandler } from '../../src/services/handlers/orchestration-handler.js';
import { LoopManagerService } from '../../src/services/loop-manager.js';
import { OrchestrationManagerService } from '../../src/services/orchestration-manager.js';
import { createTestConfiguration } from '../fixtures/factories.js';
import { TestEventBus, TestLogger } from '../fixtures/test-doubles.js';

describe('Orchestration Lifecycle - Integration Tests', () => {
  let db: Database;
  let loopRepo: SQLiteLoopRepository;
  let orchRepo: SQLiteOrchestrationRepository;
  let eventBus: TestEventBus;
  let logger: TestLogger;
  let loopService: LoopManagerService;
  let orchService: OrchestrationManagerService;
  const config = createTestConfiguration({ defaultAgent: 'claude' });

  beforeEach(() => {
    db = new Database(':memory:');
    loopRepo = new SQLiteLoopRepository(db);
    orchRepo = new SQLiteOrchestrationRepository(db);
    eventBus = new TestEventBus();
    logger = new TestLogger();
    loopService = new LoopManagerService(eventBus, logger, loopRepo, config);
    orchService = new OrchestrationManagerService({ eventBus, logger, orchestrationRepo: orchRepo, loopService, config });

    // Simulate LoopHandler: persist loop on LoopCreated event
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

  describe('Create orchestration -> verify loop + state file', () => {
    it('should create orchestration with associated loop and state file', async () => {
      const result = await orchService.createOrchestration({
        goal: 'Build a complete REST API',
        maxWorkers: 3,
        maxDepth: 2,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const orch = result.value;

      // Verify orchestration state
      expect(orch.status).toBe(OrchestratorStatus.RUNNING);
      expect(orch.loopId).toBeDefined();
      expect(orch.maxWorkers).toBe(3);
      expect(orch.maxDepth).toBe(2);

      // Verify state file was created
      expect(existsSync(orch.stateFilePath)).toBe(true);
      const stateResult = readStateFile(orch.stateFilePath);
      expect(stateResult.ok).toBe(true);
      if (!stateResult.ok) return;
      expect(stateResult.value.goal).toBe('Build a complete REST API');
      expect(stateResult.value.status).toBe('planning');

      // Verify loop was created
      const loopResult = await loopRepo.findById(orch.loopId!);
      expect(loopResult.ok).toBe(true);
      if (!loopResult.ok) return;
      expect(loopResult.value).not.toBeNull();
      expect(loopResult.value?.freshContext).toBe(true);
      expect(loopResult.value?.maxConsecutiveFailures).toBe(5);

      // Verify events
      const orchEvents = eventBus.getEmittedEvents('OrchestrationCreated');
      expect(orchEvents.length).toBe(1);
      const loopEvents = eventBus.getEmittedEvents('LoopCreated');
      expect(loopEvents.length).toBe(1);
    });
  });

  describe('Cancel orchestration -> verify cascade', () => {
    it('should cancel orchestration and emit events', async () => {
      const createResult = await orchService.createOrchestration({
        goal: 'Will be cancelled',
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const cancelResult = await orchService.cancelOrchestration(createResult.value.id, 'Changed my mind');
      expect(cancelResult.ok).toBe(true);

      // Should have LoopCancelled and OrchestrationCancelled events
      const loopCancelled = eventBus.getEmittedEvents('LoopCancelled');
      expect(loopCancelled.length).toBe(1);

      const orchCancelled = eventBus.getEmittedEvents('OrchestrationCancelled');
      expect(orchCancelled.length).toBe(1);
    });
  });

  describe('Cleanup old orchestrations', () => {
    it('should cleanup terminal orchestrations older than retention', async () => {
      // Create and complete an orchestration
      const createResult = await orchService.createOrchestration({ goal: 'Old one' });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const { updateOrchestration } = await import('../../src/core/domain.js');
      const completed = updateOrchestration(createResult.value, {
        status: OrchestratorStatus.COMPLETED,
        completedAt: Date.now() - 10 * 24 * 60 * 60 * 1000, // 10 days ago
      });
      await orchRepo.update(completed);

      const cleanupResult = await orchRepo.cleanupOldOrchestrations(7 * 24 * 60 * 60 * 1000);
      expect(cleanupResult.ok).toBe(true);
      if (!cleanupResult.ok) return;
      expect(cleanupResult.value).toBe(1);

      // Verify it was deleted
      const findResult = await orchRepo.findById(createResult.value.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;
      expect(findResult.value).toBeNull();
    });
  });
});
