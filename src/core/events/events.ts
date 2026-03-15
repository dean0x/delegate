/**
 * Event type definitions for the event-driven architecture
 * All system state changes flow through these events
 */

import {
  MissedRunPolicy,
  Schedule,
  ScheduleId,
  ScheduleStatus,
  Task,
  TaskCheckpoint,
  TaskId,
  WorkerId,
} from '../domain.js';
import { BackbeatError } from '../errors.js';

/**
 * Base event interface - all events extend this
 */
export interface BaseEvent {
  eventId: string;
  timestamp: number;
  source: string;
  /** Correlation ID for request-response pattern */
  __correlationId?: string;
}

/**
 * Task lifecycle events
 */
export interface TaskDelegatedEvent extends BaseEvent {
  type: 'TaskDelegated';
  task: Task;
}

export interface TaskPersistedEvent extends BaseEvent {
  type: 'TaskPersisted';
  taskId: TaskId;
  task: Task; // Include full task for QueueHandler
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
  error: BackbeatError;
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
  error: BackbeatError;
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

/**
 * Query events - for read operations in pure event-driven architecture
 * ARCHITECTURE: Part of pure event-driven pattern - ALL operations go through events
 */
export interface TaskStatusQueryEvent extends BaseEvent {
  type: 'TaskStatusQuery';
  taskId?: TaskId; // If omitted, return all tasks
}

export interface TaskStatusResponseEvent extends BaseEvent {
  type: 'TaskStatusResponse';
  result: Task | readonly Task[];
}

export interface TaskLogsQueryEvent extends BaseEvent {
  type: 'TaskLogsQuery';
  taskId: TaskId;
  tail?: number;
}

export interface TaskLogsResponseEvent extends BaseEvent {
  type: 'TaskLogsResponse';
  taskId: TaskId;
  stdout: readonly string[];
  stderr: readonly string[];
  totalSize: number;
}

/**
 * Queue query events - for pure event-driven queue operations
 */
export interface NextTaskQueryEvent extends BaseEvent {
  type: 'NextTaskQuery';
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
  error: BackbeatError;
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
  taskId: TaskId; // ID of the task created from this execution
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
 * Schedule query events - for pure event-driven reads
 * ARCHITECTURE: Follows same pattern as TaskStatusQuery/TaskStatusResponse
 */
export interface ScheduleQueryEvent extends BaseEvent {
  type: 'ScheduleQuery';
  scheduleId?: ScheduleId; // If omitted, return all schedules
  status?: ScheduleStatus; // Optional filter by status
}

export interface ScheduleQueryResponseEvent extends BaseEvent {
  type: 'ScheduleQueryResponse';
  schedules: readonly Schedule[];
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
 * Union type of all events
 */
export type BackbeatEvent =
  // Task lifecycle events
  | TaskDelegatedEvent
  | TaskPersistedEvent
  | TaskQueuedEvent
  | TaskStartingEvent
  | TaskStartedEvent
  | TaskCompletedEvent
  | TaskFailedEvent
  | TaskCancelledEvent
  | TaskTimeoutEvent
  | TaskCancellationRequestedEvent
  // Query events (pure event-driven architecture)
  | TaskStatusQueryEvent
  | TaskStatusResponseEvent
  | TaskLogsQueryEvent
  | TaskLogsResponseEvent
  // Queue query events
  | NextTaskQueryEvent
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
  // Schedule query events
  | ScheduleQueryEvent
  | ScheduleQueryResponseEvent
  // Checkpoint events
  | CheckpointCreatedEvent
  // Output events
  | OutputCapturedEvent;

/**
 * Event handler function type
 */
export type EventHandler<T extends BackbeatEvent = BackbeatEvent> = (event: T) => Promise<void>;

/**
 * Helper to create events with consistent metadata
 */
export function createEvent<T extends BackbeatEvent>(
  type: T['type'],
  payload: Omit<T, keyof BaseEvent | 'type'>,
  source = 'backbeat',
): T {
  return {
    type,
    eventId: crypto.randomUUID(),
    timestamp: Date.now(),
    source,
    ...payload,
  } as T;
}
