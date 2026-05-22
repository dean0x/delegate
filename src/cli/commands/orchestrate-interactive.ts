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
import type { AgentAdapter, AgentProvider, AgentRegistry } from '../../core/agents.js';
import type { Container } from '../../core/container.js';
import type { Orchestration } from '../../core/domain.js';
import type { OrchestrationService } from '../../core/interfaces.js';
import { err, ok, type Result } from '../../core/result.js';
import type { TmuxConnectorPort, TmuxHandle, TmuxSpawnCoreConfig } from '../../core/tmux-types.js';
import { TmuxValidator } from '../../implementations/tmux/tmux-validator.js';
import { errorMessage, withServices } from '../services.js';
import * as ui from '../ui.js';
import { type CommonOrchestrateFlags, parseCommonOrchestrateFlag } from './orchestrate-parse-helpers.js';

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
 *
 * Uses TmuxValidator (canonical implementation) rather than reimplementing
 * version parsing. Also validates jq is available, which the wrapper scripts require.
 */
function validateTmux(): Result<void, string> {
  const validator = new TmuxValidator({
    exec: (cmd) => {
      const result = spawnSync(cmd, { shell: true, encoding: 'utf8', timeout: 10_000 });
      return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status ?? -1 };
    },
  });
  const result = validator.validate();
  if (!result.ok) {
    return err(result.error.message);
  }
  return ok(undefined);
}

// ============================================================================
// Container dependency resolution
// ============================================================================

interface ContainerDeps {
  readonly agentRegistry: AgentRegistry;
  readonly tmuxConnector: TmuxConnectorPort;
  readonly sessionsDir: string;
}

/**
 * Resolve the three container-registered dependencies needed by interactive mode.
 * Returns null and calls process.exit(1) on any failure (CLI pattern — no recovery).
 */
async function resolveContainerDeps(container: Container): Promise<ContainerDeps | null> {
  const agentRegistryResult = container.get<AgentRegistry>('agentRegistry');
  if (!agentRegistryResult.ok) {
    ui.error(`Failed to get agent registry: ${agentRegistryResult.error.message}`);
    await container.dispose();
    process.exit(1);
  }

  // Resolve tmuxConnector and sessionsDir from container.
  // Both are always registered by bootstrap (even in CLI mode).
  const tmuxConnectorResult = container.get<TmuxConnectorPort>('tmuxConnector');
  if (!tmuxConnectorResult.ok) {
    ui.error(`Failed to get tmux connector: ${tmuxConnectorResult.error.message}`);
    await container.dispose();
    process.exit(1);
  }

  const sessionsDirResult = container.get<string>('sessionsDir');
  if (!sessionsDirResult.ok) {
    ui.error(`Failed to get sessions directory: ${sessionsDirResult.error.message}`);
    await container.dispose();
    process.exit(1);
  }

  return {
    agentRegistry: agentRegistryResult.value,
    tmuxConnector: tmuxConnectorResult.value,
    sessionsDir: sessionsDirResult.value,
  };
}

// ============================================================================
// Tmux session spawn + prompt delivery
// ============================================================================

interface SpawnedSession {
  readonly handle: TmuxHandle;
  readonly agentState: { exitCode: number | null; exited: boolean };
  readonly exitPromise: Promise<void>;
}

/**
 * Build the tmux config (stripping AUTOBEAT_WORKER), spawn the session, and deliver
 * the initial prompt via send-keys.
 *
 * Returns null and calls process.exit(1) on any failure.
 * On failure after spawn (send-keys), destroys the session before exiting.
 */
