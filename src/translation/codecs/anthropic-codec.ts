/**
 * Anthropic Messages API codec — source codec.
 *
 * ARCHITECTURE: This codec handles requests coming FROM Claude Code (source)
 * and responses going back TO Claude Code. It parses Anthropic wire format
 * into canonical IR and serializes canonical IR into Anthropic wire format.
 *
 * Named SSE events: Anthropic uses `event: <name>\ndata: <json>\n\n` format.
 */
import { err, ok, type Result } from '../../core/result.js';
import type { FormatCodec, StreamParser, StreamSerializer } from '../codec.js';
import type {
  CanonicalContent,
  CanonicalMessage,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStopReason,
  CanonicalStreamEvent,
  CanonicalSystemBlock,
  CanonicalToolChoice,
  CanonicalToolDefinition,
  CanonicalUsage,
} from '../ir.js';

// ==========================================
// parseRequest helpers
// ==========================================

function parseContentBlock(block: Record<string, unknown>): CanonicalContent {
  const type = block['type'];

  if (type === 'text') {
    const cc = block['cache_control'] as Record<string, unknown> | undefined;
    return {
      type: 'text',
      text: (block['text'] as string) ?? '',
      ...(cc ? { cacheControl: { type: cc['type'] as string } } : {}),
    };
  }

  if (type === 'image') {
    const source = block['source'] as Record<string, unknown>;
    return {
      type: 'image',
      source: {
        type: source['type'] as 'base64' | 'url',
        mediaType: source['media_type'] as string,
        data: source['data'] as string,
      },
    };
  }

  if (type === 'tool_use') {
    return {
      type: 'tool_use',
      id: block['id'] as string,
      name: block['name'] as string,
      input: (block['input'] as Record<string, unknown>) ?? {},
    };
  }

  if (type === 'tool_result') {
    const rawContent = block['content'];
    let content: CanonicalContent[] = [];
    if (Array.isArray(rawContent)) {
      content = rawContent.map((c) => parseContentBlock(c as Record<string, unknown>));
    } else if (typeof rawContent === 'string') {
      content = [{ type: 'text', text: rawContent }];
    }
    return {
      type: 'tool_result',
      toolUseId: block['tool_use_id'] as string,
      content,
      ...(block['is_error'] !== undefined ? { isError: block['is_error'] as boolean } : {}),
    };
  }

  if (type === 'thinking') {
    return {
      type: 'thinking',
      thinking: block['thinking'] as string,
      ...(block['signature'] ? { signature: block['signature'] as string } : {}),
    };
  }

  if (type === 'redacted_thinking') {
    return { type: 'redacted_thinking' };
  }

  if (type === 'document') {
    const source = block['source'] as Record<string, unknown>;
    return {
      type: 'document',
      source: {
        type: source['type'] as 'base64' | 'url',
        mediaType: source['media_type'] as string,
        data: source['data'] as string,
      },
    };
  }

  // Fallback: treat unknown as text
  return { type: 'text', text: String(block['text'] ?? '') };
}

function parseMessageContent(content: unknown): CanonicalContent[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  if (Array.isArray(content)) {
    return content.map((block) => parseContentBlock(block as Record<string, unknown>));
  }
  return [];
}

function parseSystemBlocks(system: unknown): CanonicalSystemBlock[] {
  if (typeof system === 'string') {
    return [{ type: 'text', text: system }];
  }
  if (Array.isArray(system)) {
    return system.map((block) => {
      const b = block as Record<string, unknown>;
      const cc = b['cache_control'] as Record<string, unknown> | undefined;
      return {
        type: 'text' as const,
        text: b['text'] as string,
        ...(cc ? { cacheControl: { type: cc['type'] as string } } : {}),
      };
    });
  }
  return [];
}

function parseToolChoice(raw: unknown): CanonicalToolChoice | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const tc = raw as Record<string, unknown>;
  const type = tc['type'] as string;

  if (type === 'any') return { type: 'required' };
  if (type === 'tool') return { type: 'specific', name: tc['name'] as string };
  if (type === 'auto') return { type: 'auto' };
  if (type === 'none') return { type: 'none' };

  return undefined;
}

// ==========================================
// serializeResponse helpers
// ==========================================

