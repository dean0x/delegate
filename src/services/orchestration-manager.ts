/**
 * Orchestration management service
 * ARCHITECTURE: Service layer for autonomous orchestration mode (v0.9.0)
 * Pattern: Service layer with DI, Result types, event emission
 * Rationale: Enables orchestration operations from MCP, CLI, or any future adapter
 */

import { mkdirSync } from 'fs';
import path from 'path';
import { resolveDefaultAgent } from '../core/agents.js';
import type { Configuration } from '../core/configuration.js';
import {
  createOrchestration,
  LoopStrategy,
  type Orchestration,
  type OrchestratorCreateRequest,
  OrchestratorId,
  OrchestratorStatus,
  updateOrchestration,
} from '../core/domain.js';
import { AutobeatError, ErrorCode } from '../core/errors.js';
import type { EventBus } from '../core/events/event-bus.js';
import type { Logger, LoopService, OrchestrationRepository, OrchestrationService } from '../core/interfaces.js';
import {
  createInitialState,
  getStateDir,
  writeExitConditionScript,
  writeStateFile,
} from '../core/orchestrator-state.js';
import { err, ok, type Result } from '../core/result.js';
import { validatePath } from '../utils/validation.js';
import { buildOrchestratorPrompt } from './orchestrator-prompt.js';

export class OrchestrationManagerService implements OrchestrationService {
  constructor(
    private readonly eventBus: EventBus,
    private readonly logger: Logger,
    private readonly orchestrationRepo: OrchestrationRepository,
    private readonly loopService: LoopService,
    private readonly config: Configuration,
  ) {
    this.logger.debug('OrchestrationManagerService initialized');
  }

