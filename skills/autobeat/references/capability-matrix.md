# Capability Matrix

Complete parameter tables for every MCP tool and CLI command. Pure reference.

## MCP Tools

### DelegateTask

Submit a task to a background AI agent instance.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `prompt` | string | Yes | — | Task prompt |
| `priority` | string | No | P2 | P0 (critical), P1 (high), P2 (normal) |
| `workingDirectory` | string | No | — | Absolute path for task execution |
| `timeout` | number | No | 0 (disabled) | Timeout in ms (1000-86400000); 0 means no timeout |
| `maxOutputBuffer` | number | No | 10485760 | Max output buffer bytes (1024-1073741824) |
| `dependsOn` | string[] | No | — | Task IDs this task depends on |
| `continueFrom` | string | No | — | Task ID to receive checkpoint context from |
| `agent` | string | No | configured default | claude, codex, or gemini |
| `model` | string | No | — | Model override (overrides agent-config default) |
| `systemPrompt` | string | No | — | System prompt injected into agent (Claude: --append-system-prompt, Codex: developer_instructions, Gemini: combined GEMINI_SYSTEM_MD) |
| `metadata.orchestratorId` | string | No | — | Orchestration attribution (format: orchestrator-{UUID}, 49 chars exactly) |
| `jsonSchema` | string | No | — | JSON schema for structured output (Claude only) |

### TaskStatus

Get status of delegated tasks.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `taskId` | string | No | — | Specific task ID (omit for all tasks) |
| `includeSystemPrompt` | boolean | No | false | Include system prompt in response |

### TaskLogs

Retrieve execution logs from a delegated task.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `taskId` | string | Yes | — | Task ID to get logs for |
| `tail` | number | No | 100 | Number of recent lines |

### CancelTask

Cancel a running delegated task.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `taskId` | string | Yes | — | Task ID to cancel |
| `reason` | string | No | — | Cancellation reason |

### RetryTask

Retry a failed or completed task (creates new task with same prompt).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `taskId` | string | Yes | — | Task ID to retry |

### ResumeTask

Resume a terminal task with enriched context from its checkpoint.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `taskId` | string | Yes | — | Task ID (must be completed, failed, or cancelled) |
| `additionalContext` | string | No | — | Extra instructions for the resumed task |

### CreatePipeline

Create a sequential pipeline of 2-20 tasks.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `steps` | object[] | Yes | — | Ordered pipeline steps (2-20) |
| `steps[].prompt` | string | Yes | — | Task prompt for this step |
| `steps[].priority` | string | No | inherited | Priority override (P0, P1, P2) |
| `steps[].workingDirectory` | string | No | inherited | Working directory override |
| `steps[].agent` | string | No | inherited | Agent override |
| `steps[].model` | string | No | inherited | Model override for this step |
| `steps[].systemPrompt` | string | No | inherited | System prompt override for this step |
| `priority` | string | No | P2 | Default priority for all steps |
| `workingDirectory` | string | No | — | Default working directory for all steps |
| `agent` | string | No | configured default | Default agent for all steps |
| `model` | string | No | — | Default model for all steps (steps can override) |
| `systemPrompt` | string | No | — | Default system prompt for all steps (steps can override) |

### ScheduleTask

Schedule a task for future or recurring execution.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `prompt` | string | Yes | — | Task prompt |
| `scheduleType` | string | Yes | — | "cron" or "one_time" |
| `cronExpression` | string | Cond. | — | 5-field cron (required if cron) |
| `scheduledAt` | string | Cond. | — | ISO 8601 datetime (required if one_time) |
| `timezone` | string | No | UTC | IANA timezone identifier |
| `missedRunPolicy` | string | No | skip | skip, catchup, or fail |
| `priority` | string | No | P2 | Task priority |
| `workingDirectory` | string | No | — | Working directory |
| `maxRuns` | number | No | — | Max executions for cron |
| `expiresAt` | string | No | — | ISO 8601 expiry datetime |
| `afterSchedule` | string | No | — | Schedule ID to chain after |
| `agent` | string | No | configured default | Agent for the task |
| `model` | string | No | — | Model override (overrides agent-config default) |
| `systemPrompt` | string | No | — | System prompt injected on every scheduled run |

