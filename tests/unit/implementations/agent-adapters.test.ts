/**
 * Agent Adapter Tests — Claude, Codex, Gemini
 *
 * ARCHITECTURE: Tests the spawn arguments, environment stripping, kill
 * behavior, and pre-spawn auth validation for each agent adapter.
 *
 * Pattern: child_process.spawn is mocked to verify args/env without spawning real processes
 */

import type { ChildProcess } from 'child_process';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Configuration } from '../../../src/core/configuration';
import { _testSetConfigDir, saveAgentConfig } from '../../../src/core/configuration';
import { ErrorCode } from '../../../src/core/errors';
import { ClaudeAdapter } from '../../../src/implementations/claude-adapter';
import { CodexAdapter } from '../../../src/implementations/codex-adapter';
import { GeminiAdapter } from '../../../src/implementations/gemini-adapter';

// Mock child_process.spawn
vi.mock('child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  ChildProcess: vi.fn(),
}));

// Mock isCommandInPath from agents.ts (used by resolveAuth in base-agent-adapter)
vi.mock('../../../src/core/agents', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/core/agents')>();
  return {
    ...original,
    isCommandInPath: vi.fn().mockReturnValue(true), // Default: CLI found
  };
});

import { spawn } from 'child_process';
import { isCommandInPath } from '../../../src/core/agents';

const mockIsCommandInPath = vi.mocked(isCommandInPath);

const mockSpawn = vi.mocked(spawn);

/** Minimal config for adapter construction */
const testConfig: Configuration = {
  maxOutputBuffer: 10485760,
  timeout: 300000,
  killGracePeriodMs: 5000,
  cpuCoresReserved: 1,
  memoryReserve: 536870912,
  logLevel: 'info',
  maxListenersPerEvent: 50,
  maxTotalSubscriptions: 500,
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
    // Default: CLI found in PATH (auth passes)
    mockIsCommandInPath.mockReturnValue(true);
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
    mockIsCommandInPath.mockReturnValue(true);
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

  it('should preserve CODEX_ env vars (no known nesting indicators)', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    process.env.CODEX_SESSION = 'test';
    try {
      adapter.spawn('test prompt', '/workspace');

      const spawnOptions = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
      expect(spawnOptions.env.CODEX_SESSION).toBe('test');
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
    mockIsCommandInPath.mockReturnValue(true);
    adapter = new GeminiAdapter(testConfig, 'gemini');
  });

  afterEach(() => {
    adapter.dispose();
  });

  it('should have provider set to gemini', () => {
    expect(adapter.provider).toBe('gemini');
  });

  it('should spawn with --yolo --prompt flags for non-interactive auto-accept mode', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    const result = adapter.spawn('test prompt', '/workspace');

    expect(result.ok).toBe(true);
    const [command, args] = mockSpawn.mock.calls[0];
    expect(command).toBe('gemini');
    expect(args).toContain('--yolo');
    expect(args).toContain('--prompt');
    expect(args).toContain('test prompt');
  });

  it('should preserve GEMINI_ env vars including API key (no known nesting indicators)', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    process.env.GEMINI_API_KEY = 'secret';
    try {
      adapter.spawn('test prompt', '/workspace');

      const spawnOptions = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
      expect(spawnOptions.env.GEMINI_API_KEY).toBe('secret');
      expect(spawnOptions.env.BACKBEAT_WORKER).toBe('true');
    } finally {
      delete process.env.GEMINI_API_KEY;
    }
  });
});

// ============================================================================
// BaseAgentAdapter kill/dispose Tests
// ============================================================================

describe('BaseAgentAdapter kill', () => {
  let adapter: ClaudeAdapter;
  let processKillSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockIsCommandInPath.mockReturnValue(true);
    adapter = new ClaudeAdapter(testConfig, 'claude');
    processKillSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as never);
  });

  afterEach(() => {
    adapter.dispose();
    processKillSpy.mockRestore();
    vi.useRealTimers();
  });

  it('should send SIGTERM to the process', () => {
    const result = adapter.kill(1234);

    expect(result.ok).toBe(true);
    expect(processKillSpy).toHaveBeenCalledWith(1234, 'SIGTERM');
  });

  it('should escalate to SIGKILL after killGracePeriodMs', () => {
    adapter.kill(1234);

    // Advance past grace period (5000ms from testConfig)
    vi.advanceTimersByTime(testConfig.killGracePeriodMs);

    expect(processKillSpy).toHaveBeenCalledWith(1234, 'SIGKILL');
  });

  it('should return PROCESS_KILL_FAILED when process.kill throws', () => {
    processKillSpy.mockImplementation((() => {
      throw new Error('ESRCH: No such process');
    }) as never);

    const result = adapter.kill(1234);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.PROCESS_KILL_FAILED);
    }
  });

  it('should clear pending kill timeouts on dispose', () => {
    adapter.kill(1234);

    // Dispose before grace period expires
    adapter.dispose();

    // Advance past grace period
    vi.advanceTimersByTime(testConfig.killGracePeriodMs);

    // SIGKILL should NOT have been sent (dispose cleared the timeout)
    expect(processKillSpy).not.toHaveBeenCalledWith(1234, 'SIGKILL');
  });

  it('should clear previous pending SIGKILL timeout before setting new one', () => {
    // First kill
    adapter.kill(1234);

    // Second kill of same pid (clears previous timeout, sets new one)
    adapter.kill(1234);

    // Advance past grace period once
    vi.advanceTimersByTime(testConfig.killGracePeriodMs);

    // SIGKILL should only be sent once (not twice from two pending timeouts)
    const sigkillCalls = processKillSpy.mock.calls.filter((call) => call[0] === 1234 && call[1] === 'SIGKILL');
    expect(sigkillCalls).toHaveLength(1);
  });
});

