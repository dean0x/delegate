/**
 * Core domain models
 * All types are immutable (readonly)
 */

import { AgentProvider } from './agents.js';
import { AutobeatError } from './errors.js';

export type TaskId = string & { readonly __brand: 'TaskId' };
export type WorkerId = string & { readonly __brand: 'WorkerId' };
export type ScheduleId = string & { readonly __brand: 'ScheduleId' };
export type LoopId = string & { readonly __brand: 'LoopId' };
export type OrchestratorId = string & { readonly __brand: 'OrchestratorId' };

export const TaskId = (id: string): TaskId => id as TaskId;
export const WorkerId = (id: string): WorkerId => id as WorkerId;
export const ScheduleId = (id: string): ScheduleId => id as ScheduleId;
export const LoopId = (id: string): LoopId => id as LoopId;
export const OrchestratorId = (id: string): OrchestratorId => id as OrchestratorId;

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

  // Model override (per-task): overrides agent-config default model and CLI default
  // Resolution order: per-task > agent-config > CLI default
  readonly model?: string;

  // JSON schema for structured output (v1.3.0): passed to --json-schema for eval tasks
  // Only applicable to agents that support structured output (e.g., Claude Code).
  readonly jsonSchema?: string;

  // System prompt override: injected into agent via per-agent mechanism
  // Claude: --append-system-prompt (preserves defaults); Codex: -c developer_instructions;
  // Gemini: GEMINI_SYSTEM_MD env var (combined with base prompt).
  readonly systemPrompt?: string;

  // Orchestration attribution (v1.3.0): orchestration that spawned this task
  // Set when a task is created inside an orchestration context (CLI env var or MCP metadata).
  // Validated against DB on receipt — dropped silently if orchestration not found.
  readonly orchestratorId?: OrchestratorId;

  // Timestamps and results
  readonly createdAt: number;
  readonly updatedAt?: number;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly workerId?: WorkerId;
  readonly exitCode?: number;
  readonly duration?: number;
  readonly error?: Error | AutobeatError;
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
  readonly lastHeartbeat?: number; // Epoch ms of last heartbeat (undefined = no heartbeat yet)
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

  // Model override (per-task): overrides agent-config default model and CLI default
  readonly model?: string;

  // JSON schema for structured output (v1.3.0): passed to --json-schema for eval tasks
  // Only applicable to agents that support structured output (e.g., Claude Code).
  readonly jsonSchema?: string;

  // System prompt override: injected into agent via per-agent mechanism
  // Claude: --append-system-prompt; Codex: -c developer_instructions; Gemini: GEMINI_SYSTEM_MD.
  readonly systemPrompt?: string;

  // Orchestration attribution (v1.3.0): orchestration that spawned this task
  // Passed through CLI env var (AUTOBEAT_ORCHESTRATOR_ID) or MCP metadata field.
  readonly orchestratorId?: OrchestratorId;
}

export interface TaskUpdate {
  readonly status?: TaskStatus;
  readonly workerId?: WorkerId;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly exitCode?: number;
  readonly duration?: number;
  readonly error?: Error | AutobeatError;
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
    // dependents populated by DependencyRepository queries — omitted here
    dependencyState: request.dependsOn && request.dependsOn.length > 0 ? 'blocked' : 'none',
    continueFrom: request.continueFrom,

    // Execution configuration
    timeout: request.timeout,
    maxOutputBuffer: request.maxOutputBuffer,

    // Multi-agent support (v0.5.0)
    agent: request.agent,
    model: request.model,

    // Structured output for eval tasks (v1.3.0)
    jsonSchema: request.jsonSchema,

    // System prompt override
    systemPrompt: request.systemPrompt,

    // Orchestration attribution (v1.3.0)
    orchestratorId: request.orchestratorId,

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
  readonly loopConfig?: LoopCreateRequest; // Loop config if this schedule triggers loop creation (v0.8.0)
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
  readonly loopConfig?: LoopCreateRequest; // Loop config for scheduled loop creation (v0.8.0)
  readonly nextRunAt?: number; // Pre-computed next run time (from validateScheduleTiming)
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
    nextRunAt: request.nextRunAt ?? (request.scheduleType === ScheduleType.ONE_TIME ? request.scheduledAt : undefined),
    expiresAt: request.expiresAt,
    afterScheduleId: request.afterScheduleId,
    pipelineSteps: request.pipelineSteps,
    loopConfig: request.loopConfig,
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
  readonly model?: string; // Per-schedule model override
  readonly systemPrompt?: string; // system prompt injected into the agent on every scheduled run
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
  readonly model?: string; // Per-step model override
  readonly systemPrompt?: string; // Per-step system prompt override
}

