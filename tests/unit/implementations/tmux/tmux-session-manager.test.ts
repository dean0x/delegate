/**
 * Unit tests for TmuxSessionManager
 * All tmux commands are intercepted via injected ExecFn — no real tmux required.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../../../../src/core/errors.js';
import { DefaultTmuxSessionManager } from '../../../../src/implementations/tmux/tmux-session-manager.js';
import type { ExecFn, ExecResult } from '../../../../src/implementations/tmux/types.js';

/** Build an exec mock that returns the given result for any command */
function mockExec(result: Partial<ExecResult>): ExecFn {
  return vi.fn().mockReturnValue({ stdout: '', stderr: '', status: 0, ...result } satisfies ExecResult);
}

/** Build a session-list exec that simulates N active beat-* sessions */
function listSessionsExec(count: number, otherCalls: Partial<ExecResult> = {}): ExecFn {
  let callCount = 0;
  return vi.fn().mockImplementation((cmd: string) => {
    callCount++;
    if (cmd.includes('list-sessions')) {
      const lines = Array.from({ length: count }, (_, i) => `beat-task-${i}:${Date.now()}:0:220:50`).join('\n');
      return { stdout: lines, stderr: '', status: count === 0 ? 1 : 0 };
    }
    return { stdout: '', stderr: '', status: 0, ...otherCalls };
  });
}

const validConfig = {
  name: 'beat-task-123',
  command: 'echo hello',
  cwd: '/tmp',
};

