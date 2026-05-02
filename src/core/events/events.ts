/**
 * Event type definitions for the hybrid event-driven architecture.
 * Commands flow through events (TaskDelegated, TaskQueued, etc.).
 * Queries use direct repository access (no query events).
 * 34 event types after adding orchestration events (v0.9.0).
 */

import {
  Loop,
  LoopId,
  LoopIteration,
  MissedRunPolicy,
  Orchestration,
  OrchestratorId,
  PipelineId,
  PipelineStatus,
  Schedule,
  ScheduleId,
  Task,
  TaskCheckpoint,
  TaskId,
  WorkerId,
} from '../domain.js';
import { AutobeatError } from '../errors.js';

/**
 * Base event interface - all events extend this
 */
export interface BaseEvent {
  eventId: string;
  timestamp: number;
  source: string;
}

/**
 * Task lifecycle events
 */
export interface TaskDelegatedEvent extends BaseEvent {
  type: 'TaskDelegated';
  task: Task;
}

export interface TaskQueuedEvent extends BaseEvent {
  type: 'TaskQueued';
  taskId: TaskId;
}

export interface TaskStartingEvent extends BaseEvent {
  type: 'TaskStarting';
  taskId: TaskId;
}

export interface TaskStartedEvent extends BaseEvent {
  type: 'TaskStarted';
  taskId: TaskId;
  workerId: WorkerId;
}

export interface TaskCompletedEvent extends BaseEvent {
  type: 'TaskCompleted';
  taskId: TaskId;
  exitCode: number;
  duration: number;
}

export interface TaskFailedEvent extends BaseEvent {
  type: 'TaskFailed';
  taskId: TaskId;
  error: AutobeatError;
  exitCode?: number;
}

export interface TaskCancelledEvent extends BaseEvent {
  type: 'TaskCancelled';
  taskId: TaskId;
  reason?: string;
}

export interface TaskTimeoutEvent extends BaseEvent {
  type: 'TaskTimeout';
  taskId: TaskId;
  error: AutobeatError;
}

export interface TaskCancellationRequestedEvent extends BaseEvent {
  type: 'TaskCancellationRequested';
  taskId: TaskId;
  reason?: string;
}

/**
 * Output and configuration events
 */
export interface OutputCapturedEvent extends BaseEvent {
  type: 'OutputCaptured';
  taskId: TaskId;
  outputType: 'stdout' | 'stderr';
  data: string;
}

export interface RequeueTaskEvent extends BaseEvent {
  type: 'RequeueTask';
  task: Task;
}

/**
 * Dependency events - for task dependency management
 * ARCHITECTURE: Part of DAG-based task dependency system
 * Pattern: Event-driven dependency validation and resolution tracking
 */
export interface TaskDependencyAddedEvent extends BaseEvent {
  type: 'TaskDependencyAdded';
  taskId: TaskId;
  dependsOnTaskId: TaskId;
}

export interface TaskDependencyResolvedEvent extends BaseEvent {
  type: 'TaskDependencyResolved';
  taskId: TaskId;
  dependsOnTaskId: TaskId;
  resolution: 'completed' | 'failed' | 'cancelled';
}

export interface TaskUnblockedEvent extends BaseEvent {
  type: 'TaskUnblocked';
  taskId: TaskId;
  task: Task; // ARCHITECTURE: Include task to prevent layer violation in QueueHandler
}

export interface TaskDependencyFailedEvent extends BaseEvent {
  type: 'TaskDependencyFailed';
  taskId: TaskId;
  failedDependencyId: TaskId;
  error: AutobeatError;
}

/**
 * Schedule lifecycle events
 * ARCHITECTURE: Part of scheduled task execution system
 * Pattern: Event-driven schedule management with execution tracking
 */
export interface ScheduleCreatedEvent extends BaseEvent {
  type: 'ScheduleCreated';
  schedule: Schedule;
}

export interface ScheduleTriggeredEvent extends BaseEvent {
  type: 'ScheduleTriggered';
  scheduleId: ScheduleId;
  triggeredAt: number; // Epoch ms when trigger occurred
}

export interface ScheduleExecutedEvent extends BaseEvent {
  type: 'ScheduleExecuted';
  scheduleId: ScheduleId;
  taskId?: TaskId; // ID of the task created from this execution (undefined for loop triggers)
  loopId?: LoopId; // ID of the loop created from this execution (undefined for task/pipeline triggers)
  executedAt: number; // Epoch ms when execution started
}

export interface ScheduleMissedEvent extends BaseEvent {
  type: 'ScheduleMissed';
  scheduleId: ScheduleId;
  missedAt: number; // Epoch ms of the missed run time
  policy: MissedRunPolicy; // Policy that will be applied
}

export interface ScheduleCancelledEvent extends BaseEvent {
  type: 'ScheduleCancelled';
  scheduleId: ScheduleId;
  reason?: string;
}

export interface SchedulePausedEvent extends BaseEvent {
  type: 'SchedulePaused';
  scheduleId: ScheduleId;
}

export interface ScheduleResumedEvent extends BaseEvent {
  type: 'ScheduleResumed';
  scheduleId: ScheduleId;
}

export interface ScheduleExpiredEvent extends BaseEvent {
  type: 'ScheduleExpired';
  scheduleId: ScheduleId;
}

export interface ScheduleUpdatedEvent extends BaseEvent {
  type: 'ScheduleUpdated';
  scheduleId: ScheduleId;
  update: Partial<Schedule>; // Fields that were updated
}

/**
 * Checkpoint and resumption events
 * ARCHITECTURE: Part of task resumption system ("smart retry with context")
 */
