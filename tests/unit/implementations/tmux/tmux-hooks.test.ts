/**
 * Unit tests for TmuxHooks
 * All filesystem operations are intercepted via injected dependencies.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../../../../src/core/errors.js';
import { TmuxHooks, type TmuxHooksDeps } from '../../../../src/implementations/tmux/tmux-hooks.js';
import type { SetupShimConfig, WrapperConfig } from '../../../../src/implementations/tmux/types.js';

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

  it('wrapper uses defensive EXIT_CODE quoting with default value', () => {
    hooks.generateWrapper(validConfig);
    const [, content] = writeFile.mock.calls[0] as [string, string];
    expect(content).toContain('EXIT_CODE="${PIPESTATUS[0]:-1}"');
    expect(content).toContain('[ "$EXIT_CODE" -eq 0 ]');
    expect(content).toContain('exit "$EXIT_CODE"');
  });

  it('wrapper script contains the agent command', () => {
    hooks.generateWrapper(validConfig);
    const [, content] = writeFile.mock.calls[0] as [string, string];
    expect(content).toContain('/usr/bin/claude');
  });

  it('wrapper script contains agent args single-quoted', () => {
    hooks.generateWrapper(validConfig);
    const [, content] = writeFile.mock.calls[0] as [string, string];
    // Each arg is individually single-quoted for shell safety
    expect(content).toContain("'--prompt'");
    expect(content).toContain("'do stuff'");
  });

  it('wrapper captures stdout via while IFS= read -r loop', () => {
    hooks.generateWrapper(validConfig);
    const [, content] = writeFile.mock.calls[0] as [string, string];
    expect(content).toContain('while IFS= read -r line');
  });

  // DESIGN DECISION: flock is intentionally absent. The wrapper is a single pipeline
  // (one writer), so no concurrent callers exist. flock is also unavailable on macOS
  // without Homebrew, making it a portability hazard with no safety benefit here.
  // The decision is documented in the NEXT_SEQ_FN JSDoc in tmux-hooks.ts, not embedded
  // in the generated script.
  it('wrapper uses simple cat/increment/echo for next_seq (no flock)', () => {
    hooks.generateWrapper(validConfig);
    const [, content] = writeFile.mock.calls[0] as [string, string];
    expect(content).not.toContain('flock -x');
    // next_seq reads SEQ_FILE with cat, increments, writes back, and prints the value
    expect(content).toContain('SEQ=$(cat "$SEQ_FILE"');
    expect(content).toContain('SEQ=$((SEQ + 1))');
    expect(content).toContain('echo $SEQ > "$SEQ_FILE"');
    expect(content).toContain('printf "%05d" $SEQ');
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
    // Both targets should appear as separate load-buffer/paste-buffer blocks
    const loadMatches = [...content.matchAll(/tmux load-buffer/g)];
    expect(loadMatches.length).toBeGreaterThanOrEqual(2);
    const pasteMatches = [...content.matchAll(/tmux paste-buffer/g)];
    expect(pasteMatches.length).toBeGreaterThanOrEqual(2);
    expect(content).toContain('beat-a');
    expect(content).toContain('beat-b');
  });

  // SECURITY: Communication uses load-buffer/paste-buffer to avoid shell variable
  // expansion. A $PAYLOAD variable approach would allow agent output containing $()
  // or backticks to be interpreted by the shell before tmux sees them.
  it('communication block uses tmux load-buffer and paste-buffer (not send-keys) to forward payload', () => {
    const configWithTargets: WrapperConfig = {
      ...validConfig,
      communicationTargets: ['beat-receiver'],
    };
    hooks.generateWrapper(configWithTargets);
    const [, content] = writeFile.mock.calls[0] as [string, string];
    expect(content).toContain('tmux load-buffer');
    expect(content).toContain('tmux paste-buffer');
    expect(content).toContain('tmux delete-buffer');
    // The content is piped directly — no $PAYLOAD variable expansion risk
    expect(content).not.toContain('send-keys -l "$PAYLOAD"');
    expect(content).toContain('beat-receiver');
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
    expect(m.sessionDir).toContain('task-abc');
  });

  // SECURITY: P0-7 — taskId must be validated before flowing into path.join and the wrapper script
  it('returns TMUX_HOOK_FAILED for taskId containing shell metacharacters', () => {
    const result = hooks.generateWrapper({ ...validConfig, taskId: '$(evil)' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.TMUX_HOOK_FAILED);
  });

  it('returns TMUX_HOOK_FAILED for taskId containing path traversal', () => {
    const result = hooks.generateWrapper({ ...validConfig, taskId: '../../etc/passwd' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.TMUX_HOOK_FAILED);
  });

  it('returns TMUX_HOOK_FAILED for taskId with uppercase characters', () => {
    const result = hooks.generateWrapper({ ...validConfig, taskId: 'Task-ABC' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.TMUX_HOOK_FAILED);
  });

  it('accepts valid taskId with alphanumeric hyphens and underscores', () => {
    const result = hooks.generateWrapper({ ...validConfig, taskId: 'task-abc123_ok' });
    expect(result.ok).toBe(true);
  });

  // SECURITY: P0-6 — sessionsDir must be validated before embedding in the wrapper script
  it('returns TMUX_HOOK_FAILED for sessionsDir containing single quotes', () => {
    const result = hooks.generateWrapper({ ...validConfig, sessionsDir: "/tmp/ses'sions" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.TMUX_HOOK_FAILED);
  });

  it('returns TMUX_HOOK_FAILED for sessionsDir containing shell metacharacters', () => {
    const result = hooks.generateWrapper({ ...validConfig, sessionsDir: '/tmp/$(evil)' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.TMUX_HOOK_FAILED);
  });

  // SECURITY: P0-6 — SESSIONS_DIR must use single quotes to prevent interpolation
  it('wrapper script embeds session directory in single quotes', () => {
    hooks.generateWrapper(validConfig);
    const [, content] = writeFile.mock.calls[0] as [string, string];
    expect(content).toContain("SESSIONS_DIR='/tmp/sessions/task-abc'");
  });

  // SECURITY: Issue 1 — agentCommand must be validated before embedding in the wrapper script
  it('returns TMUX_HOOK_FAILED for agentCommand containing shell metacharacters', () => {
    const result = hooks.generateWrapper({ ...validConfig, agentCommand: '/usr/bin/claude;rm -rf /' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.TMUX_HOOK_FAILED);
  });

  it('returns TMUX_HOOK_FAILED for agentCommand containing path traversal', () => {
    const result = hooks.generateWrapper({ ...validConfig, agentCommand: '/usr/../bin/claude' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.TMUX_HOOK_FAILED);
  });

  it('returns TMUX_HOOK_FAILED for agentCommand with single quote injection', () => {
    const result = hooks.generateWrapper({ ...validConfig, agentCommand: "/usr/bin/claude'injected" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.TMUX_HOOK_FAILED);
  });

  it('accepts valid agentCommand as an absolute path', () => {
    const result = hooks.generateWrapper({ ...validConfig, agentCommand: '/usr/local/bin/claude' });
    expect(result.ok).toBe(true);
  });

  // SECURITY: Issue 2 — agentArgs must be individually single-quoted
  it('wrapper script single-quotes args containing spaces', () => {
    hooks.generateWrapper({ ...validConfig, agentArgs: ['--system', 'do the thing'] });
    const [, content] = writeFile.mock.calls[0] as [string, string];
    expect(content).toContain("'do the thing'");
  });

  it('wrapper script escapes single quotes inside args using the end-quote technique', () => {
    // Arg "it's" must become 'it'\''s' in the script
    hooks.generateWrapper({ ...validConfig, agentArgs: ["it's"] });
    const [, content] = writeFile.mock.calls[0] as [string, string];
    expect(content).toContain("'it'\\''s'");
  });

  it('wrapper script single-quotes args containing dollar signs', () => {
    hooks.generateWrapper({ ...validConfig, agentArgs: ['--env', '$SECRET'] });
    const [, content] = writeFile.mock.calls[0] as [string, string];
    expect(content).toContain("'$SECRET'");
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

describe('TmuxHooks — wrapper script jq handling', () => {
  it('does not contain printf fallback pattern', () => {
    const { deps, writeFile } = makeDeps();
    const hooks = new TmuxHooks(deps);
    hooks.generateWrapper(validConfig);
    const [, content] = writeFile.mock.calls[0] as [string, string];
    expect(content).not.toContain('printf \'%"');
    expect(content).not.toContain('|| printf');
  });

  it('contains command -v jq defense-in-depth guard', () => {
    const { deps, writeFile } = makeDeps();
    const hooks = new TmuxHooks(deps);
    hooks.generateWrapper(validConfig);
    const [, content] = writeFile.mock.calls[0] as [string, string];
    expect(content).toContain('command -v jq');
    expect(content).toContain('exit 127');
  });

  it('uses jq -Rs . for escaping without fallback', () => {
    const { deps, writeFile } = makeDeps();
    const hooks = new TmuxHooks(deps);
    hooks.generateWrapper(validConfig);
    const [, content] = writeFile.mock.calls[0] as [string, string];
    expect(content).toContain('jq -Rs .');
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