### ListSchedules

List all schedules with optional filters.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `status` | string | No | — | active, paused, completed, cancelled, expired |
| `limit` | number | No | 50 | Max results |
| `offset` | number | No | 0 | Pagination offset |

### ScheduleStatus

Get details of a specific schedule.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `scheduleId` | string | Yes | — | Schedule ID |
| `includeHistory` | boolean | No | false | Include execution history |
| `historyLimit` | number | No | 10 | Max history entries |

### CancelSchedule

Cancel an active schedule.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `scheduleId` | string | Yes | — | Schedule ID |
| `reason` | string | No | — | Cancellation reason |
| `cancelTasks` | boolean | No | false | Also cancel in-flight pipeline tasks |

### PauseSchedule

Pause an active schedule.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `scheduleId` | string | Yes | — | Schedule ID |

### ResumeSchedule

Resume a paused schedule.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `scheduleId` | string | Yes | — | Schedule ID |

### SchedulePipeline

Schedule a recurring or one-time pipeline.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `steps` | object[] | Yes | — | Ordered pipeline steps (2-20) |
| `steps[].prompt` | string | Yes | — | Task prompt for this step |
| `steps[].priority` | string | No | inherited | Priority override |
| `steps[].workingDirectory` | string | No | inherited | Working directory override |
| `steps[].agent` | string | No | inherited | Agent override |
| `steps[].model` | string | No | inherited | Model override for this step |
| `steps[].systemPrompt` | string | No | inherited | System prompt override for this step |
| `scheduleType` | string | Yes | — | "cron" or "one_time" |
| `cronExpression` | string | Cond. | — | 5-field cron expression |
| `scheduledAt` | string | Cond. | — | ISO 8601 datetime |
| `timezone` | string | No | UTC | IANA timezone |
| `missedRunPolicy` | string | No | skip | skip, catchup, or fail |
| `priority` | string | No | P2 | Default priority |
| `workingDirectory` | string | No | — | Default working directory |
| `maxRuns` | number | No | — | Max cron executions |
| `expiresAt` | string | No | — | ISO 8601 expiry |
| `afterSchedule` | string | No | — | Chain after schedule ID |
| `agent` | string | No | configured default | Default agent |
| `model` | string | No | — | Default model for all steps (steps can override) |
| `systemPrompt` | string | No | — | Default system prompt for all steps (steps can override) |

### CreateLoop

Create an iterative loop.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `prompt` | string | No* | — | Task prompt per iteration |
| `strategy` | string | Yes | — | "retry" or "optimize" |
| `exitCondition` | string | No | — | Shell command for eval (shell mode) |
| `evalMode` | string | No | shell | "shell" or "agent" |
| `evalPrompt` | string | No | — | Custom agent eval prompt (agent eval mode only) |
| `evalDirection` | string | No | — | "minimize" or "maximize" (optimize only) |
| `evalTimeout` | number | No | 60000 | Eval timeout ms (1000-600000) |
| `workingDirectory` | string | No | — | Working directory |
| `maxIterations` | number | No | 10 | Max iterations (0 = unlimited) |
| `maxConsecutiveFailures` | number | No | 3 | Max consecutive failures (0 = unlimited) |
| `cooldownMs` | number | No | 0 | Delay between iterations (ms) |
| `freshContext` | boolean | No | true | Fresh agent context per iteration |
| `pipelineSteps` | string[] | No | — | Pipeline step prompts (2-20, creates pipeline loop) |
| `priority` | string | No | P2 | Task priority |
| `agent` | string | No | configured default | Agent for iterations |
| `model` | string | No | — | Model override per iteration (overrides agent-config default) |
| `systemPrompt` | string | No | — | System prompt injected into each iteration task agent |
| `evalType` | string | No | feedforward | Agent eval sub-strategy: feedforward, judge, or schema (only when evalMode is agent) |
| `judgeAgent` | string | No | loop agent | Agent for judge decisions (judge evalType only) |
| `judgePrompt` | string | No | — | Custom judge instructions (judge evalType only) |
| `gitBranch` | string | No | — | Git branch for iteration tracking |

