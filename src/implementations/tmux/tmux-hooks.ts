/**
 * TmuxHooks — wrapper script generation and session directory lifecycle
 *
 * DESIGN DECISION: The wrapper script approach works universally across agent
 * types. Each agent invocation gets an isolated session directory under
 * sessionsDir/{taskId}/. The wrapper captures output to JSON files and writes
 * a sentinel (.done or .exit) when done — enabling push-based completion
 * detection via fs.watch without polling.
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
import type { TmuxHooksPort, WrapperConfig, WrapperManifest } from './types.js';
import { SAFE_PATH_REGEX, SENTINEL_DONE, SENTINEL_EXIT, SESSION_NAME_REGEX, TASK_ID_REGEX } from './types.js';

/** Octal permission bits for session directories and scripts (owner read/write/execute only) */
const FILE_MODE = 0o700;

export interface TmuxHooksDeps {
  writeFile: (filePath: string, content: string, opts: { mode: number }) => void;
  mkdirSync: (dirPath: string, opts: { recursive: boolean; mode: number }) => void;
  rmSync: (dirPath: string, opts: { recursive: boolean; force: boolean }) => void;
}

/**
 * Generates the communication block for the wrapper script.
 * When targets are configured, the final JSON message is forwarded to each.
 *
 * SECURITY: Targets are validated against SESSION_NAME_REGEX before embedding
 * in the generated bash script. Invalid targets are silently dropped to prevent
 * shell injection — callers must ensure target names come from trusted sources.
 *
 * SECURITY: File content is piped directly into tmux load-buffer to bypass shell
 * variable expansion. Reading content into a $PAYLOAD variable and passing it as
 * a double-quoted argument would allow agent output containing $() or backticks to
 * be interpreted by the shell before tmux sees them.
 */
function buildCommunicationBlock(config: WrapperConfig): string {
  const { communicationTargets: targets } = config;
  if (!targets || targets.length === 0) return '';

  const validTargets = targets.filter((t) => SESSION_NAME_REGEX.test(t));
  if (validTargets.length === 0) return '';

  const sendLines = validTargets
    .map(
      (t) =>
        `  cat "$RESULT_FILE" | tmux load-buffer -b beat-payload -\n  tmux paste-buffer -b beat-payload -t "${t}"\n  tmux delete-buffer -b beat-payload`,
    )
    .join('\n');

  return `
# Send result to communication targets
RESULT_FILE=$(ls -1 "$MESSAGES_DIR"/*.json 2>/dev/null | tail -1)
if [ -n "$RESULT_FILE" ]; then
${sendLines}
fi`;
}

/**
 * next_seq bash function body for the wrapper script.
 *
 * DESIGN DECISION: flock is intentionally absent. This wrapper is a single
 * pipeline (one writer at a time) — the while-read loop is the sole caller of
 * next_seq and bash does not run loop iterations in parallel. flock -x is a
 * GNU coreutils utility unavailable on macOS without Homebrew, so including it
 * would silently fail (the `|| true` guard) and add no protection anyway.
 */
const NEXT_SEQ_FN = `\
next_seq() {
  SEQ=$(cat "$SEQ_FILE" 2>/dev/null || echo 0)
  SEQ=$((SEQ + 1))
  echo $SEQ > "$SEQ_FILE"
  printf "%05d" $SEQ
}`;

/**
 * Generates the wrapper bash script content.
 */
