/**
 * Test Doubles
 * Provides test implementations of core interfaces for testing
 *
 * ARCHITECTURE: These test doubles implement the same interfaces as production
 * code but with controllable behavior for testing. Use these instead of mocks.
 */

import type { ChildProcess } from 'child_process';
import type { SystemResources, Task, TaskId, TaskOutput, Worker, WorkerId } from '../../src/core/domain';
import { taskNotFound } from '../../src/core/errors';
import type {
  EventBus,
  Logger,
  OutputCapture,
  ProcessSpawner,
  ResourceMonitor,
  TaskQueue,
  TaskRepository,
  WorkerPool,
} from '../../src/core/interfaces';
import type { Result } from '../../src/core/result';
import { err, ok } from '../../src/core/result';

/**
 * TestEventBus - EventBus with event tracking capabilities
 */
export class TestEventBus implements EventBus {
  private handlers = new Map<string, Set<(event: unknown) => Promise<void>>>();
  private requestHandlers = new Map<string, (event: unknown) => Promise<Result<unknown, Error>>>();
  private emittedEvents: Array<{ type: string; payload: unknown; timestamp: number }> = [];
  private subscriptionCount = 0;
  private failingEventTypes = new Set<string>();
  // Track subscription ID -> handler for unsubscribe
  private subscriptionToHandler = new Map<string, { eventType: string; handler: (event: unknown) => Promise<void> }>();
  // Track original handler -> subscription ID for removeListener compatibility
  private handlerToSubscription = new Map<(data: unknown) => void, string>();

  async emit<T>(eventType: string, payload: T): Promise<Result<void, Error>> {
    this.emittedEvents.push({
      type: eventType,
      payload,
      timestamp: Date.now(),
    });

    // Test helper: simulate emit failure for specific event types
    if (this.failingEventTypes.has(eventType)) {
      return err(new Error(`Simulated emit failure for ${eventType}`));
    }

    const handlers = this.handlers.get(eventType) || new Set();
    const allHandlers = this.handlers.get('*') || new Set();

    const errors: Error[] = [];

    for (const handler of [...handlers, ...allHandlers]) {
      try {
        await handler({ type: eventType, ...payload });
      } catch (error) {
        errors.push(error as Error);
      }
    }

    if (errors.length > 0) {
      return err(new Error(`Event handler errors: ${errors.map((e) => e.message).join(', ')}`));
    }

    return ok(undefined);
  }

  // Test helper: make specific event types fail on emit
  setEmitFailure(eventType: string, shouldFail: boolean): void {
    if (shouldFail) {
      this.failingEventTypes.add(eventType);
    } else {
      this.failingEventTypes.delete(eventType);
    }
  }

  subscribe<T>(eventType: string, handler: (event: T) => Promise<void>): Result<string, Error> {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }

    this.handlers.get(eventType)!.add(handler as (event: unknown) => Promise<void>);
    this.subscriptionCount++;