function serializeContentBlock(content: CanonicalContent): Record<string, unknown> {
  if (content.type === 'text') {
    return {
      type: 'text',
      text: content.text,
      ...(content.cacheControl ? { cache_control: content.cacheControl } : {}),
    };
  }

  if (content.type === 'tool_use') {
    return {
      type: 'tool_use',
      id: content.id,
      name: content.name,
      input: content.input,
    };
  }

  if (content.type === 'thinking') {
    return {
      type: 'thinking',
      thinking: content.thinking,
      ...(content.signature ? { signature: content.signature } : {}),
    };
  }

  if (content.type === 'redacted_thinking') {
    return { type: 'redacted_thinking' };
  }

  if (content.type === 'refusal') {
    return { type: 'text', text: `[Refusal] ${content.refusal}` };
  }

  // Fallback for other content types
  return { type: 'text', text: '' };
}

function serializeStopReason(stopReason: CanonicalStopReason): string | null {
  if (stopReason === null) return null;
  // Already in Anthropic format
  return stopReason;
}

function serializeUsage(usage: CanonicalUsage): Record<string, unknown> {
  const result: Record<string, unknown> = {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
  };
  if (usage.cacheReadInputTokens !== undefined) {
    result['cache_read_input_tokens'] = usage.cacheReadInputTokens;
  }
  if (usage.cacheCreationInputTokens !== undefined) {
    result['cache_creation_input_tokens'] = usage.cacheCreationInputTokens;
  }
  return result;
}

// ==========================================
// Stream serializer
// ==========================================

class AnthropicStreamSerializer implements StreamSerializer {
  private messageId = '';
  private messageModel = '';

  serialize(event: CanonicalStreamEvent): string[] {
    switch (event.type) {
      case 'message_start': {
        this.messageId = event.id;
        this.messageModel = event.model;
        const data = {
          type: 'message_start',
          message: {
            id: `msg_proxy_${event.id}`,
            type: 'message',
            role: 'assistant',
            content: [],
            model: event.model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        };
        return [`event: message_start`, `data: ${JSON.stringify(data)}`, ``];
      }

      case 'content_start': {
        const data = {
          type: 'content_block_start',
          index: event.index,
          content_block: { type: 'text', text: '' },
        };
        return [`event: content_block_start`, `data: ${JSON.stringify(data)}`, ``];
      }

      case 'content_delta': {
        const data = {
          type: 'content_block_delta',
          index: event.index,
          delta: { type: 'text_delta', text: event.text },
        };
        return [`event: content_block_delta`, `data: ${JSON.stringify(data)}`, ``];
      }

      case 'content_stop': {
        const data = { type: 'content_block_stop', index: event.index };
        return [`event: content_block_stop`, `data: ${JSON.stringify(data)}`, ``];
      }

      case 'tool_call_start': {
        const data = {
          type: 'content_block_start',
          index: event.index,
          content_block: {
            type: 'tool_use',
            id: event.id,
            name: event.name,
            input: {},
          },
        };
        return [`event: content_block_start`, `data: ${JSON.stringify(data)}`, ``];
      }

      case 'tool_call_delta': {
        const data = {
          type: 'content_block_delta',
          index: event.index,
          delta: { type: 'input_json_delta', partial_json: event.arguments },
        };
        return [`event: content_block_delta`, `data: ${JSON.stringify(data)}`, ``];
      }

      case 'tool_call_stop': {
        const data = { type: 'content_block_stop', index: event.index };
        return [`event: content_block_stop`, `data: ${JSON.stringify(data)}`, ``];
      }

      case 'thinking_delta': {
        const data = {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: event.thinking },
        };
        return [`event: content_block_delta`, `data: ${JSON.stringify(data)}`, ``];
      }

      case 'message_stop': {
        const deltaData = {
          type: 'message_delta',
          delta: {
            stop_reason: serializeStopReason(event.stopReason),
            stop_sequence: null,
          },
          usage: event.usage ? { output_tokens: event.usage.outputTokens } : { output_tokens: 0 },
        };
        const stopData = { type: 'message_stop' };
        return [
          `event: message_delta`,
          `data: ${JSON.stringify(deltaData)}`,
          ``,
          `event: message_stop`,
          `data: ${JSON.stringify(stopData)}`,
          ``,
        ];
      }

      case 'usage': {
        // Anthropic doesn't have a standalone usage event — ignore or fold into message_stop
        return [];
      }

      default:
        return [];
    }
  }
}

