/**
 * Tests for Interactive Orchestrator Mode
 * Covers: CLI arg parsing, agent adapter interactive args, orchestration manager,
 * cancel, migration, scaffold template, list/status output
 */

import { unlinkSync } from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ============================================================================
// CLI Arg Parsing Tests
// ============================================================================

import {
  parseOrchestrateCreateArgs,
  parseOrchestrateInitArgs,
  parseOrchestrateInteractiveArgs,
} from '../../src/cli/commands/orchestrate.js';

describe('parseOrchestrateInteractiveArgs', () => {
  it('should parse a single-word goal', () => {
    const result = parseOrchestrateInteractiveArgs(['deploy']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('interactive');
    expect(result.value.goal).toBe('deploy');
  });

  it('should parse a multi-word goal', () => {
    const result = parseOrchestrateInteractiveArgs(['Build', 'the', 'auth', 'system']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.goal).toBe('Build the auth system');
  });

  it('should parse --agent flag', () => {
    const result = parseOrchestrateInteractiveArgs(['--agent', 'codex', 'goal']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.agent).toBe('codex');
  });

  it('should parse --model flag', () => {
    const result = parseOrchestrateInteractiveArgs(['--model', 'o3', 'goal']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.model).toBe('o3');
  });

  it('should parse -w flag', () => {
    const result = parseOrchestrateInteractiveArgs(['-w', '/tmp', 'goal']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.workingDirectory).toBe('/tmp');
  });

  it('should parse --system-prompt flag', () => {
    const result = parseOrchestrateInteractiveArgs(['--system-prompt', 'custom prompt', 'goal']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.systemPrompt).toBe('custom prompt');
  });

  it('should parse --max-depth flag', () => {
    const result = parseOrchestrateInteractiveArgs(['--max-depth', '5', 'goal']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.maxDepth).toBe(5);
  });

  it('should parse --max-workers flag', () => {
    const result = parseOrchestrateInteractiveArgs(['--max-workers', '3', 'goal']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.maxWorkers).toBe(3);
  });

  it('should reject --foreground as mutually exclusive', () => {
    const result = parseOrchestrateInteractiveArgs(['--foreground', 'goal']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('mutually exclusive');
  });

  it('should reject -f as mutually exclusive', () => {
    const result = parseOrchestrateInteractiveArgs(['-f', 'goal']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('mutually exclusive');
  });

  it('should reject --max-iterations as irrelevant', () => {
    const result = parseOrchestrateInteractiveArgs(['--max-iterations', '10', 'goal']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('irrelevant');
  });

  it('should return error when goal is missing', () => {
    const result = parseOrchestrateInteractiveArgs([]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('goal is required');
  });

  it('should reject unknown flags', () => {
    const result = parseOrchestrateInteractiveArgs(['--unknown-flag', 'goal']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('Unknown flag');
  });

  it('should parse all common flags together', () => {
    const result = parseOrchestrateInteractiveArgs([
      '--agent',
      'codex',
      '--model',
      'o3',
      '-w',
      '/tmp',
      '--max-depth',
      '5',
      '--max-workers',
      '3',
      '--system-prompt',
      'custom',
      'Build',
      'API',
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.agent).toBe('codex');
    expect(result.value.model).toBe('o3');
    expect(result.value.workingDirectory).toBe('/tmp');
    expect(result.value.maxDepth).toBe(5);
    expect(result.value.maxWorkers).toBe(3);
    expect(result.value.systemPrompt).toBe('custom');
    expect(result.value.goal).toBe('Build API');
  });
});

// ============================================================================
// parseOrchestrateInitArgs — template flag
// ============================================================================

describe('parseOrchestrateInitArgs - template flag', () => {
  it('should parse --template interactive', () => {
    const result = parseOrchestrateInitArgs(['--template', 'interactive', 'goal']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.template).toBe('interactive');
  });

  it('should parse --template standard', () => {
    const result = parseOrchestrateInitArgs(['--template', 'standard', 'goal']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.template).toBe('standard');
  });

  it('should have template undefined when not specified', () => {
    const result = parseOrchestrateInitArgs(['goal']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.template).toBeUndefined();
  });

  it('should reject unknown template values', () => {
    const result = parseOrchestrateInitArgs(['--template', 'bogus', 'goal']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('Unknown template');
  });

  it('should reject --template without value', () => {
    const result = parseOrchestrateInitArgs(['--template']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('requires a value');
  });
});

// ============================================================================
// Agent Adapter — buildInteractiveArgs
// ============================================================================

vi.mock('child_process', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return { ...original, spawn: vi.fn(), spawnSync: vi.fn() };
});

vi.mock('../../src/core/agents', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return { ...original, isCommandInPath: vi.fn().mockReturnValue(true) };
});

import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import { isCommandInPath } from '../../src/core/agents.js';
import type { Configuration } from '../../src/core/configuration.js';
import { ClaudeAdapter } from '../../src/implementations/claude-adapter.js';
import { CodexAdapter } from '../../src/implementations/codex-adapter.js';
import { GeminiAdapter } from '../../src/implementations/gemini-adapter.js';

const mockSpawn = vi.mocked(spawn);
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

function createMockChildProcess(pid: number): ChildProcess {
  return {
    pid,
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
  } as unknown as ChildProcess;
}

describe('buildInteractiveArgs - Claude', () => {
  let adapter: ClaudeAdapter;
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsCommandInPath.mockReturnValue(true);
    adapter = new ClaudeAdapter(testConfig, 'claude');
  });
  afterEach(() => adapter.dispose());

  it('should omit --print flag', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    adapter.spawnInteractive({ prompt: 'test prompt', workingDirectory: '/workspace' });

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).not.toContain('--print');
  });

  it('should omit --output-format json', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    adapter.spawnInteractive({ prompt: 'test prompt', workingDirectory: '/workspace' });

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).not.toContain('--output-format');
    expect(args).not.toContain('json');
  });

  it('should include --dangerously-skip-permissions', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    adapter.spawnInteractive({ prompt: 'test prompt', workingDirectory: '/workspace' });

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('--dangerously-skip-permissions');
  });

  it('should include model when provided', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    adapter.spawnInteractive({ prompt: 'test prompt', workingDirectory: '/workspace', model: 'opus-4' });

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('--model');
    expect(args).toContain('opus-4');
  });

  it('should use -- separator before prompt', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    adapter.spawnInteractive({ prompt: 'test prompt', workingDirectory: '/workspace' });

    const [, args] = mockSpawn.mock.calls[0];
    const separatorIdx = args!.indexOf('--');
    expect(separatorIdx).toBeGreaterThan(-1);
    expect(args![separatorIdx + 1]).toBe('test prompt');
  });

  it('should not include --json-schema', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    adapter.spawnInteractive({ prompt: 'test prompt', workingDirectory: '/workspace' });

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).not.toContain('--json-schema');
  });
});

