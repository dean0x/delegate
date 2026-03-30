# Autobeat Features

This document lists all features that are **currently implemented and working** in Autobeat.

Last Updated: March 2026 (v1.0.0)

## ✅ Autonomous Orchestration (v1.0.0)

### Orchestrator Mode
- **Goal-Driven Execution**: Give the orchestrator a goal and it autonomously breaks it into subtasks, delegates to worker agents, monitors progress, and iterates until done
- **Meta-Agent Architecture**: The orchestrator is a loop running a lead agent whose prompt gives it access to all of Autobeat's CLI commands (`beat run`, `beat status`, `beat loop`, etc.)
- **Persistent State File**: JSON state file in `~/.autobeat/orchestrator-state/` with plan, step statuses, iteration count, and agent context. Atomic writes (temp + rename) prevent corruption
- **Crash Recovery**: Orchestrations persisted in SQLite. Recovery manager detects and resumes interrupted orchestrations on startup
- **Multi-Agent**: Per-orchestration agent selection (Claude, Codex, Gemini)

### MCP Tools
- **CreateOrchestrator**: Create and start an orchestration with goal, guardrails, and agent selection
- **OrchestratorStatus**: Get orchestration details including plan steps and state
- **ListOrchestrators**: List orchestrations with status filter and pagination
- **CancelOrchestrator**: Cancel an active orchestration with optional reason

### CLI Commands
- `beat orchestrate "<goal>"`: Create and run an orchestration (detached by default)
- `beat orchestrate "<goal>" --foreground`: Block and wait for completion (Ctrl+C to cancel)
- `beat orchestrate status <id>`: Check orchestration status and plan progress
- `beat orchestrate list [--status <status>]`: List orchestrations with optional status filter
- `beat orchestrate cancel <id> [reason]`: Cancel an active orchestration

### Guardrails
- **Max Depth** (1-10, default 3): Maximum delegation depth
- **Max Workers** (1-20, default 5): Maximum concurrent worker agents
- **Max Iterations** (1-200, default 50): Maximum orchestrator loop iterations
- **Goal Length**: 1-8,000 characters with Zod validation

### Event-Driven Integration
- **OrchestrationCreated**: Emitted when a new orchestration is created
- **OrchestrationCompleted**: Emitted when the orchestration goal is achieved
- **OrchestrationCancelled**: Emitted when an orchestration is cancelled

### Database Schema
- **Migration 14**: `orchestrations` table with goal, status, guardrail columns, loop FK, and indexes on status and loop_id

## ✅ Core Task Delegation

### MCP Tools
- **DelegateTask**: Submit tasks to background AI agent instances
- **TaskStatus**: Check status of running/completed tasks
- **TaskLogs**: Retrieve stdout/stderr output from tasks (with tail option)
- **CancelTask**: Cancel running tasks with optional reason
- **RetryTask**: Retry a failed or completed task (creates new task with same prompt)

### Task Management
- **Priority Levels**: P0 (Critical), P1 (High), P2 (Normal)
- **Task Status Tracking**: QUEUED, RUNNING, COMPLETED, FAILED, CANCELLED
- **Per-Task Configuration**: Custom timeout and output buffer per task
- **Working Directory Support**: Run tasks in specific directories
- **Retry Logic**: Exponential backoff for operations

## ✅ Autoscaling & Resource Management

### Dynamic Worker Pool
- **Automatic Scaling**: Spawns workers based on CPU and memory availability
- **Resource Monitoring**: Real-time CPU and memory usage tracking
- **Intelligent Limits**: Maintains 20% CPU headroom and 1GB RAM reserve
- **No Artificial Limits**: Uses all available system resources

### Resource Protection
- **CPU Threshold**: Configurable CPU usage limit (default: 80%)
- **Memory Reserve**: Configurable memory reserve (default: 1GB)
- **Worker Lifecycle**: Automatic cleanup on completion/failure
- **Resource Tracking**: Per-worker CPU and memory monitoring

### Settling Workers Tracking (v0.3.1+)
- **Problem Solved**: Load average is a 1-minute rolling average that doesn't reflect recent spawns
- **Settling Window**: Recently spawned workers are tracked for 15 seconds (configurable via `WORKER_SETTLING_WINDOW_MS`)
- **Resource Projection**: Includes settling workers in resource calculations to prevent spawn burst overload
- **Spawn Delay**: Minimum 10 seconds between spawns for stability (configurable via `WORKER_MIN_SPAWN_DELAY_MS`)

