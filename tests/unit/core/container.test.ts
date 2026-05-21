import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Container } from '../../../src/core/container';

describe('Container - Dependency Injection', () => {
  let container: Container;

  beforeEach(() => {
    container = new Container();
  });

  describe('Registration', () => {
    it('should register a singleton and return ok', () => {
      const result = container.registerSingleton('myService', () => ({ name: 'test' }));

      expect(result.ok).toBe(true);
    });

    it('should register a transient and return ok', () => {
      const result = container.registerTransient('myService', () => ({ name: 'test' }));

      expect(result.ok).toBe(true);
    });

    it('should register a value and return ok', () => {
      const result = container.registerValue('myConfig', { port: 3000 });

      expect(result.ok).toBe(true);
    });

    it('should return err when registering duplicate singleton name', () => {
      container.registerSingleton('duplicate', () => 'first');
      const result = container.registerSingleton('duplicate', () => 'second');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('duplicate');
        expect(result.error.message).toContain('already registered');
      }
    });

    it('should return err when registering duplicate transient name', () => {
      container.registerTransient('duplicate', () => 'first');
      const result = container.registerTransient('duplicate', () => 'second');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('already registered');
      }
    });

    it('should return err when registering duplicate value name', () => {
      container.registerValue('duplicate', 'first');
      const result = container.registerValue('duplicate', 'second');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('already registered');
      }
    });

    it('should return err when registration types conflict across methods', () => {
      container.registerSingleton('service', () => 'singleton');

      const transientResult = container.registerTransient('service', () => 'transient');
      expect(transientResult.ok).toBe(false);

      const valueResult = container.registerValue('service', 'value');
      expect(valueResult.ok).toBe(false);
    });

    it('should report has() true after registration, false before', () => {
      expect(container.has('myService')).toBe(false);

      container.registerSingleton('myService', () => 'instance');

      expect(container.has('myService')).toBe(true);
    });

    it('should track multiple independent registrations', () => {
      container.registerSingleton('a', () => 'a');
      container.registerTransient('b', () => 'b');
      container.registerValue('c', 'c');

      expect(container.has('a')).toBe(true);
      expect(container.has('b')).toBe(true);
      expect(container.has('c')).toBe(true);
      expect(container.has('d')).toBe(false);
    });
  });

  describe('resolve() - Async Resolution', () => {
    it('should resolve a singleton and return the same instance each call', async () => {
      let callCount = 0;
      container.registerSingleton('counter', () => {
        callCount++;
        return { id: callCount };
      });

      const first = await container.resolve<{ id: number }>('counter');
      const second = await container.resolve<{ id: number }>('counter');

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (first.ok && second.ok) {
        expect(first.value).toBe(second.value); // Same reference
        expect(first.value.id).toBe(1);
        expect(callCount).toBe(1); // Factory called only once
      }
    });

    it('should resolve a transient and return a new instance each call', async () => {
      let callCount = 0;
      container.registerTransient('counter', () => {
        callCount++;
        return { id: callCount };
      });

      const first = await container.resolve<{ id: number }>('counter');
      const second = await container.resolve<{ id: number }>('counter');

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (first.ok && second.ok) {
        expect(first.value).not.toBe(second.value); // Different references
        expect(first.value.id).toBe(1);
        expect(second.value.id).toBe(2);
        expect(callCount).toBe(2); // Factory called each time
      }
    });

    it('should resolve a registered value and return the exact value', async () => {
      const originalValue = { key: 'config', nested: { deep: true } };
      container.registerValue('config', originalValue);

      const result = await container.resolve<typeof originalValue>('config');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(originalValue); // Same reference
      }
    });

    it('should return err for unregistered service', async () => {
      const result = await container.resolve<string>('nonexistent');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('nonexistent');
        expect(result.error.message).toContain('not registered');
      }
    });

    it('should detect circular dependencies (A -> B -> A)', async () => {
      // Factories that unwrap the inner resolve, propagating the circular error as a throw
      container.registerSingleton('A', async () => {
        const bResult = await container.resolve('B');
        if (!bResult.ok) throw bResult.error;
        return { dep: bResult.value };
      });
      container.registerSingleton('B', async () => {
        const aResult = await container.resolve('A');
        if (!aResult.ok) throw aResult.error;
        return { dep: aResult.value };
      });

      const result = await container.resolve('A');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Circular dependency');
      }
    });

    it('should return circular dependency error Result from inner resolve', async () => {
      // Even without throwing, the inner resolve detects the cycle and returns err
      let innerResult: unknown = null;
      container.registerSingleton('X', async () => {
        const yResult = await container.resolve('Y');
        return { dep: yResult };
      });
      container.registerSingleton('Y', async () => {
        innerResult = await container.resolve('X');
        return { inner: innerResult };
      });

      // X resolves "successfully" because Y's factory doesn't throw,
      // but innerResult captures the circular dependency error
      await container.resolve('X');

      expect(innerResult).toBeDefined();
      const typedResult = innerResult as { ok: boolean; error?: { message: string } };
      expect(typedResult.ok).toBe(false);
      if (!typedResult.ok && typedResult.error) {
        expect(typedResult.error.message).toContain('Circular dependency');
      }
    });

    it('should handle async factories that return promises', async () => {
      container.registerSingleton('asyncService', async () => {
        return { loaded: true };
      });

      const result = await container.resolve<{ loaded: boolean }>('asyncService');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.loaded).toBe(true);
      }
    });

    it('should wrap factory errors in Result error', async () => {
      container.registerSingleton('failing', () => {
        throw new Error('Factory exploded');
      });

      const result = await container.resolve('failing');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Failed to resolve');
        expect(result.error.message).toContain('Factory exploded');
      }
    });

    it('should wrap async factory rejections in Result error', async () => {
      container.registerSingleton('asyncFail', async () => {
        throw new Error('Async factory failed');
      });

      const result = await container.resolve('asyncFail');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Failed to resolve');
        expect(result.error.message).toContain('Async factory failed');
      }
    });

    it('should clean up resolving state after factory error', async () => {
      let shouldFail = true;
      container.registerSingleton('flaky', () => {
        if (shouldFail) {
          shouldFail = false;
          throw new Error('First call fails');
        }
        return { recovered: true };
      });

      const firstAttempt = await container.resolve('flaky');
      expect(firstAttempt.ok).toBe(false);

      // Second attempt should not report circular dependency
      const secondAttempt = await container.resolve<{ recovered: boolean }>('flaky');
      expect(secondAttempt.ok).toBe(true);
      if (secondAttempt.ok) {
        expect(secondAttempt.value.recovered).toBe(true);
      }
    });
  });

  describe('get() - Synchronous Resolution', () => {
    it('should return cached singleton instance', async () => {
      container.registerSingleton('cached', () => ({ value: 42 }));

      // First resolve via async to populate the cache
      await container.resolve('cached');

      const result = container.get<{ value: number }>('cached');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value).toBe(42);
      }
    });

    it('should call sync factory for uncached singleton', () => {
      container.registerSingleton('syncService', () => ({ created: true }));

      const result = container.get<{ created: boolean }>('syncService');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.created).toBe(true);
      }
    });

    it('should return err for async factory (returns Promise)', () => {
      container.registerSingleton('asyncOnly', async () => {
        return { data: 'async' };
      });

      const result = container.get('asyncOnly');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('async factory');
        expect(result.error.message).toContain('use resolve()');
      }
    });

    it('should return err for unregistered service', () => {
      const result = container.get('missing');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('missing');
        expect(result.error.message).toContain('not registered');
      }
    });

    it('should cache singleton after first sync get', () => {
      let callCount = 0;
      container.registerSingleton('onceSyncService', () => {
        callCount++;
        return { id: callCount };
      });

      const first = container.get<{ id: number }>('onceSyncService');
      const second = container.get<{ id: number }>('onceSyncService');

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (first.ok && second.ok) {
        expect(first.value).toBe(second.value);
        expect(callCount).toBe(1);
      }
    });

    it('should wrap sync factory errors in Result error', () => {
      container.registerSingleton('syncFail', () => {
        throw new Error('Sync boom');
      });

      const result = container.get('syncFail');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Failed to get service');
        expect(result.error.message).toContain('Sync boom');
      }
    });
  });

  describe('clear()', () => {
    it('should remove all registrations', () => {
      container.registerSingleton('a', () => 'a');
      container.registerTransient('b', () => 'b');
      container.registerValue('c', 'c');

      container.clear();

      expect(container.has('a')).toBe(false);
      expect(container.has('b')).toBe(false);
      expect(container.has('c')).toBe(false);
    });

    it('should allow re-registration after clear', () => {
      container.registerSingleton('service', () => 'first');
      container.clear();

      const result = container.registerSingleton('service', () => 'second');

      expect(result.ok).toBe(true);
    });
  });

  describe('dispose()', () => {
    it('should emit ShutdownInitiated and ShutdownComplete via eventBus', async () => {
      const emittedEvents: string[] = [];
      const mockEventBus = {
        emit: vi.fn(async (event: string) => {
          emittedEvents.push(event);
        }),
        dispose: vi.fn(),
      };

      container.registerValue('eventBus', mockEventBus);

      await container.dispose();

      expect(emittedEvents[0]).toBe('ShutdownInitiated');
      expect(emittedEvents[emittedEvents.length - 1]).toBe('ShutdownComplete');
    });

    it('should stop resourceMonitor before other cleanup', async () => {
      const callOrder: string[] = [];

      const mockEventBus = {
        emit: vi.fn(async () => {}),
        dispose: vi.fn(),
      };
      const mockResourceMonitor = {
        stopMonitoring: vi.fn(() => {
          callOrder.push('stopMonitoring');
        }),
      };
      const mockWorkerPool = {
        killAll: vi.fn(async () => {
          callOrder.push('killAll');
        }),
      };
      const mockDatabase = {
        close: vi.fn(() => {
          callOrder.push('close');
        }),
      };

      container.registerValue('eventBus', mockEventBus);
      container.registerValue('resourceMonitor', mockResourceMonitor);
      container.registerValue('workerPool', mockWorkerPool);
      container.registerValue('database', mockDatabase);

      await container.dispose();

      expect(callOrder[0]).toBe('stopMonitoring');
      expect(mockResourceMonitor.stopMonitoring).toHaveBeenCalledOnce();
    });

    it('should stop scheduleExecutor', async () => {
      const mockScheduleExecutor = {
        stop: vi.fn(),
      };
      container.registerValue('scheduleExecutor', mockScheduleExecutor);

      await container.dispose();

      expect(mockScheduleExecutor.stop).toHaveBeenCalledOnce();
    });

    it('should kill all workers via workerPool', async () => {
      const mockEventBus = {
        emit: vi.fn(async () => {}),
        dispose: vi.fn(),
      };
      const mockWorkerPool = {
        killAll: vi.fn(async () => {}),
      };

      container.registerValue('eventBus', mockEventBus);
      container.registerValue('workerPool', mockWorkerPool);

      await container.dispose();

      expect(mockWorkerPool.killAll).toHaveBeenCalledOnce();
      // Should emit WorkersTerminating before killing
      expect(mockEventBus.emit).toHaveBeenCalledWith('WorkersTerminating', {});
    });

    it('should close database', async () => {
      const mockEventBus = {
        emit: vi.fn(async () => {}),
        dispose: vi.fn(),
      };
      const mockDatabase = {
        close: vi.fn(),
      };

      container.registerValue('eventBus', mockEventBus);
      container.registerValue('database', mockDatabase);

      await container.dispose();

      expect(mockDatabase.close).toHaveBeenCalledOnce();
      // Should emit DatabaseClosing before closing
      expect(mockEventBus.emit).toHaveBeenCalledWith('DatabaseClosing', {});
    });

    it('should dispose eventBus after emitting ShutdownComplete', async () => {
      const callOrder: string[] = [];
      const mockEventBus = {
        emit: vi.fn(async (event: string) => {
          callOrder.push(`emit:${event}`);
        }),
        dispose: vi.fn(() => {
          callOrder.push('dispose');
        }),
      };

      container.registerValue('eventBus', mockEventBus);

      await container.dispose();

      const shutdownCompleteIndex = callOrder.indexOf('emit:ShutdownComplete');
      const disposeIndex = callOrder.indexOf('dispose');
      expect(shutdownCompleteIndex).toBeLessThan(disposeIndex);
    });

    it('should clear all services after dispose', async () => {
      container.registerValue('eventBus', { emit: vi.fn(async () => {}), dispose: vi.fn() });
      container.registerValue('someService', { data: 'test' });

      await container.dispose();

      expect(container.has('eventBus')).toBe(false);
      expect(container.has('someService')).toBe(false);
    });

    it('should complete without errors when no services are registered', async () => {
      // Should not throw even with empty container
      await expect(container.dispose()).resolves.toBeUndefined();
    });

    it('should handle partial service registration gracefully', async () => {
      // Only eventBus registered, no workerPool, database, etc.
      const mockEventBus = {
        emit: vi.fn(async () => {}),
        dispose: vi.fn(),
      };
      container.registerValue('eventBus', mockEventBus);

      await expect(container.dispose()).resolves.toBeUndefined();
      expect(mockEventBus.emit).toHaveBeenCalledWith('ShutdownInitiated', {});
      expect(mockEventBus.emit).toHaveBeenCalledWith('ShutdownComplete', {});
    });

    it('should follow the correct shutdown order', async () => {
      const callOrder: string[] = [];

      const mockEventBus = {
        emit: vi.fn(async (event: string) => {
          callOrder.push(`emit:${event}`);
        }),
        dispose: vi.fn(() => {
          callOrder.push('eventBus:dispose');
        }),
      };
      const mockResourceMonitor = {
        stopMonitoring: vi.fn(() => {
          callOrder.push('resourceMonitor:stop');
        }),
      };
      const mockScheduleExecutor = {
        stop: vi.fn(() => {
          callOrder.push('scheduleExecutor:stop');
        }),
      };
      const mockWorkerPool = {
        killAll: vi.fn(async () => {
          callOrder.push('workerPool:killAll');
        }),
      };
      // sweepTmuxSessions calls listSessions() then destroySession() per session.
      // Register a session so the sweep is observable in callOrder.
      const mockTmuxSessionManager = {
        listSessions: vi.fn(() => {
          callOrder.push('tmuxSessionManager:listSessions');
          return { ok: true as const, value: [{ name: 'beat-test-session', created: 0 }] };
        }),
        destroySession: vi.fn(() => {
          callOrder.push('tmuxSessionManager:destroySession');
          return { ok: true as const, value: undefined };
        }),
        isAlive: vi.fn(),
        sendControlKeys: vi.fn(),
      };
      const mockDatabase = {
        close: vi.fn(() => {
          callOrder.push('database:close');
        }),
      };

      container.registerValue('eventBus', mockEventBus);
      container.registerValue('resourceMonitor', mockResourceMonitor);
      container.registerValue('scheduleExecutor', mockScheduleExecutor);
      container.registerValue('workerPool', mockWorkerPool);
      container.registerValue('tmuxSessionManager', mockTmuxSessionManager);
      container.registerValue('database', mockDatabase);

      await container.dispose();

      expect(callOrder).toEqual([
        'emit:ShutdownInitiated',
        'resourceMonitor:stop',
        'scheduleExecutor:stop',
        'emit:WorkersTerminating',
        'workerPool:killAll',
        'tmuxSessionManager:listSessions',
        'tmuxSessionManager:destroySession',
        'emit:DatabaseClosing',
        'database:close',
        'emit:ShutdownComplete',
        'eventBus:dispose',
      ]);
    });
  });

  describe('createChild()', () => {
    it('should inherit service definitions from parent', () => {
      container.registerSingleton('service', () => ({ type: 'singleton' }));
      container.registerTransient('transient', () => ({ type: 'transient' }));

      const child = container.createChild();

      expect(child.has('service')).toBe(true);
      expect(child.has('transient')).toBe(true);
    });

    it('should NOT inherit cached instances from parent', async () => {
      let callCount = 0;
      container.registerSingleton('counter', () => {
        callCount++;
        return { id: callCount };
      });

      // Resolve on parent to cache the instance
      const parentResult = await container.resolve<{ id: number }>('counter');
      expect(parentResult.ok).toBe(true);
      if (parentResult.ok) {
        expect(parentResult.value.id).toBe(1);
      }

      const child = container.createChild();

      // Child should create a fresh instance
      const childResult = await child.resolve<{ id: number }>('counter');
      expect(childResult.ok).toBe(true);
      if (childResult.ok) {
        expect(childResult.value.id).toBe(2); // New instance, callCount incremented
      }
    });

    it('should not affect parent when child is modified', () => {
      container.registerSingleton('shared', () => 'shared');

      const child = container.createChild();
      child.registerSingleton('childOnly', () => 'child');

      expect(child.has('childOnly')).toBe(true);
      expect(container.has('childOnly')).toBe(false);
    });

    it('should not be affected by parent modifications after creation', () => {
      container.registerSingleton('initial', () => 'initial');

      const child = container.createChild();

      container.registerSingleton('addedLater', () => 'later');

      expect(container.has('addedLater')).toBe(true);
      expect(child.has('addedLater')).toBe(false);
    });

    it('should produce independent singleton caches between parent and child', async () => {
      let callCount = 0;
      container.registerSingleton('unique', () => {
        callCount++;
        return { instance: callCount };
      });

      const child = container.createChild();

      const parentResult = await container.resolve<{ instance: number }>('unique');
      const childResult = await child.resolve<{ instance: number }>('unique');

      expect(parentResult.ok).toBe(true);
      expect(childResult.ok).toBe(true);
      if (parentResult.ok && childResult.ok) {
        expect(parentResult.value).not.toBe(childResult.value);
        expect(parentResult.value.instance).toBe(1);
        expect(childResult.value.instance).toBe(2);
      }
    });
  });
});
