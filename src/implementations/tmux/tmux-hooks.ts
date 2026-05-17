/**
 * TmuxHooks — wrapper script generation and session directory lifecycle
 *
 * DESIGN DECISION: The wrapper script approach works universally across agent
 * types. Each agent invocation gets an isolated session directory under
 * sessionsDir/{taskId}/. The wrapper captures output to JSON files and writes
 * a sentinel (.done or .exit) when done — enabling push-based completion
 * detection via fs.watch without polling.
 *
 * SECURITY: All paths embedded in the generated script are double-quoted to
 * prevent word splitting and glob expansion. The agentCommand and agentArgs
 * are embedded as-is; callers are responsible for ensuring these values come
 * from trusted configuration, not user input.
 */

import * as path from 'path';
import { AutobeatError, tmuxHookFailed } from '../../core/errors.js';
import { err, ok, Result } from '../../core/result.js';
import { SENTINEL_DONE, SENTINEL_EXIT, SESSION_NAME_REGEX, TmuxHooks, WrapperConfig, WrapperManifest } from './types.js';

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
 */
function buildCommunicationBlock(config: WrapperConfig): string {
  const { communicationTargets: targets } = config;
  if (!targets || targets.length === 0) return '';

  const validTargets = targets.filter((t) => SESSION_NAME_REGEX.test(t));
  if (validTargets.length === 0) return '';

  const sendLines = validTargets.map((t) => `  tmux send-keys -t "${t}" -l "$PAYLOAD" Enter`).join('\n');

  return `
# Send result to communication targets
RESULT_FILE=$(ls -1 "$MESSAGES_DIR"/*.json 2>/dev/null | tail -1)
if [ -n "$RESULT_FILE" ]; then
  PAYLOAD=$(cat "$RESULT_FILE")
${sendLines}
fi`;
}

/**
 * Generates the wrapper bash script content.
 */
function buildWrapperScript(config: WrapperConfig): string {
  const sessionDir = path.join(config.sessionsDir, config.taskId);
  const agentArgs = config.agentArgs.join(' ');
  const communicationBlock = buildCommunicationBlock(config);

  return `#!/bin/bash
set -euo pipefail

command -v jq >/dev/null 2>&1 || { echo "FATAL: jq is required but not found in PATH" >&2; exit 127; }

SESSIONS_DIR="${sessionDir}"
MESSAGES_DIR="$SESSIONS_DIR/messages"
SEQ_FILE="$SESSIONS_DIR/.seq"

next_seq() {
  (
    flock -x 200 2>/dev/null || true
    SEQ=$(cat "$SEQ_FILE" 2>/dev/null || echo 0)
    SEQ=$((SEQ + 1))
    echo $SEQ > "$SEQ_FILE"
    printf "%05d" $SEQ
  ) 200>"$SEQ_FILE.lock"
}

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

EXIT_CODE=\${PIPESTATUS[0]}
set -e

if [ $EXIT_CODE -eq 0 ]; then
  echo "$EXIT_CODE" > "$SESSIONS_DIR/${SENTINEL_DONE}.tmp"
  mv "$SESSIONS_DIR/${SENTINEL_DONE}.tmp" "$SESSIONS_DIR/${SENTINEL_DONE}"
else
  echo "$EXIT_CODE" > "$SESSIONS_DIR/${SENTINEL_EXIT}.tmp"
  mv "$SESSIONS_DIR/${SENTINEL_EXIT}.tmp" "$SESSIONS_DIR/${SENTINEL_EXIT}"
fi
${communicationBlock}

exit $EXIT_CODE
`;
}

export class DefaultTmuxHooks implements TmuxHooks {
  constructor(private readonly deps: TmuxHooksDeps) {}

  /**
   * Generates the session directory tree and wrapper script for a task.
   * Returns a manifest with all artifact paths.
   */
  generateWrapper(config: WrapperConfig): Result<WrapperManifest, AutobeatError> {
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
      sessionsDir: sessionDir,
      sentinelPath,
      messagesDir,
      seqFilePath,
    });
  }

  /**
   * Removes the session directory and all its contents.
   */
  cleanup(taskId: string, sessionsDir: string): Result<void, AutobeatError> {
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