    const subscriptionId = `sub-${this.subscriptionCount}`;
    // Track subscription for proper unsubscribe
    this.subscriptionToHandler.set(subscriptionId, {
      eventType,
      handler: handler as (event: unknown) => Promise<void>,
    });
    return ok(subscriptionId);
  }

  subscribeAll(handler: (event: unknown) => Promise<void>): Result<string, Error> {
    return this.subscribe('*', handler);
  }

  unsubscribe(subscriptionId: string): Result<void, Error> {
    const entry = this.subscriptionToHandler.get(subscriptionId);
    if (entry) {
      const handlers = this.handlers.get(entry.eventType);
      if (handlers) {
        handlers.delete(entry.handler);
      }
      this.subscriptionToHandler.delete(subscriptionId);
    }
    return ok(undefined);
  }

  unsubscribeAll(): void {
    this.handlers.clear();
    this.subscriptionToHandler.clear();
    this.handlerToSubscription.clear();
    this.subscriptionCount = 0;
  }

  async request<TRequest, TResponse>(eventType: string, payload: TRequest): Promise<Result<TResponse, Error>> {
    // Track request events for testing
    this.emittedEvents.push({
      type: `request:${eventType}`,
      payload,
      timestamp: Date.now(),
    });

    const handler = this.requestHandlers.get(eventType);
    if (!handler) {
      return err(new Error(`No handler for request type: ${eventType}`));
    }

    return handler(payload) as Promise<Result<TResponse, Error>>;
  }

  onRequest<TRequest, TResponse>(
    eventType: string,
    handler: (event: TRequest) => Promise<Result<TResponse, Error>>,
  ): Result<string, Error> {
    this.requestHandlers.set(eventType, handler as (event: unknown) => Promise<Result<unknown, Error>>);
    return ok(`req-handler-${eventType}`);
  }

  dispose(): void {
    this.unsubscribeAll();
    this.requestHandlers.clear();
    this.emittedEvents = [];
    this.failingEventTypes.clear();
  }

  // Test-specific methods
  getAllEmittedEvents(): Array<{ type: string; payload: unknown; timestamp: number }> {
    return [...this.emittedEvents];
  }

  hasEmitted(eventType: string, payload?: unknown): boolean {
    return this.emittedEvents.some((e) => {
      if (e.type !== eventType) return false;
      if (payload === undefined) return true;
      return JSON.stringify(e.payload) === JSON.stringify(payload);
    });
  }

  getEventCount(eventType: string): number {
    return this.emittedEvents.filter((e) => e.type === eventType).length;
  }

  clearEmittedEvents(): void {
    this.emittedEvents = [];
  }

  on(eventType: string, handler: (data: unknown) => void): () => void {
    const asyncHandler = async (event: unknown) => {
      handler(event);
    };
    this.subscribe(eventType, asyncHandler);
    return () => this.unsubscribe(`mock-unsub`);
  }

  // Additional test helpers for worker-handler tests
  setRequestResponse<TRequest, TResponse>(eventType: string, response: Result<TResponse, Error>): void {
    this.requestHandlers.set(eventType, async (payload: TRequest) => response);
  }

  hasSubscription(eventType: string): boolean {
    return this.handlers.has(eventType) && this.handlers.get(eventType)!.size > 0;
  }

  getEmittedEvents(eventType: string): unknown[] {
    return this.emittedEvents.filter((e) => e.type === eventType).map((e) => e.payload);
  }

  getRequestedEvents(eventType: string): unknown[] {
    // Track requested events (simplified for testing)
    return this.emittedEvents.filter((e) => e.type === `request:${eventType}`).map((e) => e.payload);
  }

  // Event synchronization methods for replacing timing-based waits

  /**
   * Wait for a specific event to be emitted
   * Checks already-emitted events first, then waits for new ones
   */
  async waitFor<T = unknown>(
    eventType: string,
    options: { timeout?: number; filter?: (payload: T) => boolean } = {},
  ): Promise<T> {
    const timeout = options.timeout ?? 5000;
    const filter = options.filter ?? (() => true);

    // Check already-emitted events first
    const existing = this.emittedEvents.find((e) => e.type === eventType && filter(e.payload));
    if (existing) {
      return existing.payload;
    }

    // Otherwise wait for new event
    return new Promise((resolve, reject) => {
      let subscriptionId: string | undefined;

      const handler = async (event: unknown) => {
        if (filter(event)) {
          clearTimeout(timer);
          if (subscriptionId) {
            this.unsubscribe(subscriptionId);
          }
          resolve(event);
        }
      };

      const result = this.subscribe(eventType, handler);
      if (result.ok) {
        subscriptionId = result.value;
      }

      const timer = setTimeout(() => {
        if (subscriptionId) {
          this.unsubscribe(subscriptionId);
        }
        reject(new Error(`Timeout waiting for '${eventType}' after ${timeout}ms`));
      }, timeout);
    });
  }

  /**
   * Flush all pending microtasks and event loop cycles
   * Useful when handlers have completed but microtasks are pending
   */
  async flushHandlers(): Promise<void> {
    // Process microtasks first
    await Promise.resolve();
    // Then process any setImmediate callbacks
    await new Promise((resolve) => setImmediate(resolve));
  }

  /**
   * Subscribe to a single event occurrence (Node EventEmitter style)
   * Handler auto-unsubscribes after first invocation
   */
  once(eventType: string, handler: (data: unknown) => void): void {
    let subscriptionId: string | undefined;

    const wrappedHandler = async (event: unknown) => {
      // Unsubscribe first to prevent any race conditions
      if (subscriptionId) {
        this.unsubscribe(subscriptionId);
        // Clean up handler mapping
        this.handlerToSubscription.delete(handler);
      }
      handler(event);
    };

    const result = this.subscribe(eventType, wrappedHandler);
    if (result.ok) {
      subscriptionId = result.value;
      // Track original handler -> subscription for removeListener compatibility
      this.handlerToSubscription.set(handler, subscriptionId);
    }
  }

  /**
   * Remove a specific event listener (for compatibility with event-helpers.ts)
   */
  removeListener(eventType: string, handler: (data: unknown) => void): void {
    // First check if we have a subscription ID for this handler (from once())
    const subscriptionId = this.handlerToSubscription.get(handler);
    if (subscriptionId) {
      this.unsubscribe(subscriptionId);
      this.handlerToSubscription.delete(handler);
      return;
    }

    // Fallback: try direct removal for handlers registered via on()
    const handlers = this.handlers.get(eventType);
    if (handlers) {
      handlers.delete(handler as (event: unknown) => Promise<void>);
    }
  }
}

