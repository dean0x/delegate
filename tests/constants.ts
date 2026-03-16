/**
 * Test Constants
 * Centralizes all test configuration values and magic numbers
 *
 * ARCHITECTURE: Use these constants instead of inline magic numbers in tests
 */

// Timeouts (in milliseconds)
export const TIMEOUTS = {
  IMMEDIATE: 0,
  SHORT: 100,
  MEDIUM: 1000,
  LONG: 5000,
  VERY_LONG: 30000,
  DEFAULT_TASK: 30000,
  INTEGRATION_TEST: 60000,
  E2E_TEST: 300000,
} as const;

// Buffer Sizes (in bytes)
export const BUFFER_SIZES = {
  TINY: 1024, // 1KB
  SMALL: 1048576, // 1MB
  MEDIUM: 10485760, // 10MB
  LARGE: 52428800, // 50MB
  HUGE: 1073741824, // 1GB
  DEFAULT: 10485760, // 10MB
} as const;

// Memory Sizes (in bytes)
export const MEMORY_SIZES = {
  MB_100: 100000000,
  MB_500: 500000000,
  GB_1: 1073741824,
  GB_2: 2147483648,
  GB_4: 4294967296,
  GB_8: 8589934592,
  DEFAULT_RESERVE: 2684354560, // 2.5GB
} as const;

// CPU Configuration
export const CPU_CONFIG = {
  MIN_CORES: 1,
  DEFAULT_CORES_RESERVED: 2,
  MAX_CORES: 32,
  HIGH_USAGE_PERCENT: 80,
  CRITICAL_USAGE_PERCENT: 95,
  LOW_USAGE_PERCENT: 30,
} as const;

// Retry Configuration
export const RETRY_CONFIG = {
  MAX_ATTEMPTS: 3,
  BASE_DELAY: 1000,
  MAX_DELAY: 30000,
  BACKOFF_MULTIPLIER: 2,
  JITTER_MAX: 1000,
} as const;

// Queue Configuration
export const QUEUE_CONFIG = {
  MAX_SIZE: 1000,
  BATCH_SIZE: 10,
  PRIORITY_LEVELS: 3,
  CONCURRENT_WORKERS: 5,
} as const;

// Test Data Counts
export const TEST_COUNTS = {
  SMALL_SET: 3,
  MEDIUM_SET: 10,
  LARGE_SET: 100,
  STRESS_TEST: 1000,
  CONCURRENT_TASKS: 5,
  WORKER_POOL_SIZE: 4,
} as const;

// Event Names
export const EVENT_TYPES = {
  TASK_DELEGATED: 'TaskDelegated',
  TASK_QUEUED: 'TaskQueued',
  TASK_STARTED: 'TaskStarted',
  TASK_COMPLETED: 'TaskCompleted',
  TASK_FAILED: 'TaskFailed',
  TASK_CANCELLED: 'TaskCancelled',
  OUTPUT_CAPTURED: 'OutputCaptured',
} as const;

// Database Configuration
export const DB_CONFIG = {
  BUSY_TIMEOUT: 5000,
  MAX_CONNECTIONS: 10,
  WAL_CHECKPOINT_INTERVAL: 1000,
  VACUUM_THRESHOLD: 100,
} as const;

// File Paths
export const TEST_PATHS = {
  TEMP_DIR: '/tmp/backbeat-test',
  FIXTURES_DIR: './tests/fixtures',
  OUTPUT_DIR: './test-output',
  DB_FILE: ':memory:', // Use in-memory DB for tests
  LOG_FILE: './test-logs/test.log',
} as const;

// Process Configuration
export const PROCESS_CONFIG = {
  SPAWN_TIMEOUT: 5000,
  KILL_TIMEOUT: 10000,
  HEARTBEAT_INTERVAL: 30000,
  MAX_OUTPUT_SIZE: 10485760,
  STDIO_ENCODING: 'utf8' as const,
} as const;

// Performance Thresholds
export const PERFORMANCE_THRESHOLDS = {
  TASK_THROUGHPUT_MIN: 10, // tasks/second
  EVENT_LATENCY_P50: 10, // milliseconds
  EVENT_LATENCY_P95: 50, // milliseconds
  EVENT_LATENCY_P99: 100, // milliseconds
  DB_QUERY_MAX: 100, // milliseconds
  MEMORY_GROWTH_MAX: 100, // MB per hour
} as const;

// Error Messages
export const ERROR_MESSAGES = {
  TASK_NOT_FOUND: 'Task not found',
  WORKER_NOT_AVAILABLE: 'No available workers',
  RESOURCE_EXHAUSTED: 'System resources exhausted',
  DATABASE_LOCKED: 'Database is locked',
  TIMEOUT_EXCEEDED: 'Operation timeout exceeded',
  INVALID_INPUT: 'Invalid input provided',
} as const;

// Test User Data
export const TEST_USERS = {
  ALICE: { id: 'user-1', name: 'Alice' },
  BOB: { id: 'user-2', name: 'Bob' },
  CHARLIE: { id: 'user-3', name: 'Charlie' },
} as const;

// Wait times for async operations
export const WAIT_FOR = {
  EVENT_PROPAGATION: 50,
  DATABASE_WRITE: 100,
  PROCESS_SPAWN: 500,
  WORKER_READY: 1000,
  CLEANUP: 200,
} as const;

// Assertion helpers
export const ASSERTION_CONFIG = {
  FLOAT_PRECISION: 0.001,
  TIMESTAMP_TOLERANCE: 1000, // 1 second tolerance for timestamps
  RETRY_ASSERTION_TIMES: 3,
  RETRY_ASSERTION_DELAY: 100,
} as const;
