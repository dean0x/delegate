/**
 * Orchestration handler for lifecycle management
 * ARCHITECTURE: Event-driven orchestration state management (v0.9.0)
 * Pattern: Factory pattern for async initialization (matches LoopHandler)
 * Rationale: Correlates loop lifecycle events to orchestration status updates
 */

import { LoopId, LoopStatus, OrchestratorStatus, updateOrchestration } from '../../core/domain.js';
import type { EventBus } from '../../core/events/event-bus.js';
import type { LoopCancelledEvent, LoopCompletedEvent } from '../../core/events/events.js';
import { BaseEventHandler } from '../../core/events/handlers.js';
import type {
  Logger,
  SyncLoopOperations,
  SyncOrchestrationOperations,
  TransactionRunner,
} from '../../core/interfaces.js';
import { ok, type Result } from '../../core/result.js';

export class OrchestrationHandler extends BaseEventHandler {
  /**
   * Private constructor - use OrchestrationHandler.create() instead
   * ARCHITECTURE: Factory pattern ensures handler is fully initialized before use
   */
  private constructor(
    private readonly orchestrationRepo: SyncOrchestrationOperations,
    private readonly loopRepo: SyncLoopOperations,
    private readonly database: TransactionRunner,
    logger: Logger,
  ) {
    super(logger, 'OrchestrationHandler');
  }

  /**
   * Factory method to create a fully initialized OrchestrationHandler
   * ARCHITECTURE: Guarantees handler is ready to use — no uninitialized state possible
   */
  static async create(
    orchestrationRepo: SyncOrchestrationOperations,
    loopRepo: SyncLoopOperations,
    database: TransactionRunner,
    eventBus: EventBus,
    logger: Logger,
  ): Promise<Result<OrchestrationHandler>> {
    const handler = new OrchestrationHandler(orchestrationRepo, loopRepo, database, logger);

    // Subscribe to loop lifecycle events
    const completedSub = eventBus.subscribe<LoopCompletedEvent>('LoopCompleted', async (event) =>
      handler.handleLoopCompleted(event),
    );
    if (!completedSub.ok) {
      logger.error('Failed to subscribe to LoopCompleted', completedSub.error);
    }

    const cancelledSub = eventBus.subscribe<LoopCancelledEvent>('LoopCancelled', async (event) =>
      handler.handleLoopCancelled(event),
    );
    if (!cancelledSub.ok) {
      logger.error('Failed to subscribe to LoopCancelled', cancelledSub.error);
    }

    logger.info('OrchestrationHandler initialized');
    return ok(handler);
  }

  /**
   * Handle LoopCompleted: map loop terminal state to orchestration status
   *
   * IMPORTANT: No LoopFailed event exists. Both success and failure come through
   * LoopCompleted. We must load the loop from SQLite to check its actual status.
   */
  private async handleLoopCompleted(event: LoopCompletedEvent): Promise<void> {
    this.updateOrchestrationForLoop(event.loopId, (loopStatus) => {
      if (loopStatus === LoopStatus.COMPLETED) {
        return OrchestratorStatus.COMPLETED;
      }
      // LoopStatus.FAILED comes through LoopCompleted event
      return OrchestratorStatus.FAILED;
    });
  }

  /**
   * Handle LoopCancelled: mark orchestration as cancelled
   */
  private async handleLoopCancelled(event: LoopCancelledEvent): Promise<void> {
    this.updateOrchestrationForLoop(event.loopId, () => OrchestratorStatus.CANCELLED);
  }

  /**
   * Shared helper: look up orchestration by loopId and update status in a transaction
   */
  private updateOrchestrationForLoop(
    loopId: LoopId,
    resolveStatus: (loopStatus: LoopStatus) => OrchestratorStatus,
  ): void {
    const txResult = this.database.runInTransaction(() => {
      // Find the orchestration that owns this loop
      const orchestration = this.orchestrationRepo.findByLoopIdSync(loopId);
      if (!orchestration) {
        // Not an orchestration-owned loop — no-op
        return;
      }

      // Load the loop to get its actual status
      const loop = this.loopRepo.findByIdSync(loopId);
      const loopStatus = loop?.status ?? LoopStatus.FAILED;

      const newStatus = resolveStatus(loopStatus);
      const updated = updateOrchestration(orchestration, {
        status: newStatus,
        completedAt: Date.now(),
      });

      this.orchestrationRepo.updateSync(updated);

      this.logger.info('Orchestration status updated from loop event', {
        orchestratorId: orchestration.id,
        loopId,
        newStatus,
        loopStatus,
      });
    });

    if (!txResult.ok) {
      this.logger.error('Failed to update orchestration status', txResult.error, { loopId });
    }
  }
}
