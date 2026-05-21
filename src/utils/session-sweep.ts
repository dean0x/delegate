/**
 * Shared session sweep utility for graceful shutdown.
 *
 * ARCHITECTURE: Called by both container.dispose() and the index.ts signal
 * handler to destroy any remaining beat-* tmux sessions after killAll().
 * Belt-and-suspenders guard for sessions that were spawning during shutdown.
 *
 * Pattern: Result types, dependency injection via parameters, no throwing.
 */

import { AutobeatError } from '../core/errors.js';
import type { Logger } from '../core/interfaces.js';
import { ok, Result } from '../core/result.js';
import type { TmuxSessionManagerCorePort } from '../core/tmux-types.js';

/**
 * Destroy all active tmux sessions via the given session manager.
 *
 * @param tmux - Session manager port to list and destroy sessions
 * @param logger - Optional logger; when absent, destroy failures are silently ignored
 * @returns Result<number, AutobeatError> with the count of sessions destroyed,
 *          or the first error encountered if listSessions() fails
 */
export function sweepTmuxSessions(tmux: TmuxSessionManagerCorePort, logger?: Logger): Result<number, AutobeatError> {
  const sessionsResult = tmux.listSessions();
  if (!sessionsResult.ok) {
    return sessionsResult;
  }

  let destroyed = 0;
  for (const session of sessionsResult.value) {
    const destroyResult = tmux.destroySession(session.name);
    if (destroyResult.ok) {
      destroyed++;
    } else if (logger) {
      logger.warn('Shutdown session sweep: failed to destroy session', {
        sessionName: session.name,
        error: destroyResult.error.message,
      });
    }
    // When no logger is provided (container.dispose path), failures are silently
    // ignored so that DB close is not blocked by a stale session entry.
  }

  return ok(destroyed);
}
