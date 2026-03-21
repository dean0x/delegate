/**
 * Loop management service
 * ARCHITECTURE: Service layer for iterative task/pipeline execution (v0.7.0)
 * Pattern: Service layer with DI, Result types, event emission
 * Rationale: Enables loop operations from MCP, CLI, or any future adapter
 */

import { resolveDefaultAgent } from '../core/agents.js';
import { Configuration } from '../core/configuration.js';
import {
  createLoop,
  Loop,
  LoopCreateRequest,
  LoopId,
  LoopIteration,
  LoopStatus,
  LoopStrategy,
} from '../core/domain.js';
import { BackbeatError, ErrorCode } from '../core/errors.js';
import { EventBus } from '../core/events/event-bus.js';
import { Logger, LoopRepository, LoopService } from '../core/interfaces.js';
import { err, ok, Result } from '../core/result.js';
import { truncatePrompt } from '../utils/format.js';
import { validatePath } from '../utils/validation.js';

export class LoopManagerService implements LoopService {
  constructor(
    private readonly eventBus: EventBus,
    private readonly logger: Logger,
    private readonly loopRepository: LoopRepository,
    private readonly config: Configuration,
  ) {
    this.logger.debug('LoopManagerService initialized');
  }

  async createLoop(request: LoopCreateRequest): Promise<Result<Loop>> {
    // ========================================================================
    // Input validation (R13 boundary validation)
    // ========================================================================

    // Validate prompt: required 1-4000 chars unless pipeline mode
    const isPipelineMode = request.pipelineSteps && request.pipelineSteps.length > 0;
    if (!isPipelineMode) {
      if (!request.prompt || request.prompt.trim().length === 0) {
        return err(
          new BackbeatError(ErrorCode.INVALID_INPUT, 'prompt is required for non-pipeline loops', {
            field: 'prompt',
          }),
        );
      }
    }
    if (request.prompt && request.prompt.length > 4000) {
      return err(
        new BackbeatError(ErrorCode.INVALID_INPUT, 'prompt must not exceed 4000 characters', {
          field: 'prompt',
          length: request.prompt.length,
        }),
      );
    }

    // Validate exitCondition: required, non-empty
    if (!request.exitCondition || request.exitCondition.trim().length === 0) {
      return err(
        new BackbeatError(ErrorCode.INVALID_INPUT, 'exitCondition is required', {
          field: 'exitCondition',
        }),
      );
    }

    // Validate workingDirectory
    let validatedWorkingDirectory: string;
    if (request.workingDirectory) {
      const pathValidation = validatePath(request.workingDirectory);
      if (!pathValidation.ok) {
        return err(
          new BackbeatError(ErrorCode.INVALID_DIRECTORY, `Invalid working directory: ${pathValidation.error.message}`, {
            workingDirectory: request.workingDirectory,
          }),
        );
      }
      validatedWorkingDirectory = pathValidation.value;
    } else {
      validatedWorkingDirectory = process.cwd();
    }

    // Validate maxIterations: >= 0 (0 = unlimited)
    if (request.maxIterations !== undefined && request.maxIterations < 0) {
      return err(
        new BackbeatError(ErrorCode.INVALID_INPUT, 'maxIterations must be >= 0 (0 = unlimited)', {
          field: 'maxIterations',
          value: request.maxIterations,
        }),
      );
    }

    // Validate maxConsecutiveFailures: >= 0
    if (request.maxConsecutiveFailures !== undefined && request.maxConsecutiveFailures < 0) {
      return err(
        new BackbeatError(ErrorCode.INVALID_INPUT, 'maxConsecutiveFailures must be >= 0', {
          field: 'maxConsecutiveFailures',
          value: request.maxConsecutiveFailures,
        }),
      );
    }

    // Validate cooldownMs: >= 0
    if (request.cooldownMs !== undefined && request.cooldownMs < 0) {
      return err(
        new BackbeatError(ErrorCode.INVALID_INPUT, 'cooldownMs must be >= 0', {
          field: 'cooldownMs',
          value: request.cooldownMs,
        }),
      );
    }

    // Validate evalTimeout: >= 1000ms (minimum 1 second)
    if (request.evalTimeout !== undefined && request.evalTimeout < 1000) {
      return err(
        new BackbeatError(ErrorCode.INVALID_INPUT, 'evalTimeout must be >= 1000ms (1 second minimum)', {
          field: 'evalTimeout',
          value: request.evalTimeout,
        }),
      );
    }

    // Validate evalDirection: required if optimize, forbidden if retry
    if (request.strategy === LoopStrategy.OPTIMIZE && !request.evalDirection) {
      return err(
        new BackbeatError(ErrorCode.INVALID_INPUT, 'evalDirection is required for optimize strategy', {
          field: 'evalDirection',
          strategy: request.strategy,
        }),
      );
    }
    if (request.strategy === LoopStrategy.RETRY && request.evalDirection) {
      return err(
        new BackbeatError(ErrorCode.INVALID_INPUT, 'evalDirection is not allowed for retry strategy', {
          field: 'evalDirection',
          strategy: request.strategy,
        }),
      );
    }

    // Validate pipelineSteps: 2-20 steps if provided
    if (request.pipelineSteps) {
      if (request.pipelineSteps.length < 2) {
        return err(
          new BackbeatError(ErrorCode.INVALID_INPUT, 'Pipeline requires at least 2 steps', {
            field: 'pipelineSteps',
            stepCount: request.pipelineSteps.length,
          }),
        );
      }
      if (request.pipelineSteps.length > 20) {
        return err(
          new BackbeatError(ErrorCode.INVALID_INPUT, 'Pipeline cannot exceed 20 steps', {
            field: 'pipelineSteps',
            stepCount: request.pipelineSteps.length,
          }),
        );
      }
    }

    // Resolve agent (same pattern as TaskManager.delegate / ScheduleManager)
    const agentResult = resolveDefaultAgent(request.agent, this.config.defaultAgent);
    if (!agentResult.ok) return agentResult;

    // ========================================================================
    // Create loop via domain factory
    // ========================================================================

    const loop = createLoop(
      {
        ...request,
        agent: agentResult.value,
      },
      validatedWorkingDirectory,
    );

    const promptSummary = request.prompt
      ? truncatePrompt(request.prompt, 50)
      : `Pipeline (${request.pipelineSteps?.length ?? 0} steps)`;

    this.logger.info('Creating loop', {
      loopId: loop.id,
      strategy: loop.strategy,
      maxIterations: loop.maxIterations,
      prompt: promptSummary,
    });

    // Emit event — handler persists the loop
    const emitResult = await this.eventBus.emit('LoopCreated', { loop });
    if (!emitResult.ok) {
      this.logger.error('Failed to emit LoopCreated event', emitResult.error, {
        loopId: loop.id,
      });
      return err(emitResult.error);
    }

    return ok(loop);
  }

