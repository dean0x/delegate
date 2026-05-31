/**
 * TmuxHooks — setup shim generation and session directory lifecycle
 *
 * DESIGN DECISION: All agent sessions run in interactive (REPL) mode via a
 * setup shim. Each agent invocation gets an isolated session directory under
 * sessionsDir/{taskId}/. The shim initialises the directory and execs the
 * agent interactively — output capture is handled by the agent's Stop hook,
 * which writes message JSON files and per-iteration sentinel files.
 *
 * SECURITY: All paths and command values embedded in the generated script are
 * validated or single-quoted to prevent word splitting and glob expansion.
 * agentCommand is validated against SAFE_PATH_REGEX (reject-bad-input) before
 * embedding. agentArgs are individually single-quote-escaped so arguments
 * containing spaces or special characters are passed verbatim to the agent
 * without shell interpretation.
 */

import * as path from 'path';
import type { TaskId } from '../../core/domain.js';
import type { AutobeatError } from '../../core/errors.js';
import { tmuxHookFailed } from '../../core/errors.js';
import type { Result } from '../../core/result.js';
import { err, ok } from '../../core/result.js';
import { singleQuoteToken } from './tmux-shell-utils.js';
import type { SetupShimConfig, SetupShimManifest, TmuxHooksPort } from './types.js';
import { SAFE_PATH_REGEX, TASK_ID_REGEX } from './types.js';

/** Octal permission bits for session directories and scripts (owner read/write/execute only) */
const FILE_MODE = 0o700;

export interface TmuxHooksDeps {
  writeFile: (filePath: string, content: string, opts: { mode: number }) => void;
  mkdirSync: (dirPath: string, opts: { recursive: boolean; mode: number }) => void;
  rmSync: (dirPath: string, opts: { recursive: boolean; force: boolean }) => void;
}

/**
 * Generates the setup shim script for a persistent interactive session.
 *
 * The shim initialises the messages directory and sequence counter, then
 * exec-replaces itself with the agent running in interactive REPL mode
 * (no --print). Output capture is handled by the agent's Stop hook, which
 * writes message JSON files and per-iteration sentinel files.
 *
 * SECURITY: All paths and command values are single-quoted. agentCommand
 * is validated against SAFE_PATH_REGEX before embedding.
 */
function buildSetupShim(config: SetupShimConfig): string {
  // Defense-in-depth: validate agentCommand even though generateSetupShim() validates
  // before calling this function. Guards against future callers bypassing the outer check.
  if (!SAFE_PATH_REGEX.test(config.agentCommand)) {
    throw new Error(`unsafe agentCommand in buildSetupShim: ${config.agentCommand}`);
  }

  const sessionDir = path.join(config.sessionsDir, config.taskId);
  const agentArgs = config.agentArgs.map(singleQuoteToken).join(' ');
  const sessionDirToken = singleQuoteToken(sessionDir);

  return `#!/bin/bash
set -euo pipefail

SESSIONS_DIR=${sessionDirToken}
MESSAGES_DIR="$SESSIONS_DIR/messages"
SEQ_FILE="$SESSIONS_DIR/.seq"

# Initialise session directory structure and sequence counter.
mkdir -p "$MESSAGES_DIR"
echo 0 > "$SEQ_FILE"

# Set env vars for the Stop hook.
export AUTOBEAT_WORKER=true
export AUTOBEAT_TASK_ID=${singleQuoteToken(config.taskId)}
export AUTOBEAT_SESSIONS_DIR=${singleQuoteToken(config.sessionsDir)}

# exec-replace this shell with the agent REPL (interactive mode, no output piping).
# The agent owns the tmux session from this point forward.
exec ${singleQuoteToken(config.agentCommand)} ${agentArgs}
`;
}

export class TmuxHooks implements TmuxHooksPort {
  constructor(private readonly deps: TmuxHooksDeps) {}

  /**
   * Validates taskId and sessionsDir — shared preconditions for all operations.
   * Returns err() on the first violation.
   * SECURITY: Both values are embedded in generated scripts or used in recursive
   * filesystem operations; invalid values could cause shell injection or path traversal.
   */
  private validateBaseInputs(operation: string, taskId: string, sessionsDir: string): Result<void, AutobeatError> {
    if (!TASK_ID_REGEX.test(taskId)) {
      return err(tmuxHookFailed(operation, `invalid taskId: ${taskId}`, { taskId }));
    }
    if (!SAFE_PATH_REGEX.test(sessionsDir)) {
      return err(tmuxHookFailed(operation, `unsafe sessionsDir path: ${sessionsDir}`, { taskId, sessionsDir }));
    }
    return ok(undefined);
  }

