/**
 * Agent Adapter Tests — Claude, Codex, Gemini
 *
 * ARCHITECTURE: Tests the spawn arguments, environment stripping, kill
 * behavior, and pre-spawn auth validation for each agent adapter.
 *
 * Pattern: child_process.spawn is mocked to verify args/env without spawning real processes
 */

import type { ChildProcess } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import os, { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig, Configuration } from '../../../src/core/configuration';
import { _testSetConfigDir, saveAgentConfig } from '../../../src/core/configuration';
import { ErrorCode } from '../../../src/core/errors';
import { ClaudeAdapter } from '../../../src/implementations/claude-adapter';
import { CodexAdapter } from '../../../src/implementations/codex-adapter';
import { GeminiAdapter, GeminiBasePromptCache } from '../../../src/implementations/gemini-adapter';

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

/** Shared setup/teardown for adapter describe blocks that follow the common pattern. */
function setupAdapter<T extends { dispose(): void }>(createFn: () => T): { getAdapter: () => T } {
  let adapter: T;
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsCommandInPath.mockReturnValue(true);
    adapter = createFn();
  });
  afterEach(() => {
    adapter.dispose();
  });
  return { getAdapter: () => adapter };
}

describe('ClaudeAdapter', () => {
  const { getAdapter } = setupAdapter(() => new ClaudeAdapter(testConfig, 'claude'));

  it('should have provider set to claude', () => {
    expect(getAdapter().provider).toBe('claude');
  });

  it('should spawn with --print and --dangerously-skip-permissions flags', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    const result = getAdapter().spawn({ prompt: 'test prompt', workingDirectory: '/workspace', taskId: 'task-1' });

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
    process.env.CLAUDECODE = 'true';
    process.env.CLAUDE_CODE_SESSION = 'test';

    try {
      getAdapter().spawn({ prompt: 'test prompt', workingDirectory: '/workspace' });

      const spawnOptions = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
      expect(spawnOptions.env.CLAUDECODE).toBeUndefined();
      expect(spawnOptions.env.CLAUDE_CODE_SESSION).toBeUndefined();
      expect(spawnOptions.env.AUTOBEAT_WORKER).toBe('true');
    } finally {
      delete process.env.CLAUDECODE;
      delete process.env.CLAUDE_CODE_SESSION;
    }
  });

  it('should set AUTOBEAT_TASK_ID when taskId provided', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    getAdapter().spawn({ prompt: 'test prompt', workingDirectory: '/workspace', taskId: 'task-123' });

    const spawnOptions = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
    expect(spawnOptions.env.AUTOBEAT_TASK_ID).toBe('task-123');
  });

  it('should return error when process has no PID', () => {
    const mockChild = createMockChildProcess(0);
    (mockChild as { pid: number | undefined }).pid = undefined;
    mockSpawn.mockReturnValue(mockChild);

    const result = getAdapter().spawn({ prompt: 'test prompt', workingDirectory: '/workspace' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Failed to get process PID');
    }
  });

  it('should return error when spawn throws', () => {
    mockSpawn.mockImplementation(() => {
      throw new Error('spawn ENOENT');
    });

    const result = getAdapter().spawn({ prompt: 'test prompt', workingDirectory: '/workspace' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('spawn ENOENT');
    }
  });
});

describe('CodexAdapter', () => {
  const { getAdapter } = setupAdapter(() => new CodexAdapter(testConfig, 'codex'));

  it('should have provider set to codex', () => {
    expect(getAdapter().provider).toBe('codex');
  });

  it('should spawn with --quiet and --full-auto flags', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    const result = getAdapter().spawn({ prompt: 'test prompt', workingDirectory: '/workspace' });

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
      getAdapter().spawn({ prompt: 'test prompt', workingDirectory: '/workspace' });

      const spawnOptions = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
      expect(spawnOptions.env.CODEX_SESSION).toBe('test');
      expect(spawnOptions.env.AUTOBEAT_WORKER).toBe('true');
    } finally {
      delete process.env.CODEX_SESSION;
    }
  });
});