describe('TmuxSessionManager', () => {
  let exec: ReturnType<typeof vi.fn>;
  let manager: DefaultTmuxSessionManager;

  beforeEach(() => {
    exec = vi.fn().mockReturnValue({ stdout: '', stderr: '', status: 0 } satisfies ExecResult);
    manager = new DefaultTmuxSessionManager({ exec: exec as ExecFn });
  });

  // ─── createSession ───────────────────────────────────────────────────────────

  it('creates session with correct tmux new-session arguments', () => {
    manager.createSession({ ...validConfig, width: 220, height: 50 });
    const calls: string[] = exec.mock.calls.map((c: [string]) => c[0]);
    const newSession = calls.find((c) => c.includes('new-session'));
    expect(newSession).toBeDefined();
    expect(newSession).toContain('new-session -d -s beat-task-123');
    expect(newSession).toContain('-x 220 -y 50');
    expect(newSession).toContain('echo hello');
    // cwd must be passed via -c flag
    expect(newSession).toContain("-c '/tmp'");
  });

  it('includes -c flag when cwd is specified', () => {
    manager.createSession({ ...validConfig, cwd: '/home/user/project' });
    const calls: string[] = exec.mock.calls.map((c: [string]) => c[0]);
    const newSession = calls.find((c) => c.includes('new-session'));
    expect(newSession).toContain("-c '/home/user/project'");
  });

  it('omits -c flag when cwd is not specified', () => {
    const { cwd: _cwd, ...configWithoutCwd } = validConfig;
    manager.createSession(configWithoutCwd);
    const calls: string[] = exec.mock.calls.map((c: [string]) => c[0]);
    const newSession = calls.find((c) => c.includes('new-session'));
    expect(newSession).not.toContain('-c ');
  });

  it('rejects session names that lack the beat- prefix', () => {
    const result = manager.createSession({ ...validConfig, name: 'my-session' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.TMUX_SESSION_FAILED);
  });

  it('injects environment variables via tmux set-environment', () => {
    manager.createSession({
      ...validConfig,
      env: { MY_VAR: 'hello' },
    });
    const calls: string[] = exec.mock.calls.map((c: [string]) => c[0]);
    const envCalls = calls.filter((c) => c.includes('set-environment'));
    expect(envCalls.some((c) => c.includes('MY_VAR'))).toBe(true);
  });

  it('auto-injects AUTOBEAT_TASK_ID and AUTOBEAT_SPAWN_TIME without caller specifying them', () => {
    // No env provided — auto vars must still be set
    manager.createSession(validConfig);
    const calls: string[] = exec.mock.calls.map((c: [string]) => c[0]);
    const envCalls = calls.filter((c) => c.includes('set-environment'));
    expect(envCalls.some((c) => c.includes('AUTOBEAT_TASK_ID'))).toBe(true);
    expect(envCalls.some((c) => c.includes('AUTOBEAT_SPAWN_TIME'))).toBe(true);
    // AUTOBEAT_TASK_ID value should be the task id (strip beat- prefix)
    const taskIdCall = envCalls.find((c) => c.includes('AUTOBEAT_TASK_ID'));
    expect(taskIdCall).toContain('task-123');
    // AUTOBEAT_SPAWN_TIME value should be an ISO timestamp
    const spawnTimeCall = envCalls.find((c) => c.includes('AUTOBEAT_SPAWN_TIME'));
    expect(spawnTimeCall).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('uses custom dimensions when width/height are provided', () => {
    manager.createSession({ ...validConfig, width: 200, height: 50 });
    const calls: string[] = exec.mock.calls.map((c: [string]) => c[0]);
    const newSession = calls.find((c) => c.includes('new-session'));
    expect(newSession).toContain('-x 200 -y 50');
  });

  it('rejects zero, negative, and non-integer dimensions', () => {
    // Zero width
    const zeroWidth = manager.createSession({ ...validConfig, width: 0, height: 50 });
    expect(zeroWidth.ok).toBe(false);
    if (zeroWidth.ok) return;
    expect(zeroWidth.error.code).toBe(ErrorCode.TMUX_SESSION_FAILED);
    expect(zeroWidth.error.message).toContain('Invalid dimensions');

    // Negative height
    const negHeight = manager.createSession({ ...validConfig, width: 220, height: -1 });
    expect(negHeight.ok).toBe(false);
    if (negHeight.ok) return;
    expect(negHeight.error.code).toBe(ErrorCode.TMUX_SESSION_FAILED);
    expect(negHeight.error.message).toContain('Invalid dimensions');

    // Non-integer width (float)
    const floatWidth = manager.createSession({ ...validConfig, width: 1.5, height: 50 });
    expect(floatWidth.ok).toBe(false);
    if (floatWidth.ok) return;
    expect(floatWidth.error.code).toBe(ErrorCode.TMUX_SESSION_FAILED);
    expect(floatWidth.error.message).toContain('Invalid dimensions');
  });

  it('injectEnvironment silently skips invalid POSIX keys and only injects valid ones', () => {
    manager.createSession({
      ...validConfig,
      env: {
        VALID_KEY: 'yes',
        '123-BAD': 'skip-me',
        'my.key': 'also-skip',
        _UNDERSCORE_LEAD: 'also-valid',
      },
    });
    const calls: string[] = exec.mock.calls.map((c: [string]) => c[0]);
    const envCalls = calls.filter((c) => c.includes('set-environment'));
    // All env commands are batched into one call — join them for assertion
    const envStr = envCalls.join(' ');
    // Valid keys must appear
    expect(envStr).toContain('VALID_KEY');
    expect(envStr).toContain('_UNDERSCORE_LEAD');
    // Invalid keys must be absent
    expect(envStr).not.toContain('123-BAD');
    expect(envStr).not.toContain('my.key');
  });

  it('enforces concurrent session limit when max sessions are active', () => {
    const limitedManager = new DefaultTmuxSessionManager({
      exec: listSessionsExec(20) as ExecFn,
      maxConcurrentSessions: 20,
    });
    const result = limitedManager.createSession(validConfig);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.TMUX_SESSION_FAILED);
    expect(result.error.message).toContain('limit');
  });

  it('returns TMUX_SESSION_FAILED when exec fails (status 1)', () => {
    exec.mockReturnValue({ stdout: '', stderr: 'duplicate session', status: 1 });
    const result = manager.createSession(validConfig);
    // The first exec is list-sessions which succeeds; second fails
    // We need list to succeed and new-session to fail
    const failManager = new DefaultTmuxSessionManager({
      exec: vi.fn().mockImplementation((cmd: string) => {
        if (cmd.includes('list-sessions')) return { stdout: '', stderr: "can't find session", status: 1 };
        return { stdout: '', stderr: 'duplicate session: beat-task-123', status: 1 };
      }) as ExecFn,
    });
    const failResult = failManager.createSession(validConfig);
    expect(failResult.ok).toBe(false);
    if (failResult.ok) return;
    expect(failResult.error.code).toBe(ErrorCode.TMUX_SESSION_FAILED);
  });

  // ─── destroySession ──────────────────────────────────────────────────────────

  it('destroys session with correct kill-session command', () => {
    manager.destroySession('beat-task-123');
    const calls: string[] = exec.mock.calls.map((c: [string]) => c[0]);
    expect(calls.some((c) => c.includes('kill-session -t beat-task-123'))).toBe(true);
  });

  it('rejects non-beat- session names in destroySession', () => {
    const result = manager.destroySession('other-session');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.TMUX_SESSION_FAILED);
  });

  it('destroySession is idempotent — "session not found" returns ok', () => {
    exec.mockReturnValue({
      stdout: '',
      stderr: "can't find session: beat-task-123",
      status: 1,
    });
    const result = manager.destroySession('beat-task-123');
    expect(result.ok).toBe(true);
  });

  // B6: destroySession error path — non-idempotent failure returns TMUX_SESSION_FAILED
  it('destroySession returns TMUX_SESSION_FAILED when exec fails with an unrecognized error', () => {
    exec.mockReturnValue({
      stdout: '',
      stderr: 'server exited unexpectedly',
      status: 1,
    });
    const result = manager.destroySession('beat-task-123');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.TMUX_SESSION_FAILED);
  });

  it('rejects cwd containing a single quote (unsafe path — SAFE_PATH_REGEX)', () => {
    // A path with a single quote is unsafe for shell embedding.
    // SAFE_PATH_REGEX rejects it before the command is constructed.
    const result = manager.createSession({ ...validConfig, cwd: "/home/user/it's a path" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.TMUX_SESSION_FAILED);
    // No tmux new-session command must have been spawned
    const calls: string[] = exec.mock.calls.map((c: [string]) => c[0]);
    expect(calls.find((c) => c.includes('new-session'))).toBeUndefined();
  });

  it('rejects cwd containing path traversal sequence (SAFE_PATH_REGEX)', () => {
    const result = manager.createSession({ ...validConfig, cwd: '/tmp/../etc/passwd' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.TMUX_SESSION_FAILED);
    const calls: string[] = exec.mock.calls.map((c: [string]) => c[0]);
    expect(calls.find((c) => c.includes('new-session'))).toBeUndefined();
  });

  // ─── sendKeys ────────────────────────────────────────────────────────────────

  it('sendKeys uses -l (literal mode) flag', () => {
    manager.sendKeys('beat-task-123', 'hello world');
    const calls: string[] = exec.mock.calls.map((c: [string]) => c[0]);
    const sendKeys = calls.find((c) => c.includes('send-keys'));
    expect(sendKeys).toContain('-l');
  });

  it('sendKeys passes $, backticks through literally and only escapes single quotes', () => {
    manager.sendKeys('beat-task-123', "say $USER `whoami` it's");
    const calls: string[] = exec.mock.calls.map((c: [string]) => c[0]);
    const sendKeys = calls.find((c) => c.includes('send-keys'));
    expect(sendKeys).toBeDefined();
    expect(sendKeys).toContain('-l');
    // $ and backticks must pass through literally (no backslash prefix)
    expect(sendKeys).toContain('$USER');
    expect(sendKeys).toContain('`whoami`');
    // Single quote must be escaped as '\'' (break out, escaped quote, re-enter)
    expect(sendKeys).toContain("'\\''");
  });

  it('sendKeys passes backslashes through literally (no doubling)', () => {
    manager.sendKeys('beat-task-123', 'path\\to\\file');
    const calls: string[] = exec.mock.calls.map((c: [string]) => c[0]);
    const sendKeys = calls.find((c) => c.includes('send-keys'));
    expect(sendKeys).toContain('path\\to\\file');
    expect(sendKeys).not.toContain('path\\\\to\\\\file');
  });

  it('createSession with $ in command embeds it literally in single quotes', () => {
    manager.createSession({ ...validConfig, command: 'echo $HOME' });
    const calls: string[] = exec.mock.calls.map((c: [string]) => c[0]);
    const newSession = calls.find((c) => c.includes('new-session'));
    expect(newSession).toContain("'echo $HOME'");
    expect(newSession).not.toContain('\\$');
  });

  it('returns TMUX_SEND_KEYS_FAILED when exec fails', () => {
    exec.mockReturnValue({ stdout: '', stderr: 'no such session', status: 1 });
    const result = manager.sendKeys('beat-task-123', 'hello');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.TMUX_SEND_KEYS_FAILED);
  });

  it('sendKeys rejects invalid session names', () => {
    const result = manager.sendKeys('../../etc/passwd', 'hello');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.TMUX_SESSION_FAILED);
  });

  // ─── isAlive ─────────────────────────────────────────────────────────────────

  it('isAlive returns ok(true) when has-session exits 0', () => {
    exec.mockReturnValue({ stdout: '', stderr: '', status: 0 });
    const result = manager.isAlive('beat-task-123');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(true);
  });

  it('isAlive returns ok(false) when has-session exits non-zero', () => {
    exec.mockReturnValue({ stdout: '', stderr: 'no session', status: 1 });
    const result = manager.isAlive('beat-task-123');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(false);
  });

  it('isAlive rejects invalid session names', () => {
    const result = manager.isAlive('evil; rm -rf /');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.TMUX_SESSION_FAILED);
  });

  // ─── listSessions ─────────────────────────────────────────────────────────────

  it('listSessions parses the tmux list-sessions output format correctly', () => {
    exec.mockReturnValue({
      stdout: 'beat-task-abc:1700000000:0:220:50\nbeat-task-def:1700000001:1:200:40\n',
      stderr: '',
      status: 0,
    });
    const result = manager.listSessions();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2);
    expect(result.value[0]).toEqual({
      name: 'beat-task-abc',
      created: 1700000000,
      attached: false,
      width: 220,
      height: 50,
    });
    expect(result.value[1]?.attached).toBe(true);
  });

  it('listSessions filters out non-beat-* sessions', () => {
    exec.mockReturnValue({
      stdout: 'beat-task-abc:1700000000:0:220:50\nother-session:1700000001:0:80:24\n',
      stderr: '',
      status: 0,
    });
    const result = manager.listSessions();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.name).toBe('beat-task-abc');
  });

  // B3: malformed lines mixed with valid lines
  it('listSessions skips malformed lines (fewer than 5 colon-separated parts)', () => {
    exec.mockReturnValue({
      // Line 1: valid; Line 2: malformed (only 3 parts); Line 3: valid
      stdout: 'beat-task-abc:1700000000:0:220:50\nbeat-malformed:bad\nbeat-task-def:1700000001:1:200:40\n',
      stderr: '',
      status: 0,
    });
    const result = manager.listSessions();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only the two valid lines should appear; the malformed line is silently skipped
    expect(result.value).toHaveLength(2);
    expect(result.value.map((s) => s.name)).toEqual(['beat-task-abc', 'beat-task-def']);
  });

  it('listSessions returns ok([]) when no sessions exist', () => {
    exec.mockReturnValue({
      stdout: '',
      stderr: 'no server running',
      status: 1,
    });
    const result = manager.listSessions();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(0);
  });

  // ─── getSessionEnvironment ────────────────────────────────────────────────────

  it('getSessionEnvironment parses "KEY=value" output', () => {
    exec.mockReturnValue({
      stdout: 'MY_VAR=hello-world',
      stderr: '',
      status: 0,
    });
    const result = manager.getSessionEnvironment('beat-task-123', 'MY_VAR');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe('hello-world');
  });

  it('getSessionEnvironment returns ok(undefined) when variable is missing (status 1)', () => {
    exec.mockReturnValue({ stdout: '', stderr: 'unknown variable', status: 1 });
    const result = manager.getSessionEnvironment('beat-task-123', 'NONEXISTENT');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeUndefined();
  });

  it('getSessionEnvironment rejects invalid session names', () => {
    const result = manager.getSessionEnvironment('bad session name', 'MY_VAR');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.TMUX_SESSION_FAILED);
  });

  it('getSessionEnvironment rejects invalid env var names', () => {
    const result = manager.getSessionEnvironment('beat-task-123', '$(echo injected)');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.TMUX_SESSION_FAILED);
  });

  it('getSessionEnvironment correctly parses values that contain "=" characters', () => {
    // show-environment output: "MY_VAR=abc=def==" — only the first "=" is the key/value separator
    exec.mockReturnValue({
      stdout: 'MY_VAR=abc=def==',
      stderr: '',
      status: 0,
    });
    const result = manager.getSessionEnvironment('beat-task-123', 'MY_VAR');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Full value after the first "=" must be returned, preserving subsequent "=" characters
    expect(result.value).toBe('abc=def==');
  });
});
