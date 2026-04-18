/**
 * Unit tests for orchestrator prompt builder
 * ARCHITECTURE: Tests pure function output for correct content
 *
 * v1.4.0: buildOrchestratorPrompt returns { systemPrompt, userPrompt }.
 * - systemPrompt: role/capability instructions (ROLE through RESILIENCE)
 * - userPrompt: the goal statement
 */

import { describe, expect, it } from 'vitest';
import { buildOrchestratorPrompt } from '../../../src/services/orchestrator-prompt.js';

describe('buildOrchestratorPrompt - Unit Tests', () => {
  const defaultParams = {
    goal: 'Build a complete authentication system',
    stateFilePath: '/home/user/.autobeat/orchestrator-state/state-123.json',
    workingDirectory: '/workspace/my-project',
    maxDepth: 3,
    maxWorkers: 5,
  };

  it('should return { systemPrompt, userPrompt } object', () => {
    const result = buildOrchestratorPrompt(defaultParams);
    expect(result).toHaveProperty('systemPrompt');
    expect(result).toHaveProperty('userPrompt');
    expect(typeof result.systemPrompt).toBe('string');
    expect(typeof result.userPrompt).toBe('string');
  });

  it('should include the goal in userPrompt', () => {
    const { userPrompt } = buildOrchestratorPrompt(defaultParams);
    expect(userPrompt).toContain('Build a complete authentication system');
  });

  it('should not include the goal in systemPrompt', () => {
    const { systemPrompt } = buildOrchestratorPrompt(defaultParams);
    expect(systemPrompt).not.toContain('Build a complete authentication system');
  });

  it('should include the state file path in systemPrompt', () => {
    const { systemPrompt } = buildOrchestratorPrompt(defaultParams);
    expect(systemPrompt).toContain('/home/user/.autobeat/orchestrator-state/state-123.json');
  });

  it('should include the working directory in systemPrompt', () => {
    const { systemPrompt } = buildOrchestratorPrompt(defaultParams);
    expect(systemPrompt).toContain('/workspace/my-project');
  });

  it('should include beat CLI commands in systemPrompt', () => {
    const { systemPrompt } = buildOrchestratorPrompt(defaultParams);
    expect(systemPrompt).toContain('beat run');
    expect(systemPrompt).toContain('beat status');
    expect(systemPrompt).toContain('beat logs');
    expect(systemPrompt).toContain('beat cancel');
  });

  it('should include maxWorkers constraint in systemPrompt', () => {
    const { systemPrompt } = buildOrchestratorPrompt({ ...defaultParams, maxWorkers: 10 });
    expect(systemPrompt).toContain('Max concurrent workers: 10');
  });

  it('should include maxDepth constraint in systemPrompt', () => {
    const { systemPrompt } = buildOrchestratorPrompt({ ...defaultParams, maxDepth: 7 });
    expect(systemPrompt).toContain('Max delegation depth: 7');
  });

  it('should include decision protocol in systemPrompt', () => {
    const { systemPrompt } = buildOrchestratorPrompt(defaultParams);
    expect(systemPrompt).toContain('DECISION PROTOCOL');
    expect(systemPrompt).toContain('PLANNING');
    expect(systemPrompt).toContain('EXECUTING');
    expect(systemPrompt).toContain('MONITORING');
    expect(systemPrompt).toContain('VALIDATION');
    expect(systemPrompt).toContain('COMPLETION');
  });

  it('should include resilience instructions in systemPrompt', () => {
    const { systemPrompt } = buildOrchestratorPrompt(defaultParams);
    expect(systemPrompt).toContain('RESILIENCE');
    expect(systemPrompt).toContain('state file is missing');
    expect(systemPrompt).toContain('status: "failed"');
  });

  it('should include conflict avoidance in systemPrompt', () => {
    const { systemPrompt } = buildOrchestratorPrompt(defaultParams);
    expect(systemPrompt).toContain('CONFLICT AVOIDANCE');
    expect(systemPrompt).toContain('integration validation task');
  });

  describe('agent and model passthrough', () => {
    it('does not add --agent flag when agent is not provided', () => {
      const { systemPrompt } = buildOrchestratorPrompt(defaultParams);
      // Default params have no agent — delegation examples should be plain "beat run"
      expect(systemPrompt).toContain('beat run "<prompt>"');
      expect(systemPrompt).not.toContain('--agent');
    });

    it('does not add --model flag when model is not provided', () => {
      const { systemPrompt } = buildOrchestratorPrompt(defaultParams);
      expect(systemPrompt).not.toContain('--model');
    });

    it('threads --agent flag into worker delegation example when agent is set', () => {
      const { systemPrompt } = buildOrchestratorPrompt({ ...defaultParams, agent: 'codex' });
      expect(systemPrompt).toContain('beat run --agent codex "<prompt>"');
    });

    it('threads --model flag into worker delegation example when model is set', () => {
      const { systemPrompt } = buildOrchestratorPrompt({ ...defaultParams, model: 'claude-opus-4-5' });
      expect(systemPrompt).toContain('beat run --model claude-opus-4-5 "<prompt>"');
    });

    it('threads both --agent and --model flags when both are set', () => {
      const { systemPrompt } = buildOrchestratorPrompt({
        ...defaultParams,
        agent: 'gemini',
        model: 'gemini-2.5-pro',
      });
      expect(systemPrompt).toContain('beat run --agent gemini --model gemini-2.5-pro "<prompt>"');
    });

    it('threads flags into loop delegation examples too', () => {
      const { systemPrompt } = buildOrchestratorPrompt({
        ...defaultParams,
        agent: 'claude',
        model: 'claude-opus-4-5',
      });
      expect(systemPrompt).toContain('beat loop --agent claude --model claude-opus-4-5 "<prompt>" --until');
    });
  });

  describe('operationalContract', () => {
    it('contains state file path', () => {
      const { operationalContract } = buildOrchestratorPrompt(defaultParams);
      expect(operationalContract).toContain(defaultParams.stateFilePath);
    });

    it('contains completion signal', () => {
      const { operationalContract } = buildOrchestratorPrompt(defaultParams);
      expect(operationalContract).toContain('status: "complete"');
    });

    it('contains working directory and beat CLI commands', () => {
      const { operationalContract } = buildOrchestratorPrompt(defaultParams);
      expect(operationalContract).toContain(defaultParams.workingDirectory);
      expect(operationalContract).toContain('beat run');
      expect(operationalContract).toContain('beat status');
      expect(operationalContract).toContain('beat logs');
      expect(operationalContract).toContain('beat cancel');
    });
  });
});
