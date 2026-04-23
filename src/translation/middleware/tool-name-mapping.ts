/**
 * Tool name mapping middleware.
 *
 * ARCHITECTURE: OpenAI limits tool names to 64 characters. Anthropic tool names
 * can be longer. This middleware truncates long names for outbound requests and
 * reverse-maps them back in responses/streams.
 *
 * Truncation format: `name.substring(0, 53) + '_' + SHA256(name).substring(0, 10)`
 * This guarantees uniqueness while staying under 64 chars (53 + 1 + 10 = 64).
 *
 * DECISION: Per-instance mapping (not global) so each proxy request has its own
 * name→truncated→original mapping. Avoids cross-request interference.
 */
import { createHash } from 'node:crypto';
import type { CanonicalRequest, CanonicalResponse, CanonicalStreamEvent } from '../ir.js';
import type { TranslationMiddleware } from './middleware.js';

const MAX_TOOL_NAME_LENGTH = 64;
const TRUNCATED_PREFIX_LENGTH = 53;
const SHA_SUFFIX_LENGTH = 10;

function truncateName(name: string): string {
  const hash = createHash('sha256').update(name).digest('hex');
  const prefix = name.substring(0, TRUNCATED_PREFIX_LENGTH);
  const suffix = hash.substring(0, SHA_SUFFIX_LENGTH);
  return `${prefix}_${suffix}`;
}

export class ToolNameMappingMiddleware implements TranslationMiddleware {
  readonly name = 'tool-name-mapping';

  // Maps truncated name → original name
  private readonly reverseMap = new Map<string, string>();
  // Maps original name → truncated name (for idempotent processing)
  private readonly forwardMap = new Map<string, string>();

  processRequest(request: CanonicalRequest): CanonicalRequest {
    if (!request.tools || request.tools.length === 0) {
      return request;
    }

    let anyTruncated = false;
    const mappedTools = request.tools.map((tool) => {
      if (tool.name.length <= MAX_TOOL_NAME_LENGTH) {
        return tool;
      }

      anyTruncated = true;

      // Check cache first
      if (this.forwardMap.has(tool.name)) {
        return { ...tool, name: this.forwardMap.get(tool.name)! };
      }

      const truncated = truncateName(tool.name);
      this.forwardMap.set(tool.name, truncated);
      this.reverseMap.set(truncated, tool.name);

      return { ...tool, name: truncated };
    });

    if (!anyTruncated) return request;

    return { ...request, tools: mappedTools };
  }

  processResponse(response: CanonicalResponse): CanonicalResponse {
    if (this.reverseMap.size === 0) return response;

    let anyMapped = false;
    const mappedContent = response.content.map((block) => {
      if (block.type === 'tool_use') {
        const original = this.reverseMap.get(block.name);
        if (original) {
          anyMapped = true;
          return { ...block, name: original };
        }
      }
      return block;
    });

    if (!anyMapped) return response;
    return { ...response, content: mappedContent };
  }

  processStreamEvent(event: CanonicalStreamEvent): CanonicalStreamEvent | null {
    if (this.reverseMap.size === 0) return event;

    if (event.type === 'tool_call_start') {
      const original = this.reverseMap.get(event.name);
      if (original) {
        return { ...event, name: original };
      }
    }

    return event;
  }
}
