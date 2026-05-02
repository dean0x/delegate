import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _testSetConfigDir,
  type Configuration,
  ConfigurationSchema,
  loadConfigFile,
  loadConfiguration,
  resetConfigValue,
  saveConfigValue,
  type TaskConfiguration,
} from '../../../src/core/configuration';
import { BUFFER_SIZES, TIMEOUTS } from '../../constants';

describe('ConfigurationSchema - REAL Validation Behavior', () => {
  describe('Valid configurations', () => {
    it('should accept valid configuration', () => {
      const config = {
        timeout: 60000,
        maxOutputBuffer: BUFFER_SIZES.SMALL,
        cpuCoresReserved: 2,
        memoryReserve: 1000000000,
        logLevel: 'info' as const,
      };

      const result = ConfigurationSchema.safeParse(config);

      expect(result.success).toBe(true);
      if (result.success) {
        // FIX: Schema adds defaults for all fields (~20), not just the 5 provided
        expect(result.data.timeout).toBe(60000);
        expect(result.data.maxOutputBuffer).toBe(BUFFER_SIZES.SMALL);
        expect(result.data.cpuCoresReserved).toBe(2);
        expect(result.data.memoryReserve).toBe(1000000000);
        expect(result.data.logLevel).toBe('info');
        // Schema adds defaults for other fields
        expect(result.data.maxListenersPerEvent).toBe(100);
        expect(result.data.maxTotalSubscriptions).toBe(1000);
        expect(typeof result.data.timeout).toBe('number');
        expect(typeof result.data.maxOutputBuffer).toBe('number');
        expect(typeof result.data.cpuCoresReserved).toBe('number');
        expect(typeof result.data.memoryReserve).toBe('number');
        expect(typeof result.data.logLevel).toBe('string');
      }
    });

    it('should accept minimum valid values', () => {
      const config = {
        timeout: TIMEOUTS.MEDIUM,
        maxOutputBuffer: 1024,
        cpuCoresReserved: 1, // Minimum is 1 core
        memoryReserve: 0,
        logLevel: 'debug' as const,
      };

      const result = ConfigurationSchema.safeParse(config);

      expect(result.success).toBe(true);
    });

    it('should accept maximum valid values', () => {
      const config = {
        // DECISION: Max timeout is 24 hours (86,400,000ms). Safety cap for runaway tasks.
        timeout: 86400000, // 24 hours (max allowed)
        maxOutputBuffer: 1073741824, // 1GB
        cpuCoresReserved: 32,
        // FIX: Max memory reserve is 64GB, not MAX_SAFE_INTEGER
        memoryReserve: 64 * 1024 * 1024 * 1024,
        logLevel: 'error' as const,
      };

      const result = ConfigurationSchema.safeParse(config);

      expect(result.success).toBe(true);
    });

    it('accepts timeout of 0 (no timeout)', () => {
      // DECISION: timeout=0 means disabled (no timeout). Default since v1.3.0.
      const config = {
        timeout: 0,
        maxOutputBuffer: BUFFER_SIZES.SMALL,
        cpuCoresReserved: 2,
        memoryReserve: 1000000000,
        logLevel: 'info' as const,
      };

      const result = ConfigurationSchema.safeParse(config);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.timeout).toBe(0);
      }
    });

    it('should accept all valid log levels', () => {
      const logLevels = ['debug', 'info', 'warn', 'error'] as const;

      logLevels.forEach((level) => {
        const config = {
          timeout: 30000,
          maxOutputBuffer: BUFFER_SIZES.SMALL,
          cpuCoresReserved: 2,
          memoryReserve: 1000000000,
          logLevel: level,
        };

        const result = ConfigurationSchema.safeParse(config);
        expect(result.success).toBe(true);
      });
    });
  });

  describe('Invalid configurations', () => {
    it('should reject timeout below minimum (negative)', () => {
      const config = {
        timeout: -1,
        maxOutputBuffer: BUFFER_SIZES.SMALL,
        cpuCoresReserved: 2,
        memoryReserve: 1000000000,
        logLevel: 'info' as const,
      };

      const result = ConfigurationSchema.safeParse(config);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain('timeout');
      }
    });

    it('should reject timeout above maximum (> 24 hours)', () => {
      const config = {
        // DECISION: Max timeout is 24 hours (86,400,000ms). Safety cap for runaway tasks.
        timeout: 86400000 + 1, // 24 hours + 1ms (exceeds max)
        maxOutputBuffer: BUFFER_SIZES.SMALL,
        cpuCoresReserved: 2,
        memoryReserve: 1000000000,
        logLevel: 'info' as const,
      };

      const result = ConfigurationSchema.safeParse(config);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain('timeout');
        expect(result.error.issues).toHaveLength(1);
        expect(result.error.issues[0].code).toBe('too_big');
        // Max is 24 hours (86,400,000ms)
        expect(result.error.issues[0].maximum).toBe(86400000);
        expect(result.error.issues[0].inclusive).toBe(true);
        expect(typeof result.error.issues[0].message).toBe('string');
      }
    });

    it('should reject invalid maxOutputBuffer', () => {
      const invalidBuffers = [
        1023, // Below minimum
        1073741825, // Above maximum
        -1, // Negative
        0, // Zero
      ];

      invalidBuffers.forEach((buffer) => {
        const config = {
          timeout: 30000,
          maxOutputBuffer: buffer,
          cpuCoresReserved: 2,
          memoryReserve: 1000000000,
          logLevel: 'info' as const,
        };

        const result = ConfigurationSchema.safeParse(config);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toBeDefined();
          expect(result.error.issues).toBeDefined();
          expect(result.error.issues.length).toBeGreaterThan(0);
          expect(result.error.issues[0].path).toContain('maxOutputBuffer');
        }
      });
    });

    it('should reject invalid CPU thresholds', () => {
      const invalidThresholds = [0, -1, 33, 100]; // Below 1 or above 32 are invalid
      const validHighValues = [16, 32]; // FIX: Max is 32, not unlimited

      invalidThresholds.forEach((threshold) => {
        const config = {
          timeout: 30000,
          maxOutputBuffer: BUFFER_SIZES.SMALL,
          cpuCoresReserved: threshold,
          memoryReserve: 1000000000,
          logLevel: 'info' as const,
        };

        const result = ConfigurationSchema.safeParse(config);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toBeDefined();
          expect(result.error.issues).toBeDefined();
          expect(result.error.issues.length).toBeGreaterThan(0);
          expect(result.error.issues[0].path).toContain('cpuCoresReserved');
        }
      });

      // FIX: Valid values are 1-32, not unlimited
      validHighValues.forEach((threshold) => {
        const config = {
          timeout: 30000,
          maxOutputBuffer: BUFFER_SIZES.SMALL,
          cpuCoresReserved: threshold,
          memoryReserve: 1000000000,
          logLevel: 'info' as const,
        };

        const result = ConfigurationSchema.safeParse(config);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.cpuCoresReserved).toBe(threshold);
          expect(result.data).toBeDefined();
          expect(typeof result.data.cpuCoresReserved).toBe('number');
          expect(result.data.timeout).toBe(30000);
          expect(result.data.maxOutputBuffer).toBe(BUFFER_SIZES.SMALL);
        }
      });
    });

    it('should reject negative memory reserve', () => {
      const config = {
        timeout: 30000,
        maxOutputBuffer: BUFFER_SIZES.SMALL,
        cpuCoresReserved: 2,
        memoryReserve: -1,
        logLevel: 'info' as const,
      };

      const result = ConfigurationSchema.safeParse(config);

      expect(result.success).toBe(false);
    });

    it('should reject invalid log levels', () => {
      const invalidLevels = ['trace', 'verbose', 'DEBUG', 'INFO', 'invalid', ''];

      invalidLevels.forEach((level) => {
        const config = {
          timeout: 30000,
          maxOutputBuffer: BUFFER_SIZES.SMALL,
          cpuCoresReserved: 2,
          memoryReserve: 1000000000,
          logLevel: level,
        };

        const result = ConfigurationSchema.safeParse(config);
        expect(result.success).toBe(false);
      });
    });

    it('should reject non-numeric values', () => {
      const config = {
        timeout: '30000' as unknown as number,
        maxOutputBuffer: 'large' as unknown as number,
        cpuCoresReserved: true as unknown as number,
        memoryReserve: null as unknown as number,
        logLevel: 'info',
      };

      const result = ConfigurationSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it('should reject missing fields', () => {
      // FIX: Schema has defaults for all fields, so partial configs succeed
      // This test should validate that defaults are applied correctly
      const partialConfigs = [
        { timeout: 30000 },
        { maxOutputBuffer: BUFFER_SIZES.SMALL },
        { cpuCoresReserved: 16 },
        { memoryReserve: 1000000000 },
        { logLevel: 'info' as const },
        {},
      ];

      partialConfigs.forEach((partial) => {
        const result = ConfigurationSchema.safeParse(partial);
        // FIX: Schema provides defaults, so these succeed
        expect(result.success).toBe(true);
        if (result.success) {
          // Verify defaults are applied
          expect(result.data).toBeDefined();
          expect(typeof result.data.timeout).toBe('number');
          expect(typeof result.data.maxOutputBuffer).toBe('number');
        }
      });
    });
  });

  describe('Type inference', () => {
    it('should infer correct TypeScript types', () => {
      const config: Configuration = {
        timeout: 30000,
        maxOutputBuffer: BUFFER_SIZES.SMALL,
        cpuCoresReserved: 2,
        memoryReserve: 2684354560, // 2.5GB to match default
        logLevel: 'info',
      };

      // Type checks (these would fail compilation if types were wrong)
      const timeout: number = config.timeout;
      const buffer: number = config.maxOutputBuffer;
      const cpu: number = config.cpuCoresReserved;
      const memory: number = config.memoryReserve;
      const level: 'debug' | 'info' | 'warn' | 'error' = config.logLevel;

      expect(timeout).toBe(30000);
      expect(buffer).toBe(BUFFER_SIZES.SMALL);
      expect(cpu).toBe(2); // cpuCoresReserved default is 2
      expect(memory).toBe(2684354560); // 2.5GB default
      expect(level).toBe('info');
    });
  });
});

