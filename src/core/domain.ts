/**
 * Core domain models
 * All types are immutable (readonly)
 */

import { AgentProvider } from './agents.js';
import { BackbeatError } from './errors.js';

export type TaskId = string & { readonly __brand: 'TaskId' };
export type WorkerId = string & { readonly __brand: 'WorkerId' };
export type ScheduleId = string & { readonly __brand: 'ScheduleId' };
export type LoopId = string & { readonly __brand: 'LoopId' };

export const TaskId = (id: string): TaskId => id as TaskId;
export const WorkerId = (id: string): WorkerId => id as WorkerId;
export const ScheduleId = (id: string): ScheduleId => id as ScheduleId;
export const LoopId = (id: string): LoopId => id as LoopId;

export enum Priority {
  P0 = 'P0', // Critical
  P1 = 'P1', // High
  P2 = 'P2', // Normal
}

export enum TaskStatus {
  QUEUED = 'queued',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

/**
 * Schedule status values
 * ARCHITECTURE: Tracks lifecycle of scheduled task triggers
 */
export enum ScheduleStatus {
  ACTIVE = 'active', // Schedule is active and will trigger at next scheduled time
  PAUSED = 'paused', // Schedule is temporarily paused (can be resumed)
  COMPLETED = 'completed', // Schedule has completed (maxRuns reached or one-time schedule executed)
  CANCELLED = 'cancelled', // Schedule was manually cancelled
  EXPIRED = 'expired', // Schedule has passed its expiration time
}

/**
 * Schedule type discriminator
 * ARCHITECTURE: Determines how next run time is calculated
 */
export enum ScheduleType {
  CRON = 'cron', // Recurring schedule using cron expression (5-field standard)
  ONE_TIME = 'one_time', // Single execution at specified timestamp
}

/**
 * Policy for handling missed schedule runs
 * ARCHITECTURE: Determines behavior when scheduled time passes without execution
 * Common scenarios: server downtime, high load, maintenance windows
 */
export enum MissedRunPolicy {
  SKIP = 'skip', // Skip missed runs, continue with next scheduled time (default)
  CATCHUP = 'catchup', // Execute missed runs immediately (one by one)
  FAIL = 'fail', // Mark schedule as failed if run is missed
}

export interface Task {
  readonly id: TaskId;
  readonly prompt: string;
  readonly status: TaskStatus;
  readonly priority: Priority;
  readonly workingDirectory?: string;

  // Execution control
  readonly timeout?: number;
  readonly maxOutputBuffer?: number;

  // Retry tracking - populated when task is created via retry-task command
  // RETRY CHAIN DESIGN:
  // - parentTaskId: Points to the ROOT task of the entire retry chain
  //   This allows grouping all retries of the same original request
  // - retryOf: Points to the IMMEDIATE parent being retried
  //   This allows reconstructing the retry sequence
  // - retryCount: Increments with each retry (1, 2, 3...)
  //   This shows how many attempts have been made
  readonly parentTaskId?: TaskId; // Root task ID in retry chain (original task)
  readonly retryCount?: number; // Number in retry chain (1 = first retry, 2 = second, etc.)
  readonly retryOf?: TaskId; // Direct parent task ID (task this is a retry of)

  // Dependency tracking (Phase 4: Task Dependencies)
  // DEPENDENCY DESIGN:
  // - These are cached/derived fields populated from DependencyRepository
  // - Actual dependency relationships stored in task_dependencies table
  // - DAG validation enforced at DependencyGraph layer
  readonly dependsOn?: readonly TaskId[]; // Tasks this task depends on (blocking tasks)
  readonly dependents?: readonly TaskId[]; // Tasks that depend on this task (blocked tasks)
  readonly dependencyState?: 'blocked' | 'ready' | 'none'; // Computed dependency state

  // Session continuation (v0.5.0): Task ID to continue from
  // When set, DependencyHandler enriches prompt with checkpoint context from this dependency
  readonly continueFrom?: TaskId;

  // Multi-agent support (v0.5.0): Which agent provider to use for execution
  // Resolved by TaskManager: explicit task agent > config defaultAgent > error
  readonly agent?: AgentProvider;

