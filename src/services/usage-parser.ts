/**
 * Claude JSON output parser for token/cost usage extraction.
 *
 * ARCHITECTURE: Best-effort parser — never throws, returns ok(null) on any
 * missing or unparseable data. Cost capture must not affect task outcome.
 * Pattern: Functional core with explicit Result types.
 * Rationale: The Stop hook captures Claude's output per turn and writes JSON
 * message files containing {"type":"result", ..., "usage": {...}, "total_cost_usd": ...}.
 */

import { TaskId, TaskOutput, TaskUsage } from '../core/domain.js';
import { ok, Result } from '../core/result.js';

/**
 * Maximum plausible cost per task (USD). Rejects corrupt/test data.
 * $1000 is an extreme upper bound — typical Claude runs cost <$1.
 */
const MAX_COST_USD = 1000;

/**
 * Parse Claude JSON output to extract token/cost usage.
 *
 * Strategy:
 * 1. Concatenate all stdout chunks.
 * 2. Search backwards for the last `{"type":"result"` marker.
 * 3. Try JSON.parse on the suffix from that marker.
 * 4. Validate required fields with bounds checks.
 * 5. Return ok(null) on ANY failure — never throw, never block.
 *
 * @param output - TaskOutput with all stdout chunks (inline or file-merged)
 * @param model - Optional model identifier from task metadata
 */
export function parseClaudeUsage(output: TaskOutput, model: string | undefined): Result<TaskUsage | null> {
  // ARCHITECTURE: Never throw — wrap entire body in try/catch as safety net
  try {
    return ok(extractUsage(output, model));
  } catch {
    // Should never reach here given internal guards, but defensive fallback
    return ok(null);
  }
}

function extractUsage(output: TaskOutput, model: string | undefined): TaskUsage | null {
  if (!output || output.stdout.length === 0) {
    return null;
  }

  // Concatenate all stdout chunks into a single string
  const combined = output.stdout.join('');
  if (combined.length === 0) {
    return null;
  }

  // Search backwards for the last {"type":"result" marker
  const marker = '{"type":"result"';
  const markerIndex = combined.lastIndexOf(marker);
  if (markerIndex === -1) {
    return null;
  }

  // Extract and parse the JSON suffix from the marker
  const suffix = combined.slice(markerIndex);
  let parsed: unknown;
  try {
    parsed = JSON.parse(suffix);
  } catch {
    // JSON.parse failed — truncated or malformed output
    return null;
  }

  // Validate structure
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const obj = parsed as Record<string, unknown>;

  // Must be type "result"
  if (obj.type !== 'result') {
    return null;
  }

  // Extract usage object
  const usageObj = obj.usage;
  if (!usageObj || typeof usageObj !== 'object') {
    return null;
  }

  const usage = usageObj as Record<string, unknown>;

  // Extract numeric fields with validation
  const inputTokens = toNonNegativeInt(usage.input_tokens);
  const outputTokens = toNonNegativeInt(usage.output_tokens);
  const cacheCreationInputTokens = toNonNegativeInt(usage.cache_creation_input_tokens) ?? 0;
  const cacheReadInputTokens = toNonNegativeInt(usage.cache_read_input_tokens) ?? 0;

  if (inputTokens === null || outputTokens === null) {
    return null;
  }

  // Extract cost — required field
  const totalCostUsd = toFiniteNumber(obj.total_cost_usd);
  if (totalCostUsd === null) {
    return null;
  }

  // Bounds checks: reject implausible values
  if (totalCostUsd < 0 || totalCostUsd > MAX_COST_USD) {
    return null;
  }

  // Extract model from result JSON, fall back to task model parameter
  const resultModel = typeof obj.model === 'string' ? obj.model : model;

  // Synthesize a placeholder task ID — caller replaces with real task ID
  // ARCHITECTURE: TaskId is set by UsageCaptureHandler from event context,
  // not here (parser doesn't know the task ID).
  return {
    taskId: TaskId(''),
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    totalCostUsd,
    model: resultModel,
    capturedAt: Date.now(),
  };
}

// ============================================================================
// Private helpers — numeric field coercion with validation
// ============================================================================

function toNonNegativeInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const int = Math.floor(value);
  return int >= 0 ? int : null;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}
