/**
 * CLI command: beat orchestrate --interactive
 * ARCHITECTURE: Extracted from orchestrate.ts for separation of concerns.
 * Interactive mode has distinct lifecycle (tmux session + attach, no loop, SIGINT coordination).
 *
 * Phase 5: Migrated from child_process spawnInteractive() to tmux sessions.
 * Flow: buildTmuxCommand() → tmuxConnector.spawn() → tmuxConnector.sendKeys()
 *   → tmux attach-session (stdio: 'inherit') → session liveness check → finalize
 */

import { spawn as nodeSpawn, spawnSync } from 'child_process';
import type { AgentProvider } from '../../core/agents.js';
import type { Container } from '../../core/container.js';
import type { OrchestrationService } from '../../core/interfaces.js';
import { err, ok, type Result } from '../../core/result.js';
import type { TmuxConnectorPort } from '../../core/tmux-types.js';
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
// tmux validation — fail-fast before session creation
// ============================================================================

/**
 * Validate tmux is installed and meets the minimum version requirement.
 * CLI mode skips the eager bootstrap validator, so we validate here before
 * attempting to spawn an interactive session.
 *
 * DECISION: Validate at the call site in CLI mode rather than at bootstrap
 * because `beat orchestrate -i` is the only CLI path that spawns tmux sessions.
 * Other CLI commands (list, status, cancel) do not need tmux.
 */
function validateTmux(): Result<void, string> {
  const result = spawnSync('tmux', ['-V'], { encoding: 'utf8', timeout: 5_000 });
  if (result.status !== 0 || result.error) {
    return err(
      'tmux is not installed or not found in PATH.\n' +
        '  Interactive mode requires tmux >= 3.0.\n' +
        '  Install: brew install tmux (macOS) or apt-get install tmux (Linux)',
    );
  }

  const raw = result.stdout?.trim() ?? '';
  const match = /(\d+)\.(\d+)/.exec(raw);
  if (!match) {
    return err(`Could not parse tmux version from: "${raw}". tmux >= 3.0 is required.`);
  }

  const major = parseInt(match[1], 10);
  if (major < 3) {
    return err(
      `tmux version ${raw} is too old. tmux >= 3.0 is required.\n` +
        '  Upgrade: brew upgrade tmux (macOS) or apt-get upgrade tmux (Linux)',
    );
  }

  return ok(undefined);
}

// ============================================================================
// Interactive mode handler (blocking via tmux attach-session)
// ============================================================================