export interface PipelineCreateRequest {
  readonly steps: readonly PipelineStepRequest[];
  readonly priority?: Priority; // shared default for all steps
  readonly workingDirectory?: string; // shared default for all steps
  readonly agent?: AgentProvider; // shared default for all steps
  readonly model?: string; // shared default model for all steps
  readonly systemPrompt?: string; // system prompt injected into every step task agent
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
  readonly model?: string; // shared default model for all steps
  readonly systemPrompt?: string; // system prompt injected into every step task agent on each trigger
}

/**
 * Request type for creating scheduled loops via ScheduleService
 * ARCHITECTURE: Flat structure for MCP/CLI consumption
 * Each trigger creates a fresh loop from the loopConfig
 */
export interface ScheduledLoopCreateRequest {
  readonly loopConfig: LoopCreateRequest;
  readonly scheduleType: ScheduleType;
  readonly cronExpression?: string;
  readonly scheduledAt?: string; // ISO 8601 string (parsed by service)
  readonly timezone?: string;
  readonly missedRunPolicy?: MissedRunPolicy;
  readonly maxRuns?: number;
  readonly expiresAt?: string; // ISO 8601 string (parsed by service)
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
  PAUSED = 'paused',
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
 * Evaluation mode discriminator for loop exit condition evaluation
 * ARCHITECTURE: Determines whether a shell command or agent review evaluates each iteration
 */
export enum EvalMode {
  SHELL = 'shell',
  AGENT = 'agent',
}

/**
 * Evaluation sub-strategy for agent-mode loops.
 *
 * ARCHITECTURE: Two-level eval hierarchy (evalMode + evalType).
 * Why: evalMode (shell/agent) is the top-level; evalType (feedforward/judge/schema)
 * is agent-specific sub-strategy. feedforward is default because it works with any agent.
 *
 * - feedforward: current agent's own output drives evaluation (no separate eval agent)
 * - judge: a separate dedicated agent task evaluates the iteration quality
 * - schema: structured JSON output is used for deterministic evaluation
 */
export const EvalType = {
  FEEDFORWARD: 'feedforward',
  JUDGE: 'judge',
  SCHEMA: 'schema',
} as const;
export type EvalType = (typeof EvalType)[keyof typeof EvalType];

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
  readonly exitCondition: string; // Shell command to evaluate iteration result (empty string for agent mode)
  readonly evalDirection?: OptimizeDirection; // Optimize strategy only
  readonly evalTimeout: number; // Milliseconds for exit condition evaluation
  readonly evalMode: EvalMode; // Evaluation mode: shell command or agent review
  readonly evalPrompt?: string; // Custom prompt for agent evaluator (agent mode only)
  readonly workingDirectory: string;
  readonly maxIterations: number; // 0 = unlimited
  readonly maxConsecutiveFailures: number;
  readonly cooldownMs: number;
  readonly freshContext: boolean; // Whether each iteration gets a fresh agent context
  readonly currentIteration: number;
  readonly bestScore?: number;
  readonly bestIterationId?: number;
  readonly bestIterationCommitSha?: string;
  readonly consecutiveFailures: number;
  readonly status: LoopStatus;
  readonly gitBranch?: string; // Branch name for loop iteration work (v0.8.0)
  readonly gitBaseBranch?: string; // Base branch to diff against (v0.8.0, dead after v0.8.1)
  readonly gitStartCommitSha?: string; // Commit SHA at loop creation for revert target (v0.8.1)
  readonly scheduleId?: ScheduleId; // Owning schedule if created via scheduled loop (v0.8.0)
  // Eval redesign fields (v1.3.0): sub-strategy and judge configuration
  readonly evalType?: EvalType; // Agent eval sub-strategy (default: feedforward)
  readonly judgeAgent?: AgentProvider; // Agent provider for judge mode (judge evalType only)
  readonly judgePrompt?: string; // Custom prompt for judge agent (judge evalType only)
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
  readonly taskId?: TaskId; // Optional: NULL after ON DELETE SET NULL when task is cleaned up
  readonly pipelineTaskIds?: readonly TaskId[];
  readonly status: 'running' | 'pass' | 'fail' | 'keep' | 'discard' | 'crash' | 'cancelled';
  readonly score?: number;
  readonly exitCode?: number;
  readonly errorMessage?: string;
  readonly evalFeedback?: string; // Feedback from agent evaluator (agent mode only)
  readonly evalResponse?: string; // Raw agent evaluation response text for audit (v1.3.0)
  readonly gitBranch?: string; // Branch used for this iteration (v0.8.0, dead after v0.8.1)
  readonly gitCommitSha?: string; // Commit SHA after iteration changes committed (v0.8.1)
  readonly preIterationCommitSha?: string; // Commit SHA before iteration started (v0.8.1)
  readonly gitDiffSummary?: string; // Git diff --stat summary of iteration changes (v0.8.0)
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
  readonly exitCondition?: string; // Required for shell mode, empty string for agent mode (kept non-optional for backward compat)
  readonly evalDirection?: OptimizeDirection;
  readonly evalTimeout?: number; // Default: 60000ms
  readonly evalMode?: EvalMode; // Default: EvalMode.SHELL
  readonly evalPrompt?: string; // Custom prompt for agent evaluator (agent mode only)
  readonly workingDirectory?: string;
  readonly maxIterations?: number; // Default: 10
  readonly maxConsecutiveFailures?: number; // Default: 3
  readonly cooldownMs?: number; // Default: 0
  readonly freshContext?: boolean; // Default: true
  readonly pipelineSteps?: readonly string[];
  readonly priority?: Priority;
  readonly agent?: AgentProvider;
  readonly model?: string; // Per-loop model override (applied to taskTemplate)
  readonly gitBranch?: string; // Branch name for loop iteration work (v0.8.0)
  readonly orchestratorId?: OrchestratorId; // Attribute loop tasks to this orchestration (v1.3.0)
  // Eval redesign fields (v1.3.0): sub-strategy and judge configuration
  readonly evalType?: EvalType; // Agent eval sub-strategy (default: feedforward)
  readonly judgeAgent?: AgentProvider; // Agent provider for judge mode (judge evalType only)
  readonly judgePrompt?: string; // Custom prompt for judge agent (judge evalType only)
  // System prompt override: injected into iteration task agent via per-agent mechanism
  readonly systemPrompt?: string;
}

