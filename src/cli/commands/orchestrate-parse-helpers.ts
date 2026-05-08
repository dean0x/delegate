/**
 * Shared arg-parsing helpers for `beat orchestrate` subcommands.
 * Extracted to avoid a circular dependency between orchestrate.ts and orchestrate-interactive.ts.
 */

import type { AgentProvider } from '../../core/agents.js';
import { AGENT_PROVIDERS, isAgentProvider } from '../../core/agents.js';
import { err, ok, type Result } from '../../core/result.js';

/** Shared mutable state accumulated by parseCommonOrchestrateFlag. */
export interface CommonOrchestrateFlags {
  workingDirectory: string | undefined;
  agent: AgentProvider | undefined;
  model: string | undefined;
  maxDepth: number | undefined;
  maxWorkers: number | undefined;
  goalWords: string[];
}

/** Parse and validate an integer flag value within [min, max]. */
export function parseIntFlag(name: string, value: string, min: number, max: number): Result<number, string> {
  const val = parseInt(value, 10);
  if (isNaN(val) || val < min || val > max) return err(`${name} must be ${min}-${max}`);
  return ok(val);
}

/**
 * Parse a single arg from the common flag set shared between `create`, `init`, and `interactive`.
 * Returns the new index (incremented when the flag consumed a following value),
 * or an Err if the flag is invalid. Returns `null` when the arg is not a common
 * flag — the caller should then handle it as a subcommand-specific flag or error.
 *
 * DECISION: Single-arg dispatch rather than a full loop keeps each caller in
 * control of its own iteration and unique flags (--foreground, --system-prompt, etc.).
 */
export function parseCommonOrchestrateFlag(
  arg: string,
  args: readonly string[],
  i: number,
  state: CommonOrchestrateFlags,
): Result<number, string> | null {
  if (arg === '--working-directory' || arg === '-w') {
    const next = args[i + 1];
    if (!next || next.startsWith('-')) return err('--working-directory requires a path');
    state.workingDirectory = next;
    return ok(i + 1);
  }
  if (arg === '--agent' || arg === '-a') {
    const next = args[i + 1];
    if (!next || next.startsWith('-')) return err(`--agent requires a name (${AGENT_PROVIDERS.join(', ')})`);
    if (!isAgentProvider(next)) return err(`Unknown agent: "${next}". Available: ${AGENT_PROVIDERS.join(', ')}`);
    state.agent = next;
    return ok(i + 1);
  }
  if (arg === '--model' || arg === '-m') {
    const next = args[i + 1];
    if (!next || next.startsWith('-')) return err('--model requires a model name (e.g. claude-opus-4-5)');
    state.model = next;
    return ok(i + 1);
  }
  if (arg === '--max-depth') {
    const parsed = parseIntFlag('--max-depth', args[i + 1], 1, 10);
    if (!parsed.ok) return parsed;
    state.maxDepth = parsed.value;
    return ok(i + 1);
  }
  if (arg === '--max-workers') {
    const parsed = parseIntFlag('--max-workers', args[i + 1], 1, 20);
    if (!parsed.ok) return parsed;
    state.maxWorkers = parsed.value;
    return ok(i + 1);
  }
  if (!arg.startsWith('-')) {
    state.goalWords.push(arg);
    return ok(i);
  }
  return null; // not a common flag — caller decides
}
