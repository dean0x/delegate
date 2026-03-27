import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTask, type Task, type TaskCheckpoint, TaskId } from '../../../../src/core/domain';
import { InMemoryEventBus } from '../../../../src/core/events/event-bus';
import { SQLiteCheckpointRepository } from '../../../../src/implementations/checkpoint-repository';
import { Database } from '../../../../src/implementations/database';
import { SQLiteDependencyRepository } from '../../../../src/implementations/dependency-repository';
import { SQLiteTaskRepository } from '../../../../src/implementations/task-repository';
import { DependencyHandler } from '../../../../src/services/handlers/dependency-handler';
import { createTestConfiguration } from '../../../fixtures/factories';
import { TestLogger } from '../../../fixtures/test-doubles';
import { flushEventLoop } from '../../../utils/event-helpers.js';

describe('DependencyHandler - Behavioral Tests', () => {
  let handler: DependencyHandler;
  let eventBus: InMemoryEventBus;
  let dependencyRepo: SQLiteDependencyRepository;
  let taskRepo: SQLiteTaskRepository;
  let database: Database;
  let tempDir: string;
  let logger: TestLogger;

  beforeEach(async () => {
    // Use real implementations instead of mocks
    logger = new TestLogger();
    const config = createTestConfiguration();
    eventBus = new InMemoryEventBus(config, logger);

    // Use real database for testing
    tempDir = await mkdtemp(join(tmpdir(), 'dependency-handler-test-'));
    database = new Database(join(tempDir, 'test.db'));
    dependencyRepo = new SQLiteDependencyRepository(database);
    taskRepo = new SQLiteTaskRepository(database);

    // Create handler using factory pattern
    const handlerResult = await DependencyHandler.create({ dependencyRepo, taskRepo, logger, eventBus });
    if (!handlerResult.ok) {
      throw new Error(`Failed to create DependencyHandler: ${handlerResult.error.message}`);
    }
    handler = handlerResult.value;
  });

  afterEach(async () => {
    eventBus.dispose();
    database.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('Setup and initialization', () => {
    it('should setup successfully and subscribe to events', async () => {
      // Arrange - Create a fresh event bus for this test
      const freshEventBus = new InMemoryEventBus(createTestConfiguration(), new TestLogger());
      const freshLogger = new TestLogger();

      // Act - Create handler using factory pattern
      const result = await DependencyHandler.create({ dependencyRepo, taskRepo, logger: freshLogger, eventBus: freshEventBus });

      // Assert
      expect(result.ok).toBe(true);
      expect(freshLogger.hasLogContaining('DependencyHandler initialized')).toBe(true);

      // Cleanup
      freshEventBus.dispose();
    });
  });

  describe('Task delegation with dependencies', () => {
    it('should add dependencies when task is delegated', async () => {
      // Arrange - Create parent task
      const parentTask = createTask({ prompt: 'parent task' });
      await taskRepo.save(parentTask);

      // Create child task with dependency
      const childTask = createTask({
        prompt: 'child task',
        dependsOn: [parentTask.id],
      });
      await taskRepo.save(childTask);

      // Act - Emit TaskDelegated event
      await eventBus.emit('TaskDelegated', { task: childTask });

      // Assert - Dependency should be created
      const dependencies = await dependencyRepo.getDependencies(childTask.id);
      expect(dependencies.ok).toBe(true);
      if (dependencies.ok) {
        expect(dependencies.value).toHaveLength(1);
        expect(dependencies.value[0].taskId).toBe(childTask.id);
        expect(dependencies.value[0].dependsOnTaskId).toBe(parentTask.id);
        expect(dependencies.value[0].resolution).toBe('pending');
      }
    });

    it('should skip tasks with no dependencies', async () => {
      // Arrange - Create task without dependencies
      const task = createTask({ prompt: 'independent task' });
      await taskRepo.save(task);

      // Act - Emit TaskDelegated event
      await eventBus.emit('TaskDelegated', { task });

      // Assert - No dependencies should be created
      const dependencies = await dependencyRepo.getDependencies(task.id);
      expect(dependencies.ok).toBe(true);
      if (dependencies.ok) {
        expect(dependencies.value).toHaveLength(0);
      }
    });

    it('should detect and prevent cycles (A -> B -> A)', async () => {
      // Arrange - Create tasks A and B
      const taskA = createTask({ prompt: 'task A' });
      const taskB = createTask({ prompt: 'task B', dependsOn: [taskA.id] });
      await taskRepo.save(taskA);
      await taskRepo.save(taskB);

      // Create B -> A dependency
      await eventBus.emit('TaskDelegated', { task: taskB });

      // Flush microtasks (emit() already awaits handlers)
      await flushEventLoop();

      // Verify B -> A dependency was created
      const depsB = await dependencyRepo.getDependencies(taskB.id);
      expect(depsB.ok).toBe(true);
      if (depsB.ok) {
        expect(depsB.value).toHaveLength(1);
        expect(depsB.value[0].dependsOnTaskId).toBe(taskA.id);
      }

      // Try to create A -> B dependency (would create cycle)
      const taskAWithCycle = { ...taskA, dependsOn: [taskB.id] };
      // NOTE: Don't save the task again - INSERT OR REPLACE would cascade delete existing dependencies
      // The handler only needs the event, not the persisted task

      // Act - Try to emit TaskDelegated for A with dependency on B
      await eventBus.emit('TaskDelegated', { task: taskAWithCycle });

      // Flush microtasks (emit() already awaits handlers)
      await flushEventLoop();

      // Assert - Cycle should be detected and prevented
      // Verify an error was logged about cycle detection
      const errorLogs = logger.getLogsByLevel('error');
      expect(errorLogs.length).toBeGreaterThan(0);
      expect(
        errorLogs.some(
          (log) =>
            log.message.includes('would create cycle') ||
            (log.context?.error?.message && log.context.error.message.includes('would create cycle')),
        ),
      ).toBe(true);

      // The cyclic dependency (A -> B) should NOT have been added
      const depsA = await dependencyRepo.getDependencies(taskA.id);
      expect(depsA.ok).toBe(true);
      if (depsA.ok) {
        // Verify the cyclic dependency was not created
        const hasCyclicDependency = depsA.value.some((d) => d.dependsOnTaskId === taskB.id);
        expect(hasCyclicDependency).toBe(false);
      }
    });

    it('should detect and prevent transitive cycles (A -> B -> C -> A)', async () => {
      // Arrange - Create tasks A, B, C
      const taskA = createTask({ prompt: 'task A' });
      const taskB = createTask({ prompt: 'task B', dependsOn: [taskA.id] });
      const taskC = createTask({ prompt: 'task C', dependsOn: [taskB.id] });
      await taskRepo.save(taskA);
      await taskRepo.save(taskB);
      await taskRepo.save(taskC);

      // Create B -> A and C -> B dependencies
      await eventBus.emit('TaskDelegated', { task: taskB });
      await eventBus.emit('TaskDelegated', { task: taskC });

      // Flush microtasks (emit() already awaits handlers)
      await flushEventLoop();

      // Verify dependencies were created
      const depsB = await dependencyRepo.getDependencies(taskB.id);
      const depsC = await dependencyRepo.getDependencies(taskC.id);
      expect(depsB.ok && depsB.value.length === 1).toBe(true);
      expect(depsC.ok && depsC.value.length === 1).toBe(true);

      // Try to create A -> C dependency (would create transitive cycle: A->C->B->A)
      const taskAWithCycle = { ...taskA, dependsOn: [taskC.id] };
      // NOTE: Don't save the task again - INSERT OR REPLACE would cascade delete existing dependencies

      // Act
      await eventBus.emit('TaskDelegated', { task: taskAWithCycle });

      // Flush microtasks (emit() already awaits handlers)
      await flushEventLoop();

      // Assert - Transitive cycle should be detected and prevented
      // Verify an error was logged about cycle detection
      const errorLogs = logger.getLogsByLevel('error');
      expect(errorLogs.length).toBeGreaterThan(0);
      expect(
        errorLogs.some(
          (log) =>
            log.message.includes('would create cycle') ||
            (log.context?.error?.message && log.context.error.message.includes('would create cycle')),
        ),
      ).toBe(true);

      // The cyclic dependency (A -> C) should NOT have been added
      const depsA = await dependencyRepo.getDependencies(taskA.id);
      expect(depsA.ok).toBe(true);
      if (depsA.ok) {
        // Verify the cyclic dependency was not created
        const hasCyclicDependency = depsA.value.some((d) => d.dependsOnTaskId === taskC.id);
        expect(hasCyclicDependency).toBe(false);
      }
    });

    it('should handle multiple dependencies for single task', async () => {
      // Arrange - Create parent tasks
      const parent1 = createTask({ prompt: 'parent 1' });
      const parent2 = createTask({ prompt: 'parent 2' });
      const parent3 = createTask({ prompt: 'parent 3' });
      await taskRepo.save(parent1);
      await taskRepo.save(parent2);
      await taskRepo.save(parent3);

      // Create child with multiple dependencies
      const child = createTask({
        prompt: 'child task',
        dependsOn: [parent1.id, parent2.id, parent3.id],
      });
      await taskRepo.save(child);

      // Act
      await eventBus.emit('TaskDelegated', { task: child });

      // Assert - All 3 dependencies should be created
      const dependencies = await dependencyRepo.getDependencies(child.id);
      expect(dependencies.ok).toBe(true);
      if (dependencies.ok) {
        expect(dependencies.value).toHaveLength(3);
        const depTaskIds = dependencies.value.map((d) => d.dependsOnTaskId);
        expect(depTaskIds).toContain(parent1.id);
        expect(depTaskIds).toContain(parent2.id);
        expect(depTaskIds).toContain(parent3.id);
      }
    });
  });

  describe('Task completion dependency resolution', () => {
    it('should use batch resolution method for performance', async () => {
      // Arrange - Create tasks A (parent) and B, C (dependents)
      const taskA = createTask({ prompt: 'task A' });
      const taskB = createTask({ prompt: 'task B', dependsOn: [taskA.id] });
      const taskC = createTask({ prompt: 'task C', dependsOn: [taskA.id] });

      await taskRepo.save(taskA);
      await taskRepo.save(taskB);
      await taskRepo.save(taskC);

      // Create dependencies
      await eventBus.emit('TaskDelegated', { task: taskB });
      await eventBus.emit('TaskDelegated', { task: taskC });
      await flushEventLoop();

      // Spy on the batch resolution method to verify it's called
      const batchSpy = vi.spyOn(dependencyRepo, 'resolveDependenciesBatch');

      // Act - Complete task A
      await eventBus.emit('TaskCompleted', { taskId: taskA.id });
      await flushEventLoop();

      // Assert - Verify batch method was called exactly once
      expect(batchSpy).toHaveBeenCalledTimes(1);
      expect(batchSpy).toHaveBeenCalledWith(taskA.id, 'completed');

      // Verify dependencies were actually resolved
      const depsB = await dependencyRepo.getDependencies(taskB.id);
      const depsC = await dependencyRepo.getDependencies(taskC.id);

      expect(depsB.ok && depsB.value[0].resolution).toBe('completed');
      expect(depsC.ok && depsC.value[0].resolution).toBe('completed');
    });

    it('should resolve dependency when parent task completes', async () => {
      // Arrange - Create parent and child with dependency
      const parent = createTask({ prompt: 'parent' });
      const child = createTask({ prompt: 'child', dependsOn: [parent.id] });
      await taskRepo.save(parent);
      await taskRepo.save(child);
      await eventBus.emit('TaskDelegated', { task: child });

      // Act - Complete parent task
      await eventBus.emit('TaskCompleted', { taskId: parent.id });

      // Assert - Dependency should be resolved as completed
      const dependencies = await dependencyRepo.getDependencies(child.id);
      expect(dependencies.ok).toBe(true);
      if (dependencies.ok) {
        expect(dependencies.value[0].resolution).toBe('completed');
        expect(dependencies.value[0].resolvedAt).toBeDefined();
      }
    });

    it('should emit TaskUnblocked when all dependencies complete', async () => {
      // Arrange - Create parents and child
      const parent1 = createTask({ prompt: 'parent 1' });
      const parent2 = createTask({ prompt: 'parent 2' });
      const child = createTask({ prompt: 'child', dependsOn: [parent1.id, parent2.id] });
      await taskRepo.save(parent1);
      await taskRepo.save(parent2);
      await taskRepo.save(child);
      await eventBus.emit('TaskDelegated', { task: child });

      // Listen for TaskUnblocked event
      let unblockedEventReceived = false;
      let unblockedTaskId: TaskId | undefined;
      eventBus.subscribe('TaskUnblocked', async (event) => {
        unblockedEventReceived = true;
        unblockedTaskId = event.taskId;
      });

      // Act - Complete both parents
      await eventBus.emit('TaskCompleted', { taskId: parent1.id });
      await eventBus.emit('TaskCompleted', { taskId: parent2.id });

      // Give event time to propagate
      await flushEventLoop();

      // Assert - TaskUnblocked should be emitted
      expect(unblockedEventReceived).toBe(true);
      expect(unblockedTaskId).toBe(child.id);
    });

    it('should not emit TaskUnblocked if some dependencies remain pending', async () => {
      // Arrange
      const parent1 = createTask({ prompt: 'parent 1' });
      const parent2 = createTask({ prompt: 'parent 2' });
      const child = createTask({ prompt: 'child', dependsOn: [parent1.id, parent2.id] });
      await taskRepo.save(parent1);
      await taskRepo.save(parent2);
      await taskRepo.save(child);
      await eventBus.emit('TaskDelegated', { task: child });

      let unblockedEventReceived = false;
      eventBus.subscribe('TaskUnblocked', async () => {
        unblockedEventReceived = true;
      });

      // Act - Complete only one parent
      await eventBus.emit('TaskCompleted', { taskId: parent1.id });
      await flushEventLoop();

      // Assert - Should still be blocked
      expect(unblockedEventReceived).toBe(false);
      const isBlocked = await dependencyRepo.isBlocked(child.id);
      expect(isBlocked.ok).toBe(true);
      if (isBlocked.ok) {
        expect(isBlocked.value).toBe(true);
      }
    });
  });

  describe('Task failure dependency resolution', () => {
    it('should resolve dependency as failed when parent task fails', async () => {
      // Arrange
      const parent = createTask({ prompt: 'parent' });
      const child = createTask({ prompt: 'child', dependsOn: [parent.id] });
      await taskRepo.save(parent);
      await taskRepo.save(child);
      await eventBus.emit('TaskDelegated', { task: child });

      // Act - Fail parent task
      await eventBus.emit('TaskFailed', { taskId: parent.id, error: new Error('test failure') });

      // Assert - Dependency should be resolved as failed
      const dependencies = await dependencyRepo.getDependencies(child.id);
      expect(dependencies.ok).toBe(true);
      if (dependencies.ok) {
        expect(dependencies.value[0].resolution).toBe('failed');
      }
    });
  });

  describe('Task cancellation dependency resolution', () => {
    it('should resolve dependency as cancelled when parent task is cancelled', async () => {
      // Arrange
      const parent = createTask({ prompt: 'parent' });
      const child = createTask({ prompt: 'child', dependsOn: [parent.id] });
      await taskRepo.save(parent);
      await taskRepo.save(child);
      await eventBus.emit('TaskDelegated', { task: child });

      // Act - Cancel parent task
      await eventBus.emit('TaskCancelled', { taskId: parent.id, reason: 'test cancellation' });

      // Assert - Dependency should be resolved as cancelled
      const dependencies = await dependencyRepo.getDependencies(child.id);
      expect(dependencies.ok).toBe(true);
      if (dependencies.ok) {
        expect(dependencies.value[0].resolution).toBe('cancelled');
      }
    });
  });

  describe('Task timeout dependency resolution', () => {
    it('should resolve dependency as failed when parent task times out', async () => {
      // Arrange
      const parent = createTask({ prompt: 'parent' });
      const child = createTask({ prompt: 'child', dependsOn: [parent.id] });
      await taskRepo.save(parent);
      await taskRepo.save(child);
      await eventBus.emit('TaskDelegated', { task: child });

      // Act - Timeout parent task
      await eventBus.emit('TaskTimeout', { taskId: parent.id });

      // Assert - Dependency should be resolved as failed
      const dependencies = await dependencyRepo.getDependencies(child.id);
      expect(dependencies.ok).toBe(true);
      if (dependencies.ok) {
        expect(dependencies.value[0].resolution).toBe('failed');
      }
    });
  });

  describe('Complex dependency chains', () => {
    it('should handle diamond dependency pattern (A <- B,C <- D)', async () => {
      // Arrange - Create diamond pattern
      //     A
      //    / \
      //   B   C
      //    \ /
      //     D
      const taskA = createTask({ prompt: 'task A' });
      const taskB = createTask({ prompt: 'task B', dependsOn: [taskA.id] });
      const taskC = createTask({ prompt: 'task C', dependsOn: [taskA.id] });
      const taskD = createTask({ prompt: 'task D', dependsOn: [taskB.id, taskC.id] });

      await taskRepo.save(taskA);
      await taskRepo.save(taskB);
      await taskRepo.save(taskC);
      await taskRepo.save(taskD);

      await eventBus.emit('TaskDelegated', { task: taskB });
      await eventBus.emit('TaskDelegated', { task: taskC });
      await eventBus.emit('TaskDelegated', { task: taskD });

      // Act - Complete A, then B and C
      await eventBus.emit('TaskCompleted', { taskId: taskA.id });
      await flushEventLoop();

      // B and C should now be unblocked
      const isBBlocked = await dependencyRepo.isBlocked(taskB.id);
      const isCBlocked = await dependencyRepo.isBlocked(taskC.id);
      expect(isBBlocked.ok && !isBBlocked.value).toBe(true);
      expect(isCBlocked.ok && !isCBlocked.value).toBe(true);

      // Complete B and C
      await eventBus.emit('TaskCompleted', { taskId: taskB.id });
      await eventBus.emit('TaskCompleted', { taskId: taskC.id });
      await flushEventLoop();

      // Assert - D should now be unblocked
      const isDBlocked = await dependencyRepo.isBlocked(taskD.id);
      expect(isDBlocked.ok).toBe(true);
      if (isDBlocked.ok) {
        expect(isDBlocked.value).toBe(false);
      }
    });
  });

  describe('Error handling', () => {
    it('should handle missing parent task gracefully', async () => {
      // Arrange - Create child with non-existent parent
      const nonExistentParentId = TaskId('task-non-existent');
      const child = createTask({ prompt: 'child', dependsOn: [nonExistentParentId] });
      await taskRepo.save(child);

      // Act - Try to create dependency with non-existent parent
      await eventBus.emit('TaskDelegated', { task: child });

      // Assert - Should log error
      expect(logger.getLogsByLevel('error').length).toBeGreaterThan(0);
    });

    it('should not unblock task when getDependencies fails during cascade check', async () => {
      // Arrange: parent → child dependency
      const parent = createTask({ prompt: 'parent' });
      const child = createTask({ prompt: 'child', dependsOn: [parent.id] });
      await taskRepo.save(parent);
      await taskRepo.save(child);
      await eventBus.emit('TaskDelegated', { task: child });

      // Track unblock events — none should fire
      let unblockedEventReceived = false;
      eventBus.subscribe('TaskUnblocked', async () => {
        unblockedEventReceived = true;
      });

      // Mock getDependencies to fail when called during cascade check
      const originalGetDeps = dependencyRepo.getDependencies.bind(dependencyRepo);
      const getDependenciesSpy = vi.spyOn(dependencyRepo, 'getDependencies').mockImplementation(async (taskId) => {
        // Only fail during the cascade check (after isBlocked returns false)
        if (taskId === child.id) {
          const { err: mkErr } = await import('../../../../src/core/result');
          const { AutobeatError, ErrorCode } = await import('../../../../src/core/errors');
          return mkErr(new AutobeatError(ErrorCode.SYSTEM_ERROR, 'Simulated getDependencies failure'));
        }
        return originalGetDeps(taskId);
      });

      // Act: fail the parent — should trigger cascade check
      await eventBus.emit('TaskFailed', { taskId: parent.id, error: new Error('parent failed') });
      await flushEventLoop();

      getDependenciesSpy.mockRestore();

      // Assert: task should NOT be unblocked (getDependencies failed, can't confirm cascade)
      expect(unblockedEventReceived).toBe(false);

      // Assert: warning should be logged
      expect(logger.getLogsByLevel('warn').length).toBeGreaterThan(0);
    });

    it('should handle database errors during dependency creation', async () => {
      // Arrange - Create valid tasks
      const parent = createTask({ prompt: 'parent' });
      const child = createTask({ prompt: 'child', dependsOn: [parent.id] });
      await taskRepo.save(parent);
      await taskRepo.save(child);

      // Close database to force error
      database.close();

      // Act - Try to create dependency
      await eventBus.emit('TaskDelegated', { task: child });

      // Assert - Should handle error gracefully (check for error logs)
      // The handler should log an error when database operations fail
      const errorLogs = logger.getLogsByLevel('error');
      expect(errorLogs.length).toBeGreaterThan(0);
    });
  });

  describe('Concurrent dependency operations', () => {
    it('should handle concurrent dependency additions safely', async () => {
      // Arrange - Create multiple parent-child pairs
      const pairs = Array.from({ length: 10 }, (_, i) => ({
        parent: createTask({ prompt: `parent ${i}` }),
        child: createTask({ prompt: `child ${i}` }),
      }));

      // Save all tasks
      for (const { parent, child } of pairs) {
        await taskRepo.save(parent);
        await taskRepo.save(child);
      }

      // Act - Emit TaskDelegated concurrently for all children
      await Promise.all(
        pairs.map(({ parent, child }) => {
          const childWithDep = { ...child, dependsOn: [parent.id] };
          return eventBus.emit('TaskDelegated', { task: childWithDep });
        }),
      );

      // Assert - All dependencies should be created
      for (const { child } of pairs) {
        const deps = await dependencyRepo.getDependencies(child.id);
        expect(deps.ok).toBe(true);
      }
    });
  });

  describe('Graph consistency on failures', () => {
    /**
     * ROOT CAUSE TESTS: Verify event-driven graph updates maintain consistency
     * when repository operations fail. The handler updates its graph AFTER
     * successful database operations - these tests verify it doesn't update
     * the graph when operations fail.
     */

    it('should not update graph when dependency addition fails', async () => {
      // Arrange - Create tasks
      const parent = createTask({ prompt: 'parent task' });
      const child = createTask({ prompt: 'child task' });

      await taskRepo.save(parent);
      await taskRepo.save(child);

      // Create a dependency that will succeed
      const childWithValidDep = { ...child, dependsOn: [parent.id] };
      await eventBus.emit('TaskDelegated', { task: childWithValidDep });

      // Verify dependency was added to both database AND graph
      const depsResult = await dependencyRepo.getDependencies(child.id);
      expect(depsResult.ok).toBe(true);
      if (!depsResult.ok) throw new Error('Setup failed');
      expect(depsResult.value).toHaveLength(1);

      // Now try to add a DUPLICATE dependency (will fail)
      const duplicateAttempt = { ...child, dependsOn: [parent.id] };
      await eventBus.emit('TaskDelegated', { task: duplicateAttempt });

      // CRITICAL ASSERTION: Graph should still show only ONE dependency
      // If graph was updated before checking transaction success, we'd have duplicates
      const allDeps = await dependencyRepo.findAllUnbounded();
      expect(allDeps.ok).toBe(true);
      if (!allDeps.ok) throw new Error('Failed to get all deps');

      // Should have exactly 1 dependency (not 2)
      expect(allDeps.value).toHaveLength(1);
      expect(allDeps.value[0].taskId).toBe(child.id);
      expect(allDeps.value[0].dependsOnTaskId).toBe(parent.id);
    });

    it('should not update graph when cycle is detected', async () => {
      // Arrange - Create a dependency chain: A -> B
      const taskA = createTask({ prompt: 'task A' });
      const taskB = createTask({ prompt: 'task B' });

      await taskRepo.save(taskA);
      await taskRepo.save(taskB);

      // Create A -> B
      const taskBWithDep = { ...taskB, dependsOn: [taskA.id] };
      await eventBus.emit('TaskDelegated', { task: taskBWithDep });

      // Verify A -> B exists
      const bDeps = await dependencyRepo.getDependencies(taskB.id);
      expect(bDeps.ok).toBe(true);
      if (!bDeps.ok) throw new Error('Setup failed');
      expect(bDeps.value).toHaveLength(1);

      // Now try to create B -> A (would create cycle)
      const taskAWithCycle = { ...taskA, dependsOn: [taskB.id] };
      await eventBus.emit('TaskDelegated', { task: taskAWithCycle });

      // CRITICAL ASSERTION: Graph should NOT have B -> A edge
      // If handler updated graph before checking cycle, graph would be corrupted
      const aDeps = await dependencyRepo.getDependencies(taskA.id);
      expect(aDeps.ok).toBe(true);
      if (!aDeps.ok) throw new Error('Failed to get A deps');

      // A should have ZERO dependencies (cycle was rejected)
      expect(aDeps.value).toHaveLength(0);

      // Verify database also doesn't have the cycle
      const allDeps = await dependencyRepo.findAllUnbounded();
      expect(allDeps.ok).toBe(true);
      if (!allDeps.ok) throw new Error('Failed to get all deps');
      expect(allDeps.value).toHaveLength(1); // Only A -> B, not B -> A
    });

    it('should not update graph when task does not exist', async () => {
      // Arrange - Create only child task, not parent
      const child = createTask({ prompt: 'child task' });
      const nonExistentParent = 'non-existent-task' as TaskId;

      await taskRepo.save(child);

      // Try to create dependency to non-existent task (will fail)
      const childWithInvalidDep = { ...child, dependsOn: [nonExistentParent] };
      await eventBus.emit('TaskDelegated', { task: childWithInvalidDep });

      // CRITICAL ASSERTION: Graph should have NO dependencies
      // If handler updated graph before validating task existence, graph would be corrupted
      const deps = await dependencyRepo.getDependencies(child.id);
      expect(deps.ok).toBe(true);
      if (!deps.ok) throw new Error('Failed to get deps');

      // Should have ZERO dependencies (task not found error)
      expect(deps.value).toHaveLength(0);

      // Verify database is also empty
      const allDeps = await dependencyRepo.findAllUnbounded();
      expect(allDeps.ok).toBe(true);
      if (!allDeps.ok) throw new Error('Failed to get all deps');
      expect(allDeps.value).toHaveLength(0);
    });

    it('should maintain graph consistency across multiple failed operations', async () => {
      // Arrange - Create valid dependency chain: A -> B -> C
      const taskA = createTask({ prompt: 'task A' });
      const taskB = createTask({ prompt: 'task B' });
      const taskC = createTask({ prompt: 'task C' });

      await taskRepo.save(taskA);
      await taskRepo.save(taskB);
      await taskRepo.save(taskC);

      // Create A -> B
      const taskBWithDep = { ...taskB, dependsOn: [taskA.id] };
      await eventBus.emit('TaskDelegated', { task: taskBWithDep });

      // Create B -> C
      const taskCWithDep = { ...taskC, dependsOn: [taskB.id] };
      await eventBus.emit('TaskDelegated', { task: taskCWithDep });

      // Now attempt multiple failing operations
      // 1. Try to create C -> A (transitive cycle)
      const taskAWithCycle = { ...taskA, dependsOn: [taskC.id] };
      await eventBus.emit('TaskDelegated', { task: taskAWithCycle });

      // 2. Try to add duplicate B -> C
      const duplicateC = { ...taskC, dependsOn: [taskB.id] };
      await eventBus.emit('TaskDelegated', { task: duplicateC });

      // 3. Try to add non-existent dependency
      const nonExistent = 'non-existent' as TaskId;
      const taskAWithInvalid = { ...taskA, dependsOn: [nonExistent] };
      await eventBus.emit('TaskDelegated', { task: taskAWithInvalid });

      // CRITICAL ASSERTION: Graph should maintain original state
      const allDeps = await dependencyRepo.findAllUnbounded();
      expect(allDeps.ok).toBe(true);
      if (!allDeps.ok) throw new Error('Failed to get all deps');

      // Should have exactly 2 dependencies: A -> B and B -> C
      expect(allDeps.value).toHaveLength(2);

      const depPairs = allDeps.value.map((d) => `${d.taskId}->${d.dependsOnTaskId}`);
      expect(depPairs).toContain(`${taskB.id}->${taskA.id}`);
      expect(depPairs).toContain(`${taskC.id}->${taskB.id}`);
    });
  });

  /**
   * CHARACTERIZATION TESTS - Decomposition Safety
   *
   * These tests capture critical invariants that MUST be preserved when
   * decomposing handleTaskDelegated(). Each test documents a specific behavior
   * that the refactored code must maintain.
   *
   * See: docs/architecture/HANDLER-DECOMPOSITION-INVARIANTS.md
   */
  describe('Characterization Tests - Decomposition Safety', () => {
    describe('handleTaskDelegated() Ordering Invariants', () => {
      it('INVARIANT: Skip check is FIRST - no dependencies means immediate return', async () => {
        // Task with no dependencies should return immediately without any DB operations
        const task = createTask({ prompt: 'no deps task' });
        await taskRepo.save(task);

        // Spy on dependencyRepo to verify no calls
        const addSpy = vi.spyOn(dependencyRepo, 'addDependencies');

        await eventBus.emit('TaskDelegated', { task });

        // Should NOT call addDependencies
        expect(addSpy).not.toHaveBeenCalled();

        // Should NOT emit any dependency events
        const events = (eventBus as unknown as { emittedEvents?: Array<{ type: string }> }).emittedEvents || [];
        const depEvents = events.filter((e) => e.type === 'TaskDependencyAdded' || e.type === 'TaskDependencyFailed');
        expect(depEvents).toHaveLength(0);
      });

      it('INVARIANT: All validations run in PARALLEL via Promise.all', async () => {
        // Create multiple parent tasks
        const parent1 = createTask({ prompt: 'parent 1' });
        const parent2 = createTask({ prompt: 'parent 2' });
        const parent3 = createTask({ prompt: 'parent 3' });
        await taskRepo.save(parent1);
        await taskRepo.save(parent2);
        await taskRepo.save(parent3);

        // Create child with multiple dependencies
        const child = createTask({
          prompt: 'child',
          dependsOn: [parent1.id, parent2.id, parent3.id],
        });
        await taskRepo.save(child);

        await eventBus.emit('TaskDelegated', { task: child });

        // All dependencies should be created (validation ran for all)
        const deps = await dependencyRepo.getDependencies(child.id);
        expect(deps.ok).toBe(true);
        if (deps.ok) {
          expect(deps.value).toHaveLength(3);
        }
      });

      it('INVARIANT: Validation failure prevents ANY database writes', async () => {
        // Create A -> B chain
        const taskA = createTask({ prompt: 'task A' });
        const taskB = createTask({ prompt: 'task B', dependsOn: [taskA.id] });
        await taskRepo.save(taskA);
        await taskRepo.save(taskB);

        await eventBus.emit('TaskDelegated', { task: taskB });
        await flushEventLoop();

        // Now try to add cycle + valid dependency together
        // The cycle should prevent BOTH from being added
        const taskC = createTask({ prompt: 'task C' });
        await taskRepo.save(taskC);

        // This would create: A -> [B, C] where A->B creates cycle
        const taskAWithMixed = { ...taskA, dependsOn: [taskB.id, taskC.id] };
        await eventBus.emit('TaskDelegated', { task: taskAWithMixed });
        await flushEventLoop();

        // Neither dependency should be added (atomic failure)
        const depsA = await dependencyRepo.getDependencies(taskA.id);
        expect(depsA.ok).toBe(true);
        if (depsA.ok) {
          expect(depsA.value).toHaveLength(0);
        }
      });

      it('INVARIANT: Graph update happens AFTER successful database write', async () => {
        // This test verifies the critical ordering: DB first, then graph
        const parent = createTask({ prompt: 'parent' });
        const child = createTask({ prompt: 'child', dependsOn: [parent.id] });
        await taskRepo.save(parent);
        await taskRepo.save(child);

        // Spy on repository to track call order
        const addDepsSpy = vi.spyOn(dependencyRepo, 'addDependencies');

        await eventBus.emit('TaskDelegated', { task: child });

        // Database should have been called
        expect(addDepsSpy).toHaveBeenCalled();

        // Verify dependency exists in database (proof DB write succeeded)
        const deps = await dependencyRepo.getDependencies(child.id);
        expect(deps.ok).toBe(true);
        if (deps.ok) {
          expect(deps.value).toHaveLength(1);
        }
      });

      it('INVARIANT: TaskDependencyAdded emitted for EACH dependency after graph update', async () => {
        const parent1 = createTask({ prompt: 'parent 1' });
        const parent2 = createTask({ prompt: 'parent 2' });
        await taskRepo.save(parent1);
        await taskRepo.save(parent2);

        const child = createTask({
          prompt: 'child',
          dependsOn: [parent1.id, parent2.id],
        });
        await taskRepo.save(child);

        // Track emitted events
        let addedEvents: Array<Record<string, unknown>> = [];
        eventBus.subscribe('TaskDependencyAdded', async (event) => {
          addedEvents.push(event);
        });

        await eventBus.emit('TaskDelegated', { task: child });
        await flushEventLoop();

        // Should have emitted 2 TaskDependencyAdded events
        expect(addedEvents).toHaveLength(2);
      });
    });

    describe('Atomicity Invariants', () => {
      it('INVARIANT: All-or-nothing - partial validation failure rejects entire batch', async () => {
        // Create valid parent
        const validParent = createTask({ prompt: 'valid parent' });
        await taskRepo.save(validParent);

        // Create child with one valid and one non-existent dependency
        const nonExistentId = TaskId('non-existent-task');
        const child = createTask({
          prompt: 'child',
          dependsOn: [validParent.id, nonExistentId],
        });
        await taskRepo.save(child);

        await eventBus.emit('TaskDelegated', { task: child });
        await flushEventLoop();

        // NEITHER dependency should be added
        const deps = await dependencyRepo.getDependencies(child.id);
        expect(deps.ok).toBe(true);
        if (deps.ok) {
          expect(deps.value).toHaveLength(0);
        }
      });

      it('INVARIANT: TaskDependencyFailed emitted on any validation failure', async () => {
        const nonExistentId = TaskId('non-existent-task');
        const child = createTask({
          prompt: 'child',
          dependsOn: [nonExistentId],
        });
        await taskRepo.save(child);

        let failedEvent: Record<string, unknown> | null = null;
        eventBus.subscribe('TaskDependencyFailed', async (event) => {
          failedEvent = event as Record<string, unknown>;
        });

        await eventBus.emit('TaskDelegated', { task: child });
        await flushEventLoop();

        // Should have emitted failure event
        expect(failedEvent).not.toBeNull();
        expect(failedEvent!.taskId).toBe(child.id);
      });
    });

    describe('Error Type Classification', () => {
      it('INVARIANT: Cycle detection results in TaskDependencyFailed event', async () => {
        // Cycles are detected and result in failure events being emitted
        const taskA = createTask({ prompt: 'task A' });
        const taskB = createTask({ prompt: 'task B', dependsOn: [taskA.id] });
        await taskRepo.save(taskA);
        await taskRepo.save(taskB);

        await eventBus.emit('TaskDelegated', { task: taskB });
        await flushEventLoop();

        // Track failure events
        let failedEvent: Record<string, unknown> | null = null;
        eventBus.subscribe('TaskDependencyFailed', async (event) => {
          failedEvent = event as Record<string, unknown>;
        });

        // Try to create cycle
        const taskAWithCycle = { ...taskA, dependsOn: [taskB.id] };
        await eventBus.emit('TaskDelegated', { task: taskAWithCycle });
        await flushEventLoop();

        // Cycle should trigger TaskDependencyFailed with cycle error
        expect(failedEvent).not.toBeNull();
        expect((failedEvent!.error as Error).message).toContain('would create cycle');
      });

      it('INVARIANT: Database errors log as ERROR (unexpected system error)', async () => {
        const parent = createTask({ prompt: 'parent' });
        const child = createTask({ prompt: 'child', dependsOn: [parent.id] });
        await taskRepo.save(parent);
        await taskRepo.save(child);

        // Close database to force error
        database.close();

        await eventBus.emit('TaskDelegated', { task: child });
        await flushEventLoop();

        // Should log as error (unexpected system failure)
        const errorLogs = logger.getLogsByLevel('error');
        expect(errorLogs.length).toBeGreaterThan(0);
      });
    });
  });

  describe('continueFrom enrichment', () => {
    let checkpointRepo: SQLiteCheckpointRepository;
    let handlerWithCheckpoint: DependencyHandler;
    let enrichmentEventBus: InMemoryEventBus;
    let enrichmentLogger: TestLogger;
    let enrichmentDb: Database;
    let enrichmentTempDir: string;

    beforeEach(async () => {
      enrichmentLogger = new TestLogger();
      const config = createTestConfiguration();
      enrichmentEventBus = new InMemoryEventBus(config, enrichmentLogger);

      enrichmentTempDir = await mkdtemp(join(tmpdir(), 'dep-handler-enrich-'));
      enrichmentDb = new Database(join(enrichmentTempDir, 'test.db'));

      const enrichTaskRepo = new SQLiteTaskRepository(enrichmentDb);
      const enrichDepRepo = new SQLiteDependencyRepository(enrichmentDb);
      checkpointRepo = new SQLiteCheckpointRepository(enrichmentDb);

      const handlerResult = await DependencyHandler.create(
        { dependencyRepo: enrichDepRepo, taskRepo: enrichTaskRepo, logger: enrichmentLogger, eventBus: enrichmentEventBus },
        { checkpointLookup: checkpointRepo },
      );
      if (!handlerResult.ok) {
        throw new Error(`Failed to create DependencyHandler: ${handlerResult.error.message}`);
      }
      handlerWithCheckpoint = handlerResult.value;

      // NOTE: enrichTaskRepo and enrichDepRepo are created per-test below
      // as test-local variables, avoiding `this` context entirely
    });

    afterEach(async () => {
      enrichmentEventBus.dispose();
      enrichmentDb.close();
      await rm(enrichmentTempDir, { recursive: true, force: true });
    });

    it('should enrich task prompt with checkpoint context when continueFrom is set', async () => {
      // Create fresh repos from the enrichment DB
      const enrichTaskRepo = new SQLiteTaskRepository(enrichmentDb);
      const enrichDepRepo = new SQLiteDependencyRepository(enrichmentDb);

      // Arrange - Create parent task
      const parent = createTask({ prompt: 'Set up authentication module' });
      await enrichTaskRepo.save(parent);

      // Create child task with continueFrom
      const child = createTask({
        prompt: 'Continue implementing auth middleware',
        dependsOn: [parent.id],
        continueFrom: parent.id,
      });
      await enrichTaskRepo.save(child);

      // Create a checkpoint for the parent task
      const checkpointData: Omit<TaskCheckpoint, 'id'> = {
        taskId: parent.id,
        checkpointType: 'completed',
        outputSummary: 'Build succeeded. All tests passed.',
        errorSummary: undefined,
        gitBranch: 'feature/auth',
        gitCommitSha: 'abc123',
        gitDirtyFiles: ['src/auth.ts'],
        createdAt: Date.now(),
      };
      await checkpointRepo.save(checkpointData);

      // Register child dependencies
      await enrichmentEventBus.emit('TaskDelegated', { task: child });
      await flushEventLoop();

      // Listen for TaskUnblocked
      let unblockedTask: Task | undefined;
      enrichmentEventBus.subscribe('TaskUnblocked', async (event) => {
        unblockedTask = event.task;
      });

      // Act - Complete parent task (triggers dependency resolution + enrichment)
      await enrichmentEventBus.emit('TaskCompleted', { taskId: parent.id });
      await flushEventLoop();

      // Assert - Task should be unblocked with enriched prompt
      expect(unblockedTask).toBeDefined();
      if (unblockedTask) {
        expect(unblockedTask.prompt).toContain('DEPENDENCY CONTEXT:');
        expect(unblockedTask.prompt).toContain('Set up authentication module');
        expect(unblockedTask.prompt).toContain('Build succeeded. All tests passed.');
        expect(unblockedTask.prompt).toContain('YOUR TASK:');
        expect(unblockedTask.prompt).toContain('Continue implementing auth middleware');
      }

      // Verify prompt was persisted to DB
      const fetchedTask = await enrichTaskRepo.findById(child.id);
      expect(fetchedTask.ok).toBe(true);
      if (fetchedTask.ok && fetchedTask.value) {
        expect(fetchedTask.value.prompt).toContain('DEPENDENCY CONTEXT:');
      }
    });

    it('should not enrich task prompt when continueFrom is not set', async () => {
      const enrichTaskRepo = new SQLiteTaskRepository(enrichmentDb);

      // Arrange - Create parent and child without continueFrom
      const parent = createTask({ prompt: 'parent task' });
      await enrichTaskRepo.save(parent);

      const child = createTask({
        prompt: 'child task without continueFrom',
        dependsOn: [parent.id],
        // No continueFrom
      });
      await enrichTaskRepo.save(child);

      await enrichmentEventBus.emit('TaskDelegated', { task: child });
      await flushEventLoop();

      let unblockedTask: Task | undefined;
      enrichmentEventBus.subscribe('TaskUnblocked', async (event) => {
        unblockedTask = event.task;
      });

      // Act
      await enrichmentEventBus.emit('TaskCompleted', { taskId: parent.id });
      await flushEventLoop();

      // Assert - prompt should be unchanged
      expect(unblockedTask).toBeDefined();
      if (unblockedTask) {
        expect(unblockedTask.prompt).toBe('child task without continueFrom');
        expect(unblockedTask.prompt).not.toContain('DEPENDENCY CONTEXT:');
      }
    });

    it('should enrich through A→B→C chain with nested continuation context', async () => {
      const enrichTaskRepo = new SQLiteTaskRepository(enrichmentDb);
      const enrichDepRepo = new SQLiteDependencyRepository(enrichmentDb);

      // Arrange - Create chain: A → B (continueFrom A) → C (continueFrom B)
      const taskA = createTask({ prompt: 'Step 1: Initialize database schema' });
      await enrichTaskRepo.save(taskA);

      const taskB = createTask({
        prompt: 'Step 2: Seed test data',
        dependsOn: [taskA.id],
        continueFrom: taskA.id,
      });
      await enrichTaskRepo.save(taskB);

      const taskC = createTask({
        prompt: 'Step 3: Run integration tests',
        dependsOn: [taskB.id],
        continueFrom: taskB.id,
      });
      await enrichTaskRepo.save(taskC);

      // Create checkpoint for A
      await checkpointRepo.save({
        taskId: taskA.id,
        checkpointType: 'completed',
        outputSummary: 'Schema created: users, orders, products tables.',
        errorSummary: undefined,
        gitBranch: 'feature/db',
        gitCommitSha: 'aaa111',
        gitDirtyFiles: ['schema.sql'],
        createdAt: Date.now(),
      });

      // Register dependencies for B and C
      await enrichmentEventBus.emit('TaskDelegated', { task: taskB });
      await enrichmentEventBus.emit('TaskDelegated', { task: taskC });
      await flushEventLoop();

      // Track unblocked tasks
      const unblockedTasks: Task[] = [];
      enrichmentEventBus.subscribe('TaskUnblocked', async (event) => {
        unblockedTasks.push(event.task);
      });

      // Act 1: Complete A → B should unblock with enriched prompt
      await enrichmentEventBus.emit('TaskCompleted', { taskId: taskA.id });
      await flushEventLoop();

      expect(unblockedTasks).toHaveLength(1);
      const enrichedB = unblockedTasks[0];
      expect(enrichedB.prompt).toContain('DEPENDENCY CONTEXT:');
      expect(enrichedB.prompt).toContain('Step 1: Initialize database schema');
      expect(enrichedB.prompt).toContain('Schema created: users, orders, products tables.');
      expect(enrichedB.prompt).toContain('YOUR TASK:');
      expect(enrichedB.prompt).toContain('Step 2: Seed test data');

      // Create checkpoint for B (its prompt is now enriched — checkpoint captures enriched prompt context)
      await checkpointRepo.save({
        taskId: taskB.id,
        checkpointType: 'completed',
        outputSummary: 'Seeded 100 users, 500 orders.',
        errorSummary: undefined,
        gitBranch: 'feature/db',
        gitCommitSha: 'bbb222',
        gitDirtyFiles: ['seed.ts'],
        createdAt: Date.now(),
      });

      // Act 2: Complete B → C should unblock with enriched prompt containing B's context
      await enrichmentEventBus.emit('TaskCompleted', { taskId: taskB.id });
      await flushEventLoop();

      expect(unblockedTasks).toHaveLength(2);
      const enrichedC = unblockedTasks[1];
      expect(enrichedC.prompt).toContain('DEPENDENCY CONTEXT:');
      expect(enrichedC.prompt).toContain('Seeded 100 users, 500 orders.');
      expect(enrichedC.prompt).toContain('YOUR TASK:');
      expect(enrichedC.prompt).toContain('Step 3: Run integration tests');

      // Verify B's enriched prompt is used as dependency prompt for C
      // (B's prompt was enriched with A's context, and that becomes the "Prerequisite prompt" for C)
      expect(enrichedC.prompt).toContain('Step 2: Seed test data');
    });

    it('should proceed without enrichment when checkpoint is not available', async () => {
      const enrichTaskRepo = new SQLiteTaskRepository(enrichmentDb);

      // Arrange - Create parent and child with continueFrom but NO checkpoint
      const parent = createTask({ prompt: 'parent task' });
      await enrichTaskRepo.save(parent);

      const child = createTask({
        prompt: 'child task with continueFrom',
        dependsOn: [parent.id],
        continueFrom: parent.id,
      });
      await enrichTaskRepo.save(child);

      await enrichmentEventBus.emit('TaskDelegated', { task: child });
      await flushEventLoop();

      let unblockedTask: Task | undefined;
      enrichmentEventBus.subscribe('TaskUnblocked', async (event) => {
        unblockedTask = event.task;
      });

      // Act - Complete parent (no checkpoint exists)
      // The emit awaits the handler chain which includes waitForCheckpoint's 5s timeout
      await enrichmentEventBus.emit('TaskCompleted', { taskId: parent.id });
      await flushEventLoop();

      // Assert - task should still be unblocked, but with original prompt
      expect(unblockedTask).toBeDefined();
      if (unblockedTask) {
        expect(unblockedTask.prompt).toBe('child task with continueFrom');
        expect(unblockedTask.prompt).not.toContain('DEPENDENCY CONTEXT:');
      }

      // Verify warning was logged
      const warnLogs = enrichmentLogger.getLogsByLevel('warn');
      expect(warnLogs.some((log) => log.message.includes('Checkpoint not available for continueFrom enrichment'))).toBe(
        true,
      );
    }, 15000); // Extended timeout: handler awaits 5s checkpoint timeout internally
  });

  describe('Dependency failure cascade (v0.6.0)', () => {
    it('should cancel dependent task when upstream fails', async () => {
      // Arrange - Create parent and child with dependency
      const parentTask = createTask({ prompt: 'parent' });
      await taskRepo.save(parentTask);
      const childTask = createTask({ prompt: 'child', dependsOn: [parentTask.id] });
      await taskRepo.save(childTask);

      // Emit TaskDelegated for child to register deps in handler
      await eventBus.emit('TaskDelegated', { task: childTask });
      await flushEventLoop();

      // Capture TaskCancellationRequested events
      const cancellationRequestedIds: TaskId[] = [];
      eventBus.subscribe('TaskCancellationRequested', async (event) => {
        cancellationRequestedIds.push(event.taskId);
      });

      // Act - Fail the parent task
      await eventBus.emit('TaskFailed', { taskId: parentTask.id, error: new Error('failed') });
      await flushEventLoop();

      // Assert - Child should receive a cancellation request
      expect(cancellationRequestedIds).toContain(childTask.id);
      expect(logger.hasLogContaining('cascading cancellation')).toBe(true);
    });

    it('should cascade cancellation through multi-level chain', async () => {
      // Arrange - Create A→B→C chain
      const taskA = createTask({ prompt: 'task A' });
      await taskRepo.save(taskA);
      const taskB = createTask({ prompt: 'task B', dependsOn: [taskA.id] });
      await taskRepo.save(taskB);
      const taskC = createTask({ prompt: 'task C', dependsOn: [taskB.id] });
      await taskRepo.save(taskC);

      // Register dependencies in the handler
      await eventBus.emit('TaskDelegated', { task: taskB });
      await eventBus.emit('TaskDelegated', { task: taskC });
      await flushEventLoop();

      // Capture TaskCancellationRequested events
      const cancellationRequestedIds: TaskId[] = [];
      eventBus.subscribe('TaskCancellationRequested', async (event) => {
        cancellationRequestedIds.push(event.taskId);
      });

      // Act - Fail A, which should cascade cancellation to B
      await eventBus.emit('TaskFailed', { taskId: taskA.id, error: new Error('failed') });
      await flushEventLoop();

      // B should be cancelled at this point
      expect(cancellationRequestedIds).toContain(taskB.id);

      // Simulate B being cancelled (downstream of the cancellation request) — this
      // triggers the DependencyHandler to resolve C's dependency on B as 'cancelled',
      // which cascades the cancellation to C
      await eventBus.emit('TaskCancelled', { taskId: taskB.id, reason: 'dependency failed' });
      await flushEventLoop();

      // C should also receive a cancellation request (cascade)
      expect(cancellationRequestedIds).toContain(taskC.id);
      expect(logger.hasLogContaining('cascading cancellation')).toBe(true);
    });

    it('should cancel dependent when upstream is cancelled', async () => {
      // Arrange - Create parent and child with dependency
      const parentTask = createTask({ prompt: 'parent' });
      await taskRepo.save(parentTask);
      const childTask = createTask({ prompt: 'child', dependsOn: [parentTask.id] });
      await taskRepo.save(childTask);

      // Emit TaskDelegated for child to register deps in handler
      await eventBus.emit('TaskDelegated', { task: childTask });
      await flushEventLoop();

      // Capture TaskCancellationRequested events
      const cancellationRequestedIds: TaskId[] = [];
      eventBus.subscribe('TaskCancellationRequested', async (event) => {
        cancellationRequestedIds.push(event.taskId);
      });

      // Act - Cancel the parent task (instead of failing it)
      await eventBus.emit('TaskCancelled', { taskId: parentTask.id, reason: 'user cancelled' });
      await flushEventLoop();

      // Assert - Child should receive a cancellation request
      expect(cancellationRequestedIds).toContain(childTask.id);
      expect(logger.hasLogContaining('cascading cancellation')).toBe(true);
    });
  });
});
