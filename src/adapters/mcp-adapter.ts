/**
 * MCP Protocol Adapter
 * Bridges the MCP protocol with our new architecture
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';
import pkg from '../../package.json' with { type: 'json' };
import {
  AGENT_DESCRIPTIONS,
  AGENT_PROVIDERS,
  AGENT_PROVIDERS_TUPLE,
  AgentProvider,
  AgentRegistry,
  checkAgentAuth,
  maskApiKey,
} from '../core/agents.js';
import { type Configuration, loadAgentConfig, resetAgentConfig, saveAgentConfig } from '../core/configuration.js';
import {
  EvalMode,
  LoopCreateRequest,
  LoopId,
  LoopStatus,
  LoopStrategy,
  OrchestratorId,
  OrchestratorStatus,
  PipelineCreateRequest,
  Priority,
  ResumeTaskRequest,
  ScheduleCreateRequest,
  ScheduledLoopCreateRequest,
  ScheduledPipelineCreateRequest,
  ScheduleId,
  ScheduleStatus,
  ScheduleType,
  Task,
  TaskId,
  TaskRequest,
} from '../core/domain.js';
import { Logger, LoopService, OrchestrationService, ScheduleService, TaskManager } from '../core/interfaces.js';
import { match } from '../core/result.js';
import { toMissedRunPolicy, toOptimizeDirection, truncatePrompt } from '../utils/format.js';
import { validatePath } from '../utils/validation.js';
import { MCP_INSTRUCTIONS } from './mcp-instructions.js';

// Zod schemas for MCP protocol validation
// Exported for unit-testing schema validation independently of the MCP protocol layer
export const DelegateTaskSchema = z.object({
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
  agent: z
    .enum(AGENT_PROVIDERS_TUPLE)
    .optional()
    .describe('AI agent to execute the task (uses configured default if omitted)'),
  model: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Model override for this task (overrides agent-config default)'),
  /**
   * v1.3.0: Orchestration attribution metadata.
   * IMPORTANT (Risk #8): This is intentionally per-request metadata, NOT an env var.
   * The MCP server is long-lived and shared across orchestrators; reading an env var
   * here would mix attribution across concurrent orchestrations.
   *
   * DESIGN NOTE: metadata is a nested object (not a flat field) to namespace future
   * per-request metadata without polluting the top-level schema. The orchestratorId
   * field is the first use of this namespace.
   *
   * SECURITY: orchestratorId is constrained to the canonical format produced by
   * crypto.randomUUID() in domain.ts createOrchestration():
   *   "orchestrator-" (13 chars) + UUID (36 chars) = 49 chars total
   * Bounds enforce printable ASCII only, preventing log injection via control chars.
   */
  metadata: z
    .object({
      orchestratorId: z
        .string()
        .regex(/^orchestrator-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
        .min(49)
        .max(49)
        .optional(),
    })
    .optional()
    .describe('Optional per-request metadata for orchestration attribution'),
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
  agent: z
    .enum(AGENT_PROVIDERS_TUPLE)
    .optional()
    .describe('AI agent to execute the task (uses configured default if omitted)'),
  model: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Model override for this task (overrides agent-config default)'),
});

const ListSchedulesSchema = z.object({
  status: z.enum(['active', 'paused', 'completed', 'cancelled', 'expired']).optional(),
  limit: z.number().min(1).max(100).optional().default(50),
  offset: z.number().min(0).optional().default(0),
});

const CancelScheduleSchema = z.object({
  scheduleId: z.string().describe('Schedule ID to cancel'),
  reason: z.string().optional().describe('Reason for cancellation'),
  cancelTasks: z
    .boolean()
    .optional()
    .default(false)
    .describe('Also cancel in-flight pipeline tasks from the current execution'),
});

const ScheduleStatusSchema = z.object({
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
        agent: z.enum(AGENT_PROVIDERS_TUPLE).optional().describe('Agent override for this step'),
        model: z.string().min(1).max(200).optional().describe('Model override for this step'),
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
  agent: z
    .enum(AGENT_PROVIDERS_TUPLE)
    .optional()
    .describe('Default agent for all steps (individual steps can override)'),
  model: z.string().min(1).max(200).optional().describe('Default model for all steps (individual steps can override)'),
});

const SchedulePipelineSchema = z.object({
  steps: z
    .array(
      z.object({
        prompt: z.string().min(1).max(4000).describe('Task prompt for this step'),
        priority: z.enum(['P0', 'P1', 'P2']).optional().describe('Priority override for this step'),
        workingDirectory: z.string().optional().describe('Working directory override (absolute path)'),
        agent: z.enum(AGENT_PROVIDERS_TUPLE).optional().describe('Agent override for this step'),
        model: z.string().min(1).max(200).optional().describe('Model override for this step'),
      }),
    )
    .min(2, 'Pipeline requires at least 2 steps')
    .max(20, 'Pipeline cannot exceed 20 steps')
    .describe('Ordered pipeline steps (executed sequentially on each trigger)'),
  scheduleType: z.enum(['cron', 'one_time']).describe('Schedule type'),
  cronExpression: z.string().optional().describe('Cron expression (5-field) for recurring pipelines'),
  scheduledAt: z.string().optional().describe('ISO 8601 datetime for one-time pipelines'),
  timezone: z.string().optional().default('UTC').describe('IANA timezone'),
  missedRunPolicy: z.enum(['skip', 'catchup', 'fail']).optional().default('skip'),
  priority: z.enum(['P0', 'P1', 'P2']).optional().describe('Default priority for all steps'),
  workingDirectory: z.string().optional().describe('Default working directory for all steps'),
  maxRuns: z.number().min(1).optional().describe('Maximum number of pipeline runs for cron schedules'),
  expiresAt: z.string().optional().describe('ISO 8601 datetime when schedule expires'),
  afterSchedule: z
    .string()
    .optional()
    .describe("Schedule ID to chain after (step 0 depends on this schedule's latest task)"),
  agent: z
    .enum(AGENT_PROVIDERS_TUPLE)
    .optional()
    .describe('Default agent for all steps (individual steps can override)'),
  model: z.string().min(1).max(200).optional().describe('Default model for all steps (individual steps can override)'),
});

// Orchestrator-related Zod schemas (v0.9.0 Orchestrator Mode)
const CreateOrchestratorSchema = z.object({
  goal: z.string().min(1).max(8000).describe('High-level goal for the orchestrator to achieve'),
  workingDirectory: z.string().optional().describe('Working directory for workers (absolute path)'),
  agent: z.enum(AGENT_PROVIDERS_TUPLE).optional().describe('AI agent for the orchestrator loop'),
  model: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Model override for the orchestrator (overrides agent-config default)'),
  maxDepth: z.number().min(1).max(10).optional().default(3).describe('Max delegation depth'),
  maxWorkers: z.number().min(1).max(20).optional().default(5).describe('Max concurrent workers'),
  maxIterations: z.number().min(1).max(200).optional().default(50).describe('Max orchestrator iterations'),
});

const OrchestratorStatusSchema = z.object({
  orchestratorId: z.string().describe('Orchestrator ID'),
});

const ListOrchestratorsSchema = z.object({
  status: z.nativeEnum(OrchestratorStatus).optional(),
  limit: z.number().min(1).max(100).optional().default(50),
  offset: z.number().min(0).optional().default(0),
});