describe('GeminiAdapter', () => {
  const { getAdapter } = setupAdapter(() => new GeminiAdapter(testConfig, 'gemini'));

  it('should have provider set to gemini', () => {
    expect(getAdapter().provider).toBe('gemini');
  });

  it('should spawn with --yolo --prompt flags for non-interactive auto-accept mode', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    const result = getAdapter().spawn({ prompt: 'test prompt', workingDirectory: '/workspace' });

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
      getAdapter().spawn({ prompt: 'test prompt', workingDirectory: '/workspace' });

      const spawnOptions = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
      expect(spawnOptions.env.GEMINI_API_KEY).toBe('secret');
      expect(spawnOptions.env.AUTOBEAT_WORKER).toBe('true');
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
  const { getAdapter } = setupAdapter(() => new GeminiAdapter(testConfig, 'gemini'));

  it('should set GEMINI_SANDBOX=false in spawn env', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    getAdapter().spawn({ prompt: 'test prompt', workingDirectory: '/workspace' });

    const spawnOptions = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
    expect(spawnOptions.env.GEMINI_SANDBOX).toBe('false');
  });

  it("should allow user's GEMINI_SANDBOX=true to override adapter default", () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    process.env.GEMINI_SANDBOX = 'true';
    try {
      getAdapter().spawn({ prompt: 'test prompt', workingDirectory: '/workspace' });

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
    testDir = path.join(tmpdir(), `autobeat-adapter-auth-test-${Date.now()}`);
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
    const result = adapter.spawn({ prompt: 'test prompt', workingDirectory: '/workspace' });

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
      const result = adapter.spawn({ prompt: 'test prompt', workingDirectory: '/workspace' });
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
    const result = adapter.spawn({ prompt: 'test prompt', workingDirectory: '/workspace' });

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
    const result = adapter.spawn({ prompt: 'test prompt', workingDirectory: '/workspace' });

    expect(result.ok).toBe(true);
    adapter.dispose();
  });

  it('should include actionable hints when CLI not in PATH', () => {
    mockIsCommandInPath.mockReturnValue(false);

    const adapter = new GeminiAdapter(testConfig, 'gemini');
    const result = adapter.spawn({ prompt: 'test prompt', workingDirectory: '/workspace' });

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
      const result = adapter.spawn({ prompt: 'test prompt', workingDirectory: '/workspace' });
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

// ============================================================================
// baseUrl Passthrough Tests
// ============================================================================

describe('baseUrl passthrough', () => {
  let testDir: string;
  let restoreConfig: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    testDir = path.join(tmpdir(), `autobeat-baseurl-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    restoreConfig = _testSetConfigDir(testDir);
    mockIsCommandInPath.mockReturnValue(true);
  });

  afterEach(() => {
    restoreConfig();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('ClaudeAdapter: should inject ANTHROPIC_BASE_URL from config when not set in env', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);
    saveAgentConfig('claude', 'baseUrl', 'https://proxy.example.com');

    const adapter = new ClaudeAdapter(testConfig, 'claude');
    adapter.spawn({ prompt: 'test prompt', workingDirectory: '/workspace' });

    const spawnOptions = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
    expect(spawnOptions.env.ANTHROPIC_BASE_URL).toBe('https://proxy.example.com');
    adapter.dispose();
  });

  it('ClaudeAdapter: user env ANTHROPIC_BASE_URL takes precedence over config', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);
    saveAgentConfig('claude', 'baseUrl', 'https://config.example.com');

    process.env.ANTHROPIC_BASE_URL = 'https://env.example.com';
    try {
      const adapter = new ClaudeAdapter(testConfig, 'claude');
      adapter.spawn({ prompt: 'test prompt', workingDirectory: '/workspace' });

      const spawnOptions = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
      // User env (spread via cleanEnv) takes precedence over injected config
      expect(spawnOptions.env.ANTHROPIC_BASE_URL).toBe('https://env.example.com');
      adapter.dispose();
    } finally {
      delete process.env.ANTHROPIC_BASE_URL;
    }
  });

  it('ClaudeAdapter: auto-sets CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 when baseUrl is configured', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);
    saveAgentConfig('claude', 'baseUrl', 'https://proxy.example.com');

    const adapter = new ClaudeAdapter(testConfig, 'claude');
    adapter.spawn({ prompt: 'test prompt', workingDirectory: '/workspace' });

    const spawnOptions = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
    expect(spawnOptions.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe('1');
    adapter.dispose();
  });

  it('ClaudeAdapter: no CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS when baseUrl not configured', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    const adapter = new ClaudeAdapter(testConfig, 'claude');
    adapter.spawn({ prompt: 'test prompt', workingDirectory: '/workspace' });

    const spawnOptions = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
    expect(spawnOptions.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBeUndefined();
    adapter.dispose();
  });

  it('CodexAdapter: should inject OPENAI_BASE_URL from config', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);
    saveAgentConfig('codex', 'baseUrl', 'https://openai-proxy.example.com');

    const adapter = new CodexAdapter(testConfig, 'codex');
    adapter.spawn({ prompt: 'test prompt', workingDirectory: '/workspace' });

    const spawnOptions = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
    expect(spawnOptions.env.OPENAI_BASE_URL).toBe('https://openai-proxy.example.com');
    adapter.dispose();
  });

  it('GeminiAdapter: should inject GEMINI_BASE_URL from config', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);
    saveAgentConfig('gemini', 'baseUrl', 'https://gemini-proxy.example.com');

    const adapter = new GeminiAdapter(testConfig, 'gemini');
    adapter.spawn({ prompt: 'test prompt', workingDirectory: '/workspace' });

    const spawnOptions = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
    expect(spawnOptions.env.GEMINI_BASE_URL).toBe('https://gemini-proxy.example.com');
    adapter.dispose();
  });
});

// ============================================================================
// Model Passthrough Tests
// ============================================================================

describe('model passthrough', () => {
  let testDir: string;
  let restoreConfig: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    testDir = path.join(tmpdir(), `autobeat-model-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    restoreConfig = _testSetConfigDir(testDir);
    mockIsCommandInPath.mockReturnValue(true);
  });

  afterEach(() => {
    restoreConfig();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('ClaudeAdapter: should include --model in args when model provided', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    const adapter = new ClaudeAdapter(testConfig, 'claude');
    adapter.spawn({
      prompt: 'test prompt',
      workingDirectory: '/workspace',
      taskId: 'task-1',
      model: 'claude-opus-4-5',
    });

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('--model');
    expect(args).toContain('claude-opus-4-5');
    // --model should appear before '--'
    const modelIdx = (args as string[]).indexOf('--model');
    const separatorIdx = (args as string[]).indexOf('--');
    expect(modelIdx).toBeLessThan(separatorIdx);
    adapter.dispose();
  });

  it('ClaudeAdapter: no --model in args when no model provided', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    const adapter = new ClaudeAdapter(testConfig, 'claude');
    adapter.spawn({ prompt: 'test prompt', workingDirectory: '/workspace' });

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).not.toContain('--model');
    adapter.dispose();
  });

  it('ClaudeAdapter: per-task model overrides agent-config model', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);
    saveAgentConfig('claude', 'model', 'claude-sonnet-4-5');

    const adapter = new ClaudeAdapter(testConfig, 'claude');
    adapter.spawn({
      prompt: 'test prompt',
      workingDirectory: '/workspace',
      taskId: 'task-1',
      model: 'claude-opus-4-5',
    });

    const [, args] = mockSpawn.mock.calls[0];
    const modelIdx = (args as string[]).indexOf('--model');
    expect((args as string[])[modelIdx + 1]).toBe('claude-opus-4-5');
    adapter.dispose();
  });

  it('ClaudeAdapter: uses agent-config model when no per-task model', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);
    saveAgentConfig('claude', 'model', 'claude-sonnet-4-5');

    const adapter = new ClaudeAdapter(testConfig, 'claude');
    adapter.spawn({ prompt: 'test prompt', workingDirectory: '/workspace' });

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('--model');
    expect(args).toContain('claude-sonnet-4-5');
    adapter.dispose();
  });

  it('CodexAdapter: should include --model in args when model provided', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    const adapter = new CodexAdapter(testConfig, 'codex');
    adapter.spawn({ prompt: 'test prompt', workingDirectory: '/workspace', taskId: 'task-1', model: 'gpt-4o' });

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('--model');
    expect(args).toContain('gpt-4o');
    adapter.dispose();
  });

  it('GeminiAdapter: should include --model in args when model provided', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    const adapter = new GeminiAdapter(testConfig, 'gemini');
    adapter.spawn({
      prompt: 'test prompt',
      workingDirectory: '/workspace',
      taskId: 'task-1',
      model: 'gemini-2.0-flash',
    });

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('--model');
    expect(args).toContain('gemini-2.0-flash');
    // --model should appear before --prompt
    const modelIdx = (args as string[]).indexOf('--model');
    const promptIdx = (args as string[]).indexOf('--prompt');
    expect(modelIdx).toBeLessThan(promptIdx);
    adapter.dispose();
  });
});

