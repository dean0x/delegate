/**
 * Prompt cache middleware (metrics-only).
 *
 * ARCHITECTURE: This middleware tracks stable prompt prefixes to estimate
 * cache hits. It does NOT skip API calls — it only annotates usage metadata
 * when a stable prefix is detected (indicating the target provider likely
 * served from cache).
 *
 * DECISION: Metrics-only approach avoids false positives from actual cache
 * misses on the target side. We measure, but the actual cache behavior is
 * determined by the target API.
 *
 * How it works:
 * 1. Hash system + first N messages (the "prefix")
 * 2. If the prefix matches the previous request's hash, annotate response
 *    usage with estimated cacheReadInputTokens
 * 3. Estimate: chars / 4 ≈ tokens (rough Claude tokenization)
 */
import { createHash } from 'node:crypto';
import type { CanonicalRequest, CanonicalResponse } from '../ir.js';
import type { TranslationMiddleware } from './middleware.js';

const PREFIX_MESSAGES_TO_HASH = 3;
const CHARS_PER_TOKEN = 4;

function hashPrefix(request: CanonicalRequest): string {
  const parts: string[] = [];

  // DECISION: Only hash system blocks as the "stable prefix."
  // Messages change every request; system prompts are the stable prefix
  // that providers typically cache. Hashing messages would cause every
  // request to be a "miss" even when the system prompt is identical.
  if (request.system) {
    for (const block of request.system) {
      parts.push(block.text);
    }
  }

  // If no system prompt, hash the first few messages as a fallback prefix
  if (!request.system || request.system.length === 0) {
    const messagesToHash = request.messages.slice(0, PREFIX_MESSAGES_TO_HASH);
    for (const msg of messagesToHash) {
      parts.push(msg.role);
      for (const block of msg.content) {
        if (block.type === 'text') {
          parts.push(block.text);
        }
      }
    }
  }

  return createHash('sha256').update(parts.join('|')).digest('hex');
}

function estimatePrefixTokens(request: CanonicalRequest): number {
  let chars = 0;

  if (request.system) {
    for (const block of request.system) {
      chars += block.text.length;
    }
  }

  const messagesToCount = request.messages.slice(0, PREFIX_MESSAGES_TO_HASH);
  for (const msg of messagesToCount) {
    for (const block of msg.content) {
      if (block.type === 'text') {
        chars += block.text.length;
      }
    }
  }

  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export class PromptCacheMiddleware implements TranslationMiddleware {
  readonly name = 'prompt-cache';

  private lastPrefixHash: string | null = null;
  private currentPrefixHash: string | null = null;
  private currentPrefixTokens = 0;

  processRequest(request: CanonicalRequest): CanonicalRequest {
    const hash = hashPrefix(request);
    this.currentPrefixHash = hash;
    this.currentPrefixTokens = estimatePrefixTokens(request);
    return request;
  }

  processResponse(response: CanonicalResponse): CanonicalResponse {
    const isStablePrefix =
      this.currentPrefixHash !== null && this.lastPrefixHash !== null && this.currentPrefixHash === this.lastPrefixHash;

    // Update last hash for next request
    this.lastPrefixHash = this.currentPrefixHash;

    // If backend already reported cache tokens, don't double-count
    if (response.usage.cacheReadInputTokens) {
      return response;
    }

    if (isStablePrefix && this.currentPrefixTokens > 0) {
      return {
        ...response,
        usage: {
          ...response.usage,
          cacheReadInputTokens: this.currentPrefixTokens,
        },
      };
    }

    return response;
  }
}