  async createOrchestration(request: OrchestratorCreateRequest): Promise<Result<Orchestration>> {
    // ========================================================================
    // Input validation
    // ========================================================================

    // Validate goal: 1-8000 chars
    if (!request.goal || request.goal.trim().length === 0) {
      return err(new AutobeatError(ErrorCode.INVALID_INPUT, 'goal is required', { field: 'goal' }));
    }
    if (request.goal.length > 8000) {
      return err(
        new AutobeatError(ErrorCode.INVALID_INPUT, 'goal must not exceed 8000 characters', {
          field: 'goal',
          length: request.goal.length,
        }),
      );
    }

    // Validate working directory
    let validatedWorkingDirectory = process.cwd();
    if (request.workingDirectory) {
      const pathResult = validatePath(request.workingDirectory);
      if (!pathResult.ok) {
        return err(
          new AutobeatError(ErrorCode.INVALID_DIRECTORY, `Invalid working directory: ${pathResult.error.message}`, {
            workingDirectory: request.workingDirectory,
          }),
        );
      }
      validatedWorkingDirectory = pathResult.value;
    }

    // Resolve agent
    const agentResult = resolveDefaultAgent(request.agent, this.config.defaultAgent);
    if (!agentResult.ok) return agentResult;
    const agent = agentResult.value;

    // ========================================================================
    // State file setup
    // ========================================================================

    const stateDir = getStateDir();
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });

    const stateFileName = `state-${Date.now()}-${Math.random().toString(36).substring(2, 8)}.json`;
    const stateFilePath = path.join(stateDir, stateFileName);

    // Write initial state
    const initialState = createInitialState(request.goal);
    writeStateFile(stateFilePath, initialState);

    // Write exit condition script
    const exitConditionScript = writeExitConditionScript(stateDir, stateFilePath);

    // ========================================================================
    // Create orchestration domain object
    // ========================================================================

    const orchestration = createOrchestration({ ...request, agent }, stateFilePath, validatedWorkingDirectory);

    // Persist orchestration
    const saveResult = this.orchestrationRepo.save(orchestration);
    if (!saveResult.ok) {
      this.logger.error('Failed to save orchestration', saveResult.error, {
        orchestratorId: orchestration.id,
      });
      return err(saveResult.error);
    }

    // ========================================================================
    // Build prompt and create loop
    // ========================================================================

    const prompt = buildOrchestratorPrompt({
      goal: request.goal,
      stateFilePath,
      workingDirectory: validatedWorkingDirectory,
      maxDepth: orchestration.maxDepth,
      maxWorkers: orchestration.maxWorkers,
    });

    const loopResult = await this.loopService.createLoop({
      strategy: LoopStrategy.RETRY,
      prompt,
      exitCondition: `node ${exitConditionScript} ${stateFilePath}`,
      maxIterations: orchestration.maxIterations,
      maxConsecutiveFailures: 5,
      freshContext: true,
      workingDirectory: validatedWorkingDirectory,
      agent,
    });

    if (!loopResult.ok) {
      this.logger.error('Failed to create orchestrator loop', loopResult.error, {
        orchestratorId: orchestration.id,
      });
      return err(loopResult.error);
    }

    // ========================================================================
    // Update orchestration with loop ID and set to RUNNING
    // ========================================================================

    const updatedOrchestration = updateOrchestration(orchestration, {
      loopId: loopResult.value.id,
      status: OrchestratorStatus.RUNNING,
    });

    const updateResult = this.orchestrationRepo.update(updatedOrchestration);
    if (!updateResult.ok) {
      this.logger.error('Failed to update orchestration with loop ID', updateResult.error, {
        orchestratorId: orchestration.id,
        loopId: loopResult.value.id,
      });
      return err(updateResult.error);
    }

    // Emit event
    const emitResult = await this.eventBus.emit('OrchestrationCreated', {
      orchestration: updatedOrchestration,
    });
    if (!emitResult.ok) {
      this.logger.error('Failed to emit OrchestrationCreated event', emitResult.error, {
        orchestratorId: updatedOrchestration.id,
      });
    }

    this.logger.info('Orchestration created', {
      orchestratorId: updatedOrchestration.id,
      loopId: loopResult.value.id,
      goal: request.goal.substring(0, 100),
      maxDepth: orchestration.maxDepth,
      maxWorkers: orchestration.maxWorkers,
      maxIterations: orchestration.maxIterations,
    });

    return ok(updatedOrchestration);
  }

  async getOrchestration(id: OrchestratorId): Promise<Result<Orchestration>> {
    const result = await this.orchestrationRepo.findById(id);
    if (!result.ok) {
      return err(
        new AutobeatError(ErrorCode.SYSTEM_ERROR, `Failed to get orchestration: ${result.error.message}`, {
          orchestratorId: id,
        }),
      );
    }

    if (!result.value) {
      return err(
        new AutobeatError(ErrorCode.ORCHESTRATION_NOT_FOUND, `Orchestration ${id} not found`, {
          orchestratorId: id,
        }),
      );
    }

    return ok(result.value);
  }

  async listOrchestrations(
    status?: OrchestratorStatus,
    limit?: number,
    offset?: number,
  ): Promise<Result<readonly Orchestration[]>> {
    if (status) {
      return this.orchestrationRepo.findByStatus(status, limit);
    }
    return this.orchestrationRepo.findAll(limit, offset);
  }

  async cancelOrchestration(id: OrchestratorId, reason?: string): Promise<Result<void>> {
    const lookupResult = await this.getOrchestration(id);
    if (!lookupResult.ok) return lookupResult;

    const orchestration = lookupResult.value;
    if (orchestration.status !== OrchestratorStatus.PLANNING && orchestration.status !== OrchestratorStatus.RUNNING) {
      return err(
        new AutobeatError(
          ErrorCode.INVALID_OPERATION,
          `Orchestration ${id} is not active (status: ${orchestration.status})`,
          { orchestratorId: id, status: orchestration.status },
        ),
      );
    }

    this.logger.info('Cancelling orchestration', { orchestratorId: id, reason });

    // Cancel the underlying loop if it exists
    if (orchestration.loopId) {
      const cancelResult = await this.loopService.cancelLoop(orchestration.loopId, reason, true);
      if (!cancelResult.ok) {
        this.logger.warn('Failed to cancel orchestration loop', {
          orchestratorId: id,
          loopId: orchestration.loopId,
          error: cancelResult.error.message,
        });
      }
    }

    // Emit cancellation event (handler will update DB status)
    const emitResult = await this.eventBus.emit('OrchestrationCancelled', {
      orchestratorId: id,
      reason,
    });

    if (!emitResult.ok) {
      this.logger.error('Failed to emit OrchestrationCancelled event', emitResult.error, {
        orchestratorId: id,
      });
      return err(emitResult.error);
    }

    return ok(undefined);
  }
}