// ==========================================
// Stream parser (source → not used by this codec in normal flow)
// ==========================================

class AnthropicStreamParser implements StreamParser {
  processChunk(_data: unknown): CanonicalStreamEvent[] {
    // ARCHITECTURE: AnthropicStreamParser is not used in the primary flow
    // (the proxy receives from OpenAI and sends back to Anthropic). This
    // would be used if proxying in the reverse direction.
    return [];
  }

  flush(): CanonicalStreamEvent[] {
    return [];
  }
}

// ==========================================
// Codec
// ==========================================

export class AnthropicCodec implements FormatCodec {
  readonly name = 'anthropic';

  parseRequest(raw: unknown): Result<CanonicalRequest> {
    if (!raw || typeof raw !== 'object') {
      return err(new Error('Request must be an object'));
    }

    const r = raw as Record<string, unknown>;

    if (typeof r['model'] !== 'string' || !r['model']) {
      return err(new Error('Request must have a model field'));
    }

    if (!Array.isArray(r['messages'])) {
      return err(new Error('Request must have a messages array'));
    }

    if (typeof r['max_tokens'] !== 'number') {
      return err(new Error('Request must have max_tokens'));
    }

    const messages: CanonicalMessage[] = (r['messages'] as Array<Record<string, unknown>>).map((msg) => ({
      role: msg['role'] as 'user' | 'assistant',
      content: parseMessageContent(msg['content']),
    }));

    const tools: CanonicalToolDefinition[] | undefined = r['tools']
      ? (r['tools'] as Array<Record<string, unknown>>).map((t) => ({
          name: t['name'] as string,
          ...(t['description'] ? { description: t['description'] as string } : {}),
          inputSchema: (t['input_schema'] as Record<string, unknown>) ?? {},
        }))
      : undefined;

    let thinking: { budgetTokens: number } | undefined;
    if (r['thinking'] && typeof r['thinking'] === 'object') {
      const th = r['thinking'] as Record<string, unknown>;
      if (th['budget_tokens'] !== undefined) {
        thinking = { budgetTokens: th['budget_tokens'] as number };
      }
    }

    const request: CanonicalRequest = {
      model: r['model'] as string,
      messages,
      maxTokens: r['max_tokens'] as number,
      stream: r['stream'] === true,
      ...(r['system'] !== undefined ? { system: parseSystemBlocks(r['system']) } : {}),
      ...(tools !== undefined ? { tools } : {}),
      ...(r['tool_choice'] !== undefined ? { toolChoice: parseToolChoice(r['tool_choice']) } : {}),
      ...(r['stop_sequences'] ? { stopSequences: r['stop_sequences'] as string[] } : {}),
      ...(r['temperature'] !== undefined ? { temperature: r['temperature'] as number } : {}),
      ...(r['top_p'] !== undefined ? { topP: r['top_p'] as number } : {}),
      ...(r['top_k'] !== undefined ? { topK: r['top_k'] as number } : {}),
      ...(thinking ? { thinking } : {}),
      ...(r['metadata'] ? { metadata: r['metadata'] as { userId?: string } } : {}),
    };

    return ok(request);
  }

  serializeRequest(canonical: CanonicalRequest): Result<unknown> {
    // ARCHITECTURE: AnthropicCodec.serializeRequest would be used in reverse
    // proxy mode. Not needed for source→target flow.
    return ok({
      model: canonical.model,
      messages: canonical.messages,
      max_tokens: canonical.maxTokens,
    });
  }

  parseResponse(_raw: unknown): Result<CanonicalResponse> {
    // ARCHITECTURE: Used in reverse proxy mode only.
    return err(new Error('AnthropicCodec.parseResponse not implemented for source codec'));
  }

  serializeResponse(canonical: CanonicalResponse): Result<unknown> {
    const content = canonical.content.map(serializeContentBlock);

    return ok({
      id: `msg_proxy_${canonical.id}`,
      type: 'message',
      role: 'assistant',
      content,
      model: canonical.model,
      stop_reason: serializeStopReason(canonical.stopReason),
      stop_sequence: null,
      usage: serializeUsage(canonical.usage),
    });
  }

  createStreamParser(): StreamParser {
    return new AnthropicStreamParser();
  }

  createStreamSerializer(): StreamSerializer {
    return new AnthropicStreamSerializer();
  }
}
