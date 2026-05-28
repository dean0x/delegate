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

import { parseOrchestrateCreateArgs, parseOrchestrateInitArgs } from '../../src/cli/commands/orchestrate.js';
import { parseOrchestrateInteractiveArgs } from '../../src/cli/commands/orchestrate-interactive.js';

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

// ============================================================================
// OrchestrationManagerService — createInteractiveOrchestration
// ============================================================================

vi.mock('../../src/utils/git-state.js', () => ({
  captureGitState: vi.fn().mockResolvedValue({ ok: true, value: null }),
  getCurrentCommitSha: vi.fn().mockResolvedValue({ ok: true, value: 'abc1234567890abcdef1234567890abcdef123456' }),
  captureLoopGitContext: vi.fn().mockResolvedValue({ ok: true, value: {} }),
  validateGitRefName: vi.fn().mockReturnValue({ ok: true, value: undefined }),
}));

import { OrchestratorId, OrchestratorStatus, updateOrchestration } from '../../src/core/domain.js';
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

  it('should succeed when stored PID is not a live process (ESRCH path)', async () => {
    // Exercises the process.kill(pid, 'SIGTERM') branch in cancelOrchestration for
    // interactive mode. PID 99999 passes validation (positive integer) but is
    // virtually guaranteed not to exist, so process.kill throws ESRCH. The cancel
    // must still complete successfully and mark the orchestration as CANCELLED.
    const createResult = await service.createInteractiveOrchestration({ goal: 'Test SIGTERM path' });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;
    createdStateFiles.push(createResult.value.orchestration.stateFilePath);

    // Seed a PID directly via the repo to simulate a pre-Phase-5 orchestration row
    // (updateInteractiveOrchestrationPid was the public API for this; now removed).
    const withPid = updateOrchestration(createResult.value.orchestration, { pid: 99999 });
    await orchestrationRepo.update(withPid);

    const cancelResult = await service.cancelOrchestration(createResult.value.orchestration.id);
    expect(cancelResult.ok).toBe(true);

    const dbResult = await orchestrationRepo.findById(createResult.value.orchestration.id);
    expect(dbResult.ok).toBe(true);
    if (!dbResult.ok) return;
    expect(dbResult.value!.status).toBe('cancelled');
  });
});

// ============================================================================
// finalizeInteractiveOrchestration
// ============================================================================