/**
 * TestLogger - Logger that captures log entries for assertions
 */
export class TestLogger implements Logger {
  public logs: Array<{
    level: string;
    message: string;
    context?: Record<string, unknown>;
    timestamp: number;
  }> = [];

  info(message: string, context?: Record<string, unknown>): void {
    this.logs.push({ level: 'info', message, context, timestamp: Date.now() });
  }

  error(message: string, error?: Error, context?: Record<string, unknown>): void {
    this.logs.push({
      level: 'error',
      message,
      context: { ...context, error } as Record<string, unknown>,
      timestamp: Date.now(),
    });
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.logs.push({ level: 'warn', message, context, timestamp: Date.now() });
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.logs.push({ level: 'debug', message, context, timestamp: Date.now() });
  }

  child(context: Record<string, unknown>): Logger {
    const childLogger = new TestLogger();
    childLogger.logs = this.logs; // Share logs with parent
    return childLogger;
  }

  hasLog(level: string, message: string): boolean {
    return this.logs.some((log) => log.level === level && log.message === message);
  }

  hasLogContaining(substring: string): boolean {
    return this.logs.some((log) => log.message.includes(substring));
  }

  getLogsByLevel(level: string): typeof this.logs {
    return this.logs.filter((log) => log.level === level);
  }

  clear(): void {
    this.logs = [];
  }
}

/**
 * TestTaskRepository - In-memory task repository for testing
 */
export class TestTaskRepository implements TaskRepository {
  private tasks = new Map<TaskId, Task>();
  private saveError: Error | null = null;
  private findError: Error | null = null;

  async save(task: Task): Promise<Result<void, Error>> {
    if (this.saveError) {
      return err(this.saveError);
    }
    this.tasks.set(task.id, { ...task });
    return ok(undefined);
  }

  async update(id: TaskId, updates: Partial<Task>): Promise<Result<void, Error>> {
    const task = this.tasks.get(id);
    if (!task) {
      return err(taskNotFound(id));
    }
    this.tasks.set(id, { ...task, ...updates, updatedAt: Date.now() });
    return ok(undefined);
  }

  async findById(id: TaskId): Promise<Result<Task | null, Error>> {
    if (this.findError) {
      return err(this.findError);
    }
    const task = this.tasks.get(id);
    return ok(task || null);
  }

  /** Default pagination limit for findAll() */
  private static readonly DEFAULT_LIMIT = 100;

  async findAll(limit?: number, offset?: number): Promise<Result<Task[], Error>> {
    if (this.findError) {
      return err(this.findError);
    }
    // Sort by created_at DESC to match production behavior
    const all = Array.from(this.tasks.values()).sort((a, b) => b.createdAt - a.createdAt);
    const effectiveLimit = limit ?? TestTaskRepository.DEFAULT_LIMIT;
    const effectiveOffset = offset ?? 0;
    return ok(all.slice(effectiveOffset, effectiveOffset + effectiveLimit));
  }

  async findAllUnbounded(): Promise<Result<Task[], Error>> {
    if (this.findError) {
      return err(this.findError);
    }
    // Sort by created_at DESC to match production behavior
    return ok(Array.from(this.tasks.values()).sort((a, b) => b.createdAt - a.createdAt));
  }

  async count(): Promise<Result<number, Error>> {
    if (this.findError) {
      return err(this.findError);
    }
    return ok(this.tasks.size);
  }

