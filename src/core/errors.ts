/**
 * Error types for Result pattern
 * Never throw these - always return them in Result.err()
 *
 * @see /docs/SECURITY.md for security-related error handling
 */

/**
 * Error codes used throughout the application
 * Organized by category for better maintainability
 */
export enum ErrorCode {
  // Task errors
  /** Task with specified ID does not exist */
  TASK_NOT_FOUND = 'TASK_NOT_FOUND',
  /** Task is already running and cannot be started again */
  TASK_ALREADY_RUNNING = 'TASK_ALREADY_RUNNING',
  /** Task is in a state that prevents cancellation */
  TASK_CANNOT_CANCEL = 'TASK_CANNOT_CANCEL',
  /** Task exceeded its configured timeout */
  TASK_TIMEOUT = 'TASK_TIMEOUT',

  // Resource errors
  /** System lacks resources (CPU/memory) to spawn new workers */
  INSUFFICIENT_RESOURCES = 'INSUFFICIENT_RESOURCES',
  /** Failed to monitor system resources */
  RESOURCE_MONITORING_FAILED = 'RESOURCE_MONITORING_FAILED',
  /** Resource limit exceeded (e.g., max listeners, subscriptions) */
  RESOURCE_LIMIT_EXCEEDED = 'RESOURCE_LIMIT_EXCEEDED',
  /** Resource exhausted (e.g., queue full, memory limit) - DoS protection */
  RESOURCE_EXHAUSTED = 'RESOURCE_EXHAUSTED',

  // Process errors
  /** Failed to spawn child process */
  PROCESS_SPAWN_FAILED = 'PROCESS_SPAWN_FAILED',
  /** Failed to kill child process */
  PROCESS_KILL_FAILED = 'PROCESS_KILL_FAILED',
  /** Process with specified PID not found */
  PROCESS_NOT_FOUND = 'PROCESS_NOT_FOUND',

  // Worker errors
  /** Worker with specified ID not found */
  WORKER_NOT_FOUND = 'WORKER_NOT_FOUND',
  /** Failed to spawn worker process */
  WORKER_SPAWN_FAILED = 'WORKER_SPAWN_FAILED',
  /** Failed to kill worker process */
  WORKER_KILL_FAILED = 'WORKER_KILL_FAILED',
  /** Task execution failed within worker */
  TASK_EXECUTION_FAILED = 'TASK_EXECUTION_FAILED',

  // Validation errors (Security-critical)
  /** Input validation failed - may indicate injection attempt */
  INVALID_INPUT = 'INVALID_INPUT',
  /** Task ID format or content invalid */
  INVALID_TASK_ID = 'INVALID_TASK_ID',
  /** Task prompt validation failed */
  INVALID_PROMPT = 'INVALID_PROMPT',
  /** Directory path invalid or outside allowed boundaries */
  INVALID_DIRECTORY = 'INVALID_DIRECTORY',

  // System errors
  /** Generic system error - check logs for details */
  SYSTEM_ERROR = 'SYSTEM_ERROR',
  /** Configuration validation or loading failed */
  CONFIGURATION_ERROR = 'CONFIGURATION_ERROR',
  /** Dependency injection failed - required component not found in container */
  DEPENDENCY_INJECTION_FAILED = 'DEPENDENCY_INJECTION_FAILED',
  /**
   * Operation not allowed in current context
   * @example Attempting to retry a task that is not in a terminal state (QUEUED, RUNNING)
   * @example Trying to cancel a task that has already completed
   * @example Performing operations on tasks without required permissions
   */
  INVALID_OPERATION = 'INVALID_OPERATION',
  /**
   * System state inconsistent or corrupted
   * @example Missing expected data in database
   * @example Task references non-existent parent task
   * @example Orphaned worker processes without corresponding tasks
   * @example Database schema version mismatch
   */
  INVALID_STATE = 'INVALID_STATE',

  // Queue errors
  /** Task queue has reached maximum capacity */
  QUEUE_FULL = 'QUEUE_FULL',
  /** Attempted operation on empty queue */
  QUEUE_EMPTY = 'QUEUE_EMPTY',

  // Agent errors (v0.5.0 Multi-Agent Support)
  /** Requested agent provider is not registered in the registry */
  AGENT_NOT_FOUND = 'AGENT_NOT_FOUND',
  /** Agent adapter exists but is misconfigured (e.g., CLI not installed) */
  AGENT_MISCONFIGURED = 'AGENT_MISCONFIGURED',

  // Orchestrator errors (v0.9.0 Orchestrator Mode)
  /** Orchestration with specified ID does not exist */
  ORCHESTRATION_NOT_FOUND = 'ORCHESTRATION_NOT_FOUND',

  // Tmux errors (v1.6.0 tmux Worker Migration)
  /** Failed to create, destroy, or communicate with a tmux session */
  TMUX_SESSION_FAILED = 'TMUX_SESSION_FAILED',
  /** tmux not installed, version too old, or binary not found */
  TMUX_VALIDATION_FAILED = 'TMUX_VALIDATION_FAILED',
  /** Failed to generate wrapper script or create session directory */
  TMUX_HOOK_FAILED = 'TMUX_HOOK_FAILED',
  /** Failed to send keys to a tmux session */
  TMUX_SEND_KEYS_FAILED = 'TMUX_SEND_KEYS_FAILED',
}

/**
 * Custom error class for Autobeat
 * Includes error code and optional context for debugging
 *
 * @example
 * return err(new AutobeatError(
 *   ErrorCode.INVALID_INPUT,
 *   'Path traversal detected',
 *   { path: inputPath, base: baseDir }
 * ));
 */
