/**
 * Unit tests for TmuxHooks
 * All filesystem operations are intercepted via injected dependencies.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../../../../src/core/errors.js';
import { TmuxHooks, type TmuxHooksDeps } from '../../../../src/implementations/tmux/tmux-hooks.js';
import type { SetupShimConfig } from '../../../../src/implementations/tmux/types.js';

function makeDeps(): {
  deps: TmuxHooksDeps;
  writeFile: ReturnType<typeof vi.fn>;
  mkdirSync: ReturnType<typeof vi.fn>;
  rmSync: ReturnType<typeof vi.fn>;
} {
  const writeFile = vi.fn();
  const mkdirSync = vi.fn();
  const rmSync = vi.fn();
  return {
    deps: { writeFile, mkdirSync, rmSync } as TmuxHooksDeps,
    writeFile,
    mkdirSync,
    rmSync,
  };
}

describe('TmuxHooks.cleanup()', () => {
  it('removes session directory recursively', () => {
    const { deps, rmSync } = makeDeps();
    const hooks = new TmuxHooks(deps);
    hooks.cleanup('task-abc', '/tmp/sessions');
    expect(rmSync).toHaveBeenCalledOnce();
    const [dirPath, opts] = rmSync.mock.calls[0] as [string, { recursive: boolean; force: boolean }];
    expect(dirPath).toContain('task-abc');
    expect(opts.recursive).toBe(true);
    expect(opts.force).toBe(true);
  });

  // B5: cleanup error path — rmSync throws
  it('returns TMUX_HOOK_FAILED when rmSync throws', () => {
    const { deps, rmSync } = makeDeps();
    rmSync.mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });
    const hooks = new TmuxHooks(deps);
    const result = hooks.cleanup('task-abc', '/tmp/sessions');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.TMUX_HOOK_FAILED);
  });

  // SECURITY: taskId and sessionsDir are validated before being passed to path.join + rmSync.
  // These tests guard cleanup() as a public interface independent of generateWrapper() tests.
  it('returns TMUX_HOOK_FAILED for invalid taskId (shell metacharacters)', () => {
    const { deps, rmSync } = makeDeps();
    const hooks = new TmuxHooks(deps);
    const result = hooks.cleanup('$(evil)', '/tmp/sessions');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.TMUX_HOOK_FAILED);
    // rmSync must not have been called — validation rejects before filesystem access
    expect(rmSync).not.toHaveBeenCalled();
  });

  it('returns TMUX_HOOK_FAILED for unsafe sessionsDir (path traversal attempt)', () => {
    const { deps, rmSync } = makeDeps();
    const hooks = new TmuxHooks(deps);
    const result = hooks.cleanup('task-abc', '/tmp/../etc');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.TMUX_HOOK_FAILED);
    // rmSync must not have been called — validation rejects before filesystem access
    expect(rmSync).not.toHaveBeenCalled();
  });
});

// ─── generateSetupShim ────────────────────────────────────────────────────────

const validShimConfig: SetupShimConfig = {
  taskId: 'task-xyz',
  sessionsDir: '/tmp/sessions',
  agentCommand: '/usr/bin/claude',
  agentArgs: ['--dangerously-skip-permissions'],
};

describe('TmuxHooks.generateSetupShim()', () => {
  let writeFile: ReturnType<typeof vi.fn>;
  let mkdirSync: ReturnType<typeof vi.fn>;
  let hooks: TmuxHooks;

  beforeEach(() => {
    const m = makeDeps();
    writeFile = m.writeFile;
    mkdirSync = m.mkdirSync;
    hooks = new TmuxHooks(m.deps);
  });

  it('creates session root directory with mode 0o700', () => {
    hooks.generateSetupShim(validShimConfig);
    const call = mkdirSync.mock.calls.find(([p]: [string]) => p.endsWith('/task-xyz'));
    expect(call).toBeDefined();
    expect(call?.[1]).toMatchObject({ mode: 0o700 });
  });

  it('creates messages subdirectory with mode 0o700', () => {
    hooks.generateSetupShim(validShimConfig);
    const call = mkdirSync.mock.calls.find(([p]: [string]) => p.endsWith('/messages'));
    expect(call).toBeDefined();
    expect(call?.[1]).toMatchObject({ mode: 0o700 });
  });

  it('writes setup-shim.sh with mode 0o700', () => {
    hooks.generateSetupShim(validShimConfig);
    expect(writeFile).toHaveBeenCalledOnce();
    const [shimPath, , opts] = writeFile.mock.calls[0] as [string, string, { mode: number }];
    expect(shimPath).toContain('setup-shim.sh');
    expect(opts.mode).toBe(0o700);
  });

  it('shim script contains shebang and set -euo pipefail', () => {
    hooks.generateSetupShim(validShimConfig);
    const [, content] = writeFile.mock.calls[0] as [string, string, { mode: number }];
    expect(content).toContain('#!/bin/bash');
    expect(content).toContain('set -euo pipefail');
  });

  it('shim script sets AUTOBEAT_WORKER=true', () => {
    hooks.generateSetupShim(validShimConfig);
    const [, content] = writeFile.mock.calls[0] as [string, string, { mode: number }];
    expect(content).toContain('AUTOBEAT_WORKER=true');
  });

  it('shim script sets AUTOBEAT_TASK_ID to taskId', () => {
    hooks.generateSetupShim(validShimConfig);
    const [, content] = writeFile.mock.calls[0] as [string, string, { mode: number }];
    expect(content).toContain("AUTOBEAT_TASK_ID='task-xyz'");
  });

  it('shim script sets AUTOBEAT_SESSIONS_DIR to sessionsDir', () => {
    hooks.generateSetupShim(validShimConfig);
    const [, content] = writeFile.mock.calls[0] as [string, string, { mode: number }];
    expect(content).toContain("AUTOBEAT_SESSIONS_DIR='/tmp/sessions'");
  });

  it('shim script uses exec to replace shell with agent', () => {
    hooks.generateSetupShim(validShimConfig);
    const [, content] = writeFile.mock.calls[0] as [string, string, { mode: number }];
    expect(content).toMatch(/^exec\s/m);
    expect(content).toContain('/usr/bin/claude');
  });

  it('shim script does NOT contain --print flag', () => {
    hooks.generateSetupShim(validShimConfig);
    const [, content] = writeFile.mock.calls[0] as [string, string, { mode: number }];
    expect(content).not.toContain('--print');
  });

  it('shim script single-quotes agent args', () => {
    hooks.generateSetupShim(validShimConfig);
    const [, content] = writeFile.mock.calls[0] as [string, string, { mode: number }];
    expect(content).toContain("'--dangerously-skip-permissions'");
  });

  it('returns manifest with correct paths', () => {
    const result = hooks.generateSetupShim(validShimConfig);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.shimPath).toContain('setup-shim.sh');
    expect(result.value.sessionDir).toContain('task-xyz');
    expect(result.value.messagesDir).toContain('messages');
  });

  it('returns TMUX_HOOK_FAILED for invalid taskId', () => {
    const result = hooks.generateSetupShim({ ...validShimConfig, taskId: 'INVALID TASK ID!' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.TMUX_HOOK_FAILED);
  });

  it('returns TMUX_HOOK_FAILED for unsafe agentCommand', () => {
    const result = hooks.generateSetupShim({ ...validShimConfig, agentCommand: '/usr/bin/bad"cmd' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.TMUX_HOOK_FAILED);
  });
});

// ─── TmuxHooks.initTaskDirectory() ───────────────────────────────────────────

describe('TmuxHooks.initTaskDirectory()', () => {
  let writeFile: ReturnType<typeof vi.fn>;
  let mkdirSync: ReturnType<typeof vi.fn>;
  let hooks: TmuxHooks;

  beforeEach(() => {
    const m = makeDeps();
    writeFile = m.writeFile;
    mkdirSync = m.mkdirSync;
    hooks = new TmuxHooks(m.deps);
  });

  it('creates session root directory with mode 0o700', () => {
    hooks.initTaskDirectory('task-iter2', '/tmp/sessions');
    const call = mkdirSync.mock.calls.find(([p]: [string]) => p.endsWith('/task-iter2'));
    expect(call).toBeDefined();
    expect(call?.[1]).toMatchObject({ mode: 0o700 });
  });

  it('creates messages subdirectory with mode 0o700', () => {
    hooks.initTaskDirectory('task-iter2', '/tmp/sessions');
    const call = mkdirSync.mock.calls.find(([p]: [string]) => p.endsWith('/messages'));
    expect(call).toBeDefined();
    expect(call?.[1]).toMatchObject({ mode: 0o700 });
  });

  it('writes 0 to the .seq file', () => {
    hooks.initTaskDirectory('task-iter2', '/tmp/sessions');
    const call = writeFile.mock.calls.find(([p]: [string]) => p.endsWith('/.seq'));
    expect(call).toBeDefined();
    expect(call?.[1]).toBe('0');
  });

  it('returns ok with sessionDir and messagesDir paths', () => {
    const result = hooks.initTaskDirectory('task-iter2', '/tmp/sessions');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sessionDir).toBe('/tmp/sessions/task-iter2');
    expect(result.value.messagesDir).toBe('/tmp/sessions/task-iter2/messages');
  });

  it('returns TMUX_HOOK_FAILED when mkdirSync throws', () => {
    const m = makeDeps();
    m.mkdirSync.mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });
    const hooksWithError = new TmuxHooks(m.deps);
    const result = hooksWithError.initTaskDirectory('task-err', '/tmp/sessions');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.TMUX_HOOK_FAILED);
  });

  it('returns TMUX_HOOK_FAILED for invalid taskId', () => {
    const result = hooks.initTaskDirectory('INVALID TASK ID!', '/tmp/sessions');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.TMUX_HOOK_FAILED);
  });

  it('returns TMUX_HOOK_FAILED for unsafe sessionsDir path', () => {
    const result = hooks.initTaskDirectory('task-abc', '/tmp/../etc/passwd');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.TMUX_HOOK_FAILED);
  });
});