  // Timestamps and results
  readonly createdAt: number;
  readonly updatedAt?: number;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly workerId?: WorkerId;
  readonly exitCode?: number;
  readonly duration?: number;
  readonly error?: Error | BackbeatError;
}

export interface Worker {
  readonly id: WorkerId;
  readonly taskId: TaskId;
  readonly pid: number;
  readonly startedAt: number;
  readonly cpuUsage: number;
  readonly memoryUsage: number;
}

/**
 * Worker registration for cross-process coordination
 * ARCHITECTURE: Dedicated type for DB coordination — separate from Worker which has
 * ephemeral per-process fields (cpuUsage, memoryUsage). WorkerRegistration tracks
 * ownerPid and agent for cross-process visibility and PID-based recovery.
 */
export interface WorkerRegistration {
  readonly workerId: WorkerId;
  readonly taskId: TaskId;
  readonly pid: number;
  readonly ownerPid: number;
  readonly agent: string;
  readonly startedAt: number;
}

export interface SystemResources {
  readonly cpuUsage: number; // 0-100
  readonly availableMemory: number; // bytes
  readonly totalMemory: number; // bytes
  readonly loadAverage: readonly [number, number, number];
  readonly workerCount: number;
}

export interface TaskOutput {
  readonly taskId: TaskId;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
  readonly totalSize: number;
}

export interface TaskRequest {
  readonly prompt: string;
  readonly priority?: Priority;
  readonly workingDirectory?: string;

  // Execution control
  readonly timeout?: number;
  readonly maxOutputBuffer?: number;

  // Retry tracking (used internally when creating retry tasks)
  readonly parentTaskId?: TaskId;
  readonly retryCount?: number;
  readonly retryOf?: TaskId;

  // Dependency tracking (Phase 4: Task Dependencies)
  // Array of task IDs this task depends on (must complete before this task can run)
  readonly dependsOn?: readonly TaskId[];

  // Session continuation (v0.5.0): Task ID to continue from
  // When set, the task's prompt is enriched with checkpoint context from this dependency before running
  // Must be in dependsOn list (auto-added if missing)
  readonly continueFrom?: TaskId;

