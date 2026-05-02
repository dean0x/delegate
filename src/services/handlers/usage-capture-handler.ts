/**
 * Usage capture handler — subscribes to TaskCompleted and saves token/cost data.
 *
 * ARCHITECTURE: Event-driven, best-effort capture.
 * - Claude only (v1.3.0): Codex parser returns null for now.
 * - All errors logged as warn, never thrown.
 * - Factory pattern for async initialization (matches CheckpointHandler).
 * Pattern: Template Method via BaseEventHandler.
 */

import { TaskId } from '../../core/domain.js';
import { AutobeatError, ErrorCode } from '../../core/errors.js';
import { EventBus } from '../../core/events/event-bus.js';
import type { TaskCompletedEvent } from '../../core/events/events.js';
import { BaseEventHandler } from '../../core/events/handlers.js';
import { Logger, OutputRepository, TaskRepository, UsageRepository } from '../../core/interfaces.js';
import { err, ok, Result } from '../../core/result.js';
import { parseClaudeUsage } from '../usage-parser.js';

export interface UsageCaptureHandlerDeps {
  readonly usageRepository: UsageRepository;
  readonly outputRepository: OutputRepository;
  readonly taskRepository: TaskRepository;
  readonly eventBus: EventBus;
  readonly logger: Logger;
}

export class UsageCaptureHandler extends BaseEventHandler {
  private readonly usageRepository: UsageRepository;
  private readonly outputRepository: OutputRepository;
  private readonly taskRepository: TaskRepository;
  private readonly eventBus: EventBus;

  /**
   * Private constructor — use UsageCaptureHandler.create() instead.
   * ARCHITECTURE: Factory pattern ensures handler is fully initialized before use.
   */
  private constructor(deps: UsageCaptureHandlerDeps) {
    super(deps.logger, 'UsageCaptureHandler');
    this.usageRepository = deps.usageRepository;
    this.outputRepository = deps.outputRepository;
    this.taskRepository = deps.taskRepository;
    this.eventBus = deps.eventBus;
  }

  /**
   * Factory method — creates and subscribes the handler.
   * ARCHITECTURE: Guarantees handler is ready to use — no uninitialized state possible.
   */
  static async create(deps: UsageCaptureHandlerDeps): Promise<Result<UsageCaptureHandler, AutobeatError>> {
    const handlerLogger = deps.logger.child ? deps.logger.child({ module: 'UsageCaptureHandler' }) : deps.logger;
    const handler = new UsageCaptureHandler({ ...deps, logger: handlerLogger });

    const subscribeResult = handler.subscribeToEvents();
    if (!subscribeResult.ok) {
      return subscribeResult;
    }

    handlerLogger.info('UsageCaptureHandler initialized');
    return ok(handler);
  }

  private subscribeToEvents(): Result<void, AutobeatError> {
    const result = this.eventBus.subscribe('TaskCompleted', this.handleTaskCompleted.bind(this));
    if (!result.ok) {
      return err(
        new AutobeatError(ErrorCode.SYSTEM_ERROR, `Failed to subscribe to TaskCompleted: ${result.error.message}`, {
          error: result.error,
        }),
      );
    }
    return ok(undefined);
  }

  private async handleTaskCompleted(event: TaskCompletedEvent): Promise<void> {
    await this.handleEvent(event, async (e) => {
      return this.captureUsage(e.taskId);
    });
  }

  private async captureUsage(taskId: TaskId): Promise<Result<void>> {
    const logger = this.logger;

    // Fetch task to check agent type
    const taskResult = await this.taskRepository.findById(taskId);
    if (!taskResult.ok) {
      logger.warn('UsageCaptureHandler: failed to fetch task', {
        taskId,
        error: taskResult.error.message,
      });
      return ok(undefined); // best-effort — don't propagate
    }

    const task = taskResult.value;
    if (!task) {
      // Task was deleted between completion event and capture — silently skip
      return ok(undefined);
    }

    // v1.3.0: Claude only — other agents don't emit JSON result messages
    if (task.agent !== 'claude') {
      return ok(undefined);
    }

    // Fetch task output — ProcessConnector flush is guaranteed complete before TaskCompleted
    const outputResult = await this.outputRepository.get(taskId);
    if (!outputResult.ok) {
      logger.warn('UsageCaptureHandler: failed to fetch task output', {
        taskId,
        error: outputResult.error.message,
      });
      return ok(undefined);
    }

    const output = outputResult.value;
    if (!output) {
      // No output (e.g., task cancelled before writing anything)
      return ok(undefined);
    }

    // Parse Claude JSON usage — best-effort, returns null on any failure
    const parseResult = parseClaudeUsage(output, task.model);
    if (!parseResult.ok) {
      logger.warn('UsageCaptureHandler: parseClaudeUsage returned error', {
        taskId,
        error: parseResult.error.message,
      });
      return ok(undefined);
    }

    const usage = parseResult.value;
    if (!usage) {
      // Normal: task completed without Claude JSON output format, or no result object
      return ok(undefined);
    }

    // Replace placeholder task ID with real task ID
    const usageWithId = { ...usage, taskId };

    const saveResult = await this.usageRepository.save(usageWithId);
    if (!saveResult.ok) {
      logger.warn('UsageCaptureHandler: failed to save usage', {
        taskId,
        error: saveResult.error.message,
      });
      return ok(undefined);
    }

    logger.debug('UsageCaptureHandler: usage saved', {
      taskId,
      totalCostUsd: usage.totalCostUsd,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });

    return ok(undefined);
  }
}