*`prompt` required unless `pipelineSteps` provided.

### LoopStatus

Get loop details.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `loopId` | string | Yes | — | Loop ID |
| `includeHistory` | boolean | No | false | Include iteration history |
| `historyLimit` | number | No | 20 | Max iterations to return |
| `includeSystemPrompt` | boolean | No | false | Include system prompt in response |

### ListLoops

List loops with optional filter.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `status` | string | No | — | running, paused, completed, failed, cancelled |
| `limit` | number | No | 20 | Max results (1-100) |

### CancelLoop

Cancel an active loop.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `loopId` | string | Yes | — | Loop ID |
| `reason` | string | No | — | Cancellation reason |
| `cancelTasks` | boolean | No | true | Cancel in-flight iteration tasks |

### PauseLoop

Pause an active loop.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `loopId` | string | Yes | — | Loop ID |
| `force` | boolean | No | false | Force pause (cancel current iteration) |

### ResumeLoop

Resume a paused loop.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `loopId` | string | Yes | — | Loop ID |

### ScheduleLoop

Schedule a recurring or one-time loop.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `prompt` | string | No | — | Task prompt per iteration |
| `strategy` | string | Yes | — | "retry" or "optimize" |
| `exitCondition` | string | No | — | Shell eval command |
| `evalMode` | string | No | shell | "shell" or "agent" |
| `evalPrompt` | string | No | — | Custom agent eval prompt |
| `evalDirection` | string | No | — | "minimize" or "maximize" |
| `evalTimeout` | number | No | — | Eval timeout ms (1000-600000) |
| `workingDirectory` | string | No | — | Working directory |
| `maxIterations` | number | No | — | Max iterations (0 = unlimited) |
| `maxConsecutiveFailures` | number | No | — | Max consecutive failures |
| `cooldownMs` | number | No | — | Delay between iterations |
| `freshContext` | boolean | No | — | Fresh context per iteration |
| `pipelineSteps` | string[] | No | — | Pipeline step prompts (2-20) |
| `gitBranch` | string | No | — | Git branch for tracking |
| `priority` | string | No | — | Task priority |
| `agent` | string | No | — | Agent for iterations |
| `model` | string | No | — | Model override per iteration |
| `systemPrompt` | string | No | — | System prompt injected into each iteration task agent (applied on every trigger) |
| `scheduleType` | string | Yes | — | "cron" or "one_time" |
| `cronExpression` | string | Cond. | — | 5-field cron expression |
| `scheduledAt` | string | Cond. | — | ISO 8601 datetime |
| `timezone` | string | No | UTC | IANA timezone |
| `missedRunPolicy` | string | No | skip | skip, catchup, or fail |
| `maxRuns` | number | No | — | Max cron loop runs |
| `expiresAt` | string | No | — | ISO 8601 expiry |

### CreateOrchestrator

Create and start an autonomous orchestration.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `goal` | string | Yes | — | High-level goal for the orchestrator |
| `workingDirectory` | string | No | — | Working directory for workers |
| `agent` | string | No | configured default | Agent for the orchestrator |
| `model` | string | No | — | Model override (overrides agent-config default) |
| `systemPrompt` | string | No | — | Custom system prompt (replaces auto-generated role instructions entirely) |
| `maxDepth` | number | No | 3 | Max delegation depth (1-10) |
| `maxWorkers` | number | No | 5 | Max concurrent workers (1-20) |
| `maxIterations` | number | No | 50 | Max orchestrator iterations (1-200) |

