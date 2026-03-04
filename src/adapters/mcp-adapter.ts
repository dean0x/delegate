/**
 * MCP Protocol Adapter
 * Bridges the MCP protocol with our new architecture
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';
import pkg from '../../package.json' with { type: 'json' };
import {
  PipelineCreateRequest,
  Priority,
  ResumeTaskRequest,
  ScheduleCreateRequest,
  ScheduleId,
  ScheduleStatus,
  ScheduleType,
  Task,
  TaskId,
  TaskRequest,
} from '../core/domain.js';
import { Logger, ScheduleService, TaskManager } from '../core/interfaces.js';
import { match } from '../core/result.js';
import { toMissedRunPolicy } from '../services/schedule-manager.js';
import { validatePath } from '../utils/validation.js';

// Zod schemas for MCP protocol validation
const DelegateTaskSchema = z.object({
  prompt: z.string().min(1).max(4000),
  priority: z.enum(['P0', 'P1', 'P2']).optional(),
  workingDirectory: z.string().optional(),
  timeout: z.number().min(1000).max(86400000).optional(), // 1 second to 24 hours
  maxOutputBuffer: z.number().min(1024).max(1073741824).optional(), // 1KB to 1GB
  dependsOn: z.array(z.string()).optional(), // Task IDs this task depends on
  continueFrom: z
    .string()
    .regex(/^task-/)
    .optional()
    .describe(
      'Task ID to continue from — receives checkpoint context from this dependency (must be in dependsOn list)',
    ),
});

const TaskStatusSchema = z.object({
  taskId: z.string().optional(),
});

const TaskLogsSchema = z.object({
  taskId: z.string(),
  tail: z.number().optional().default(100),
});

const CancelTaskSchema = z.object({
  taskId: z.string(),
  reason: z.string().optional(),
});

const RetryTaskSchema = z.object({
  taskId: z.string(),
});

const ResumeTaskSchema = z.object({
  taskId: z.string().describe('Task ID to resume (must be in terminal state)'),
  additionalContext: z.string().max(4000).optional().describe('Additional instructions for the resumed task'),
});

// Schedule-related Zod schemas (v0.4.0 Task Scheduling)
const ScheduleTaskSchema = z.object({
  prompt: z.string().min(1).max(4000).describe('Task prompt to execute'),
  scheduleType: z.enum(['cron', 'one_time']).describe('Schedule type'),
  cronExpression: z.string().optional().describe('Cron expression (5-field) for recurring schedules'),
  scheduledAt: z.string().optional().describe('ISO 8601 datetime for one-time schedules'),
  timezone: z.string().optional().default('UTC').describe('IANA timezone'),
  missedRunPolicy: z.enum(['skip', 'catchup', 'fail']).optional().default('skip'),
  priority: z.enum(['P0', 'P1', 'P2']).optional(),
  workingDirectory: z.string().optional(),
  maxRuns: z.number().min(1).optional().describe('Maximum number of runs for cron schedules'),
  expiresAt: z.string().optional().describe('ISO 8601 datetime when schedule expires'),
  afterSchedule: z
    .string()
    .optional()
    .describe("Schedule ID to chain after (new tasks depend on this schedule's latest task)"),
});

const ListSchedulesSchema = z.object({
  status: z.enum(['active', 'paused', 'completed', 'cancelled', 'expired']).optional(),
  limit: z.number().min(1).max(100).optional().default(50),
  offset: z.number().min(0).optional().default(0),
});

const CancelScheduleSchema = z.object({
  scheduleId: z.string().describe('Schedule ID to cancel'),
  reason: z.string().optional().describe('Reason for cancellation'),
});

const GetScheduleSchema = z.object({
  scheduleId: z.string().describe('Schedule ID'),
  includeHistory: z.boolean().optional().default(false),
  historyLimit: z.number().min(1).max(100).optional().default(10),
});

const PauseScheduleSchema = z.object({
  scheduleId: z.string().describe('Schedule ID to pause'),
});

const ResumeScheduleSchema = z.object({
  scheduleId: z.string().describe('Schedule ID to resume'),
});

const CreatePipelineSchema = z.object({
  steps: z
    .array(
      z.object({
        prompt: z.string().min(1).max(4000).describe('Task prompt for this step'),
        priority: z.enum(['P0', 'P1', 'P2']).optional().describe('Priority override for this step'),
        workingDirectory: z.string().optional().describe('Working directory override (absolute path)'),
      }),
    )
    .min(2, 'Pipeline requires at least 2 steps')
    .max(20, 'Pipeline cannot exceed 20 steps')
    .describe('Ordered pipeline steps (executed sequentially)'),
  priority: z
    .enum(['P0', 'P1', 'P2'])
    .optional()
    .describe('Default priority for all steps (individual steps can override)'),
  workingDirectory: z
    .string()
    .optional()
    .describe('Default working directory for all steps (individual steps can override)'),
});

/** Standard MCP tool response shape */
interface MCPToolResponse {
  [key: string]: unknown;
  content: { type: string; text: string }[];
  isError?: boolean;
}

