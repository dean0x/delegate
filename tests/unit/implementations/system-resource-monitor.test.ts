import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryEventBus } from '../../../src/core/events/event-bus';
import { TestLogger } from '../../../src/implementations/logger';
import { SystemResourceMonitor } from '../../../src/implementations/resource-monitor';
import { createTestConfiguration } from '../../fixtures/factories';

// Mock os module
let mockTotalmem = () => 16_000_000_000;
let mockFreemem = () => 8_000_000_000;
let mockLoadavg = () => [1.0, 1.0, 1.0];
let mockCpus = () => Array(8).fill({ times: { idle: 100, user: 100, nice: 0, sys: 50, irq: 0 } });

vi.mock('os', () => ({
  default: {
    totalmem: () => mockTotalmem(),
    freemem: () => mockFreemem(),
    loadavg: () => mockLoadavg(),
    cpus: () => mockCpus(),
  },
  totalmem: () => mockTotalmem(),
  freemem: () => mockFreemem(),
  loadavg: () => mockLoadavg(),
  cpus: () => mockCpus(),
}));

describe('SystemResourceMonitor', () => {
  let monitor: SystemResourceMonitor;
  let eventBus: InMemoryEventBus;
  let logger: TestLogger;

  const MEMORY_16GB = 16_000_000_000;
  const MEMORY_8GB = 8_000_000_000;
  const MEMORY_1GB = 1_000_000_000;

  beforeEach(() => {
    logger = new TestLogger();
    eventBus = new InMemoryEventBus(createTestConfiguration(), logger);

    // Setup default mock values
    mockTotalmem = () => MEMORY_16GB;
    mockFreemem = () => MEMORY_8GB;
    mockLoadavg = () => [1.5, 1.2, 1.0];
    mockCpus = () => new Array(4).fill({ times: { idle: 100, user: 100, nice: 0, sys: 50, irq: 0 } });

    const config = createTestConfiguration({
      cpuCoresReserved: 2,
      memoryReserve: MEMORY_1GB,
      resourceMonitorIntervalMs: 100,
    });

    monitor = new SystemResourceMonitor(config, eventBus, logger);
  });

  afterEach(() => {
    monitor.stopMonitoring();
    vi.clearAllMocks();
  });

  describe('Resource querying', () => {
    it('should get current system resources', async () => {
      const result = await monitor.getResources();

      expect(result.ok).toBe(true);
      if (result.ok) {
        const resources = result.value;
        expect(resources.totalMemory).toBe(MEMORY_16GB);
        expect(resources.availableMemory).toBe(MEMORY_8GB);
        expect(resources.loadAverage).toEqual([1.5, 1.2, 1.0]);
        expect(resources.workerCount).toBe(0);
        expect(resources.cpuUsage).toBe(37.5); // (1.5/4) * 100
      }
    });

    // Data-driven CPU usage tests
    const cpuUsageCases = [
      { load: [2.0, 1.5, 1.0], cpus: 8, expected: 25 }, // (2.0/8) * 100
      { load: [16.0, 12.0, 8.0], cpus: 4, expected: 100 }, // Capped at 100
      { load: [0.5, 0.3, 0.2], cpus: 4, expected: 12.5 }, // Low load
    ];

    it.each(cpuUsageCases)('should calculate CPU usage correctly with load $load and $cpus CPUs', async ({
      load,
      cpus,
      expected,
    }) => {
      mockLoadavg = () => load;
      mockCpus = () => new Array(cpus).fill({ times: { idle: 100, user: 100, nice: 0, sys: 50, irq: 0 } });

      const result = await monitor.getResources();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.cpuUsage).toBe(expected);
      }
    });

    it('should handle edge cases gracefully', async () => {
      mockCpus = () => []; // No CPUs

      const result = await monitor.getResources();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.cpuUsage).toBe(0);
      }
    });
  });

  describe('getThresholds', () => {
    it('should calculate maxCpuPercent from reserved cores', () => {
      const thresholds = monitor.getThresholds();

      // 4 CPUs, 2 reserved → (4-2)/4 * 100 = 50%
      expect(thresholds.maxCpuPercent).toBe(50);
      expect(thresholds.minMemoryBytes).toBe(MEMORY_1GB);
    });
  });

  describe('Spawn eligibility', () => {
    // Data-driven eligibility tests
    const eligibilityCases = [
      {
        name: 'sufficient resources',
        memory: MEMORY_8GB,
        load: [1.0, 1.0, 1.0],
        cpus: 4,
        workerCount: 0,
        expected: true,
      },
      {
        name: 'low memory',
        memory: 500_000_000, // 500MB free
        load: [1.0, 1.0, 1.0],
        cpus: 4,
        workerCount: 0,
        expected: false,
      },
      {
        name: 'high CPU usage',
        memory: MEMORY_8GB,
        load: [3.5, 3.0, 2.5], // 87.5% usage on 4 cores
        cpus: 4,
        workerCount: 0,
        expected: false,
      },
      {
        name: 'at CPU threshold',
        memory: MEMORY_8GB,
        load: [3.2, 3.0, 2.8], // Exactly 80% on 4 cores
        cpus: 4,
        workerCount: 0,
        expected: false,
      },
    ];

    it.each(eligibilityCases)('should determine spawn eligibility correctly when $name', async ({
      memory,
      load,
      cpus,
      expected,
    }) => {
      mockFreemem = () => memory;
      mockLoadavg = () => load;
      mockCpus = () => new Array(cpus).fill({ times: { idle: 100, user: 100, nice: 0, sys: 50, irq: 0 } });

      const result = await monitor.canSpawnWorker();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(expected);
      }
    });
  });

  describe('Worker count management', () => {
    it('should track worker count', () => {
      expect(monitor.getCurrentWorkerCount()).toBe(0);

      monitor.incrementWorkerCount();
      expect(monitor.getCurrentWorkerCount()).toBe(1);

      monitor.incrementWorkerCount();
      expect(monitor.getCurrentWorkerCount()).toBe(2);

      monitor.decrementWorkerCount();
      expect(monitor.getCurrentWorkerCount()).toBe(1);
    });

    it('should not go below zero', () => {
      monitor.decrementWorkerCount();
      monitor.decrementWorkerCount();
      expect(monitor.getCurrentWorkerCount()).toBe(0);

      // Multiple decrements should stay at 0
      monitor.decrementWorkerCount();
      monitor.decrementWorkerCount();
      expect(monitor.getCurrentWorkerCount()).toBe(0);
      expect(monitor.getCurrentWorkerCount()).toBeGreaterThanOrEqual(0);
      expect(typeof monitor.getCurrentWorkerCount()).toBe('number');
    });

    it('should allow direct setting', () => {
      monitor.setWorkerCount(5);
      expect(monitor.getCurrentWorkerCount()).toBe(5);

      monitor.setWorkerCount(0);
      expect(monitor.getCurrentWorkerCount()).toBe(0);

      monitor.setWorkerCount(100);
      expect(monitor.getCurrentWorkerCount()).toBe(100);

      // Should handle negative values by setting to 0
      monitor.setWorkerCount(-5);
      expect(monitor.getCurrentWorkerCount()).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Settling workers tracking', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      // Set up resources that would allow spawning
      mockFreemem = () => MEMORY_8GB;
      mockLoadavg = () => [1.0, 1.0, 1.0];
      mockCpus = () => new Array(8).fill({ times: { idle: 100, user: 100, nice: 0, sys: 50, irq: 0 } });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should record spawn events and affect spawn eligibility', async () => {
      // Set MAX_WORKERS to low value to see the effect
      const originalMaxWorkers = process.env.MAX_WORKERS;
      process.env.MAX_WORKERS = '1';

      try {
        const limitedConfig = createTestConfiguration({
          cpuCoresReserved: 2,
          memoryReserve: MEMORY_1GB,
        });
        const limitedMonitor = new SystemResourceMonitor(limitedConfig, eventBus, logger);

        // Before recordSpawn, should be able to spawn
        const beforeResult = await limitedMonitor.canSpawnWorker();
        expect(beforeResult.ok).toBe(true);
        if (beforeResult.ok) {
          expect(beforeResult.value).toBe(true);
        }

        // Record a spawn - this should affect eligibility
        limitedMonitor.recordSpawn();

        // After recordSpawn, should NOT be able to spawn (at maxWorkers)
        const afterResult = await limitedMonitor.canSpawnWorker();
        expect(afterResult.ok).toBe(true);
        if (afterResult.ok) {
          expect(afterResult.value).toBe(false);
        }
      } finally {
        if (originalMaxWorkers !== undefined) {
          process.env.MAX_WORKERS = originalMaxWorkers;
        } else {
          delete process.env.MAX_WORKERS;
        }
      }
    });

    it('should include settling workers in effective worker count', async () => {
      const originalMaxWorkers = process.env.MAX_WORKERS;
      process.env.MAX_WORKERS = '3';

      try {
        const limitedConfig = createTestConfiguration({
          cpuCoresReserved: 2,
          memoryReserve: MEMORY_1GB,
        });
        const limitedMonitor = new SystemResourceMonitor(limitedConfig, eventBus, logger);

        // Record spawns up to but not exceeding limit
        limitedMonitor.recordSpawn();
        limitedMonitor.recordSpawn();

        // 2 settling workers < 3 max → should still allow spawn
        const canSpawn = await limitedMonitor.canSpawnWorker();
        expect(canSpawn.ok).toBe(true);
        if (canSpawn.ok) {
          expect(canSpawn.value).toBe(true);
        }

        // 3rd settling worker hits the limit
        limitedMonitor.recordSpawn();
        const blocked = await limitedMonitor.canSpawnWorker();
        expect(blocked.ok).toBe(true);
        if (blocked.ok) {
          expect(blocked.value).toBe(false);
        }
      } finally {
        if (originalMaxWorkers !== undefined) {
          process.env.MAX_WORKERS = originalMaxWorkers;
        } else {
          delete process.env.MAX_WORKERS;
        }
      }
    });

    it('should expire settling workers after 15 second window', async () => {
      const originalMaxWorkers = process.env.MAX_WORKERS;
      process.env.MAX_WORKERS = '1';

      try {
        const limitedConfig = createTestConfiguration({
          cpuCoresReserved: 2,
          memoryReserve: MEMORY_1GB,
        });
        const limitedMonitor = new SystemResourceMonitor(limitedConfig, eventBus, logger);

        // Record a spawn (fills the 1-worker limit)
        limitedMonitor.recordSpawn();

        // Should be blocked while settling
        const blocked = await limitedMonitor.canSpawnWorker();
        expect(blocked.ok).toBe(true);
        if (blocked.ok) {
          expect(blocked.value).toBe(false);
        }

        // Fast-forward past the settling window (15 seconds)
        await vi.advanceTimersByTimeAsync(16_000);

        // The spawn should have expired — can spawn again
        const unblocked = await limitedMonitor.canSpawnWorker();
        expect(unblocked.ok).toBe(true);
        if (unblocked.ok) {
          expect(unblocked.value).toBe(true);
        }
      } finally {
        if (originalMaxWorkers !== undefined) {
          process.env.MAX_WORKERS = originalMaxWorkers;
        } else {
          delete process.env.MAX_WORKERS;
        }
      }
    });

    it('should not expire settling workers within the window', async () => {
      const originalMaxWorkers = process.env.MAX_WORKERS;
      process.env.MAX_WORKERS = '1';

      try {
        const limitedConfig = createTestConfiguration({
          cpuCoresReserved: 2,
          memoryReserve: MEMORY_1GB,
        });
        const limitedMonitor = new SystemResourceMonitor(limitedConfig, eventBus, logger);

        // Record a spawn (fills the 1-worker limit)
        limitedMonitor.recordSpawn();

        // Fast-forward 10 seconds (within the 15 second window)
        await vi.advanceTimersByTimeAsync(10_000);

        // The spawn should still be tracked — cannot spawn
        const result = await limitedMonitor.canSpawnWorker();
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(false);
        }
      } finally {
        if (originalMaxWorkers !== undefined) {
          process.env.MAX_WORKERS = originalMaxWorkers;
        } else {
          delete process.env.MAX_WORKERS;
        }
      }
    });

    it('should correctly project resource usage for settling workers', async () => {
      // Set MAX_WORKERS env to limit workers
      const originalMaxWorkers = process.env.MAX_WORKERS;
      process.env.MAX_WORKERS = '2';

      try {
        // Create monitor with limited max workers (2)
        const limitedConfig = createTestConfiguration({
          cpuCoresReserved: 2,
          memoryReserve: MEMORY_1GB,
        });
        const limitedMonitor = new SystemResourceMonitor(limitedConfig, eventBus, logger);

        // Record spawns up to the limit (2 settling workers = max)
        limitedMonitor.recordSpawn();
        limitedMonitor.recordSpawn();

        // Should not allow more spawns because settling workers count toward limit
        const result = await limitedMonitor.canSpawnWorker();
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(false);
        }
      } finally {
        // Restore env
        if (originalMaxWorkers !== undefined) {
          process.env.MAX_WORKERS = originalMaxWorkers;
        } else {
          delete process.env.MAX_WORKERS;
        }
      }
    });
  });

  describe('Periodic monitoring', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should perform resource checks on interval', async () => {
      monitor.startMonitoring();

      // Advance past one monitoring interval (100ms)
      await vi.advanceTimersByTimeAsync(150);

      // Verify monitoring loop ran by checking debug logs
      const debugLogs = logger.logs.filter(
        (log) => log.level === 'debug' && log.message === 'Resource status published',
      );
      expect(debugLogs.length).toBeGreaterThan(0);
      expect(debugLogs[0].context).toEqual(
        expect.objectContaining({
          cpuPercent: expect.any(Number),
          memoryUsed: expect.any(Number),
          workerCount: expect.any(Number),
        }),
      );
    });

    it('should be idempotent when startMonitoring is called twice', async () => {
      monitor.startMonitoring();
      monitor.startMonitoring(); // Second call should be no-op

      await vi.advanceTimersByTimeAsync(150);

      // Should have logs from one monitoring loop, not two
      const debugLogs = logger.logs.filter(
        (log) => log.level === 'debug' && log.message === 'Resource status published',
      );
      expect(debugLogs.length).toBe(1);
    });

    it('should be safe to call stopMonitoring when not monitoring', () => {
      // Fresh monitor — not started
      expect(() => monitor.stopMonitoring()).not.toThrow();
    });

    it('should not start monitoring when eventBus is not provided', () => {
      const config = createTestConfiguration({
        cpuCoresReserved: 2,
        memoryReserve: MEMORY_1GB,
        resourceMonitorIntervalMs: 100,
      });
      const noEventBusMonitor = new SystemResourceMonitor(config, undefined, logger);

      noEventBusMonitor.startMonitoring();

      expect(noEventBusMonitor['monitoringInterval']).toBeNull();
      expect(noEventBusMonitor['isMonitoring']).toBe(false);
    });

    it('should continue scheduling after performResourceCheck encounters an error', async () => {
      let callCount = 0;
      mockLoadavg = () => {
        callCount++;
        if (callCount === 1) throw new Error('Temporary OS error');
        return [1.0, 1.0, 1.0];
      };

      monitor.startMonitoring();

      // First check → error (monitoring should continue via finally)
      await vi.advanceTimersByTimeAsync(150);

      // Second check → success (monitoring continued past the error)
      await vi.advanceTimersByTimeAsync(150);

      expect(callCount).toBeGreaterThan(1);
      // Should have at least one successful log after recovery
      const debugLogs = logger.logs.filter(
        (log) => log.level === 'debug' && log.message === 'Resource status published',
      );
      expect(debugLogs.length).toBeGreaterThan(0);
    });

    it('should stop monitoring on command', () => {
      monitor.startMonitoring();
      expect(monitor['monitoringInterval']).toBeTruthy();

      monitor.stopMonitoring();
      expect(monitor['monitoringInterval']).toBeNull();
    });
  });

  describe('Error handling', () => {
    it('should handle OS API errors gracefully', async () => {
      mockTotalmem = () => {
        throw new Error('OS API error');
      };

      const result = await monitor.getResources();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Failed to get system resources');
      }
    });

    it('should continue monitoring after errors', async () => {
      vi.useFakeTimers();

      let errorCount = 0;
      mockLoadavg = () => {
        errorCount++;
        if (errorCount <= 2) {
          throw new Error('Temporary error');
        }
        return [1.0, 1.0, 1.0];
      };

      monitor.startMonitoring();

      // Advance through error periods
      await vi.advanceTimersByTimeAsync(300);

      // Should recover after errors clear
      const result = await monitor.getResources();
      expect(result.ok).toBe(true);

      vi.useRealTimers();
    });
  });
});