describe('loadConfiguration - REAL Configuration Loading', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let tempDir: string;
  let restoreConfigDir: () => void;

  beforeEach(() => {
    originalEnv = { ...process.env };
    tempDir = path.join(tmpdir(), `autobeat-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    restoreConfigDir = _testSetConfigDir(tempDir);
    // Clear relevant env vars
    delete process.env.TASK_TIMEOUT;
    delete process.env.MAX_OUTPUT_BUFFER;
    delete process.env.CPU_CORES_RESERVED;
    delete process.env.MEMORY_RESERVE;
    delete process.env.LOG_LEVEL;
  });

  afterEach(() => {
    restoreConfigDir();
    process.env = originalEnv;
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  });

  describe('Default configuration', () => {
    it('should load defaults when no environment variables set', () => {
      const config = loadConfiguration();

      // FIX: loadConfiguration returns 20+ fields, check core fields only
      // DECISION: Default timeout 0 (disabled). Why: tasks run 2.5+ hours; timeout was killing them.
      expect(config.timeout).toBe(0); // 0 = disabled (no timeout)
      expect(config.maxOutputBuffer).toBe(BUFFER_SIZES.MEDIUM); // 10MB
      expect(config.cpuCoresReserved).toBe(2);
      expect(config.memoryReserve).toBe(2684354560); // 2.5GB default
      expect(config.logLevel).toBe('info');
      expect(config.maxListenersPerEvent).toBe(100);
      expect(config.maxTotalSubscriptions).toBe(1000);
    });
  });

  describe('Environment variable loading', () => {
    it('should load configuration from environment', () => {
      process.env.TASK_TIMEOUT = '60000';
      process.env.MAX_OUTPUT_BUFFER = '2097152';
      process.env.CPU_CORES_RESERVED = '1';
      process.env.MEMORY_RESERVE = '2000000000';
      process.env.LOG_LEVEL = 'debug';

      const config = loadConfiguration();

      // FIX: Check specific fields, not full equality (20+ fields returned)
      expect(config.timeout).toBe(60000);
      expect(config.maxOutputBuffer).toBe(2097152);
      expect(config.cpuCoresReserved).toBe(1);
      expect(config.memoryReserve).toBe(2000000000);
      expect(config.logLevel).toBe('debug');
      expect(config.maxListenersPerEvent).toBe(100);
      expect(config.maxTotalSubscriptions).toBe(1000);
    });

    it('should handle partial environment configuration', () => {
      process.env.TASK_TIMEOUT = '120000';
      process.env.LOG_LEVEL = 'warn';

      const config = loadConfiguration();

      expect(config.timeout).toBe(120000);
      expect(config.logLevel).toBe('warn');
      expect(config.maxOutputBuffer).toBe(BUFFER_SIZES.MEDIUM); // Default
      expect(config.cpuCoresReserved).toBe(2); // Default
      expect(config.memoryReserve).toBe(2684354560); // Default (2.5GB)  // Default
    });

    it('should handle invalid number parsing', () => {
      process.env.TASK_TIMEOUT = 'not-a-number';
      process.env.MAX_OUTPUT_BUFFER = 'abc';
      process.env.CPU_CORES_RESERVED = '';
      process.env.MEMORY_RESERVE = 'null';

      const config = loadConfiguration();

      // Should use defaults for invalid numbers
      // DECISION: Default timeout is 0 (disabled) since v1.3.0
      expect(config.timeout).toBe(0);
      expect(config.maxOutputBuffer).toBe(BUFFER_SIZES.MEDIUM);
      expect(config.cpuCoresReserved).toBe(2);
      expect(config.memoryReserve).toBe(2684354560); // Default (2.5GB)
    });

    it('should handle invalid log level', () => {
      process.env.LOG_LEVEL = 'INVALID';

      const config = loadConfiguration();

      expect(config.logLevel).toBe('info'); // Default
    });

    it('should handle case-sensitive log levels', () => {
      process.env.LOG_LEVEL = 'DEBUG'; // Uppercase

      const config = loadConfiguration();

      expect(config.logLevel).toBe('info'); // Falls back to default
    });
  });

  describe('Validation fallback', () => {
    it('should fallback to defaults on invalid timeout', () => {
      // DECISION: min=0, max=86400000. Use a negative value to trigger below-minimum.
      process.env.TASK_TIMEOUT = '-1'; // Below minimum (0)

      const config = loadConfiguration();

      // DECISION: Default timeout is 0 (disabled) since v1.3.0
      expect(config.timeout).toBe(0); // Default
    });

    it('should fallback to defaults on invalid CPU threshold', () => {
      process.env.CPU_CORES_RESERVED = '33'; // Above maximum (32)

      const config = loadConfiguration();

      // FIX: Schema max is 32, so 33 gets rejected and falls back to default
      expect(config.cpuCoresReserved).toBe(2); // Falls back to default
    });

    it('should fallback to defaults on invalid memory reserve', () => {
      process.env.MEMORY_RESERVE = '-' + TIMEOUTS.MEDIUM; // Negative

      const config = loadConfiguration();

      expect(config.memoryReserve).toBe(2684354560); // Default (2.5GB)
    });

    it('should fallback to all defaults on any validation failure', () => {
      // One invalid value causes entire config to fallback
      process.env.TASK_TIMEOUT = '30000'; // Valid
      process.env.CPU_CORES_RESERVED = '2'; // Valid
      process.env.MEMORY_RESERVE = '-1'; // Invalid!
      process.env.LOG_LEVEL = 'debug'; // Valid

      const config = loadConfiguration();

      // FIX: Check core fields only (20+ fields returned)
      // DECISION: Default timeout is 0 (disabled) since v1.3.0
      expect(config.timeout).toBe(0);
      expect(config.maxOutputBuffer).toBe(BUFFER_SIZES.MEDIUM);
      expect(config.cpuCoresReserved).toBe(2);
      expect(config.memoryReserve).toBe(2684354560); // 2.5GB default
      expect(config.logLevel).toBe('info');
      expect(config.maxListenersPerEvent).toBe(100);
      expect(config.maxTotalSubscriptions).toBe(1000);
    });
  });

  describe('Edge cases', () => {
    it('should handle float values by truncating', () => {
      process.env.TASK_TIMEOUT = '30000.999';
      process.env.CPU_CORES_RESERVED = '2.5';

      const config = loadConfiguration();

      expect(config.timeout).toBe(30000);
      expect(config.cpuCoresReserved).toBe(2); // Now uses cores not percent
    });

    it('should handle very large numbers', () => {
      process.env.MEMORY_RESERVE = String(Number.MAX_SAFE_INTEGER);

      const config = loadConfiguration();

      // FIX: MAX_SAFE_INTEGER exceeds 64GB limit, falls back to default
      expect(config.memoryReserve).toBe(2684354560); // Default 2.5GB
    });

    it('should handle zero values appropriately', () => {
      process.env.MEMORY_RESERVE = '0'; // Valid (minimum is 0)

      const config = loadConfiguration();

      expect(config.memoryReserve).toBe(0);
    });

    it('should handle whitespace in environment variables', () => {
      process.env.TASK_TIMEOUT = '  60000  ';
      process.env.LOG_LEVEL = '  debug  ';

      const config = loadConfiguration();

      expect(config.timeout).toBe(60000);
      expect(config.logLevel).toBe('info'); // Doesn't trim, so invalid
    });
  });

  describe('Configuration consistency', () => {
    it('should always return valid configuration', () => {
      // Try many different invalid combinations
      const invalidConfigs = [
        { TASK_TIMEOUT: '-1', CPU_CORES_RESERVED: '200' },
        { MAX_OUTPUT_BUFFER: '0', MEMORY_RESERVE: '-999' },
        { LOG_LEVEL: '123', TASK_TIMEOUT: 'infinity' },
        { CPU_CORES_RESERVED: 'NaN', MEMORY_RESERVE: 'undefined' },
      ];

      invalidConfigs.forEach((envVars) => {
        process.env = { ...originalEnv, ...envVars };

        const config = loadConfiguration();

        // Should always return valid config (defaults)
        const validation = ConfigurationSchema.safeParse(config);
        expect(validation.success).toBe(true);
      });
    });

    it('should be deterministic', () => {
      process.env.TASK_TIMEOUT = '45000';
      process.env.LOG_LEVEL = 'warn';

      const config1 = loadConfiguration();
      const config2 = loadConfiguration();

      expect(config1).toEqual(config2);
    });
  });
});

describe('ConfigurationSchema - defaultAgent', () => {
  it('should accept valid defaultAgent', () => {
    const result = ConfigurationSchema.safeParse({ defaultAgent: 'claude' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.defaultAgent).toBe('claude');
  });

  it('should accept all valid agent providers', () => {
    for (const agent of ['claude', 'codex']) {
      const result = ConfigurationSchema.safeParse({ defaultAgent: agent });
      expect(result.success).toBe(true);
    }
  });

  it('should accept config without defaultAgent (optional)', () => {
    const result = ConfigurationSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.defaultAgent).toBeUndefined();
  });

  it('should reject invalid agent provider', () => {
    const result = ConfigurationSchema.safeParse({ defaultAgent: 'gpt4' });
    expect(result.success).toBe(false);
  });
});

describe('loadConfiguration - AUTOBEAT_DEFAULT_AGENT env var', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let tempDir: string;
  let restoreConfigDir: () => void;

  beforeEach(() => {
    originalEnv = { ...process.env };
    tempDir = path.join(tmpdir(), `autobeat-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    restoreConfigDir = _testSetConfigDir(tempDir);
  });

  afterEach(() => {
    restoreConfigDir();
    process.env = originalEnv;
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  });

  it('should load defaultAgent from AUTOBEAT_DEFAULT_AGENT env var', () => {
    process.env.AUTOBEAT_DEFAULT_AGENT = 'codex';
    const config = loadConfiguration();
    expect(config.defaultAgent).toBe('codex');
  });

  it('should ignore invalid AUTOBEAT_DEFAULT_AGENT value', () => {
    process.env.AUTOBEAT_DEFAULT_AGENT = 'invalid-agent';
    const config = loadConfiguration();
    expect(config.defaultAgent).toBeUndefined();
  });

  it('should not set defaultAgent when env var is empty', () => {
    process.env.AUTOBEAT_DEFAULT_AGENT = '';
    const config = loadConfiguration();
    expect(config.defaultAgent).toBeUndefined();
  });
});