export class MCPAdapter {
  private server: Server;

  constructor(
    private readonly taskManager: TaskManager,
    private readonly logger: Logger,
    private readonly scheduleService: ScheduleService,
  ) {
    this.server = new Server(
      {
        name: 'backbeat',
        version: pkg.version,
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    this.setupHandlers();
  }

  /**
   * Get the MCP server instance for starting
   */
  getServer(): Server {
    return this.server;
  }

  private setupHandlers(): void {
    // Handle tool calls
    this.server.setRequestHandler(
      z.object({
        method: z.literal('tools/call'),
        params: z.object({
          name: z.string(),
          arguments: z.any(),
        }),
      }),
      async (request) => {
        const { name, arguments: args } = request.params;

        // SECURITY: DoS protection handled at resource level:
        // - Queue size limit (RESOURCE_EXHAUSTED error when queue full)
        // - Resource monitoring (workers only spawn when system has capacity)
        // - Spawn throttling (prevents fork bombs)
        this.logger.debug('MCP tool call received', { tool: name });

        switch (name) {
          case 'DelegateTask':
            return await this.handleDelegateTask(args);
          case 'TaskStatus':
            return await this.handleTaskStatus(args);
          case 'TaskLogs':
            return await this.handleTaskLogs(args);
          case 'CancelTask':
            return await this.handleCancelTask(args);
          case 'RetryTask':
            return await this.handleRetryTask(args);
          case 'ResumeTask':
            return await this.handleResumeTask(args);
          // Schedule tools (v0.4.0 Task Scheduling)
          case 'ScheduleTask':
            return await this.handleScheduleTask(args);
          case 'ListSchedules':
            return await this.handleListSchedules(args);
          case 'GetSchedule':
            return await this.handleGetSchedule(args);
          case 'CancelSchedule':
            return await this.handleCancelSchedule(args);
          case 'PauseSchedule':
            return await this.handlePauseSchedule(args);
          case 'ResumeSchedule':
            return await this.handleResumeSchedule(args);
          case 'CreatePipeline':
            return await this.handleCreatePipeline(args);
          default:
            // ARCHITECTURE: Return error response instead of throwing
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(
                    {
                      error: `Unknown tool: ${name}`,
                      code: 'INVALID_TOOL',
                    },
                    null,
                    2,
                  ),
                },
              ],
              isError: true,
            };
        }
      },
    );

