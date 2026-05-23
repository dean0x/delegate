/**
 * Unit tests: bootstrap TmuxValidator eager fail-fast
 *
 * Verifies that bootstrap rejects startup (returns err) when tmux is missing or
 * too old in server/run modes, and that validation is skipped when:
 *   - an injected tmuxConnector is provided (test/DI override path), or
 *   - mode === 'cli' (no worker spawning, tmux not required).
 *
 * PATTERN: Uses options.tmuxExec injection (not vi.mock('child_process')) to avoid
 * polluting the shared module registry in non-isolated vitest mode. This is the
 * correct DI pattern for testing exec-dependent code paths.
 */

import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrap } from '../../../src/bootstrap.js';
import { ErrorCode } from '../../../src/core/errors.js';
import { TestResourceMonitor } from '../../../src/implementations/resource-monitor.js';
import type { ExecFn, ExecResult } from '../../../src/implementations/tmux/types.js';
import { createTmuxAgentRegistry } from '../../fixtures/mock-agent.js';
import { createMockTmuxConnector } from '../../fixtures/mocks.js';

/** Builds a deterministic ExecFn that simulates tmux installed at the given version. */
function makeExecOk(version: string): ExecFn {
  return (cmd: string): ExecResult => {
    if (cmd === 'command -v tmux') return { stdout: '/usr/bin/tmux', stderr: '', status: 0 };
    if (cmd.includes('jq')) return { stdout: '/usr/bin/jq', stderr: '', status: 0 };
    // Any other tmux command (e.g. tmux -V, list-sessions, etc.)
    return { stdout: version, stderr: '', status: 0 };
  };
}

/** Builds a deterministic ExecFn that simulates tmux not installed (exit 127). */
function makeExecMissing(): ExecFn {
  return (_cmd: string): ExecResult => ({ stdout: '', stderr: 'tmux: command not found', status: 127 });
}

describe('Bootstrap — TmuxValidator eager fail-fast', () => {
  let tempDir: string;
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'autobeat-tmux-validation-'));
    originalEnv['AUTOBEAT_DATABASE_PATH'] = process.env['AUTOBEAT_DATABASE_PATH'];
    process.env['AUTOBEAT_DATABASE_PATH'] = join(tempDir, 'test.db');
  });

  afterEach(async () => {
    if (originalEnv['AUTOBEAT_DATABASE_PATH'] === undefined) {
      delete process.env['AUTOBEAT_DATABASE_PATH'];
    } else {
      process.env['AUTOBEAT_DATABASE_PATH'] = originalEnv['AUTOBEAT_DATABASE_PATH'];
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns err(SYSTEM_ERROR) in server mode when tmux is missing', async () => {
    const result = await bootstrap({
      mode: 'server',
      agentRegistry: createTmuxAgentRegistry(),
      resourceMonitor: new TestResourceMonitor(),
      tmuxExec: makeExecMissing(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.SYSTEM_ERROR);
    expect(result.error.message).toContain('tmux validation failed');
  });

  it('returns err(SYSTEM_ERROR) in run mode when tmux version is too old', async () => {
    const result = await bootstrap({
      mode: 'run',
      agentRegistry: createTmuxAgentRegistry(),
      resourceMonitor: new TestResourceMonitor(),
      tmuxExec: makeExecOk('tmux 2.9'),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.SYSTEM_ERROR);
    expect(result.error.message).toContain('tmux validation failed');
  });

  it('succeeds in server mode when tmux >= 3.0 is installed', async () => {
    const result = await bootstrap({
      mode: 'server',
      agentRegistry: createTmuxAgentRegistry(),
      resourceMonitor: new TestResourceMonitor(),
      tmuxExec: makeExecOk('tmux 3.3a'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await result.value.dispose();
  });

  it('skips validation when tmuxConnector is injected (test DI override)', async () => {
    // tmuxExec would cause validation failure — but tmuxConnector bypasses validation entirely
    const result = await bootstrap({
      mode: 'server',
      agentRegistry: createTmuxAgentRegistry(),
      resourceMonitor: new TestResourceMonitor(),
      tmuxConnector: createMockTmuxConnector(),
      tmuxExec: makeExecMissing(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await result.value.dispose();
  });

  it('skips validation in cli mode (no worker spawning needed)', async () => {
    // tmuxExec would cause validation failure — but cli mode skips validation
    const result = await bootstrap({
      mode: 'cli',
      agentRegistry: createTmuxAgentRegistry(),
      resourceMonitor: new TestResourceMonitor(),
      tmuxExec: makeExecMissing(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await result.value.dispose();
  });
});
