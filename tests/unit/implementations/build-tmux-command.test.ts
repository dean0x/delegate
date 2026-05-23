/**
 * Tests for buildTmuxCommand() — tmux config production for agent adapters
 *
 * Pattern: Mirrors agent-adapters.test.ts — mocks child_process.spawn and
 * isCommandInPath, uses _testSetConfigDir for config isolation.
 */

import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Configuration } from '../../../src/core/configuration';
import { _testSetConfigDir, saveAgentConfig } from '../../../src/core/configuration';
import { ErrorCode } from '../../../src/core/errors';
import { ClaudeAdapter } from '../../../src/implementations/claude-adapter';
import { CodexAdapter } from '../../../src/implementations/codex-adapter';

// Mock child_process.spawn (needed by BaseAgentAdapter import chain)
vi.mock('child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  ChildProcess: vi.fn(),
}));

// Mock isCommandInPath — keep consistent with agent-adapters.test.ts.
// NOTE: With isolate: false, both test files share the agents module registry.
// This vi.mock call ensures the mock is registered in this file's scope; the factory
// is deduplicated by Vitest so the same vi.fn() is used across both files.
vi.mock('../../../src/core/agents', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/core/agents')>();
  return {
    ...original,
    isCommandInPath: vi.fn().mockReturnValue(true),
  };
});

import { isCommandInPath } from '../../../src/core/agents';
import type { TmuxSpawnConfig } from '../../../src/implementations/tmux/types';
import { SESSION_NAME_REGEX } from '../../../src/implementations/tmux/types';

const mockIsCommandInPath = vi.mocked(isCommandInPath);

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

const baseOptions = {
  prompt: 'Implement the feature',
  workingDirectory: '/tmp/workspace',
  taskId: 'task-abc123',
  sessionsDir: '/tmp/sessions',
};

let configDir: string;
let restoreConfig: () => void;