describe('buildInteractiveArgs - Codex', () => {
  let adapter: CodexAdapter;
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsCommandInPath.mockReturnValue(true);
    adapter = new CodexAdapter(testConfig, 'codex');
  });
  afterEach(() => adapter.dispose());

  it('should omit --quiet', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    adapter.spawnInteractive({ prompt: 'test prompt', workingDirectory: '/workspace' });

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).not.toContain('--quiet');
  });

  it('should include --full-auto', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    adapter.spawnInteractive({ prompt: 'test prompt', workingDirectory: '/workspace' });

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('--full-auto');
  });

  it('should include model when provided', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    adapter.spawnInteractive({ prompt: 'test prompt', workingDirectory: '/workspace', model: 'o3' });

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('--model');
    expect(args).toContain('o3');
  });
});

describe('buildInteractiveArgs - Gemini', () => {
  let adapter: GeminiAdapter;
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsCommandInPath.mockReturnValue(true);
    adapter = new GeminiAdapter(testConfig, 'gemini');
  });
  afterEach(() => adapter.dispose());

  it('should omit --prompt flag', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    adapter.spawnInteractive({ prompt: 'test prompt', workingDirectory: '/workspace' });

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).not.toContain('--prompt');
  });

  it('should include --yolo', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    adapter.spawnInteractive({ prompt: 'test prompt', workingDirectory: '/workspace' });

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('--yolo');
  });

  it('should include model when provided', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    adapter.spawnInteractive({ prompt: 'test prompt', workingDirectory: '/workspace', model: 'gemini-2.5-pro' });

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('--model');
    expect(args).toContain('gemini-2.5-pro');
  });
});

