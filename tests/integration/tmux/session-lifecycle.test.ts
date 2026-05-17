/**
 * Integration tests for TmuxSessionManager — real tmux required.
 * Skips gracefully if tmux is not available or is below minimum version.
 */

import { spawnSync } from 'child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DefaultTmuxSessionManager } from '../../../src/implementations/tmux/tmux-session-manager.js';
import type { ExecFn, ExecResult, TmuxSessionManager } from '../../../src/implementations/tmux/types.js';

const TEST_SESSION = 'beat-integration-lifecycle';

function realExec(cmd: string): ExecResult {
  const result = spawnSync('sh', ['-c', cmd], { encoding: 'utf8' });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 1,
  };
}

function isTmuxAvailable(): boolean {
  // Check binary exists and is >= 3.0
  const versionCheck = realExec('which tmux && tmux -V');
  if (versionCheck.status !== 0) return false;
  const match = /(\d+)\.(\d+)/.exec(versionCheck.stdout);
  if (!match) return false;
  const [, major, minor] = match;
  const versionOk = (parseInt(major!, 10) === 3 && parseInt(minor!, 10) >= 0) || parseInt(major!, 10) > 3;
  if (!versionOk) return false;

  // Verify the tmux server is functional — not just that the binary exists.
  // CI environments may have the binary installed but no server/socket support.
  // Attempt to create and immediately destroy a probe session.
  const probeSession = 'beat-ci-probe';
  const probe = realExec(`tmux new-session -d -s ${probeSession} 'exit' && tmux kill-session -t ${probeSession}`);
  return probe.status === 0;
}

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
    manager = new DefaultTmuxSessionManager({ exec: realExec as ExecFn });
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

    const limitedManager = new DefaultTmuxSessionManager({
      exec: realExec as ExecFn,
      maxConcurrentSessions: 0, // Artificially small limit
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
