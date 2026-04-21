/**
 * Unit tests for orchestrator-scaffold.ts
 * ARCHITECTURE: Tests file I/O side effects + returned data structure.
 * Uses a real temp directory to verify actual file creation.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scaffoldCustomOrchestrator } from '../../../src/core/orchestrator-scaffold.js';
import { readStateFile } from '../../../src/core/orchestrator-state.js';

// Override getStateDir to use a temp dir so we don't litter ~/.autobeat in tests
const TEST_STATE_DIR = path.join(tmpdir(), `autobeat-scaffold-test-${process.pid}`);

vi.mock('../../../src/core/orchestrator-state.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/core/orchestrator-state.js')>();
  return {
    ...original,
    getStateDir: () => TEST_STATE_DIR,
  };
});

describe('scaffoldCustomOrchestrator', () => {
  beforeEach(() => {
    mkdirSync(TEST_STATE_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_STATE_DIR)) {
      rmSync(TEST_STATE_DIR, { recursive: true, force: true });
    }
  });

  it('returns ok result with all required fields', () => {
    const result = scaffoldCustomOrchestrator({
      goal: 'Build auth system',
      workingDirectory: '/workspace',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.stateFilePath).toBeTruthy();
    expect(result.value.exitConditionScript).toBeTruthy();
    expect(result.value.suggestedExitCondition).toBeTruthy();
    expect(result.value.instructions.delegation).toBeTruthy();
    expect(result.value.instructions.stateManagement).toBeTruthy();
    expect(result.value.instructions.constraints).toBeTruthy();
  });

  it('creates state file on disk with initial content', () => {
    const result = scaffoldCustomOrchestrator({
      goal: 'Test goal',
      workingDirectory: '/workspace',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(existsSync(result.value.stateFilePath)).toBe(true);

    const stateResult = readStateFile(result.value.stateFilePath);
    expect(stateResult.ok).toBe(true);
    if (!stateResult.ok) return;

    expect(stateResult.value.goal).toBe('Test goal');
    expect(stateResult.value.status).toBe('planning');
    expect(stateResult.value.version).toBe(1);
    expect(stateResult.value.plan).toEqual([]);
    expect(stateResult.value.iterationCount).toBe(0);
  });

  it('creates exit condition script on disk', () => {
    const result = scaffoldCustomOrchestrator({
      goal: 'Test goal',
      workingDirectory: '/workspace',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(existsSync(result.value.exitConditionScript)).toBe(true);

    const scriptContent = readFileSync(result.value.exitConditionScript, 'utf-8');
    expect(scriptContent).toContain('process.exit');
    expect(scriptContent).toContain(result.value.stateFilePath);
  });

  it('suggestedExitCondition is "node <scriptPath>"', () => {
    const result = scaffoldCustomOrchestrator({
      goal: 'Test goal',
      workingDirectory: '/workspace',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.suggestedExitCondition).toBe(`node ${result.value.exitConditionScript}`);
  });

  it('defaults maxWorkers to 5 and maxDepth to 3 in constraints snippet', () => {
    const result = scaffoldCustomOrchestrator({
      goal: 'Test goal',
      workingDirectory: '/workspace',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.instructions.constraints).toContain('Max concurrent workers: 5');
    expect(result.value.instructions.constraints).toContain('Max delegation depth: 3');
  });

  it('respects explicit maxWorkers and maxDepth', () => {
    const result = scaffoldCustomOrchestrator({
      goal: 'Test goal',
      workingDirectory: '/workspace',
      maxWorkers: 10,
      maxDepth: 2,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.instructions.constraints).toContain('Max concurrent workers: 10');
    expect(result.value.instructions.constraints).toContain('Max delegation depth: 2');
  });

  it('threads agent flag into delegation snippet', () => {
    const result = scaffoldCustomOrchestrator({
      goal: 'Test goal',
      workingDirectory: '/workspace',
      agent: 'claude',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.instructions.delegation).toContain('--agent claude');
  });

  it('threads model flag into delegation snippet', () => {
    const result = scaffoldCustomOrchestrator({
      goal: 'Test goal',
      workingDirectory: '/workspace',
      model: 'claude-opus-4-5',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.instructions.delegation).toContain('--model claude-opus-4-5');
  });

  it('threads both agent and model flags into delegation snippet', () => {
    const result = scaffoldCustomOrchestrator({
      goal: 'Test goal',
      workingDirectory: '/workspace',
      agent: 'gemini',
      model: 'gemini-2.5-pro',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.instructions.delegation).toContain('--agent gemini --model gemini-2.5-pro');
  });

  it('includes state file path in state management snippet', () => {
    const result = scaffoldCustomOrchestrator({
      goal: 'Test goal',
      workingDirectory: '/workspace',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.instructions.stateManagement).toContain(result.value.stateFilePath);
  });

  it('generates unique state files for concurrent calls', () => {
    const result1 = scaffoldCustomOrchestrator({ goal: 'Goal 1', workingDirectory: '/workspace' });
    const result2 = scaffoldCustomOrchestrator({ goal: 'Goal 2', workingDirectory: '/workspace' });

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
    if (!result1.ok || !result2.ok) return;

    expect(result1.value.stateFilePath).not.toBe(result2.value.stateFilePath);
    expect(result1.value.exitConditionScript).not.toBe(result2.value.exitConditionScript);
  });

  it('returns a Result object (never throws)', () => {
    // The function contract: any internal error must be caught and returned as err(Error).
    // We verify this by calling with valid input — the Result type is always returned.
    // Testing the error branch via module mocking is avoided here because vitest's
    // isolate:false config causes doMock() to pollute the module cache across files.
    const result = scaffoldCustomOrchestrator({ goal: 'Test', workingDirectory: '/workspace' });
    expect(typeof result).toBe('object');
    expect('ok' in result).toBe(true);
  });
});