async function spawnAndDeliverPrompt(
  tmuxConnector: TmuxConnectorPort,
  adapter: AgentAdapter,
  orchestration: Orchestration,
  orchestrationService: OrchestrationService,
  container: Container,
  params: { userPrompt: string; systemPrompt: string | undefined; sessionsDir: string },
): Promise<SpawnedSession | null> {
  // Build tmux session config from the adapter (pure config assembly, no side effects).
  const tmuxCommandResult = adapter.buildTmuxCommand({
    prompt: params.userPrompt,
    workingDirectory: orchestration.workingDirectory,
    taskId: orchestration.id,
    model: orchestration.model,
    orchestratorId: orchestration.id,
    systemPrompt: params.systemPrompt,
    sessionsDir: params.sessionsDir,
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

  const { config: rawTmuxConfig, prompt: tmuxPrompt } = tmuxCommandResult.value;

  // Strip AUTOBEAT_WORKER from the interactive session's environment.
  // buildTmuxCommand() always sets AUTOBEAT_WORKER=true (worker identity for background tasks),
  // but an interactive orchestrator is not a worker — it is the orchestrator itself.
  // Leaving it set would suppress interactive behaviors designed for orchestrators.
  //
  // TmuxSpawnCoreConfig is the minimal core-layer type; env lives on the impl-level extension.
  // We produce a new config object that overrides env, passing it through unknown since the
  // type boundary is intentionally opaque at this call site.
  const existingEnv = (rawTmuxConfig as unknown as { env?: Record<string, string> }).env;
  const tmuxConfig: TmuxSpawnCoreConfig = existingEnv
    ? ({
        ...rawTmuxConfig,
        env: Object.fromEntries(Object.entries(existingEnv).filter(([k]) => k !== 'AUTOBEAT_WORKER')),
      } as unknown as TmuxSpawnCoreConfig)
    : rawTmuxConfig;

  // Track agent exit state; shared across spawn callbacks and the attach wait below.
  const agentState = { exitCode: null as number | null, exited: false };

  // exitPromise resolves when onExit fires — eliminates setInterval polling after attach.
  let resolveExitPromise!: () => void;
  const exitPromise = new Promise<void>((resolve) => {
    resolveExitPromise = resolve;
  });

  // Spawn the tmux session (creates the tmux window + wrapper, does NOT attach).
  // Callbacks receive output and exit signals from the wrapper.
  const spawnResult = tmuxConnector.spawn(tmuxConfig, {
    onOutput: (_msg) => {
      // Output captured by wrapper; not displayed in interactive mode (user sees it directly).
    },
    onExit: (code) => {
      agentState.exitCode = code;
      agentState.exited = true;
      resolveExitPromise();
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

  return { handle, agentState, exitPromise };
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

    // Phase 1: Resolve container dependencies
    const deps = await resolveContainerDeps(container);
    if (!deps) return; // process.exit already called
    const { agentRegistry, tmuxConnector, sessionsDir } = deps;

    // Phase 2: Create orchestration record and resolve agent adapter
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

    // Phase 3: Spawn tmux session and deliver initial prompt
    const session = await spawnAndDeliverPrompt(
      tmuxConnector,
      adapter,
      orchestration,
      orchestrationService,
      container,
      { userPrompt, systemPrompt, sessionsDir },
    );
    if (!session) return; // process.exit already called
    const { handle, agentState, exitPromise } = session;

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

    // Phase 4: Attach, handle SIGINT, and finalize
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
    // Use event-driven resolution: exitPromise resolves when onExit fires;
    // race against a 2000ms deadline to avoid blocking indefinitely.
    if (!agentState.exited) {
      await Promise.race([exitPromise, new Promise<void>((resolve) => setTimeout(resolve, 2000))]);
    }

    const finalizeResult = await orchestrationService.finalizeInteractiveOrchestration(orchestration.id, {
      exitCode: agentState.exited ? agentState.exitCode : attachExitCode,
      cancelled,
    });
    if (!finalizeResult.ok) {
      ui.info(`Warning: failed to finalize orchestration: ${finalizeResult.error.message}`);
    }

    if (cancelled) {
      ui.info('\nOrchestration cancelled.');
    } else if (agentState.exitCode === 0 || (agentState.exitCode === null && attachExitCode === 0)) {
      ui.success('\nOrchestration completed.');
    } else {
      ui.error(`\nOrchestration failed (exit code: ${agentState.exitCode ?? attachExitCode}).`);
    }

    adapter.cleanup(orchestration.id);

    await container.dispose();
    process.exit(agentState.exitCode ?? attachExitCode ?? 1);
  } catch (error) {
    s.stop('Failed');
    ui.error(errorMessage(error));
    if (container) await container.dispose();
    process.exit(1);
  }
}
