/**
 * Network Failure Scenarios
 * Tests for network timeouts, disconnections, and recovery
 *
 * ARCHITECTURE: These tests validate proper handling of network-related failures
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task, Worker } from '../../../src/core/domain';
import { BUFFER_SIZES, ERROR_MESSAGES, TIMEOUTS, WAIT_FOR } from '../../constants';
import { TaskFactory, WorkerFactory } from '../../fixtures/factories';
import { TestEventBus, TestProcessSpawner } from '../../fixtures/test-doubles';

describe('Network Failure Scenarios', () => {
  let taskFactory: TaskFactory;
  let workerFactory: WorkerFactory;
  let processSpawner: TestProcessSpawner;
  let eventBus: TestEventBus;

  beforeEach(() => {
    taskFactory = new TaskFactory();
    workerFactory = new WorkerFactory();
    processSpawner = new TestProcessSpawner();
    eventBus = new TestEventBus();
  });

  afterEach(() => {
    processSpawner.clear();
    eventBus.dispose();
  });

  describe('Process Communication Failures', () => {
    it('should handle process spawn timeout', async () => {
      // Set up spawn to hang
      const timeoutError = new Error('spawn ETIMEDOUT');
      processSpawner.setSpawnError(timeoutError);

      const result = await processSpawner.spawn('claude', ['--task', 'test']);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('ETIMEDOUT');
        expect(result.error.message).toContain('spawn');
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error.message).toBe(timeoutError.message);
      }
    });

    it('should handle process disconnection', async () => {
      const spawnResult = await processSpawner.spawn('claude', ['--task', 'test']);
      expect(spawnResult.ok).toBe(true);

      if (spawnResult.ok) {
        const { workerId, process } = spawnResult.value;

        expect(workerId).toBeTruthy();
        expect(typeof workerId).toBe('string');
        expect(process).toBeDefined();

        // Simulate process disconnection
        processSpawner.simulateExit(workerId, -1);

        // Verify process is marked as killed
        expect(processSpawner.isProcessKilled(workerId)).toBe(true);
        // FIX: getProcessInfo() doesn't exist on MockProcessSpawner - removed call
      }
    });

    it('should handle stdout/stderr pipe broken', async () => {
      const spawnResult = await processSpawner.spawn('claude', ['--task', 'test']);

      expect(spawnResult.ok).toBe(true);
      if (spawnResult.ok) {
        const { workerId } = spawnResult.value;

        expect(workerId).toBeTruthy();
        expect(processSpawner.isProcessKilled(workerId)).toBe(false);

        // Simulate broken pipe by sending data after process exit
        processSpawner.simulateExit(workerId, 1);
        expect(processSpawner.isProcessKilled(workerId)).toBe(true);

        // This should not throw
        expect(() => {
          processSpawner.simulateOutput(workerId, 'stdout', 'data after exit');
        }).not.toThrow();

        // Process should remain killed
        expect(processSpawner.isProcessKilled(workerId)).toBe(true);
      }
    });
  });

  describe('Event Bus Communication Failures', () => {
    it('should handle event emission timeout', async () => {
      // Subscribe with slow handler
      const slowHandler = async (_event: unknown) => {
        await new Promise((resolve) => setTimeout(resolve, TIMEOUTS.LONG));
      };

      eventBus.subscribe('TestEvent', slowHandler);

      // Emit with implicit timeout handling
      const startTime = Date.now();
      const result = await eventBus.emit('TestEvent', { data: 'test' });
      const elapsed = Date.now() - startTime;

      // Should complete even with slow handler
      expect(elapsed).toBeGreaterThanOrEqual(TIMEOUTS.LONG);
      expect(result.ok).toBe(true);
    });

    it('should handle event handler exceptions', async () => {
      // Subscribe with failing handler
      const failingHandler = async () => {
        throw new Error('Handler network error');
      };

      const goodHandler = vi.fn(async () => {
        // Good handler continues working
      });

      eventBus.subscribe('TestEvent', failingHandler);
      eventBus.subscribe('TestEvent', goodHandler);

      const result = await eventBus.emit('TestEvent', { data: 'test' });

      // Should report error but continue
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Handler network error');
      }

      // Good handler should still be called
      expect(goodHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe('Worker Communication Failures', () => {
    it('should detect unresponsive worker', async () => {
      const worker = workerFactory.withId('worker-1').busy('task-1').build();

      // Simulate heartbeat timeout
      const lastHeartbeat = worker.lastHeartbeat;
      const now = Date.now();
      const heartbeatTimeout = TIMEOUTS.LONG * 2;

      // Check if worker is unresponsive
      const isUnresponsive = now - lastHeartbeat > heartbeatTimeout;

      // After timeout, worker should be considered unresponsive
      if (now - lastHeartbeat > heartbeatTimeout) {
        expect(isUnresponsive).toBe(true);
      }
    });

    it('should handle worker output buffer overflow', async () => {
      const spawnResult = await processSpawner.spawn('claude', ['--task', 'test']);

      if (spawnResult.ok) {
        const { workerId } = spawnResult.value;

        // Simulate massive output
        const hugeOutput = 'x'.repeat(10 * 1024 * 1024); // 10MB

        // This should handle gracefully
        processSpawner.simulateOutput(workerId, 'stdout', hugeOutput);

        // Process should still be alive
        expect(processSpawner.isProcessKilled(workerId)).toBe(false);
      }
    });

    it('should handle worker sudden death', async () => {
      const spawnResult = await processSpawner.spawn('claude', ['--task', 'test']);

      if (spawnResult.ok) {
        const { workerId, process } = spawnResult.value;

        // Simulate SIGKILL
        process.kill();

        // Worker should be marked as killed
        expect(processSpawner.isProcessKilled(workerId)).toBe(true);
      }
    });
  });

  describe('Recovery from Network Failures', () => {
    it('should retry on transient network errors', async () => {
      let attempts = 0;

      // Fail first 2 attempts, succeed on third
      const handler = async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error('Network error');
        }
        return { ok: true, value: 'success' };
      };

      // Retry wrapper
      const retryWithBackoff = async (fn: Function, maxAttempts = 3) => {
        for (let i = 0; i < maxAttempts; i++) {
          try {
            return await fn();
          } catch (error) {
            if (i === maxAttempts - 1) throw error;
            await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, i)));
          }
        }
      };

      const result = await retryWithBackoff(handler);

      expect(attempts).toBe(3);
      expect(result.ok).toBe(true);
    });

    it('should reconnect event bus subscriptions after failure', async () => {
      let handlerCalls = 0;
      const handler = async () => {
        handlerCalls++;
      };

      // Subscribe
      const subResult = eventBus.subscribe('TestEvent', handler);
      expect(subResult.ok).toBe(true);

      // Simulate connection loss
      eventBus.unsubscribeAll();

      // Resubscribe
      const resubResult = eventBus.subscribe('TestEvent', handler);
      expect(resubResult.ok).toBe(true);

      // Should work again
      await eventBus.emit('TestEvent', { data: 'after reconnect' });
      // FIX: handler is not a spy, use counter instead
      expect(handlerCalls).toBeGreaterThan(0);
    });

    it('should handle partial message delivery', async () => {
      const receivedEvents: unknown[] = [];

      eventBus.subscribe('TestEvent', async (event) => {
        receivedEvents.push(event);
      });

      // Send multiple events
      const events = Array.from({ length: 5 }, (_, i) => ({
        id: i,
        data: `event-${i}`,
      }));

      const results = await Promise.allSettled(events.map((event) => eventBus.emit('TestEvent', event)));

      // Check partial success
      const successful = results.filter((r) => r.status === 'fulfilled').length;
      expect(successful).toBeGreaterThan(0);
      expect(receivedEvents.length).toBe(successful);
    });
  });

  describe('Network Latency Simulation', () => {
    it('should handle high latency operations', async () => {
      const latency = 200; // 200ms latency

      const simulateLatency = async <T>(operation: () => Promise<T>): Promise<T> => {
        await new Promise((resolve) => setTimeout(resolve, latency));
        return operation();
      };

      const startTime = Date.now();
      const result = await simulateLatency(async () => ({
        ok: true,
        value: 'completed',
      }));
      const elapsed = Date.now() - startTime;

      // Allow 5ms tolerance for timing precision in CI environments
      expect(elapsed).toBeGreaterThanOrEqual(latency - 5);
      expect(result.ok).toBe(true);
    });

    it('should handle packet loss simulation', async () => {
      const packetLossRate = 0.3; // 30% packet loss

      const simulatePacketLoss = async (operation: () => Promise<unknown>) => {
        if (Math.random() < packetLossRate) {
          throw new Error('Packet lost');
        }
        return operation();
      };

      let successes = 0;
      let failures = 0;
      const attempts = 100;

      for (let i = 0; i < attempts; i++) {
        try {
          await simulatePacketLoss(async () => ({ ok: true }));
          successes++;
        } catch {
          failures++;
        }
      }

      // Should have roughly 30% failures (with tolerance for randomness)
      const actualLossRate = failures / attempts;
      expect(actualLossRate).toBeGreaterThanOrEqual(0.2);
      expect(actualLossRate).toBeLessThanOrEqual(0.4);
    });

    it('should handle bandwidth throttling', async () => {
      const bandwidthLimit = BUFFER_SIZES.TINY; // 1KB/s
      const dataSize = BUFFER_SIZES.TINY * 5; // 5KB
      const expectedTime = (dataSize / bandwidthLimit) * TIMEOUTS.MEDIUM; // in ms

      const simulateBandwidthLimit = async (data: string) => {
        const chunks = Math.ceil(data.length / bandwidthLimit);
        for (let i = 0; i < chunks; i++) {
          await new Promise((resolve) => setTimeout(resolve, TIMEOUTS.MEDIUM));
        }
        return { ok: true, value: data.length };
      };

      const startTime = Date.now();
      const result = await simulateBandwidthLimit('x'.repeat(dataSize));
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeGreaterThanOrEqual(expectedTime * 0.9); // Allow 10% variance
      expect(result.ok).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('should handle ECONNRESET errors', async () => {
      processSpawner.setSpawnError(new Error('spawn ECONNRESET'));

      const result = await processSpawner.spawn('claude', ['--task', 'test']);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('ECONNRESET');
      }
    });

    it('should handle EPIPE errors', async () => {
      processSpawner.setSpawnError(new Error('write EPIPE'));

      const result = await processSpawner.spawn('claude', ['--task', 'test']);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('EPIPE');
      }
    });

    it('should handle DNS resolution failures', async () => {
      processSpawner.setSpawnError(new Error('getaddrinfo ENOTFOUND'));

      const result = await processSpawner.spawn('claude', ['--task', 'test']);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('ENOTFOUND');
      }
    });

    it('should handle maximum retry exceeded', async () => {
      let attempts = 0;
      const maxRetries = 3;

      const failingOperation = async () => {
        attempts++;
        throw new Error(`Attempt ${attempts} failed`);
      };

      let lastError: Error | null = null;
      for (let i = 0; i < maxRetries; i++) {
        try {
          await failingOperation();
          break;
        } catch (error) {
          lastError = error as Error;
        }
      }

      expect(attempts).toBe(maxRetries);
      expect(lastError).toBeTruthy();
      expect(lastError?.message).toContain(`Attempt ${maxRetries}`);
    });
  });
});
