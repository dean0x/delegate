/**
 * OpenAI Chat Completions API codec — target codec.
 *
 * ARCHITECTURE: This codec handles requests going TO OpenAI (target) and
 * responses coming back FROM OpenAI. It serializes canonical IR into OpenAI
 * wire format and parses OpenAI responses back into canonical IR.
 *
 * Key differences from Anthropic:
 * - No named SSE events (just `data: <json>\n\n`)
 * - Tool definitions wrapped in `{ type: 'function', function: {...} }`
 * - System prompt is a message with role 'system'
 * - tool_choice uses 'tool_calls' finish_reason (not 'tool_use')
 * - Reasoning uses `reasoning_effort` instead of `thinking.budget_tokens`
 */
import { err, ok, type Result } from '../../core/result.js';
import type { FormatCodec, StreamParser, StreamSerializer } from '../codec.js';
import type {
  CanonicalContent,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStopReason,
  CanonicalStreamEvent,
  CanonicalUsage,
} from '../ir.js';

// ==========================================
// serializeRequest helpers
// ==========================================

function thinkingToReasoningEffort(budgetTokens: number): string {
  if (budgetTokens > 10000) return 'high';
  if (budgetTokens > 3000) return 'medium';
  return 'low';
}

function serializeContentForOpenAI(content: CanonicalContent[]): Array<Record<string, unknown>> | string {
  // If single text block, return as string (simpler)
  if (content.length === 1 && content[0].type === 'text' && !content[0].cacheControl) {
    return content[0].text;
  }

  // Otherwise, build array
  const parts: Array<Record<string, unknown>> = [];
  for (const block of content) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'image') {
      if (block.source.type === 'base64') {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${block.source.mediaType};base64,${block.source.data}` },
        });
      } else {
        parts.push({ type: 'image_url', image_url: { url: block.source.data } });
      }
    }
    // Other content types are ignored or handled at message level
  }
  return parts;
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | Array<Record<string, unknown>> | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

function buildOpenAIMessages(canonical: CanonicalRequest): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];

  // System blocks → system message
  if (canonical.system && canonical.system.length > 0) {
    const systemText = canonical.system.map((b) => b.text).join('\n\n');
    messages.push({ role: 'system', content: systemText });
  }

  // Canonical messages
  for (const msg of canonical.messages) {
    // Check if message has only tool_result blocks → becomes 'tool' messages
    const toolResults = msg.content.filter((c) => c.type === 'tool_result');
    const nonToolResults = msg.content.filter((c) => c.type !== 'tool_result');

    if (toolResults.length > 0) {
      // Emit each tool_result as a separate tool message
      for (const tr of toolResults) {
        if (tr.type === 'tool_result') {
          let content: string;
          if (tr.content.length === 1 && tr.content[0].type === 'text') {
            content = tr.content[0].text;
          } else {
            content = tr.content
              .filter((c) => c.type === 'text')
              .map((c) => (c.type === 'text' ? c.text : ''))
              .join('\n');
          }
          messages.push({
            role: 'tool',
            tool_call_id: tr.toolUseId,
            content,
          });
        }
      }
      // If also has non-tool-result content, emit as user message
      if (nonToolResults.length > 0) {
        messages.push({
          role: 'user',
          content: serializeContentForOpenAI(nonToolResults),
        });
      }
      continue;
    }

    // Check if assistant message has tool_use blocks → becomes tool_calls
    if (msg.role === 'assistant') {
      const toolUses = msg.content.filter((c) => c.type === 'tool_use');
      const textBlocks = msg.content.filter((c) => c.type === 'text');

      const assistantMsg: OpenAIMessage = { role: 'assistant' };

      if (textBlocks.length > 0) {
        assistantMsg.content = serializeContentForOpenAI(textBlocks);
      } else {
        assistantMsg.content = null;
      }

      if (toolUses.length > 0) {
        assistantMsg.tool_calls = toolUses
          .filter((c) => c.type === 'tool_use')
          .map((c) => {
            if (c.type === 'tool_use') {
              return {
                id: c.id,
                type: 'function' as const,
                function: {
                  name: c.name,
                  arguments: JSON.stringify(c.input),
                },
              };
            }
            return { id: '', type: 'function' as const, function: { name: '', arguments: '{}' } };
          });
      }

      messages.push(assistantMsg);
      continue;
    }

    // Regular user message
    messages.push({
      role: 'user',
      content: serializeContentForOpenAI(msg.content),
    });
  }

  return messages;
}

// ==========================================
// parseResponse helpers
// ==========================================

function mapFinishReason(finishReason: string | null): CanonicalStopReason {
  if (!finishReason) return null;
  switch (finishReason) {
    case 'stop':
      return 'end_turn';
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'end_turn';
  }
}

function parseOpenAIUsage(usage: Record<string, unknown>): CanonicalUsage {
  const promptDetails = usage['prompt_tokens_details'] as Record<string, unknown> | undefined;
  const completionDetails = usage['completion_tokens_details'] as Record<string, unknown> | undefined;

  return {
    inputTokens: (usage['prompt_tokens'] as number) ?? 0,
    outputTokens: (usage['completion_tokens'] as number) ?? 0,
    ...(promptDetails?.['cached_tokens'] ? { cacheReadInputTokens: promptDetails['cached_tokens'] as number } : {}),
    ...(completionDetails?.['reasoning_tokens']
      ? { reasoningTokens: completionDetails['reasoning_tokens'] as number }
      : {}),
  };
}

// ==========================================
// Stream parser state machine
// ==========================================

interface ActiveToolCall {
  id: string;
  name: string;
  argumentsAccumulator: string;
  started: boolean;
}

class OpenAIStreamParser implements StreamParser {
  private hasEmittedMessageStart = false;
  private hasActiveTextBlock = false;
  private currentContentIndex = 0;
  private activeToolCalls = new Map<number, ActiveToolCall>();
  private savedId = '';
  private savedModel = '';
  private lastActiveToolIndex = -1;

  processChunk(data: unknown): CanonicalStreamEvent[] {
    if (!data || typeof data !== 'object') return [];
    const chunk = data as Record<string, unknown>;
    const events: CanonicalStreamEvent[] = [];

    // Usage chunk (no choices)
    const usageRaw = chunk['usage'] as Record<string, unknown> | undefined;
    if (usageRaw && (chunk['choices'] as unknown[])?.length === 0) {
      events.push({
        type: 'usage',
        usage: parseOpenAIUsage(usageRaw),
      });
      return events;
    }

    const choices = chunk['choices'] as Array<Record<string, unknown>> | undefined;
    if (!choices || choices.length === 0) {
      // Might be a usage-only chunk
      if (usageRaw) {
        events.push({ type: 'usage', usage: parseOpenAIUsage(usageRaw) });
      }
      return events;
    }

    const choice = choices[0];
    const delta = choice['delta'] as Record<string, unknown> | undefined;
    const finishReason = choice['finish_reason'] as string | null;

    if (!delta) {
      if (finishReason) {
        events.push(...this.handleFinishReason(finishReason, chunk));
      }
      return events;
    }

    // First chunk: emit message_start if we have id/model
    if (!this.hasEmittedMessageStart) {
      const id = (chunk['id'] as string) ?? 'stream_id';
      const model = (chunk['model'] as string) ?? 'unknown';
      this.savedId = id;
      this.savedModel = model;

      if (delta['role'] !== undefined || delta['content'] !== undefined || delta['tool_calls'] !== undefined) {
        events.push({ type: 'message_start', id, model });
        this.hasEmittedMessageStart = true;
      }
    }

    // Text content delta
    const content = delta['content'] as string | null | undefined;
    if (content !== null && content !== undefined && content !== '') {
      // Close any active tool call block first
      if (this.lastActiveToolIndex >= 0) {
        const tc = this.activeToolCalls.get(this.lastActiveToolIndex);
        if (tc && tc.started) {
          events.push({
            type: 'tool_call_stop',
            index: this.lastActiveToolIndex,
            arguments: tc.argumentsAccumulator,
          });
          this.currentContentIndex++;
          this.lastActiveToolIndex = -1;
        }
      }

      if (!this.hasActiveTextBlock) {
        events.push({ type: 'content_start', index: this.currentContentIndex, contentType: 'text' });
        this.hasActiveTextBlock = true;
      }
      events.push({ type: 'content_delta', index: this.currentContentIndex, text: content });
    }

    // Tool calls delta
    const toolCalls = delta['tool_calls'] as Array<Record<string, unknown>> | undefined;
    if (toolCalls) {
      // Close text block if open
      if (this.hasActiveTextBlock) {
        events.push({ type: 'content_stop', index: this.currentContentIndex });
        this.currentContentIndex++;
        this.hasActiveTextBlock = false;
      }

      for (const tc of toolCalls) {
        const tcIndex = tc['index'] as number;
        const func = tc['function'] as Record<string, unknown> | undefined;
        const tcId = tc['id'] as string | undefined;
        const tcName = func?.['name'] as string | undefined;
        const tcArgs = func?.['arguments'] as string | undefined;

        if (!this.activeToolCalls.has(tcIndex)) {
          // New tool call
          const toolCallData: ActiveToolCall = {
            id: tcId ?? '',
            name: tcName ?? '',
            argumentsAccumulator: tcArgs ?? '',
            started: false,
          };
          this.activeToolCalls.set(tcIndex, toolCallData);

          if (tcId && tcName) {
            toolCallData.started = true;
            events.push({
              type: 'tool_call_start',
              index: this.currentContentIndex,
              id: tcId,
              name: tcName,
            });
            this.lastActiveToolIndex = this.currentContentIndex;
            // Store with the content index as key for lookup
            this.activeToolCalls.delete(tcIndex);
            this.activeToolCalls.set(this.currentContentIndex, toolCallData);
          }
        } else {
          // Continuing tool call
          const existing = this.activeToolCalls.get(tcIndex)!;
          if (!existing.started && tcId && tcName) {
            existing.id = tcId;
            existing.name = tcName;
            existing.started = true;
            events.push({
              type: 'tool_call_start',
              index: this.currentContentIndex,
              id: tcId,
              name: tcName,
            });
            this.lastActiveToolIndex = this.currentContentIndex;
          }

          if (tcArgs) {
            existing.argumentsAccumulator += tcArgs;
            events.push({
              type: 'tool_call_delta',
              index: this.lastActiveToolIndex >= 0 ? this.lastActiveToolIndex : this.currentContentIndex,
              arguments: tcArgs,
            });
          }
        }
      }
    }

    // Finish reason
    if (finishReason) {
      events.push(...this.handleFinishReason(finishReason, chunk));
    }

    return events;
  }

  private handleFinishReason(finishReason: string, chunk: Record<string, unknown>): CanonicalStreamEvent[] {
    const events: CanonicalStreamEvent[] = [];

    // Close text block
    if (this.hasActiveTextBlock) {
      events.push({ type: 'content_stop', index: this.currentContentIndex });
      this.currentContentIndex++;
      this.hasActiveTextBlock = false;
    }

    // Close all active tool call blocks
    for (const [blockIndex, tc] of this.activeToolCalls.entries()) {
      if (tc.started) {
        events.push({
          type: 'tool_call_stop',
          index: blockIndex,
          arguments: tc.argumentsAccumulator,
        });
        this.currentContentIndex++;
      }
    }
    this.activeToolCalls.clear();

    // Usage from finish chunk if present
    const usageRaw = chunk['usage'] as Record<string, unknown> | undefined;
    const usage = usageRaw ? parseOpenAIUsage(usageRaw) : undefined;

    events.push({
      type: 'message_stop',
      stopReason: mapFinishReason(finishReason),
      ...(usage ? { usage } : {}),
    });

    return events;
  }

  flush(): CanonicalStreamEvent[] {
    return [];
  }
}

// ==========================================
// Stream serializer (not needed for OpenAI target codec)
// ==========================================

class OpenAIStreamSerializer implements StreamSerializer {
  serialize(event: CanonicalStreamEvent): string[] {
    // ARCHITECTURE: OpenAIStreamSerializer would be used in reverse proxy mode.
    // In the primary flow, AnthropicCodec.createStreamSerializer() is used.
    const data = JSON.stringify(event);
    return [`data: ${data}`, ``];
  }
}

// ==========================================
// Codec
// ==========================================

export class OpenAICodec implements FormatCodec {
  readonly name = 'openai';

  parseRequest(_raw: unknown): Result<CanonicalRequest> {
    // ARCHITECTURE: Used in reverse proxy mode only.
    return err(new Error('OpenAICodec.parseRequest not implemented for target codec'));
  }

  serializeRequest(canonical: CanonicalRequest): Result<unknown> {
    const messages = buildOpenAIMessages(canonical);

    const body: Record<string, unknown> = {
      model: canonical.model,
      messages,
      max_tokens: canonical.maxTokens,
      stream: canonical.stream,
    };

    if (canonical.stream) {
      body['stream_options'] = { include_usage: true };
    }

    if (canonical.temperature !== undefined) {
      body['temperature'] = canonical.temperature;
    }

    if (canonical.topP !== undefined) {
      body['top_p'] = canonical.topP;
    }
    // topK is silently dropped (not supported by OpenAI)

    if (canonical.stopSequences) {
      body['stop'] = canonical.stopSequences;
    }

    if (canonical.metadata?.userId) {
      const userId = canonical.metadata.userId;
      body['user'] = userId.length > 64 ? userId.substring(0, 64) : userId;
    }

    if (canonical.thinking) {
      body['reasoning_effort'] = thinkingToReasoningEffort(canonical.thinking.budgetTokens);
    }

    if (canonical.tools && canonical.tools.length > 0) {
      body['tools'] = canonical.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
          parameters: t.inputSchema,
        },
      }));
    }

    if (canonical.toolChoice) {
      const tc = canonical.toolChoice;
      if (tc.type === 'auto') {
        body['tool_choice'] = 'auto';
      } else if (tc.type === 'required') {
        body['tool_choice'] = 'required';
      } else if (tc.type === 'none') {
        body['tool_choice'] = 'none';
      } else if (tc.type === 'specific' && tc.name) {
        body['tool_choice'] = { type: 'function', function: { name: tc.name } };
      }
    }

    return ok(body);
  }

  parseResponse(raw: unknown): Result<CanonicalResponse> {
    if (!raw || typeof raw !== 'object') {
      return err(new Error('Response must be an object'));
    }

    const r = raw as Record<string, unknown>;

    const choices = r['choices'] as Array<Record<string, unknown>> | undefined;
    if (!choices || !Array.isArray(choices) || choices.length === 0) {
      return err(new Error('Response must have choices array'));
    }

    const choice = choices[0];
    const message = choice['message'] as Record<string, unknown>;
    const finishReason = choice['finish_reason'] as string | null;

    const content: CanonicalContent[] = [];

    // Reasoning content → thinking block (comes first)
    const reasoningContent = message['reasoning_content'] as string | undefined;
    if (reasoningContent) {
      content.push({ type: 'thinking', thinking: reasoningContent });
    }

    // Refusal
    const refusal = message['refusal'] as string | undefined;
    if (refusal) {
      content.push({ type: 'refusal', refusal });
    }

    // Text content
    const textContent = message['content'] as string | null | undefined;
    if (textContent !== null && textContent !== undefined) {
      content.push({ type: 'text', text: textContent });
    }

    // Tool calls → tool_use blocks
    const toolCalls = message['tool_calls'] as Array<Record<string, unknown>> | undefined;
    if (toolCalls) {
      for (const tc of toolCalls) {
        const func = tc['function'] as Record<string, unknown>;
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(func['arguments'] as string) as Record<string, unknown>;
        } catch {
          // Malformed JSON → empty input
          input = {};
        }
        content.push({
          type: 'tool_use',
          id: tc['id'] as string,
          name: func['name'] as string,
          input,
        });
      }
    }

    const usageRaw = r['usage'] as Record<string, unknown> | undefined;
    const usage: CanonicalUsage = usageRaw ? parseOpenAIUsage(usageRaw) : { inputTokens: 0, outputTokens: 0 };

    return ok({
      id: r['id'] as string,
      model: r['model'] as string,
      content,
      stopReason: mapFinishReason(finishReason),
      usage,
    });
  }

  serializeResponse(_canonical: CanonicalResponse): Result<unknown> {
    // ARCHITECTURE: Used in reverse proxy mode only.
    return err(new Error('OpenAICodec.serializeResponse not implemented for target codec'));
  }

  createStreamParser(): StreamParser {
    return new OpenAIStreamParser();
  }

  createStreamSerializer(): StreamSerializer {
    return new OpenAIStreamSerializer();
  }
}
