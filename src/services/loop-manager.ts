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
  EvalMode,
  Loop,
  LoopCreateRequest,
  LoopId,
  LoopIteration,
  LoopStatus,
  LoopStrategy,
  updateLoop,
} from '../core/domain.js';
import { AutobeatError, ErrorCode } from '../core/errors.js';
import { EventBus } from '../core/events/event-bus.js';
import { Logger, LoopRepository, LoopService } from '../core/interfaces.js';
import { err, ok, Result } from '../core/result.js';
import { truncatePrompt } from '../utils/format.js';
import { captureGitState, captureLoopGitContext } from '../utils/git-state.js';
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

  /**
   * Validate a loop creation request without creating the loop.
   * ARCHITECTURE: Extracted from createLoop() so ScheduleHandler can validate
   * loopConfig before domain factory creation — prevents bypassing validations.
   */
  async validateCreateRequest(request: LoopCreateRequest): Promise<Result<void, Error>> {
    // Validate prompt: required, non-empty unless pipeline mode
    const isPipelineMode = request.pipelineSteps && request.pipelineSteps.length > 0;
    if (!isPipelineMode) {
      if (!request.prompt || request.prompt.trim().length === 0) {
        return err(
          new AutobeatError(ErrorCode.INVALID_INPUT, 'prompt is required for non-pipeline loops', {
            field: 'prompt',
          }),
        );
      }
    }

    // Validate evalMode + exitCondition
    const evalMode = request.evalMode ?? EvalMode.SHELL;
    if (evalMode === EvalMode.SHELL) {
      // Shell mode: exitCondition required, evalPrompt forbidden
      if (!request.exitCondition || request.exitCondition.trim().length === 0) {
        return err(
          new AutobeatError(ErrorCode.INVALID_INPUT, 'exitCondition is required for shell eval mode', {
            field: 'exitCondition',
          }),
        );
      }
      if (request.evalPrompt) {
        return err(
          new AutobeatError(ErrorCode.INVALID_INPUT, 'evalPrompt is only valid with evalMode: agent', {
            field: 'evalPrompt',
          }),
        );
      }
    }

    // Validate workingDirectory
    if (request.workingDirectory) {
      const pathValidation = validatePath(request.workingDirectory);
      if (!pathValidation.ok) {
        return err(
          new AutobeatError(ErrorCode.INVALID_DIRECTORY, `Invalid working directory: ${pathValidation.error.message}`, {
            workingDirectory: request.workingDirectory,
          }),
        );
      }
    }

    // Validate maxIterations: >= 0 (0 = unlimited)
    if (request.maxIterations !== undefined && request.maxIterations < 0) {
      return err(
        new AutobeatError(ErrorCode.INVALID_INPUT, 'maxIterations must be >= 0 (0 = unlimited)', {
          field: 'maxIterations',
          value: request.maxIterations,
        }),
      );
    }

    // Validate maxConsecutiveFailures: >= 0
    if (request.maxConsecutiveFailures !== undefined && request.maxConsecutiveFailures < 0) {
      return err(
        new AutobeatError(ErrorCode.INVALID_INPUT, 'maxConsecutiveFailures must be >= 0', {
          field: 'maxConsecutiveFailures',
          value: request.maxConsecutiveFailures,
        }),
      );
    }

    // Validate cooldownMs: >= 0
    if (request.cooldownMs !== undefined && request.cooldownMs < 0) {
      return err(
        new AutobeatError(ErrorCode.INVALID_INPUT, 'cooldownMs must be >= 0', {
          field: 'cooldownMs',
          value: request.cooldownMs,
        }),
      );
    }

    // Validate evalTimeout: 1000ms min; max depends on evalMode (agent: 600s, shell: 300s)
    if (request.evalTimeout !== undefined) {
      const maxEvalTimeout = evalMode === EvalMode.AGENT ? 600000 : 300000;
      const maxEvalTimeoutLabel = evalMode === EvalMode.AGENT ? '10 minute' : '5 minute';
      if (request.evalTimeout < 1000) {
        return err(
          new AutobeatError(ErrorCode.INVALID_INPUT, 'evalTimeout must be >= 1000ms (1 second minimum)', {
            field: 'evalTimeout',
            value: request.evalTimeout,
          }),
        );
      }
      if (request.evalTimeout > maxEvalTimeout) {
        return err(
          new AutobeatError(
            ErrorCode.INVALID_INPUT,
            `evalTimeout must be <= ${maxEvalTimeout}ms (${maxEvalTimeoutLabel} maximum)`,
            {
              field: 'evalTimeout',
              value: request.evalTimeout,
            },
          ),
        );
      }
    }

    // Validate evalDirection: required if optimize, forbidden if retry
    if (request.strategy === LoopStrategy.OPTIMIZE && !request.evalDirection) {
      return err(
        new AutobeatError(ErrorCode.INVALID_INPUT, 'evalDirection is required for optimize strategy', {
          field: 'evalDirection',
          strategy: request.strategy,
        }),
      );
    }
    if (request.strategy === LoopStrategy.RETRY && request.evalDirection) {
      return err(
        new AutobeatError(ErrorCode.INVALID_INPUT, 'evalDirection is not allowed for retry strategy', {
          field: 'evalDirection',
          strategy: request.strategy,
        }),
      );
    }

    // Validate pipelineSteps: 2-20 steps if provided
    if (request.pipelineSteps) {
      if (request.pipelineSteps.length < 2) {
        return err(
          new AutobeatError(ErrorCode.INVALID_INPUT, 'Pipeline requires at least 2 steps', {
            field: 'pipelineSteps',
            stepCount: request.pipelineSteps.length,
          }),
        );
      }
      if (request.pipelineSteps.length > 20) {
        return err(
          new AutobeatError(ErrorCode.INVALID_INPUT, 'Pipeline cannot exceed 20 steps', {
            field: 'pipelineSteps',
            stepCount: request.pipelineSteps.length,
          }),
        );
      }
    }

    // Resolve agent (same pattern as TaskManager.delegate / ScheduleManager)
    const agentResult = resolveDefaultAgent(request.agent, this.config.defaultAgent);
    if (!agentResult.ok) return agentResult;

    // Git branch validation (v0.8.0)
    if (request.gitBranch) {
      const validatedDir = request.workingDirectory ?? process.cwd();
      const gitStateResult = await captureGitState(validatedDir);
      if (!gitStateResult.ok) {
        return err(
          new AutobeatError(
            ErrorCode.INVALID_INPUT,
            `gitBranch requires a git repository: ${gitStateResult.error.message}`,
            { workingDirectory: validatedDir, gitBranch: request.gitBranch },
          ),
        );
      }
      if (!gitStateResult.value) {
        return err(
          new AutobeatError(
            ErrorCode.INVALID_INPUT,
            'gitBranch requires a git repository, but working directory is not a git repo',
            { workingDirectory: validatedDir, gitBranch: request.gitBranch },
          ),
        );
      }
    }

    return ok(undefined);
  }

  async createLoop(request: LoopCreateRequest): Promise<Result<Loop>> {
    // ========================================================================
    // Input validation via extracted validateCreateRequest()
    // ========================================================================
    const validationResult = await this.validateCreateRequest(request);
    if (!validationResult.ok) {
      return validationResult;
    }

    // ========================================================================
    // Resolve validated working directory and agent (validation passed above)
    // ========================================================================
    const pathResult = request.workingDirectory ? validatePath(request.workingDirectory) : undefined;
    const validatedWorkingDirectory = pathResult?.ok ? pathResult.value : process.cwd();

    const agentResult = resolveDefaultAgent(request.agent, this.config.defaultAgent);
    const agent = agentResult.ok ? agentResult.value : request.agent;

    // ========================================================================
    // Git state capture (v0.8.1)
    // Always capture gitStartCommitSha when in a git repo (not just when --git-branch)
    // gitBaseBranch is a legacy field (dead after v0.8.1) but still populated
    // for backward compatibility with existing DB rows
    // ========================================================================

    const gitContextResult = await captureLoopGitContext(validatedWorkingDirectory, request.gitBranch);
    let gitBaseBranch: string | undefined;
    let gitStartCommitSha: string | undefined;
    if (gitContextResult.ok) {
      gitBaseBranch = gitContextResult.value.gitBaseBranch;
      gitStartCommitSha = gitContextResult.value.gitStartCommitSha;
    } else {
      this.logger.warn('Failed to capture git state for loop — proceeding without git context', {
        error: gitContextResult.error.message,
      });
    }

    // ========================================================================
    // Create loop via domain factory
    // ========================================================================

    const loop = createLoop(
      {
        ...request,
        agent,
      },
      validatedWorkingDirectory,
    );

    // Inject git state into the loop
    // ARCHITECTURE: createLoop sets gitStartCommitSha to undefined;
    // we override here because git operations are async (not available in pure domain factory)
    // gitBaseBranch is a legacy field still populated for DB backward compatibility
    const loopWithGit =
      gitBaseBranch || gitStartCommitSha
        ? updateLoop(loop, {
            ...(gitBaseBranch ? { gitBaseBranch } : {}),
            ...(gitStartCommitSha ? { gitStartCommitSha } : {}),
          })
        : loop;

    const promptSummary = request.prompt
      ? truncatePrompt(request.prompt, 50)
      : `Pipeline (${request.pipelineSteps?.length ?? 0} steps)`;

    this.logger.info('Creating loop', {
      loopId: loopWithGit.id,
      strategy: loopWithGit.strategy,
      maxIterations: loopWithGit.maxIterations,
      prompt: promptSummary,
      gitBranch: loopWithGit.gitBranch,
      gitBaseBranch: loopWithGit.gitBaseBranch,
      gitStartCommitSha: loopWithGit.gitStartCommitSha,
    });

    // Emit event — handler persists the loop
    const emitResult = await this.eventBus.emit('LoopCreated', { loop: loopWithGit });
    if (!emitResult.ok) {
      this.logger.error('Failed to emit LoopCreated event', emitResult.error, {
        loopId: loopWithGit.id,
      });
      return err(emitResult.error);
    }

    return ok(loopWithGit);
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
      } else {
        // Non-fatal: log warning but still return loop data
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
    if (loop.status !== LoopStatus.RUNNING && loop.status !== LoopStatus.PAUSED) {
      return err(
        new AutobeatError(
          ErrorCode.INVALID_OPERATION,
          `Loop ${loopId} is not running or paused (status: ${loop.status})`,
          {
            loopId,
            status: loop.status,
          },
        ),
      );
    }

    this.logger.info('Cancelling loop', { loopId, reason, cancelTasks });

    // Cancel running iteration tasks BEFORE emitting LoopCancelled event.
    // The handler marks iterations as 'cancelled', so we must read running
    // iterations and emit TaskCancellationRequested while they still have
    // 'running' status.
    if (cancelTasks) {
      const iterationsResult = await this.loopRepository.getIterations(loopId);
      if (iterationsResult.ok) {
        const runningIterations = iterationsResult.value.filter((i) => i.status === 'running');
        for (const iteration of runningIterations) {
          // Guard: taskId can be undefined due to ON DELETE SET NULL
          if (!iteration.taskId) {
            this.logger.warn('Skipping cancel for iteration with no taskId (cleaned up)', {
              loopId,
              iterationNumber: iteration.iterationNumber,
            });
            continue;
          }
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

    return ok(undefined);
  }

  async pauseLoop(loopId: LoopId, options?: { force?: boolean }): Promise<Result<void>> {
    const lookupResult = await this.fetchLoopOrError(loopId);
    if (!lookupResult.ok) return lookupResult;

    const loop = lookupResult.value;
    if (loop.status !== LoopStatus.RUNNING) {
      return err(
        new AutobeatError(ErrorCode.INVALID_OPERATION, `Loop ${loopId} is not running (status: ${loop.status})`, {
          loopId,
          status: loop.status,
        }),
      );
    }

    const force = options?.force ?? false;
    this.logger.info('Pausing loop', { loopId, force });

    const emitResult = await this.eventBus.emit('LoopPaused', {
      loopId,
      force,
    });

    if (!emitResult.ok) {
      this.logger.error('Failed to emit LoopPaused event', emitResult.error, { loopId });
      return err(emitResult.error);
    }

    return ok(undefined);
  }

  async resumeLoop(loopId: LoopId): Promise<Result<void>> {
    const lookupResult = await this.fetchLoopOrError(loopId);
    if (!lookupResult.ok) return lookupResult;

    const loop = lookupResult.value;
    if (loop.status !== LoopStatus.PAUSED) {
      return err(
        new AutobeatError(ErrorCode.INVALID_OPERATION, `Loop ${loopId} is not paused (status: ${loop.status})`, {
          loopId,
          status: loop.status,
        }),
      );
    }

    this.logger.info('Resuming loop', { loopId });

    const emitResult = await this.eventBus.emit('LoopResumed', { loopId });

    if (!emitResult.ok) {
      this.logger.error('Failed to emit LoopResumed event', emitResult.error, { loopId });
      return err(emitResult.error);
    }

    return ok(undefined);
  }

  /**
   * Fetch a loop by ID and return a typed error if not found
   */
  private async fetchLoopOrError(loopId: LoopId): Promise<Result<Loop>> {
    const result = await this.loopRepository.findById(loopId);
    if (!result.ok) {
      return err(new AutobeatError(ErrorCode.SYSTEM_ERROR, `Failed to get loop: ${result.error.message}`, { loopId }));
    }

    if (!result.value) {
      return err(new AutobeatError(ErrorCode.TASK_NOT_FOUND, `Loop ${loopId} not found`, { loopId }));
    }

    return ok(result.value);
  }
}