// ============================================================================
// spawnInteractive — shared behavior
// ============================================================================

describe('spawnInteractive - shared behavior', () => {
  let adapter: ClaudeAdapter;
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsCommandInPath.mockReturnValue(true);
    adapter = new ClaudeAdapter(testConfig, 'claude');
  });
  afterEach(() => adapter.dispose());

  it('should call spawn with stdio: inherit', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    adapter.spawnInteractive({ prompt: 'test prompt', workingDirectory: '/workspace' });

    const spawnOptions = mockSpawn.mock.calls[0][2] as { stdio: string };
    expect(spawnOptions.stdio).toBe('inherit');
  });

  it('should not set AUTOBEAT_WORKER env', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    adapter.spawnInteractive({ prompt: 'test prompt', workingDirectory: '/workspace' });

    const spawnOptions = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
    expect(spawnOptions.env.AUTOBEAT_WORKER).toBeUndefined();
  });

  it('should set AUTOBEAT_ORCHESTRATOR_ID when provided', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    adapter.spawnInteractive({
      prompt: 'test prompt',
      workingDirectory: '/workspace',
      orchestratorId: 'orchestrator-12345678-1234-1234-1234-123456789012',
    });

    const spawnOptions = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
    expect(spawnOptions.env.AUTOBEAT_ORCHESTRATOR_ID).toBe('orchestrator-12345678-1234-1234-1234-123456789012');
  });

  it('should return error when CLI binary not found', () => {
    mockIsCommandInPath.mockReturnValue(false);

    const result = adapter.spawnInteractive({ prompt: 'test', workingDirectory: '/workspace' });

    expect(result.ok).toBe(false);
  });

  it('should include system prompt args', () => {
    const mockChild = createMockChildProcess(1234);
    mockSpawn.mockReturnValue(mockChild);

    adapter.spawnInteractive({
      prompt: 'test prompt',
      workingDirectory: '/workspace',
      systemPrompt: 'You are a helpful assistant',
    });

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('--append-system-prompt');
    expect(args).toContain('You are a helpful assistant');
  });
});

// ============================================================================
// OrchestrationManagerService — createInteractiveOrchestration
// ============================================================================

vi.mock('../../src/utils/git-state.js', () => ({
  captureGitState: vi.fn().mockResolvedValue({ ok: true, value: null }),
  getCurrentCommitSha: vi.fn().mockResolvedValue({ ok: true, value: 'abc1234567890abcdef1234567890abcdef123456' }),
  captureLoopGitContext: vi.fn().mockResolvedValue({ ok: true, value: {} }),
  validateGitRefName: vi.fn().mockReturnValue({ ok: true, value: undefined }),
}));

import { OrchestratorId, OrchestratorStatus } from '../../src/core/domain.js';
import { Database } from '../../src/implementations/database.js';
import { SQLiteLoopRepository } from '../../src/implementations/loop-repository.js';
import { SQLiteOrchestrationRepository } from '../../src/implementations/orchestration-repository.js';
import { LoopManagerService } from '../../src/services/loop-manager.js';
import { OrchestrationManagerService } from '../../src/services/orchestration-manager.js';
import { createTestConfiguration } from '../fixtures/factories.js';
import { TestEventBus, TestLogger } from '../fixtures/test-doubles.js';