const CancelOrchestratorSchema = z.object({
  orchestratorId: z.string().describe('Orchestrator ID to cancel'),
  reason: z.string().optional().describe('Reason for cancellation'),
});

const ConfigureAgentSchema = z.object({
  agent: z.enum(AGENT_PROVIDERS_TUPLE).describe('Agent provider to configure'),
  action: z
    .enum(['set', 'check', 'reset'])
    .default('check')
    .describe('Action: set config values, check auth status, or reset all stored config'),
  apiKey: z.string().min(1).optional().describe('API key to store (set action)'),
  baseUrl: z.string().url().optional().describe('Base URL override (set action, e.g. https://proxy.example.com/v1)'),
  model: z.string().min(1).max(200).optional().describe('Default model override for this agent (set action)'),
});

// Loop-related Zod schemas (v0.7.0 Task/Pipeline Loops)
const CreateLoopSchema = z.object({
  prompt: z.string().min(1).max(4000).optional().describe('Task prompt for each iteration'),
  strategy: z.enum(['retry', 'optimize']).describe('Loop strategy'),
  exitCondition: z
    .string()
    .min(1)
    .max(4000)
    .optional()
    .describe('Shell command to evaluate after each iteration (required for shell eval mode)'),
  evalMode: z
    .nativeEnum(EvalMode)
    .optional()
    .default(EvalMode.SHELL)
    .describe('Evaluation mode: shell command or agent review'),
  evalPrompt: z
    .string()
    .min(1)
    .max(8000)
    .optional()
    .describe('Custom prompt for agent evaluator (agent eval mode only)'),
  evalDirection: z.enum(['minimize', 'maximize']).optional().describe('Score direction for optimize strategy'),
  evalTimeout: z
    .number()
    .min(1000)
    .max(600000)
    .optional()
    .default(60000)
    .describe('Eval timeout in ms (max: shell=300s, agent=600s)'),
  workingDirectory: z.string().optional().describe('Working directory for task and eval'),
  maxIterations: z.number().min(0).optional().default(10).describe('Max iterations (0 = unlimited)'),
  maxConsecutiveFailures: z.number().min(0).optional().default(3).describe('Max consecutive failures before stopping'),
  cooldownMs: z.number().min(0).optional().default(0).describe('Cooldown between iterations in ms'),
  freshContext: z
    .boolean()
    .optional()
    .default(true)
    .describe('Start each iteration fresh (true) or continue from checkpoint'),
  pipelineSteps: z
    .array(z.string().min(1))
    .min(2)
    .max(20)
    .optional()
    .describe('Pipeline step prompts (creates pipeline loop)'),
  priority: z.enum(['P0', 'P1', 'P2']).optional().describe('Task priority'),
  agent: z.enum(AGENT_PROVIDERS_TUPLE).optional().describe('Agent provider'),
  model: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Model override for each iteration task (overrides agent-config default)'),
  gitBranch: z.string().optional().describe('Git branch name for loop iteration work'),
});

const LoopStatusSchema = z.object({
  loopId: z.string().min(1).describe('Loop ID'),
  includeHistory: z.boolean().optional().default(false).describe('Include iteration history'),
  historyLimit: z.number().min(1).optional().default(20).describe('Max iterations to return'),
});

const ListLoopsSchema = z.object({
  status: z.enum(['running', 'paused', 'completed', 'failed', 'cancelled']).optional().describe('Filter by status'),
  limit: z.number().min(1).max(100).optional().default(20).describe('Results limit'),
});

// Loop pause/resume schemas (v0.8.0)
const PauseLoopSchema = z.object({
  loopId: z.string().min(1).describe('Loop ID to pause'),
  force: z
    .boolean()
    .optional()
    .default(false)
    .describe('Force pause — cancel current iteration immediately (default: false, waits for iteration to finish)'),
});

const ResumeLoopSchema = z.object({
  loopId: z.string().min(1).describe('Loop ID to resume'),
});

// Scheduled loop schema (v0.8.0)
const ScheduleLoopSchema = z.object({
  // Loop config fields
  prompt: z.string().min(1).max(4000).optional().describe('Task prompt for each iteration'),
  strategy: z.enum(['retry', 'optimize']).describe('Loop strategy'),
  exitCondition: z
    .string()
    .min(1)
    .max(4000)
    .optional()
    .describe('Shell command to evaluate after each iteration (required for shell eval mode)'),
  evalMode: z
    .nativeEnum(EvalMode)
    .optional()
    .default(EvalMode.SHELL)
    .describe('Evaluation mode: shell command or agent review'),
  evalPrompt: z
    .string()
    .min(1)
    .max(8000)
    .optional()
    .describe('Custom prompt for agent evaluator (agent eval mode only)'),
  evalDirection: z.enum(['minimize', 'maximize']).optional().describe('Score direction for optimize strategy'),
  evalTimeout: z.number().min(1000).max(600000).optional().describe('Eval timeout in ms (max: shell=300s, agent=600s)'),
  workingDirectory: z.string().optional().describe('Working directory for task and eval'),
  maxIterations: z.number().min(0).optional().describe('Max iterations (0 = unlimited)'),
  maxConsecutiveFailures: z.number().min(0).optional().describe('Max consecutive failures'),
  cooldownMs: z.number().min(0).optional().describe('Cooldown between iterations in ms'),
  freshContext: z.boolean().optional().describe('Start each iteration fresh (default: true)'),
  pipelineSteps: z.array(z.string().min(1)).min(2).max(20).optional().describe('Pipeline step prompts'),
  gitBranch: z.string().optional().describe('Git branch name for loop iteration work'),
  priority: z.enum(['P0', 'P1', 'P2']).optional().describe('Task priority'),
  agent: z.enum(AGENT_PROVIDERS_TUPLE).optional().describe('Agent provider'),
  model: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Model override for each iteration task (overrides agent-config default)'),
  // Schedule fields
  scheduleType: z.enum(['cron', 'one_time']).describe('Schedule type'),
  cronExpression: z.string().optional().describe('Cron expression (5-field) for recurring loops'),
  scheduledAt: z.string().optional().describe('ISO 8601 datetime for one-time loops'),
  timezone: z.string().optional().default('UTC').describe('IANA timezone'),
  missedRunPolicy: z.enum(['skip', 'catchup', 'fail']).optional().default('skip'),
  maxRuns: z.number().min(1).optional().describe('Maximum number of loop runs for cron schedules'),
  expiresAt: z.string().optional().describe('ISO 8601 datetime when schedule expires'),
});

const CancelLoopSchema = z.object({
  loopId: z.string().min(1).describe('Loop ID'),
  reason: z.string().optional().describe('Cancellation reason'),
  cancelTasks: z.boolean().optional().default(true).describe('Also cancel in-flight tasks'),
});

/** Standard MCP tool response shape */
interface MCPToolResponse {
  [key: string]: unknown;
  content: { type: string; text: string }[];
  isError?: boolean;
}

export interface MCPAdapterDeps {
  readonly taskManager: TaskManager;
  readonly logger: Logger;
  readonly scheduleService: ScheduleService;
  readonly loopService: LoopService;
  readonly agentRegistry: AgentRegistry | undefined;
  readonly config: Configuration;
  readonly orchestrationService?: OrchestrationService;
}

export class MCPAdapter {
  private readonly server: Server;

