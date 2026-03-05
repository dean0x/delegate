/**
 * Agent Config Storage Tests
 *
 * ARCHITECTURE: Tests loadAgentConfig, saveAgentConfig, resetAgentConfig
 * which store per-agent API keys under the `agents` namespace in config.json.
 * Uses _testSetConfigDir for test isolation.
 */

import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _testSetConfigDir, loadAgentConfig, resetAgentConfig, saveAgentConfig } from '../../../src/core/configuration';

describe('Agent Config Storage', () => {
  let testDir: string;
  let restore: () => void;

  beforeEach(() => {
    testDir = path.join(tmpdir(), `backbeat-agent-config-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    restore = _testSetConfigDir(testDir);
  });

  afterEach(() => {
    restore();
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('loadAgentConfig', () => {
    it('should return empty config when no config file exists', () => {
      const config = loadAgentConfig('claude');
      expect(config).toEqual({});
      expect(config.apiKey).toBeUndefined();
    });

    it('should return empty config when agents section missing', () => {
      writeFileSync(path.join(testDir, 'config.json'), JSON.stringify({ timeout: 5000 }));
      const config = loadAgentConfig('codex');
      expect(config.apiKey).toBeUndefined();
    });

    it('should return empty config when provider section missing', () => {
      writeFileSync(path.join(testDir, 'config.json'), JSON.stringify({ agents: { claude: { apiKey: 'sk-test' } } }));
      const config = loadAgentConfig('codex');
      expect(config.apiKey).toBeUndefined();
    });

    it('should return stored API key for provider', () => {
      writeFileSync(
        path.join(testDir, 'config.json'),
        JSON.stringify({ agents: { codex: { apiKey: 'sk-stored-key' } } }),
      );
      const config = loadAgentConfig('codex');
      expect(config.apiKey).toBe('sk-stored-key');
    });

    it('should handle malformed agents section gracefully', () => {
      writeFileSync(path.join(testDir, 'config.json'), JSON.stringify({ agents: 'not-an-object' }));
      const config = loadAgentConfig('claude');
      expect(config).toEqual({});
    });

    it('should handle malformed provider section gracefully', () => {
      writeFileSync(path.join(testDir, 'config.json'), JSON.stringify({ agents: { claude: 'bad' } }));
      const config = loadAgentConfig('claude');
      expect(config).toEqual({});
    });
  });

  describe('saveAgentConfig', () => {
    it('should save API key for a provider', () => {
      const result = saveAgentConfig('codex', 'apiKey', 'sk-new-key');
      expect(result.ok).toBe(true);

      const config = loadAgentConfig('codex');
      expect(config.apiKey).toBe('sk-new-key');
    });

    it('should preserve existing config when saving agent config', () => {
      writeFileSync(path.join(testDir, 'config.json'), JSON.stringify({ timeout: 5000 }));

      saveAgentConfig('claude', 'apiKey', 'sk-claude-key');

      const config = loadAgentConfig('claude');
      expect(config.apiKey).toBe('sk-claude-key');

      // Original config preserved
      const raw = JSON.parse(require('fs').readFileSync(path.join(testDir, 'config.json'), 'utf-8'));
      expect(raw.timeout).toBe(5000);
    });

    it('should preserve other agents when saving', () => {
      saveAgentConfig('claude', 'apiKey', 'sk-claude');
      saveAgentConfig('codex', 'apiKey', 'sk-codex');

      expect(loadAgentConfig('claude').apiKey).toBe('sk-claude');
      expect(loadAgentConfig('codex').apiKey).toBe('sk-codex');
    });

    it('should overwrite existing API key', () => {
      saveAgentConfig('gemini', 'apiKey', 'old-key');
      saveAgentConfig('gemini', 'apiKey', 'new-key');

      expect(loadAgentConfig('gemini').apiKey).toBe('new-key');
    });
  });

  describe('resetAgentConfig', () => {
    it('should remove stored config for a provider', () => {
      saveAgentConfig('codex', 'apiKey', 'sk-to-remove');
      expect(loadAgentConfig('codex').apiKey).toBe('sk-to-remove');

      const result = resetAgentConfig('codex');
      expect(result.ok).toBe(true);
      expect(loadAgentConfig('codex').apiKey).toBeUndefined();
    });

    it('should be idempotent (reset when nothing stored)', () => {
      const result = resetAgentConfig('gemini');
      expect(result.ok).toBe(true);
    });

    it('should preserve other agents when resetting one', () => {
      saveAgentConfig('claude', 'apiKey', 'sk-keep');
      saveAgentConfig('codex', 'apiKey', 'sk-remove');

      resetAgentConfig('codex');

      expect(loadAgentConfig('claude').apiKey).toBe('sk-keep');
      expect(loadAgentConfig('codex').apiKey).toBeUndefined();
    });

    it('should clean up empty agents object', () => {
      saveAgentConfig('codex', 'apiKey', 'sk-only');
      resetAgentConfig('codex');

      const raw = JSON.parse(require('fs').readFileSync(path.join(testDir, 'config.json'), 'utf-8'));
      expect(raw.agents).toBeUndefined();
    });
  });
});