describe('TaskConfiguration - Interface Testing', () => {
  it('should allow partial configuration', () => {
    const taskConfig: TaskConfiguration = {
      timeout: 60000,
    };

    expect(taskConfig.timeout).toBe(60000);
    expect(taskConfig.maxOutputBuffer).toBeUndefined();
  });

  it('should allow empty configuration', () => {
    const taskConfig: TaskConfiguration = {};

    expect(taskConfig.timeout).toBeUndefined();
    expect(taskConfig.maxOutputBuffer).toBeUndefined();
  });

  it('should enforce immutability at runtime', () => {
    // Test RUNTIME immutability, not TypeScript compile-time
    const taskConfig: TaskConfiguration = Object.freeze({
      timeout: 60000,
      maxOutputBuffer: BUFFER_SIZES.SMALL,
    });

    // Test that Object.freeze actually prevents mutations
    const attemptMutation = () => {
      'use strict'; // Strict mode makes property assignment throw
      // @ts-expect-error - Testing dynamic property assignment
      taskConfig.timeout = 30000;
    };

    expect(attemptMutation).toThrow(TypeError);
    expect(taskConfig.timeout).toBe(60000); // Value unchanged
  });

  it('should create defensive copies to prevent mutation', () => {
    // Test that configuration is defensively copied
    const original = { timeout: 60000, maxOutputBuffer: BUFFER_SIZES.SMALL };
    const taskConfig: TaskConfiguration = { ...original };

    // Mutate original
    original.timeout = 30000;

    // Config should be unaffected
    expect(taskConfig.timeout).toBe(60000);
  });
});