// ============================================================================
// GeminiAdapter env Tests
// ============================================================================

describe('GeminiAdapter env', () => {
  let adapter: GeminiAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsCommandInPath.mockReturnValue(true);
    adapter = new GeminiAdapter(testConfig, 'gemini');
  });

  afterEach(() => {
    adapter.dispose();
  });

  it('should set GEMINI_SANDBOX=false in spawn env', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    adapter.spawn('test prompt', '/workspace');

    const spawnOptions = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
    expect(spawnOptions.env.GEMINI_SANDBOX).toBe('false');
  });

  it("should allow user's GEMINI_SANDBOX=true to override adapter default", () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    process.env.GEMINI_SANDBOX = 'true';
    try {
      adapter.spawn('test prompt', '/workspace');

      const spawnOptions = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
      // User's env (cleanEnv) spreads after additionalEnv, so user wins
      expect(spawnOptions.env.GEMINI_SANDBOX).toBe('true');
    } finally {
      delete process.env.GEMINI_SANDBOX;
    }
  });
});

// ============================================================================
// Pre-Spawn Auth Validation Tests
// ============================================================================

describe('Pre-spawn auth validation', () => {
  let testDir: string;
  let restoreConfig: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    testDir = path.join(tmpdir(), `backbeat-adapter-auth-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    restoreConfig = _testSetConfigDir(testDir);
  });

  afterEach(() => {
    restoreConfig();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should fail spawn when CLI not in PATH', () => {
    // CLI not found — pre-spawn binary check fails before auth
    mockIsCommandInPath.mockReturnValue(false);

    const adapter = new CodexAdapter(testConfig, 'codex');
    const result = adapter.spawn('test prompt', '/workspace');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.AGENT_MISCONFIGURED);
      expect(result.error.message).toContain('codex');
      expect(result.error.message).toContain('not found in PATH');
    }

    adapter.dispose();
  });

  it('should fail spawn when CLI not in PATH even if env var is set', () => {
    mockIsCommandInPath.mockReturnValue(false);

    process.env.OPENAI_API_KEY = 'sk-test-key';
    try {
      const adapter = new CodexAdapter(testConfig, 'codex');
      const result = adapter.spawn('test prompt', '/workspace');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.AGENT_MISCONFIGURED);
        expect(result.error.message).toContain('codex');
        expect(result.error.message).toContain('not found in PATH');
      }
      adapter.dispose();
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('should inject stored API key from config into spawn env', () => {
    // CLI in PATH, config has key
    mockIsCommandInPath.mockReturnValue(true);
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    saveAgentConfig('codex', 'apiKey', 'sk-stored-key');

    const adapter = new CodexAdapter(testConfig, 'codex');
    const result = adapter.spawn('test prompt', '/workspace');

    expect(result.ok).toBe(true);

    // Verify the stored key was injected into spawn env
    const spawnOptions = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
    expect(spawnOptions.env.OPENAI_API_KEY).toBe('sk-stored-key');

    adapter.dispose();
  });

  it('should pass auth when CLI is in PATH (login assumed)', () => {
    // CLI found
    mockIsCommandInPath.mockReturnValue(true);
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    const adapter = new GeminiAdapter(testConfig, 'gemini');
    const result = adapter.spawn('test prompt', '/workspace');

    expect(result.ok).toBe(true);
    adapter.dispose();
  });

  it('should include actionable hints when CLI not in PATH', () => {
    mockIsCommandInPath.mockReturnValue(false);

    const adapter = new GeminiAdapter(testConfig, 'gemini');
    const result = adapter.spawn('test prompt', '/workspace');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.AGENT_MISCONFIGURED);
      expect(result.error.message).toContain('gemini');
      expect(result.error.message).toContain('not found in PATH');
    }

    adapter.dispose();
  });

  it('should prefer env var over config file API key', () => {
    mockIsCommandInPath.mockReturnValue(true);
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    // Both set
    process.env.ANTHROPIC_API_KEY = 'sk-env-key';
    saveAgentConfig('claude', 'apiKey', 'sk-config-key');

    try {
      const adapter = new ClaudeAdapter(testConfig, 'claude');
      const result = adapter.spawn('test prompt', '/workspace');
      expect(result.ok).toBe(true);

      // Env var takes precedence — config key NOT injected
      const spawnOptions = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
      expect(spawnOptions.env.ANTHROPIC_API_KEY).toBe('sk-env-key');

      adapter.dispose();
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
});