  private readonly taskManager: TaskManager;
  private readonly logger: Logger;
  private readonly scheduleService: ScheduleService;
  private readonly loopService: LoopService;
  private readonly agentRegistry: AgentRegistry | undefined;
  private readonly config: Configuration;
  private readonly orchestrationService?: OrchestrationService;

  constructor(deps: MCPAdapterDeps) {
    this.taskManager = deps.taskManager;
    this.logger = deps.logger;
    this.scheduleService = deps.scheduleService;
    this.loopService = deps.loopService;
    this.agentRegistry = deps.agentRegistry;
    this.config = deps.config;
    this.orchestrationService = deps.orchestrationService;
    this.server = new Server(
      {
        name: 'autobeat',
        version: pkg.version,
      },
      {
        capabilities: {
          tools: {},
        },
        instructions: MCP_INSTRUCTIONS,
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

  /**
   * Dispatch a tool call by name through the Zod validation + handler pipeline.
   * ARCHITECTURE: Extracted from the MCP tools/call request handler so both
   * the transport layer and tests share the same dispatch path.
   */
  async callTool(name: string, args: unknown): Promise<MCPToolResponse> {
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
      case 'ScheduleTask':
        return await this.handleScheduleTask(args);
      case 'ListSchedules':
        return await this.handleListSchedules(args);
      case 'ScheduleStatus':
        return await this.handleScheduleStatus(args);
      case 'CancelSchedule':
        return await this.handleCancelSchedule(args);
      case 'PauseSchedule':
        return await this.handlePauseSchedule(args);
      case 'ResumeSchedule':
        return await this.handleResumeSchedule(args);
      case 'CreatePipeline':
        return await this.handleCreatePipeline(args);
      case 'SchedulePipeline':
        return await this.handleSchedulePipeline(args);
      case 'CreateLoop':
        return await this.handleCreateLoop(args);
      case 'LoopStatus':
        return await this.handleLoopStatus(args);
      case 'ListLoops':
        return await this.handleListLoops(args);
      case 'CancelLoop':
        return await this.handleCancelLoop(args);
      case 'PauseLoop':
        return await this.handlePauseLoop(args);
      case 'ResumeLoop':
        return await this.handleResumeLoop(args);
      case 'ScheduleLoop':
        return await this.handleScheduleLoop(args);
      case 'ListAgents':
        return this.handleListAgents();
      case 'CreateOrchestrator':
        return await this.handleCreateOrchestrator(args);
      case 'OrchestratorStatus':
        return await this.handleOrchestratorStatus(args);
      case 'ListOrchestrators':
        return await this.handleListOrchestrators(args);
      case 'CancelOrchestrator':
        return await this.handleCancelOrchestrator(args);
      case 'ConfigureAgent':
        return this.handleConfigureAgent(args);
      default:
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: `Unknown tool: ${name}`, code: 'INVALID_TOOL' }, null, 2),
            },
          ],
          isError: true,
        };
    }
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
        return await this.callTool(name, args);
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
              description: 'Delegate a task to a background AI agent instance',
              inputSchema: {
                type: 'object',
                properties: {
                  prompt: {
                    type: 'string',
                    description: 'The task for the AI agent to execute',
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
                  agent: {
                    type: 'string',
                    enum: [...AGENT_PROVIDERS],
                    description: `AI agent to execute the task (${this.config.defaultAgent ? `default: ${this.config.defaultAgent}` : 'required if no default configured'})`,
                  },
                  model: {
                    type: 'string',
                    description: 'Model override for this task (overrides agent-config default)',
                    minLength: 1,
                    maxLength: 200,
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
                  agent: {
                    type: 'string',
                    enum: [...AGENT_PROVIDERS],
                    description: `AI agent to execute the task (${this.config.defaultAgent ? `default: ${this.config.defaultAgent}` : 'required if no default configured'})`,
                  },
                  model: {
                    type: 'string',
                    description: 'Model override for this task (overrides agent-config default)',
                    minLength: 1,
                    maxLength: 200,
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
              name: 'ScheduleStatus',
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
              description:
                'Cancel an active schedule. Optionally cancel in-flight pipeline tasks from the current execution.',
              inputSchema: {
                type: 'object',
                properties: {
                  scheduleId: {
                    type: 'string',
                  },
                  reason: {
                    type: 'string',
                  },
                  cancelTasks: {
                    type: 'boolean',
                    description: 'Also cancel in-flight tasks from the current pipeline execution (default: false)',
                    default: false,
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
                        agent: {
                          type: 'string',
                          enum: [...AGENT_PROVIDERS],
                          description: 'Agent override for this step',
                        },
                        model: {
                          type: 'string',
                          description: 'Model override for this step',
                          minLength: 1,
                          maxLength: 200,
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
                  agent: {
                    type: 'string',
                    enum: [...AGENT_PROVIDERS],
                    description: 'Default agent for all steps (individual steps can override)',
                  },
                  model: {
                    type: 'string',
                    description: 'Default model for all steps (individual steps can override)',
                    minLength: 1,
                    maxLength: 200,
                  },
                },
                required: ['steps'],
              },
            },
            // Scheduled pipeline (v0.6.0)
            {
              name: 'SchedulePipeline',
              description:
                'Schedule a recurring or one-time pipeline. Each trigger creates N tasks with linear dependencies (e.g., "every day at 9am: lint → test → deploy").',
              inputSchema: {
                type: 'object',
                properties: {
                  steps: {
                    type: 'array',
                    description: 'Ordered pipeline steps (executed sequentially on each trigger)',
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
                        agent: {
                          type: 'string',
                          enum: [...AGENT_PROVIDERS],
                          description: 'Agent override for this step',
                        },
                        model: {
                          type: 'string',
                          description: 'Model override for this step',
                          minLength: 1,
                          maxLength: 200,
                        },
                      },
                      required: ['prompt'],
                    },
                    minItems: 2,
                    maxItems: 20,
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
                    description: 'ISO 8601 datetime for one-time pipelines',
                  },
                  timezone: {
                    type: 'string',
                    description: 'IANA timezone (default: UTC)',
                  },
                  missedRunPolicy: {
                    type: 'string',
                    enum: ['skip', 'catchup', 'fail'],
                  },
                  priority: {
                    type: 'string',
                    enum: ['P0', 'P1', 'P2'],
                    description: 'Default priority for all steps',
                  },
                  workingDirectory: {
                    type: 'string',
                    description: 'Default working directory for all steps',
                  },
                  maxRuns: {
                    type: 'number',
                    description: 'Maximum runs for cron pipelines',
                  },
                  expiresAt: {
                    type: 'string',
                    description: 'ISO 8601 expiration datetime',
                  },
                  afterSchedule: {
                    type: 'string',
                    description: "Schedule ID to chain after (step 0 depends on this schedule's latest task)",
                  },
                  agent: {
                    type: 'string',
                    enum: [...AGENT_PROVIDERS],
                    description: 'Default agent for all steps (individual steps can override)',
                  },
                  model: {
                    type: 'string',
                    description: 'Default model for all steps (individual steps can override)',
                    minLength: 1,
                    maxLength: 200,
                  },
                },
                required: ['steps', 'scheduleType'],
              },
            },
            // Loop tools (v0.7.0 Task/Pipeline Loops)
            {
              name: 'CreateLoop',
              description:
                'Create an iterative loop that runs a task repeatedly until an exit condition is met. Supports retry (pass/fail) and optimize (score-based) strategies.',
              inputSchema: {
                type: 'object',
                properties: {
                  prompt: {
                    type: 'string',
                    description: 'Task prompt for each iteration',
                    minLength: 1,
                    maxLength: 4000,
                  },
                  strategy: {
                    type: 'string',
                    enum: ['retry', 'optimize'],
                    description: 'Loop strategy: retry (pass/fail exit condition) or optimize (score-based)',
                  },
                  exitCondition: {
                    type: 'string',
                    description:
                      'Shell command to evaluate after each iteration (exit code 0 = pass for retry, stdout = score for optimize)',
                  },
                  evalMode: {
                    type: 'string',
                    enum: ['shell', 'agent'],
                    description: 'Evaluation mode: shell command or agent review (default: shell)',
                  },
                  evalPrompt: {
                    type: 'string',
                    description: 'Custom prompt for agent evaluator (agent eval mode only)',
                    minLength: 1,
                    maxLength: 8000,
                  },
                  evalDirection: {
                    type: 'string',
                    enum: ['minimize', 'maximize'],
                    description: 'Score direction for optimize strategy',
                  },
                  evalTimeout: {
                    type: 'number',
                    description: 'Eval script timeout in ms (default: 60000, max: 600000)',
                    minimum: 1000,
                    maximum: 600000,
                  },
                  workingDirectory: {
                    type: 'string',
                    description: 'Working directory for task and eval execution',
                  },
                  maxIterations: {
                    type: 'number',
                    description: 'Max iterations (0 = unlimited, default: 10)',
                    minimum: 0,
                  },
                  maxConsecutiveFailures: {
                    type: 'number',
                    description: 'Max consecutive failures before stopping (default: 3)',
                    minimum: 0,
                  },
                  cooldownMs: {
                    type: 'number',
                    description: 'Cooldown between iterations in ms (default: 0)',
                    minimum: 0,
                  },
                  freshContext: {
                    type: 'boolean',
                    description: 'Start each iteration fresh (true) or continue from checkpoint (default: true)',
                  },
                  pipelineSteps: {
                    type: 'array',
                    description: 'Pipeline step prompts (creates pipeline loop, 2-20 steps)',
                    items: { type: 'string', minLength: 1 },
                    minItems: 2,
                    maxItems: 20,
                  },
                  priority: {
                    type: 'string',
                    enum: ['P0', 'P1', 'P2'],
                    description: 'Task priority (P0=critical, P1=high, P2=normal)',
                  },
                  agent: {
                    type: 'string',
                    enum: [...AGENT_PROVIDERS],
                    description: `AI agent to execute iterations (${this.config.defaultAgent ? `default: ${this.config.defaultAgent}` : 'required if no default configured'})`,
                  },
                  model: {
                    type: 'string',
                    description: 'Model override for each iteration task (overrides agent-config default)',
                    minLength: 1,
                    maxLength: 200,
                  },
                  gitBranch: {
                    type: 'string',
                    description: 'Git branch name for loop iteration work (v0.8.0)',
                  },
                },
                required: ['strategy'],
              },
            },
            {
              name: 'LoopStatus',
              description: 'Get details of a specific loop including optional iteration history',
              inputSchema: {
                type: 'object',
                properties: {
                  loopId: {
                    type: 'string',
                    description: 'Loop ID',
                  },
                  includeHistory: {
                    type: 'boolean',
                    description: 'Include iteration history (default: false)',
                  },
                  historyLimit: {
                    type: 'number',
                    description: 'Max iterations to return (default: 20)',
                    minimum: 1,
                  },
                },
                required: ['loopId'],
              },
            },
            {
              name: 'ListLoops',
              description: 'List loops with optional status filter',
              inputSchema: {
                type: 'object',
                properties: {
                  status: {
                    type: 'string',
                    enum: ['running', 'paused', 'completed', 'failed', 'cancelled'],
                    description: 'Filter by status',
                  },
                  limit: {
                    type: 'number',
                    description: 'Max results (default: 20)',
                    minimum: 1,
                    maximum: 100,
                  },
                },
              },
            },
            {
              name: 'CancelLoop',
              description: 'Cancel an active loop. Optionally cancel in-flight iteration tasks.',
              inputSchema: {
                type: 'object',
                properties: {
                  loopId: {
                    type: 'string',
                    description: 'Loop ID to cancel',
                  },
                  reason: {
                    type: 'string',
                    description: 'Cancellation reason',
                  },
                  cancelTasks: {
                    type: 'boolean',
                    description: 'Also cancel in-flight iteration tasks (default: true)',
                    default: true,
                  },
                },
                required: ['loopId'],
              },
            },
            // Loop pause/resume/schedule tools (v0.8.0)
            {
              name: 'PauseLoop',
              description: 'Pause an active loop. Graceful pause waits for current iteration; force pause cancels it.',
              inputSchema: {
                type: 'object',
                properties: {
                  loopId: {
                    type: 'string',
                    description: 'Loop ID to pause',
                  },
                  force: {
                    type: 'boolean',
                    description: 'Force pause — cancel current iteration immediately (default: false)',
                    default: false,
                  },
                },
                required: ['loopId'],
              },
            },
            {
              name: 'ResumeLoop',
              description: 'Resume a paused loop',
              inputSchema: {
                type: 'object',
                properties: {
                  loopId: {
                    type: 'string',
                    description: 'Loop ID to resume',
                  },
                },
                required: ['loopId'],
              },
            },
            {
              name: 'ScheduleLoop',
              description:
                'Schedule a recurring or one-time loop. Each trigger creates a fresh loop from the provided configuration.',
              inputSchema: {
                type: 'object',
                properties: {
                  prompt: { type: 'string', description: 'Task prompt for each iteration' },
                  strategy: { type: 'string', enum: ['retry', 'optimize'], description: 'Loop strategy' },
                  exitCondition: { type: 'string', description: 'Shell command to evaluate after each iteration' },
                  evalMode: {
                    type: 'string',
                    enum: ['shell', 'agent'],
                    description: 'Evaluation mode: shell command or agent review (default: shell)',
                  },
                  evalPrompt: {
                    type: 'string',
                    description: 'Custom prompt for agent evaluator (agent eval mode only)',
                  },
                  evalDirection: { type: 'string', enum: ['minimize', 'maximize'] },
                  evalTimeout: {
                    type: 'number',
                    description: 'Eval script timeout in ms',
                    minimum: 1000,
                    maximum: 600000,
                  },
                  workingDirectory: { type: 'string' },
                  maxIterations: { type: 'number', description: 'Max iterations (0 = unlimited)', minimum: 0 },
                  maxConsecutiveFailures: { type: 'number', minimum: 0 },
                  cooldownMs: { type: 'number', minimum: 0 },
                  freshContext: { type: 'boolean' },
                  pipelineSteps: {
                    type: 'array',
                    items: { type: 'string', minLength: 1 },
                    minItems: 2,
                    maxItems: 20,
                  },
                  gitBranch: { type: 'string', description: 'Git branch name for loop iteration work' },
                  priority: { type: 'string', enum: ['P0', 'P1', 'P2'] },
                  agent: { type: 'string', enum: [...AGENT_PROVIDERS] },
                  model: {
                    type: 'string',
                    description: 'Model override for each iteration task (overrides agent-config default)',
                    minLength: 1,
                    maxLength: 200,
                  },
                  scheduleType: { type: 'string', enum: ['cron', 'one_time'] },
                  cronExpression: { type: 'string', description: 'Cron expression (5-field)' },
                  scheduledAt: { type: 'string', description: 'ISO 8601 datetime for one-time loops' },
                  timezone: { type: 'string', description: 'IANA timezone (default: UTC)' },
                  missedRunPolicy: { type: 'string', enum: ['skip', 'catchup', 'fail'] },
                  maxRuns: { type: 'number', description: 'Maximum number of loop runs for cron schedules' },
                  expiresAt: { type: 'string', description: 'ISO 8601 expiration datetime' },
                },
                required: ['strategy', 'scheduleType'],
              },
            },
            // Agent tools (v0.5.0 Multi-Agent Support)
            {
              name: 'ListAgents',
              description: 'List available AI agents with registration and auth status',
              inputSchema: {
                type: 'object',
                properties: {},
              },
            },
            {
              name: 'CreateOrchestrator',
              description:
                'Create and start an autonomous orchestration session. The orchestrator decomposes a high-level goal into subtasks, delegates to worker agents, monitors progress, and iterates until the goal is achieved.',
              inputSchema: {
                type: 'object',
                properties: {
                  goal: {
                    type: 'string',
                    description: 'High-level goal for the orchestrator to achieve',
                    minLength: 1,
                    maxLength: 8000,
                  },
                  workingDirectory: {
                    type: 'string',
                    description: 'Working directory for workers (absolute path)',
                  },
                  agent: {
                    type: 'string',
                    enum: [...AGENT_PROVIDERS],
                    description: 'AI agent for the orchestrator loop',
                  },
                  model: {
                    type: 'string',
                    description: 'Model override for the orchestrator (overrides agent-config default)',
                    minLength: 1,
                    maxLength: 200,
                  },
                  maxDepth: {
                    type: 'number',
                    description: 'Max delegation depth (1-10, default: 3)',
                    minimum: 1,
                    maximum: 10,
                  },
                  maxWorkers: {
                    type: 'number',
                    description: 'Max concurrent workers (1-20, default: 5)',
                    minimum: 1,
                    maximum: 20,
                  },
                  maxIterations: {
                    type: 'number',
                    description: 'Max orchestrator iterations (1-200, default: 50)',
                    minimum: 1,
                    maximum: 200,
                  },
                },
                required: ['goal'],
              },
            },
            {
              name: 'OrchestratorStatus',
              description: 'Get the status and details of an orchestration session',
              inputSchema: {
                type: 'object',
                properties: {
                  orchestratorId: {
                    type: 'string',
                    description: 'Orchestrator ID',
                  },
                },
                required: ['orchestratorId'],
              },
            },
            {
              name: 'ListOrchestrators',
              description: 'List orchestration sessions with optional status filter',
              inputSchema: {
                type: 'object',
                properties: {
                  status: {
                    type: 'string',
                    enum: ['planning', 'running', 'completed', 'failed', 'cancelled'],
                    description: 'Filter by orchestration status',
                  },
                  limit: {
                    type: 'number',
                    description: 'Maximum results (default: 50)',
                    minimum: 1,
                    maximum: 100,
                  },
                  offset: {
                    type: 'number',
                    description: 'Skip first N results (default: 0)',
                    minimum: 0,
                  },
                },
              },
            },
            {
              name: 'CancelOrchestrator',
              description: 'Cancel an active orchestration session and its underlying loop/workers',
              inputSchema: {
                type: 'object',
                properties: {
                  orchestratorId: {
                    type: 'string',
                    description: 'Orchestrator ID to cancel',
                  },
                  reason: {
                    type: 'string',
                    description: 'Reason for cancellation',
                  },
                },
                required: ['orchestratorId'],
              },
            },
            {
              name: 'ConfigureAgent',
              description:
                'Check auth status, store API key/baseUrl/model, or reset stored config for an agent. Note: to clear individual fields (baseUrl, model), use action=reset (clears all) or the CLI `beat agents config set <agent> <field> ""`. The MCP set action requires non-empty values.',
              inputSchema: {
                type: 'object',
                properties: {
                  agent: {
                    type: 'string',
                    enum: [...AGENT_PROVIDERS],
                    description: 'Agent provider to configure',
                  },
                  action: {
                    type: 'string',
                    enum: ['set', 'check', 'reset'],
                    description: 'Action to perform (default: check)',
                  },
                  apiKey: {
                    type: 'string',
                    description: 'API key to store (set action)',
                  },
                  baseUrl: {
                    type: 'string',
                    description: 'Base URL override for the agent API (set action, e.g. https://proxy.example.com/v1)',
                  },
                  model: {
                    type: 'string',
                    description: 'Default model for this agent (set action, overridden by per-task model)',
                    minLength: 1,
                    maxLength: 200,
                  },
                },
                required: ['agent'],
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

    // v1.3.0: Validate orchestratorId from per-request metadata against DB.
    // IMPORTANT: Do NOT use an env var here — the MCP server is long-lived and shared
    // across orchestrators. Per-request metadata is the only safe mechanism (Risk #8).
    let orchestratorId: OrchestratorId | undefined;
    if (data.metadata?.orchestratorId && this.orchestrationService) {
      const orchResult = await this.orchestrationService.getOrchestration(OrchestratorId(data.metadata.orchestratorId));
      if (orchResult.ok) {
        orchestratorId = OrchestratorId(data.metadata.orchestratorId);
      } else {
        // Drop silently — stale or unknown orchestratorId should not block task delegation
        this.logger.warn('DelegateTask: metadata.orchestratorId not found in DB, ignoring', {
          orchestratorId: data.metadata.orchestratorId,
        });
      }
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
      agent: data.agent as AgentProvider | undefined,
      model: data.model,
      orchestratorId,
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
          // Multiple tasks — add promptPreview for concise display
          const tasks = data.map((task) => ({
            ...task,
            promptPreview: truncatePrompt(task.prompt),
          }));
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  tasks,
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
                  prompt: truncatePrompt(task.prompt, 100),
                  startTime: task.startedAt,
                  endTime: task.completedAt,
                  duration: task.completedAt && task.startedAt ? task.completedAt - task.startedAt : undefined,
                  exitCode: task.exitCode,
                  workingDirectory: task.workingDirectory,
                  agent: task.agent ?? 'unknown',
                  ...(task.model && { model: task.model }),
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
      agent: data.agent as AgentProvider | undefined,
      model: data.model,
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
          isPipeline: !!(s.pipelineSteps && s.pipelineSteps.length > 0),
          stepCount: s.pipelineSteps?.length ?? 0,
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
   * Handle ScheduleStatus tool call
   * Gets details of a specific schedule with optional execution history
   */
  private async handleScheduleStatus(args: unknown): Promise<MCPToolResponse> {
    const parseResult = ScheduleStatusSchema.safeParse(args);
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
              prompt: truncatePrompt(schedule.taskTemplate.prompt, 100),
              priority: schedule.taskTemplate.priority,
              workingDirectory: schedule.taskTemplate.workingDirectory,
            },
            ...(schedule.pipelineSteps && schedule.pipelineSteps.length > 0
              ? {
                  isPipeline: true,
                  pipelineSteps: schedule.pipelineSteps.map((s, i) => ({
                    index: i,
                    prompt: truncatePrompt(s.prompt, 100),
                    priority: s.priority,
                    workingDirectory: s.workingDirectory,
                    agent: s.agent,
                  })),
                }
              : {}),
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

    const { scheduleId, reason, cancelTasks } = parseResult.data;

    const result = await this.scheduleService.cancelSchedule(ScheduleId(scheduleId), reason, cancelTasks);

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
                cancelTasksRequested: cancelTasks,
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
        agent: (s.agent ?? data.agent) as AgentProvider | undefined,
        model: s.model ?? data.model,
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

  /**
   * Handle SchedulePipeline tool call
   * Creates a scheduled pipeline that triggers N tasks with linear dependencies on each run
   */
  private async handleSchedulePipeline(args: unknown): Promise<MCPToolResponse> {
    const parseResult = SchedulePipelineSchema.safeParse(args);
    if (!parseResult.success) {
      return {
        content: [{ type: 'text', text: `Validation error: ${parseResult.error.message}` }],
        isError: true,
      };
    }

    const data = parseResult.data;

    const request: ScheduledPipelineCreateRequest = {
      steps: data.steps.map((s) => ({
        prompt: s.prompt,
        priority: s.priority as Priority | undefined,
        workingDirectory: s.workingDirectory,
        agent: s.agent as AgentProvider | undefined,
        model: s.model ?? data.model,
      })),
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
      agent: data.agent as AgentProvider | undefined,
      model: data.model,
    };

    const result = await this.scheduleService.createScheduledPipeline(request);

    return match(result, {
      ok: (schedule) => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                scheduleId: schedule.id,
                stepCount: schedule.pipelineSteps?.length ?? 0,
                scheduleType: schedule.scheduleType,
                nextRunAt: schedule.nextRunAt ? new Date(schedule.nextRunAt).toISOString() : null,
                status: schedule.status,
                timezone: schedule.timezone,
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
  // LOOP HANDLERS (v0.7.0 Task/Pipeline Loops)
  // Thin wrappers: Zod parse -> service call -> format MCP response
  // ============================================================================

  /**
   * Handle CreateLoop tool call
   * Creates a new iterative loop (retry or optimize strategy)
   */
  private async handleCreateLoop(args: unknown): Promise<MCPToolResponse> {
    const parseResult = CreateLoopSchema.safeParse(args);
    if (!parseResult.success) {
      return {
        content: [{ type: 'text', text: `Validation error: ${parseResult.error.message}` }],
        isError: true,
      };
    }

    const data = parseResult.data;

    // SECURITY: Validate workingDirectory to prevent path traversal attacks
    if (data.workingDirectory) {
      const pathValidation = validatePath(data.workingDirectory);
      if (!pathValidation.ok) {
        return {
          content: [{ type: 'text', text: `Invalid working directory: ${pathValidation.error.message}` }],
          isError: true,
        };
      }
    }

    const request: LoopCreateRequest = {
      prompt: data.prompt,
      strategy: data.strategy === 'retry' ? LoopStrategy.RETRY : LoopStrategy.OPTIMIZE,
      exitCondition: data.exitCondition,
      evalMode: data.evalMode,
      evalPrompt: data.evalPrompt,
      evalDirection: toOptimizeDirection(data.evalDirection),
      evalTimeout: data.evalTimeout,
      workingDirectory: data.workingDirectory,
      maxIterations: data.maxIterations,
      maxConsecutiveFailures: data.maxConsecutiveFailures,
      cooldownMs: data.cooldownMs,
      freshContext: data.freshContext,
      pipelineSteps: data.pipelineSteps,
      priority: data.priority as Priority | undefined,
      agent: data.agent as AgentProvider | undefined,
      model: data.model,
      gitBranch: data.gitBranch,
    };

    const result = await this.loopService.createLoop(request);

    return match(result, {
      ok: (loop) => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                loopId: loop.id,
                strategy: loop.strategy,
                status: loop.status,
                maxIterations: loop.maxIterations,
                message: 'Loop created successfully',
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
   * Handle LoopStatus tool call
   * Gets details of a specific loop with optional iteration history
   */
  private async handleLoopStatus(args: unknown): Promise<MCPToolResponse> {
    const parseResult = LoopStatusSchema.safeParse(args);
    if (!parseResult.success) {
      return {
        content: [{ type: 'text', text: `Validation error: ${parseResult.error.message}` }],
        isError: true,
      };
    }

    const { loopId, includeHistory, historyLimit } = parseResult.data;

    const result = await this.loopService.getLoop(LoopId(loopId), includeHistory, historyLimit);

    return match(result, {
      ok: ({ loop, iterations }) => {
        const response: Record<string, unknown> = {
          success: true,
          loop: {
            id: loop.id,
            strategy: loop.strategy,
            status: loop.status,
            currentIteration: loop.currentIteration,
            maxIterations: loop.maxIterations,
            consecutiveFailures: loop.consecutiveFailures,
            maxConsecutiveFailures: loop.maxConsecutiveFailures,
            bestScore: loop.bestScore,
            exitCondition: loop.exitCondition,
            evalDirection: loop.evalDirection,
            cooldownMs: loop.cooldownMs,
            freshContext: loop.freshContext,
            promptPreview: truncatePrompt(loop.taskTemplate.prompt, 50),
            workingDirectory: loop.workingDirectory,
            gitBranch: loop.gitBranch ?? null,
            gitBaseBranch: loop.gitBaseBranch ?? null,
            gitStartCommitSha: loop.gitStartCommitSha ?? null,
            evalMode: loop.evalMode,
            evalPrompt: loop.evalPrompt ?? null,
            scheduleId: loop.scheduleId ?? null,
            createdAt: new Date(loop.createdAt).toISOString(),
            updatedAt: new Date(loop.updatedAt).toISOString(),
            completedAt: loop.completedAt ? new Date(loop.completedAt).toISOString() : null,
            ...(loop.pipelineSteps && loop.pipelineSteps.length > 0
              ? {
                  isPipeline: true,
                  pipelineSteps: loop.pipelineSteps.map((s, i) => ({
                    index: i,
                    prompt: truncatePrompt(s, 80),
                  })),
                }
              : {}),
          },
        };

        if (iterations) {
          response.iterations = iterations.map((iter) => ({
            iterationNumber: iter.iterationNumber,
            status: iter.status,
            taskId: iter.taskId ?? null,
            score: iter.score ?? null,
            exitCode: iter.exitCode ?? null,
            errorMessage: iter.errorMessage ?? null,
            evalFeedback: iter.evalFeedback ?? null,
            gitBranch: iter.gitBranch ?? null,
            gitCommitSha: iter.gitCommitSha ?? null,
            preIterationCommitSha: iter.preIterationCommitSha ?? null,
            gitDiffSummary: iter.gitDiffSummary ?? null,
            startedAt: new Date(iter.startedAt).toISOString(),
            completedAt: iter.completedAt ? new Date(iter.completedAt).toISOString() : null,
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
   * Handle ListLoops tool call
   * Lists loops with optional status filter
   */
  private async handleListLoops(args: unknown): Promise<MCPToolResponse> {
    const parseResult = ListLoopsSchema.safeParse(args);
    if (!parseResult.success) {
      return {
        content: [{ type: 'text', text: `Validation error: ${parseResult.error.message}` }],
        isError: true,
      };
    }

    const { status, limit } = parseResult.data;

    const result = await this.loopService.listLoops(status as LoopStatus | undefined, limit);

    return match(result, {
      ok: (loops) => {
        const summaries = loops.map((l) => ({
          id: l.id,
          strategy: l.strategy,
          status: l.status,
          currentIteration: l.currentIteration,
          maxIterations: l.maxIterations,
          promptPreview: truncatePrompt(l.taskTemplate.prompt, 50),
          isPipeline: !!(l.pipelineSteps && l.pipelineSteps.length > 0),
          createdAt: new Date(l.createdAt).toISOString(),
        }));

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  loops: summaries,
                  count: summaries.length,
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
   * Handle CancelLoop tool call
   * Cancels an active loop with optional task cancellation
   */
  private async handleCancelLoop(args: unknown): Promise<MCPToolResponse> {
    const parseResult = CancelLoopSchema.safeParse(args);
    if (!parseResult.success) {
      return {
        content: [{ type: 'text', text: `Validation error: ${parseResult.error.message}` }],
        isError: true,
      };
    }

    const { loopId, reason, cancelTasks } = parseResult.data;

    const result = await this.loopService.cancelLoop(LoopId(loopId), reason, cancelTasks);

    return match(result, {
      ok: () => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                message: `Loop ${loopId} cancelled`,
                reason,
                cancelTasksRequested: cancelTasks,
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
   * Handle PauseLoop tool call
   * Pauses an active loop (graceful or force)
   */
  private async handlePauseLoop(args: unknown): Promise<MCPToolResponse> {
    const parseResult = PauseLoopSchema.safeParse(args);
    if (!parseResult.success) {
      return {
        content: [{ type: 'text', text: `Validation error: ${parseResult.error.message}` }],
        isError: true,
      };
    }

    const { loopId, force } = parseResult.data;

    const result = await this.loopService.pauseLoop(LoopId(loopId), { force });

    return match(result, {
      ok: () => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                message: `Loop ${loopId} paused`,
                force,
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
   * Handle ResumeLoop tool call
   * Resumes a paused loop
   */
  private async handleResumeLoop(args: unknown): Promise<MCPToolResponse> {
    const parseResult = ResumeLoopSchema.safeParse(args);
    if (!parseResult.success) {
      return {
        content: [{ type: 'text', text: `Validation error: ${parseResult.error.message}` }],
        isError: true,
      };
    }

    const { loopId } = parseResult.data;

    const result = await this.loopService.resumeLoop(LoopId(loopId));

    return match(result, {
      ok: () => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                message: `Loop ${loopId} resumed`,
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
   * Handle ScheduleLoop tool call
   * Creates a scheduled loop that triggers loop creation on each run
   */
  private async handleScheduleLoop(args: unknown): Promise<MCPToolResponse> {
    const parseResult = ScheduleLoopSchema.safeParse(args);
    if (!parseResult.success) {
      return {
        content: [{ type: 'text', text: `Validation error: ${parseResult.error.message}` }],
        isError: true,
      };
    }

    const data = parseResult.data;

    const loopConfig: LoopCreateRequest = {
      prompt: data.prompt,
      strategy: data.strategy === 'retry' ? LoopStrategy.RETRY : LoopStrategy.OPTIMIZE,
      exitCondition: data.exitCondition,
      evalMode: data.evalMode,
      evalPrompt: data.evalPrompt,
      evalDirection: toOptimizeDirection(data.evalDirection),
      evalTimeout: data.evalTimeout,
      workingDirectory: data.workingDirectory,
      maxIterations: data.maxIterations,
      maxConsecutiveFailures: data.maxConsecutiveFailures,
      cooldownMs: data.cooldownMs,
      freshContext: data.freshContext,
      pipelineSteps: data.pipelineSteps,
      gitBranch: data.gitBranch,
      priority: data.priority as Priority | undefined,
      agent: data.agent as AgentProvider | undefined,
      model: data.model,
    };

    const request: ScheduledLoopCreateRequest = {
      loopConfig,
      scheduleType: data.scheduleType === 'cron' ? ScheduleType.CRON : ScheduleType.ONE_TIME,
      cronExpression: data.cronExpression,
      scheduledAt: data.scheduledAt,
      timezone: data.timezone,
      missedRunPolicy: toMissedRunPolicy(data.missedRunPolicy),
      maxRuns: data.maxRuns,
      expiresAt: data.expiresAt,
    };

    const result = await this.scheduleService.createScheduledLoop(request);

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
                status: schedule.status,
                timezone: schedule.timezone,
                loopStrategy: data.strategy,
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
  // AGENT HANDLERS (v0.5.0 Multi-Agent Support)
  // ============================================================================

  /**
   * Handle ListAgents tool call
   * Returns all known agent providers with registration and auth status
   */
  private handleListAgents(): MCPToolResponse {
    const agents = AGENT_PROVIDERS.map((provider) => {
      const agentConfig = loadAgentConfig(provider);
      const authStatus = checkAgentAuth(provider, agentConfig.apiKey);

      const claudeBaseUrlWarning = this.getClaudeBaseUrlWarning(provider, agentConfig.baseUrl, agentConfig.apiKey);

      return {
        provider,
        description: AGENT_DESCRIPTIONS[provider],
        registered: this.agentRegistry?.has(provider) ?? false,
        isDefault: provider === this.config.defaultAgent,
        authStatus: authStatus.ready ? 'ready' : 'not-configured',
        authMethod: authStatus.method,
        ...(authStatus.hint && { hint: authStatus.hint }),
        ...(agentConfig.baseUrl && { baseUrl: agentConfig.baseUrl }),
        ...(agentConfig.model && { model: agentConfig.model }),
        ...(claudeBaseUrlWarning && { warning: claudeBaseUrlWarning }),
      };
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              agents,
              defaultAgent: this.config.defaultAgent ?? null,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  // ============================================================================
  // Orchestrator tool handlers (v0.9.0)
  // ============================================================================

  private readonly ORCHESTRATION_UNAVAILABLE: MCPToolResponse = {
    content: [{ type: 'text', text: JSON.stringify({ error: 'Orchestration service not available' }, null, 2) }],
    isError: true,
  };

  private async handleCreateOrchestrator(args: unknown): Promise<MCPToolResponse> {
    if (!this.orchestrationService) return this.ORCHESTRATION_UNAVAILABLE;

    const parseResult = CreateOrchestratorSchema.safeParse(args);
    if (!parseResult.success) {
      return {
        content: [{ type: 'text', text: `Validation error: ${parseResult.error.message}` }],
        isError: true,
      };
    }

    const data = parseResult.data;

    if (data.workingDirectory) {
      const pathValidation = validatePath(data.workingDirectory);
      if (!pathValidation.ok) {
        return {
          content: [{ type: 'text', text: `Invalid working directory: ${pathValidation.error.message}` }],
          isError: true,
        };
      }
    }

    const result = await this.orchestrationService.createOrchestration({
      goal: data.goal,
      workingDirectory: data.workingDirectory,
      agent: data.agent as AgentProvider | undefined,
      model: data.model,
      maxDepth: data.maxDepth,
      maxWorkers: data.maxWorkers,
      maxIterations: data.maxIterations,
    });

    return match(result, {
      ok: (orchestration) => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                orchestratorId: orchestration.id,
                loopId: orchestration.loopId,
                status: orchestration.status,
                stateFilePath: orchestration.stateFilePath,
                message: 'Orchestration started',
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

  private async handleOrchestratorStatus(args: unknown): Promise<MCPToolResponse> {
    if (!this.orchestrationService) return this.ORCHESTRATION_UNAVAILABLE;

    const parseResult = OrchestratorStatusSchema.safeParse(args);
    if (!parseResult.success) {
      return {
        content: [{ type: 'text', text: `Validation error: ${parseResult.error.message}` }],
        isError: true,
      };
    }

    const result = await this.orchestrationService.getOrchestration(OrchestratorId(parseResult.data.orchestratorId));

    return match(result, {
      ok: (orchestration) => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                orchestration: {
                  id: orchestration.id,
                  goal: orchestration.goal,
                  status: orchestration.status,
                  loopId: orchestration.loopId,
                  stateFilePath: orchestration.stateFilePath,
                  workingDirectory: orchestration.workingDirectory,
                  agent: orchestration.agent,
                  ...(orchestration.model && { model: orchestration.model }),
                  maxDepth: orchestration.maxDepth,
                  maxWorkers: orchestration.maxWorkers,
                  maxIterations: orchestration.maxIterations,
                  createdAt: new Date(orchestration.createdAt).toISOString(),
                  updatedAt: new Date(orchestration.updatedAt).toISOString(),
                  completedAt: orchestration.completedAt ? new Date(orchestration.completedAt).toISOString() : null,
                },
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

  private async handleListOrchestrators(args: unknown): Promise<MCPToolResponse> {
    if (!this.orchestrationService) return this.ORCHESTRATION_UNAVAILABLE;

    const parseResult = ListOrchestratorsSchema.safeParse(args);
    if (!parseResult.success) {
      return {
        content: [{ type: 'text', text: `Validation error: ${parseResult.error.message}` }],
        isError: true,
      };
    }

    const { status, limit, offset } = parseResult.data;
    const result = await this.orchestrationService.listOrchestrations(status, limit, offset);

    return match(result, {
      ok: (orchestrations) => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                count: orchestrations.length,
                orchestrations: orchestrations.map((o) => ({
                  id: o.id,
                  goal: truncatePrompt(o.goal, 100),
                  status: o.status,
                  loopId: o.loopId,
                  createdAt: new Date(o.createdAt).toISOString(),
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

  private async handleCancelOrchestrator(args: unknown): Promise<MCPToolResponse> {
    if (!this.orchestrationService) return this.ORCHESTRATION_UNAVAILABLE;

    const parseResult = CancelOrchestratorSchema.safeParse(args);
    if (!parseResult.success) {
      return {
        content: [{ type: 'text', text: `Validation error: ${parseResult.error.message}` }],
        isError: true,
      };
    }

    const { orchestratorId, reason } = parseResult.data;
    const result = await this.orchestrationService.cancelOrchestration(OrchestratorId(orchestratorId), reason);

    return match(result, {
      ok: () => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                orchestratorId,
                message: 'Orchestration cancelled',
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
   * Returns a warning string when Claude has a custom baseUrl configured without an API key.
   * Login-based auth does not work with a custom baseUrl, so the setting will be silently
   * ignored. Returns undefined for all other providers or when the condition is not met.
   */
  private getClaudeBaseUrlWarning(
    provider: string,
    baseUrl: string | undefined,
    apiKey: string | undefined,
  ): string | undefined {
    if (provider === 'claude' && baseUrl && !apiKey) {
      return 'Warning: Claude requires an API key when using a custom baseUrl. The base URL will be ignored with login-based auth.';
    }
    return undefined;
  }

  /**
   * Handle ConfigureAgent tool call
   * Actions: check auth status, set API key, reset stored key
   */
  private handleConfigureAgent(args: unknown): MCPToolResponse {
    const parseResult = ConfigureAgentSchema.safeParse(args);
    if (!parseResult.success) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: parseResult.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }

    const { agent, action, apiKey, baseUrl, model } = parseResult.data;

    switch (action) {
      case 'check': {
        const agentConfig = loadAgentConfig(agent);
        const status = checkAgentAuth(agent, agentConfig.apiKey);

        interface CheckPayload {
          success: boolean;
          ready: boolean;
          method: string;
          hint?: string;
          storedKey?: string;
          baseUrl?: string;
          model?: string;
          warning?: string;
        }
        const checkWarning = this.getClaudeBaseUrlWarning(agent, agentConfig.baseUrl, agentConfig.apiKey);
        const checkPayload: CheckPayload = {
          success: true,
          ...status,
          ...(agentConfig.apiKey && { storedKey: maskApiKey(agentConfig.apiKey) }),
          ...(agentConfig.baseUrl && { baseUrl: agentConfig.baseUrl }),
          ...(agentConfig.model && { model: agentConfig.model }),
          ...(checkWarning && { warning: checkWarning }),
        };

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(checkPayload, null, 2),
            },
          ],
        };
      }

      case 'set': {
        if (!apiKey && !baseUrl && !model) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  { success: false, error: 'At least one of apiKey, baseUrl, or model is required for set action' },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }

        // Perform all writes up-front to avoid partial-write: collect each
        // result before returning so that a late failure reports which fields
        // were already saved and which failed.
        type WriteAttempt = { key: 'apiKey' | 'baseUrl' | 'model'; label: string; ok: boolean; error?: string };
        const attempts: WriteAttempt[] = [];

        if (apiKey) {
          const result = saveAgentConfig(agent, 'apiKey', apiKey);
          attempts.push({
            key: 'apiKey',
            label: `API key stored (${maskApiKey(apiKey)})`,
            ok: result.ok,
            error: result.ok ? undefined : result.error,
          });
        }

        if (baseUrl !== undefined) {
          const result = saveAgentConfig(agent, 'baseUrl', baseUrl);
          attempts.push({
            key: 'baseUrl',
            label: `baseUrl set to ${baseUrl}`,
            ok: result.ok,
            error: result.ok ? undefined : result.error,
          });
        }

        if (model !== undefined) {
          const result = saveAgentConfig(agent, 'model', model);
          attempts.push({
            key: 'model',
            label: `model set to ${model}`,
            ok: result.ok,
            error: result.ok ? undefined : result.error,
          });
        }

        const failed = attempts.filter((a) => !a.ok);
        if (failed.length > 0) {
          const saved = attempts.filter((a) => a.ok).map((a) => a.key);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: false,
                    error: failed.map((a) => a.error).join('; '),
                    ...(saved.length > 0 && { alreadySaved: saved }),
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }

        // Compute Claude baseUrl warning using effective values after writes
        const currentConfig = loadAgentConfig(agent);
        const effectiveBaseUrl = baseUrl !== undefined ? baseUrl : currentConfig.baseUrl;
        const effectiveApiKey = apiKey ?? currentConfig.apiKey;
        const setWarning = this.getClaudeBaseUrlWarning(agent, effectiveBaseUrl, effectiveApiKey);

        interface SetPayload {
          success: boolean;
          message: string;
          warning?: string;
        }
        const responsePayload: SetPayload = {
          success: true,
          message: `${agent}: ${attempts.map((a) => a.label).join(', ')}`,
          ...(setWarning && { warning: setWarning }),
        };

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(responsePayload, null, 2),
            },
          ],
        };
      }

      case 'reset': {
        const result = resetAgentConfig(agent);
        if (!result.ok) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: result.error }, null, 2) }],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, message: `Stored config cleared for ${agent}` }, null, 2),
            },
          ],
        };
      }
    }
  }
}
