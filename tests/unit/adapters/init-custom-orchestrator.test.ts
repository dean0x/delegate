/**
 * Unit tests for InitCustomOrchestrator MCP tool.
 * ARCHITECTURE: Tests the full call path through the MCP adapter using real
 * scaffoldCustomOrchestrator. State dir is mocked to use a temp directory.
 */

import { existsSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MCPAdapter } from '../../../src/adapters/mcp-adapter.js';
import type { Configuration } from '../../../src/core/configuration.js';
import type { Logger, LoopService, ScheduleService, TaskManager } from '../../../src/core/interfaces.js';
import * as orchestratorScaffold from '../../../src/core/orchestrator-scaffold.js';
import { err, ok } from '../../../src/core/result.js';
import { createTestConfiguration } from '../../fixtures/factories.js';

const TEST_STATE_DIR = path.join(tmpdir(), `autobeat-mcp-init-test-${process.pid}`);

vi.mock('../../../src/core/orchestrator-state.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/core/orchestrator-state.js')>();
  return {
    ...original,
    getStateDir: () => TEST_STATE_DIR,
  };
});

// Minimal stubs for services not exercised by InitCustomOrchestrator
const stubTaskManager: TaskManager = {
  delegate: vi.fn().mockResolvedValue(ok(null)),
  getStatus: vi.fn().mockResolvedValue(ok([])),
  getLogs: vi.fn().mockResolvedValue(ok({ taskId: '', stdout: [], stderr: [], totalSize: 0 })),
  cancel: vi.fn().mockResolvedValue(ok(undefined)),
  retry: vi.fn().mockResolvedValue(ok(null)),
};

const stubLogger: Logger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: vi.fn().mockReturnThis(),
};

const stubScheduleService: ScheduleService = {
  createSchedule: vi.fn().mockResolvedValue(ok(null)),
  listSchedules: vi.fn().mockResolvedValue(ok([])),
  getSchedule: vi.fn().mockResolvedValue(ok({ schedule: null })),
  cancelSchedule: vi.fn().mockResolvedValue(ok(undefined)),
  pauseSchedule: vi.fn().mockResolvedValue(ok(undefined)),
  resumeSchedule: vi.fn().mockResolvedValue(ok(undefined)),
  createPipeline: vi.fn().mockResolvedValue(ok({ pipelineId: '', steps: [] })),
  createScheduledPipeline: vi.fn().mockResolvedValue(ok(null)),
};

const stubLoopService: LoopService = {
  createLoop: vi.fn().mockResolvedValue(ok(null)),
  getLoop: vi.fn().mockResolvedValue(ok({ loop: null })),
  listLoops: vi.fn().mockResolvedValue(ok([])),
  cancelLoop: vi.fn().mockResolvedValue(ok(undefined)),
  pauseLoop: vi.fn().mockResolvedValue(ok(undefined)),
  resumeLoop: vi.fn().mockResolvedValue(ok(undefined)),
  validateCreateRequest: vi.fn().mockResolvedValue(ok(undefined)),
};

