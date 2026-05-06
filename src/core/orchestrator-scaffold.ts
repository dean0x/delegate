/**
 * Custom orchestrator scaffolding
 * ARCHITECTURE: Pure function that creates state file + exit script and returns
 * reusable instruction snippets for building custom orchestrators.
 *
 * DECISION (2026-04-22): Extracted as a standalone function (not a method on a
 * service class) because it has no dependencies that need injection — it performs
 * file I/O through well-tested helpers and string generation through pure functions.
 * Follows the ConfigureAgent precedent: stateless file creation + string generation
 * does not require a service layer.
 *
 * DECISION: scaffoldCustomOrchestrator returns Result<ScaffoldResult> so callers
 * (MCP tool, CLI command) get consistent error handling without try/catch at each
 * call site. Follows the project-wide "never throw in business logic" principle.
 */

import { randomUUID } from 'crypto';
import path from 'path';
import {
  buildConstraintInstructions,
  buildDelegationInstructions,
  buildStateManagementInstructions,
} from '../services/orchestrator-prompt.js';
import { createInitialState, getStateDir, writeExitConditionScript, writeStateFile } from './orchestrator-state.js';
import { type Result, tryCatch } from './result.js';

export interface ScaffoldParams {
  readonly goal: string;
  readonly agent?: string;
  readonly model?: string;
  readonly maxWorkers?: number;
  readonly maxDepth?: number;
  readonly template?: 'standard' | 'interactive';
}

export interface ScaffoldResult {
  readonly stateFilePath: string;
  readonly exitConditionScript?: string;
  readonly suggestedExitCondition?: string;
  readonly suggestedCommand: string;
  readonly instructions: {
    readonly delegation: string;
    readonly stateManagement: string;
    readonly constraints: string;
  };
}

/**
 * Initialize scaffolding for a custom orchestrator.
 * Creates a state file and exit condition checker script on disk,
 * then returns reusable instruction snippets ready for inclusion in a
 * custom system prompt.
 *
 * DECISION: Uses timestamp + short UUID suffix for the state file name so
 * multiple concurrent orchestrations never collide. The script name is
 * derived from the state file name (handled by writeExitConditionScript).
 *
 * @returns ok(ScaffoldResult) on success, err(Error) on any I/O failure.
 */
export function scaffoldCustomOrchestrator(params: ScaffoldParams): Result<ScaffoldResult> {
  return tryCatch(() => {
    const { goal, agent, model, maxWorkers = 5, maxDepth = 3, template } = params;
    const isInteractive = template === 'interactive';

    const stateDir = getStateDir();
    const filename = `state-${Date.now()}-${randomUUID().substring(0, 8)}.json`;
    const stateFilePath = path.join(stateDir, filename);

    const state = createInitialState(goal);
    writeStateFile(stateFilePath, state);

    const delegation = buildDelegationInstructions({ agent, model });
    const stateManagement = buildStateManagementInstructions({ stateFilePath });
    const constraints = buildConstraintInstructions({ maxWorkers, maxDepth });

    if (isInteractive) {
      const agentFlag = agent ? ` --agent ${agent}` : '';
      const modelFlag = model ? ` --model ${model}` : '';
      const suggestedCommand = `beat orchestrate -i${agentFlag}${modelFlag} "<your goal>"`;

      return {
        stateFilePath,
        suggestedCommand,
        instructions: { delegation, stateManagement, constraints },
      };
    }

    const exitConditionScript = writeExitConditionScript(stateDir, stateFilePath);
    const suggestedExitCondition = `node ${JSON.stringify(exitConditionScript)}`;
    const agentFlag = agent ? ` --agent ${agent}` : '';
    const modelFlag = model ? ` --model ${model}` : '';
    const suggestedCommand = `beat loop${agentFlag}${modelFlag} "<your orchestrator prompt>" --strategy retry --until "${suggestedExitCondition}"`;

    return {
      stateFilePath,
      exitConditionScript,
      suggestedExitCondition,
      suggestedCommand,
      instructions: { delegation, stateManagement, constraints },
    };
  });
}