  // Multi-agent support (v0.5.0): Which agent provider to use
  // Resolved by TaskManager: explicit task agent > config defaultAgent > error
  readonly agent?: AgentProvider;
}

export interface TaskUpdate {
  readonly status?: TaskStatus;
  readonly workerId?: WorkerId;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly exitCode?: number;
  readonly duration?: number;
  readonly error?: Error | BackbeatError;
}

/**
 * Immutable update helper
 */
export const updateTask = (task: Task, update: TaskUpdate): Task => ({
  ...task,
  ...update,
  updatedAt: Date.now(),
});

/**
 * Create a new task
 */
export const createTask = (request: TaskRequest): Task => {
  const now = Date.now(); // Capture once to ensure createdAt === updatedAt
  return Object.freeze({
    id: TaskId(`task-${crypto.randomUUID()}`),
    prompt: request.prompt,
    status: TaskStatus.QUEUED,
    priority: request.priority || Priority.P2,
    workingDirectory: request.workingDirectory,

    // Retry tracking
    parentTaskId: request.parentTaskId,
    retryCount: request.retryCount,
    retryOf: request.retryOf,

    // Dependency tracking (Phase 4: Task Dependencies)
    // NOTE: dependsOn from request is the initial dependency list
    // Actual validation and DAG cycle detection happens in DependencyHandler
    dependsOn: request.dependsOn,
    dependents: undefined, // Populated by DependencyRepository queries
    dependencyState: request.dependsOn && request.dependsOn.length > 0 ? 'blocked' : 'none',
    continueFrom: request.continueFrom,

    // Execution configuration
    timeout: request.timeout,
    maxOutputBuffer: request.maxOutputBuffer,

    // Multi-agent support (v0.5.0)
    agent: request.agent,

    createdAt: now,
    updatedAt: now,
  });
};

/**
 * Check if task is terminal state
 */
export const isTerminalState = (status: TaskStatus): boolean => {
  return [TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED].includes(status);
};

/**
 * Check if task can be cancelled
 */
export const canCancel = (task: Task): boolean => {
  return task.status === TaskStatus.QUEUED || task.status === TaskStatus.RUNNING;
};

/**
 * Priority comparison
 */
export const comparePriority = (a: Priority, b: Priority): number => {
  const order = { [Priority.P0]: 0, [Priority.P1]: 1, [Priority.P2]: 2 };
  return order[a] - order[b];
};

/**
 * Schedule interface - defines recurring or one-time task execution
 * ARCHITECTURE: All fields readonly for immutability
 * Pattern: Factory function createSchedule() for construction
 */
export interface Schedule {
  readonly id: ScheduleId;
  readonly taskTemplate: TaskRequest; // What to run when schedule triggers
  readonly scheduleType: ScheduleType;
  readonly cronExpression?: string; // For CRON type: standard 5-field expression (minute hour day month weekday)
  readonly scheduledAt?: number; // For ONE_TIME type: epoch milliseconds
  readonly timezone: string; // IANA timezone identifier (e.g., 'America/New_York'), default 'UTC'
  readonly missedRunPolicy: MissedRunPolicy;
  readonly status: ScheduleStatus;
  readonly maxRuns?: number; // Optional limit for CRON schedules (undefined = unlimited)
  readonly runCount: number; // Number of times schedule has triggered
  readonly lastRunAt?: number; // Timestamp of last execution (epoch ms)
  readonly nextRunAt?: number; // Computed next execution time (epoch ms)
  readonly expiresAt?: number; // Optional expiration time (epoch ms)
  readonly afterScheduleId?: ScheduleId; // Chain: new tasks depend on this schedule's latest task
  readonly pipelineSteps?: readonly PipelineStepRequest[]; // Pipeline: ordered steps to create on each trigger
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * Request type for creating schedules
 * ARCHITECTURE: Subset of Schedule fields that caller provides
 */
export interface ScheduleRequest {
  readonly taskTemplate: TaskRequest;
  readonly scheduleType: ScheduleType;
  readonly cronExpression?: string; // Required for CRON type
  readonly scheduledAt?: number; // Required for ONE_TIME type
  readonly timezone?: string; // Default: 'UTC'
  readonly missedRunPolicy?: MissedRunPolicy; // Default: SKIP
  readonly maxRuns?: number; // Optional limit for CRON
  readonly expiresAt?: number; // Optional expiration
  readonly afterScheduleId?: ScheduleId; // Chain: block until after-schedule's latest task completes
  readonly pipelineSteps?: readonly PipelineStepRequest[]; // Pipeline: ordered steps for scheduled pipeline
}

/**
 * Update type for modifying schedules
 * ARCHITECTURE: Only fields that can be modified after creation
 */
export interface ScheduleUpdate {
  readonly status?: ScheduleStatus;
  readonly cronExpression?: string;
  readonly scheduledAt?: number;
  readonly timezone?: string;
  readonly missedRunPolicy?: MissedRunPolicy;
  readonly maxRuns?: number;
  readonly runCount?: number;
  readonly lastRunAt?: number;
  readonly nextRunAt?: number;
  readonly expiresAt?: number;
  readonly afterScheduleId?: ScheduleId;
}

/**
 * Create a new schedule
 * ARCHITECTURE: Factory function returns frozen immutable object
 * Note: nextRunAt must be computed by caller (requires cron parsing logic)
 */
export const createSchedule = (request: ScheduleRequest): Schedule => {
  const now = Date.now();
  return Object.freeze({
    id: ScheduleId(`schedule-${crypto.randomUUID()}`),
    taskTemplate: request.taskTemplate,
    scheduleType: request.scheduleType,
    cronExpression: request.cronExpression,
    scheduledAt: request.scheduledAt,
    timezone: request.timezone ?? 'UTC',
    missedRunPolicy: request.missedRunPolicy ?? MissedRunPolicy.SKIP,
    status: ScheduleStatus.ACTIVE,
    maxRuns: request.maxRuns,
    runCount: 0,
    lastRunAt: undefined,
    nextRunAt: request.scheduleType === ScheduleType.ONE_TIME ? request.scheduledAt : undefined,
    expiresAt: request.expiresAt,
    afterScheduleId: request.afterScheduleId,
    pipelineSteps: request.pipelineSteps,
    createdAt: now,
    updatedAt: now,
  });
};

/**
 * Immutable update helper for schedules
 * ARCHITECTURE: Returns new frozen object, never mutates input
 */
export const updateSchedule = (schedule: Schedule, update: ScheduleUpdate): Schedule => {
  return Object.freeze({
    ...schedule,
    ...update,
    updatedAt: Date.now(),
  });
};

/**
 * Check if schedule is in active state (can trigger)
 * ARCHITECTURE: Pure function for status checking
 */
export const isScheduleActive = (schedule: Schedule): boolean => {
  return schedule.status === ScheduleStatus.ACTIVE;
};

/**
 * Request type for creating schedules via ScheduleService
 * ARCHITECTURE: Flat structure for CLI/service consumption (not event-oriented)
 */
export interface ScheduleCreateRequest {
  readonly prompt: string;
  readonly scheduleType: ScheduleType;
  readonly cronExpression?: string;
  readonly scheduledAt?: string; // ISO 8601 string (parsed by service)
  readonly timezone?: string; // IANA timezone, default 'UTC'
  readonly missedRunPolicy?: MissedRunPolicy;
  readonly priority?: Priority;
  readonly workingDirectory?: string;
  readonly maxRuns?: number;
  readonly expiresAt?: string; // ISO 8601 string (parsed by service)
  readonly afterScheduleId?: ScheduleId; // Chain: block until after-schedule's latest task completes
  readonly agent?: AgentProvider; // Multi-agent support (v0.5.0)
}

/**
 * Pipeline types - sequential task execution via chained one-time schedules
 * ARCHITECTURE: Used by both MCP CreatePipeline tool and CLI pipeline command
 */
export interface PipelineStepRequest {
  readonly prompt: string;
  readonly priority?: Priority;
  readonly workingDirectory?: string;
  readonly agent?: AgentProvider; // Multi-agent support (v0.5.0)
}

export interface PipelineCreateRequest {
  readonly steps: readonly PipelineStepRequest[];
  readonly priority?: Priority; // shared default for all steps
  readonly workingDirectory?: string; // shared default for all steps
  readonly agent?: AgentProvider; // shared default for all steps
}

/**
 * Request type for creating scheduled pipelines via ScheduleService
 * ARCHITECTURE: Flat structure for MCP/CLI consumption
 * Each trigger creates fresh tasks with linear dependencies from pipelineSteps
 */
export interface ScheduledPipelineCreateRequest {
  readonly steps: readonly PipelineStepRequest[];
  readonly scheduleType: ScheduleType;
  readonly cronExpression?: string;
  readonly scheduledAt?: string; // ISO 8601 string (parsed by service)
  readonly timezone?: string;
  readonly missedRunPolicy?: MissedRunPolicy;
  readonly priority?: Priority; // shared default for all steps
  readonly workingDirectory?: string; // shared default for all steps
  readonly maxRuns?: number;
  readonly expiresAt?: string; // ISO 8601 string (parsed by service)
  readonly afterScheduleId?: ScheduleId;
  readonly agent?: AgentProvider; // shared default for all steps
}

export interface PipelineStep {
  readonly index: number;
  readonly scheduleId: ScheduleId;
  readonly prompt: string;
}

export interface PipelineResult {
  readonly pipelineId: ScheduleId; // first schedule ID (stable reference)
  readonly steps: readonly PipelineStep[];
}

/**
 * Task checkpoint - snapshot of task state at completion/failure
 * ARCHITECTURE: Captures enough context to create enriched retry prompts
 * Pattern: Immutable record, created by CheckpointHandler on task terminal events
 */
export interface TaskCheckpoint {
  readonly id: number;
  readonly taskId: TaskId;
  readonly checkpointType: 'completed' | 'failed' | 'cancelled';
  readonly outputSummary?: string; // Last N lines of stdout
  readonly errorSummary?: string; // Last N lines of stderr or error message
  readonly gitBranch?: string;
  readonly gitCommitSha?: string;
  readonly gitDirtyFiles?: readonly string[];
  readonly contextNote?: string; // User-provided context on resume
  readonly createdAt: number;
}

/**
 * Request type for resuming a failed/completed task with enriched context
 * ARCHITECTURE: "Smart retry" - captures checkpoint + additional context to create better retry
 */
export interface ResumeTaskRequest {
  readonly taskId: TaskId;
  readonly additionalContext?: string; // User-provided instructions for retry
}

// ============================================================================
// Loop types (v0.7.0: Task/Pipeline Loops)
// ARCHITECTURE: Iterative task execution with exit condition evaluation
// Pattern: Immutable domain objects with factory functions, following Schedule conventions
// ============================================================================

/**
 * Loop status values
 * ARCHITECTURE: Tracks lifecycle of iterative task loops
 */
export enum LoopStatus {
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

/**
 * Loop strategy discriminator
 * ARCHITECTURE: Determines how iteration results are evaluated
 * - RETRY: Exit condition is pass/fail (exit code 0 = pass)
 * - OPTIMIZE: Exit condition returns a numeric score, loop seeks best score
 */
export enum LoopStrategy {
  RETRY = 'retry',
  OPTIMIZE = 'optimize',
}

/**
 * Direction for optimize strategy scoring
 * ARCHITECTURE: Determines whether lower or higher scores are better
 */
export enum OptimizeDirection {
  MINIMIZE = 'minimize',
  MAXIMIZE = 'maximize',
}

/**
 * Loop interface - defines iterative task/pipeline execution
 * ARCHITECTURE: All fields readonly for immutability
 * Pattern: Factory function createLoop() for construction
 */
export interface Loop {
  readonly id: LoopId;
  readonly strategy: LoopStrategy;
  readonly taskTemplate: TaskRequest;
  readonly pipelineSteps?: readonly string[];
  readonly exitCondition: string; // Shell command to evaluate iteration result
  readonly evalDirection?: OptimizeDirection; // Optimize strategy only
  readonly evalTimeout: number; // Milliseconds for exit condition evaluation
  readonly workingDirectory: string;
  readonly maxIterations: number; // 0 = unlimited
  readonly maxConsecutiveFailures: number;
  readonly cooldownMs: number;
  readonly freshContext: boolean; // Whether each iteration gets a fresh agent context
  readonly currentIteration: number;
  readonly bestScore?: number;
  readonly bestIterationId?: number;
  readonly consecutiveFailures: number;
  readonly status: LoopStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
}

/**
 * Loop iteration record - tracks individual iteration execution
 * ARCHITECTURE: Immutable record of each iteration attempt and outcome
 */
export interface LoopIteration {
  readonly id: number; // Autoincrement
  readonly loopId: LoopId;
  readonly iterationNumber: number;
  readonly taskId: TaskId;
  readonly pipelineTaskIds?: readonly TaskId[];
  readonly status: 'running' | 'pass' | 'fail' | 'keep' | 'discard' | 'crash' | 'cancelled';
  readonly score?: number;
  readonly exitCode?: number;
  readonly errorMessage?: string;
  readonly startedAt: number;
  readonly completedAt?: number;
}

/**
 * Request type for creating loops via LoopService
 * ARCHITECTURE: Flat structure for MCP/CLI consumption
 */
export interface LoopCreateRequest {
  readonly prompt?: string; // Optional if pipeline mode (pipelineSteps provided)
  readonly strategy: LoopStrategy;
  readonly exitCondition: string;
  readonly evalDirection?: OptimizeDirection;
  readonly evalTimeout?: number; // Default: 60000ms
  readonly workingDirectory?: string;
  readonly maxIterations?: number; // Default: 10
  readonly maxConsecutiveFailures?: number; // Default: 3
  readonly cooldownMs?: number; // Default: 0
  readonly freshContext?: boolean; // Default: true
  readonly pipelineSteps?: readonly string[];
  readonly priority?: Priority;
  readonly agent?: AgentProvider;
}

/**
 * Create a new loop
 * ARCHITECTURE: Factory function returns frozen immutable object
 * Pattern: Follows createSchedule() convention
 */
export const createLoop = (request: LoopCreateRequest, workingDirectory: string): Loop => {
  const now = Date.now();
  return Object.freeze({
    id: LoopId(`loop-${crypto.randomUUID()}`),
    strategy: request.strategy,
    taskTemplate: {
      prompt: request.prompt ?? '',
      priority: request.priority,
      workingDirectory,
      agent: request.agent,
    },
    pipelineSteps: request.pipelineSteps,
    exitCondition: request.exitCondition,
    evalDirection: request.evalDirection,
    evalTimeout: request.evalTimeout ?? 60000,
    workingDirectory,
    maxIterations: request.maxIterations ?? 10,
    maxConsecutiveFailures: request.maxConsecutiveFailures ?? 3,
    cooldownMs: request.cooldownMs ?? 0,
    freshContext: request.freshContext ?? true,
    currentIteration: 0,
    bestScore: undefined,
    bestIterationId: undefined,
    consecutiveFailures: 0,
    status: LoopStatus.RUNNING,
    createdAt: now,
    updatedAt: now,
    completedAt: undefined,
  });
};

/**
 * Immutable update helper for loops
 * ARCHITECTURE: Returns new frozen object, never mutates input
 * Pattern: Follows updateSchedule() convention
 */
export const updateLoop = (loop: Loop, update: Partial<Loop>): Loop => {
  return Object.freeze({
    ...loop,
    ...update,
    updatedAt: Date.now(),
  });
};