// ============================================================================
// BaseAgentAdapter — orchestratorId env injection validation (security, v1.3.0)
// ============================================================================

describe('BaseAgentAdapter - orchestratorId env injection', () => {
  const VALID_ORCHESTRATOR_ID = 'orchestrator-550e8400-e29b-41d4-a716-446655440000';

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsCommandInPath.mockReturnValue(true);
  });

  it('injects AUTOBEAT_ORCHESTRATOR_ID when orchestratorId matches canonical format', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    const adapter = new ClaudeAdapter(testConfig, 'claude');
    adapter.spawn({
      prompt: 'test prompt',
      workingDirectory: '/workspace',
      taskId: 'task-1',
      orchestratorId: VALID_ORCHESTRATOR_ID,
    });
    adapter.dispose();

    const spawnOptions = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
    expect(spawnOptions.env.AUTOBEAT_ORCHESTRATOR_ID).toBe(VALID_ORCHESTRATOR_ID);
  });

  it('drops AUTOBEAT_ORCHESTRATOR_ID when orchestratorId is malformed', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    const adapter = new ClaudeAdapter(testConfig, 'claude');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    adapter.spawn({
      prompt: 'test prompt',
      workingDirectory: '/workspace',
      taskId: 'task-1',
      orchestratorId: 'not-an-orchestrator-id',
    });
    consoleSpy.mockRestore();
    adapter.dispose();

    const spawnOptions = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
    expect(spawnOptions.env.AUTOBEAT_ORCHESTRATOR_ID).toBeUndefined();
  });

  it('drops AUTOBEAT_ORCHESTRATOR_ID when orchestratorId has uppercase hex (not canonical UUID)', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    const adapter = new ClaudeAdapter(testConfig, 'claude');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    adapter.spawn({
      prompt: 'test prompt',
      workingDirectory: '/workspace',
      taskId: 'task-1',
      orchestratorId: 'orchestrator-550E8400-E29B-41D4-A716-446655440000',
    });
    consoleSpy.mockRestore();
    adapter.dispose();

    const spawnOptions = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
    expect(spawnOptions.env.AUTOBEAT_ORCHESTRATOR_ID).toBeUndefined();
  });

  it('drops AUTOBEAT_ORCHESTRATOR_ID when orchestratorId contains control characters', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    const adapter = new ClaudeAdapter(testConfig, 'claude');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    adapter.spawn({
      prompt: 'test prompt',
      workingDirectory: '/workspace',
      taskId: 'task-1',
      orchestratorId: 'orchestrator-\x00injected\nvalue',
    });
    consoleSpy.mockRestore();
    adapter.dispose();

    const spawnOptions = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
    expect(spawnOptions.env.AUTOBEAT_ORCHESTRATOR_ID).toBeUndefined();
  });

  it('does not inject AUTOBEAT_ORCHESTRATOR_ID when orchestratorId is undefined', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    const adapter = new ClaudeAdapter(testConfig, 'claude');
    adapter.spawn({ prompt: 'test prompt', workingDirectory: '/workspace', taskId: 'task-1' });
    adapter.dispose();

    const spawnOptions = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
    expect(spawnOptions.env.AUTOBEAT_ORCHESTRATOR_ID).toBeUndefined();
  });

  it('spawn still succeeds when orchestratorId is malformed (attribution fails but task runs)', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    const adapter = new ClaudeAdapter(testConfig, 'claude');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = adapter.spawn({
      prompt: 'test prompt',
      workingDirectory: '/workspace',
      taskId: 'task-1',
      orchestratorId: 'malformed-id',
    });
    consoleSpy.mockRestore();
    adapter.dispose();

    expect(result.ok).toBe(true);
  });
});

