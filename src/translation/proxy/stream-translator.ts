/**
 * Stream translator — orchestrates OpenAI parser + middleware + Anthropic serializer.
 *
 * ARCHITECTURE: The stream translator sits between the raw SSE lines from the
 * target (OpenAI) and the SSE output to the source (Claude Code). It processes
 * one SSE line at a time, yielding zero or more Anthropic SSE strings.
 *
 * Line routing:
 * - `data: [DONE]` → end sentinel, no-op
 * - `data: <json>` → parse JSON, route through target parser + middleware + source serializer
 * - `event: <name>` → ignored (OpenAI doesn't use named events)
 * - `: <comment>` → ignored
 * - Empty line → ignored (SSE event separator)
 */
import type { StreamParser, StreamSerializer } from '../codec.js';
import type { CanonicalStreamEvent } from '../ir.js';
import type { TranslationMiddleware } from '../middleware/middleware.js';
import { runStreamEventMiddleware } from '../middleware/middleware.js';

export class StreamTranslator {
  constructor(
    private readonly sourceSerializer: StreamSerializer,
    private readonly targetParser: StreamParser,
    private readonly middlewares: readonly TranslationMiddleware[],
  ) {}

  /**
   * Process one raw SSE line from the target API.
   * Returns Anthropic SSE strings to write to the client.
   */
  processLine(line: string): string[] {
    // Ignore empty lines (SSE event separator)
    if (line === '') return [];

    // Ignore event: lines (OpenAI doesn't use named events)
    if (line.startsWith('event:')) return [];

    // Ignore comment lines
    if (line.startsWith(':')) return [];

    // SSE data prefix
    if (!line.startsWith('data: ')) return [];

    const payload = line.slice('data: '.length);

    // [DONE] sentinel — end of stream
    if (payload === '[DONE]') return [];

    // Parse JSON
    let data: unknown;
    try {
      data = JSON.parse(payload);
    } catch {
      // Malformed JSON — skip silently
      return [];
    }

    // Route through target parser
    const canonicalEvents = this.targetParser.processChunk(data);

    // Run each event through middleware and serialize
    const output: string[] = [];
    for (const event of canonicalEvents) {
      const processed = this.applyMiddleware(event);
      if (processed) {
        const lines = this.sourceSerializer.serialize(processed);
        output.push(...lines);
      }
    }

    return output;
  }

  /**
   * Flush any remaining state from the target parser.
   * Call at end of stream.
   */
  flush(): string[] {
    const canonicalEvents = this.targetParser.flush();
    const output: string[] = [];
    for (const event of canonicalEvents) {
      const processed = this.applyMiddleware(event);
      if (processed) {
        const lines = this.sourceSerializer.serialize(processed);
        output.push(...lines);
      }
    }
    return output;
  }

  private applyMiddleware(event: CanonicalStreamEvent): CanonicalStreamEvent | null {
    if (this.middlewares.length === 0) return event;
    return runStreamEventMiddleware(this.middlewares, event);
  }
}
