/**
 * Canonical Intermediate Representation (IR) for API translation.
 *
 * ARCHITECTURE: This is the lingua franca between source (Anthropic Messages API)
 * and target (OpenAI Chat Completions API) codecs. All translation goes through
 * these types — codecs parse/serialize to/from IR, never directly to each other.
 *
 * Rationale: Clean separation ensures each codec is independently testable,
 * and adding new codecs (Gemini, etc.) only requires implementing the interface.
 */

// ==========================================
// Content types
// ==========================================

export type TextContent = {
  readonly type: 'text';
  readonly text: string;
  readonly cacheControl?: { readonly type: string };
};

export type ImageContent = {
  readonly type: 'image';
  readonly source: {
    readonly type: 'base64' | 'url';
    readonly mediaType: string;
    readonly data: string;
  };
};

export type ToolUseContent = {
  readonly type: 'tool_use';
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
};

export type ToolResultContent = {
  readonly type: 'tool_result';
  readonly toolUseId: string;
  readonly content: CanonicalContent[];
  readonly isError?: boolean;
};

export type ThinkingContent = {
  readonly type: 'thinking';
  readonly thinking: string;
  readonly signature?: string;
};

export type RedactedThinkingContent = {
  readonly type: 'redacted_thinking';
};

export type DocumentContent = {
  readonly type: 'document';
  readonly source: {
    readonly type: 'base64' | 'url';
    readonly mediaType: string;
    readonly data: string;
  };
};

export type JsonContent = {
  readonly type: 'json';
  readonly data: unknown;
};

export type RefusalContent = {
  readonly type: 'refusal';
  readonly refusal: string;
};

/**
 * Discriminated union of all canonical content types.
 */
export type CanonicalContent =
  | TextContent
  | ImageContent
  | ToolUseContent
  | ToolResultContent
  | ThinkingContent
  | RedactedThinkingContent
  | DocumentContent
  | JsonContent
  | RefusalContent;

// ==========================================
// Messages and system
// ==========================================

export interface CanonicalMessage {
  readonly role: 'user' | 'assistant';
  readonly content: CanonicalContent[];
}

export interface CanonicalSystemBlock {
  readonly type: 'text';
  readonly text: string;
  readonly cacheControl?: { readonly type: string };
}

// ==========================================
// Tools
// ==========================================

export interface CanonicalToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface CanonicalToolChoice {
  readonly type: 'auto' | 'required' | 'none' | 'specific';
  readonly name?: string;
  readonly disableParallelToolUse?: boolean;
}

// ==========================================
// Stop reason and usage
// ==========================================

export type CanonicalStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'content_filter' | null;

export interface CanonicalUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly reasoningTokens?: number;
}

// ==========================================
// Request and Response
// ==========================================

export interface CanonicalRequest {
  readonly model: string;
  readonly messages: readonly CanonicalMessage[];
  readonly system?: readonly CanonicalSystemBlock[];
  readonly maxTokens: number;
  readonly tools?: readonly CanonicalToolDefinition[];
  readonly toolChoice?: CanonicalToolChoice;
  readonly stopSequences?: readonly string[];
  readonly temperature?: number;
  readonly topP?: number;
  readonly topK?: number;
  readonly stream: boolean;
  readonly thinking?: { readonly budgetTokens: number };
  readonly metadata?: { readonly userId?: string };
}

export interface CanonicalResponse {
  readonly id: string;
  readonly model: string;
  readonly content: readonly CanonicalContent[];
  readonly stopReason: CanonicalStopReason;
  readonly usage: CanonicalUsage;
}

// ==========================================
// Stream events
// ==========================================

export type MessageStartEvent = {
  readonly type: 'message_start';
  readonly id: string;
  readonly model: string;
};

export type MessageStopEvent = {
  readonly type: 'message_stop';
  readonly stopReason: CanonicalStopReason;
  readonly usage?: CanonicalUsage;
};

export type ContentStartEvent = {
  readonly type: 'content_start';
  readonly index: number;
  readonly contentType: 'text';
};

export type ContentDeltaEvent = {
  readonly type: 'content_delta';
  readonly index: number;
  readonly text: string;
};

export type ContentStopEvent = {
  readonly type: 'content_stop';
  readonly index: number;
};

export type ToolCallStartEvent = {
  readonly type: 'tool_call_start';
  readonly index: number;
  readonly id: string;
  readonly name: string;
};

export type ToolCallDeltaEvent = {
  readonly type: 'tool_call_delta';
  readonly index: number;
  readonly arguments: string;
};

export type ToolCallStopEvent = {
  readonly type: 'tool_call_stop';
  readonly index: number;
  readonly arguments: string;
};

export type ThinkingDeltaEvent = {
  readonly type: 'thinking_delta';
  readonly thinking: string;
};

export type UsageEvent = {
  readonly type: 'usage';
  readonly usage: CanonicalUsage;
};

/**
 * Discriminated union of all canonical stream events.
 */
export type CanonicalStreamEvent =
  | MessageStartEvent
  | MessageStopEvent
  | ContentStartEvent
  | ContentDeltaEvent
  | ContentStopEvent
  | ToolCallStartEvent
  | ToolCallDeltaEvent
  | ToolCallStopEvent
  | ThinkingDeltaEvent
  | UsageEvent;
