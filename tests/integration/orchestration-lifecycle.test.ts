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

import { existsSync, unlinkSync } from 'fs';
import { LoopId, LoopStatus, OrchestratorId, OrchestratorStatus, updateLoop } from '../../src/core/domain.js';
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
  /** Track state files created during tests for cleanup */
  const createdStateFiles: string[] = [];
  const config = createTestConfiguration({ defaultAgent: 'claude' });

  beforeEach(() => {
    db = new Database(':memory:');
    loopRepo = new SQLiteLoopRepository(db);
    orchRepo = new SQLiteOrchestrationRepository(db);
    eventBus = new TestEventBus();
    logger = new TestLogger();
    loopService = new LoopManagerService(eventBus, logger, loopRepo, config);
    orchService = new OrchestrationManagerService({
      eventBus,
      logger,
      orchestrationRepo: orchRepo,
      loopService,
      config,
    });

    // Simulate LoopHandler: persist loop on LoopCreated event
    eventBus.subscribe('LoopCreated', async (event: Record<string, unknown>) => {
      const loop = (event as { loop: Parameters<typeof loopRepo.save>[0] }).loop;
      if (loop) {
        await loopRepo.save(loop);
      }
    });

    // Simulate LoopHandler: update loop status to CANCELLED on LoopCancelled event
    eventBus.subscribe('LoopCancelled', async (event: Record<string, unknown>) => {
      const { loopId } = event as { loopId: LoopId };
      if (!loopId) return;
      const result = await loopRepo.findById(loopId);
      if (result.ok && result.value) {
        const cancelled = updateLoop(result.value, { status: LoopStatus.CANCELLED, completedAt: Date.now() });
        await loopRepo.update(cancelled);
      }
    });

    // Track state files for cleanup
    eventBus.subscribe('OrchestrationCreated', async (event: Record<string, unknown>) => {
      const orch = event as { orchestration: { stateFilePath?: string } };
      if (orch.orchestration?.stateFilePath) {
        createdStateFiles.push(orch.orchestration.stateFilePath);
      }
    });
  });

  afterEach(() => {
    // Clean up state files created during tests
    for (const filePath of createdStateFiles) {
      try {
        unlinkSync(filePath);
      } catch {
        // File may not exist (e.g., test for invalid input)
      }
    }
    createdStateFiles.length = 0;
    eventBus.dispose();
    db.close();
  });

  describe('Create orchestration -> verify loop + agent eval mode', () => {
    it('should create orchestration with associated loop using agent eval mode (no state file)', async () => {
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

      // Agent eval mode: no state file is created
      expect(orch.stateFilePath).toBe('');
      expect(existsSync(orch.stateFilePath)).toBe(false);

      // Verify loop was created with agent eval mode
      const loopResult = await loopRepo.findById(orch.loopId!);
      expect(loopResult.ok).toBe(true);
      if (!loopResult.ok) return;
      expect(loopResult.value).not.toBeNull();
      expect(loopResult.value?.freshContext).toBe(true);
      expect(loopResult.value?.maxConsecutiveFailures).toBe(5);
      expect(loopResult.value?.evalMode).toBe('agent');
      expect(loopResult.value?.evalPrompt).toContain('Build a complete REST API');

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

  describe('Compensation on createOrchestration failure', () => {
    it('happy path: orch ends RUNNING with loopId set and loop persisted', async () => {
      const result = await orchService.createOrchestration({
        goal: 'Happy path test',
        maxWorkers: 2,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const orch = result.value;
      expect(orch.status).toBe(OrchestratorStatus.RUNNING);
      expect(orch.loopId).toBeDefined();

      // Loop should be persisted
      const loopResult = await loopRepo.findById(orch.loopId!);
      expect(loopResult.ok).toBe(true);
      if (!loopResult.ok) return;
      expect(loopResult.value).not.toBeNull();

      // Agent eval mode: no state file is created
      expect(orch.stateFilePath).toBe('');
    });

    it('loop creation fails: orch row marked FAILED, state file removed', async () => {
      // Make loopService.createLoop fail by making the eventBus fail on LoopCreated
      // Remove the LoopCreated subscriber from the TestEventBus (it was added in beforeEach)
      // and replace with one that returns err
      eventBus.setEmitFailure('LoopCreated', true);

      const result = await orchService.createOrchestration({
        goal: 'Will fail during loop creation',
      });

      // Should fail
      expect(result.ok).toBe(false);

      // Orch row should exist with FAILED status (compensation preserved the row)
      // Find by listing all orchestrations (no direct query by goal here)
      // We need to find it somehow — check if there's any orchestration in FAILED state
      const failedResult = await orchRepo.findByStatus(OrchestratorStatus.FAILED);
      expect(failedResult.ok).toBe(true);
      if (!failedResult.ok) return;
      expect(failedResult.value.length).toBeGreaterThan(0);

      const failedOrch = failedResult.value[0];
      expect(failedOrch).toBeDefined();
      if (!failedOrch) return;

      // State file should NOT exist (compensation cleaned it up)
      expect(existsSync(failedOrch.stateFilePath)).toBe(false);

      // Reset for cleanup
      eventBus.setEmitFailure('LoopCreated', false);
    });

    it('orchestration update fails: loop cancelled, orch row marked FAILED, state file removed', async () => {
      // Arrange: replace updateIfStatus on orchRepo to return a DB error Result.
      // This simulates the conditional update failing (e.g. DB constraint or connection error).
      vi.spyOn(orchRepo, 'updateIfStatus').mockResolvedValueOnce({
        ok: false,
        error: new Error('Simulated DB error on updateIfStatus'),
      });

      const result = await orchService.createOrchestration({
        goal: 'Will fail during orchestration update',
      });

      // Should return err (compensation ran but flow still fails)
      expect(result.ok).toBe(false);

      // Orch row should exist with FAILED status (compensation soft-deletes it)
      const failedResult = await orchRepo.findByStatus(OrchestratorStatus.FAILED);
      expect(failedResult.ok).toBe(true);
      if (!failedResult.ok) return;
      expect(failedResult.value.length).toBeGreaterThan(0);

      const failedOrch = failedResult.value[0];
      expect(failedOrch).toBeDefined();
      if (!failedOrch) return;

      // State file should NOT exist (compensation cleaned it up)
      expect(existsSync(failedOrch.stateFilePath)).toBe(false);

      // The loop that was created must now be CANCELLED.
      // Compensation called cancelLoop(loopId) which emits LoopCancelled;
      // our beforeEach LoopCancelled subscriber updates the loop row to CANCELLED.
      const cancelledLoops = await loopRepo.findByStatus(LoopStatus.CANCELLED);
      expect(cancelledLoops.ok).toBe(true);
      if (!cancelledLoops.ok) return;
      expect(cancelledLoops.value.length).toBe(1);
      expect(cancelledLoops.value[0]?.status).toBe(LoopStatus.CANCELLED);

      vi.restoreAllMocks();
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