// ============================================================================
// System Prompt Passthrough Tests
// ============================================================================

describe('system prompt passthrough', () => {
  let testDir: string;
  let restoreConfig: () => void;
  let homedirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    testDir = path.join(tmpdir(), `autobeat-systemprompt-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    restoreConfig = _testSetConfigDir(testDir);
    mockIsCommandInPath.mockReturnValue(true);
    // Redirect os.homedir() to our temp directory so Gemini cache reads are isolated
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(testDir);
  });

  afterEach(() => {
    homedirSpy.mockRestore();
    restoreConfig();
    rmSync(testDir, { recursive: true, force: true });
  });

  // ---- Claude ----------------------------------------------------------------

  it('ClaudeAdapter: --append-system-prompt appears in spawn args when systemPrompt set', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    const adapter = new ClaudeAdapter(testConfig, 'claude');
    const result = adapter.spawn({
      prompt: 'test prompt',
      workingDirectory: '/workspace',
      taskId: 'task-1',
      systemPrompt: 'Always respond in JSON',
    });
    adapter.dispose();

    expect(result.ok).toBe(true);
    const [, args] = mockSpawn.mock.calls[0];
    const idx = (args as string[]).indexOf('--append-system-prompt');
    expect(idx).toBeGreaterThan(-1);
    expect((args as string[])[idx + 1]).toBe('Always respond in JSON');
  });

  it('ClaudeAdapter: no --append-system-prompt when systemPrompt is absent (regression guard)', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    const adapter = new ClaudeAdapter(testConfig, 'claude');
    adapter.spawn({ prompt: 'test prompt', workingDirectory: '/workspace', taskId: 'task-1' });
    adapter.dispose();

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).not.toContain('--append-system-prompt');
  });

  // ---- Codex -----------------------------------------------------------------

  it('CodexAdapter: -c developer_instructions=<text> appears in spawn args when systemPrompt set', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    const adapter = new CodexAdapter(testConfig, 'codex');
    const result = adapter.spawn({
      prompt: 'test prompt',
      workingDirectory: '/workspace',
      taskId: 'task-1',
      systemPrompt: 'Be concise',
    });
    adapter.dispose();

    expect(result.ok).toBe(true);
    const [, args] = mockSpawn.mock.calls[0];
    const cIdx = (args as string[]).indexOf('-c');
    expect(cIdx).toBeGreaterThan(-1);
    expect((args as string[])[cIdx + 1]).toBe('developer_instructions=Be concise');
  });

  it('CodexAdapter: no -c developer_instructions when systemPrompt is absent (regression guard)', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    const adapter = new CodexAdapter(testConfig, 'codex');
    adapter.spawn({ prompt: 'test prompt', workingDirectory: '/workspace', taskId: 'task-1' });
    adapter.dispose();

    const [, args] = mockSpawn.mock.calls[0];
    // Verify no developer_instructions entry
    expect((args as string[]).some((a) => typeof a === 'string' && a.startsWith('developer_instructions='))).toBe(
      false,
    );
  });

  // ---- Gemini: no cache (fallback to prependToPrompt) -----------------------

  it('GeminiAdapter: without base cache — falls back to prependToPrompt (systemPrompt prepended to prompt arg)', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // No cache file created — fallback path
    const adapter = new GeminiAdapter(testConfig, 'gemini');
    const result = adapter.spawn({
      prompt: 'do the work',
      workingDirectory: '/workspace',
      taskId: 'task-fallback',
      systemPrompt: 'Be careful',
    });
    consoleSpy.mockRestore();
    adapter.dispose();

    expect(result.ok).toBe(true);
    const [, args] = mockSpawn.mock.calls[0];
    // --prompt arg value should contain both systemPrompt and original prompt
    const promptIdx = (args as string[]).indexOf('--prompt');
    expect(promptIdx).toBeGreaterThan(-1);
    const promptValue = (args as string[])[promptIdx + 1];
    expect(promptValue).toContain('Be careful');
    expect(promptValue).toContain('do the work');
    // GEMINI_SYSTEM_MD env var should NOT be set in fallback
    const spawnOptions = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
    expect(spawnOptions.env.GEMINI_SYSTEM_MD).toBeUndefined();
  });

  // ---- Gemini: with cache (GEMINI_SYSTEM_MD injection) ---------------------

  it('GeminiAdapter: with valid base cache — sets GEMINI_SYSTEM_MD env var with combined file', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    // Create the base cache file that GeminiAdapter looks for
    const cacheDir = path.join(testDir, '.autobeat', 'system-prompts');
    mkdirSync(cacheDir, { recursive: true });
    const baseCachePath = path.join(cacheDir, 'gemini-base.md');
    writeFileSync(baseCachePath, 'Base Gemini system prompt content', 'utf8');

    const adapter = new GeminiAdapter(testConfig, 'gemini');
    const result = adapter.spawn({
      prompt: 'do the work',
      workingDirectory: '/workspace',
      taskId: 'task-with-cache',
      systemPrompt: 'Additional instructions',
    });
    adapter.dispose();

    expect(result.ok).toBe(true);
    const spawnOptions = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
    // GEMINI_SYSTEM_MD must be set to the task-scoped combined file
    expect(spawnOptions.env.GEMINI_SYSTEM_MD).toBeDefined();
    expect(spawnOptions.env.GEMINI_SYSTEM_MD).toContain('task-with-cache');
    // The --prompt arg should be the original prompt (not prepended)
    const [, args] = mockSpawn.mock.calls[0];
    const promptIdx = (args as string[]).indexOf('--prompt');
    const promptValue = (args as string[])[promptIdx + 1];
    expect(promptValue).toBe('do the work');
    expect(promptValue).not.toContain('Additional instructions');
  });

  it('GeminiAdapter: without systemPrompt — no GEMINI_SYSTEM_MD or prepend (regression guard)', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    const adapter = new GeminiAdapter(testConfig, 'gemini');
    adapter.spawn({ prompt: 'do the work', workingDirectory: '/workspace', taskId: 'task-no-sp' });
    adapter.dispose();

    const spawnOptions = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
    expect(spawnOptions.env.GEMINI_SYSTEM_MD).toBeUndefined();
    const [, args] = mockSpawn.mock.calls[0];
    const promptIdx = (args as string[]).indexOf('--prompt');
    const promptValue = (args as string[])[promptIdx + 1];
    expect(promptValue).toBe('do the work');
  });
});

// ============================================================================
// GeminiBasePromptCache Unit Tests
// ============================================================================

describe('GeminiBasePromptCache', () => {
  let cacheDir: string;
  let cache: GeminiBasePromptCache;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    cacheDir = path.join(tmpdir(), `gemini-cache-test-${Date.now()}`);
    mkdirSync(cacheDir, { recursive: true });
    cache = new GeminiBasePromptCache(cacheDir);
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('returns null when no gemini-base.md exists (no cache file)', () => {
    const result = cache.buildCombinedFile('user system prompt', path.join(cacheDir, 'task-1.md'));
    expect(result).toBeNull();
  });

  it('returns null when gemini-base.md is stale (older than 30 days)', () => {
    const baseCachePath = path.join(cacheDir, 'gemini-base.md');
    writeFileSync(baseCachePath, 'base content', 'utf8');

    // Backdate the file's mtime to 31 days ago
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    utimesSync(baseCachePath, thirtyOneDaysAgo, thirtyOneDaysAgo);

    const result = cache.buildCombinedFile('user system prompt', path.join(cacheDir, 'task-stale.md'));
    expect(result).toBeNull();
  });

  it('returns null when combined prompt exceeds 64KB size guard', () => {
    const baseCachePath = path.join(cacheDir, 'gemini-base.md');
    // Write a base prompt that fills most of the 64KB budget
    const bigBase = 'x'.repeat(60 * 1024);
    writeFileSync(baseCachePath, bigBase, 'utf8');

    const bigUserPrompt = 'y'.repeat(10 * 1024); // combined exceeds 64KB
    const result = cache.buildCombinedFile(bigUserPrompt, path.join(cacheDir, 'task-big.md'));
    expect(result).toBeNull();
  });

  it('writes combined file and returns outputPath on cache hit', () => {
    const baseCachePath = path.join(cacheDir, 'gemini-base.md');
    writeFileSync(baseCachePath, 'Base instructions', 'utf8');

    const outputPath = path.join(cacheDir, 'task-abc.md');
    const result = cache.buildCombinedFile('User instructions', outputPath);

    expect(result).toBe(outputPath);
    const written = readFileSync(outputPath, 'utf8');
    expect(written).toContain('Base instructions');
    expect(written).toContain('User instructions');
  });

  it('returns in-memory cache hit on second call without re-reading disk', () => {
    const baseCachePath = path.join(cacheDir, 'gemini-base.md');
    writeFileSync(baseCachePath, 'Base instructions', 'utf8');

    const out1 = path.join(cacheDir, 'task-1.md');
    const out2 = path.join(cacheDir, 'task-2.md');

    // First call loads from disk
    cache.buildCombinedFile('prompt', out1);

    // Overwrite disk file — in-memory cache should still be used
    writeFileSync(baseCachePath, 'CHANGED base', 'utf8');

    // Second call should use cached in-memory value (original "Base instructions")
    const result2 = cache.buildCombinedFile('prompt', out2);
    expect(result2).toBe(out2);
    const written2 = readFileSync(out2, 'utf8');
    expect(written2).toContain('Base instructions');
    expect(written2).not.toContain('CHANGED base');
  });

  it('invalidate() causes next buildCombinedFile to re-read from disk', () => {
    const baseCachePath = path.join(cacheDir, 'gemini-base.md');
    writeFileSync(baseCachePath, 'Original base', 'utf8');

    const out1 = path.join(cacheDir, 'task-before.md');
    cache.buildCombinedFile('prompt', out1);

    // Overwrite disk then invalidate
    writeFileSync(baseCachePath, 'Updated base', 'utf8');
    cache.invalidate();

    const out2 = path.join(cacheDir, 'task-after.md');
    const result2 = cache.buildCombinedFile('prompt', out2);
    expect(result2).toBe(out2);
    const written2 = readFileSync(out2, 'utf8');
    expect(written2).toContain('Updated base');
  });

  it('buildCombinedFile rejects outputPath outside cacheDir (path traversal)', () => {
    const baseCachePath = path.join(cacheDir, 'gemini-base.md');
    writeFileSync(baseCachePath, 'Base instructions', 'utf8');

    // Attempt to write outside cacheDir via traversal
    const outsidePath = path.join(path.dirname(cacheDir), 'escaped.md');
    const result = cache.buildCombinedFile('User prompt', outsidePath);

    expect(result).toBeNull();
    expect(existsSync(outsidePath)).toBe(false);
  });

  it('cleanupTaskFile removes the task file when it exists', () => {
    const taskId = 'task-to-delete';
    const taskFile = path.join(cacheDir, `${taskId}.md`);
    writeFileSync(taskFile, 'content', 'utf8');

    cache.cleanupTaskFile(taskId);

    expect(existsSync(taskFile)).toBe(false);
  });

  it('cleanupTaskFile is non-fatal when file does not exist (missing file)', () => {
    expect(() => cache.cleanupTaskFile('nonexistent-task-id')).not.toThrow();
  });

  it('cleanupTaskFile rejects path traversal attempts', () => {
    // Create a file one level above cacheDir that a traversal would target
    const outsideFile = path.join(path.dirname(cacheDir), 'sensitive.md');
    writeFileSync(outsideFile, 'sensitive', 'utf8');

    try {
      // Attempt traversal: taskId containing ../ to escape cacheDir
      const traversalId = `../sensitive`;
      cache.cleanupTaskFile(traversalId);

      // File should still exist — traversal was blocked
      expect(existsSync(outsideFile)).toBe(true);
    } finally {
      try {
        rmSync(outsideFile, { force: true });
      } catch {
        /* best effort */
      }
    }
  });
});

// ─── Ollama Runtime Integration Tests ────────────────────────────────────────
// Tests for resolveRuntime() and spawn() with ollama runtime wrapping.
// Placed here (not a separate file) to share the module registry mocks established
// above — isolate:false means each new vi.mock() call creates a new fn instance
// that breaks imports already captured in other test files.

function callResolveRuntime(
  adapter: ClaudeAdapter | CodexAdapter | GeminiAdapter,
  config: AgentConfig,
  taskModel?: string,
) {
  return (adapter as unknown as { resolveRuntime(c: AgentConfig, m?: string): unknown }).resolveRuntime(
    config,
    taskModel,
  );
}

describe('resolveRuntime', () => {
  let testDir: string;
  let restoreConfig: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsCommandInPath.mockReturnValue(true);
    testDir = path.join(tmpdir(), `autobeat-runtime-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    restoreConfig = _testSetConfigDir(testDir);
  });

  afterEach(() => {
    restoreConfig();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns ok(null) when runtime is not set', () => {
    const adapter = new ClaudeAdapter(testConfig);
    const result = callResolveRuntime(adapter, {});
    expect(result).toEqual({ ok: true, value: null });
    adapter.dispose();
  });

  it('returns ollama config when runtime is ollama for claude', () => {
    const adapter = new ClaudeAdapter(testConfig);
    const result = callResolveRuntime(adapter, { runtime: 'ollama' as const });
    expect(result).toMatchObject({
      ok: true,
      value: {
        command: 'ollama',
        suppressModel: true,
        suppressAuth: true,
        suppressBaseUrl: true,
      },
    });
    adapter.dispose();
  });

  it('returns ollama config when runtime is ollama for codex', () => {
    const adapter = new CodexAdapter(testConfig);
    const result = callResolveRuntime(adapter, { runtime: 'ollama' as const });
    expect(result).toMatchObject({ ok: true, value: { command: 'ollama' } });
    adapter.dispose();
  });

  it('returns error when runtime is ollama for gemini', () => {
    const adapter = new GeminiAdapter(testConfig);
    const result = callResolveRuntime(adapter, { runtime: 'ollama' as const }) as {
      ok: false;
      error: { code: string; message: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe(ErrorCode.AGENT_MISCONFIGURED);
    expect(result.error.message).toContain("Runtime 'ollama' does not support agent 'gemini'");
    adapter.dispose();
  });

  it('uses taskModel over agentConfig.model in prependArgs', () => {
    const adapter = new ClaudeAdapter(testConfig);
    const result = callResolveRuntime(adapter, { runtime: 'ollama' as const, model: 'config-model' }, 'task-model') as {
      ok: true;
      value: { prependArgs: readonly string[] };
    };
    expect(result.ok).toBe(true);
    expect(result.value.prependArgs).toContain('task-model');
    expect(result.value.prependArgs).not.toContain('config-model');
    adapter.dispose();
  });

  it('uses agentConfig.model when no taskModel provided', () => {
    const adapter = new ClaudeAdapter(testConfig);
    const result = callResolveRuntime(adapter, {
      runtime: 'ollama' as const,
      model: 'config-model',
    }) as { ok: true; value: { prependArgs: readonly string[] } };
    expect(result.ok).toBe(true);
    expect(result.value.prependArgs).toContain('config-model');
    adapter.dispose();
  });

  it('omits --model from prependArgs when neither model source is set', () => {
    const adapter = new ClaudeAdapter(testConfig);
    const result = callResolveRuntime(adapter, { runtime: 'ollama' as const }) as {
      ok: true;
      value: { prependArgs: readonly string[] };
    };
    expect(result.ok).toBe(true);
    expect(result.value.prependArgs).not.toContain('--model');
    adapter.dispose();
  });
});

describe('spawn with ollama runtime', () => {
  let testDir: string;
  let restoreConfig: () => void;
  let adapter: ClaudeAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsCommandInPath.mockReturnValue(true);
    mockSpawn.mockReturnValue(createMockChildProcess(1234));
    testDir = path.join(tmpdir(), `autobeat-runtime-spawn-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    restoreConfig = _testSetConfigDir(testDir);
    adapter = new ClaudeAdapter(testConfig);
  });

  afterEach(() => {
    adapter.dispose();
    restoreConfig();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('wraps command with ollama launch when runtime is set', () => {
    saveAgentConfig('claude', 'runtime', 'ollama');
    const result = adapter.spawn({ prompt: 'test', workingDirectory: '/workspace', taskId: 'task-1' });

    expect(result.ok).toBe(true);
    expect(mockSpawn).toHaveBeenCalledOnce();
    const [command, args] = mockSpawn.mock.calls[0];
    expect(command).toBe('ollama');
    expect(args[0]).toBe('launch');
    expect(args[1]).toBe('claude');
  });

  it('checks isCommandInPath for ollama not claude when runtime is active', () => {
    saveAgentConfig('claude', 'runtime', 'ollama');
    adapter.spawn({ prompt: 'test', workingDirectory: '/workspace', taskId: 'task-1' });

    const checkedCommands = mockIsCommandInPath.mock.calls.map(([cmd]) => cmd);
    expect(checkedCommands).toContain('ollama');
  });

  it('returns error when ollama binary is not found', () => {
    saveAgentConfig('claude', 'runtime', 'ollama');
    mockIsCommandInPath.mockImplementation((cmd: string) => cmd !== 'ollama');

    const result = adapter.spawn({ prompt: 'test', workingDirectory: '/workspace', taskId: 'task-1' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.AGENT_MISCONFIGURED);
      expect(result.error.message).toContain("CLI binary 'ollama' not found");
    }
  });

  it('suppresses --model from inner buildArgs when runtime is active', () => {
    saveAgentConfig('claude', 'runtime', 'ollama');
    adapter.spawn({ prompt: 'test', workingDirectory: '/workspace', taskId: 'task-1', model: 'claude-opus-4-5' });

    expect(mockSpawn).toHaveBeenCalledOnce();
    const [, args] = mockSpawn.mock.calls[0];
    const doubleDashIdx = args.indexOf('--');
    const innerArgs = doubleDashIdx >= 0 ? args.slice(doubleDashIdx + 1) : args;
    expect(innerArgs).not.toContain('--model');
  });

  it('includes ollama --model in prependArgs when model is set', () => {
    saveAgentConfig('claude', 'runtime', 'ollama');
    saveAgentConfig('claude', 'model', 'qwen3');
    adapter.spawn({ prompt: 'test', workingDirectory: '/workspace', taskId: 'task-1' });

    expect(mockSpawn).toHaveBeenCalledOnce();
    const [, args] = mockSpawn.mock.calls[0];
    const doubleDashIdx = args.indexOf('--');
    const outerArgs = doubleDashIdx >= 0 ? args.slice(0, doubleDashIdx) : args;
    expect(outerArgs).toContain('--model');
    expect(outerArgs).toContain('qwen3');
  });

  it('suppresses auth env var injection when runtime is active', () => {
    saveAgentConfig('claude', 'runtime', 'ollama');
    saveAgentConfig('claude', 'apiKey', 'sk-test-key');
    adapter.spawn({ prompt: 'test', workingDirectory: '/workspace', taskId: 'task-1' });

    expect(mockSpawn).toHaveBeenCalledOnce();
    const [, , spawnOpts] = mockSpawn.mock.calls[0];
    const env = (spawnOpts as { env?: Record<string, string> } | undefined)?.env;
    expect(env?.ANTHROPIC_API_KEY).not.toBe('sk-test-key');
  });

  it('suppresses baseUrl env var injection when runtime is active', () => {
    saveAgentConfig('claude', 'runtime', 'ollama');
    saveAgentConfig('claude', 'baseUrl', 'https://custom.api.example.com');
    adapter.spawn({ prompt: 'test', workingDirectory: '/workspace', taskId: 'task-1' });

    expect(mockSpawn).toHaveBeenCalledOnce();
    const [, , spawnOpts] = mockSpawn.mock.calls[0];
    const env = (spawnOpts as { env?: Record<string, string> } | undefined)?.env;
    expect(env?.ANTHROPIC_BASE_URL).not.toBe('https://custom.api.example.com');
  });

  it('preserves AUTOBEAT_ env vars when runtime is active', () => {
    saveAgentConfig('claude', 'runtime', 'ollama');
    adapter.spawn({ prompt: 'test', workingDirectory: '/workspace', taskId: 'task-42' });

    expect(mockSpawn).toHaveBeenCalledOnce();
    const [, , spawnOpts] = mockSpawn.mock.calls[0];
    const env = (spawnOpts as { env?: Record<string, string> } | undefined)?.env;
    expect(env?.AUTOBEAT_WORKER).toBe('true');
    expect(env?.AUTOBEAT_TASK_ID).toBe('task-42');
  });

  it('passes system prompt args through when runtime is active', () => {
    saveAgentConfig('claude', 'runtime', 'ollama');
    adapter.spawn({
      prompt: 'test',
      workingDirectory: '/workspace',
      taskId: 'task-1',
      systemPrompt: 'Be concise.',
    });

    expect(mockSpawn).toHaveBeenCalledOnce();
    const [, args] = mockSpawn.mock.calls[0];
    expect(args.join(' ')).toContain('--append-system-prompt');
  });
});

describe('spawn with ollama runtime (codex)', () => {
  let testDir: string;
  let restoreConfig: () => void;
  let adapter: CodexAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsCommandInPath.mockReturnValue(true);
    mockSpawn.mockReturnValue(createMockChildProcess(1234));
    testDir = path.join(tmpdir(), `autobeat-runtime-codex-spawn-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    restoreConfig = _testSetConfigDir(testDir);
    adapter = new CodexAdapter(testConfig);
  });

  afterEach(() => {
    adapter.dispose();
    restoreConfig();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('wraps codex command with ollama launch when runtime is set', () => {
    saveAgentConfig('codex', 'runtime', 'ollama');
    const result = adapter.spawn({ prompt: 'test', workingDirectory: '/workspace', taskId: 'task-1' });

    expect(result.ok).toBe(true);
    expect(mockSpawn).toHaveBeenCalledOnce();
    const [command, args] = mockSpawn.mock.calls[0];
    expect(command).toBe('ollama');
    expect(args[0]).toBe('launch');
    expect(args[1]).toBe('codex');
  });
});