    // List available tools
    this.server.setRequestHandler(
      z.object({
        method: z.literal('tools/list'),
      }),
      async () => {
        return {
          tools: [
            {
              name: 'DelegateTask',
              description: 'Delegate a task to a background Claude Code instance',
              inputSchema: {
                type: 'object',
                properties: {
                  prompt: {
                    type: 'string',
                    description: 'The task for Claude Code to execute',
                    minLength: 1,
                    maxLength: 4000,
                  },
                  priority: {
                    type: 'string',
                    enum: ['P0', 'P1', 'P2'],
                    description: 'Task priority (P0=critical, P1=high, P2=normal)',
                    default: 'P2',
                  },
                  workingDirectory: {
                    type: 'string',
                    description: 'Optional working directory for task execution (absolute path)',
                  },
                  timeout: {
                    type: 'number',
                    description: 'Task timeout in milliseconds (overrides global default)',
                    minimum: 1000,
                    maximum: 86400000, // 24 hours
                  },
                  maxOutputBuffer: {
                    type: 'number',
                    description: 'Maximum output buffer size in bytes (overrides global default)',
                    minimum: 1024,
                    maximum: 1073741824, // 1GB
                  },
                  dependsOn: {
                    type: 'array',
                    description: 'Array of task IDs this task depends on (must complete before this task can run)',
                    items: {
                      type: 'string',
                      pattern: '^task-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
                    },
                  },
                  continueFrom: {
                    type: 'string',
                    description:
                      'Task ID to continue from — receives checkpoint context when that dependency completes (must be in dependsOn list)',
                    pattern: '^task-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
                  },
                },
                required: ['prompt'],
              },
            },
            {
              name: 'TaskStatus',
              description: 'Get status of delegated tasks',
              inputSchema: {
                type: 'object',
                properties: {
                  taskId: {
                    type: 'string',
                    description: 'Task ID to check (omit for all tasks)',
                    pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
                  },
                },
              },
            },
            {
              name: 'TaskLogs',
              description: 'Retrieve execution logs from a delegated task',
              inputSchema: {
                type: 'object',
                properties: {
                  taskId: {
                    type: 'string',
                    description: 'Task ID to get logs for',
                    pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
                  },
                  tail: {
                    type: 'number',
                    description: 'Number of recent lines to return',
                    default: 100,
                    minimum: 1,
                    maximum: 1000,
                  },
                },
                required: ['taskId'],
              },
            },
            {
              name: 'CancelTask',
              description: 'Cancel a running delegated task',
              inputSchema: {
                type: 'object',
                properties: {
                  taskId: {
                    type: 'string',
                    description: 'Task ID to cancel',
                    pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
                  },
                  reason: {
                    type: 'string',
                    description: 'Optional reason for cancellation',
                    maxLength: 200,
                  },
                },
                required: ['taskId'],
              },
            },
            {
              name: 'RetryTask',
              description: 'Retry a failed or completed task',
              inputSchema: {
                type: 'object',
                properties: {
                  taskId: {
                    type: 'string',
                    description: 'Task ID to retry',
                    pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
                  },
                },
                required: ['taskId'],
              },
            },
            {
              name: 'ResumeTask',
              description:
                'Resume a failed/completed task with enriched context from its checkpoint (smart retry with previous output, errors, and git state)',
              inputSchema: {
                type: 'object',
                properties: {
                  taskId: {
                    type: 'string',
                    description: 'Task ID to resume (must be in terminal state: completed, failed, or cancelled)',
                    pattern: '^task-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
                  },
                  additionalContext: {
                    type: 'string',
                    description: 'Additional instructions or context for the resumed task',
                    maxLength: 4000,
                  },
                },
                required: ['taskId'],
              },
            },
            // Schedule tools (v0.4.0 Task Scheduling)
            {
              name: 'ScheduleTask',
              description:
                'Schedule a task for future or recurring execution using cron expressions or one-time timestamps',
              inputSchema: {
                type: 'object',
                properties: {
                  prompt: {
                    type: 'string',
                    description: 'Task prompt to execute',
                  },
                  scheduleType: {
                    type: 'string',
                    enum: ['cron', 'one_time'],
                    description: 'cron for recurring, one_time for single execution',
                  },
                  cronExpression: {
                    type: 'string',
                    description: 'Cron expression (5-field: minute hour day month weekday)',
                  },
                  scheduledAt: {
                    type: 'string',
                    description: 'ISO 8601 datetime for one-time schedules',
                  },
                  timezone: {
                    type: 'string',
                    description: 'IANA timezone (default: UTC)',
                  },
                  missedRunPolicy: {
                    type: 'string',
                    enum: ['skip', 'catchup', 'fail'],
                    description: 'How to handle missed runs',
                  },
                  priority: {
                    type: 'string',
                    enum: ['P0', 'P1', 'P2'],
                  },
                  workingDirectory: {
                    type: 'string',
                  },
                  maxRuns: {
                    type: 'number',
                    description: 'Maximum runs for cron schedules',
                  },
                  expiresAt: {
                    type: 'string',
                    description: 'ISO 8601 expiration datetime',
                  },
                  afterSchedule: {
                    type: 'string',
                    description: "Schedule ID to chain after (new tasks depend on this schedule's latest task)",
                  },
                },
                required: ['prompt', 'scheduleType'],
              },
            },
            {
              name: 'ListSchedules',
              description: 'List all schedules with optional status filter',
              inputSchema: {
                type: 'object',
                properties: {
                  status: {
                    type: 'string',
                    enum: ['active', 'paused', 'completed', 'cancelled', 'expired'],
                  },
                  limit: {
                    type: 'number',
                    description: 'Max results (default 50)',
                  },
                  offset: {
                    type: 'number',
                    description: 'Pagination offset',
                  },
                },
              },
            },
            {
              name: 'GetSchedule',
              description: 'Get details of a specific schedule including execution history',
              inputSchema: {
                type: 'object',
                properties: {
                  scheduleId: {
                    type: 'string',
                    description: 'Schedule ID',
                  },
                  includeHistory: {
                    type: 'boolean',
                    description: 'Include execution history',
                  },
                  historyLimit: {
                    type: 'number',
                    description: 'Max history entries',
                  },
                },
                required: ['scheduleId'],
              },
            },
            {
              name: 'CancelSchedule',
              description: 'Cancel an active schedule',
              inputSchema: {
                type: 'object',
                properties: {
                  scheduleId: {
                    type: 'string',
                  },
                  reason: {
                    type: 'string',
                  },
                },
                required: ['scheduleId'],
              },
            },
            {
              name: 'PauseSchedule',
              description: 'Pause a schedule (can be resumed later)',
              inputSchema: {
                type: 'object',
                properties: {
                  scheduleId: {
                    type: 'string',
                  },
                },
                required: ['scheduleId'],
              },
            },
            {
              name: 'ResumeSchedule',
              description: 'Resume a paused schedule',
              inputSchema: {
                type: 'object',
                properties: {
                  scheduleId: {
                    type: 'string',
                  },
                },
                required: ['scheduleId'],
              },
            },
            {
              name: 'CreatePipeline',
              description:
                'Create a sequential pipeline of tasks that execute one after another. Each step runs only after the previous step completes successfully.',
              inputSchema: {
                type: 'object',
                properties: {
                  steps: {
                    type: 'array',
                    description: 'Ordered pipeline steps (executed sequentially)',
                    items: {
                      type: 'object',
                      properties: {
                        prompt: {
                          type: 'string',
                          description: 'Task prompt for this step',
                          minLength: 1,
                          maxLength: 4000,
                        },
                        priority: {
                          type: 'string',
                          enum: ['P0', 'P1', 'P2'],
                          description: 'Priority override for this step',
                        },
                        workingDirectory: {
                          type: 'string',
                          description: 'Working directory override (absolute path)',
                        },
                      },
                      required: ['prompt'],
                    },
                    minItems: 2,
                    maxItems: 20,
                  },
                  priority: {
                    type: 'string',
                    enum: ['P0', 'P1', 'P2'],
                    description: 'Default priority for all steps (individual steps can override)',
                  },
                  workingDirectory: {
                    type: 'string',
                    description: 'Default working directory for all steps (individual steps can override)',
                  },
                },
                required: ['steps'],
              },
            },
          ],
        };
      },
    );
  }

  private async handleDelegateTask(args: unknown): Promise<MCPToolResponse> {
    // Validate input at boundary
    const parseResult = DelegateTaskSchema.safeParse(args);

    if (!parseResult.success) {
      return {
        content: [
          {
            type: 'text',
            text: `Validation error: ${parseResult.error.message}`,
          },
        ],
        isError: true,
      };
    }

    const data = parseResult.data;

    // SECURITY: Validate workingDirectory to prevent path traversal attacks
    let validatedWorkingDirectory: string | undefined;
    if (data.workingDirectory) {
      const pathValidation = validatePath(data.workingDirectory);
      if (!pathValidation.ok) {
        return {
          content: [
            {
              type: 'text',
              text: `Invalid working directory: ${pathValidation.error.message}`,
            },
          ],
          isError: true,
        };
      }
      validatedWorkingDirectory = pathValidation.value;
    }

    // Create request with validated paths
    const request: TaskRequest = {
      prompt: data.prompt,
      priority: data.priority as Priority,
      workingDirectory: validatedWorkingDirectory,
      timeout: data.timeout,
      maxOutputBuffer: data.maxOutputBuffer,
      dependsOn: data.dependsOn ? data.dependsOn.map(TaskId) : undefined,
      continueFrom: data.continueFrom ? TaskId(data.continueFrom) : undefined,
    };

    // Delegate task using our new architecture
    const result = await this.taskManager.delegate(request);

    // Convert Result to MCP response
    return match(result, {
      ok: (task) => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              taskId: task.id,
              message: 'Task delegated successfully',
            }),
          },
        ],
      }),
      err: (error) => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: error.message,
            }),
          },
        ],
        isError: true,
      }),
    });
  }

  private async handleTaskStatus(args: unknown): Promise<MCPToolResponse> {
    const parseResult = TaskStatusSchema.safeParse(args);

    if (!parseResult.success) {
      return {
        content: [
          {
            type: 'text',
            text: `Validation error: ${parseResult.error.message}`,
          },
        ],
        isError: true,
      };
    }

    const { taskId } = parseResult.data;

    const result = await this.taskManager.getStatus(taskId ? TaskId(taskId) : undefined);

    return match(result, {
      ok: (data) => {
        if (Array.isArray(data)) {
          // Multiple tasks
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  tasks: data,
                }),
              },
            ],
          };
        } else {
          // Single task - TypeScript needs help with type narrowing
          const task = data as Exclude<typeof data, readonly Task[]>;
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  taskId: task.id,
                  status: task.status,
                  prompt: task.prompt.substring(0, 100) + '...',
                  startTime: task.startedAt,
                  endTime: task.completedAt,
                  duration: task.completedAt && task.startedAt ? task.completedAt - task.startedAt : undefined,
                  exitCode: task.exitCode,
                  workingDirectory: task.workingDirectory,
                }),
              },
            ],
          };
        }
      },
      err: (error) => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: error.message,
            }),
          },
        ],
        isError: true,
      }),
    });
  }

  private async handleTaskLogs(args: unknown): Promise<MCPToolResponse> {
    const parseResult = TaskLogsSchema.safeParse(args);

    if (!parseResult.success) {
      return {
        content: [
          {
            type: 'text',
            text: `Validation error: ${parseResult.error.message}`,
          },
        ],
        isError: true,
      };
    }

    const { taskId, tail } = parseResult.data;

    const result = await this.taskManager.getLogs(TaskId(taskId), tail);

    return match(result, {
      ok: (output) => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              taskId: output.taskId,
              output: output.stdout.join(''),
              errors: output.stderr.join(''),
              lineCount: {
                output: output.stdout.length,
                errors: output.stderr.length,
              },
            }),
          },
        ],
      }),
      err: (error) => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: error.message,
            }),
          },
        ],
        isError: true,
      }),
    });
  }

  private async handleCancelTask(args: unknown): Promise<MCPToolResponse> {
    const parseResult = CancelTaskSchema.safeParse(args);

    if (!parseResult.success) {
      return {
        content: [
          {
            type: 'text',
            text: `Validation error: ${parseResult.error.message}`,
          },
        ],
        isError: true,
      };
    }

    const { taskId, reason } = parseResult.data;

    const result = await this.taskManager.cancel(TaskId(taskId), reason);

    return match(result, {
      ok: () => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: `Task ${taskId} cancelled`,
            }),
          },
        ],
      }),
      err: (error) => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: error.message,
            }),
          },
        ],
        isError: true,
      }),
    });
  }

  private async handleRetryTask(args: unknown): Promise<MCPToolResponse> {
    const parseResult = RetryTaskSchema.safeParse(args);

    if (!parseResult.success) {
      return {
        content: [
          {
            type: 'text',
            text: `Validation error: ${parseResult.error.message}`,
          },
        ],
        isError: true,
      };
    }

    const { taskId } = parseResult.data;

    const result = await this.taskManager.retry(TaskId(taskId));

    return match(result, {
      ok: (newTask) => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: `Task ${taskId} retried successfully`,
              newTaskId: newTask.id,
              retryCount: newTask.retryCount || 1,
              parentTaskId: newTask.parentTaskId,
            }),
          },
        ],
      }),
      err: (error) => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: error.message,
            }),
          },
        ],
        isError: true,
      }),
    });
  }

  private async handleResumeTask(args: unknown): Promise<MCPToolResponse> {
    const parseResult = ResumeTaskSchema.safeParse(args);

    if (!parseResult.success) {
      return {
        content: [{ type: 'text', text: `Validation error: ${parseResult.error.message}` }],
        isError: true,
      };
    }

    const { taskId, additionalContext } = parseResult.data;

    const request: ResumeTaskRequest = {
      taskId: TaskId(taskId),
      additionalContext,
    };

    const result = await this.taskManager.resume(request);

    return match(result, {
      ok: (newTask) => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                message: `Task ${taskId} resumed successfully`,
                newTaskId: newTask.id,
                retryCount: newTask.retryCount || 1,
                parentTaskId: newTask.parentTaskId,
              },
              null,
              2,
            ),
          },
        ],
      }),
      err: (error) => ({
        content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }, null, 2) }],
        isError: true,
      }),
    });
  }

  // ============================================================================
  // SCHEDULE HANDLERS (v0.4.0 Task Scheduling)
  // Thin wrappers: Zod parse -> service call -> format MCP response
  // ============================================================================

  /**
   * Handle ScheduleTask tool call
   * Creates a new schedule for recurring or one-time task execution
   */
  private async handleScheduleTask(args: unknown): Promise<MCPToolResponse> {
    const parseResult = ScheduleTaskSchema.safeParse(args);
    if (!parseResult.success) {
      return {
        content: [{ type: 'text', text: `Validation error: ${parseResult.error.message}` }],
        isError: true,
      };
    }
    const data = parseResult.data;

    const request: ScheduleCreateRequest = {
      prompt: data.prompt,
      scheduleType: data.scheduleType === 'cron' ? ScheduleType.CRON : ScheduleType.ONE_TIME,
      cronExpression: data.cronExpression,
      scheduledAt: data.scheduledAt,
      timezone: data.timezone,
      missedRunPolicy: toMissedRunPolicy(data.missedRunPolicy),
      priority: data.priority as Priority | undefined,
      workingDirectory: data.workingDirectory,
      maxRuns: data.maxRuns,
      expiresAt: data.expiresAt,
      afterScheduleId: data.afterSchedule ? ScheduleId(data.afterSchedule) : undefined,
    };

    const result = await this.scheduleService.createSchedule(request);

    return match(result, {
      ok: (schedule) => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                scheduleId: schedule.id,
                scheduleType: schedule.scheduleType,
                nextRunAt: schedule.nextRunAt ? new Date(schedule.nextRunAt).toISOString() : null,
                timezone: schedule.timezone,
                status: schedule.status,
              },
              null,
              2,
            ),
          },
        ],
      }),
      err: (error) => ({
        content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }, null, 2) }],
        isError: true,
      }),
    });
  }

  /**
   * Handle ListSchedules tool call
   * Lists schedules with optional status filter and pagination
   */
  private async handleListSchedules(args: unknown): Promise<MCPToolResponse> {
    const parseResult = ListSchedulesSchema.safeParse(args);
    if (!parseResult.success) {
      return {
        content: [{ type: 'text', text: `Validation error: ${parseResult.error.message}` }],
        isError: true,
      };
    }

    const { status, limit, offset } = parseResult.data;

    const result = await this.scheduleService.listSchedules(status as ScheduleStatus | undefined, limit, offset);

    return match(result, {
      ok: (schedules) => {
        const simplifiedSchedules = schedules.map((s) => ({
          id: s.id,
          status: s.status,
          scheduleType: s.scheduleType,
          cronExpression: s.cronExpression,
          nextRunAt: s.nextRunAt ? new Date(s.nextRunAt).toISOString() : null,
          runCount: s.runCount,
          maxRuns: s.maxRuns,
        }));

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  schedules: simplifiedSchedules,
                  count: simplifiedSchedules.length,
                },
                null,
                2,
              ),
            },
          ],
        };
      },
      err: (error) => ({
        content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }, null, 2) }],
        isError: true,
      }),
    });
  }

  /**
   * Handle GetSchedule tool call
   * Gets details of a specific schedule with optional execution history
   */
  private async handleGetSchedule(args: unknown): Promise<MCPToolResponse> {
    const parseResult = GetScheduleSchema.safeParse(args);
    if (!parseResult.success) {
      return {
        content: [{ type: 'text', text: `Validation error: ${parseResult.error.message}` }],
        isError: true,
      };
    }

    const { scheduleId, includeHistory, historyLimit } = parseResult.data;

    const result = await this.scheduleService.getSchedule(ScheduleId(scheduleId), includeHistory, historyLimit);

    return match(result, {
      ok: ({ schedule, history }) => {
        const response: Record<string, unknown> = {
          success: true,
          schedule: {
            id: schedule.id,
            status: schedule.status,
            scheduleType: schedule.scheduleType,
            cronExpression: schedule.cronExpression,
            scheduledAt: schedule.scheduledAt ? new Date(schedule.scheduledAt).toISOString() : null,
            timezone: schedule.timezone,
            missedRunPolicy: schedule.missedRunPolicy,
            maxRuns: schedule.maxRuns,
            runCount: schedule.runCount,
            lastRunAt: schedule.lastRunAt ? new Date(schedule.lastRunAt).toISOString() : null,
            nextRunAt: schedule.nextRunAt ? new Date(schedule.nextRunAt).toISOString() : null,
            expiresAt: schedule.expiresAt ? new Date(schedule.expiresAt).toISOString() : null,
            createdAt: new Date(schedule.createdAt).toISOString(),
            updatedAt: new Date(schedule.updatedAt).toISOString(),
            taskTemplate: {
              prompt:
                schedule.taskTemplate.prompt.substring(0, 100) +
                (schedule.taskTemplate.prompt.length > 100 ? '...' : ''),
              priority: schedule.taskTemplate.priority,
              workingDirectory: schedule.taskTemplate.workingDirectory,
            },
          },
        };

        if (history) {
          response.history = history.map((h) => ({
            scheduledFor: new Date(h.scheduledFor).toISOString(),
            executedAt: h.executedAt ? new Date(h.executedAt).toISOString() : null,
            status: h.status,
            taskId: h.taskId,
            errorMessage: h.errorMessage,
          }));
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      },
      err: (error) => ({
        content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }, null, 2) }],
        isError: true,
      }),
    });
  }

  /**
   * Handle CancelSchedule tool call
   * Cancels an active schedule
   */
  private async handleCancelSchedule(args: unknown): Promise<MCPToolResponse> {
    const parseResult = CancelScheduleSchema.safeParse(args);
    if (!parseResult.success) {
      return {
        content: [{ type: 'text', text: `Validation error: ${parseResult.error.message}` }],
        isError: true,
      };
    }

    const { scheduleId, reason } = parseResult.data;

    const result = await this.scheduleService.cancelSchedule(ScheduleId(scheduleId), reason);

    return match(result, {
      ok: () => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                message: `Schedule ${scheduleId} cancelled`,
                reason,
              },
              null,
              2,
            ),
          },
        ],
      }),
      err: (error) => ({
        content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }, null, 2) }],
        isError: true,
      }),
    });
  }

  /**
   * Handle PauseSchedule tool call
   * Pauses an active schedule (can be resumed later)
   */
  private async handlePauseSchedule(args: unknown): Promise<MCPToolResponse> {
    const parseResult = PauseScheduleSchema.safeParse(args);
    if (!parseResult.success) {
      return {
        content: [{ type: 'text', text: `Validation error: ${parseResult.error.message}` }],
        isError: true,
      };
    }

    const { scheduleId } = parseResult.data;

    const result = await this.scheduleService.pauseSchedule(ScheduleId(scheduleId));

    return match(result, {
      ok: () => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                message: `Schedule ${scheduleId} paused`,
              },
              null,
              2,
            ),
          },
        ],
      }),
      err: (error) => ({
        content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }, null, 2) }],
        isError: true,
      }),
    });
  }

  /**
   * Handle ResumeSchedule tool call
   * Resumes a paused schedule
   */
  private async handleResumeSchedule(args: unknown): Promise<MCPToolResponse> {
    const parseResult = ResumeScheduleSchema.safeParse(args);
    if (!parseResult.success) {
      return {
        content: [{ type: 'text', text: `Validation error: ${parseResult.error.message}` }],
        isError: true,
      };
    }

    const { scheduleId } = parseResult.data;

    const result = await this.scheduleService.resumeSchedule(ScheduleId(scheduleId));

    return match(result, {
      ok: () => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                message: `Schedule ${scheduleId} resumed`,
              },
              null,
              2,
            ),
          },
        ],
      }),
      err: (error) => ({
        content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }, null, 2) }],
        isError: true,
      }),
    });
  }

  /**
   * Handle CreatePipeline tool call
   * Creates a sequential pipeline of chained one-time schedules
   */
  private async handleCreatePipeline(args: unknown): Promise<MCPToolResponse> {
    const parseResult = CreatePipelineSchema.safeParse(args);
    if (!parseResult.success) {
      return {
        content: [{ type: 'text', text: `Validation error: ${parseResult.error.message}` }],
        isError: true,
      };
    }

    const data = parseResult.data;

    // Validate shared workingDirectory
    if (data.workingDirectory) {
      const pathValidation = validatePath(data.workingDirectory);
      if (!pathValidation.ok) {
        return {
          content: [{ type: 'text', text: `Invalid shared working directory: ${pathValidation.error.message}` }],
          isError: true,
        };
      }
    }

    // Validate per-step workingDirectory paths
    for (let i = 0; i < data.steps.length; i++) {
      const step = data.steps[i];
      if (step.workingDirectory) {
        const pathValidation = validatePath(step.workingDirectory);
        if (!pathValidation.ok) {
          return {
            content: [
              {
                type: 'text',
                text: `Invalid working directory for step ${i + 1}: ${pathValidation.error.message}`,
              },
            ],
            isError: true,
          };
        }
      }
    }

    const request: PipelineCreateRequest = {
      steps: data.steps.map((s) => ({
        prompt: s.prompt,
        priority: s.priority as Priority | undefined,
        workingDirectory: s.workingDirectory,
      })),
      priority: data.priority as Priority | undefined,
      workingDirectory: data.workingDirectory,
    };

    const result = await this.scheduleService.createPipeline(request);

    return match(result, {
      ok: (pipeline) => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                pipelineId: pipeline.pipelineId,
                stepCount: pipeline.steps.length,
                steps: pipeline.steps.map((s) => ({
                  index: s.index,
                  scheduleId: s.scheduleId,
                  prompt: s.prompt,
                })),
              },
              null,
              2,
            ),
          },
        ],
      }),
      err: (error) => ({
        content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }, null, 2) }],
        isError: true,
      }),
    });
  }
}
