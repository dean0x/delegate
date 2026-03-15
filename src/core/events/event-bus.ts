/**
 * Event bus implementation for coordinating system events
 * Provides pub/sub pattern for loosely coupled components
 */

import { Configuration } from '../configuration.js';
import { BackbeatError, ErrorCode } from '../errors.js';
import { Logger } from '../interfaces.js';
import { err, ok, Result } from '../result.js';
import { BackbeatEvent, BaseEvent, createEvent, EventHandler } from './events.js';

/**
 * Event bus interface for dependency injection
 *
 * ARCHITECTURE: Supports both fire-and-forget (emit) and request-response (request) patterns
 * for hybrid event-driven architecture. Commands flow through events; queries use direct repository access.
 */
export interface EventBus {
  emit<T extends BackbeatEvent>(type: T['type'], payload: Omit<T, keyof BaseEvent | 'type'>): Promise<Result<void>>;
  request<T extends BackbeatEvent, R = unknown>(
    type: T['type'],
    payload: Omit<T, keyof BaseEvent | 'type'>,
  ): Promise<Result<R>>;
  subscribe<T extends BackbeatEvent>(eventType: T['type'], handler: EventHandler<T>): Result<string>;
  unsubscribe(subscriptionId: string): Result<void>;
  subscribeAll(handler: EventHandler): Result<string>;
  unsubscribeAll(): void;
  dispose?(): void; // Optional cleanup method

  // Additional convenience methods for testing compatibility
  // biome-ignore lint/suspicious/noExplicitAny: testing convenience methods — `unknown` would break all test call sites for no safety gain
  on?(event: string, handler: (data: any) => void): string;
  off?(event: string, subscriptionId: string): void;
  // biome-ignore lint/suspicious/noExplicitAny: testing convenience methods — `unknown` would break all test call sites for no safety gain
  once?(event: string, handler: (data: any) => void): void;
  // biome-ignore lint/suspicious/noExplicitAny: testing convenience methods — `unknown` would break all test call sites for no safety gain
  onRequest?(event: string, handler: (data: any) => Promise<Result<any>>): string;
  respond?<T = unknown>(correlationId: string, response: T): boolean;
  respondError?(correlationId: string, error: Error): boolean;
}

/**
 * Pending request tracking with proper typing
 */
interface PendingRequest<T = unknown> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timeoutId: NodeJS.Timeout;
  timestamp: number;
  resolved: boolean;
}

/**
 * In-memory event bus implementation
 */
export class InMemoryEventBus implements EventBus {
  private readonly handlers = new Map<string, EventHandler[]>();
  private readonly globalHandlers: EventHandler[] = [];
  private readonly subscriptions = new Map<string, { eventType?: string; handler: EventHandler; isGlobal: boolean }>();
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private subscriptionCounter = 0;
  private cleanupInterval?: NodeJS.Timeout;
  private readonly maxRequestAge: number;
  private readonly defaultRequestTimeoutMs: number;
  private readonly maxListenersPerEvent: number;
  private readonly maxTotalSubscriptions: number;

  constructor(
    config: Configuration,
    private readonly logger: Logger,
  ) {
    // SECURITY: Use safe defaults instead of non-null assertions to prevent runtime crashes
    // These match ConfigurationSchema defaults from configuration.ts
    this.maxListenersPerEvent = config.maxListenersPerEvent ?? 100;
    this.maxTotalSubscriptions = config.maxTotalSubscriptions ?? 1000;
    this.maxRequestAge = config.eventCleanupIntervalMs ?? 60000;
    this.defaultRequestTimeoutMs = config.eventRequestTimeoutMs ?? 5000;
    // Start cleanup interval to prevent memory leaks
    this.startCleanupInterval();
  }