describe('finalizeInteractiveOrchestration', () => {
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

  it('should set COMPLETED and emit OrchestrationCompleted on exitCode=0', async () => {
    const createResult = await service.createInteractiveOrchestration({ goal: 'Test finalize' });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;
    createdStateFiles.push(createResult.value.orchestration.stateFilePath);
    const id = createResult.value.orchestration.id;

    const result = await service.finalizeInteractiveOrchestration(id, { exitCode: 0, cancelled: false });
    expect(result.ok).toBe(true);

    const dbResult = await orchestrationRepo.findById(id);
    expect(dbResult.ok).toBe(true);
    expect(dbResult.value!.status).toBe('completed');
    expect(dbResult.value!.completedAt).toBeGreaterThan(0);

    expect(eventBus.getEventCount('OrchestrationCompleted')).toBe(1);
    const payloads = eventBus.getEmittedEvents('OrchestrationCompleted');
    expect(payloads[0]).toMatchObject({ orchestratorId: id, reason: expect.any(String) });
  });

  it('should set CANCELLED and emit OrchestrationCancelled when cancelled=true', async () => {
    const createResult = await service.createInteractiveOrchestration({ goal: 'Test cancel' });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;
    createdStateFiles.push(createResult.value.orchestration.stateFilePath);
    const id = createResult.value.orchestration.id;

    const result = await service.finalizeInteractiveOrchestration(id, { exitCode: null, cancelled: true });
    expect(result.ok).toBe(true);

    const dbResult = await orchestrationRepo.findById(id);
    expect(dbResult.ok).toBe(true);
    expect(dbResult.value!.status).toBe('cancelled');

    expect(eventBus.getEventCount('OrchestrationCancelled')).toBe(1);
  });

  it('should set FAILED and emit NO events on exitCode=1 (DECISION)', async () => {
    const createResult = await service.createInteractiveOrchestration({ goal: 'Test fail' });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;
    createdStateFiles.push(createResult.value.orchestration.stateFilePath);
    const id = createResult.value.orchestration.id;

    const result = await service.finalizeInteractiveOrchestration(id, { exitCode: 1, cancelled: false });
    expect(result.ok).toBe(true);

    const dbResult = await orchestrationRepo.findById(id);
    expect(dbResult.ok).toBe(true);
    expect(dbResult.value!.status).toBe('failed');

    expect(eventBus.getEventCount('OrchestrationCompleted')).toBe(0);
    expect(eventBus.getEventCount('OrchestrationCancelled')).toBe(0);
  });

  it('should be idempotent — second finalize is a no-op', async () => {
    const createResult = await service.createInteractiveOrchestration({ goal: 'Test idempotent' });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;
    createdStateFiles.push(createResult.value.orchestration.stateFilePath);
    const id = createResult.value.orchestration.id;

    const first = await service.finalizeInteractiveOrchestration(id, { exitCode: 0, cancelled: false });
    expect(first.ok).toBe(true);

    const second = await service.finalizeInteractiveOrchestration(id, { exitCode: 1, cancelled: false });
    expect(second.ok).toBe(true);

    const dbResult = await orchestrationRepo.findById(id);
    expect(dbResult.ok).toBe(true);
    expect(dbResult.value!.status).toBe('completed');

    expect(eventBus.getEventCount('OrchestrationCompleted')).toBe(1);
  });

  it('should return err for non-existent orchestration', async () => {
    const result = await service.finalizeInteractiveOrchestration('orchestrator-nonexistent' as OrchestratorId, {
      exitCode: 0,
      cancelled: false,
    });
    expect(result.ok).toBe(false);
    expect(eventBus.getEventCount('OrchestrationCompleted')).toBe(0);
  });

  it('should reject finalization of non-interactive orchestration (mode guard)', async () => {
    // Create an interactive orchestration, then clear mode in DB to simulate a standard one.
    const createResult = await service.createInteractiveOrchestration({ goal: 'Guard test' });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;
    createdStateFiles.push(createResult.value.orchestration.stateFilePath);
    const id = createResult.value.orchestration.id;

    // Manually clear mode to simulate a standard orchestration
    const rawDb = db.getDatabase();
    rawDb.exec(`UPDATE orchestrations SET mode = NULL WHERE id = '${id}'`);

    eventBus.clearEmittedEvents();

    const result = await service.finalizeInteractiveOrchestration(id, { exitCode: 0, cancelled: false });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('non-interactive');
    expect(eventBus.getEventCount('OrchestrationCompleted')).toBe(0);
  });

  it('should set FAILED on spawn failure (exitCode=null, cancelled=false)', async () => {
    const createResult = await service.createInteractiveOrchestration({ goal: 'Test spawn fail' });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;
    createdStateFiles.push(createResult.value.orchestration.stateFilePath);
    const id = createResult.value.orchestration.id;

    const result = await service.finalizeInteractiveOrchestration(id, { exitCode: null, cancelled: false });
    expect(result.ok).toBe(true);

    const dbResult = await orchestrationRepo.findById(id);
    expect(dbResult.ok).toBe(true);
    expect(dbResult.value!.status).toBe('failed');

    expect(eventBus.getEventCount('OrchestrationCompleted')).toBe(0);
    expect(eventBus.getEventCount('OrchestrationCancelled')).toBe(0);
  });

  it('should be no-op when remote cancel races finalize', async () => {
    const createResult = await service.createInteractiveOrchestration({ goal: 'Test race' });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;
    createdStateFiles.push(createResult.value.orchestration.stateFilePath);
    const id = createResult.value.orchestration.id;

    const cancelResult = await service.cancelOrchestration(id);
    expect(cancelResult.ok).toBe(true);

    eventBus.clearEmittedEvents();

    const finalizeResult = await service.finalizeInteractiveOrchestration(id, { exitCode: 143, cancelled: false });
    expect(finalizeResult.ok).toBe(true);

    const dbResult = await orchestrationRepo.findById(id);
    expect(dbResult.ok).toBe(true);
    expect(dbResult.value!.status).toBe('cancelled');

    expect(eventBus.getEventCount('OrchestrationCancelled')).toBe(0);
    expect(eventBus.getEventCount('OrchestrationCompleted')).toBe(0);
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

  it('should be at schema version 32', () => {
    const db = new Database(':memory:');
    expect(db.getSchemaVersion()).toBe(32);
    db.close();
  });
});

// ============================================================================
// Migration v30 — session_name column on orchestrations
// ============================================================================

describe('migration v30 - session_name column on orchestrations', () => {
  it('should add session_name column (nullable TEXT)', () => {
    const db = new Database(':memory:');
    const rawDb = db.getDatabase();
    const columns = rawDb.pragma('table_info(orchestrations)') as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const col = columns.find((c) => c.name === 'session_name');
    expect(col).toBeDefined();
    expect(col!.type).toBe('TEXT');
    expect(col!.notnull).toBe(0); // nullable
    db.close();
  });

  it('should create idx_orchestrations_session_name index', () => {
    const db = new Database(':memory:');
    const rawDb = db.getDatabase();
    const indexes = rawDb.pragma('index_list(orchestrations)') as Array<{ name: string }>;
    const idx = indexes.find((i) => i.name === 'idx_orchestrations_session_name');
    expect(idx).toBeDefined();
    db.close();
  });
});

// ============================================================================
// updateInteractiveOrchestrationSessionName
// ============================================================================

describe('updateInteractiveOrchestrationSessionName', () => {
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

  it('should store session name and set pid=0 sentinel', async () => {
    const createResult = await service.createInteractiveOrchestration({ goal: 'Test session name' });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;
    createdStateFiles.push(createResult.value.orchestration.stateFilePath);
    const id = createResult.value.orchestration.id;

    const updateResult = await service.updateInteractiveOrchestrationSessionName(id, 'beat-task-testid-abcdef');
    expect(updateResult.ok).toBe(true);
    if (!updateResult.ok) return;
    expect(updateResult.value).toBe(true);

    const dbResult = await orchestrationRepo.findById(id);
    expect(dbResult.ok).toBe(true);
    if (!dbResult.ok) return;
    expect(dbResult.value!.sessionName).toBe('beat-task-testid-abcdef');
    // pid=0 sentinel (tmux worker convention from migration v29)
    expect(dbResult.value!.pid).toBe(0);
  });

  it('should reject empty session name', async () => {
    const createResult = await service.createInteractiveOrchestration({ goal: 'Test empty session name' });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;
    createdStateFiles.push(createResult.value.orchestration.stateFilePath);

    const updateResult = await service.updateInteractiveOrchestrationSessionName(
      createResult.value.orchestration.id,
      '',
    );
    expect(updateResult.ok).toBe(false);
    if (updateResult.ok) return;
    expect(updateResult.error.message).toContain('sessionName must be a non-empty string');
  });

  it('should return false when orchestration already cancelled', async () => {
    const createResult = await service.createInteractiveOrchestration({ goal: 'Test cancel race' });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;
    createdStateFiles.push(createResult.value.orchestration.stateFilePath);
    const id = createResult.value.orchestration.id;

    const cancelResult = await service.cancelOrchestration(id);
    expect(cancelResult.ok).toBe(true);

    const updateResult = await service.updateInteractiveOrchestrationSessionName(id, 'beat-task-xxx');
    expect(updateResult.ok).toBe(true);
    if (!updateResult.ok) return;
    expect(updateResult.value).toBe(false);

    const dbResult = await orchestrationRepo.findById(id);
    expect(dbResult.ok).toBe(true);
    if (!dbResult.ok) return;
    expect(dbResult.value!.sessionName).toBeUndefined();
    expect(dbResult.value!.status).toBe('cancelled');
  });
});

// ============================================================================
// cancelOrchestration — session_name path (Phase 5 tmux destroy)
// ============================================================================

describe('cancelOrchestration - session_name tmux destroy path', () => {
  let db: Database;
  let orchestrationRepo: SQLiteOrchestrationRepository;
  let eventBus: TestEventBus;
  let logger: TestLogger;
  let service: OrchestrationManagerService;
  const createdStateFiles: string[] = [];
  const config = createTestConfiguration({ defaultAgent: 'claude' });

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

  it('should call tmuxSessionManager.destroySession when session_name is set', async () => {
    const mockDestroySession = vi.fn().mockReturnValue({ ok: true, value: undefined });
    const mockTmuxSessionManager = {
      isAlive: vi.fn(),
      sendControlKeys: vi.fn(),
      listSessions: vi.fn(),
      destroySession: mockDestroySession,
    };

    db = new Database(':memory:');
    const loopRepo = new SQLiteLoopRepository(db);
    orchestrationRepo = new SQLiteOrchestrationRepository(db);
    eventBus = new TestEventBus();
    logger = new TestLogger();
    const loopService = new LoopManagerService(eventBus, logger, loopRepo, config);
    service = new OrchestrationManagerService({
      eventBus,
      logger,
      orchestrationRepo,
      loopService,
      config,
      tmuxSessionManager: mockTmuxSessionManager,
    });

    const createResult = await service.createInteractiveOrchestration({ goal: 'Test session cancel' });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;
    createdStateFiles.push(createResult.value.orchestration.stateFilePath);
    const id = createResult.value.orchestration.id;

    const sessionNameResult = await service.updateInteractiveOrchestrationSessionName(id, 'beat-task-test-session');
    expect(sessionNameResult.ok).toBe(true);

    const cancelResult = await service.cancelOrchestration(id);
    expect(cancelResult.ok).toBe(true);

    expect(mockDestroySession).toHaveBeenCalledWith('beat-task-test-session');

    const dbResult = await orchestrationRepo.findById(id);
    expect(dbResult.ok).toBe(true);
    expect(dbResult.value!.status).toBe('cancelled');
  });

  it('should fall back to SIGTERM when no session_name but pid > 0', async () => {
    // No tmuxSessionManager — forces the pre-Phase-5 SIGTERM path
    db = new Database(':memory:');
    const loopRepo = new SQLiteLoopRepository(db);
    orchestrationRepo = new SQLiteOrchestrationRepository(db);
    eventBus = new TestEventBus();
    logger = new TestLogger();
    const loopService = new LoopManagerService(eventBus, logger, loopRepo, config);
    service = new OrchestrationManagerService({ eventBus, logger, orchestrationRepo, loopService, config });

    const createResult = await service.createInteractiveOrchestration({ goal: 'Test PID cancel' });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;
    createdStateFiles.push(createResult.value.orchestration.stateFilePath);
    const id = createResult.value.orchestration.id;

    // Seed a PID directly via the repo to simulate a pre-Phase-5 orchestration row
    // (updateInteractiveOrchestrationPid was the public API for this; now removed).
    // PID 99999 virtually guaranteed not to exist — ESRCH; cancel must still succeed.
    const withPid = updateOrchestration(createResult.value.orchestration, { pid: 99999 });
    await orchestrationRepo.update(withPid);

    const cancelResult = await service.cancelOrchestration(id);
    expect(cancelResult.ok).toBe(true);

    const dbResult = await orchestrationRepo.findById(id);
    expect(dbResult.ok).toBe(true);
    expect(dbResult.value!.status).toBe('cancelled');
  });

  it('should succeed even when destroySession returns an error', async () => {
    const mockTmuxSessionManager = {
      isAlive: vi.fn(),
      sendControlKeys: vi.fn(),
      listSessions: vi.fn(),
      destroySession: vi.fn().mockReturnValue({
        ok: false,
        error: { message: 'session already gone', code: 'SYSTEM_ERROR' },
      }),
    };

    db = new Database(':memory:');
    const loopRepo = new SQLiteLoopRepository(db);
    orchestrationRepo = new SQLiteOrchestrationRepository(db);
    eventBus = new TestEventBus();
    logger = new TestLogger();
    const loopService = new LoopManagerService(eventBus, logger, loopRepo, config);
    service = new OrchestrationManagerService({
      eventBus,
      logger,
      orchestrationRepo,
      loopService,
      config,
      tmuxSessionManager: mockTmuxSessionManager,
    });

    const createResult = await service.createInteractiveOrchestration({ goal: 'Test destroy error' });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;
    createdStateFiles.push(createResult.value.orchestration.stateFilePath);
    const id = createResult.value.orchestration.id;

    await service.updateInteractiveOrchestrationSessionName(id, 'beat-task-gone-session');

    const cancelResult = await service.cancelOrchestration(id);
    // Cancel should succeed even if destroy failed (session may already be gone)
    expect(cancelResult.ok).toBe(true);

    const dbResult = await orchestrationRepo.findById(id);
    expect(dbResult.ok).toBe(true);
    expect(dbResult.value!.status).toBe('cancelled');
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
    // Discriminant ensures these fields are absent at the type level for 'interactive'
    expect(result.value.template).toBe('interactive');
    expect('exitConditionScript' in result.value).toBe(false);
    expect('suggestedExitCondition' in result.value).toBe(false);
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
    expect(result.value.template).toBe('standard');
    if (result.value.template === 'standard') createdFiles.push(result.value.exitConditionScript);
    expect(result.value.template === 'standard' && result.value.exitConditionScript).toBeTruthy();
    expect(result.value.template === 'standard' && result.value.suggestedExitCondition).toBeTruthy();
  });

  it('should have suggestedCommand containing "beat loop" for standard template', () => {
    const result = scaffoldCustomOrchestrator({ goal: 'Build API', template: 'standard' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdFiles.push(result.value.stateFilePath);
    if (result.value.template === 'standard') createdFiles.push(result.value.exitConditionScript);
    expect(result.value.suggestedCommand).toContain('beat loop');
  });

  it('should default to standard when no template specified (backward compat)', () => {
    const result = scaffoldCustomOrchestrator({ goal: 'Build API' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdFiles.push(result.value.stateFilePath);
    expect(result.value.template).toBe('standard');
    if (result.value.template === 'standard') createdFiles.push(result.value.exitConditionScript);
    expect(result.value.template === 'standard' && result.value.exitConditionScript).toBeTruthy();
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
    isOrchestratorProcessAlive: vi.fn(),
    isTmuxSessionAlive: vi.fn().mockReturnValue(false),
  };

  it('should return live when interactive PID is alive', async () => {
    mockDeps.isOrchestratorProcessAlive.mockReturnValue(true);
    const orch = { mode: 'interactive', pid: 1234, status: 'running' } as unknown as Orchestration;

    const result = await checkOrchestrationLiveness(orch, mockDeps);
    expect(result).toBe('live');
    expect(mockDeps.isOrchestratorProcessAlive).toHaveBeenCalledWith(1234);
  });

  it('should return dead when interactive PID is dead', async () => {
    mockDeps.isOrchestratorProcessAlive.mockReturnValue(false);
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