export interface CheckpointCreatedEvent extends BaseEvent {
  type: 'CheckpointCreated';
  taskId: TaskId;
  checkpoint: TaskCheckpoint;
}

/**
 * Loop lifecycle events
 * ARCHITECTURE: Part of iterative task/pipeline loop system (v0.7.0)
 * Pattern: Event-driven loop management with iteration tracking
 */
export interface LoopCreatedEvent extends BaseEvent {
  type: 'LoopCreated';
  loop: Loop;
}

export interface LoopIterationCompletedEvent extends BaseEvent {
  type: 'LoopIterationCompleted';
  loopId: LoopId;
  iterationNumber: number;
  result: LoopIteration;
}

export interface LoopCompletedEvent extends BaseEvent {
  type: 'LoopCompleted';
  loopId: LoopId;
  reason: string;
}

export interface LoopCancelledEvent extends BaseEvent {
  type: 'LoopCancelled';
  loopId: LoopId;
  reason?: string;
}

export interface LoopPausedEvent extends BaseEvent {
  type: 'LoopPaused';
  loopId: LoopId;
  force: boolean; // If true, current iteration was cancelled; if false, waits for iteration to finish
}

export interface LoopResumedEvent extends BaseEvent {
  type: 'LoopResumed';
  loopId: LoopId;
}

/**
 * Orchestration lifecycle events
 * ARCHITECTURE: Part of autonomous orchestration system (v0.9.0)
 * Pattern: Event-driven orchestration management with loop correlation
 */
export interface OrchestrationCreatedEvent extends BaseEvent {
  type: 'OrchestrationCreated';
  orchestration: Orchestration;
}

export interface OrchestrationCompletedEvent extends BaseEvent {
  type: 'OrchestrationCompleted';
  orchestratorId: OrchestratorId;
  reason: string;
}

export interface OrchestrationCancelledEvent extends BaseEvent {
  type: 'OrchestrationCancelled';
  orchestratorId: OrchestratorId;
  reason?: string;
}

/**
 * Pipeline lifecycle events
 * ARCHITECTURE: Part of first-class pipeline entity system (Phase A: Dashboard Visibility Overhaul)
 * Pattern: Event-driven pipeline lifecycle tracking with step-level granularity
 */
export interface PipelineCreatedEvent extends BaseEvent {
  type: 'PipelineCreated';
  pipelineId: PipelineId;
  steps: number;
}

export interface PipelineStatusChangedEvent extends BaseEvent {
  type: 'PipelineStatusChanged';
  pipelineId: PipelineId;
  fromStatus: PipelineStatus;
  toStatus: PipelineStatus;
}

export interface PipelineStepCompletedEvent extends BaseEvent {
  type: 'PipelineStepCompleted';
  pipelineId: PipelineId;
  stepIndex: number;
  taskId: TaskId;
}

export interface PipelineCompletedEvent extends BaseEvent {
  type: 'PipelineCompleted';
  pipelineId: PipelineId;
}

export interface PipelineFailedEvent extends BaseEvent {
  type: 'PipelineFailed';
  pipelineId: PipelineId;
  failedStepIndex: number;
  taskId: TaskId;
}

export interface PipelineCancelledEvent extends BaseEvent {
  type: 'PipelineCancelled';
  pipelineId: PipelineId;
}

/**
 * Union type of all events
 */
export type AutobeatEvent =
  // Task lifecycle events
  | TaskDelegatedEvent
  | TaskQueuedEvent
  | TaskStartingEvent
  | TaskStartedEvent
  | TaskCompletedEvent
  | TaskFailedEvent
  | TaskCancelledEvent
  | TaskTimeoutEvent
  | TaskCancellationRequestedEvent
  // Queue events
  | RequeueTaskEvent
  // Dependency events
  | TaskDependencyAddedEvent
  | TaskDependencyResolvedEvent
  | TaskUnblockedEvent
  | TaskDependencyFailedEvent
  // Schedule lifecycle events
  | ScheduleCreatedEvent
  | ScheduleTriggeredEvent
  | ScheduleExecutedEvent
  | ScheduleMissedEvent
  | ScheduleCancelledEvent
  | SchedulePausedEvent
  | ScheduleResumedEvent
  | ScheduleExpiredEvent
  | ScheduleUpdatedEvent
  // Checkpoint events
  | CheckpointCreatedEvent
  // Output events
  | OutputCapturedEvent
  // Loop lifecycle events
  | LoopCreatedEvent
  | LoopIterationCompletedEvent
  | LoopCompletedEvent
  | LoopCancelledEvent
  | LoopPausedEvent
  | LoopResumedEvent
  // Orchestration lifecycle events
  | OrchestrationCreatedEvent
  | OrchestrationCompletedEvent
  | OrchestrationCancelledEvent
  // Pipeline lifecycle events
  | PipelineCreatedEvent
  | PipelineStatusChangedEvent
  | PipelineStepCompletedEvent
  | PipelineCompletedEvent
  | PipelineFailedEvent
  | PipelineCancelledEvent;

/**
 * Event handler function type
 */
export type EventHandler<T extends AutobeatEvent = AutobeatEvent> = (event: T) => Promise<void>;

/**
 * Helper to create events with consistent metadata
 */
export function createEvent<T extends AutobeatEvent>(
  type: T['type'],
  payload: Omit<T, keyof BaseEvent | 'type'>,
  source = 'autobeat',
): T {
  return {
    type,
    eventId: crypto.randomUUID(),
    timestamp: Date.now(),
    source,
    ...payload,
  } as T;
}