function buildWrapperScript(config: WrapperConfig): string {
  const sessionDir = path.join(config.sessionsDir, config.taskId);
  // SECURITY: Each argument is individually single-quoted to prevent word
  // splitting, glob expansion, and injection of shell metacharacters.
  const agentArgs = config.agentArgs.map(singleQuoteToken).join(' ');
  const communicationBlock = buildCommunicationBlock(config);
  // SECURITY: sessionDir is assembled from sessionsDir and taskId, both validated
  // against SAFE_PATH_REGEX above. singleQuoteToken is used here for consistency
  // with all other path/value embeddings in this script.
  const sessionDirToken = singleQuoteToken(sessionDir);

  return `#!/bin/bash
set -euo pipefail

command -v jq >/dev/null 2>&1 || { echo "FATAL: jq is required but not found in PATH" >&2; exit 127; }

SESSIONS_DIR=${sessionDirToken}
MESSAGES_DIR="$SESSIONS_DIR/messages"
SEQ_FILE="$SESSIONS_DIR/.seq"

${NEXT_SEQ_FN}

# Ensure a sentinel is always written, even if jq crashes or mv fails mid-run.
# The exit code captured here is the script's exit code at trap time; when the
# main flow completes normally it will have already written the sentinel, so
# the guard condition prevents a duplicate.
_sentinel_guard() {
  local _ec=$?
  if [ ! -f "$SESSIONS_DIR/${SENTINEL_DONE}" ] && [ ! -f "$SESSIONS_DIR/${SENTINEL_EXIT}" ]; then
    echo "$_ec" > "$SESSIONS_DIR/${SENTINEL_EXIT}.tmp"
    mv "$SESSIONS_DIR/${SENTINEL_EXIT}.tmp" "$SESSIONS_DIR/${SENTINEL_EXIT}" 2>/dev/null || true
  fi
}
trap _sentinel_guard EXIT

# Launch agent, capture output.
# set +e disables errexit for the pipeline so that a non-zero agent exit does
# not terminate the script before PIPESTATUS is captured and the sentinel is
# written. pipefail remains active (set via -o pipefail above) so PIPESTATUS[0]
# reflects the agent exit code correctly.
set +e
${config.agentCommand} ${agentArgs} 2>&1 | while IFS= read -r line; do
  SEQ=$(next_seq)
  TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)
  ESCAPED=$(printf '%s' "$line" | jq -Rs .)
  MSG_FILE="$MESSAGES_DIR/\${SEQ}-stdout.json"
  printf '{"sequence":%d,"timestamp":"%s","type":"stdout","content":%s}\\n' "$SEQ" "$TIMESTAMP" "$ESCAPED" > "\${MSG_FILE}.tmp"
  mv "\${MSG_FILE}.tmp" "$MSG_FILE"
done

EXIT_CODE="\${PIPESTATUS[0]:-1}"
set -e

if [ "$EXIT_CODE" -eq 0 ]; then
  echo "$EXIT_CODE" > "$SESSIONS_DIR/${SENTINEL_DONE}.tmp"
  mv "$SESSIONS_DIR/${SENTINEL_DONE}.tmp" "$SESSIONS_DIR/${SENTINEL_DONE}"
else
  echo "$EXIT_CODE" > "$SESSIONS_DIR/${SENTINEL_EXIT}.tmp"
  mv "$SESSIONS_DIR/${SENTINEL_EXIT}.tmp" "$SESSIONS_DIR/${SENTINEL_EXIT}"
fi
${communicationBlock}

exit "$EXIT_CODE"
`;
}

export class TmuxHooks implements TmuxHooksPort {
  constructor(private readonly deps: TmuxHooksDeps) {}

  /**
   * Validates taskId and sessionsDir — both are shared preconditions for
   * generateWrapper() and cleanup(). Returns err() on the first violation.
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
   * Generates the session directory tree and wrapper script for a task.
   * Returns a manifest with all artifact paths.
   */
  generateWrapper(config: WrapperConfig): Result<WrapperManifest, AutobeatError> {
    const baseCheck = this.validateBaseInputs('generateWrapper', config.taskId, config.sessionsDir);
    if (!baseCheck.ok) return baseCheck;

    // SECURITY: Validate agentCommand against SAFE_PATH_REGEX before embedding
    // in the generated script. Reject-bad-input is preferred over escaping for
    // command paths — a command with shell metacharacters is almost certainly a
    // misconfiguration rather than a legitimate path.
    if (!SAFE_PATH_REGEX.test(config.agentCommand)) {
      return err(
        tmuxHookFailed('generateWrapper', `unsafe agentCommand: ${config.agentCommand}`, {
          taskId: config.taskId,
          agentCommand: config.agentCommand,
        }),
      );
    }

    const sessionDir = path.join(config.sessionsDir, config.taskId);
    const messagesDir = path.join(sessionDir, 'messages');
    const wrapperPath = path.join(sessionDir, 'wrapper.sh');
    const sentinelPath = path.join(sessionDir, SENTINEL_DONE);
    const seqFilePath = path.join(sessionDir, '.seq');

    try {
      // Create session root directory
      this.deps.mkdirSync(sessionDir, { recursive: true, mode: FILE_MODE });
      // Create messages subdirectory
      this.deps.mkdirSync(messagesDir, { recursive: true, mode: FILE_MODE });

      // Generate and write wrapper script
      const scriptContent = buildWrapperScript(config);
      this.deps.writeFile(wrapperPath, scriptContent, { mode: FILE_MODE });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return err(tmuxHookFailed('generateWrapper', reason, { taskId: config.taskId, sessionDir }));
    }

    return ok({
      wrapperPath,
      sessionDir,
      sentinelPath,
      messagesDir,
      seqFilePath,
    });
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
