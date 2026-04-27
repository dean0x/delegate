/**
 * Logging middleware for translation proxy.
 *
 * ARCHITECTURE: Logs request metadata (model, counts, flags) and response
 * metadata (stop reason, tokens) for observability. NEVER logs full request/
 * response bodies or API keys.
 *
 * DECISION: Uses the structured Logger interface from core/interfaces.ts
 * rather than console.log. Rationale: consistent JSON structured logging
 * with context propagation across the codebase.
 *
 * Security constraint: maskApiKey() is imported but used externally when
 * constructing proxy configs with logger context. This middleware itself
 * never receives API keys — they are only held by the proxy config.
 */
import type { Logger } from '../../core/interfaces.js';
import type { CanonicalRequest, CanonicalResponse } from '../ir.js';
import type { TranslationMiddleware } from './middleware.js';

export class LoggingMiddleware implements TranslationMiddleware {
  readonly name = 'logging';

  private requestStartTime = 0;
  private requestModel = '';

  constructor(private readonly logger: Logger) {}

  processRequest(request: CanonicalRequest): CanonicalRequest {
    this.requestStartTime = Date.now();
    this.requestModel = request.model;

    this.logger.debug('Translation proxy: outbound request', {
      model: request.model,
      messageCount: request.messages.length,
      toolCount: request.tools?.length ?? 0,
      streaming: request.stream,
      hasSystem: (request.system?.length ?? 0) > 0,
      hasThinking: !!request.thinking,
    });

    return request;
  }

  processResponse(response: CanonicalResponse): CanonicalResponse {
    const elapsed = Date.now() - this.requestStartTime;

    this.logger.debug('Translation proxy: inbound response', {
      model: this.requestModel,
      stopReason: response.stopReason,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      ...(response.usage.cacheReadInputTokens !== undefined
        ? { cacheReadInputTokens: response.usage.cacheReadInputTokens }
        : {}),
      ...(response.usage.cacheCreationInputTokens !== undefined
        ? { cacheCreationInputTokens: response.usage.cacheCreationInputTokens }
        : {}),
      elapsedMs: elapsed,
    });

    return response;
  }
}
