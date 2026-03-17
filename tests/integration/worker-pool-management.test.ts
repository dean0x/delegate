/**
 * Integration test for worker pool management
 * Tests worker lifecycle, resource monitoring, and output capture
 */

import { describe, expect, it, vi } from 'vitest';
import { InMemoryEventBus } from '../../src/core/events/event-bus.js';
import { ok } from '../../src/core/result.js';
import { EventDrivenWorkerPool } from '../../src/implementations/event-driven-worker-pool.js';
import { BufferedOutputCapture } from '../../src/implementations/output-capture.js';
import { createTestConfiguration } from '../fixtures/factories.js';
import { createAgentRegistryFromSpawner } from '../fixtures/mock-agent.js';
import { MockProcessSpawner } from '../fixtures/mock-process-spawner.js';
import { MockResourceMonitor } from '../fixtures/mock-resource-monitor.js';
import { createMockOutputRepository, createMockWorkerRepository } from '../fixtures/mocks.js';
import { createTestTask as createTask } from '../fixtures/test-data.js';
import { TestLogger } from '../fixtures/test-doubles.js';
import { flushEventLoop } from '../utils/event-helpers.js';

describe('Integration: Worker pool management', () => {
  it('should handle worker pool lifecycle management', async () => {
    const logger = new TestLogger();
    const config = createTestConfiguration();
    const eventBus = new InMemoryEventBus(config, logger);
    const processSpawner = new MockProcessSpawner();
    const outputCapture = new BufferedOutputCapture(10 * 1024 * 1024, eventBus);
    const resourceMonitor = new MockResourceMonitor();
    const workerRepository = createMockWorkerRepository();
    const outputRepository = createMockOutputRepository();

    const agentRegistry = createAgentRegistryFromSpawner(processSpawner);
    const workerPool = new EventDrivenWorkerPool(
      agentRegistry, // agentRegistry
      resourceMonitor, // monitor
      logger, // logger
      eventBus, // eventBus
      outputCapture, // outputCapture
      workerRepository, // workerRepository
      outputRepository, // outputRepository
    );

    try {
      // Track worker events
      const workerEvents: string[] = [];

      // Listen for task completion/failure
      eventBus.on('TaskCompleted', (data) => {
        workerEvents.push(`completed:${data.taskId}`);
      });

      eventBus.on('TaskFailed', (data) => {
        workerEvents.push(`failed:${data.taskId}`);
      });

      // Test 1: Spawn workers up to limit
      // Use 'sleep' in prompt to prevent auto-completion
      const tasks = Array.from({ length: 5 }, (_, i) => createTask({ prompt: `sleep 10 && echo "Task ${i}"` }));

      // Spawn first 3 workers (at max capacity)
      for (let i = 0; i < 3; i++) {
        const result = await workerPool.spawn(tasks[i]);
        expect(result.ok).toBe(true);
        if (result.ok) {
          // Update worker count in monitor so it knows we have workers
          resourceMonitor.updateWorkerCount(i + 1);
        }
      }

      // Wait for events to process
      await flushEventLoop();

      expect(workerPool.getWorkerCount()).toBe(3);

      // Test 2: Cannot spawn beyond limit - simulate resource exhaustion
      resourceMonitor.simulateHighCPU(90); // High CPU prevents spawning
      const result = await workerPool.spawn(tasks[3]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INSUFFICIENT_RESOURCES');
      }
      resourceMonitor.simulateHighCPU(30); // Reset CPU

      // Test 3: Complete a worker to free slot
      processSpawner.simulateCompletion(tasks[0].id, 'Task 0 complete');
      await flushEventLoop();
      expect(workerPool.getWorkerCount()).toBe(2);

      // Test 4: Can spawn new worker after slot freed
      const newResult = await workerPool.spawn(tasks[3]);
      expect(newResult.ok).toBe(true);
      await flushEventLoop();
      expect(workerPool.getWorkerCount()).toBe(3);

      // Test 5: Handle worker failure
      processSpawner.simulateError(tasks[1].id, new Error('Worker crashed'));
      await flushEventLoop();

      expect(workerEvents.some((e) => e.includes('failed'))).toBe(true);
      expect(workerPool.getWorkerCount()).toBe(2);

      // Test 6: Terminate all workers
      await workerPool.killAll();
      await flushEventLoop();

      expect(workerPool.getWorkerCount()).toBe(0);
    } finally {
      await workerPool.killAll();
      eventBus.dispose();
    }
  });

  it('should respect resource limits when spawning workers', async () => {
    const logger = new TestLogger();
    const config = createTestConfiguration();
    const eventBus = new InMemoryEventBus(config, logger);
    const resourceMonitor = new MockResourceMonitor();
    const processSpawner = new MockProcessSpawner();
    const outputCapture = new BufferedOutputCapture(10 * 1024 * 1024, eventBus);
    const workerRepository = createMockWorkerRepository();
    const outputRepository = createMockOutputRepository();

    const agentRegistry = createAgentRegistryFromSpawner(processSpawner);
    const workerPool = new EventDrivenWorkerPool(
      agentRegistry, // agentRegistry
      resourceMonitor, // monitor
      logger, // logger
      eventBus, // eventBus
      outputCapture, // outputCapture
      workerRepository, // workerRepository
      outputRepository, // outputRepository
    );

    try {
      const tasks = Array.from({ length: 5 }, (_, i) => createTask({ prompt: `Resource task ${i}` }));

      // Test 1: Spawn workers under normal resources
      const result1 = await workerPool.spawn(tasks[0]);
      expect(result1.ok).toBe(true);
      resourceMonitor.updateWorkerCount(1);
      await flushEventLoop();
      expect(workerPool.getWorkerCount()).toBe(1);

      // Test 2: Reject spawn under high CPU
      resourceMonitor.simulateHighCPU(90);
      const result2 = await workerPool.spawn(tasks[1]);
      expect(result2.ok).toBe(false);
      if (!result2.ok) {
        expect(result2.error.code).toBe('INSUFFICIENT_RESOURCES');
      }

      // Test 3: Allow spawn after resources recover
      resourceMonitor.simulateHighCPU(30);
      const result3 = await workerPool.spawn(tasks[1]);
      expect(result3.ok).toBe(true);
      resourceMonitor.updateWorkerCount(2);
      await flushEventLoop();
      expect(workerPool.getWorkerCount()).toBe(2);

      // Test 4: Complete all workers and verify count drops
      const activeTasks = processSpawner.getActiveTasks();
      activeTasks.forEach((taskId) => {
        processSpawner.simulateCompletion(taskId, 'Complete');
      });
      await flushEventLoop();
      expect(workerPool.getWorkerCount()).toBe(0);
    } finally {
      await workerPool.killAll();
      eventBus.dispose();
    }
  });

  it('should handle output capture and streaming', async () => {
    const logger = new TestLogger();
    const config = createTestConfiguration();
    const eventBus = new InMemoryEventBus(config, logger);
    const outputCapture = new BufferedOutputCapture(10 * 1024 * 1024, eventBus); // 10MB buffer to allow large output

    try {
      const task = createTask({ prompt: 'Output test' });

      // Track output events
      const outputs: string[] = [];
      eventBus.on('OutputReceived', (data) => {
        outputs.push(data.output);
      });

      // Test 1: Capture stdout
      outputCapture.capture(task.id, 'stdout', 'Line 1\n');
      outputCapture.capture(task.id, 'stdout', 'Line 2\n');
      eventBus.emit('OutputReceived', { taskId: task.id, output: 'Line 1\nLine 2\n' });

      const output1Result = outputCapture.getOutput(task.id);
      expect(output1Result.ok).toBe(true);
      if (output1Result.ok) {
        const stdoutStr = output1Result.value.stdout.join('');
        expect(stdoutStr).toContain('Line 1');
        expect(stdoutStr).toContain('Line 2');
      }

      // Test 2: Handle large output
      const largeOutput = 'x'.repeat(2048); // Large output
      const captureResult = outputCapture.capture(task.id, 'stdout', largeOutput);

      // Check if capture succeeded
      expect(captureResult.ok).toBe(true);

      const output2Result = outputCapture.getOutput(task.id);
      expect(output2Result.ok).toBe(true);
      if (output2Result.ok) {
        const totalOutput = output2Result.value.stdout.join('');
        // Should have all output captured
        expect(totalOutput).toContain('Line 1');
        expect(totalOutput).toContain('Line 2');
        expect(totalOutput).toContain('xxx'); // At least some x's
      }

      // Test 3: Tail functionality
      for (let i = 3; i <= 10; i++) {
        outputCapture.capture(task.id, 'stdout', `Line ${i}\n`);
      }

      // getOutput with tail parameter instead of separate tail method
      const tailResult = outputCapture.getOutput(task.id, 3);
      expect(tailResult.ok).toBe(true);
      if (tailResult.ok) {
        const tailLines = tailResult.value.stdout.slice(-3);
        expect(tailLines.length).toBe(3);
        expect(tailLines[2]).toContain('Line 10');
      }

      // Test 4: Verify output persists
      const finalOutputResult = outputCapture.getOutput(task.id);
      expect(finalOutputResult.ok).toBe(true);
      if (finalOutputResult.ok) {
        const hasOutput =
          finalOutputResult.value.stdout.length > 0 || finalOutputResult.value.stdout.join('').length > 0;
        expect(hasOutput).toBe(true);
      }

      // Test 5: Multiple concurrent captures
      const tasks = Array.from({ length: 5 }, (_, i) => createTask({ prompt: `Concurrent output ${i}` }));

      // Capture output for all tasks
      tasks.forEach((t, i) => {
        outputCapture.capture(t.id, 'stdout', `Output from task ${i}\n`);
      });

      // Verify all outputs captured
      for (let i = 0; i < tasks.length; i++) {
        const outputResult = outputCapture.getOutput(tasks[i].id);
        expect(outputResult.ok).toBe(true);
        if (outputResult.ok) {
          const stdoutStr = outputResult.value.stdout.join('');
          expect(stdoutStr).toContain(`task ${i}`);
        }
      }
    } finally {
      outputCapture.cleanup();
      eventBus.dispose();
    }
  });

  it('should register worker in repository on spawn and unregister on completion', async () => {
    const logger = new TestLogger();
    const config = createTestConfiguration();
    const eventBus = new InMemoryEventBus(config, logger);
    const processSpawner = new MockProcessSpawner();
    const outputCapture = new BufferedOutputCapture(10 * 1024 * 1024, eventBus);
    const resourceMonitor = new MockResourceMonitor();
    const workerRepository = createMockWorkerRepository();
    const outputRepository = createMockOutputRepository();

    const agentRegistry = createAgentRegistryFromSpawner(processSpawner);
    const workerPool = new EventDrivenWorkerPool(
      agentRegistry,
      resourceMonitor,
      logger,
      eventBus,
      outputCapture,
      workerRepository,
      outputRepository,
    );

    try {
      const task = createTask({ prompt: 'register test' });

      // Spawn worker
      const spawnResult = await workerPool.spawn(task);
      expect(spawnResult.ok).toBe(true);

      // WorkerRepository.register should have been called with task details
      expect(workerRepository.register).toHaveBeenCalledTimes(1);
      const registrationArg = (workerRepository.register as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(registrationArg.taskId).toBe(task.id);
      expect(registrationArg.agent).toBe('claude');
      expect(registrationArg.ownerPid).toBe(process.pid);

      // Complete the worker
      processSpawner.simulateCompletion(task.id, 'Done');
      await flushEventLoop();

      // WorkerRepository.unregister should have been called
      expect(workerRepository.unregister).toHaveBeenCalledTimes(1);
      expect(workerPool.getWorkerCount()).toBe(0);
    } finally {
      await workerPool.killAll();
      eventBus.dispose();
    }
  });

  it('should track global worker count via repository', async () => {
    const logger = new TestLogger();
    const config = createTestConfiguration();
    const eventBus = new InMemoryEventBus(config, logger);
    const processSpawner = new MockProcessSpawner();
    const outputCapture = new BufferedOutputCapture(10 * 1024 * 1024, eventBus);
    const resourceMonitor = new MockResourceMonitor();
    const workerRepository = createMockWorkerRepository();
    const outputRepository = createMockOutputRepository();

    // Simulate getGlobalCount returning the number of registered workers
    let registeredCount = 0;
    (workerRepository.register as ReturnType<typeof vi.fn>).mockImplementation(() => {
      registeredCount++;
      return ok(undefined);
    });
    (workerRepository.unregister as ReturnType<typeof vi.fn>).mockImplementation(() => {
      registeredCount = Math.max(0, registeredCount - 1);
      return ok(undefined);
    });
    (workerRepository.getGlobalCount as ReturnType<typeof vi.fn>).mockImplementation(() => ok(registeredCount));

    const agentRegistry = createAgentRegistryFromSpawner(processSpawner);
    const workerPool = new EventDrivenWorkerPool(
      agentRegistry,
      resourceMonitor,
      logger,
      eventBus,
      outputCapture,
      workerRepository,
      outputRepository,
    );

    try {
      const tasks = Array.from({ length: 3 }, (_, i) => createTask({ prompt: `count task ${i}` }));

      // Spawn 3 workers
      for (const task of tasks) {
        const result = await workerPool.spawn(task);
        expect(result.ok).toBe(true);
        resourceMonitor.updateWorkerCount(workerPool.getWorkerCount());
      }

      // Global count should reflect 3 registered workers
      const countResult = workerRepository.getGlobalCount();
      expect(countResult.ok).toBe(true);
      if (countResult.ok) {
        expect(countResult.value).toBe(3);
      }

      // Complete one worker
      processSpawner.simulateCompletion(tasks[0].id, 'Done');
      await flushEventLoop();

      // Global count should drop to 2
      const countResult2 = workerRepository.getGlobalCount();
      expect(countResult2.ok).toBe(true);
      if (countResult2.ok) {
        expect(countResult2.value).toBe(2);
      }

      expect(workerPool.getWorkerCount()).toBe(2);
    } finally {
      await workerPool.killAll();
      eventBus.dispose();
    }
  });

  it('should persist output to repository via ProcessConnector flush', async () => {
    const logger = new TestLogger();
    const config = createTestConfiguration();
    const eventBus = new InMemoryEventBus(config, logger);
    const processSpawner = new MockProcessSpawner();
    const outputCapture = new BufferedOutputCapture(10 * 1024 * 1024, eventBus);
    const resourceMonitor = new MockResourceMonitor();
    const workerRepository = createMockWorkerRepository();
    const outputRepository = createMockOutputRepository();

    const agentRegistry = createAgentRegistryFromSpawner(processSpawner);
    const workerPool = new EventDrivenWorkerPool(
      agentRegistry,
      resourceMonitor,
      logger,
      eventBus,
      outputCapture,
      workerRepository,
      outputRepository,
    );

    try {
      const task = createTask({ prompt: 'output persist test' });

      // Spawn worker
      const spawnResult = await workerPool.spawn(task);
      expect(spawnResult.ok).toBe(true);

      // Capture some output in the buffer
      outputCapture.capture(task.id, 'stdout', 'Hello from worker\n');
      outputCapture.capture(task.id, 'stderr', 'Warning: something\n');

      // Complete the worker (triggers final flush via ProcessConnector)
      processSpawner.simulateCompletion(task.id, 'Hello from worker');
      await flushEventLoop();

      // OutputRepository.save should have been called during flush
      // The ProcessConnector flushes on completion, persisting captured output
      expect(outputRepository.save).toHaveBeenCalled();

      // Verify the save was called with the task ID
      const saveCalls = (outputRepository.save as ReturnType<typeof vi.fn>).mock.calls;
      const saveForTask = saveCalls.find((call: unknown[]) => call[0] === task.id);
      expect(saveForTask).toBeDefined();

      expect(workerPool.getWorkerCount()).toBe(0);
    } finally {
      await workerPool.killAll();
      eventBus.dispose();
    }
  });
});