  /**
   * Start periodic cleanup of stale pending requests
   * ARCHITECTURE: Timer uses unref() to allow process exit without explicit cleanup
   */
  private startCleanupInterval(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanupStaleRequests();
    }, this.maxRequestAge); // Use configured cleanup interval

    // Allow Node.js to exit if this timer is the only thing keeping it alive
    // This prevents blocking process exit in tests or short-lived processes
    this.cleanupInterval.unref();
  }

  /**
   * Clean up stale pending requests to prevent memory leaks
   */
  private cleanupStaleRequests(): void {
    const now = Date.now();
    const staleRequests: string[] = [];

    for (const [id, request] of this.pendingRequests) {
      if (now - request.timestamp > this.maxRequestAge) {
        staleRequests.push(id);
      }
    }

    for (const id of staleRequests) {
      const request = this.pendingRequests.get(id);
      if (request) {
        clearTimeout(request.timeoutId);
        this.pendingRequests.delete(id);
        this.logger.warn('Cleaned up stale request', { correlationId: id, age: now - request.timestamp });
      }
    }
  }

  /**
   * Clean up resources when shutting down
   * ARCHITECTURE: Complete cleanup to prevent memory leaks in tests
   */
  public dispose(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }

    // Clear all pending requests
    for (const request of this.pendingRequests.values()) {
      clearTimeout(request.timeoutId);
    }
    this.pendingRequests.clear();

    // CRITICAL: Clear all event handlers to prevent memory leaks
    this.handlers.clear();
    this.globalHandlers.length = 0;
    this.subscriptions.clear();
    this.subscriptionCounter = 0;

    this.logger.debug('EventBus disposed', {
      handlersCleared: true,
      subscriptionsCleared: true,
      pendingRequestsCleared: true,
    });
  }

  async emit<T extends BackbeatEvent>(
    type: T['type'],
    payload: Omit<T, keyof BaseEvent | 'type'>,
  ): Promise<Result<void>> {
    const event = createEvent(type, payload) as T;

    this.logger.debug('Event emitted', {
      eventType: event.type,
      eventId: event.eventId,
      timestamp: event.timestamp,
    });

    try {
      // Get specific handlers for this event type
      const specificHandlers = this.handlers.get(type) || [];

      // Combine with global handlers
      const allHandlers = [...specificHandlers, ...this.globalHandlers];

      // Log if no subscribers
      if (allHandlers.length === 0) {
        this.logger.debug('No subscribers for event type', { eventType: type });
      }

      // Execute all handlers in parallel with performance profiling
      const startTime = Date.now();
      const handlerPromises = allHandlers.map(async (handler, index) => {
        const handlerStart = Date.now();
        try {
          const result = await handler(event);
          const duration = Date.now() - handlerStart;

          // PERFORMANCE: Warn about slow handlers (>100ms)
          if (duration > 100) {
            this.logger.warn('Slow event handler detected', {
              eventType: type,
              handlerIndex: index,
              duration,
              threshold: 100,
            });
          }

          return { status: 'fulfilled' as const, value: result, duration };
        } catch (error) {
          const duration = Date.now() - handlerStart;
          return { status: 'rejected' as const, reason: error, duration };
        }
      });

      const results = await Promise.all(handlerPromises);
      const totalDuration = Date.now() - startTime;

      // Log performance metrics for all handlers
      this.logger.debug('Event handlers completed', {
        eventType: type,
        eventId: event.eventId,
        handlerCount: allHandlers.length,
        totalDuration,
        slowHandlers: results.filter((r) => r.duration > 100).length,
      });

      // Check for handler failures
      const failures = results.filter((result) => result.status === 'rejected');

      if (failures.length > 0) {
        this.logger.error('Event handler failures', undefined, {
          eventType: type,
          eventId: event.eventId,
          failures: failures.map((f) => f.reason),
          durations: failures.map((f) => f.duration),
        });

        // Return error if any handler failed
        return err(
          new BackbeatError(
            ErrorCode.SYSTEM_ERROR,
            `Event handler failures for ${type}: ${failures.map((f) => f.reason).join(', ')}`,
            { eventId: event.eventId, failures: failures.length },
          ),
        );
      }

      return ok(undefined);
    } catch (error) {
      this.logger.error('Event emission failed', error as Error, {
        eventType: type,
        eventId: event.eventId,
      });

      return err(
        new BackbeatError(ErrorCode.SYSTEM_ERROR, `Event emission failed for ${type}: ${error}`, {
          eventId: event.eventId,
        }),
      );
    }
  }

  /**
   * Request-response pattern for query events with proper correlation
   * ARCHITECTURE: Thread-safe implementation using correlation IDs and promises
   * Includes automatic timeout (default 5s) to prevent hanging queries
   */
  async request<T extends BackbeatEvent, R = unknown>(
    type: T['type'],
    payload: Omit<T, keyof BaseEvent | 'type'>,
    timeoutMs: number = this.defaultRequestTimeoutMs,
  ): Promise<Result<R>> {
    const correlationId = crypto.randomUUID();

    return new Promise<Result<R>>((resolve) => {
      // Set up timeout
      const timeoutId = setTimeout(() => {
        const pending = this.pendingRequests.get(correlationId);
        if (pending) {
          this.pendingRequests.delete(correlationId);
          this.logger.error('Request timeout', undefined, {
            eventType: type,
            correlationId,
            timeoutMs,
          });
          resolve(err(new BackbeatError(ErrorCode.SYSTEM_ERROR, `Request timeout after ${timeoutMs}ms for ${type}`)));
        }
      }, timeoutMs);

      // Store pending request with timestamp and resolved flag
      const pendingRequest: PendingRequest<R> = {
        resolve: (value: R) => {
          if (!pendingRequest.resolved) {
            pendingRequest.resolved = true;
            clearTimeout(timeoutId);
            this.pendingRequests.delete(correlationId);
            resolve(ok(value));
          }
        },
        reject: (error: Error) => {
          if (!pendingRequest.resolved) {
            pendingRequest.resolved = true;
            clearTimeout(timeoutId);
            this.pendingRequests.delete(correlationId);
            resolve(
              err(error instanceof BackbeatError ? error : new BackbeatError(ErrorCode.SYSTEM_ERROR, error.message)),
            );
          }
        },
        timeoutId,
        timestamp: Date.now(),
        resolved: false,
      };

      this.pendingRequests.set(correlationId, pendingRequest as PendingRequest);

      // Emit event with correlation ID
      const event = createEvent(type, {
        ...(payload as Record<string, unknown>),
        __correlationId: correlationId,
        // biome-ignore lint/suspicious/noExplicitAny: createEvent requires Omit<T> but we're merging runtime fields
      } as any as Omit<T, keyof BaseEvent | 'type'>) as T;

      this.logger.debug('Request event emitted', {
        eventType: event.type,
        eventId: event.eventId,
        correlationId,
      });

      // Get handlers for this event type
      const handlers = this.handlers.get(type) || [];

      if (handlers.length === 0) {
        const pending = this.pendingRequests.get(correlationId);
        if (pending) {
          pending.reject(new BackbeatError(ErrorCode.SYSTEM_ERROR, `No handlers registered for query: ${type}`));
        }
        return;
      }

      // Execute handler asynchronously
      handlers[0](event).catch((error) => {
        const pending = this.pendingRequests.get(correlationId);
        if (pending) {
          pending.reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  }

  /**
   * Respond to a request with a correlation ID
   * Used by handlers to send responses back to request callers
   * @template T The response type
   * @param correlationId The correlation ID of the request
   * @param response The response value
   * @returns true if response was sent, false if already resolved or not found
   */
  respond<T = unknown>(correlationId: string, response: T): boolean {
    const pending = this.pendingRequests.get(correlationId);
    if (pending && !pending.resolved) {
      pending.resolve(response);
      return true;
    }

    if (pending?.resolved) {
      this.logger.warn('Attempted to respond to already resolved request', { correlationId });
    }

    return false;
  }

  /**
   * Respond to a request with an error
   * Used by handlers to send errors back to request callers
   * @param correlationId The correlation ID of the request
   * @param error The error to send
   * @returns true if error was sent, false if already resolved or not found
   */
  respondError(correlationId: string, error: Error): boolean {
    const pending = this.pendingRequests.get(correlationId);
    if (pending && !pending.resolved) {
      pending.reject(error);
      return true;
    }

    if (pending?.resolved) {
      this.logger.warn('Attempted to reject already resolved request', { correlationId });
    }

    return false;
  }

  subscribe<T extends BackbeatEvent>(eventType: T['type'], handler: EventHandler<T>): Result<string> {
    // Check global subscription limit
    if (this.subscriptions.size >= this.maxTotalSubscriptions) {
      this.logger.error('Maximum total subscriptions reached', undefined, {
        limit: this.maxTotalSubscriptions,
        current: this.subscriptions.size,
      });
      return err(
        new BackbeatError(
          ErrorCode.RESOURCE_LIMIT_EXCEEDED,
          `Maximum subscription limit (${this.maxTotalSubscriptions}) reached`,
        ),
      );
    }

    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, []);
    }

    const handlers = this.handlers.get(eventType)!;

    // Check per-event listener limit (warn only, don't fail)
    if (handlers.length >= this.maxListenersPerEvent) {
      this.logger.warn('Maximum listeners per event approaching limit', {
        eventType,
        limit: this.maxListenersPerEvent,
        current: handlers.length,
      });
    }

    handlers.push(handler as EventHandler);

    // Generate subscription ID
    const subscriptionId = `sub-${++this.subscriptionCounter}`;
    this.subscriptions.set(subscriptionId, {
      eventType,
      handler: handler as EventHandler,
      isGlobal: false,
    });

    this.logger.debug('Event handler subscribed', {
      eventType,
      subscriptionId,
      handlerCount: handlers.length,
    });

    return ok(subscriptionId);
  }

  unsubscribe(subscriptionId: string): Result<void> {
    const subscription = this.subscriptions.get(subscriptionId);

    if (!subscription) {
      return err(new BackbeatError(ErrorCode.CONFIGURATION_ERROR, `Subscription not found: ${subscriptionId}`));
    }

    // Remove from subscriptions map
    this.subscriptions.delete(subscriptionId);

    // Remove handler from appropriate list
    if (subscription.isGlobal) {
      const index = this.globalHandlers.indexOf(subscription.handler);
      if (index !== -1) {
        this.globalHandlers.splice(index, 1);
      }
    } else if (subscription.eventType) {
      const handlers = this.handlers.get(subscription.eventType);
      if (handlers) {
        const index = handlers.indexOf(subscription.handler);
        if (index !== -1) {
          handlers.splice(index, 1);
        }
      }
    }

    this.logger.debug('Handler unsubscribed', {
      subscriptionId,
      eventType: subscription.eventType || 'global',
      isGlobal: subscription.isGlobal,
    });

    return ok(undefined);
  }

  subscribeAll(handler: EventHandler): Result<string> {
    this.globalHandlers.push(handler);

    // Generate subscription ID for global handler
    const subscriptionId = `global-${++this.subscriptionCounter}`;
    this.subscriptions.set(subscriptionId, {
      handler,
      isGlobal: true,
    });

    this.logger.debug('Global event handler subscribed', {
      subscriptionId,
      globalHandlerCount: this.globalHandlers.length,
    });

    return ok(subscriptionId);
  }

  unsubscribeAll(): void {
    // Clear all handlers
    this.handlers.clear();
    this.globalHandlers.length = 0;
    this.subscriptions.clear();

    this.logger.debug('All handlers unsubscribed');
  }

  /**
   * Get current subscription statistics
   */
  getStats(): { eventTypes: number; totalHandlers: number; globalHandlers: number } {
    const totalHandlers = Array.from(this.handlers.values()).reduce((sum, handlers) => sum + handlers.length, 0);

    return {
      eventTypes: this.handlers.size,
      totalHandlers,
      globalHandlers: this.globalHandlers.length,
    };
  }

  /**
   * Convenience method for testing - similar to Node's EventEmitter
   */
  // biome-ignore lint/suspicious/noExplicitAny: testing convenience — mirrors Node EventEmitter API
  on(event: string, handler: (data: any) => void): string {
    const wrappedHandler: EventHandler = async (evt) => {
      handler(evt);
    };
    // biome-ignore lint/suspicious/noExplicitAny: string event name can't be narrowed to BackbeatEvent union at this call site
    const result = this.subscribe(event as any, wrappedHandler);
    return result.ok ? result.value : '';
  }

  /**
   * Convenience method for testing - unsubscribe by event and subscription ID
   */
  off(event: string, subscriptionId: string): void {
    this.unsubscribe(subscriptionId);
  }

  /**
   * Convenience method for testing - one-time event listener
   */
  // biome-ignore lint/suspicious/noExplicitAny: testing convenience — mirrors Node EventEmitter API
  once(event: string, handler: (data: any) => void): void {
    const subscriptionId = this.on(event, (data) => {
      handler(data);
      this.unsubscribe(subscriptionId);
    });
  }

  /**
   * Convenience method for testing - handle request/response pattern
   */
  // biome-ignore lint/suspicious/noExplicitAny: testing convenience — handler receives untyped event payloads
  onRequest(event: string, handler: (data: any) => Promise<Result<any>>): string {
    const wrappedHandler: EventHandler = async (evt) => {
      const correlationId = evt.__correlationId;
      if (!correlationId) return;

      try {
        const result = await handler(evt);
        if (this.pendingRequests.has(correlationId)) {
          this.respond(correlationId, result.ok ? result.value : undefined);
        }
      } catch (error) {
        if (this.pendingRequests.has(correlationId)) {
          this.respondError(correlationId, error as Error);
        }
      }
    };
    // biome-ignore lint/suspicious/noExplicitAny: string event name can't be narrowed to BackbeatEvent union at this call site
    const result = this.subscribe(event as any, wrappedHandler);
    return result.ok ? result.value : '';
  }
}

/**
 * Null event bus for testing - events are emitted but not processed
 */
export class NullEventBus implements EventBus {
  private subscriptionCounter = 0;

  async emit<T extends BackbeatEvent>(): Promise<Result<void>> {
    return ok(undefined);
  }

  async request<T extends BackbeatEvent, R = unknown>(): Promise<Result<R>> {
    return ok(undefined as R);
  }

  subscribe<T extends BackbeatEvent>(): Result<string> {
    return ok(`null-sub-${++this.subscriptionCounter}`);
  }

  unsubscribe(subscriptionId: string): Result<void> {
    return ok(undefined);
  }

  subscribeAll(): Result<string> {
    return ok(`null-global-${++this.subscriptionCounter}`);
  }

  unsubscribeAll(): void {
    // No-op
  }
}