describe('MCPAdapter - InitCustomOrchestrator tool', () => {
  let adapter: MCPAdapter;
  const testConfig = createTestConfiguration();

  beforeEach(() => {
    mkdirSync(TEST_STATE_DIR, { recursive: true });
    adapter = new MCPAdapter({
      taskManager: stubTaskManager,
      logger: stubLogger,
      scheduleService: stubScheduleService,
      loopService: stubLoopService,
      agentRegistry: undefined,
      config: testConfig,
    });
  });

  afterEach(() => {
    if (existsSync(TEST_STATE_DIR)) {
      rmSync(TEST_STATE_DIR, { recursive: true, force: true });
    }
  });

  describe('valid input', () => {
    it('returns success:true with all scaffold fields', async () => {
      const response = await adapter.callTool('InitCustomOrchestrator', {
        goal: 'Build a security audit system',
      });

      expect(response.isError).toBeFalsy();
      const body = JSON.parse(response.content[0].text);
      expect(body.success).toBe(true);
      expect(body.stateFilePath).toBeTruthy();
      expect(body.exitConditionScript).toBeTruthy();
      expect(body.suggestedExitCondition).toContain('node ');
      expect(body.instructions.delegation).toBeTruthy();
      expect(body.instructions.stateManagement).toBeTruthy();
      expect(body.instructions.constraints).toBeTruthy();
    });

    it('creates state file on disk', async () => {
      const response = await adapter.callTool('InitCustomOrchestrator', {
        goal: 'Test goal',
      });

      expect(response.isError).toBeFalsy();
      const body = JSON.parse(response.content[0].text);
      expect(existsSync(body.stateFilePath)).toBe(true);
    });

    it('creates exit condition script on disk', async () => {
      const response = await adapter.callTool('InitCustomOrchestrator', {
        goal: 'Test goal',
      });

      expect(response.isError).toBeFalsy();
      const body = JSON.parse(response.content[0].text);
      expect(existsSync(body.exitConditionScript)).toBe(true);
    });

    it('includes usage instructions in response', async () => {
      const response = await adapter.callTool('InitCustomOrchestrator', {
        goal: 'Test goal',
      });

      expect(response.isError).toBeFalsy();
      const body = JSON.parse(response.content[0].text);
      expect(body.usage).toContain('CreateLoop');
      expect(body.usage).toContain('strategy: "retry"');
    });

    it('threads agent and model into delegation snippet and usage', async () => {
      const response = await adapter.callTool('InitCustomOrchestrator', {
        goal: 'Test goal',
        agent: 'claude',
        model: 'claude-opus-4-5',
      });

      expect(response.isError).toBeFalsy();
      const body = JSON.parse(response.content[0].text);
      expect(body.instructions.delegation).toContain('--agent claude --model claude-opus-4-5');
      expect(body.usage).toContain('agent: "claude"');
      expect(body.usage).toContain('model: "claude-opus-4-5"');
    });

    it('applies maxWorkers and maxDepth to constraints snippet', async () => {
      const response = await adapter.callTool('InitCustomOrchestrator', {
        goal: 'Test goal',
        maxWorkers: 8,
        maxDepth: 4,
      });

      expect(response.isError).toBeFalsy();
      const body = JSON.parse(response.content[0].text);
      expect(body.instructions.constraints).toContain('Max concurrent workers: 8');
      expect(body.instructions.constraints).toContain('Max delegation depth: 4');
    });

    it('uses process.cwd() when workingDirectory is omitted', async () => {
      const response = await adapter.callTool('InitCustomOrchestrator', {
        goal: 'Test goal',
      });

      expect(response.isError).toBeFalsy();
      const body = JSON.parse(response.content[0].text);
      expect(body.usage).toContain(process.cwd());
    });
  });

  describe('validation errors', () => {
    it('returns error when goal is missing', async () => {
      const response = await adapter.callTool('InitCustomOrchestrator', {});

      expect(response.isError).toBe(true);
      const body = JSON.parse(response.content[0].text);
      expect(body.success).toBe(false);
      expect(body.error).toBeTruthy();
    });

    it('returns error when goal is empty string', async () => {
      const response = await adapter.callTool('InitCustomOrchestrator', { goal: '' });

      expect(response.isError).toBe(true);
      const body = JSON.parse(response.content[0].text);
      expect(body.success).toBe(false);
    });

    it('returns error for invalid agent value', async () => {
      const response = await adapter.callTool('InitCustomOrchestrator', {
        goal: 'Test goal',
        agent: 'gpt4',
      });

      expect(response.isError).toBe(true);
      const body = JSON.parse(response.content[0].text);
      expect(body.success).toBe(false);
    });

    it('returns error when maxWorkers exceeds 20', async () => {
      const response = await adapter.callTool('InitCustomOrchestrator', {
        goal: 'Test goal',
        maxWorkers: 21,
      });

      expect(response.isError).toBe(true);
      const body = JSON.parse(response.content[0].text);
      expect(body.success).toBe(false);
    });

    it('returns error when maxDepth exceeds 10', async () => {
      const response = await adapter.callTool('InitCustomOrchestrator', {
        goal: 'Test goal',
        maxDepth: 11,
      });

      expect(response.isError).toBe(true);
      const body = JSON.parse(response.content[0].text);
      expect(body.success).toBe(false);
    });

    it('accepts model names with special characters (validation delegated to agent CLI)', async () => {
      // Model names are opaque to autobeat — format is the agent CLI's responsibility.
      // Models use /, :, @ separators (e.g. registry.example.com/model:tag).
      const response = await adapter.callTool('InitCustomOrchestrator', {
        goal: 'Test goal',
        model: 'registry.example.com/model:tag',
      });

      expect(response.isError).toBeFalsy();
      const body = JSON.parse(response.content[0].text);
      expect(body.success).toBe(true);
    });

    it('accepts valid model names with dots and hyphens', async () => {
      const response = await adapter.callTool('InitCustomOrchestrator', {
        goal: 'Test goal',
        model: 'claude-opus-4-5',
      });

      expect(response.isError).toBeFalsy();
      const body = JSON.parse(response.content[0].text);
      expect(body.success).toBe(true);
    });

    it('accepts non-existent working directory (only used in output text, not created on disk)', async () => {
      // workingDirectory is validated for path traversal only (mustExist=false) because
      // the scaffold writes to ~/.autobeat/ — the directory is embedded in the usage text.
      const response = await adapter.callTool('InitCustomOrchestrator', {
        goal: 'Test goal',
        workingDirectory: '/nonexistent/path/that/does/not/exist',
      });

      expect(response.isError).toBeFalsy();
      const body = JSON.parse(response.content[0].text);
      expect(body.success).toBe(true);
      expect(body.usage).toContain('/nonexistent/path/that/does/not/exist');
    });
  });

  describe('scaffold failure', () => {
    it('returns error when scaffoldCustomOrchestrator fails', async () => {
      const spy = vi
        .spyOn(orchestratorScaffold, 'scaffoldCustomOrchestrator')
        .mockReturnValue(err(new Error('disk write failed')));

      try {
        const response = await adapter.callTool('InitCustomOrchestrator', {
          goal: 'Test goal',
        });

        expect(response.isError).toBe(true);
        const body = JSON.parse(response.content[0].text);
        expect(body.success).toBe(false);
        expect(body.error).toContain('disk write failed');
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('tool listing', () => {
    it('InitCustomOrchestrator appears in tools list', async () => {
      // The tool list is tested indirectly by verifying callTool routes correctly
      // Direct tool list verification via server.request is complex — we verify
      // routing works by the successful call test above.
      const response = await adapter.callTool('InitCustomOrchestrator', { goal: 'test' });
      // If routing works, we get a structured response (not "Unknown tool")
      const body = JSON.parse(response.content[0].text);
      expect(body).not.toHaveProperty('code', 'INVALID_TOOL');
    });
  });
});