beforeEach(() => {
  vi.clearAllMocks();
  mockIsCommandInPath.mockReturnValue(true);
  configDir = path.join(tmpdir(), `autobeat-test-tmux-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(configDir, { recursive: true });
  restoreConfig = _testSetConfigDir(configDir);
});

afterEach(() => {
  restoreConfig();
  rmSync(configDir, { recursive: true, force: true });
});

// ─── Return shape ───────────────────────────────────────────────────────────

describe('buildTmuxCommand() return shape', () => {
  let adapter: ClaudeAdapter;

  beforeEach(() => {
    adapter = new ClaudeAdapter(testConfig);
  });

  afterEach(() => {
    adapter.dispose();
  });

  it('returns ok with { config: TmuxSpawnConfig, prompt: string }', () => {
    const result = adapter.buildTmuxCommand(baseOptions);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveProperty('config');
    expect(result.value).toHaveProperty('prompt');
    expect(typeof result.value.prompt).toBe('string');

    const config: TmuxSpawnConfig = result.value.config;
    expect(config).toHaveProperty('name');
    expect(config).toHaveProperty('command');
    expect(config).toHaveProperty('agentArgs');
    expect(config).toHaveProperty('taskId');
    expect(config).toHaveProperty('sessionsDir');
    expect(config).toHaveProperty('agent');
  });

  it('prompt field equals the input prompt', () => {
    const result = adapter.buildTmuxCommand(baseOptions);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.prompt).toBe('Implement the feature');
  });
});

// ─── ClaudeAdapter ──────────────────────────────────────────────────────────

describe('buildTmuxCommand() — ClaudeAdapter', () => {
  let adapter: ClaudeAdapter;

  beforeEach(() => {
    adapter = new ClaudeAdapter(testConfig);
  });

  afterEach(() => {
    adapter.dispose();
  });

  it('config.agentArgs includes --dangerously-skip-permissions', () => {
    const result = adapter.buildTmuxCommand(baseOptions);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.config.agentArgs).toContain('--dangerously-skip-permissions');
  });

  it('config.agentArgs includes --output-format stream-json', () => {
    const result = adapter.buildTmuxCommand(baseOptions);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.config.agentArgs).toContain('--output-format');
    expect(result.value.config.agentArgs).toContain('stream-json');
  });

  it('config.agentArgs does NOT include --print', () => {
    const result = adapter.buildTmuxCommand(baseOptions);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.config.agentArgs).not.toContain('--print');
  });

  it('config.agentArgs does NOT include --output-format json', () => {
    const result = adapter.buildTmuxCommand(baseOptions);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const args = result.value.config.agentArgs;
    const fmtIndex = args.indexOf('--output-format');
    expect(fmtIndex).toBeGreaterThanOrEqual(0);
    expect(args[fmtIndex + 1]).toBe('stream-json');
  });

  it('config.agentArgs does NOT contain the prompt text', () => {
    const result = adapter.buildTmuxCommand(baseOptions);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.config.agentArgs).not.toContain('Implement the feature');
  });

  it('config.agentArgs does NOT contain -- separator', () => {
    const result = adapter.buildTmuxCommand(baseOptions);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.config.agentArgs).not.toContain('--');
  });

  it('config.name follows beat-task-{taskId} pattern', () => {
    const result = adapter.buildTmuxCommand(baseOptions);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.config.name).toBe('beat-task-task-abc123');
    expect(SESSION_NAME_REGEX.test(result.value.config.name)).toBe(true);
  });

  it('config.command is claude', () => {
    const result = adapter.buildTmuxCommand(baseOptions);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.config.command).toBe('claude');
  });

  it('config.agent is claude', () => {
    const result = adapter.buildTmuxCommand(baseOptions);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.config.agent).toBe('claude');
  });

  it('config.cwd matches workingDirectory option', () => {
    const result = adapter.buildTmuxCommand(baseOptions);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.config.cwd).toBe('/tmp/workspace');
  });

  it('config.env includes AUTOBEAT_WORKER=true', () => {
    const result = adapter.buildTmuxCommand(baseOptions);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.config.env?.AUTOBEAT_WORKER).toBe('true');
  });

  it('config.env includes AUTOBEAT_TASK_ID when taskId provided', () => {
    const result = adapter.buildTmuxCommand(baseOptions);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.config.env?.AUTOBEAT_TASK_ID).toBe('task-abc123');
  });

  it('with model: config.agentArgs includes --model <value>', () => {
    const result = adapter.buildTmuxCommand({ ...baseOptions, model: 'opus' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const args = result.value.config.agentArgs;
    const modelIndex = args.indexOf('--model');
    expect(modelIndex).toBeGreaterThanOrEqual(0);
    expect(args[modelIndex + 1]).toBe('opus');
  });

  it('with systemPrompt: config.agentArgs includes --append-system-prompt', () => {
    const result = adapter.buildTmuxCommand({
      ...baseOptions,
      systemPrompt: 'You are a helpful assistant',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const args = result.value.config.agentArgs;
    expect(args).toContain('--append-system-prompt');
    const spIndex = args.indexOf('--append-system-prompt');
    expect(args[spIndex + 1]).toBe('You are a helpful assistant');
  });

  it('with systemPrompt: prompt text NOT in agentArgs', () => {
    const result = adapter.buildTmuxCommand({
      ...baseOptions,
      systemPrompt: 'You are a helpful assistant',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.config.agentArgs).not.toContain('Implement the feature');
  });

  it('with orchestratorId: config.env includes AUTOBEAT_ORCHESTRATOR_ID', () => {
    const result = adapter.buildTmuxCommand({
      ...baseOptions,
      orchestratorId: 'orchestrator-12345678-1234-1234-1234-123456789abc',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.config.env?.AUTOBEAT_ORCHESTRATOR_ID).toBe('orchestrator-12345678-1234-1234-1234-123456789abc');
  });

  it('with ollama runtime: config.command is ollama, runtime args prepended', () => {
    saveAgentConfig('claude', 'runtime', 'ollama');
    mockIsCommandInPath.mockImplementation((cmd: string) => cmd === 'ollama');
    const result = adapter.buildTmuxCommand(baseOptions);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.config.command).toBe('ollama');
    expect(result.value.config.agentArgs[0]).toBe('launch');
    expect(result.value.config.agentArgs[1]).toBe('claude');
    expect(result.value.config.agentArgs).toContain('--yes');
    expect(result.value.config.agentArgs).toContain('--');
    expect(result.value.config.agentArgs).toContain('--dangerously-skip-permissions');
  });
});

// ─── CodexAdapter ───────────────────────────────────────────────────────────

describe('buildTmuxCommand() — CodexAdapter', () => {
  let adapter: CodexAdapter;

  beforeEach(() => {
    adapter = new CodexAdapter(testConfig);
  });

  afterEach(() => {
    adapter.dispose();
  });

  it('config.agentArgs includes --full-auto', () => {
    const result = adapter.buildTmuxCommand(baseOptions);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.config.agentArgs).toContain('--full-auto');
  });

  it('config.agentArgs does NOT include --quiet', () => {
    const result = adapter.buildTmuxCommand(baseOptions);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.config.agentArgs).not.toContain('--quiet');
  });

  it('config.agentArgs does NOT contain the prompt text', () => {
    const result = adapter.buildTmuxCommand(baseOptions);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.config.agentArgs).not.toContain('Implement the feature');
  });

  it('config.agent is codex', () => {
    const result = adapter.buildTmuxCommand(baseOptions);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.config.agent).toBe('codex');
  });

  it('with systemPrompt: config.agentArgs includes -c developer_instructions=<text>', () => {
    const result = adapter.buildTmuxCommand({
      ...baseOptions,
      systemPrompt: 'You are a code reviewer',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const args = result.value.config.agentArgs;
    expect(args).toContain('-c');
    const cIndex = args.indexOf('-c');
    expect(args[cIndex + 1]).toBe('developer_instructions=You are a code reviewer');
  });

  it('with model: config.agentArgs includes --model <value>', () => {
    const result = adapter.buildTmuxCommand({ ...baseOptions, model: 'gpt-4o' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const args = result.value.config.agentArgs;
    const modelIndex = args.indexOf('--model');
    expect(modelIndex).toBeGreaterThanOrEqual(0);
    expect(args[modelIndex + 1]).toBe('gpt-4o');
  });
});

// ─── ProxiedClaudeAdapter ───────────────────────────────────────────────────

describe('buildTmuxCommand() — ProxiedClaudeAdapter', () => {
  // Lazy import to avoid circular issues
  let ProxiedClaudeAdapter: typeof import('../../../src/translation/proxy/proxied-claude-adapter').ProxiedClaudeAdapter;

  beforeEach(async () => {
    const mod = await import('../../../src/translation/proxy/proxied-claude-adapter');
    ProxiedClaudeAdapter = mod.ProxiedClaudeAdapter;
  });

  it('config.env includes ANTHROPIC_BASE_URL with proxy URL', () => {
    const adapter = new ProxiedClaudeAdapter(testConfig, 9876);
    const result = adapter.buildTmuxCommand(baseOptions);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.config.env?.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:9876');
    adapter.dispose();
  });

  it('config.env includes CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1', () => {
    const adapter = new ProxiedClaudeAdapter(testConfig, 9876);
    const result = adapter.buildTmuxCommand(baseOptions);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.config.env?.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe('1');
    adapter.dispose();
  });

  it('prompt field equals input prompt (proxy does not modify prompt)', () => {
    const adapter = new ProxiedClaudeAdapter(testConfig, 9876);
    const result = adapter.buildTmuxCommand(baseOptions);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.prompt).toBe('Implement the feature');
    adapter.dispose();
  });
});

// ─── Error path: missing taskId ─────────────────────────────────────────────
// The CLI not-in-PATH error path is already covered in agent-adapters.test.ts
// (via spawn() which calls the same resolveSpawnConfig). Adding it here would
// require mocking isCommandInPath across two files that share the agents module
// with isolate: false — both files' vi.mock factories create separate vi.fn()
// instances, so the second file's mock never intercepts the captured reference
// used by base-agent-adapter.ts. Covered behavior: agent-adapters.test.ts
// "Pre-spawn auth validation > should fail spawn when CLI not in PATH".

describe('buildTmuxCommand() — missing taskId guard', () => {
  it.each([
    ['ClaudeAdapter', () => new ClaudeAdapter(testConfig)],
    ['CodexAdapter', () => new CodexAdapter(testConfig)],
  ] as const)('%s: returns err with AGENT_MISCONFIGURED when taskId is missing', (_name, createAdapter) => {
    const adapter = createAdapter();
    const result = adapter.buildTmuxCommand({ ...baseOptions, taskId: undefined });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.AGENT_MISCONFIGURED);
    expect(result.error.message).toContain('taskId');

    adapter.dispose();
  });
});

// ─── Unsupported provider guard ─────────────────────────────────────────────

describe('buildTmuxCommand() — unsupported provider guard', () => {
  it('returns err for non-claude/codex provider', async () => {
    const { BaseAgentAdapter } = await import('../../../src/implementations/base-agent-adapter');

    class FakeAdapter extends BaseAgentAdapter {
      // biome-ignore lint/suspicious/noExplicitAny: testing with an intentionally invalid provider
      readonly provider = 'unknown-agent' as any;
      protected get envPrefixesToStrip() {
        return [];
      }
      protected getSystemPromptConfig() {
        return { args: [], env: {}, prependToPrompt: false };
      }
    }

    const adapter = new FakeAdapter(testConfig, 'fake-cli');
    const result = adapter.buildTmuxCommand(baseOptions);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.AGENT_MISCONFIGURED);
    expect(result.error.message).toContain('tmux mode is not supported');
    adapter.dispose();
  });
});