## ✅ Task Persistence & Recovery

### Database Storage
- **SQLite Backend**: Persistent task storage with WAL mode
- **Complete Task History**: All tasks, outputs, and metadata stored
- **Automatic Recovery**: Restores QUEUED/RUNNING tasks on startup
- **Database Cleanup**: Automatic removal of old completed tasks (7 days)

### Crash Recovery
- **State Recovery**: Resumes interrupted tasks after crashes
- **Duplicate Prevention**: Prevents re-queuing already processed tasks
- **Status Reconciliation**: Marks crashed RUNNING tasks as FAILED

## ✅ Output Management

### Buffered Output Capture
- **Memory Buffering**: In-memory capture up to configurable limit (default: 10MB)
- **File Overflow**: Automatic file storage when buffer exceeded
- **Stream Processing**: Real-time stdout/stderr capture
- **Output Repository**: Persistent storage of all task output

### Configurable Limits
- **Per-Task Buffer Size**: Override buffer limit per task (1KB - 1GB)
- **Global Defaults**: System-wide output buffer configuration
- **Automatic Cleanup**: Old output files removed with tasks

## ✅ Configuration System

### Environment Variables
- `TASK_TIMEOUT`: Default task timeout (default: 1800000ms = 30min)
- `MAX_OUTPUT_BUFFER`: Default output buffer size (default: 10MB)
- `CPU_THRESHOLD`: CPU usage threshold (default: 80%)
- `MEMORY_RESERVE`: Memory reserve in bytes (default: 1GB)
- `LOG_LEVEL`: Logging verbosity (debug/info/warn/error)

### Runtime Configuration
- **Validation**: Zod schema validation with fallbacks
- **Range Checking**: Min/max limits for all numeric values
- **Graceful Degradation**: Falls back to defaults on invalid config

## ✅ Process Management

### Agent Process Management
- **CLI Spawning**: Spawns agent processes (`claude`, `codex`, `gemini`) with proper arguments
- **Permission Handling**: Agent-specific permission flags (e.g., `--dangerously-skip-permissions` for Claude)
- **Working Directory**: Supports custom working directories
- **Process Monitoring**: Tracks PIDs, exit codes, and resource usage

### Task Execution
- **Timeout Enforcement**: Configurable per-task timeouts (1s - 24h)
- **Graceful Termination**: SIGTERM then SIGKILL for task cancellation
- **Exit Code Tracking**: Captures and stores process exit codes
- **Error Handling**: Distinguishes timeout vs failure vs cancellation

## ✅ Logging & Monitoring

### Structured Logging
- **JSON Logs**: Production structured logging with context
- **Console Logs**: Development-friendly console output
- **Log Levels**: Configurable verbosity (debug/info/warn/error)
- **Context Enrichment**: Automatic context addition per module

### Monitoring
- **System Resources**: Real-time CPU/memory monitoring
- **Task Metrics**: Creation, start, completion timestamps
- **Worker Tracking**: Active worker count and resource usage
- **Error Tracking**: Structured error logging with context

## ✅ CLI Interface

### MCP Server Commands
- `beat mcp start`: Start the MCP server
- `beat mcp test`: Test server startup and validation
- `beat mcp config`: Show MCP configuration examples
- `beat help`: Show help and usage

### Direct Task Commands (v0.2.1+)
- `beat run <prompt>`: Delegate task directly to a background agent instance
- `beat status [task-id]`: Check status of all tasks or specific task
- `beat logs <task-id>`: Retrieve task output and logs
- `beat cancel <task-id> [reason]`: Cancel running task with optional reason

### Schedule Commands (v0.4.0+)
- `beat schedule create <prompt> [options]`: Create a cron or one-time scheduled task
- `beat schedule list [--status <status>]`: List schedules with optional status filter
- `beat schedule status <id> [--history]`: Get schedule details and execution history
- `beat schedule pause <id>`: Pause an active schedule
- `beat schedule resume <id>`: Resume a paused schedule
- `beat schedule cancel <id> [reason]`: Cancel a schedule with optional reason

