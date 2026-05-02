/**
 * Agent Adapter Tests — Claude, Codex
 *
 * ARCHITECTURE: Tests the spawn arguments, environment stripping, kill
 * behavior, and pre-spawn auth validation for each agent adapter.
 *
 * Pattern: child_process.spawn is mocked to verify args/env without spawning real processes
 */

import type { ChildProcess } from 'child_process';
import { mkdirSync, rmSync } from 'fs';
import os, { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Configuration } from '../../../src/core/configuration';
import { _testSetConfigDir, saveAgentConfig } from '../../../src/core/configuration';
import { ErrorCode } from '../../../src/core/errors';
import { ClaudeAdapter } from '../../../src/implementations/claude-adapter';
import { CodexAdapter } from '../../../src/implementations/codex-adapter';

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
    // Redirect os.homedir() to our temp directory for system prompt path isolation
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
});
