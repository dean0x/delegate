/**
 * CLI command: beat orchestrate --interactive
 * ARCHITECTURE: Extracted from orchestrate.ts for separation of concerns.
 * Interactive mode has distinct lifecycle (stdio:'inherit', no loop, SIGINT coordination).
 */

import type { AgentProvider } from '../../core/agents.js';
import type { Container } from '../../core/container.js';
import type { OrchestrationService } from '../../core/interfaces.js';
import { err, ok, type Result } from '../../core/result.js';
import { errorMessage, withServices } from '../services.js';
import * as ui from '../ui.js';
import { type CommonOrchestrateFlags, parseCommonOrchestrateFlag, parseIntFlag } from './orchestrate-parse-helpers.js';

// ============================================================================
// Types
// ============================================================================

export interface OrchestrateInteractiveParsed {
  readonly kind: 'interactive';
  readonly goal: string;
  readonly workingDirectory?: string;
  readonly agent?: AgentProvider;
  readonly model?: string;
  readonly maxDepth?: number;
  readonly maxWorkers?: number;
  readonly systemPrompt?: string;
}

// ============================================================================
// Arg parsing
// ============================================================================

export function parseOrchestrateInteractiveArgs(args: readonly string[]): Result<OrchestrateInteractiveParsed, string> {
  const state: CommonOrchestrateFlags = {
    workingDirectory: undefined,
    agent: undefined,
    model: undefined,
    maxDepth: undefined,
    maxWorkers: undefined,
    goalWords: [],
  };
  let systemPrompt: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--foreground' || arg === '-f') {
      return err('--foreground is mutually exclusive with --interactive');
    }
    if (arg === '--max-iterations') {
      return err('--max-iterations is irrelevant for interactive mode (no loop)');
    }
    if (arg === '--system-prompt') {
      const next = args[i + 1];
      if (next === undefined) return err('--system-prompt requires a prompt string');
      systemPrompt = next;
      i++;
    } else {
      const commonResult = parseCommonOrchestrateFlag(arg, args, i, state);
      if (commonResult === null) return err(`Unknown flag: ${arg}`);
      if (!commonResult.ok) return commonResult;
      i = commonResult.value;
    }
  }

  const goal = state.goalWords.join(' ');
  if (!goal) return err('goal is required');

  return ok({
    kind: 'interactive',
    goal,
    workingDirectory: state.workingDirectory,
    agent: state.agent,
    model: state.model,
    maxDepth: state.maxDepth,
    maxWorkers: state.maxWorkers,
    systemPrompt,
  });
}

// ============================================================================
// Interactive mode handler (blocking, stdio: 'inherit')
// ============================================================================

export async function handleOrchestrateInteractive(parsed: OrchestrateInteractiveParsed): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    ui.error('Interactive mode requires a terminal. Use `beat orchestrate "<goal>"` for headless execution.');
    process.exit(1);
  }

  let container: Container | undefined;
  const s = ui.createSpinner();
  try {
    s.start('Setting up interactive orchestration...');
    const services = await withServices(s);
    container = services.container;
    const { orchestrationService } = services;
    s.stop('Ready');

    const agentRegistryResult = container.get<import('../../core/agents.js').AgentRegistry>('agentRegistry');
    if (!agentRegistryResult.ok) {
      ui.error(`Failed to get agent registry: ${agentRegistryResult.error.message}`);
      await container.dispose();
      process.exit(1);
    }
    const agentRegistry = agentRegistryResult.value;

    const createResult = await orchestrationService.createInteractiveOrchestration({
      goal: parsed.goal,
      workingDirectory: parsed.workingDirectory,
      agent: parsed.agent,
      model: parsed.model,
      maxDepth: parsed.maxDepth,
      maxWorkers: parsed.maxWorkers,
      systemPrompt: parsed.systemPrompt,
    });
    if (!createResult.ok) {
      ui.error(`Failed to create interactive orchestration: ${createResult.error.message}`);
      await container.dispose();
      process.exit(1);
    }

    const { orchestration, systemPrompt, userPrompt } = createResult.value;
    ui.info(`Orchestration ID: ${orchestration.id}`);
    ui.info(`State file:       ${orchestration.stateFilePath}`);

    const agent = orchestration.agent ?? 'claude';
    const adapterResult = agentRegistry.get(agent);
    if (!adapterResult.ok) {
      ui.error(`Agent adapter not available: ${adapterResult.error.message}`);
      await container.dispose();
      process.exit(1);
    }

    const adapter = adapterResult.value;

    const spawnResult = adapter.spawnInteractive({
      prompt: userPrompt,
      workingDirectory: orchestration.workingDirectory,
      taskId: orchestration.id,
      model: orchestration.model,
      orchestratorId: orchestration.id,
      systemPrompt,
    });
    if (!spawnResult.ok) {
      ui.error(`Failed to spawn interactive agent: ${spawnResult.error.message}`);
      await orchestrationService.finalizeInteractiveOrchestration(orchestration.id, {
        exitCode: null,
        cancelled: false,
      });
      await container.dispose();
      process.exit(1);
    }

    const child = spawnResult.value.process;

    const pidResult = await orchestrationService.updateInteractiveOrchestrationPid(
      orchestration.id,
      spawnResult.value.pid,
    );
    if (!pidResult.ok) {
      ui.info(`Warning: failed to store PID for remote cancel: ${pidResult.error.message}`);
    }

    let cancelled = false;
    let sigintCount = 0;
    const originalSigintHandlers = process.listeners('SIGINT');
    process.removeAllListeners('SIGINT');
    process.on('SIGINT', () => {
      sigintCount++;
      if (sigintCount >= 2) {
        process.exit(130);
      }
      cancelled = true;
    });

    ui.info('Launching interactive session...\n');

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('exit', (code: number | null) => resolve(code));
    });

    process.removeAllListeners('SIGINT');
    for (const handler of originalSigintHandlers) {
      process.on('SIGINT', handler as NodeJS.SignalsListener);
    }

    const finalizeResult = await orchestrationService.finalizeInteractiveOrchestration(orchestration.id, {
      exitCode,
      cancelled,
    });
    if (!finalizeResult.ok) {
      ui.info(`Warning: failed to finalize orchestration: ${finalizeResult.error.message}`);
    }

    if (cancelled) {
      ui.info('\nOrchestration cancelled.');
    } else if (exitCode === 0) {
      ui.success('\nOrchestration completed.');
    } else {
      ui.error(`\nOrchestration failed (exit code: ${exitCode}).`);
    }

    adapter.cleanup(orchestration.id);

    await container.dispose();
    process.exit(exitCode ?? 1);
  } catch (error) {
    s.stop('Failed');
    ui.error(errorMessage(error));
    if (container) await container.dispose();
    process.exit(1);
  }
}