### Pipeline Commands (v0.4.0+)
- `beat pipeline <prompt> [--delay Nm <prompt>]...`: Create chained one-time schedules with delays

### Task Resumption Commands (v0.4.0+)
- `beat resume <task-id>`: Resume a failed/completed task from its checkpoint
- `beat resume <task-id> --context "..."`: Resume with additional instructions

### Configuration Examples
- **NPM Package**: Global installation support
- **Local Development**: Source code execution
- **Claude Desktop**: MCP server configuration
- **Environment Variables**: Runtime configuration options

## ✅ Architecture

### Core Components
- **MCP Adapter**: JSON-RPC 2.0 protocol implementation
- **Task Manager**: Orchestrates task lifecycle
- **Recovery Manager**: Startup task recovery with dependency-aware crash detection
- **Resource Monitor**: System resource tracking
- **ReadOnlyContext**: Lightweight bootstrap for CLI query commands (~200-400ms faster)

### Design Patterns (v0.6.0 Hybrid Event Model)
- **Hybrid Event-Driven Architecture**: Commands (state changes) flow through EventBus; queries use direct repository access
- **Event Handlers**: Specialized handlers (Persistence, Queue, Worker, Dependency, Schedule, Checkpoint, Loop, Orchestration)
- **Singleton EventBus**: Shared event bus across all system components (34 events)
- **Dependency Injection**: Container-based DI with Result types
- **Result Pattern**: No exceptions in business logic
- **Immutable Domain**: Readonly data structures
- **Database-First Pattern**: Single source of truth with no memory-database divergence
- **SQLite Worker Coordination**: `workers` table with PID-based crash detection for cross-process visibility
- **Atomic Transactions**: `runInTransaction` for multi-step DB operations with rollback
- **Proper Process Handling**: Fixed stdin management (`stdio: ['ignore', 'pipe', 'pipe']`)

## ✅ Task Dependencies (v0.3.0)

### DAG-Based Dependency Management
- **Dependency Declaration**: Tasks can depend on other tasks via `dependsOn` array in task specification
- **Cycle Detection**: DFS-based algorithm prevents circular dependencies (A→B→A patterns)
- **Transitive Cycle Detection**: Detects complex cycles across multiple tasks (A→B→C→A)
- **Automatic Resolution**: Dependencies automatically resolved on task completion/failure/cancellation
- **Blocked Task Management**: Tasks with unmet dependencies remain in BLOCKED state until resolved
- **Multiple Dependencies**: Tasks can depend on multiple prerequisite tasks simultaneously
- **Diamond Patterns**: Supports complex dependency graphs (A→B, A→C, B→D, C→D)

### Database Schema
- **Foreign Key Constraints**: Database-enforced referential integrity
- **Resolution Tracking**: Automatic resolution timestamp on dependency completion
- **Atomic Transactions**: TOCTOU-safe dependency addition with synchronous better-sqlite3 transactions
- **Composite Indexes**: Optimized queries for dependency lookups and blocked task checks

