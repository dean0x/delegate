/**
 * Integration tests for TmuxSessionManager — real tmux required.
 * Skips gracefully if tmux is not available or is below minimum version.
 */

import * as fs from 'fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TmuxSessionManager } from '../../../src/implementations/tmux/tmux-session-manager.js';
import type { ExecFn } from '../../../src/implementations/tmux/types.js';
import { isTmuxAvailable, realExec } from './test-helpers.js';

const TEST_SESSION = 'beat-integration-lifecycle';

let SKIP = false;

beforeAll(() => {
  SKIP = !isTmuxAvailable();
  if (SKIP) {
    console.warn('[SKIP] tmux not available, below 3.0, or server not functional — skipping integration tests');
  }
});

afterAll(() => {
  // Best-effort cleanup
  realExec(`tmux kill-session -t ${TEST_SESSION} 2>/dev/null || true`);
});

describe('TmuxSessionManager integration — session lifecycle', () => {
  let manager: TmuxSessionManager;

  beforeAll(() => {
    manager = new TmuxSessionManager({
      exec: realExec as ExecFn,
      writeFileSync: (p, c) => fs.writeFileSync(p, c, 'utf8'),
      unlinkSync: (p) => {
        try {
          fs.unlinkSync(p);
        } catch {
          /* best-effort */
        }
      },
    });
  });

  it('full lifecycle: create → isAlive → sendKeys → destroy', () => {
    if (SKIP) return;

    // Clean up any leftover from previous run
    realExec(`tmux kill-session -t ${TEST_SESSION} 2>/dev/null || true`);

    const createResult = manager.createSession({
      name: TEST_SESSION,
      command: 'bash',
      cwd: '/tmp',
    });
    expect(createResult.ok).toBe(true);

    const aliveResult = manager.isAlive(TEST_SESSION);
    expect(aliveResult.ok).toBe(true);
    if (!aliveResult.ok) return;
    expect(aliveResult.value).toBe(true);

    const sendResult = manager.sendKeys(TEST_SESSION, 'echo hello integration');
    expect(sendResult.ok).toBe(true);

    const destroyResult = manager.destroySession(TEST_SESSION);
    expect(destroyResult.ok).toBe(true);

    const deadResult = manager.isAlive(TEST_SESSION);
    expect(deadResult.ok).toBe(true);
    if (!deadResult.ok) return;
    expect(deadResult.value).toBe(false);
  });

  it('listSessions shows created session', () => {
    if (SKIP) return;

    realExec(`tmux kill-session -t ${TEST_SESSION} 2>/dev/null || true`);
    manager.createSession({ name: TEST_SESSION, command: 'bash', cwd: '/tmp' });

    const listResult = manager.listSessions();
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;
    const found = listResult.value.find((s) => s.name === TEST_SESSION);
    expect(found).toBeDefined();

    manager.destroySession(TEST_SESSION);
  });

  it('environment variables are retrievable after injection', () => {
    if (SKIP) return;

    realExec(`tmux kill-session -t ${TEST_SESSION} 2>/dev/null || true`);
    manager.createSession({
      name: TEST_SESSION,
      command: 'bash',
      cwd: '/tmp',
      env: { AUTOBEAT_TEST_VAR: 'integration-value' },
    });

    const envResult = manager.getSessionEnvironment(TEST_SESSION, 'AUTOBEAT_TEST_VAR');
    expect(envResult.ok).toBe(true);
    if (!envResult.ok) return;
    expect(envResult.value).toBe('integration-value');

    manager.destroySession(TEST_SESSION);
  });

  it('concurrent session limit is enforced', () => {
    if (SKIP) return;

    const limitedManager = new TmuxSessionManager({
      exec: realExec as ExecFn,
      maxConcurrentSessions: 0, // Artificially small limit
      writeFileSync: (p, c) => fs.writeFileSync(p, c, 'utf8'),
      unlinkSync: (p) => {
        try {
          fs.unlinkSync(p);
        } catch {
          /* best-effort */
        }
      },
    });

    const result = limitedManager.createSession({
      name: TEST_SESSION,
      command: 'bash',
      cwd: '/tmp',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('limit');
  });

  it('destroySession is idempotent — destroying non-existent session returns ok', () => {
    if (SKIP) return;

    realExec(`tmux kill-session -t ${TEST_SESSION} 2>/dev/null || true`);
    const result = manager.destroySession(TEST_SESSION);
    expect(result.ok).toBe(true);
  });
});
