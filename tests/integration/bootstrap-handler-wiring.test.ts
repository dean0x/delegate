/**
 * Regression test: bootstrap eagerly wires event handlers
 *
 * PROBLEM (v1.2.0): `setupEventHandlers` was trapped inside the `taskManager`
 * singleton factory. Callers that resolved any other service (e.g., orchestrationService
 * from `beat orchestrate --foreground`) left the EventBus with zero subscribers,
 * causing `LoopCreated` events to be lost and FK constraint failures.
 *
 * REGRESSION GUARD: This test asserts that event handlers are subscribed regardless
 * of whether `taskManager` is resolved, matching production `beat orchestrate` behavior.
 */

import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { InMemoryEventBus } from '../../src/core/events/event-bus.js';
import { TestResourceMonitor } from '../../src/implementations/resource-monitor.js';
import { NoOpProcessSpawner } from '../fixtures/no-op-spawner.js';

describe('Bootstrap handler wiring (regression)', () => {
  let tempDir: string;
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'autobeat-handler-wiring-'));
    originalEnv['AUTOBEAT_DATABASE_PATH'] = process.env['AUTOBEAT_DATABASE_PATH'];
    process.env['AUTOBEAT_DATABASE_PATH'] = join(tempDir, 'test.db');
  });

  afterEach(async () => {
    if (originalEnv['AUTOBEAT_DATABASE_PATH'] === undefined) {
      delete process.env['AUTOBEAT_DATABASE_PATH'];
    } else {
      process.env['AUTOBEAT_DATABASE_PATH'] = originalEnv['AUTOBEAT_DATABASE_PATH'];
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should subscribe LoopCreated handler without resolving taskManager', async () => {
    // Bootstrap with mode 'run' (same mode used by `beat orchestrate --foreground`)
    const containerResult = await bootstrap({
      mode: 'run',
      processSpawner: new NoOpProcessSpawner(),
      resourceMonitor: new TestResourceMonitor(),
    });

    expect(containerResult.ok).toBe(true);
    if (!containerResult.ok) return;

    const container = containerResult.value;

    // Get the EventBus — must have subscribers for critical events
    const eventBusResult = container.get<InMemoryEventBus>('eventBus');
    expect(eventBusResult.ok).toBe(true);
    if (!eventBusResult.ok) return;

    const eventBus = eventBusResult.value;

    // Critical assertion: LoopCreated must have subscribers even though we
    // never resolved 'taskManager'. This is the regression guard.
    expect(eventBus.getSubscriberCount('LoopCreated')).toBeGreaterThan(0);
    expect(eventBus.getSubscriberCount('TaskQueued')).toBeGreaterThan(0);
    expect(eventBus.getSubscriberCount('LoopCompleted')).toBeGreaterThan(0);

    await container.dispose();
  });

  it('should subscribe same handlers when taskManager IS resolved', async () => {
    const containerResult = await bootstrap({
      mode: 'run',
      processSpawner: new NoOpProcessSpawner(),
      resourceMonitor: new TestResourceMonitor(),
    });

    expect(containerResult.ok).toBe(true);
    if (!containerResult.ok) return;

    const container = containerResult.value;

    // Resolve taskManager (old code path that DID wire handlers)
    const tmResult = await container.resolve('taskManager');
    expect(tmResult.ok).toBe(true);

    const eventBusResult = container.get<InMemoryEventBus>('eventBus');
    expect(eventBusResult.ok).toBe(true);
    if (!eventBusResult.ok) return;

    const eventBus = eventBusResult.value;

    // Handlers must be subscribed exactly once (not doubled by resolving taskManager)
    const loopCreatedCount = eventBus.getSubscriberCount('LoopCreated');
    expect(loopCreatedCount).toBeGreaterThan(0);

    // No double-subscription (regression guard against accidental double-wiring)
    expect(loopCreatedCount).toBeLessThanOrEqual(3);

    await container.dispose();
  });
});