describe('createInteractiveOrchestration', () => {
  let db: Database;
  let orchestrationRepo: SQLiteOrchestrationRepository;
  let eventBus: TestEventBus;
  let logger: TestLogger;
  let service: OrchestrationManagerService;
  const createdStateFiles: string[] = [];
  const config = createTestConfiguration({ defaultAgent: 'claude' });

  beforeEach(() => {
    db = new Database(':memory:');
    const loopRepo = new SQLiteLoopRepository(db);
    orchestrationRepo = new SQLiteOrchestrationRepository(db);
    eventBus = new TestEventBus();
    logger = new TestLogger();
    const loopService = new LoopManagerService(eventBus, logger, loopRepo, config);
    service = new OrchestrationManagerService({ eventBus, logger, orchestrationRepo, loopService, config });
  });

  afterEach(() => {
    db.close();
    for (const f of createdStateFiles) {
      try {
        unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
    createdStateFiles.length = 0;
  });

  it('should create at RUNNING status with mode: interactive', async () => {
    const result = await service.createInteractiveOrchestration({ goal: 'Build auth' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdStateFiles.push(result.value.orchestration.stateFilePath);

    expect(result.value.orchestration.status).toBe(OrchestratorStatus.RUNNING);
    expect(result.value.orchestration.mode).toBe('interactive');
  });

  it('should have loopId undefined', async () => {
    const result = await service.createInteractiveOrchestration({ goal: 'Build auth' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdStateFiles.push(result.value.orchestration.stateFilePath);

    expect(result.value.orchestration.loopId).toBeUndefined();
  });

  it('should return systemPrompt with INTERACTIVE MODE addendum', async () => {
    const result = await service.createInteractiveOrchestration({ goal: 'Build auth' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdStateFiles.push(result.value.orchestration.stateFilePath);

    expect(result.value.systemPrompt).toContain('INTERACTIVE MODE');
  });

  it('should return userPrompt with goal', async () => {
    const result = await service.createInteractiveOrchestration({ goal: 'Build auth' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdStateFiles.push(result.value.orchestration.stateFilePath);

    expect(result.value.userPrompt).toContain('Build auth');
  });

  it('should validate empty goal', async () => {
    const result = await service.createInteractiveOrchestration({ goal: '' });
    expect(result.ok).toBe(false);
  });

  it('should emit OrchestrationCreated event', async () => {
    const result = await service.createInteractiveOrchestration({ goal: 'Build auth' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdStateFiles.push(result.value.orchestration.stateFilePath);

    expect(eventBus.emittedEvents.some((e) => e.type === 'OrchestrationCreated')).toBe(true);
  });

  it('should append addendum after custom systemPrompt', async () => {
    const result = await service.createInteractiveOrchestration({
      goal: 'Build auth',
      systemPrompt: 'Custom instructions here',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdStateFiles.push(result.value.orchestration.stateFilePath);

    expect(result.value.systemPrompt).toContain('Custom instructions here');
    expect(result.value.systemPrompt).toContain('INTERACTIVE MODE');
    const customIdx = result.value.systemPrompt.indexOf('Custom instructions here');
    const interactiveIdx = result.value.systemPrompt.indexOf('INTERACTIVE MODE');
    expect(interactiveIdx).toBeGreaterThan(customIdx);
  });

  it('should persist orchestration to DB', async () => {
    const result = await service.createInteractiveOrchestration({ goal: 'Build auth' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdStateFiles.push(result.value.orchestration.stateFilePath);

    const dbResult = await orchestrationRepo.findById(result.value.orchestration.id);
    expect(dbResult.ok).toBe(true);
    if (!dbResult.ok) return;
    expect(dbResult.value).not.toBeNull();
    expect(dbResult.value!.mode).toBe('interactive');
    expect(dbResult.value!.status).toBe('running');
  });
});

// ============================================================================
// cancelOrchestration — interactive mode
// ============================================================================

describe('cancelOrchestration - interactive mode', () => {
  let db: Database;
  let orchestrationRepo: SQLiteOrchestrationRepository;
  let eventBus: TestEventBus;
  let logger: TestLogger;
  let service: OrchestrationManagerService;
  const createdStateFiles: string[] = [];
  const config = createTestConfiguration({ defaultAgent: 'claude' });

  beforeEach(() => {
    db = new Database(':memory:');
    const loopRepo = new SQLiteLoopRepository(db);
    orchestrationRepo = new SQLiteOrchestrationRepository(db);
    eventBus = new TestEventBus();
    logger = new TestLogger();
    const loopService = new LoopManagerService(eventBus, logger, loopRepo, config);
    service = new OrchestrationManagerService({ eventBus, logger, orchestrationRepo, loopService, config });
  });

  afterEach(() => {
    db.close();
    for (const f of createdStateFiles) {
      try {
        unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
    createdStateFiles.length = 0;
  });

  it('should update DB to CANCELLED for interactive orchestration', async () => {
    const createResult = await service.createInteractiveOrchestration({ goal: 'Test' });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;
    createdStateFiles.push(createResult.value.orchestration.stateFilePath);

    const cancelResult = await service.cancelOrchestration(createResult.value.orchestration.id);
    expect(cancelResult.ok).toBe(true);

    const dbResult = await orchestrationRepo.findById(createResult.value.orchestration.id);
    expect(dbResult.ok).toBe(true);
    if (!dbResult.ok) return;
    expect(dbResult.value!.status).toBe('cancelled');
  });

  it('should emit OrchestrationCancelled event', async () => {
    const createResult = await service.createInteractiveOrchestration({ goal: 'Test' });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;
    createdStateFiles.push(createResult.value.orchestration.stateFilePath);

    await service.cancelOrchestration(createResult.value.orchestration.id);

    expect(eventBus.emittedEvents.some((e) => e.type === 'OrchestrationCancelled')).toBe(true);
  });
});

// ============================================================================
// Migration v25
// ============================================================================

describe('migration v25 - mode and pid columns', () => {
  it('should add mode column with NULL default', () => {
    const db = new Database(':memory:');
    const rawDb = db.getDatabase();
    const columns = rawDb.pragma('table_info(orchestrations)') as Array<{ name: string; dflt_value: string | null }>;
    const modeCol = columns.find((c) => c.name === 'mode');
    expect(modeCol).toBeDefined();
    expect(modeCol!.dflt_value).toBe('NULL');
    db.close();
  });

  it('should add pid column with NULL default', () => {
    const db = new Database(':memory:');
    const rawDb = db.getDatabase();
    const columns = rawDb.pragma('table_info(orchestrations)') as Array<{ name: string; dflt_value: string | null }>;
    const pidCol = columns.find((c) => c.name === 'pid');
    expect(pidCol).toBeDefined();
    expect(pidCol!.dflt_value).toBe('NULL');
    db.close();
  });

  it('should be at schema version 25', () => {
    const db = new Database(':memory:');
    expect(db.getSchemaVersion()).toBe(25);
    db.close();
  });
});

// ============================================================================
// Scaffold — interactive template
// ============================================================================

import { scaffoldCustomOrchestrator } from '../../src/core/orchestrator-scaffold.js';

describe('scaffoldCustomOrchestrator - interactive template', () => {
  const createdFiles: string[] = [];

  afterEach(() => {
    for (const f of createdFiles) {
      try {
        unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
    createdFiles.length = 0;
  });

  it('should create state file for interactive template', () => {
    const result = scaffoldCustomOrchestrator({ goal: 'Build API', template: 'interactive' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdFiles.push(result.value.stateFilePath);
    expect(result.value.stateFilePath).toContain('state-');
  });

  it('should NOT create exit condition script for interactive template', () => {
    const result = scaffoldCustomOrchestrator({ goal: 'Build API', template: 'interactive' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdFiles.push(result.value.stateFilePath);
    expect(result.value.exitConditionScript).toBeUndefined();
    expect(result.value.suggestedExitCondition).toBeUndefined();
  });

  it('should have suggestedCommand containing "beat orchestrate -i"', () => {
    const result = scaffoldCustomOrchestrator({ goal: 'Build API', template: 'interactive' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdFiles.push(result.value.stateFilePath);
    expect(result.value.suggestedCommand).toContain('beat orchestrate -i');
  });

  it('should include instructions for interactive template', () => {
    const result = scaffoldCustomOrchestrator({ goal: 'Build API', template: 'interactive' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdFiles.push(result.value.stateFilePath);
    expect(result.value.instructions.delegation).toBeTruthy();
    expect(result.value.instructions.stateManagement).toBeTruthy();
    expect(result.value.instructions.constraints).toBeTruthy();
  });

  it('should create exit condition script for standard template (regression)', () => {
    const result = scaffoldCustomOrchestrator({ goal: 'Build API', template: 'standard' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdFiles.push(result.value.stateFilePath);
    if (result.value.exitConditionScript) createdFiles.push(result.value.exitConditionScript);
    expect(result.value.exitConditionScript).toBeDefined();
    expect(result.value.suggestedExitCondition).toBeDefined();
  });

  it('should have suggestedCommand containing "beat loop" for standard template', () => {
    const result = scaffoldCustomOrchestrator({ goal: 'Build API', template: 'standard' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdFiles.push(result.value.stateFilePath);
    if (result.value.exitConditionScript) createdFiles.push(result.value.exitConditionScript);
    expect(result.value.suggestedCommand).toContain('beat loop');
  });

  it('should default to standard when no template specified (backward compat)', () => {
    const result = scaffoldCustomOrchestrator({ goal: 'Build API' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdFiles.push(result.value.stateFilePath);
    if (result.value.exitConditionScript) createdFiles.push(result.value.exitConditionScript);
    expect(result.value.exitConditionScript).toBeDefined();
    expect(result.value.suggestedCommand).toContain('beat loop');
  });

  it('should include agent in suggestedCommand for interactive', () => {
    const result = scaffoldCustomOrchestrator({ goal: 'Build API', template: 'interactive', agent: 'codex' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdFiles.push(result.value.stateFilePath);
    expect(result.value.suggestedCommand).toContain('--agent codex');
  });
});

// ============================================================================
// Orchestration liveness — interactive mode
// ============================================================================

import type { Orchestration } from '../../src/core/domain.js';
import { checkOrchestrationLiveness } from '../../src/services/orchestration-liveness.js';

describe('checkOrchestrationLiveness - interactive mode', () => {
  const mockDeps = {
    loopRepo: {} as Parameters<typeof checkOrchestrationLiveness>[1]['loopRepo'],
    taskRepo: {} as Parameters<typeof checkOrchestrationLiveness>[1]['taskRepo'],
    workerRepo: {} as Parameters<typeof checkOrchestrationLiveness>[1]['workerRepo'],
    isProcessAlive: vi.fn(),
  };

  it('should return live when interactive PID is alive', async () => {
    mockDeps.isProcessAlive.mockReturnValue(true);
    const orch = { mode: 'interactive', pid: 1234, status: 'running' } as unknown as Orchestration;

    const result = await checkOrchestrationLiveness(orch, mockDeps);
    expect(result).toBe('live');
    expect(mockDeps.isProcessAlive).toHaveBeenCalledWith(1234);
  });

  it('should return dead when interactive PID is dead', async () => {
    mockDeps.isProcessAlive.mockReturnValue(false);
    const orch = { mode: 'interactive', pid: 1234, status: 'running' } as unknown as Orchestration;

    const result = await checkOrchestrationLiveness(orch, mockDeps);
    expect(result).toBe('dead');
  });

  it('should return unknown when interactive has no PID', async () => {
    const orch = { mode: 'interactive', status: 'running' } as unknown as Orchestration;

    const result = await checkOrchestrationLiveness(orch, mockDeps);
    expect(result).toBe('unknown');
  });
});
