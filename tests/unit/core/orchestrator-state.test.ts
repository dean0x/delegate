/**
 * Unit tests for orchestrator state file management
 * ARCHITECTURE: Tests state file I/O with atomic write behavior
 */

import { existsSync, mkdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createInitialState,
  type OrchestratorStateFile,
  readStateFile,
  writeExitConditionScript,
  writeStateFile,
} from '../../../src/core/orchestrator-state.js';

describe('Orchestrator State File - Unit Tests', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `autobeat-test-state-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    // Cleanup
    try {
      const files = require('fs').readdirSync(tmpDir);
      for (const f of files) {
        unlinkSync(path.join(tmpDir, f));
      }
      rmdirSync(tmpDir);
    } catch {
      // Best effort cleanup
    }
  });

  describe('createInitialState()', () => {
    it('should return correct initial structure', () => {
      const state = createInitialState('Build a new auth system');

      expect(state.version).toBe(1);
      expect(state.goal).toBe('Build a new auth system');
      expect(state.status).toBe('planning');
      expect(state.plan).toEqual([]);
      expect(state.context).toEqual({});
      expect(state.iterationCount).toBe(0);
    });
  });

  describe('writeStateFile()', () => {
    it('should create file with correct content', () => {
      const filePath = path.join(tmpDir, 'state.json');
      const state = createInitialState('Test goal');

      writeStateFile(filePath, state);

      expect(existsSync(filePath)).toBe(true);
      const content = JSON.parse(readFileSync(filePath, 'utf-8'));
      expect(content.version).toBe(1);
      expect(content.goal).toBe('Test goal');
      expect(content.status).toBe('planning');
    });

    it('should create parent directories', () => {
      const nestedPath = path.join(tmpDir, 'nested', 'dir', 'state.json');
      const state = createInitialState('Nested goal');

      writeStateFile(nestedPath, state);

      expect(existsSync(nestedPath)).toBe(true);
    });

    it('should write atomically via temp file', () => {
      const filePath = path.join(tmpDir, 'state.json');
      const state = createInitialState('First');

      writeStateFile(filePath, state);

      // Overwrite with new state
      const updatedState: OrchestratorStateFile = {
        ...state,
        status: 'executing',
        iterationCount: 5,
      };
      writeStateFile(filePath, updatedState);

      const content = JSON.parse(readFileSync(filePath, 'utf-8'));
      expect(content.status).toBe('executing');
      expect(content.iterationCount).toBe(5);
      // Temp file should not remain
      expect(existsSync(`${filePath}.tmp`)).toBe(false);
    });
  });

  describe('readStateFile()', () => {
    it('should read a valid state file', () => {
      const filePath = path.join(tmpDir, 'state.json');
      const state = createInitialState('Read test');
      writeStateFile(filePath, state);

      const result = readStateFile(filePath);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.goal).toBe('Read test');
      expect(result.value.version).toBe(1);
    });

    it('should return error for missing file', () => {
      const result = readStateFile(path.join(tmpDir, 'nonexistent.json'));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('Failed to read state file');
    });

    it('should return error for malformed JSON', () => {
      const filePath = path.join(tmpDir, 'bad.json');
      writeFileSync(filePath, 'not json at all', 'utf-8');

      const result = readStateFile(filePath);

      expect(result.ok).toBe(false);
    });

    it('should return error for invalid version', () => {
      const filePath = path.join(tmpDir, 'v2.json');
      writeFileSync(filePath, JSON.stringify({ version: 2, goal: 'test' }), 'utf-8');

      const result = readStateFile(filePath);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('Invalid state file format');
    });
  });

  describe('writeExitConditionScript()', () => {
    it('should write script and return absolute path', () => {
      const stateFilePath = path.join(tmpDir, 'state.json');
      const scriptPath = writeExitConditionScript(tmpDir, stateFilePath);

      expect(path.isAbsolute(scriptPath)).toBe(true);
      expect(existsSync(scriptPath)).toBe(true);
      expect(scriptPath).toContain('check-complete-state.js');
    });

    it('should write executable script with correct logic', () => {
      const stateFilePath = path.join(tmpDir, 'state.json');
      const scriptPath = writeExitConditionScript(tmpDir, stateFilePath);

      const content = readFileSync(scriptPath, 'utf-8');
      expect(content).toContain('process.exit');
      expect(content).toContain("s.status === 'complete'");
    });

    it('should hardcode state file path without process.argv override', () => {
      const stateFilePath = path.join(tmpDir, 'state.json');
      const scriptPath = writeExitConditionScript(tmpDir, stateFilePath);

      const content = readFileSync(scriptPath, 'utf-8');
      expect(content).toContain(stateFilePath);
      expect(content).not.toContain('process.argv');
    });

    it('should generate unique script names for different state files', () => {
      const stateFile1 = path.join(tmpDir, 'state-abc.json');
      const stateFile2 = path.join(tmpDir, 'state-def.json');

      const script1 = writeExitConditionScript(tmpDir, stateFile1);
      const script2 = writeExitConditionScript(tmpDir, stateFile2);

      expect(script1).not.toBe(script2);
      expect(existsSync(script1)).toBe(true);
      expect(existsSync(script2)).toBe(true);
    });
  });
});