  async getLoop(
    loopId: LoopId,
    includeHistory?: boolean,
    historyLimit?: number,
  ): Promise<Result<{ loop: Loop; iterations?: readonly LoopIteration[] }>> {
    const lookupResult = await this.fetchLoopOrError(loopId);
    if (!lookupResult.ok) return lookupResult;

    const loop = lookupResult.value;
    let iterations: readonly LoopIteration[] | undefined;

    if (includeHistory) {
      const iterationsResult = await this.loopRepository.getIterations(loopId, historyLimit);
      if (iterationsResult.ok) {
        iterations = iterationsResult.value;
      }
      // Non-fatal: log warning but still return loop data
      if (!iterationsResult.ok) {
        this.logger.warn('Failed to fetch loop iterations', {
          loopId,
          error: iterationsResult.error.message,
        });
      }
    }

    return ok({ loop, iterations });
  }

  async listLoops(status?: LoopStatus, limit?: number, offset?: number): Promise<Result<readonly Loop[]>> {
    if (status) {
      return this.loopRepository.findByStatus(status, limit, offset);
    }
    return this.loopRepository.findAll(limit, offset);
  }

  async cancelLoop(loopId: LoopId, reason?: string, cancelTasks?: boolean): Promise<Result<void>> {
    const lookupResult = await this.fetchLoopOrError(loopId);
    if (!lookupResult.ok) return lookupResult;

    const loop = lookupResult.value;
    if (loop.status !== LoopStatus.RUNNING) {
      return err(
        new BackbeatError(ErrorCode.INVALID_OPERATION, `Loop ${loopId} is not running (status: ${loop.status})`, {
          loopId,
          status: loop.status,
        }),
      );
    }

    this.logger.info('Cancelling loop', { loopId, reason, cancelTasks });

    const emitResult = await this.eventBus.emit('LoopCancelled', {
      loopId,
      reason,
    });

    if (!emitResult.ok) {
      this.logger.error('Failed to emit LoopCancelled event', emitResult.error, {
        loopId,
      });
      return err(emitResult.error);
    }

    // Optionally cancel running iteration tasks
    if (cancelTasks) {
      const iterationsResult = await this.loopRepository.getIterations(loopId);
      if (iterationsResult.ok) {
        const runningIterations = iterationsResult.value.filter((i) => i.status === 'running');
        for (const iteration of runningIterations) {
          const cancelResult = await this.eventBus.emit('TaskCancellationRequested', {
            taskId: iteration.taskId,
            reason: `Loop ${loopId} cancelled`,
          });
          if (!cancelResult.ok) {
            this.logger.warn('Failed to cancel iteration task', {
              taskId: iteration.taskId,
              loopId,
              error: cancelResult.error.message,
            });
          }
        }
        this.logger.info('Cancelled running iteration tasks', {
          loopId,
          taskCount: runningIterations.length,
        });
      }
    }

    return ok(undefined);
  }

  /**
   * Fetch a loop by ID and return a typed error if not found
   */
  private async fetchLoopOrError(loopId: LoopId): Promise<Result<Loop>> {
    const result = await this.loopRepository.findById(loopId);
    if (!result.ok) {
      return err(new BackbeatError(ErrorCode.SYSTEM_ERROR, `Failed to get loop: ${result.error.message}`, { loopId }));
    }

    if (!result.value) {
      return err(new BackbeatError(ErrorCode.TASK_NOT_FOUND, `Loop ${loopId} not found`, { loopId }));
    }

    return ok(result.value);
  }
}
