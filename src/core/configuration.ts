import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { z } from 'zod';
import { AGENT_PROVIDERS_TUPLE, type AgentProvider, isAgentProvider } from './agents.js';

/**
 * Configuration Schema with Zod
 *
 * ARCHITECTURE PRINCIPLE: "Parse, don't validate"
 * - Schema transforms input into complete, valid configuration
 * - Fields with .default() are required with fallbacks (not truly optional)
 * - After parse(), all fields guaranteed present (type-safe, no undefined)
 * - Single source of truth for validation AND defaults
 *
 * Reference: https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/
 */
export const ConfigurationSchema = z.object({
  // Core settings - required fields
  timeout: z
    .number()
    .min(1000)
    .max(60 * 60 * 1000)
    .default(1800000), // Default: 30min (SECURITY: max 1 hour)
  maxOutputBuffer: z.number().min(1024).max(1073741824).default(10485760), // Default: 10MB (max 1GB)
  cpuCoresReserved: z.number().min(1).max(32).default(2), // Default: 2 cores (SECURITY: max 32)
  memoryReserve: z
    .number()
    .min(0)
    .max(64 * 1024 * 1024 * 1024)
    .default(2684354560), // Default: 2.5GB (SECURITY: max 64GB)
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  // EventBus resource limits - prevent memory leaks
  maxListenersPerEvent: z.number().min(10).max(10000).default(100),
  maxTotalSubscriptions: z.number().min(100).max(100000).default(1000),
  // Process management configuration
  killGracePeriodMs: z.number().min(1000).max(60000).default(5000), // Default: 5 second grace period
  resourceMonitorIntervalMs: z.number().min(1000).max(60000).default(5000), // Default: check every 5 seconds
  minSpawnDelayMs: z.number().min(10).max(60000).default(10000), // Default: 10s minimum delay between spawns (Claude Code is heavyweight)
  settlingWindowMs: z.number().min(5000).max(60000).default(15000), // Default: 15s settling window for newly spawned workers
  // Storage configuration
  fileStorageThresholdBytes: z.number().min(1024).max(10485760).default(102400), // Default: 100KB threshold
  // Output flushing configuration
  outputFlushIntervalMs: z.number().min(500).max(30000).default(5000), // Default: flush output every 5 seconds
  // Retry behavior configuration
  retryInitialDelayMs: z.number().min(100).max(10000).default(1000), // Default: 1 second initial delay
  retryMaxDelayMs: z.number().min(5000).max(300000).default(30000), // Default: 30 second max delay
  // Recovery configuration
  taskRetentionDays: z.number().min(1).max(365).default(7), // Default: keep tasks for 7 days
  // Agent configuration (v0.5.0 Multi-Agent Support)
  defaultAgent: z.enum(AGENT_PROVIDERS_TUPLE).optional(),
});

export type Configuration = z.infer<typeof ConfigurationSchema>;

// Per-task configuration (partial override)
export interface TaskConfiguration {
  readonly timeout?: number;
  readonly maxOutputBuffer?: number;
}

const DEFAULT_CONFIG: Configuration = {
  timeout: 1800000, // 30 minutes (within 1-hour security limit)
  maxOutputBuffer: 10485760, // 10MB
  cpuCoresReserved: 2, // Reserve 2 CPU cores for system stability (within 32-core security limit)
  memoryReserve: 2684354560, // 2.5GB - ensure adequate memory reserve for system stability (within 64GB security limit)
  logLevel: 'info',
  maxListenersPerEvent: 100, // Default: prevent memory leaks from excessive listeners
  maxTotalSubscriptions: 1000, // Default: global limit on subscriptions
  // Process management defaults
  killGracePeriodMs: 5000, // Default: 5 seconds grace period for process termination
  resourceMonitorIntervalMs: 5000, // Default: check resources every 5 seconds
  minSpawnDelayMs: 10000, // Default: 10s minimum delay between spawns (Claude Code is heavyweight)
  settlingWindowMs: 15000, // Default: 15s settling window for newly spawned workers
  // Storage defaults
  fileStorageThresholdBytes: 102400, // Default: 100KB threshold for file storage
  // Output flushing defaults
  outputFlushIntervalMs: 5000, // Default: flush output every 5 seconds
  // Retry behavior defaults
  retryInitialDelayMs: 1000, // Default: 1 second initial retry delay
  retryMaxDelayMs: 30000, // Default: 30 second maximum retry delay
  // Recovery defaults
  taskRetentionDays: 7, // Default: keep tasks for 7 days before cleanup
};

