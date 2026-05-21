/**
 * Unit tests for sweepTmuxSessions utility
 * ARCHITECTURE: Tests the shared shutdown helper used by container.dispose()
 * and index.ts signal handler. Pure unit tests — no I/O, fully mocked.
 * Pattern: Result types, 4-branch coverage of the branching logic.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AutobeatError, ErrorCode } from '../../../src/core/errors.js';
import { err, ok } from '../../../src/core/result.js';
import type { TmuxSessionManagerCorePort } from '../../../src/core/tmux-types.js';
import { sweepTmuxSessions } from '../../../src/utils/session-sweep.js';
import { createMockLogger, createMockTmuxSessionManagerCore } from '../../fixtures/mocks.js';

// Helper: build a minimal TmuxSession object (name + created timestamp).
const makeSession = (name: string) => ({
  name,
  created: Date.now(),
});

describe('sweepTmuxSessions()', () => {
  let tmux: ReturnType<typeof createMockTmuxSessionManagerCore>;

  beforeEach(() => {
    tmux = createMockTmuxSessionManagerCore();
  });

  describe('happy path — all sessions destroyed', () => {
    it('returns ok(count) equal to the number of sessions when all destroy calls succeed', () => {
      const sessions = [makeSession('beat-abc'), makeSession('beat-def')];
      vi.mocked(tmux.listSessions).mockReturnValue(ok(sessions));
      vi.mocked(tmux.destroySession).mockReturnValue(ok(undefined));

      const result = sweepTmuxSessions(tmux);

      expect(result).toEqual({ ok: true, value: 2 });
      expect(tmux.destroySession).toHaveBeenCalledTimes(2);
      expect(tmux.destroySession).toHaveBeenCalledWith('beat-abc');
      expect(tmux.destroySession).toHaveBeenCalledWith('beat-def');
    });

    it('returns ok(0) when there are no sessions to destroy', () => {
      vi.mocked(tmux.listSessions).mockReturnValue(ok([]));

      const result = sweepTmuxSessions(tmux);

      expect(result).toEqual({ ok: true, value: 0 });
      expect(tmux.destroySession).not.toHaveBeenCalled();
    });
  });

  describe('listSessions failure', () => {
    it('returns the error immediately without attempting any destroySession calls', () => {
      const listError = new AutobeatError(ErrorCode.SYSTEM_ERROR, 'tmux not found');
      vi.mocked(tmux.listSessions).mockReturnValue(err(listError));

      const result = sweepTmuxSessions(tmux);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(listError);
      }
      expect(tmux.destroySession).not.toHaveBeenCalled();
    });
  });

  describe('per-session destroySession failure WITH logger', () => {
    it('logs a warning for each failed session, continues to the next, and counts only successes', () => {
      const sessions = [makeSession('beat-ok'), makeSession('beat-fail'), makeSession('beat-ok2')];
      vi.mocked(tmux.listSessions).mockReturnValue(ok(sessions));

      const destroyError = new AutobeatError(ErrorCode.SYSTEM_ERROR, 'session already gone');
      vi.mocked(tmux.destroySession)
        .mockReturnValueOnce(ok(undefined)) // beat-ok: success
        .mockReturnValueOnce(err(destroyError)) // beat-fail: failure
        .mockReturnValueOnce(ok(undefined)); // beat-ok2: success

      const logger = createMockLogger();
      const result = sweepTmuxSessions(tmux, logger);

      // Only the two successful sessions are counted
      expect(result).toEqual({ ok: true, value: 2 });

      // Warning was logged for the failed session
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        'Shutdown session sweep: failed to destroy session',
        expect.objectContaining({
          sessionName: 'beat-fail',
          error: destroyError.message,
        }),
      );
    });

    it('logs a warning for every failed session when all sessions fail', () => {
      const sessions = [makeSession('beat-a'), makeSession('beat-b')];
      vi.mocked(tmux.listSessions).mockReturnValue(ok(sessions));

      const destroyError = new AutobeatError(ErrorCode.SYSTEM_ERROR, 'cannot destroy');
      vi.mocked(tmux.destroySession).mockReturnValue(err(destroyError));

      const logger = createMockLogger();
      const result = sweepTmuxSessions(tmux, logger);

      expect(result).toEqual({ ok: true, value: 0 });
      expect(logger.warn).toHaveBeenCalledTimes(2);
    });
  });

  describe('per-session destroySession failure WITHOUT logger', () => {
    it('silently continues when a session fails to destroy and no logger is provided', () => {
      const sessions = [makeSession('beat-ok'), makeSession('beat-fail')];
      vi.mocked(tmux.listSessions).mockReturnValue(ok(sessions));

      const destroyError = new AutobeatError(ErrorCode.SYSTEM_ERROR, 'already gone');
      vi.mocked(tmux.destroySession).mockReturnValueOnce(ok(undefined)).mockReturnValueOnce(err(destroyError));

      // No logger passed — failures should be silently swallowed
      const result = sweepTmuxSessions(tmux);

      expect(result).toEqual({ ok: true, value: 1 });
      // Both sessions were attempted despite the failure
      expect(tmux.destroySession).toHaveBeenCalledTimes(2);
    });

    it('returns ok(0) when all sessions fail without a logger', () => {
      const sessions = [makeSession('beat-a'), makeSession('beat-b')];
      vi.mocked(tmux.listSessions).mockReturnValue(ok(sessions));

      const destroyError = new AutobeatError(ErrorCode.SYSTEM_ERROR, 'cannot destroy');
      vi.mocked(tmux.destroySession).mockReturnValue(err(destroyError));

      const result = sweepTmuxSessions(tmux);
      expect(result).toEqual({ ok: true, value: 0 });
    });
  });
});
