/**
 * Orchestration management service
 * ARCHITECTURE: Service layer for autonomous orchestration mode (v0.9.0)
 * Pattern: Service layer with DI, Result types, event emission
 * Rationale: Enables orchestration operations from MCP, CLI, or any future adapter
 */

import { mkdirSync, unlinkSync } from 'fs';
import os from 'os';
import path from 'path';
import { type AgentProvider, resolveDefaultAgent } from '../core/agents.js';
import type { Configuration } from '../core/configuration.js';
import {
  createOrchestration,
  LoopId,
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

export interface OrchestrationManagerServiceDeps {
  readonly eventBus: EventBus;
  readonly logger: Logger;
  readonly orchestrationRepo: OrchestrationRepository;
  readonly loopService: LoopService;
  readonly config: Configuration;
}

export class OrchestrationManagerService implements OrchestrationService {
  private readonly eventBus: EventBus;
  private readonly logger: Logger;
  private readonly orchestrationRepo: OrchestrationRepository;
  private readonly loopService: LoopService;
  private readonly config: Configuration;

  constructor(deps: OrchestrationManagerServiceDeps) {
    this.eventBus = deps.eventBus;
    this.logger = deps.logger;
    this.orchestrationRepo = deps.orchestrationRepo;
    this.loopService = deps.loopService;
    this.config = deps.config;
    this.logger.debug('OrchestrationManagerService initialized');
  }

  async createOrchestration(request: OrchestratorCreateRequest): Promise<Result<Orchestration>> {
    // ========================================================================
    // DECISION (2026-04-10): Compensation pattern (keep original 3-step order,
    // mark FAILED on error) instead of inverted ordering. Inverted ordering had
    // a race where the loop's first iteration could complete before the orch row
    // was saved, leaving OrchestrationHandler.handleLoopCompleted unable to find
    // the row via findByLoopId.
    // ========================================================================

    // ========================================================================
    // Input validation
    // ========================================================================

    // Validate goal: non-empty
    if (!request.goal || request.goal.trim().length === 0) {
      return err(new AutobeatError(ErrorCode.INVALID_INPUT, 'goal is required', { field: 'goal' }));
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

    let stateFilePath: string;
    let exitConditionScript: string;
    try {
      const stateDir = getStateDir();
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });

      const stateFileName = `state-${Date.now()}-${crypto.randomUUID().substring(0, 8)}.json`;
      stateFilePath = path.join(stateDir, stateFileName);

      // Write initial state
      const initialState = createInitialState(request.goal);
      writeStateFile(stateFilePath, initialState);

      // Write exit condition script
      exitConditionScript = writeExitConditionScript(stateDir, stateFilePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('Failed to set up orchestration state files', undefined, { error: message });
      return err(
        new AutobeatError(ErrorCode.SYSTEM_ERROR, `Failed to set up state files: ${message}`, {
          error: message,
        }),
      );
    }

    // Path-validated file cleanup helper — prevents traversal attacks
    // (pattern reused from orchestration-repository.ts:cleanupOldOrchestrations)
    const expectedDir = path.resolve(path.join(os.homedir(), '.autobeat', 'orchestrator-state'));
    const isWithinStateDir = (filePath: string): boolean => {
      const resolved = path.resolve(filePath);
      return resolved.startsWith(expectedDir + path.sep);
    };
    const cleanupFiles = (): void => {
      for (const filePath of [stateFilePath, exitConditionScript]) {
        if (isWithinStateDir(filePath)) {
          try {
            unlinkSync(filePath);
          } catch {
            // Best-effort — orphan files are harmless
          }
        }
      }
    };

    // ========================================================================
    // Create orchestration domain object (PLANNING, loopId=undefined)
    // ========================================================================

    const orchestration = createOrchestration({ ...request, agent }, stateFilePath, validatedWorkingDirectory);

    // Persist orchestration row
    const saveResult = await this.orchestrationRepo.save(orchestration);
    if (!saveResult.ok) {
      this.logger.error('Failed to save orchestration', saveResult.error, {
        orchestratorId: orchestration.id,
      });
      cleanupFiles();
      return err(saveResult.error);
    }

    // ========================================================================
    // Compensation helper: soft-delete (mark FAILED) for failures after the orch row exists.
    //
    // DECISION (2026-04-10): SOFT delete (mark FAILED) instead of hard delete.
    // Preserves audit trail in dashboard so users see what failed and can use
    // the manual cleanup keybindings (c/d) to remove rows when ready.
    // ========================================================================
    const compensate = async (reason: string, loopIdToCancel?: LoopId): Promise<void> => {
      this.logger.warn('Compensating failed orchestration create', {
        orchestratorId: orchestration.id,
        reason,
      });
      if (loopIdToCancel) {
        const cancelResult = await this.loopService.cancelLoop(loopIdToCancel, reason, true);
        if (!cancelResult.ok) {
          this.logger.warn('Compensation cancelLoop failed (loop will surface as zombie in recovery)', {
            loopId: loopIdToCancel,
            error: cancelResult.error.message,
          });
        }
      }
      // Soft delete: mark FAILED rather than removing the row.
      const failed = updateOrchestration(orchestration, {
        status: OrchestratorStatus.FAILED,
        completedAt: Date.now(),
      });
      const updateResult = await this.orchestrationRepo.update(failed);
      if (!updateResult.ok) {
        this.logger.warn('Compensation update failed', {
          orchestratorId: orchestration.id,
          error: updateResult.error.message,
        });
      }
      cleanupFiles();
    };

    // ========================================================================
    // Build prompt and create loop
    // ========================================================================

    const { finalSystemPrompt, finalUserPrompt } = this.buildFinalPrompts(
      request,
      orchestration,
      stateFilePath,
      validatedWorkingDirectory,
      agent,
    );

    const loopResult = await this.loopService.createLoop({
      strategy: LoopStrategy.RETRY,
      prompt: finalUserPrompt,
      exitCondition: `node ${JSON.stringify(exitConditionScript)}`,
      maxIterations: orchestration.maxIterations,
      maxConsecutiveFailures: 5,
      freshContext: true,
      workingDirectory: validatedWorkingDirectory,
      agent,
      ...(orchestration.model !== undefined && { model: orchestration.model }),
      // v1.3.0: attribute all loop iteration tasks to this orchestration
      orchestratorId: orchestration.id,
      // Thread system prompt through to each loop iteration task
      systemPrompt: finalSystemPrompt,
    });

    if (!loopResult.ok) {
      this.logger.error('Failed to create orchestrator loop', loopResult.error, {
        orchestratorId: orchestration.id,
      });
      await compensate('loop creation failed');
      return err(loopResult.error);
    }

    // ========================================================================
    // Update orchestration with loop ID and set to RUNNING (conditional)
    //
    // DECISION (2026-04-10): Conditional UPDATE (status='planning' clause) prevents
    // a race where a fast user could cancel via the dashboard between save and update,
    // having their CANCELLED clobbered with RUNNING.
    // ========================================================================

    const updatedOrchestration = updateOrchestration(orchestration, {
      loopId: loopResult.value.id,
      status: OrchestratorStatus.RUNNING,
    });

    const updateResult = await this.orchestrationRepo.updateIfStatus(updatedOrchestration, OrchestratorStatus.PLANNING);
    if (!updateResult.ok) {
      this.logger.error('Failed to update orchestration with loop ID', updateResult.error, {
        orchestratorId: orchestration.id,
        loopId: loopResult.value.id,
      });
      await compensate('orchestration update failed', loopResult.value.id);
      return err(updateResult.error);
    }
    if (!updateResult.value) {
      // Status changed out from under us (user cancelled via dashboard between save and update)
      this.logger.info('Orchestration was cancelled during create flow — cleaning up loop', {
        orchestratorId: orchestration.id,
        loopId: loopResult.value.id,
      });
      await this.loopService.cancelLoop(loopResult.value.id, 'Orchestration cancelled during create', true);
      cleanupFiles();
      return err(
        new AutobeatError(ErrorCode.INVALID_OPERATION, 'Orchestration was cancelled before create completed', {
          orchestratorId: orchestration.id,
        }),
      );
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

  /**
   * Build finalSystemPrompt and finalUserPrompt from request + generated prompts.
   *
   * DECISION: When a custom systemPrompt is provided, it replaces the auto-generated
   * role instructions entirely. The operationalContract (state file path, working dir,
   * delegation commands) is injected into the user prompt so the agent can still
   * function without the default system prompt.
   */
  private buildFinalPrompts(
    request: OrchestratorCreateRequest,
    orchestration: Orchestration,
    stateFilePath: string,
    workingDirectory: string,
    agent: AgentProvider,
  ): { finalSystemPrompt: string; finalUserPrompt: string } {
    const {
      systemPrompt: orchestratorSystemPrompt,
      userPrompt,
      operationalContract,
    } = buildOrchestratorPrompt({
      goal: request.goal,
      stateFilePath,
      workingDirectory,
      maxDepth: orchestration.maxDepth,
      maxWorkers: orchestration.maxWorkers,
      agent,
      model: orchestration.model,
    });

    const customSystemPrompt = request.systemPrompt?.trim();
    const finalSystemPrompt = customSystemPrompt || orchestratorSystemPrompt;
    const finalUserPrompt = customSystemPrompt ? `${operationalContract}\n\n${userPrompt}` : userPrompt;

    return { finalSystemPrompt, finalUserPrompt };
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
      return this.orchestrationRepo.findByStatus(status, limit, offset);
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
    } else {
      // No loop yet (PLANNING state) — update DB directly since OrchestrationHandler
      // only subscribes to loop lifecycle events and won't see OrchestrationCancelled.
      const updated = updateOrchestration(orchestration, {
        status: OrchestratorStatus.CANCELLED,
        completedAt: Date.now(),
      });
      const updateResult = await this.orchestrationRepo.update(updated);
      if (!updateResult.ok) return err(updateResult.error);
    }

    // Emit cancellation event.
    // ARCHITECTURE: AttributedTaskCancellationHandler subscribes to OrchestrationCancelled
    // and cancels attributed sub-tasks — cancel cascade is event-driven (v1.3.0).
    // OrchestrationHandler updates DB status via loop events when loopId exists.
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