  /**
   * Generates the session directory and setup shim for a persistent interactive session.
   * The shim initialises the messages directory and seq file, then execs the agent
   * interactively (no --print). Output is captured via the Stop hook mechanism.
   */
  generateSetupShim(config: SetupShimConfig): Result<SetupShimManifest, AutobeatError> {
    const baseCheck = this.validateBaseInputs('generateSetupShim', config.taskId, config.sessionsDir);
    if (!baseCheck.ok) return baseCheck;

    // SECURITY: Validate agentCommand against SAFE_PATH_REGEX before embedding
    if (!SAFE_PATH_REGEX.test(config.agentCommand)) {
      return err(
        tmuxHookFailed('generateSetupShim', `unsafe agentCommand: ${config.agentCommand}`, {
          taskId: config.taskId,
          agentCommand: config.agentCommand,
        }),
      );
    }

    const sessionDir = path.join(config.sessionsDir, config.taskId);
    const messagesDir = path.join(sessionDir, 'messages');
    const shimPath = path.join(sessionDir, 'setup-shim.sh');

    try {
      // Create session root directory and messages subdirectory.
      // The shim script itself will re-init these at runtime, but we create them
      // here so TmuxConnector can set up fs.watch watchers before session launch.
      this.deps.mkdirSync(sessionDir, { recursive: true, mode: FILE_MODE });
      this.deps.mkdirSync(messagesDir, { recursive: true, mode: FILE_MODE });

      const shimContent = buildSetupShim(config);
      this.deps.writeFile(shimPath, shimContent, { mode: FILE_MODE });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return err(tmuxHookFailed('generateSetupShim', reason, { taskId: config.taskId, sessionDir }));
    }

    return ok({ shimPath, sessionDir, messagesDir });
  }

  /**
   * Creates the session directory tree for a new loop iteration without regenerating
   * the setup shim. Called by TmuxConnector.prepareForReuse() when a persistent session
   * is being reused — the tmux session already exists; only the per-iteration task
   * directory needs to be (re)initialised.
   *
   * Creates {sessionsDir}/{taskId}/messages/ and writes 0 to .seq.
   * Returns the sessionDir and messagesDir paths on success.
   */
  initTaskDirectory(
    taskId: TaskId,
    sessionsDir: string,
  ): Result<{ sessionDir: string; messagesDir: string }, AutobeatError> {
    const baseCheck = this.validateBaseInputs('initTaskDirectory', taskId, sessionsDir);
    if (!baseCheck.ok) return baseCheck;

    const sessionDir = path.join(sessionsDir, taskId);
    const messagesDir = path.join(sessionDir, 'messages');
    const seqFilePath = path.join(sessionDir, '.seq');

    try {
      this.deps.mkdirSync(sessionDir, { recursive: true, mode: FILE_MODE });
      this.deps.mkdirSync(messagesDir, { recursive: true, mode: FILE_MODE });
      this.deps.writeFile(seqFilePath, '0', { mode: FILE_MODE });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return err(tmuxHookFailed('initTaskDirectory', reason, { taskId, sessionDir }));
    }

    return ok({ sessionDir, messagesDir });
  }

  /**
   * Removes the session directory and all its contents.
   * taskId and sessionsDir are validated via validateBaseInputs before being
   * passed to path.join + rmSync(recursive:true) — callers cannot introduce
   * shell metacharacters or path traversal through this entry point.
   */
  cleanup(taskId: TaskId, sessionsDir: string): Result<void, AutobeatError> {
    const baseCheck = this.validateBaseInputs('cleanup', taskId, sessionsDir);
    if (!baseCheck.ok) return baseCheck;

    const sessionDir = path.join(sessionsDir, taskId);
    try {
      this.deps.rmSync(sessionDir, { recursive: true, force: true });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return err(tmuxHookFailed('cleanup', reason, { taskId, sessionDir }));
    }
    return ok(undefined);
  }
}