### Session Continuation (v0.4.0)
- **`continueFrom` Field**: Dependent tasks can specify a dependency whose checkpoint context is injected into their prompt
- **Automatic Enrichment**: When the dependency completes, its output summary, git state, and errors are prepended to the dependent task's prompt
- **Race-Safe**: Subscribe-first pattern with 5-second timeout ensures checkpoint is available before task runs
- **Validation**: `continueFrom` must reference a task in the `dependsOn` list (auto-added if missing)
- **Chain Support**: A→B→C where B receives A's context and C receives B's (which includes A's)

### Event-Driven Integration
- **TaskDependencyAdded**: Emitted when new dependency relationship created
- **DependencyResolved**: Emitted when blocking dependency completes
- **TaskUnblocked**: Emitted when all dependencies resolved, triggers automatic queuing

## ✅ Task Scheduling (v0.4.0)

### MCP Tools
- **ScheduleTask**: Create recurring (cron) or one-time scheduled tasks
- **ListSchedules**: List all schedules with optional status filter and pagination
- **ScheduleStatus**: Get schedule details including execution history
- **CancelSchedule**: Cancel an active schedule with optional reason
- **PauseSchedule**: Pause an active schedule (can be resumed later)
- **ResumeSchedule**: Resume a paused schedule
- **CreatePipeline** (v0.4.1): Create sequential task pipelines with 2–20 steps, per-step delays, priority, and working directory overrides
- **SchedulePipeline** (v0.6.0): Create recurring or one-time scheduled pipelines with 2–20 steps, each trigger creates a fresh pipeline instance with linear task dependencies

### Schedule Types
- **CRON**: Standard 5-field cron expressions for recurring task execution
- **ONE_TIME**: ISO 8601 datetime for single future execution

### Configuration
- **Timezone Support**: IANA timezone identifiers (e.g., `America/New_York`) with DST awareness
- **Missed Run Policies**: `skip` (ignore missed runs), `catchup` (execute missed runs), `fail` (mark as failed)
- **Max Runs**: Optional limit on number of executions for cron schedules
- **Expiration**: Optional ISO 8601 expiry datetime for schedules

### Concurrent Execution Prevention
- **Lock-Based Protection**: Prevents overlapping executions of the same schedule
- **Execution Tracking**: Full history of schedule executions with status and timing

### Event-Driven Integration
- **ScheduleCreated**: Emitted when a new schedule is created
- **ScheduleCancelled**: Emitted when a schedule is cancelled
- **SchedulePaused**: Emitted when a schedule is paused
- **ScheduleResumed**: Emitted when a schedule is resumed
- **ScheduleExecuted**: Emitted when a scheduled task is triggered

## ✅ Task Resumption (v0.4.0)

### Auto-Checkpoints
- **Automatic Capture**: Checkpoints created on task completion or failure (via `CheckpointHandler`)
- **Git State**: Branch name, commit SHA, and dirty file list recorded at checkpoint time
- **Output Summary**: Last 50 lines of stdout/stderr preserved for context injection
- **Database Persistence**: `task_checkpoints` table (migration v5) with full audit data

### Resume Workflow
- **Enriched Prompts**: Resumed tasks receive full checkpoint context (previous output, git state, error info)
- **Additional Context**: Provide extra instructions when resuming to guide the retry
- **Retry Chains**: Track resume lineage via `parentTaskId` and `retryOf` fields on the new task
- **Terminal State Requirement**: Only tasks in completed, failed, or cancelled states can be resumed

### MCP Tool
- **ResumeTask**: Resume a terminal task with optional `additionalContext` string (max 4000 chars)

### Event-Driven Integration
- **TaskCompleted / TaskFailed**: Triggers automatic checkpoint capture via `CheckpointHandler`
- **CheckpointRepository**: SQLite persistence with prepared statements and Zod boundary validation

## ✅ Multi-Agent Support (v0.5.0)

### Agent Registry
- **Pluggable Adapters**: Agent registry with adapter pattern for agent lifecycle management
- **Built-in Agents**: Claude (`claude`), OpenAI Codex (`codex`), Google Gemini (`gemini-cli`)
- **Per-Task Selection**: Choose which agent runs each task via MCP `agent` field or CLI `--agent` flag
- **Default Agent**: System-wide default agent configured via `beat init` or `~/.autobeat/config.json`
- **Auth Checking**: Verify agent CLI tools are installed and authenticated before delegation

### CLI Commands
- `beat init`: Interactive first-time setup — select default agent, validates availability
- `beat init --agent <name>`: Non-interactive setup with specified agent
- `beat agents list`: Show registered agents with default marker and auth status

### MCP Integration
- **`agent` field on DelegateTask**: Specify agent per task (e.g., `{ agent: "codex" }`)
- **Fallback**: Uses default agent when no agent specified

## ✅ Scheduled Pipelines (v0.6.0)

### Recurring & One-Time Pipelines
- **SchedulePipeline MCP Tool**: Create a single schedule that triggers a full pipeline (2–20 steps) on each execution
- **Cron + One-Time**: Supports both recurring cron expressions and single future execution
- **Linear Dependencies**: Each trigger creates fresh tasks wired with linear dependencies (step N depends on step N-1)
- **Per-Step Configuration**: Each step can have its own prompt, priority, working directory, and agent override (MCP only)
- **Shared Defaults**: Schedule-level agent, priority, and working directory apply to all steps unless overridden

### Pipeline Lifecycle
- **Dependency Failure Cascade**: When a pipeline step fails, all downstream steps are automatically cancelled
- **Cancel with Tasks**: `CancelSchedule` with `cancelTasks: true` cancels in-flight pipeline tasks from current execution
- **Concurrency Tracking**: Pipeline completion tracked via tail task — prevents overlapping pipeline executions
- **`afterScheduleId` Support**: Chain pipelines after other schedules (predecessor dependency injected on step 0)

### CLI Support
- `beat schedule create --pipeline --step "lint" --step "test" --cron "0 9 * * *"`: Create scheduled pipeline
- `beat schedule cancel <id> --cancel-tasks`: Cancel schedule and in-flight tasks

### Bug Fixes (v0.6.0)
- **Dependency Failure Cascade**: Failed/cancelled upstream tasks now cascade cancellation to dependents (was incorrectly unblocking them)
- **Queue Handler Race Condition**: Fast-path check prevents blocked tasks from being prematurely enqueued

## ✅ Task/Pipeline Loops (v0.7.0)

### MCP Tools
- **CreateLoop**: Create an iterative loop that runs a task repeatedly until an exit condition is met (retry or optimize strategy)
- **LoopStatus**: Get loop details including optional iteration history
- **ListLoops**: List loops with optional status filter and pagination
- **CancelLoop**: Cancel an active loop, optionally cancelling in-flight iteration tasks
- **PauseLoop** (v0.8.0): Pause an active loop mid-iteration
- **ResumeLoop** (v0.8.0): Resume a paused loop from last checkpoint
- **ScheduleLoop** (v0.8.0): Compose loops with cron/one-time schedules

### Loop Strategies
- **Retry**: Run a task until an exit condition passes — shell command returning exit code 0 ends the loop
- **Optimize**: Run a task, score output with eval script, keep improvements — seek the best score across iterations (minimize or maximize direction)
- **Agent Eval Mode**: Either strategy can delegate exit condition evaluation to an AI agent instead of a shell command. Pass `evalMode: 'agent'` (MCP) or `--eval-mode agent` (CLI). The agent reads iteration output and returns pass/fail (retry) or a numeric score (optimize). Use `evalPrompt` / `--eval-prompt` to customize the evaluation prompt.

### Single Task Loops
- **Task Prompt**: Each iteration runs the same prompt (or enriched with checkpoint context if `freshContext` is false)
- **Exit Condition**: Shell command evaluated after each iteration to determine pass/fail or score

### Pipeline Loops
- **Multi-Step Iterations**: Repeat a full pipeline (2–20 steps) per iteration instead of a single task
- **Linear Dependencies**: Each pipeline step depends on the previous step within the iteration
- **Same Exit Condition**: Evaluated after all pipeline steps complete

### Configuration
- **Max Iterations**: Safety cap on iteration count (0 = unlimited, default: 10)
- **Max Consecutive Failures**: Stop after N consecutive failures (default: 3)
- **Cooldown**: Delay between iterations in milliseconds (default: 0)
- **Eval Timeout**: Timeout for exit condition evaluation (default: 60s, minimum: 1s)
- **Fresh Context**: Each iteration gets a fresh agent context (default: true) or continues from previous checkpoint
- **Eval Mode** (`evalMode`): `'shell'` (default) evaluates iteration results via a shell command exit code; `'agent'` delegates evaluation to an AI agent
- **Eval Prompt** (`evalPrompt`): Optional custom instructions for the agent evaluator (agent mode only). When omitted, the agent uses a default review prompt.

### CLI Commands (v0.7.0+)
- `beat loop <prompt> --until <cmd>`: Create a retry loop (run until shell command exits 0)
- `beat loop <prompt> --eval <cmd> --minimize|--maximize`: Create an optimize loop (score-based)
- `beat loop <prompt> --eval-mode agent --strategy retry`: Create a retry loop using agent evaluation
- `beat loop <prompt> --eval-mode agent --strategy optimize --maximize [--eval-prompt "..."]`: Create an optimize loop with agent scoring
- `beat loop --pipeline --step "..." --step "..." --until <cmd>`: Create a pipeline loop
- `beat loop list [--status <status>]`: List loops with optional status filter
- `beat loop status <loop-id> [--history]`: Get loop details and iteration history
- `beat loop cancel <loop-id> [--cancel-tasks] [reason]`: Cancel a loop with optional task cancellation
- `beat loop pause <loop-id>` (v0.8.0): Pause an active loop
- `beat loop resume <loop-id>` (v0.8.0): Resume a paused loop

### Event-Driven Integration
- **LoopCreated**: Emitted when a new loop is created
- **LoopIterationCompleted**: Emitted when an iteration finishes with its result (pass/fail/keep/discard/crash)
- **LoopCompleted**: Emitted when the loop reaches its exit condition or max iterations
- **LoopCancelled**: Emitted when a loop is cancelled

### Database Schema
- **Migration 10**: `loops` table for loop definitions and state, `loop_iterations` table for per-iteration execution records
- **Migration 15**: `eval_mode` and `eval_prompt` columns on `loops` table, `eval_feedback` column on `loop_iterations` table

## ❌ NOT Implemented
- **Distributed Processing**: Single-server only
- **Web UI**: No dashboard interface
- **Workflow Templates**: No preset YAML/JSON workflow specifications (post-v1 roadmap item)
- **Multi-User Support**: Single-user focused
- **REST API**: MCP protocol only

---

---

## 🆕 What's New in v1.0.0

### Orchestrator Mode
- **Autonomous Goal Execution**: Meta-agent that uses Autobeat's own infrastructure to break down goals, delegate to workers, monitor progress, and iterate until done
- **4 CLI Commands**: `beat orchestrate`, `beat orchestrate status`, `beat orchestrate list`, `beat orchestrate cancel`
- **4 MCP Tools**: `CreateOrchestrator`, `OrchestratorStatus`, `ListOrchestrators`, `CancelOrchestrator`
- **Persistent State File**: Atomic JSON state file with plan, steps, and agent context
- **Guardrails**: `maxDepth` (3), `maxWorkers` (5), `maxIterations` (50) with configurable limits
- **Crash Recovery**: SQLite persistence with startup recovery for interrupted orchestrations

### Events
- 3 new events (34 total): `OrchestrationCreated`, `OrchestrationCompleted`, `OrchestrationCancelled`

### Database
- **Migration 14**: `orchestrations` table with goal, status, guardrails, loop FK, and indexes

---

## 🆕 What's New in v0.8.0 / v0.8.1

### Loop Pause/Resume (v0.8.0)
- **PauseLoop / ResumeLoop MCP Tools**: Pause active loops mid-iteration, resume from last checkpoint
- **CLI Commands**: `beat loop pause <id>`, `beat loop resume <id>`
- **Persistence**: Paused state survives server restarts

### Scheduled Loops (v0.8.0)
- **ScheduleLoop MCP Tool**: Compose loops with cron/one-time schedules — each trigger creates a new loop instance
- **CLI**: `beat schedule create --loop` for creating scheduled loops

### Git Integration (v0.8.0, corrected in v0.8.1)
- **`--git-branch` flag**: Optional git-aware loop iteration tracking
- **Commit-per-iteration**: One branch for the entire loop, one commit per successful iteration (v0.8.1 fix)
- **Revert on failure**: Failed/discarded iterations fully reverted to appropriate target commit
- **Diff summaries**: Git diffs tracked between iterations

### Performance (v0.8.1)
- **O(1) reset target lookup**: `getResetTargetSha()` reads cached `bestIterationCommitSha` directly from the Loop domain instead of scanning iterations from the database

### Events
- **2 new events** (31 total): `LoopPaused`, `LoopResumed`

### Database
- **Migration 11**: `loop_pause_state` column, `schedule_id` FK on loops table, git config storage
- **Migration 12**: `git_start_commit_sha` on loops, `git_commit_sha` and `pre_iteration_commit_sha` on loop_iterations
- **Migration 13**: `best_iteration_commit_sha` on loops for O(1) reset target lookup

### CLI
- `beat loop pause <id>`: Pause an active loop
- `beat loop resume <id>`: Resume a paused loop
- Backward-compat fallbacks for v0.8.0 data

---

## 🆕 What's New in v0.7.0

### Task/Pipeline Loops
- **`CreateLoop` MCP Tool**: Create retry or optimize loops for single tasks or pipelines (2–20 steps)
- **Retry Strategy**: Run a task until an exit condition shell command returns exit code 0
- **Optimize Strategy**: Score iterations with an eval script, keep improvements (minimize or maximize)
- **Pipeline Loops**: Repeat a multi-step pipeline per iteration with linear task dependencies
- **Fresh Context**: Each iteration gets a clean agent context by default, or continues from previous checkpoint
- **Safety Controls**: Max iterations (0 = unlimited), max consecutive failures, cooldown between iterations
- **Configurable Eval Timeout**: Exit condition evaluation timeout (default: 60s)
- **CLI**: `beat loop`, `beat loop list`, `beat loop status`, `beat loop cancel` commands
- **4 MCP Tools**: `CreateLoop`, `LoopStatus`, `ListLoops`, `CancelLoop`

### Event System
- **4 New Events**: `LoopCreated`, `LoopIterationCompleted`, `LoopCompleted`, `LoopCancelled`
- **Loop Handler**: Event-driven iteration engine manages loop lifecycle

### Database
- **Migration 10**: `loops` and `loop_iterations` tables

---

## 🆕 What's New in v0.6.0

### Scheduled Pipelines
- **`SchedulePipeline` MCP Tool**: Create cron or one-time schedules that trigger a full pipeline (2–20 steps) on each execution
- **Linear Task Dependencies**: Each trigger creates fresh tasks with `task[i].dependsOn = [task[i-1].id]`
- **Per-Step Agent Override**: MCP tool supports per-step `agent` field; CLI uses shared `--agent`
- **`cancelTasks` on CancelSchedule**: Optional flag to also cancel in-flight pipeline tasks from current execution
- **ListSchedules Enhancement**: Response includes `isPipeline` and `stepCount` indicators
- **ScheduleStatus Enhancement**: Response includes full `pipelineSteps` when present
- **CLI**: `--pipeline --step "..." --step "..."` flags for creating scheduled pipelines

### Architectural Simplification
- **Event System Simplification** (#91): 18 overhead events removed, 3 services removed (QueryHandler, OutputHandler, AutoscalingManager). Query operations use direct repository calls instead of events. EventBus reduced from 42 to 25 events.
- **SQLite Worker Coordination** (#94): New `workers` table with PID-based crash detection. Cross-process output visibility via persistent output storage. `WorkerRepository` and `OutputRepository` now required in constructors.
- **ReadOnlyContext** (#100): Lightweight bootstrap for CLI query commands (`status`, `list`, `logs`). Skips EventBus, worker pool, and schedule executor initialization. ~200-400ms faster startup.
- **Atomic Transactions** (#85): `runInTransaction` for atomic multi-step DB operations. Synchronous schedule operations with partial failure rollback.

### Bug Fixes
- **Dependency Failure Cascade**: When upstream task fails or is cancelled, dependent tasks are now cancelled instead of incorrectly unblocked (**breaking change**)
- **Queue Handler Race Condition**: Fast-path `dependencyState` check prevents blocked tasks from being enqueued before dependency rows are written to DB
- **RecoveryManager Dependency Checks** (#84): Crash recovery now validates dependency state before re-queuing tasks
- **CancelSchedule Scope** (#82): `cancelTasks` now cancels tasks from ALL active executions, not just the latest
- **Output totalSize** (#95): `totalSize` recalculated after tail-slicing via shared `linesByteSize` utility
- **FAIL Policy Atomicity** (#83): ScheduleExecutor FAIL policy wrapped in transaction — atomic cancel+audit, event emission after transaction commits

### Tech Debt / Refactoring
- **OutputRepository DIP Compliance** (#101): Interface moved from implementations to `core/interfaces.ts`
- **BootstrapMode Enum** (#104): Boolean flags (`isCli`, `isRun`, `isReadOnly`) replaced with `mode: BootstrapMode` (`'server'` | `'cli'` | `'run'`)
- **Multi-Provider Branding** (#86): Neutralize Claude-specific branding for multi-provider positioning

### Breaking Changes
- **Dependency Failure Cascade**: Failed/cancelled upstream tasks cascade cancellation to dependents (was incorrectly unblocking)
- **Constructor Changes**: `WorkerRepository` and `OutputRepository` now required in constructors (#94)
- **Event System**: EventBus reduced from 42 to 25 events; query operations use direct calls (#91)
- **BootstrapOptions**: Drops boolean flags, adds `mode: BootstrapMode` (#104)

### Database
- **Migration 8**: `pipeline_steps` column on `schedules` table, `pipeline_task_ids` column on `schedule_executions` table
- **Migration 9**: `workers` table for cross-process worker tracking (#94)

---

## 🆕 What's New in v0.5.0

### Multi-Agent Support
- **Agent Registry**: Pluggable adapters for Claude, Codex, and Gemini with per-task agent selection
- **`beat init`**: Interactive first-time setup wizard for selecting default agent
- **`beat agents list`**: Show registered agents with default marker and auth status
- **Auth Checking**: Validates agent CLI availability before task delegation
- **MCP + CLI Parity**: `agent` field on `DelegateTask` tool, `--agent` flag on `beat run`

### Test Coverage
- **54 new tests**: Handler unit tests (21), final coverage gaps (33)
- **Stale cleanup**: Removed 3 `it.skip` tests for unimplemented threshold events

---

## 🆕 What's New in v0.4.1

### CreatePipeline MCP Tool
- **Pipeline Creation via MCP**: New `CreatePipeline` tool closes the last CLI/MCP feature parity gap
- **2–20 Steps**: Sequential task pipelines with per-step delays, priority, and working directory overrides
- **Shared Service**: Both MCP and CLI use `ScheduleManagerService.createPipeline()` — identical behavior

---

## 🆕 What's New in v0.4.0

### Task Scheduling
- **Cron & One-Time Schedules**: Standard 5-field cron expressions and ISO 8601 one-time scheduling
- **Timezone Support**: IANA timezone identifiers with DST awareness
- **Missed Run Policies**: `skip`, `catchup`, or `fail` for overdue triggers
- **Lifecycle Management**: Pause, resume, cancel schedules with full execution history
- **Concurrent Execution Prevention**: Lock-based protection against overlapping runs
- **6 MCP Tools**: `ScheduleTask`, `ListSchedules`, `ScheduleStatus`, `CancelSchedule`, `PauseSchedule`, `ResumeSchedule`
- **CLI + Pipeline**: Full CLI parity including `beat pipeline` command for chained one-time schedules

### Task Resumption
- **Auto-Checkpoints**: Captured on task completion/failure with git state and output summary
- **Enriched Prompts**: Resumed tasks receive full context from previous attempt
- **Retry Chains**: Track resume lineage via `parentTaskId` and `retryOf` fields
- **MCP Tool**: `ResumeTask` with optional additional context
- **CLI**: `beat resume <task-id> [--context "..."]`

### Session Continuation (`continueFrom`)
- **Dependency Context Injection**: Dependent tasks receive checkpoint context from a specified dependency
- **`continueFrom` Field**: Added to `DelegateTask` MCP tool and `beat run --continue-from` CLI flag
- **Automatic Enrichment**: Output summary, git state, and errors prepended to task prompt
- **Race-Safe Design**: Subscribe-first pattern ensures checkpoint availability before task execution
- **Chain Support**: Context flows through A→B→C dependency chains

### Infrastructure
- **Schedule Service Extraction**: ~375 lines of business logic extracted from MCP adapter for CLI reuse
- **CLI Bootstrap Helper**: `withServices()` eliminates repeated bootstrap boilerplate
- **Database Migrations v3-v6**: `schedules`, `schedule_executions`, `task_checkpoints` tables, `continue_from` column
- **FK Cascade Fix**: Separated `save()` from `update()` to prevent cascade data loss

---

## 🆕 What's New in v0.2.1

### Event-Driven Architecture
- **Complete Rewrite**: Moved from direct method calls to event-based coordination
- **EventBus**: Central coordination hub for all system communication
- **Event Handlers**: Specialized handlers for different concerns (persistence, queue, workers, output)
- **Zero Direct State**: TaskManager is stateless, handlers manage all state via events

### Direct CLI Commands
- **Task Management**: Direct CLI interface without MCP connection required
- **Real-time Testing**: Instant task delegation and status checking
- **Better DX**: No need to reconnect MCP server for testing

### Process Handling Improvements
- **Fixed Output Capture**: Resolved Claude CLI hanging issues
- **Proper stdin**: Uses `stdio: ['ignore', 'pipe', 'pipe']` instead of hack
- **Robust Spawning**: Eliminated stdin injection workarounds

---

**Note**: This document reflects the actual implemented features. For planned features, see [ROADMAP.md](./ROADMAP.md).