  async findByStatus(status: Task['status']): Promise<Result<Task[], Error>> {
    if (this.findError) {
      return err(this.findError);
    }
    // Sort by created_at DESC to match production behavior
    const tasks = Array.from(this.tasks.values())
      .filter((t) => t.status === status)
      .sort((a, b) => b.createdAt - a.createdAt);
    return ok(tasks);
  }

  async delete(id: TaskId): Promise<Result<void, Error>> {
    if (!this.tasks.has(id)) {
      return err(taskNotFound(id));
    }
    this.tasks.delete(id);
    return ok(undefined);
  }

  async cleanupOldTasks(olderThanMs: number): Promise<Result<number, Error>> {
    const cutoffTime = Date.now() - olderThanMs;
    let deletedCount = 0;
    for (const [id, task] of this.tasks.entries()) {
      if (task.completedAt && task.completedAt < cutoffTime) {
        this.tasks.delete(id);
        deletedCount++;
      }
    }
    return ok(deletedCount);
  }

  async deleteAll(): Promise<Result<void, Error>> {
    this.tasks.clear();
    return ok(undefined);
  }

  // Test-specific methods
  setSaveError(error: Error | null): void {
    this.saveError = error;
  }

  setFindError(error: Error | null): void {
    this.findError = error;
  }

  getTaskCount(): number {
    return this.tasks.size;
  }

  hasTask(id: TaskId): boolean {
    return this.tasks.has(id);
  }

  clear(): void {
    this.tasks.clear();
    this.saveError = null;
    this.findError = null;
  }
}

/**
 * TestProcessSpawner - Controllable process spawner for testing
 */
export class TestProcessSpawner implements ProcessSpawner {
  private processes = new Map<string, { pid: number; killed: boolean }>();
  private spawnError: Error | null = null;
  private nextPid = 1000;
  private outputHandlers = new Map<string, (data: string) => void>();

  async spawn(
    command: string,
    args: string[],
    options?: Record<string, unknown>,
  ): Promise<Result<{ process: ChildProcess; workerId: string }, Error>> {
    if (this.spawnError) {
      return err(this.spawnError);
    }

    const workerId = `worker-${this.nextPid}`;
    const pid = this.nextPid++;

    this.processes.set(workerId, { pid, killed: false });

    const mockProcess = {
      pid,
      kill: () => {
        const proc = this.processes.get(workerId);
        if (proc) {
          proc.killed = true;
        }
        return true;
      },
      on: (_event: string, _handler: (...args: unknown[]) => void) => {
        // Mock event handling
      },
      stdout: {
        on: (event: string, handler: (data: string) => void) => {
          if (event === 'data') {
            this.outputHandlers.set(`${workerId}-stdout`, handler);
          }
        },
      },
      stderr: {
        on: (event: string, handler: (data: string) => void) => {
          if (event === 'data') {
            this.outputHandlers.set(`${workerId}-stderr`, handler);
          }
        },
      },
    } as unknown as ChildProcess;

    return ok({ process: mockProcess, workerId });
  }

  async kill(pid: number): Promise<Result<void, Error>> {
    const entry = Array.from(this.processes.entries()).find(([_, p]) => p.pid === pid);
    if (!entry) {
      return err(new Error(`Process ${pid} not found`));
    }
    entry[1].killed = true;
    return ok(undefined);
  }

  // Test-specific methods
  setSpawnError(error: Error | null): void {
    this.spawnError = error;
  }

  simulateOutput(workerId: string, stream: 'stdout' | 'stderr', data: string): void {
    const handler = this.outputHandlers.get(`${workerId}-${stream}`);
    if (handler) {
      handler(Buffer.from(data));
    }
  }

  simulateExit(workerId: string, code: number): void {
    // Simulate process exit
    const proc = this.processes.get(workerId);
    if (proc) {
      proc.killed = true;
    }
  }

  isProcessKilled(workerId: string): boolean {
    return this.processes.get(workerId)?.killed || false;
  }

  clear(): void {
    this.processes.clear();
    this.outputHandlers.clear();
    this.spawnError = null;
    this.nextPid = 1000;
  }
}

/**
 * TestResourceMonitor - Controllable resource monitor for testing
 * Implements ResourceMonitor interface from src/core/interfaces.ts
 */
