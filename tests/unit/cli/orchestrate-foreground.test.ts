/**
 * Unit tests for waitForLoopCompletion
 * ARCHITECTURE: Tests the extracted event subscription + wait logic
 * that monitors loop lifecycle events in foreground orchestration mode.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfiguration } from '../../../src/core/configuration.js';
import { LoopId } from '../../../src/core/domain.js';
import { InMemoryEventBus } from '../../../src/core/events/event-bus.js';
import type { Container } from '../../../src/core/container.js';
import { err, ok } from '../../../src/core/result.js';
import { waitForLoopCompletion } from '../../../src/cli/commands/orchestrate.js';
import { createMockLogger } from '../../fixtures/mocks.js';

function createMockContainer(eventBus: InMemoryEventBus): Container {
  return {
    get: (key: string) => {
      if (key === 'eventBus') return ok(eventBus);
      return err(new Error(`Unknown key: ${key}`));
    },
  } as unknown as Container;
}

describe('waitForLoopCompletion', () => {
  let eventBus: InMemoryEventBus;
  let container: Container;
  const loopId = LoopId('loop-test-1');

  beforeEach(() => {
    eventBus = new InMemoryEventBus(loadConfiguration(), createMockLogger());
    container = createMockContainer(eventBus);
  });

  afterEach(() => {
    eventBus.dispose();
  });

  it('should resolve with 0 on LoopCompleted', async () => {
    const promise = waitForLoopCompletion(container, loopId);

    // Emit after subscription
    await eventBus.emit('LoopCompleted', { loopId, reason: 'done' });

    const exitCode = await promise;
    expect(exitCode).toBe(0);
  });

  it('should resolve with 1 on LoopCancelled', async () => {
    const promise = waitForLoopCompletion(container, loopId);

    await eventBus.emit('LoopCancelled', { loopId, reason: 'user cancelled' });

    const exitCode = await promise;
    expect(exitCode).toBe(1);
  });

  it('should ignore events for other loopIds', async () => {
    const promise = waitForLoopCompletion(container, loopId);

    // Emit for a different loop — should not resolve
    await eventBus.emit('LoopCompleted', { loopId: LoopId('loop-other'), reason: 'done' });

    // Verify not resolved yet by racing with a timeout
    const result = await Promise.race([
      promise.then((code) => ({ resolved: true, code })),
      new Promise<{ resolved: false }>((resolve) => setTimeout(() => resolve({ resolved: false }), 50)),
    ]);
    expect(result.resolved).toBe(false);

    // Now emit for the correct loop
    await eventBus.emit('LoopCompleted', { loopId, reason: 'done' });
    const exitCode = await promise;
    expect(exitCode).toBe(0);
  });

  it('should only resolve once when both events fire rapidly', async () => {
    const promise = waitForLoopCompletion(container, loopId);

    // Fire both events rapidly
    await eventBus.emit('LoopCompleted', { loopId, reason: 'done' });
    await eventBus.emit('LoopCancelled', { loopId, reason: 'cancelled' });

    const exitCode = await promise;
    // First event wins (LoopCompleted → 0)
    expect(exitCode).toBe(0);
  });

  it('should resolve with 1 when eventBus is unavailable', async () => {
    const uiErrorSpy = vi.spyOn(await import('../../../src/cli/ui.js'), 'error').mockImplementation(() => {});

    const badContainer = {
      get: () => err(new Error('No event bus')),
    } as unknown as Container;

    const exitCode = await waitForLoopCompletion(badContainer, loopId);

    expect(exitCode).toBe(1);
    uiErrorSpy.mockRestore();
  });
});