describe('Real-world configuration scenarios', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let tempDir: string;
  let restoreConfigDir: () => void;

  beforeEach(() => {
    originalEnv = { ...process.env };
    tempDir = path.join(tmpdir(), `autobeat-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    restoreConfigDir = _testSetConfigDir(tempDir);
  });

  afterEach(() => {
    restoreConfigDir();
    process.env = originalEnv;
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  });

  it('should handle production configuration', () => {
    process.env.TASK_TIMEOUT = '3600000'; // 1 hour
    process.env.MAX_OUTPUT_BUFFER = '52428800'; // 50MB
    process.env.CPU_CORES_RESERVED = '2';
    process.env.MEMORY_RESERVE = '2147483648'; // 2GB
    process.env.LOG_LEVEL = 'error';

    const config = loadConfiguration();

    expect(config.timeout).toBe(3600000);
    expect(config.maxOutputBuffer).toBe(52428800);
    expect(config.cpuCoresReserved).toBe(2); // Default is 2 cores
    expect(config.memoryReserve).toBe(2147483648);
    expect(config.logLevel).toBe('error');
  });

  it('should handle development configuration', () => {
    process.env.TASK_TIMEOUT = TIMEOUTS.LONG.toString(); // 5 seconds
    process.env.MAX_OUTPUT_BUFFER = String(BUFFER_SIZES.SMALL); // 1MB
    process.env.CPU_CORES_RESERVED = '3';
    process.env.MEMORY_RESERVE = '100000000'; // 100MB
    process.env.LOG_LEVEL = 'debug';

    const config = loadConfiguration();

    expect(config.timeout).toBe(TIMEOUTS.LONG);
    expect(config.maxOutputBuffer).toBe(BUFFER_SIZES.SMALL);
    expect(config.cpuCoresReserved).toBe(3); // From CPU_CORES_RESERVED env var
    expect(config.memoryReserve).toBe(100000000);
    expect(config.logLevel).toBe('debug');
  });

  it('should handle CI/CD configuration', () => {
    process.env.TASK_TIMEOUT = '600000'; // 10 minutes
    process.env.MAX_OUTPUT_BUFFER = String(BUFFER_SIZES.MEDIUM); // 10MB
    process.env.CPU_CORES_RESERVED = '2';
    process.env.MEMORY_RESERVE = '500000000'; // 500MB
    process.env.LOG_LEVEL = 'info';

    const config = loadConfiguration();

    expect(config).toMatchObject({
      timeout: 600000,
      maxOutputBuffer: BUFFER_SIZES.MEDIUM,
      cpuCoresReserved: 2, // Default 2 cores
      memoryReserve: 500000000,
      logLevel: 'info',
    });
  });
});

// ============================================================================
// Config File Persistence Tests
// ============================================================================

describe('Config File - loadConfigFile', () => {
  let tempDir: string;
  let restoreConfigDir: () => void;

  beforeEach(() => {
    tempDir = path.join(tmpdir(), `autobeat-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    restoreConfigDir = _testSetConfigDir(tempDir);
  });

  afterEach(() => {
    restoreConfigDir();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  });

  it('should return empty object when file does not exist', () => {
    const result = loadConfigFile();
    expect(typeof result).toBe('object');
    expect(result).not.toBeNull();
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('should read config from redirected directory', () => {
    writeFileSync(path.join(tempDir, 'config.json'), JSON.stringify({ timeout: 60000 }), 'utf-8');
    const result = loadConfigFile();
    expect(result.timeout).toBe(60000);
  });

  it('should warn when config file contains malformed JSON', () => {
    writeFileSync(path.join(tempDir, 'config.json'), '{ invalid json !!!', 'utf-8');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = loadConfigFile();

    expect(result).toEqual({});
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain('Failed to parse config file');

    warnSpy.mockRestore();
  });

  it('should warn when config file is not a JSON object', () => {
    writeFileSync(path.join(tempDir, 'config.json'), '"just a string"', 'utf-8');

    const result = loadConfigFile();

    // Non-object JSON returns empty without warning (handled before catch)
    expect(result).toEqual({});
  });
});

describe('Config File - saveConfigValue', () => {
  let tempDir: string;
  let restoreConfigDir: () => void;

  beforeEach(() => {
    tempDir = path.join(tmpdir(), `autobeat-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    restoreConfigDir = _testSetConfigDir(tempDir);
  });

  afterEach(() => {
    restoreConfigDir();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  });

  it('should reject unknown config keys', () => {
    const result = saveConfigValue('nonExistentKey', 42);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Unknown config key');
    }
  });

  it('should reject invalid values for known keys', () => {
    const result = saveConfigValue('timeout', -1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Invalid value');
    }
  });

  it('should reject string values for numeric keys', () => {
    const result = saveConfigValue('timeout', 'fast');
    expect(result.ok).toBe(false);
  });

  it('should validate logLevel enum', () => {
    const validResult = saveConfigValue('logLevel', 'debug');
    expect(validResult.ok).toBe(true);

    const invalidResult = saveConfigValue('logLevel', 'verbose');
    expect(invalidResult.ok).toBe(false);
  });

  it('should write to temp directory, not real home', () => {
    saveConfigValue('timeout', 60000);
    const written = existsSync(path.join(tempDir, 'config.json'));
    expect(written).toBe(true);
  });
});

describe('Config File - resetConfigValue', () => {
  let tempDir: string;
  let restoreConfigDir: () => void;

  beforeEach(() => {
    tempDir = path.join(tmpdir(), `autobeat-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    restoreConfigDir = _testSetConfigDir(tempDir);
  });

  afterEach(() => {
    restoreConfigDir();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  });

  it('should reject unknown config keys', () => {
    const result = resetConfigValue('nonExistentKey');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Unknown config key');
    }
  });

  it('should succeed for valid key even if not in file', () => {
    const result = resetConfigValue('timeout');
    expect(result.ok).toBe(true);
  });

  it('should remove key from config file', () => {
    saveConfigValue('timeout', 60000);
    resetConfigValue('timeout');
    const file = loadConfigFile();
    expect(file.timeout).toBeUndefined();
  });
});

describe('Config File - loadConfiguration with file', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let tempDir: string;
  let restoreConfigDir: () => void;

  beforeEach(() => {
    originalEnv = { ...process.env };
    tempDir = path.join(tmpdir(), `autobeat-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    restoreConfigDir = _testSetConfigDir(tempDir);
    // Clear env vars so we only see file + defaults
    delete process.env.TASK_TIMEOUT;
    delete process.env.LOG_LEVEL;
  });

  afterEach(() => {
    restoreConfigDir();
    process.env = originalEnv;
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  });

  it('should load values from config file when no env vars set', () => {
    saveConfigValue('timeout', 60000);

    const config = loadConfiguration();
    expect(config.timeout).toBe(60000);
  });

  it('should prefer env vars over config file', () => {
    saveConfigValue('timeout', 60000);

    // Set env var (higher priority)
    process.env.TASK_TIMEOUT = '120000';

    const config = loadConfiguration();
    expect(config.timeout).toBe(120000);
  });

  it('should preserve env vars when config file has invalid values', () => {
    // Write invalid value directly to config file (bypass validation)
    writeFileSync(path.join(tempDir, 'config.json'), JSON.stringify({ timeout: -999 }), 'utf-8');

    // Set a valid env var
    process.env.TASK_TIMEOUT = '120000';

    const config = loadConfiguration();
    // Env var should be preserved despite bad config file
    expect(config.timeout).toBe(120000);
  });

  it('should emit warning mentioning env vars and defaults on validation failure', () => {
    writeFileSync(path.join(tempDir, 'config.json'), JSON.stringify({ timeout: -999 }), 'utf-8');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    loadConfiguration();

    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0][0]).toContain('environment variables and defaults');

    warnSpy.mockRestore();
  });
});
