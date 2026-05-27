/**
 * ChannelMessagePersistenceHandler — captures ChannelMessageSent events and persists summaries.
 *
 * ARCHITECTURE: Event-driven, best-effort capture — mirrors UsageCaptureHandler pattern.
 * - Single concern: persist message summaries for dashboard display.
 * - Errors logged as warn, never thrown, never propagated.
 * - Factory pattern for async initialization (matches UsageCaptureHandler, CheckpointHandler).
 * - Guards on optional summary field: silently skips events without a summary.
 *
 * Pattern: Template Method via BaseEventHandler.
 */

import { ChannelId } from '../../core/domain.js';
import { AutobeatError, ErrorCode } from '../../core/errors.js';
import { EventBus } from '../../core/events/event-bus.js';
import type { ChannelMessageSentEvent } from '../../core/events/events.js';
import { BaseEventHandler } from '../../core/events/handlers.js';
import type { ChannelRepository, Logger } from '../../core/interfaces.js';
import { err, ok, type Result } from '../../core/result.js';

export interface ChannelMessagePersistenceHandlerDeps {
  readonly channelRepository: ChannelRepository;
  readonly eventBus: EventBus;
  readonly logger: Logger;
}

export class ChannelMessagePersistenceHandler extends BaseEventHandler {
  private readonly channelRepository: ChannelRepository;
  private readonly eventBus: EventBus;

  /**
   * Private constructor — use ChannelMessagePersistenceHandler.create() instead.
   * ARCHITECTURE: Factory pattern ensures handler is fully initialized before use.
   */
  private constructor(deps: ChannelMessagePersistenceHandlerDeps) {
    super(deps.logger, 'ChannelMessagePersistenceHandler');
    this.channelRepository = deps.channelRepository;
    this.eventBus = deps.eventBus;
  }

  /**
   * Factory method — creates and subscribes the handler.
   * ARCHITECTURE: Guarantees handler is ready to use — no uninitialized state possible.
   */
  static async create(
    deps: ChannelMessagePersistenceHandlerDeps,
  ): Promise<Result<ChannelMessagePersistenceHandler, AutobeatError>> {
    const handlerLogger = deps.logger.child
      ? deps.logger.child({ module: 'ChannelMessagePersistenceHandler' })
      : deps.logger;
    const handler = new ChannelMessagePersistenceHandler({ ...deps, logger: handlerLogger });

    const subscribeResult = handler.subscribeToEvents();
    if (!subscribeResult.ok) {
      return subscribeResult;
    }

    handlerLogger.info('ChannelMessagePersistenceHandler initialized');
    return ok(handler);
  }

  private subscribeToEvents(): Result<void, AutobeatError> {
    const result = this.eventBus.subscribe('ChannelMessageSent', this.handleChannelMessageSent.bind(this));
    if (!result.ok) {
      return err(
        new AutobeatError(
          ErrorCode.SYSTEM_ERROR,
          `Failed to subscribe to ChannelMessageSent: ${result.error.message}`,
          { error: result.error },
        ),
      );
    }
    return ok(undefined);
  }

  private async handleChannelMessageSent(event: ChannelMessageSentEvent): Promise<void> {
    await this.handleEvent(event, async (e) => {
      return this.persistMessage(e);
    });
  }

  private async persistMessage(event: ChannelMessageSentEvent): Promise<Result<void>> {
    // Guard: only persist events that carry a summary (Phase 9+).
    // Events emitted before Phase 9 or from code paths that don't set summary are silently skipped.
    if (!event.summary) {
      return ok(undefined);
    }

    const msg = {
      id: `cm-${crypto.randomUUID()}`,
      channelId: ChannelId(event.channelId),
      fromMember: event.from,
      toMember: event.to === 'all' ? null : event.to,
      round: event.round,
      summary: event.summary,
      createdAt: event.timestamp,
    };

    const saveResult = await this.channelRepository.saveMessage(msg);
    if (!saveResult.ok) {
      this.logger.warn('ChannelMessagePersistenceHandler: failed to save message', {
        channelId: event.channelId,
        error: saveResult.error.message,
      });
      return ok(undefined); // best-effort — don't propagate
    }

    this.logger.debug('ChannelMessagePersistenceHandler: message saved', {
      channelId: event.channelId,
      messageId: msg.id,
      round: event.round,
    });

    return ok(undefined);
  }
}
