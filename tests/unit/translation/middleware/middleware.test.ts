/**
 * Tests for middleware pipeline runner functions.
 */
import { describe, expect, it } from 'vitest';
import type { CanonicalRequest, CanonicalResponse, CanonicalStreamEvent } from '../../../../src/translation/ir.js';
import {
  runRequestMiddleware,
  runResponseMiddleware,
  runStreamEventMiddleware,
  type TranslationMiddleware,
} from '../../../../src/translation/middleware/middleware.js';

function makeRequest(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    maxTokens: 1024,
    stream: false,
    ...overrides,
  };
}

function makeResponse(overrides: Partial<CanonicalResponse> = {}): CanonicalResponse {
  return {
    id: 'msg_1',
    model: 'gpt-4o',
    content: [{ type: 'text', text: 'Hi' }],
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 5 },
    ...overrides,
  };
}

function makeStreamEvent(text: string): CanonicalStreamEvent {
  return { type: 'content_delta', index: 0, text };
}

/** Create a middleware that appends a tag to the model field of a request */
function makeRequestTagger(tag: string): TranslationMiddleware {
  return {
    name: `request-tagger-${tag}`,
    processRequest(request: CanonicalRequest): CanonicalRequest {
      return { ...request, model: `${request.model}:${tag}` };
    },
  };
}

/** Create a middleware that appends a tag to the id field of a response */
function makeResponseTagger(tag: string): TranslationMiddleware {
  return {
    name: `response-tagger-${tag}`,
    processResponse(response: CanonicalResponse): CanonicalResponse {
      return { ...response, id: `${response.id}:${tag}` };
    },
  };
}

/** Create a middleware that appends a tag to stream event text delta */
function makeStreamTagger(tag: string): TranslationMiddleware {
  return {
    name: `stream-tagger-${tag}`,
    processStreamEvent(event: CanonicalStreamEvent): CanonicalStreamEvent {
      if (event.type === 'content_delta') {
        return { ...event, text: `${event.text}:${tag}` };
      }
      return event;
    },
  };
}

/** Create a middleware that drops (returns null) all stream events */
function makeStreamDropper(): TranslationMiddleware {
  return {
    name: 'stream-dropper',
    processStreamEvent(): null {
      return null;
    },
  };
}

describe('runRequestMiddleware', () => {
  it('runs middlewares in forward order (first → last)', () => {
    const middlewares = [makeRequestTagger('A'), makeRequestTagger('B'), makeRequestTagger('C')];
    const result = runRequestMiddleware(middlewares, makeRequest({ model: 'base' }));
    // Forward: base → base:A → base:A:B → base:A:B:C
    expect(result.model).toBe('base:A:B:C');
  });

  it('returns request unchanged when no middlewares', () => {
    const request = makeRequest();
    const result = runRequestMiddleware([], request);
    expect(result).toBe(request);
  });

  it('skips middleware that does not implement processRequest', () => {
    const noOpMiddleware: TranslationMiddleware = { name: 'no-op' };
    const tagger = makeRequestTagger('A');
    const result = runRequestMiddleware([noOpMiddleware, tagger], makeRequest({ model: 'base' }));
    expect(result.model).toBe('base:A');
  });
});

describe('runResponseMiddleware', () => {
  it('runs middlewares in reverse order (last → first)', () => {
    const middlewares = [makeResponseTagger('A'), makeResponseTagger('B'), makeResponseTagger('C')];
    const result = runResponseMiddleware(middlewares, makeResponse({ id: 'base' }));
    // Reverse: base → base:C → base:C:B → base:C:B:A
    expect(result.id).toBe('base:C:B:A');
  });

  it('returns response unchanged when no middlewares', () => {
    const response = makeResponse();
    const result = runResponseMiddleware([], response);
    expect(result).toBe(response);
  });

  it('skips middleware that does not implement processResponse', () => {
    const noOpMiddleware: TranslationMiddleware = { name: 'no-op' };
    const tagger = makeResponseTagger('A');
    // Reverse order: [no-op, tagger] reversed = [tagger, no-op]
    const result = runResponseMiddleware([noOpMiddleware, tagger], makeResponse({ id: 'base' }));
    expect(result.id).toBe('base:A');
  });
});

describe('runStreamEventMiddleware', () => {
  it('runs middlewares in reverse order (last → first)', () => {
    const middlewares = [makeStreamTagger('A'), makeStreamTagger('B'), makeStreamTagger('C')];
    const event = makeStreamEvent('hello');
    const result = runStreamEventMiddleware(middlewares, event);
    // Reverse: hello → hello:C → hello:C:B → hello:C:B:A
    expect(result).not.toBeNull();
    if (result?.type === 'content_delta') {
      expect(result.text).toBe('hello:C:B:A');
    } else {
      throw new Error('Expected content_delta');
    }
  });

  it('returns null when a middleware drops the event', () => {
    const dropper = makeStreamDropper();
    const event = makeStreamEvent('hello');
    const result = runStreamEventMiddleware([dropper], event);
    expect(result).toBeNull();
  });

  it('stops processing once an event is dropped (short-circuits)', () => {
    let afterDropperCalled = false;
    const afterDropper: TranslationMiddleware = {
      name: 'after-dropper',
      processStreamEvent(): CanonicalStreamEvent | null {
        afterDropperCalled = true;
        return null;
      },
    };
    const dropper = makeStreamDropper();
    // Reverse order: [afterDropper, dropper] → dropper runs first, then afterDropper
    // But dropper returns null, so afterDropper should NOT be called
    const event = makeStreamEvent('hello');
    const result = runStreamEventMiddleware([afterDropper, dropper], event);
    expect(result).toBeNull();
    expect(afterDropperCalled).toBe(false);
  });

  it('returns event unchanged when no middlewares', () => {
    const event = makeStreamEvent('hello');
    const result = runStreamEventMiddleware([], event);
    expect(result).toBe(event);
  });

  it('skips middleware that does not implement processStreamEvent', () => {
    const noOpMiddleware: TranslationMiddleware = { name: 'no-op' };
    const tagger = makeStreamTagger('A');
    const event = makeStreamEvent('hello');
    const result = runStreamEventMiddleware([noOpMiddleware, tagger], event);
    expect(result).not.toBeNull();
    if (result?.type === 'content_delta') {
      expect(result.text).toBe('hello:A');
    } else {
      throw new Error('Expected content_delta');
    }
  });
});
