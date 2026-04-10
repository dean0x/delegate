/**
 * Unit tests for orchestrator prompt builder
 * ARCHITECTURE: Tests pure function output for correct content
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

  it('should include the goal in the prompt', () => {
    const prompt = buildOrchestratorPrompt(defaultParams);
    expect(prompt).toContain('Build a complete authentication system');
  });

  it('should include the state file path', () => {
    const prompt = buildOrchestratorPrompt(defaultParams);
    expect(prompt).toContain('/home/user/.autobeat/orchestrator-state/state-123.json');
  });

  it('should include the working directory', () => {
    const prompt = buildOrchestratorPrompt(defaultParams);
    expect(prompt).toContain('/workspace/my-project');
  });

  it('should include beat CLI commands', () => {
    const prompt = buildOrchestratorPrompt(defaultParams);
    expect(prompt).toContain('beat run');
    expect(prompt).toContain('beat status');
    expect(prompt).toContain('beat logs');
    expect(prompt).toContain('beat cancel');
  });

  it('should include maxWorkers constraint', () => {
    const prompt = buildOrchestratorPrompt({ ...defaultParams, maxWorkers: 10 });
    expect(prompt).toContain('Max concurrent workers: 10');
  });

  it('should include maxDepth constraint', () => {
    const prompt = buildOrchestratorPrompt({ ...defaultParams, maxDepth: 7 });
    expect(prompt).toContain('Max delegation depth: 7');
  });

  it('should include decision protocol', () => {
    const prompt = buildOrchestratorPrompt(defaultParams);
    expect(prompt).toContain('DECISION PROTOCOL');
    expect(prompt).toContain('PLANNING');
    expect(prompt).toContain('EXECUTING');
    expect(prompt).toContain('MONITORING');
    expect(prompt).toContain('VALIDATION');
    expect(prompt).toContain('COMPLETION');
  });

  it('should include resilience instructions', () => {
    const prompt = buildOrchestratorPrompt(defaultParams);
    expect(prompt).toContain('RESILIENCE');
    expect(prompt).toContain('state file is missing');
    expect(prompt).toContain('status: "failed"');
  });

  it('should include conflict avoidance', () => {
    const prompt = buildOrchestratorPrompt(defaultParams);
    expect(prompt).toContain('CONFLICT AVOIDANCE');
    expect(prompt).toContain('integration validation task');
  });

  describe('agent and model passthrough', () => {
    it('does not add --agent flag when agent is not provided', () => {
      const prompt = buildOrchestratorPrompt(defaultParams);
      // Default params have no agent — delegation examples should be plain "beat run"
      expect(prompt).toContain('beat run "<prompt>"');
      expect(prompt).not.toContain('--agent');
    });

    it('does not add --model flag when model is not provided', () => {
      const prompt = buildOrchestratorPrompt(defaultParams);
      expect(prompt).not.toContain('--model');
    });

    it('threads --agent flag into worker delegation example when agent is set', () => {
      const prompt = buildOrchestratorPrompt({ ...defaultParams, agent: 'codex' });
      expect(prompt).toContain('beat run --agent codex "<prompt>"');
    });

    it('threads --model flag into worker delegation example when model is set', () => {
      const prompt = buildOrchestratorPrompt({ ...defaultParams, model: 'claude-opus-4-5' });
      expect(prompt).toContain('beat run --model claude-opus-4-5 "<prompt>"');
    });

    it('threads both --agent and --model flags when both are set', () => {
      const prompt = buildOrchestratorPrompt({ ...defaultParams, agent: 'gemini', model: 'gemini-2.5-pro' });
      expect(prompt).toContain('beat run --agent gemini --model gemini-2.5-pro "<prompt>"');
    });

    it('threads flags into loop delegation examples too', () => {
      const prompt = buildOrchestratorPrompt({ ...defaultParams, agent: 'claude', model: 'claude-opus-4-5' });
      expect(prompt).toContain('beat loop --agent claude --model claude-opus-4-5 "<prompt>" --until');
    });
  });
});