### OrchestratorStatus

Get orchestration status and details.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `orchestratorId` | string | Yes | — | Orchestrator ID |

### ListOrchestrators

List orchestration sessions.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `status` | string | No | — | planning, running, completed, failed, cancelled |
| `limit` | number | No | 50 | Max results (1-100) |
| `offset` | number | No | 0 | Skip first N results |

### CancelOrchestrator

Cancel an active orchestration.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `orchestratorId` | string | Yes | — | Orchestrator ID |
| `reason` | string | No | — | Cancellation reason |

### ListAgents

List available AI agents with registration and auth status. No parameters.

### ConfigureAgent

Check auth status, store API key, or reset stored key for an agent.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `agent` | string | Yes | — | Agent provider (claude, codex, gemini) |
| `action` | string | No | check | set, check, or reset |
| `apiKey` | string | No | — | API key to store (required for set action) |
| `baseUrl` | string | No | — | Base URL override (set action, e.g. https://proxy.example.com/v1) |
| `model` | string | No | — | Default model override for this agent (set action) |
| `proxy` | string | No | — | API proxy target (set action). Supported: "openai". Empty string clears. |
| `runtime` | string | No | — | Runtime to wrap agent spawns (set action). Supported: "ollama". Supported agents: claude, codex. Mutually exclusive with proxy — runtime takes precedence. Empty string clears. |

### InitCustomOrchestrator

Scaffold building blocks for a custom orchestrator (state file, exit script, instruction snippets).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `goal` | string | Yes | — | High-level goal for the custom orchestrator |
| `workingDirectory` | string | No | server cwd | Working directory (absolute path) |
| `agent` | string | No | configured default | AI agent for delegation commands |
| `model` | string | No | — | Model for delegation commands |
| `maxWorkers` | number | No | 5 | Max concurrent workers (1-20) |
| `maxDepth` | number | No | 3 | Max delegation depth (1-10) |

Returns: `stateFilePath`, `exitConditionScript`, `suggestedExitCondition`, and instruction snippets (`delegation`, `stateManagement`, `constraints`).

### PipelineStatus

Get status of a pipeline entity.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `pipelineId` | string | Yes | — | Pipeline entity ID (pipeline-xxxx) |

### ListPipelines

List pipelines with optional status filter.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `status` | string | No | — | pending, running, completed, failed, cancelled |
| `limit` | number | No | 50 | Max results (1-100) |

### CancelPipeline

Cancel a pipeline and optionally its in-flight tasks.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `pipelineId` | string | Yes | — | Pipeline entity ID |
| `reason` | string | No | — | Cancellation reason |
| `cancelTasks` | boolean | No | true | Also cancel in-flight step tasks |

## CLI Commands

### Task Commands

```
beat run "<prompt>" [options]
  --agent, -a <name>       Agent (claude, codex, gemini)
  --model, -m <name>       Model override
  --system-prompt "..."    System prompt injected into agent
  --priority, -p <level>   P0, P1, P2
  --working-directory, -w  Absolute path
  --timeout <ms>           Task timeout
  --depends-on <id>        Task dependency (repeatable)
  --continue-from <id>     Receive checkpoint context

beat status [task-id]      Check status (all or specific)
beat logs <task-id>        Read task output
beat cancel <task-id> [reason]  Cancel with optional reason
beat resume <task-id> [--context "..."]  Resume from checkpoint
```

### Pipeline Commands

```
beat pipeline "<step1>" [--delay Nm "<step2>"]...
  --agent, -a <name>       Default agent
  --priority, -p <level>   Default priority
  --working-directory, -w  Default working directory
```

### Loop Commands

```
beat loop "<prompt>" --until "<cmd>" [options]           # Retry (shell)
beat loop "<prompt>" --eval "<cmd>" --minimize|maximize  # Optimize (shell)
beat loop "<prompt>" --eval-mode agent --strategy retry  # Retry (agent)
beat loop "<prompt>" --eval-mode agent --strategy optimize --maximize  # Optimize (agent)
beat loop --pipeline --step "..." --step "..." --until "<cmd>"  # Pipeline loop

Options:
  --agent, -a <name>       Agent for iterations
  --model, -m <name>       Model override per iteration
  --system-prompt "..."    System prompt injected into each iteration task agent
  --priority, -p <level>   Task priority
  --working-directory, -w  Working directory
  --max-iterations <n>     Max iterations (0 = unlimited)
  --max-failures <n>       Max consecutive failures
  --cooldown <ms>          Delay between iterations
  --eval-timeout <ms>      Eval timeout (min 1000)
  --checkpoint             Continue from previous (freshContext: false)
  --eval-prompt "..."      Custom agent eval prompt
  --git-branch <name>      Git branch for tracking

beat loop list [--status <status>]
beat loop status <loop-id> [--history] [--history-limit N]
beat loop cancel <loop-id> [--cancel-tasks] [reason]
beat loop pause <loop-id> [--force]
beat loop resume <loop-id>
```

### Schedule Commands

```
beat schedule create "<prompt>" [options]
  --cron "<expression>"    5-field cron
  --at "<ISO 8601>"        One-time execution
  --timezone <iana>        Timezone (default: UTC)
  --missed-run-policy <p>  skip, catchup, fail
  --max-runs <n>           Cron execution limit
  --expires-at "<ISO>"     Expiry datetime
  --after-schedule <id>    Chain after another schedule
  --pipeline               Enable pipeline mode
  --step "..."             Pipeline step (repeatable, requires --pipeline)
  --loop                   Enable loop mode
  --agent, -a <name>       Default agent
  --model, -m <name>       Model override
  --system-prompt "..."    System prompt injected on every scheduled run
  --priority, -p <level>   Default priority
  --working-directory, -w  Working directory

beat schedule list [--status <status>]
beat schedule status <id> [--history]
beat schedule pause <id>
beat schedule resume <id>
beat schedule cancel <id> [--cancel-tasks] [reason]
```

### Orchestration Commands

```
beat orchestrate "<goal>" [options]
  --agent, -a <name>       Agent for orchestrator
  --model, -m <name>       Model override
  --system-prompt "..."    Custom system prompt
  --working-directory, -w  Working directory
  --max-depth <n>          Max delegation depth (1-10)
  --max-workers <n>        Max concurrent workers (1-20)
  --max-iterations <n>     Max loop iterations (1-200)
  --foreground             Block and wait (Ctrl+C to cancel)

beat orchestrate status <id>
beat orchestrate list [--status <status>]
beat orchestrate cancel <id> [reason]

beat orchestrate init "<goal>" [options]
  --working-directory, -w  Working directory
  --agent, -a <name>       Agent for delegation
  --model, -m <name>       Model for delegation
  --max-depth <n>          Max delegation depth (1-10)
  --max-workers <n>        Max concurrent workers (1-20)
```

### Dashboard Commands

```
beat dashboard               Terminal dashboard TUI
beat dash                    Alias for dashboard
```

### List Commands

```
beat list [--status <status>]       List tasks
beat ls [--status <status>]         Alias for list
```

### Setup Commands

```
beat init                              Interactive setup
beat init --agent <name>               Non-interactive setup
beat init --install-skills             Install agent skills
beat init --skills-agents <agents>     Comma-separated agents to install skills for (e.g. claude,codex)
beat init --yes, -y                    Non-interactive: skip confirmations
beat agents list                       Show agents with status
beat agents check                      Check agent auth status
beat agents config set <agent> [options]  Set agent config values
beat agents config show <agent>           Show agent config
beat agents config reset <agent>          Reset agent config
beat agents refresh-base-prompt <agent>   Refresh Gemini base prompt

beat config show                   Show configuration
beat config set <key> <value>      Set configuration value
beat config reset [key]            Reset config (all or specific key)
beat config path                   Show config file path

beat help                              Show help
```