export class AutobeatError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AutobeatError';
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      context: this.context,
    };
  }
}

/**
 * Error factory functions
 */
export const taskNotFound = (taskId: string): AutobeatError =>
  new AutobeatError(ErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found`, { taskId });

export const taskAlreadyRunning = (taskId: string): AutobeatError =>
  new AutobeatError(ErrorCode.TASK_ALREADY_RUNNING, `Task ${taskId} is already running`, { taskId });

export const taskTimeout = (taskId: string, timeoutMs: number): AutobeatError =>
  new AutobeatError(ErrorCode.TASK_TIMEOUT, `Task ${taskId} timed out after ${timeoutMs}ms`, { taskId, timeoutMs });

export const insufficientResources = (cpuUsage: number, availableMemory: number): AutobeatError =>
  new AutobeatError(
    ErrorCode.INSUFFICIENT_RESOURCES,
    `Insufficient resources: CPU ${cpuUsage}%, Memory ${availableMemory} bytes`,
    { cpuUsage, availableMemory },
  );

export const processSpawnFailed = (reason: string): AutobeatError =>
  new AutobeatError(ErrorCode.PROCESS_SPAWN_FAILED, `Failed to spawn process: ${reason}`, { reason });

export const invalidInput = (field: string, value: unknown): AutobeatError =>
  new AutobeatError(ErrorCode.INVALID_INPUT, `Invalid input for field ${field}`, { field, value });

export const invalidDirectory = (path: string): AutobeatError =>
  new AutobeatError(ErrorCode.INVALID_DIRECTORY, `Invalid directory: ${path}`, { path });

export const systemError = (message: string, originalError?: Error): AutobeatError =>
  new AutobeatError(ErrorCode.SYSTEM_ERROR, message, { originalError: originalError?.message });

export const resourceLimitExceeded = (resourceType: string, limit: number, current: number): AutobeatError =>
  new AutobeatError(
    ErrorCode.RESOURCE_LIMIT_EXCEEDED,
    `Resource limit exceeded for ${resourceType}: limit=${limit}, current=${current}`,
    { resourceType, limit, current },
  );

export const agentNotFound = (provider: string, available: readonly string[]): AutobeatError =>
  new AutobeatError(
    ErrorCode.AGENT_NOT_FOUND,
    `Agent '${provider}' not found. Available agents: ${available.join(', ')}`,
    { provider, available },
  );

export const agentMisconfigured = (provider: string, reason: string): AutobeatError =>
  new AutobeatError(ErrorCode.AGENT_MISCONFIGURED, `Agent '${provider}' is misconfigured: ${reason}`, {
    provider,
    reason,
  });

export const tmuxSessionFailed = (
  operation: string,
  reason: string,
  context?: Record<string, unknown>,
): AutobeatError =>
  new AutobeatError(ErrorCode.TMUX_SESSION_FAILED, `tmux session ${operation} failed: ${reason}`, {
    operation,
    reason,
    ...context,
  });

export const tmuxValidationFailed = (reason: string, context?: Record<string, unknown>): AutobeatError =>
  new AutobeatError(ErrorCode.TMUX_VALIDATION_FAILED, `tmux validation failed: ${reason}`, {
    reason,
    ...context,
  });

export const tmuxHookFailed = (operation: string, reason: string, context?: Record<string, unknown>): AutobeatError =>
  new AutobeatError(ErrorCode.TMUX_HOOK_FAILED, `tmux hook ${operation} failed: ${reason}`, {
    operation,
    reason,
    ...context,
  });

export const tmuxSendKeysFailed = (
  sessionName: string,
  reason: string,
  context?: Record<string, unknown>,
): AutobeatError =>
  new AutobeatError(ErrorCode.TMUX_SEND_KEYS_FAILED, `Failed to send keys to session '${sessionName}': ${reason}`, {
    sessionName,
    reason,
    ...context,
  });

/**
 * Type guard for AutobeatError
 */
export const isAutobeatError = (error: unknown): error is AutobeatError => {
  return error instanceof AutobeatError;
};

/**
 * Convert unknown errors to AutobeatError
 */
export const toAutobeatError = (error: unknown): AutobeatError => {
  if (isAutobeatError(error)) {
    return error;
  }

  if (error instanceof Error) {
    return systemError(error.message, error);
  }

  // Handle objects with message property
  if (error && typeof error === 'object' && 'message' in error) {
    return systemError(String((error as { message: unknown }).message));
  }

  // Handle null/undefined
  if (error == null) {
    return systemError('Unknown error');
  }

  return systemError(String(error));
};

/**
 * Create a standardized error handler for tryCatchAsync operations.
 * Reduces boilerplate by providing a consistent error format across the codebase.
 *
 * @param operation - Description of the operation (e.g., 'get dependencies', 'resolve dependency')
 * @param context - Optional context object to include in the error
 * @returns Error handler function compatible with tryCatchAsync
 *
 * @example
 * ```typescript
 * return tryCatchAsync(
 *   async () => db.query(...),
 *   operationErrorHandler('get dependencies', { taskId })
 * );
 * ```
 */
export const operationErrorHandler = (
  operation: string,
  context?: Record<string, unknown>,
): ((error: unknown) => AutobeatError) => {
  return (error: unknown): AutobeatError => {
    const message = error instanceof Error ? error.message : String(error);
    return new AutobeatError(ErrorCode.SYSTEM_ERROR, `Failed to ${operation}: ${message}`, context);
  };
};
