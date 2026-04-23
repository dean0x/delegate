/**
 * Translation middleware interface and pipeline runner.
 *
 * ARCHITECTURE: Middleware can observe/modify canonical IR at three points:
 * outbound request, inbound response, and inbound stream events.
 *
 * Request pipeline runs in order (first → last).
 * Response/stream pipeline runs in REVERSE order (last → first) to mirror
 * the onion model where the outermost middleware wraps the response.
 *
 * DECISION: Returning null from processStreamEvent drops the event.
 * This enables middleware like tool-name-mapping to suppress intermediate
 * events if needed (though currently none do).
 */
import type { CanonicalRequest, CanonicalResponse, CanonicalStreamEvent } from '../ir.js';

export interface TranslationMiddleware {
  readonly name: string;
  processRequest?(request: CanonicalRequest): CanonicalRequest;
  processResponse?(response: CanonicalResponse): CanonicalResponse;
  processStreamEvent?(event: CanonicalStreamEvent): CanonicalStreamEvent | null;
}

/**
 * Run request through middleware pipeline in order (first → last).
 */
export function runRequestMiddleware(
  middlewares: readonly TranslationMiddleware[],
  request: CanonicalRequest,
): CanonicalRequest {
  return middlewares.reduce((req, mw) => (mw.processRequest ? mw.processRequest(req) : req), request);
}

/**
 * Run response through middleware pipeline in REVERSE order (last → first).
 */
export function runResponseMiddleware(
  middlewares: readonly TranslationMiddleware[],
  response: CanonicalResponse,
): CanonicalResponse {
  return [...middlewares].reverse().reduce((res, mw) => (mw.processResponse ? mw.processResponse(res) : res), response);
}

/**
 * Run stream event through middleware pipeline in REVERSE order.
 * Returns null if any middleware drops the event.
 */
export function runStreamEventMiddleware(
  middlewares: readonly TranslationMiddleware[],
  event: CanonicalStreamEvent,
): CanonicalStreamEvent | null {
  let current: CanonicalStreamEvent | null = event;
  for (const mw of [...middlewares].reverse()) {
    if (!current) return null;
    if (mw.processStreamEvent) {
      current = mw.processStreamEvent(current);
    }
  }
  return current;
}