function parseEnvNumber(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

function parseEnvLogLevel(value: string | undefined): 'debug' | 'info' | 'warn' | 'error' {
  if (!value) return 'info';
  return ['debug', 'info', 'warn', 'error'].includes(value) ? (value as 'debug' | 'info' | 'warn' | 'error') : 'info';
}

export function loadConfiguration(): Configuration {
  /**
   * ARCHITECTURE: "Parse, don't validate"
   * - We build a partial config from env vars
   * - Zod fills in defaults for missing fields via .default()
   * - Result is always complete and valid (type-safe, no undefined)
   * - No non-null assertions needed - Zod guarantees values
   */

  // Build partial config from environment variables (omit undefined to let Zod fill defaults)
  const envConfig: Record<string, unknown> = {};

  if (process.env.TASK_TIMEOUT) envConfig.timeout = parseEnvNumber(process.env.TASK_TIMEOUT, 0);
  if (process.env.MAX_OUTPUT_BUFFER) envConfig.maxOutputBuffer = parseEnvNumber(process.env.MAX_OUTPUT_BUFFER, 0);
  if (process.env.CPU_CORES_RESERVED) envConfig.cpuCoresReserved = parseEnvNumber(process.env.CPU_CORES_RESERVED, 0);
  if (process.env.MEMORY_RESERVE) envConfig.memoryReserve = parseEnvNumber(process.env.MEMORY_RESERVE, 0);
  if (process.env.LOG_LEVEL) envConfig.logLevel = parseEnvLogLevel(process.env.LOG_LEVEL);
  if (process.env.EVENTBUS_MAX_LISTENERS_PER_EVENT)
    envConfig.maxListenersPerEvent = parseEnvNumber(process.env.EVENTBUS_MAX_LISTENERS_PER_EVENT, 0);
  if (process.env.EVENTBUS_MAX_TOTAL_SUBSCRIPTIONS)
    envConfig.maxTotalSubscriptions = parseEnvNumber(process.env.EVENTBUS_MAX_TOTAL_SUBSCRIPTIONS, 0);
  if (process.env.PROCESS_KILL_GRACE_PERIOD_MS)
    envConfig.killGracePeriodMs = parseEnvNumber(process.env.PROCESS_KILL_GRACE_PERIOD_MS, 0);
  if (process.env.RESOURCE_MONITOR_INTERVAL_MS)
    envConfig.resourceMonitorIntervalMs = parseEnvNumber(process.env.RESOURCE_MONITOR_INTERVAL_MS, 0);
  if (process.env.WORKER_MIN_SPAWN_DELAY_MS)
    envConfig.minSpawnDelayMs = parseEnvNumber(process.env.WORKER_MIN_SPAWN_DELAY_MS, 0);
  if (process.env.WORKER_SETTLING_WINDOW_MS)
    envConfig.settlingWindowMs = parseEnvNumber(process.env.WORKER_SETTLING_WINDOW_MS, 0);
  if (process.env.FILE_STORAGE_THRESHOLD_BYTES)
    envConfig.fileStorageThresholdBytes = parseEnvNumber(process.env.FILE_STORAGE_THRESHOLD_BYTES, 0);
  if (process.env.OUTPUT_FLUSH_INTERVAL_MS)
    envConfig.outputFlushIntervalMs = parseEnvNumber(process.env.OUTPUT_FLUSH_INTERVAL_MS, 0);
  if (process.env.RETRY_INITIAL_DELAY_MS)
    envConfig.retryInitialDelayMs = parseEnvNumber(process.env.RETRY_INITIAL_DELAY_MS, 0);
  if (process.env.RETRY_MAX_DELAY_MS) envConfig.retryMaxDelayMs = parseEnvNumber(process.env.RETRY_MAX_DELAY_MS, 0);
  if (process.env.TASK_RETENTION_DAYS) envConfig.taskRetentionDays = parseEnvNumber(process.env.TASK_RETENTION_DAYS, 0);
  if (process.env.AUTOBEAT_DEFAULT_AGENT && isAgentProvider(process.env.AUTOBEAT_DEFAULT_AGENT))
    envConfig.defaultAgent = process.env.AUTOBEAT_DEFAULT_AGENT;

  // Layer 2: Config file values (lower priority than env vars)
  const fileConfig = loadConfigFile();

  // Merge: env vars override config file values
  const merged = { ...fileConfig, ...envConfig };

  // Parse and validate - Zod fills in defaults for missing fields
  const parseResult = ConfigurationSchema.safeParse(merged);

  if (parseResult.success) {
    return parseResult.data; // Guaranteed complete and valid
  }

  // Merged parse failed — likely a bad config file value.
  // Try env-only so valid env vars aren't dropped by a corrupt config file.
  const errors = parseResult.error.errors.map((e) => `  - ${e.path.join('.')}: ${e.message}`).join('\n');
  console.warn(
    `[Autobeat] Configuration file validation failed, falling back to environment variables and defaults:\n${errors}`,
  );

  const envOnlyResult = ConfigurationSchema.safeParse(envConfig);
  if (envOnlyResult.success) {
    return envOnlyResult.data;
  }

  // Both failed — pure defaults
  return ConfigurationSchema.parse({});
}

// ============================================================================
// Config File Persistence (~/.autobeat/config.json)
// ============================================================================

type ConfigWriteResult = { ok: true } | { ok: false; error: string };

// Display path for CLI (always shows real home path)
export const CONFIG_FILE_PATH = path.join(homedir(), '.autobeat', 'config.json');

// Internal mutable paths — overridable via _testSetConfigDir() for test isolation
let _configDir = path.join(homedir(), '.autobeat');
let _configFilePath = CONFIG_FILE_PATH;

/** Test helper: redirect config reads/writes to a temp directory. Returns restore function. */
export function _testSetConfigDir(dir: string): () => void {
  const prevDir = _configDir;
  const prevPath = _configFilePath;
  _configDir = dir;
  _configFilePath = path.join(dir, 'config.json');
  return () => {
    _configDir = prevDir;
    _configFilePath = prevPath;
  };
}

/** Write config object to disk with secure permissions (dir 0o700, file 0o600) */
function writeConfigFile(data: Record<string, unknown>): ConfigWriteResult {
  try {
    mkdirSync(_configDir, { recursive: true, mode: 0o700 });
    writeFileSync(_configFilePath, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
    chmodSync(_configFilePath, 0o600); // Ensure permissions on pre-existing files (writeFileSync mode only applies on creation)
    return { ok: true };
  } catch {
    return { ok: false, error: `Failed to write config file at ${_configFilePath}` };
  }
}

export function loadConfigFile(): Record<string, unknown> {
  try {
    if (!existsSync(_configFilePath)) return {};
    const raw = readFileSync(_configFilePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    console.warn(`[Autobeat] Failed to parse config file, ignoring: ${_configFilePath}`);
    return {};
  }
}

export function saveConfigValue(key: string, value: unknown): ConfigWriteResult {
  // Validate key exists in schema
  const schemaShape = ConfigurationSchema.shape;
  if (!(key in schemaShape)) {
    const validKeys = Object.keys(schemaShape).join(', ');
    return { ok: false, error: `Unknown config key: ${key}. Valid keys: ${validKeys}` };
  }

  // Validate value against the specific field
  const fieldSchema = schemaShape[key as keyof typeof schemaShape];
  const fieldResult = fieldSchema.safeParse(value);
  if (!fieldResult.success) {
    const msg = fieldResult.error.errors.map((e) => e.message).join('; ');
    return { ok: false, error: `Invalid value for ${key}: ${msg}` };
  }

  // Load existing, merge, write
  const existing = loadConfigFile();
  existing[key] = fieldResult.data;
  return writeConfigFile(existing);
}

export function resetConfigValue(key: string): ConfigWriteResult {
  const schemaShape = ConfigurationSchema.shape;
  if (!(key in schemaShape)) {
    const validKeys = Object.keys(schemaShape).join(', ');
    return { ok: false, error: `Unknown config key: ${key}. Valid keys: ${validKeys}` };
  }

  const existing = loadConfigFile();
  if (!(key in existing)) {
    return { ok: true }; // Already at default
  }

  delete existing[key];
  return writeConfigFile(existing);
}

// ============================================================================
// Per-Agent Config Storage (agents.<provider>.apiKey in config.json)
// ============================================================================

export interface AgentConfig {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly model?: string;
}

/**
 * Load agent-specific config from the `agents.<provider>` section of config.json
 */
export function loadAgentConfig(provider: AgentProvider): AgentConfig {
  const file = loadConfigFile();
  const agents = file.agents;
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) return {};
  const section = (agents as Record<string, unknown>)[provider];
  if (!section || typeof section !== 'object' || Array.isArray(section)) return {};
  const record = section as Record<string, unknown>;
  return {
    apiKey: typeof record.apiKey === 'string' ? record.apiKey : undefined,
    baseUrl: typeof record.baseUrl === 'string' ? record.baseUrl : undefined,
    model: typeof record.model === 'string' ? record.model : undefined,
  };
}

/**
 * Save a key-value pair under the `agents.<provider>` section of config.json
 *
 * Edge cases:
 * - Empty string: deletes the key instead of saving it
 * - baseUrl: strips trailing slash before saving
 */
export function saveAgentConfig(
  provider: AgentProvider,
  key: 'apiKey' | 'baseUrl' | 'model',
  value: string,
): ConfigWriteResult {
  const existing = loadConfigFile();
  const agents = (
    existing.agents && typeof existing.agents === 'object' && !Array.isArray(existing.agents) ? existing.agents : {}
  ) as Record<string, unknown>;
  const section = (
    agents[provider] && typeof agents[provider] === 'object' && !Array.isArray(agents[provider]) ? agents[provider] : {}
  ) as Record<string, unknown>;

  if (value === '') {
    // Empty string clears the key
    delete section[key];
  } else {
    // Normalize baseUrl: strip trailing slash
    const normalized = key === 'baseUrl' ? value.replace(/\/$/, '') : value;
    section[key] = normalized;
  }

  agents[provider] = section;
  existing.agents = agents;
  return writeConfigFile(existing);
}

/**
 * Remove all stored config for a specific agent provider
 */
export function resetAgentConfig(provider: AgentProvider): ConfigWriteResult {
  const existing = loadConfigFile();
  const agents = existing.agents;
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) {
    return { ok: true }; // Nothing to reset
  }

  const agentsRecord = agents as Record<string, unknown>;
  if (!(provider in agentsRecord)) {
    return { ok: true }; // Already clean
  }

  delete agentsRecord[provider];
  // Clean up empty agents object
  if (Object.keys(agentsRecord).length === 0) {
    delete existing.agents;
  } else {
    existing.agents = agentsRecord;
  }

  return writeConfigFile(existing);
}