export async function handleOrchestrateInteractive(parsed: OrchestrateInteractiveParsed): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    ui.error('Interactive mode requires a terminal. Use `beat orchestrate "<goal>"` for headless execution.');
    process.exit(1);
  }

  // Validate tmux before any setup work — fail-fast with clear error message.
  // CLI mode skips the eager bootstrap validator, so we do it here.
  const tmuxValidation = validateTmux();
  if (!tmuxValidation.ok) {
    ui.error(tmuxValidation.error);
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

    // Resolve tmuxConnector and sessionsDir from container.
    // Both are always registered by bootstrap (even in CLI mode).
    const tmuxConnectorResult = container.get<TmuxConnectorPort>('tmuxConnector');
    if (!tmuxConnectorResult.ok) {
      ui.error(`Failed to get tmux connector: ${tmuxConnectorResult.error.message}`);
      await container.dispose();
      process.exit(1);
    }
    const tmuxConnector = tmuxConnectorResult.value;

    const sessionsDirResult = container.get<string>('sessionsDir');
    if (!sessionsDirResult.ok) {
      ui.error(`Failed to get sessions directory: ${sessionsDirResult.error.message}`);
      await container.dispose();
      process.exit(1);
    }
    const sessionsDir = sessionsDirResult.value;

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
      await orchestrationService.finalizeInteractiveOrchestration(orchestration.id, {
        exitCode: null,
        cancelled: false,
      });
      await container.dispose();
      process.exit(1);
    }

    const adapter = adapterResult.value;

    // Build tmux session config from the adapter (pure config assembly, no side effects).
    const tmuxCommandResult = adapter.buildTmuxCommand({
      prompt: userPrompt,
      workingDirectory: orchestration.workingDirectory,
      taskId: orchestration.id,
      model: orchestration.model,
      orchestratorId: orchestration.id,
      systemPrompt,
      sessionsDir,
    });
    if (!tmuxCommandResult.ok) {
      ui.error(`Failed to build tmux session config: ${tmuxCommandResult.error.message}`);
      await orchestrationService.finalizeInteractiveOrchestration(orchestration.id, {
        exitCode: null,
        cancelled: false,
      });
      await container.dispose();
      process.exit(1);
    }

    const { config: tmuxConfig, prompt: tmuxPrompt } = tmuxCommandResult.value;

    // Track whether the agent process has exited (set by onExit callback).
    let agentExitCode: number | null = null;
    let agentExited = false;

    // Spawn the tmux session (creates the tmux window + wrapper, does NOT attach).
    // Callbacks receive output and exit signals from the wrapper.
    const spawnResult = tmuxConnector.spawn(tmuxConfig, {
      onOutput: (_msg) => {
        // Output captured by wrapper; not displayed in interactive mode (user sees it directly).
      },
      onExit: (code) => {
        agentExitCode = code;
        agentExited = true;
      },
    });
    if (!spawnResult.ok) {
      ui.error(`Failed to spawn tmux session: ${spawnResult.error.message}`);
      await orchestrationService.finalizeInteractiveOrchestration(orchestration.id, {
        exitCode: null,
        cancelled: false,
      });
      await container.dispose();
      process.exit(1);
    }

    const handle = spawnResult.value;

    // Deliver the initial prompt via send-keys (the wrapper is now alive and ready).
    const sendKeysResult = tmuxConnector.sendKeys(handle, tmuxPrompt);
    if (!sendKeysResult.ok) {
      ui.error(`Failed to deliver prompt to tmux session: ${sendKeysResult.error.message}`);
      tmuxConnector.destroy(handle);
      await orchestrationService.finalizeInteractiveOrchestration(orchestration.id, {
        exitCode: null,
        cancelled: false,
      });
      await container.dispose();
      process.exit(1);
    }

    // Store session name for remote cancel support.
    // Returns ok(false) if already cancelled — destroy the session and exit cleanly.
    const sessionNameResult = await orchestrationService.updateInteractiveOrchestrationSessionName(
      orchestration.id,
      handle.sessionName,
    );
    if (!sessionNameResult.ok) {
      ui.info(`Warning: failed to store session name for remote cancel: ${sessionNameResult.error.message}`);
    } else if (!sessionNameResult.value) {
      ui.info('Orchestration was cancelled during startup — terminating tmux session.');
      tmuxConnector.destroy(handle);
      adapter.cleanup(orchestration.id);
      await container.dispose();
      process.exit(0);
    }

    let cancelled = false;
    let sigintCount = 0;

    const originalSigintHandlers = process.listeners('SIGINT');
    process.removeAllListeners('SIGINT');
    process.on('SIGINT', () => {
      sigintCount++;
      cancelled = true;
      if (sigintCount >= 2) {
        // Second Ctrl+C: force-destroy the tmux session.
        tmuxConnector.destroy(handle);
      } else {
        // First Ctrl+C: send C-c to the session to interrupt the agent gracefully.
        tmuxConnector.sendControlKeys(handle, 'C-c');
      }
    });

    ui.info(`\nLaunching interactive session: ${handle.sessionName}`);
    ui.info('Use Ctrl+B D to detach and leave the session running in the background.\n');

    // Attach to the tmux session (blocks until user detaches or session ends).
    // stdio: 'inherit' gives the user full terminal control inside tmux.
    const attachProcess = nodeSpawn('tmux', ['attach-session', '-t', handle.sessionName], {
      stdio: 'inherit',
    });

    const attachExitCode = await new Promise<number | null>((resolve) => {
      attachProcess.on('exit', (code) => resolve(code));
    });

    process.removeAllListeners('SIGINT');
    for (const handler of originalSigintHandlers) {
      process.on('SIGINT', handler as NodeJS.SignalsListener);
    }

    // Determine whether the session ended or the user detached.
    // attach-session exits with code 0 on both detach and session termination.
    // Check liveness to distinguish the two cases.
    const aliveResult = tmuxConnector.isAlive(handle);
    const sessionStillAlive = aliveResult.ok && aliveResult.value;

    if (sessionStillAlive) {
      // User detached (Ctrl+B D). The orchestration is still running in the background.
      ui.info('\nDetached from session. Orchestration continues running in the background.');
      ui.info(`To reattach: tmux attach-session -t ${handle.sessionName}`);
      ui.info(`To cancel:   beat orchestrate cancel ${orchestration.id}`);
      adapter.cleanup(orchestration.id);
      await container.dispose();
      process.exit(0);
    }

    // Session ended (agent exited or was killed).
    // Wait briefly for the onExit callback to fire if it hasn't yet.
    if (!agentExited) {
      await new Promise<void>((resolve) => {
        let poll: NodeJS.Timeout;
        const deadline = setTimeout(() => {
          clearInterval(poll);
          resolve();
        }, 2000);
        poll = setInterval(() => {
          if (agentExited) {
            clearInterval(poll);
            clearTimeout(deadline);
            resolve();
          }
        }, 50);
      });
    }

    const finalizeResult = await orchestrationService.finalizeInteractiveOrchestration(orchestration.id, {
      exitCode: agentExited ? agentExitCode : attachExitCode,
      cancelled,
    });
    if (!finalizeResult.ok) {
      ui.info(`Warning: failed to finalize orchestration: ${finalizeResult.error.message}`);
    }

    if (cancelled) {
      ui.info('\nOrchestration cancelled.');
    } else if (agentExitCode === 0 || (agentExitCode === null && attachExitCode === 0)) {
      ui.success('\nOrchestration completed.');
    } else {
      ui.error(`\nOrchestration failed (exit code: ${agentExitCode ?? attachExitCode}).`);
    }

    adapter.cleanup(orchestration.id);

    await container.dispose();
    process.exit(agentExitCode ?? attachExitCode ?? 1);
  } catch (error) {
    s.stop('Failed');
    ui.error(errorMessage(error));
    if (container) await container.dispose();
    process.exit(1);
  }
}
