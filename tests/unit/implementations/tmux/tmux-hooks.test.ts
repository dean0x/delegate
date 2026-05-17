/**
 * Unit tests for TmuxHooks
 * All filesystem operations are intercepted via injected dependencies.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../../../../src/core/errors.js';
import { TmuxHooks, type TmuxHooksDeps } from '../../../../src/implementations/tmux/tmux-hooks.js';
import type { WrapperConfig } from '../../../../src/implementations/tmux/types.js';

const validConfig: WrapperConfig = {
  taskId: 'task-abc',
  agent: 'claude',
  sessionsDir: '/tmp/sessions',
  agentCommand: '/usr/bin/claude',
  agentArgs: ['--prompt', 'do stuff'],
};

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

describe('TmuxHooks.generateWrapper()', () => {
  let writeFile: ReturnType<typeof vi.fn>;
  let mkdirSync: ReturnType<typeof vi.fn>;
  let rmSync: ReturnType<typeof vi.fn>;
  let hooks: TmuxHooks;

  beforeEach(() => {
    const m = makeDeps();
    writeFile = m.writeFile;
    mkdirSync = m.mkdirSync;
    rmSync = m.rmSync;
    hooks = new TmuxHooks(m.deps);
  });

  it('creates session directory with mode 0o700', () => {
    hooks.generateWrapper(validConfig);
    const call = mkdirSync.mock.calls.find(([p]: [string]) => p.endsWith('/task-abc'));
    expect(call).toBeDefined();
    expect(call?.[1]).toMatchObject({ mode: 0o700 });
  });

  it('creates messages subdirectory with mode 0o700', () => {
    hooks.generateWrapper(validConfig);
    const call = mkdirSync.mock.calls.find(([p]: [string]) => p.endsWith('/messages'));
    expect(call).toBeDefined();
    expect(call?.[1]).toMatchObject({ mode: 0o700 });
  });

  it('writes wrapper script with mode 0o700', () => {
    hooks.generateWrapper(validConfig);
    expect(writeFile).toHaveBeenCalledOnce();
    const [, , opts] = writeFile.mock.calls[0] as [string, string, { mode: number }];
    expect(opts.mode).toBe(0o700);
  });

  it('wrapper script is valid bash — contains shebang and set -euo pipefail', () => {
    hooks.generateWrapper(validConfig);
    const [, content] = writeFile.mock.calls[0] as [string, string];
    expect(content).toContain('#!/bin/bash');
    expect(content).toContain('set -euo pipefail');
  });

  // RELIABILITY: rel-pipestatus — set +e must bracket the pipeline so PIPESTATUS
  // is captured even when the agent exits non-zero, ensuring the sentinel is always written.
  it('wrapper disables errexit around the pipeline to ensure PIPESTATUS capture', () => {
    hooks.generateWrapper(validConfig);
    const [, content] = writeFile.mock.calls[0] as [string, string];
    // Use unique markers: the assignment "EXIT_CODE=${PIPESTATUS[0]}" only appears once
    // (the comment also mentions PIPESTATUS[0] but not with the EXIT_CODE= prefix).
    const setPlusEIdx = content.indexOf('set +e');
    const pipelineIdx = content.indexOf('2>&1 | while IFS=');
    const assignmentIdx = content.indexOf('EXIT_CODE=');
    const setMinusEIdx = content.indexOf('\nset -e\n'); // standalone set -e line
    expect(setPlusEIdx).toBeGreaterThan(-1);
    expect(pipelineIdx).toBeGreaterThan(setPlusEIdx);
    expect(assignmentIdx).toBeGreaterThan(pipelineIdx);
    expect(setMinusEIdx).toBeGreaterThan(assignmentIdx);
  });

  it('wrapper script contains the agent command', () => {
    hooks.generateWrapper(validConfig);
    const [, content] = writeFile.mock.calls[0] as [string, string];
    expect(content).toContain('/usr/bin/claude');
  });

  it('wrapper script contains agent args', () => {
    hooks.generateWrapper(validConfig);
    const [, content] = writeFile.mock.calls[0] as [string, string];
    expect(content).toContain('--prompt');
    expect(content).toContain('do stuff');
  });

  it('wrapper captures stdout via while IFS= read -r loop', () => {
    hooks.generateWrapper(validConfig);
    const [, content] = writeFile.mock.calls[0] as [string, string];
    expect(content).toContain('while IFS= read -r line');
  });

  it('wrapper uses flock for atomic sequence numbers', () => {
    hooks.generateWrapper(validConfig);
    const [, content] = writeFile.mock.calls[0] as [string, string];
    expect(content).toContain('flock -x');
  });

  it('wrapper writes JSON atomically via .tmp then mv', () => {
    hooks.generateWrapper(validConfig);
    const [, content] = writeFile.mock.calls[0] as [string, string];
    expect(content).toContain('.tmp');
    expect(content).toContain('mv ');
  });

  it('wrapper JSON contains sequence, timestamp, type, content fields', () => {
    hooks.generateWrapper(validConfig);
    const [, content] = writeFile.mock.calls[0] as [string, string];
    expect(content).toContain('"sequence"');
    expect(content).toContain('"timestamp"');
    expect(content).toContain('"type"');
    expect(content).toContain('"content"');
  });

  it('wrapper writes .done sentinel on exit code 0', () => {
    hooks.generateWrapper(validConfig);
    const [, content] = writeFile.mock.calls[0] as [string, string];
    expect(content).toContain('.done');
  });

  it('wrapper writes .exit sentinel on non-zero exit code', () => {
    hooks.generateWrapper(validConfig);
    const [, content] = writeFile.mock.calls[0] as [string, string];
    expect(content).toContain('.exit');
  });

  it('includes communication block when targets are configured', () => {
    const configWithTargets: WrapperConfig = {
      ...validConfig,
      communicationTargets: ['beat-orchestrator-1', 'beat-orchestrator-2'],
    };
    hooks.generateWrapper(configWithTargets);
    const [, content] = writeFile.mock.calls[0] as [string, string];
    expect(content).toContain('beat-orchestrator-1');
    expect(content).toContain('beat-orchestrator-2');
  });

  // SECURITY: sec-comm-targets — invalid targets must be filtered before script embedding
  it('filters out communication targets that do not match SESSION_NAME_REGEX', () => {
    const configWithBadTargets: WrapperConfig = {
      ...validConfig,
      communicationTargets: ['beat-valid', '$(malicious-cmd)', 'UPPERCASE', 'beat-also-valid'],
    };
    hooks.generateWrapper(configWithBadTargets);
    const [, content] = writeFile.mock.calls[0] as [string, string];
    expect(content).toContain('beat-valid');
    expect(content).toContain('beat-also-valid');
    expect(content).not.toContain('$(malicious-cmd)');
    expect(content).not.toContain('UPPERCASE');
  });

  it('omits communication block entirely when all targets are invalid', () => {
    const configAllInvalid: WrapperConfig = {
      ...validConfig,
      communicationTargets: ['$(evil)', 'invalid_name', ''],
    };
    hooks.generateWrapper(configAllInvalid);
    const [, content] = writeFile.mock.calls[0] as [string, string];
    expect(content).not.toContain('send-keys');
  });

  it('sends to all configured targets in broadcast mode', () => {
    const configWithTargets: WrapperConfig = {
      ...validConfig,
      communicationTargets: ['beat-a', 'beat-b'],
      communicationMode: 'broadcast',
    };
    hooks.generateWrapper(configWithTargets);
    const [, content] = writeFile.mock.calls[0] as [string, string];
    // Both targets should appear as separate send-keys calls
    const matches = [...content.matchAll(/tmux send-keys -t/g)];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('communication block uses tmux send-keys with the payload', () => {
    const configWithTargets: WrapperConfig = {
      ...validConfig,
      communicationTargets: ['beat-receiver'],
    };
    hooks.generateWrapper(configWithTargets);
    const [, content] = writeFile.mock.calls[0] as [string, string];
    expect(content).toContain('send-keys');
    expect(content).toContain('PAYLOAD');
  });

  it('returns manifest with all required paths', () => {
    const result = hooks.generateWrapper(validConfig);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const m = result.value;
    expect(m.wrapperPath).toContain('wrapper.sh');
    expect(m.sentinelPath).toContain('.done');
    expect(m.messagesDir).toContain('messages');
    expect(m.seqFilePath).toContain('.seq');
    expect(m.sessionsDir).toContain('task-abc');
  });

  it('returns TMUX_HOOK_FAILED when writeFile throws', () => {
    writeFile.mockImplementation(() => {
      throw new Error('disk full');
    });
    const result = hooks.generateWrapper(validConfig);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.TMUX_HOOK_FAILED);
  });
});

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
});
