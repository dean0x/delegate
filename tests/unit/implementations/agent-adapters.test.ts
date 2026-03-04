/**
 * Agent Adapter Tests — Claude, Codex, Gemini, Aider
 *
 * ARCHITECTURE: Tests the spawn arguments, environment stripping, and kill
 * behavior for each agent adapter implementation.
 *
 * Pattern: child_process.spawn is mocked to verify args/env without spawning real processes
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'child_process';
import type { Configuration } from '../../../src/core/configuration';
import { ClaudeAdapter } from '../../../src/implementations/claude-adapter';
import { CodexAdapter } from '../../../src/implementations/codex-adapter';
import { GeminiAdapter } from '../../../src/implementations/gemini-adapter';
import { AiderAdapter } from '../../../src/implementations/aider-adapter';

// Mock child_process.spawn
vi.mock('child_process', () => ({
  spawn: vi.fn(),
  ChildProcess: vi.fn(),
}));

import { spawn } from 'child_process';

const mockSpawn = vi.mocked(spawn);

/** Minimal config for adapter construction */
const testConfig: Configuration = {
  maxWorkers: 4,
  maxOutputBuffer: 10485760,
  timeout: 300000,
  killGracePeriodMs: 5000,
  cpuCoresReserved: 1,
  memoryReserve: 536870912,
  logLevel: 'info',
  maxListenersPerEvent: 50,
  maxTotalSubscriptions: 500,
  maxQueueSize: 100,
  spawnThrottleMs: 1000,
  maxEventsPerSecond: 1000,
};

function createMockChildProcess(pid: number): ChildProcess {
  return {
    pid,
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
  } as unknown as ChildProcess;
}

describe('ClaudeAdapter', () => {
  let adapter: ClaudeAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new ClaudeAdapter(testConfig, 'claude');
  });

  afterEach(() => {
    adapter.dispose();
  });

  it('should have provider set to claude', () => {
    expect(adapter.provider).toBe('claude');
  });

  it('should spawn with --print and --dangerously-skip-permissions flags', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    const result = adapter.spawn('test prompt', '/workspace', 'task-1');

    expect(result.ok).toBe(true);
    expect(mockSpawn).toHaveBeenCalledOnce();

    const [command, args] = mockSpawn.mock.calls[0];
    expect(command).toBe('claude');
    expect(args).toContain('--print');
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).toContain('--output-format');
    expect(args).toContain('json');
  });

  it('should strip CLAUDECODE and CLAUDE_CODE_ env vars', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    // Set env vars that should be stripped
    const originalEnv = { ...process.env };
    process.env.CLAUDECODE = 'true';
    process.env.CLAUDE_CODE_SESSION = 'test';

    try {
      adapter.spawn('test prompt', '/workspace');

      const spawnOptions = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
      expect(spawnOptions.env.CLAUDECODE).toBeUndefined();
      expect(spawnOptions.env.CLAUDE_CODE_SESSION).toBeUndefined();
      expect(spawnOptions.env.BACKBEAT_WORKER).toBe('true');
    } finally {
      // Restore env
      delete process.env.CLAUDECODE;
      delete process.env.CLAUDE_CODE_SESSION;
    }
  });

  it('should set BACKBEAT_TASK_ID when taskId provided', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    adapter.spawn('test prompt', '/workspace', 'task-123');

    const spawnOptions = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
    expect(spawnOptions.env.BACKBEAT_TASK_ID).toBe('task-123');
  });

  it('should return error when process has no PID', () => {
    const mockChild = createMockChildProcess(0);
    (mockChild as { pid: number | undefined }).pid = undefined;
    mockSpawn.mockReturnValue(mockChild);

    const result = adapter.spawn('test prompt', '/workspace');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Failed to get process PID');
    }
  });

  it('should return error when spawn throws', () => {
    mockSpawn.mockImplementation(() => {
      throw new Error('spawn ENOENT');
    });

    const result = adapter.spawn('test prompt', '/workspace');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('spawn ENOENT');
    }
  });
});

describe('CodexAdapter', () => {
  let adapter: CodexAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new CodexAdapter(testConfig, 'codex');
  });

  afterEach(() => {
    adapter.dispose();
  });

  it('should have provider set to codex', () => {
    expect(adapter.provider).toBe('codex');
  });

  it('should spawn with --quiet and --full-auto flags', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    const result = adapter.spawn('test prompt', '/workspace');

    expect(result.ok).toBe(true);
    const [command, args] = mockSpawn.mock.calls[0];
    expect(command).toBe('codex');
    expect(args).toContain('--quiet');
    expect(args).toContain('--full-auto');
    expect(args).toContain('test prompt');
  });

  it('should strip CODEX_ env vars', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    process.env.CODEX_SESSION = 'test';
    try {
      adapter.spawn('test prompt', '/workspace');

      const spawnOptions = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
      expect(spawnOptions.env.CODEX_SESSION).toBeUndefined();
      expect(spawnOptions.env.BACKBEAT_WORKER).toBe('true');
    } finally {
      delete process.env.CODEX_SESSION;
    }
  });
});

describe('GeminiAdapter', () => {
  let adapter: GeminiAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new GeminiAdapter(testConfig, 'gemini');
  });

  afterEach(() => {
    adapter.dispose();
  });

  it('should have provider set to gemini', () => {
    expect(adapter.provider).toBe('gemini');
  });

  it('should spawn with -sandbox false flag', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    const result = adapter.spawn('test prompt', '/workspace');

    expect(result.ok).toBe(true);
    const [command, args] = mockSpawn.mock.calls[0];
    expect(command).toBe('gemini');
    expect(args).toContain('-sandbox');
    expect(args).toContain('false');
    expect(args).toContain('test prompt');
  });

  it('should strip GEMINI_ env vars', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    process.env.GEMINI_API_KEY = 'secret';
    try {
      adapter.spawn('test prompt', '/workspace');

      const spawnOptions = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
      expect(spawnOptions.env.GEMINI_API_KEY).toBeUndefined();
      expect(spawnOptions.env.BACKBEAT_WORKER).toBe('true');
    } finally {
      delete process.env.GEMINI_API_KEY;
    }
  });
});

describe('AiderAdapter', () => {
  let adapter: AiderAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new AiderAdapter(testConfig, 'aider');
  });

  afterEach(() => {
    adapter.dispose();
  });

  it('should have provider set to aider', () => {
    expect(adapter.provider).toBe('aider');
  });

  it('should spawn with --yes-always, --no-git, and --message flags', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    const result = adapter.spawn('test prompt', '/workspace');

    expect(result.ok).toBe(true);
    const [command, args] = mockSpawn.mock.calls[0];
    expect(command).toBe('aider');
    expect(args).toContain('--yes-always');
    expect(args).toContain('--no-git');
    expect(args).toContain('--message');
    expect(args).toContain('test prompt');
  });

  it('should strip AIDER_ env vars', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    process.env.AIDER_MODEL = 'gpt-4';
    try {
      adapter.spawn('test prompt', '/workspace');

      const spawnOptions = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
      expect(spawnOptions.env.AIDER_MODEL).toBeUndefined();
      expect(spawnOptions.env.BACKBEAT_WORKER).toBe('true');
    } finally {
      delete process.env.AIDER_MODEL;
    }
  });

  it('should pass prompt via --message flag not as positional arg', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    adapter.spawn('analyze codebase', '/workspace');

    const args = mockSpawn.mock.calls[0][1] as string[];
    const messageIdx = args.indexOf('--message');
    expect(messageIdx).toBeGreaterThan(-1);
    expect(args[messageIdx + 1]).toBe('analyze codebase');
  });
});