/**
 * Create a new loop
 * ARCHITECTURE: Factory function returns frozen immutable object
 * Pattern: Follows createSchedule() convention
 */
export const createLoop = (request: LoopCreateRequest, workingDirectory: string, scheduleId?: ScheduleId): Loop => {
  const now = Date.now();
  return Object.freeze({
    id: LoopId(`loop-${crypto.randomUUID()}`),
    strategy: request.strategy,
    taskTemplate: {
      prompt: request.prompt ?? '',
      priority: request.priority,
      workingDirectory,
      agent: request.agent,
      model: request.model,
      orchestratorId: request.orchestratorId,
      systemPrompt: request.systemPrompt,
    },
    pipelineSteps: request.pipelineSteps,
    exitCondition: request.exitCondition ?? '',
    evalDirection: request.evalDirection,
    evalTimeout: request.evalTimeout ?? 60000,
    evalMode: request.evalMode ?? EvalMode.SHELL,
    evalPrompt: request.evalPrompt,
    workingDirectory,
    maxIterations: request.maxIterations ?? 10,
    maxConsecutiveFailures: request.maxConsecutiveFailures ?? 3,
    cooldownMs: request.cooldownMs ?? 0,
    freshContext: request.freshContext ?? true,
    currentIteration: 0,
    consecutiveFailures: 0,
    status: LoopStatus.RUNNING,
    gitBranch: request.gitBranch,
    scheduleId,
    // Eval redesign (v1.3.0)
    evalType: request.evalType,
    judgeAgent: request.judgeAgent,
    judgePrompt: request.judgePrompt,
    createdAt: now,
    updatedAt: now,
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

// ============================================================================
// Orchestrator types (v0.9.0: Orchestrator Mode)
// ARCHITECTURE: Autonomous multi-agent orchestration with state file management
// Pattern: Immutable domain objects with factory functions, following Loop conventions
// ============================================================================

/**
 * Orchestrator status values
 * ARCHITECTURE: Tracks lifecycle of autonomous orchestration sessions
 */
export enum OrchestratorStatus {
  PLANNING = 'planning',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

/**
 * Orchestration interface - defines an autonomous orchestration session
 * ARCHITECTURE: All fields readonly for immutability
 * Pattern: Factory function createOrchestration() for construction
 */
export interface Orchestration {
  readonly id: OrchestratorId;
  readonly goal: string;
  readonly loopId?: LoopId;
  readonly stateFilePath: string;
  readonly workingDirectory: string;
  readonly agent?: AgentProvider;
  readonly model?: string;
  readonly maxDepth: number;
  readonly maxWorkers: number;
  readonly maxIterations: number;
  readonly status: OrchestratorStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
}

/**
 * Request type for creating orchestrations
 * ARCHITECTURE: Flat structure for MCP/CLI consumption
 */
export interface OrchestratorCreateRequest {
  readonly goal: string;
  readonly workingDirectory?: string;
  readonly agent?: AgentProvider;
  readonly model?: string;
  readonly maxDepth?: number;
  readonly maxWorkers?: number;
  readonly maxIterations?: number;
  // System prompt override: replaces default role instructions when provided.
  // Orchestrator's role/capability instructions are auto-generated; setting this overrides them.
  readonly systemPrompt?: string;
}

/**
 * Create a new orchestration
 * ARCHITECTURE: Factory function returns frozen immutable object
 * Pattern: Follows createLoop() convention
 */
export const createOrchestration = (
  request: OrchestratorCreateRequest,
  stateFilePath: string,
  workingDirectory: string,
): Orchestration => {
  const now = Date.now();
  return Object.freeze({
    id: OrchestratorId(`orchestrator-${crypto.randomUUID()}`),
    goal: request.goal,
    stateFilePath,
    workingDirectory,
    agent: request.agent,
    model: request.model,
    maxDepth: request.maxDepth ?? 3,
    maxWorkers: request.maxWorkers ?? 5,
    maxIterations: request.maxIterations ?? 50,
    status: OrchestratorStatus.PLANNING,
    createdAt: now,
    updatedAt: now,
  });
};

/**
 * Immutable update helper for orchestrations
 * ARCHITECTURE: Returns new frozen object, never mutates input
 * Pattern: Follows updateLoop() convention
 */
export const updateOrchestration = (orchestration: Orchestration, update: Partial<Orchestration>): Orchestration => {
  return Object.freeze({
    ...orchestration,
    ...update,
    updatedAt: Date.now(),
  });
};

// ============================================================================
// v1.3.0: Task usage tracking, orchestrator children, activity feed
// ============================================================================

/**
 * Token/cost usage record for a completed task.
 * Captured at task completion from the Claude JSON output.
 * ARCHITECTURE: Immutable value object — no mutations.
 */
export interface TaskUsage {
  readonly taskId: TaskId;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly totalCostUsd: number;
  readonly model?: string;
  readonly capturedAt: number;
}

/**
 * A task attributed to an orchestration, discovered via direct attribution
 * (tasks.orchestrator_id) or the loop iteration chain.
 * ARCHITECTURE: Read-only projection used by workspace view.
 */
export interface OrchestratorChild {
  readonly taskId: TaskId;
  readonly kind: 'direct' | 'iteration';
  readonly iterationId?: number;
  readonly status: TaskStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly prompt: string;
  readonly agent?: AgentProvider;
}

/**
 * A single entry in the activity feed — time-sorted merge of recent state
 * changes across tasks, loops, orchestrations, and schedules.
 * ARCHITECTURE: Read-only value object for dashboard display.
 * timestamp is epoch ms (number) — matches all other domain time fields.
 */
export interface ActivityEntry {
  readonly timestamp: number;
  readonly kind: 'task' | 'loop' | 'orchestration' | 'schedule';
  readonly entityId: string;
  readonly status: string;
  readonly action: string; // short verb: 'created', 'completed', 'failed', 'iteration 3'
}