export class TestResourceMonitor implements ResourceMonitor {
  private cpuUsage = 50;
  private availableMemory = 4_000_000_000;
  private totalMemory = 8_000_000_000;
  private loadAvg: readonly [number, number, number] = [1.0, 1.0, 1.0];
  private workerCount = 0;
  private canSpawn = true;
  private cpuThreshold = 80;
  private memoryReserve = 1_000_000_000;

  async getResources(): Promise<Result<SystemResources>> {
    return ok({
      cpuUsage: this.cpuUsage,
      availableMemory: this.availableMemory,
      totalMemory: this.totalMemory,
      loadAverage: this.loadAvg,
      workerCount: this.workerCount,
    });
  }

  async canSpawnWorker(): Promise<Result<boolean>> {
    if (!this.canSpawn) {
      return ok(false);
    }
    return ok(this.cpuUsage < this.cpuThreshold && this.availableMemory > this.memoryReserve);
  }

  getThresholds(): { readonly maxCpuPercent: number; readonly minMemoryBytes: number } {
    return {
      maxCpuPercent: this.cpuThreshold,
      minMemoryBytes: this.memoryReserve,
    };
  }

  incrementWorkerCount(): void {
    this.workerCount++;
  }

  decrementWorkerCount(): void {
    if (this.workerCount > 0) {
      this.workerCount--;
    }
  }

  recordSpawn(): void {
    // INTENTIONAL NO-OP: Test double doesn't track settling workers because:
    // 1. Tests use MockWorkerPool - no real processes are spawned
    // 2. Settling worker tracking is a production autoscaling concern
    // 3. Tests verify behavior via MockWorkerPool.spawn() calls instead
  }

  // Test-specific methods
  setResources(resources: Partial<SystemResources>): void {
    if (resources.cpuUsage !== undefined) this.cpuUsage = resources.cpuUsage;
    if (resources.availableMemory !== undefined) this.availableMemory = resources.availableMemory;
    if (resources.totalMemory !== undefined) this.totalMemory = resources.totalMemory;
    if (resources.loadAverage !== undefined) this.loadAvg = resources.loadAverage;
    if (resources.workerCount !== undefined) this.workerCount = resources.workerCount;
  }

  setCpuUsage(percent: number): void {
    this.cpuUsage = percent;
  }

  setMemory(used: number, total: number): void {
    this.availableMemory = total - used;
    this.totalMemory = total;
  }

  setCanSpawnWorker(can: boolean): void {
    this.canSpawn = can;
  }

  getCurrentWorkerCount(): number {
    return this.workerCount;
  }

  simulateHighLoad(): void {
    this.setCpuUsage(95);
    this.setMemory(7500000000, 8000000000);
    this.setCanSpawnWorker(false);
  }

  simulateLowLoad(): void {
    this.setCpuUsage(20);
    this.setMemory(2000000000, 8000000000);
    this.setCanSpawnWorker(true);
  }
}

/**
 * TestOutputCapture - Controllable output capture for testing
 */
export class TestOutputCapture implements OutputCapture {
  private outputs = new Map<TaskId, { stdout: string[]; stderr: string[]; totalSize: number }>();
  private captureError: Error | null = null;

  capture(taskId: TaskId, stream: 'stdout' | 'stderr', data: string): Result<void, Error> {
    if (this.captureError) {
      return err(this.captureError);
    }

    if (!this.outputs.has(taskId)) {
      this.outputs.set(taskId, { stdout: [], stderr: [], totalSize: 0 });
    }

    const output = this.outputs.get(taskId)!;
    output[stream].push(data);
    output.totalSize += data.length;

    return ok(undefined);
  }

  getOutput(taskId: TaskId, _tail?: number): Result<TaskOutput, Error> {
    const output = this.outputs.get(taskId);

    if (!output) {
      return ok({
        taskId,
        stdout: [],
        stderr: [],
        totalSize: 0,
      });
    }

    return ok({
      taskId,
      stdout: output.stdout,
      stderr: output.stderr,
      totalSize: output.totalSize,
    });
  }

  clear(taskId: TaskId): Result<void, Error> {
    this.outputs.delete(taskId);
    return ok(undefined);
  }

  cleanup(): void {
    this.outputs.clear();
  }

  // Test-specific methods
  setCaptureError(error: Error | null): void {
    this.captureError = error;
  }

  hasOutput(taskId: TaskId): boolean {
    return this.outputs.has(taskId);
  }

  getOutputCount(): number {
    return this.outputs.size;
  }
}
