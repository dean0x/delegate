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
    testDir = path.join(tmpdir(), `autobeat-agent-config-test-${Date.now()}`);
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

  describe('baseUrl support', () => {
    it('should save and load baseUrl for a provider', () => {
      const result = saveAgentConfig('claude', 'baseUrl', 'https://proxy.example.com/v1');
      expect(result.ok).toBe(true);

      const config = loadAgentConfig('claude');
      expect(config.baseUrl).toBe('https://proxy.example.com/v1');
    });

    it('should strip trailing slash from baseUrl on save', () => {
      saveAgentConfig('claude', 'baseUrl', 'https://proxy.example.com/v1/');
      const config = loadAgentConfig('claude');
      expect(config.baseUrl).toBe('https://proxy.example.com/v1');
    });

    it('should delete baseUrl when empty string is saved', () => {
      saveAgentConfig('claude', 'baseUrl', 'https://proxy.example.com');
      saveAgentConfig('claude', 'baseUrl', '');
      const config = loadAgentConfig('claude');
      expect(config.baseUrl).toBeUndefined();
    });

    it('should preserve apiKey when saving baseUrl', () => {
      saveAgentConfig('claude', 'apiKey', 'sk-test');
      saveAgentConfig('claude', 'baseUrl', 'https://proxy.example.com');

      const config = loadAgentConfig('claude');
      expect(config.apiKey).toBe('sk-test');
      expect(config.baseUrl).toBe('https://proxy.example.com');
    });

    it('should preserve baseUrl when saving apiKey', () => {
      saveAgentConfig('claude', 'baseUrl', 'https://proxy.example.com');
      saveAgentConfig('claude', 'apiKey', 'sk-test');

      const config = loadAgentConfig('claude');
      expect(config.baseUrl).toBe('https://proxy.example.com');
      expect(config.apiKey).toBe('sk-test');
    });
  });

  describe('proxy support', () => {
    it('should save and load proxy for a provider', () => {
      const result = saveAgentConfig('claude', 'proxy', 'openai');
      expect(result.ok).toBe(true);

      const config = loadAgentConfig('claude');
      expect(config.proxy).toBe('openai');
    });

    it('should clear proxy with empty string', () => {
      saveAgentConfig('claude', 'proxy', 'openai');
      saveAgentConfig('claude', 'proxy', '');
      const config = loadAgentConfig('claude');
      expect(config.proxy).toBeUndefined();
    });

    it('should drop unknown proxy targets silently', () => {
      // Write raw JSON with an unsupported proxy value
      const { writeFileSync } = require('fs');
      writeFileSync(
        require('path').join(testDir, 'config.json'),
        JSON.stringify({ agents: { claude: { proxy: 'unsupported-backend' } } }),
      );
      const config = loadAgentConfig('claude');
      expect(config.proxy).toBeUndefined();
    });
  });

  describe('runtime support', () => {
    it('should save and load runtime for a provider', () => {
      const result = saveAgentConfig('claude', 'runtime', 'ollama');
      expect(result.ok).toBe(true);

      const config = loadAgentConfig('claude');
      expect(config.runtime).toBe('ollama');
    });

    it('should clear runtime with empty string', () => {
      saveAgentConfig('claude', 'runtime', 'ollama');
      saveAgentConfig('claude', 'runtime', '');
      const config = loadAgentConfig('claude');
      expect(config.runtime).toBeUndefined();
    });

    it('should drop unknown runtime targets silently', () => {
      const { writeFileSync } = require('fs');
      writeFileSync(
        require('path').join(testDir, 'config.json'),
        JSON.stringify({ agents: { claude: { runtime: 'unknown-runtime' } } }),
      );
      const config = loadAgentConfig('claude');
      expect(config.runtime).toBeUndefined();
    });
  });

  describe('model support', () => {
    it('should save and load model for a provider', () => {
      const result = saveAgentConfig('claude', 'model', 'claude-opus-4-5');
      expect(result.ok).toBe(true);

      const config = loadAgentConfig('claude');
      expect(config.model).toBe('claude-opus-4-5');
    });

    it('should delete model when empty string is saved', () => {
      saveAgentConfig('claude', 'model', 'claude-opus-4-5');
      saveAgentConfig('claude', 'model', '');
      const config = loadAgentConfig('claude');
      expect(config.model).toBeUndefined();
    });

    it('should preserve apiKey when saving model', () => {
      saveAgentConfig('codex', 'apiKey', 'sk-openai');
      saveAgentConfig('codex', 'model', 'gpt-4o');

      const config = loadAgentConfig('codex');
      expect(config.apiKey).toBe('sk-openai');
      expect(config.model).toBe('gpt-4o');
    });

    it('should not clobber fields across different providers', () => {
      saveAgentConfig('claude', 'model', 'claude-opus-4-5');
      saveAgentConfig('codex', 'model', 'gpt-4o');

      expect(loadAgentConfig('claude').model).toBe('claude-opus-4-5');
      expect(loadAgentConfig('codex').model).toBe('gpt-4o');
    });
  });
});
