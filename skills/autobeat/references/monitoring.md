# Monitoring Reference

Deep dive on status checking, state interpretation, recovery, and troubleshooting.

## Status Checking

### Check All Tasks

```json
{ "tool": "TaskStatus", "arguments": {} }
```

CLI: `beat status`

Returns all tasks with: id, status, priority, createdAt, startedAt, completedAt.

### Check Specific Task

```json
{ "tool": "TaskStatus", "arguments": { "taskId": "task-abc..." } }
```

CLI: `beat status task-abc...`

### Read Task Output

```json
{ "tool": "TaskLogs", "arguments": { "taskId": "task-abc...", "tail": 50 } }
```

CLI: `beat logs task-abc...`

- `tail`: number of recent lines (default: 100)
- Returns stdout and stderr combined
- Output persists even after task completion

### Check Loop Progress

```json
{ "tool": "LoopStatus", "arguments": { "loopId": "...", "includeHistory": true, "historyLimit": 10 } }
```

CLI: `beat loop status <loop-id> --history --history-limit 10`

Returns: loop state, current iteration, best score, consecutive failures, and iteration history.

### Check Orchestration

```json
{ "tool": "OrchestratorStatus", "arguments": { "orchestratorId": "..." } }
```

CLI: `beat orchestrate status <id>`

Returns: goal, status, guardrails, plan steps, iteration count.

### Check Pipeline

```json
{ "tool": "PipelineStatus", "arguments": { "pipelineId": "pipeline-xxxx" } }
```

Returns: pipeline state, step count, completed steps, failed step details.

### List Pipelines

```json
{ "tool": "ListPipelines", "arguments": { "status": "running", "limit": 20 } }
```

### Cancel Pipeline

```json
{ "tool": "CancelPipeline", "arguments": { "pipelineId": "pipeline-xxxx", "cancelTasks": true, "reason": "Superseded" } }
```

## Task States

| State | Meaning | Transitions To |
|-------|---------|---------------|
| `QUEUED` | Waiting for worker | RUNNING, CANCELLED |
| `BLOCKED` | Waiting for dependencies | QUEUED (auto), CANCELLED |
| `RUNNING` | Agent executing | COMPLETED, FAILED, CANCELLED |
| `COMPLETED` | Finished successfully | (terminal) |
| `FAILED` | Agent or process error | (terminal) |
| `CANCELLED` | Manually or cascade cancelled | (terminal) |

### Loop States

| State | Meaning |
|-------|---------|
| `running` | Actively iterating |
| `paused` | Manually paused, can resume |
| `completed` | Exit condition met |
| `failed` | Max failures or max iterations reached without success |
| `cancelled` | Manually cancelled |

### Orchestration States

| State | Meaning |
|-------|---------|
| `planning` | Orchestrator is analyzing the goal |
| `running` | Actively delegating and monitoring |
| `completed` | Goal achieved |
| `failed` | Could not achieve goal |
| `cancelled` | Manually cancelled |

### Schedule States

| State | Meaning |
|-------|---------|
| `active` | Executing on schedule |
| `paused` | Temporarily suspended |
| `completed` | maxRuns reached or expired |
| `cancelled` | Manually cancelled |
| `expired` | Past expiresAt datetime |

### Pipeline States

| State | Meaning |
|-------|---------|
| `pending` | Created, first step not yet started |
| `running` | At least one step executing |
| `completed` | All steps completed successfully |
| `failed` | A step failed, downstream steps cancelled |
| `cancelled` | Manually cancelled via CancelPipeline |

## Recovery Decision Tree

When a task or loop encounters issues, use this decision tree:

```
Task FAILED?
├── Was it a transient error (timeout, network)?
│   └── RetryTask — re-run from scratch
├── Was it close to done but hit an issue?
│   └── ResumeTask — continue from checkpoint with additional context
├── Was it fundamentally wrong approach?
│   └── CancelTask (if still running) → DelegateTask with new prompt
└── Was it a dependency that failed?
    └── Fix the dependency first, then the cascade will unblock

Loop FAILED?
├── Hit maxIterations without success?
│   └── Increase maxIterations or improve the prompt
├── Hit maxConsecutiveFailures?
│   └── Check task logs from recent iterations for root cause
├── Exit condition never passes?
│   └── Verify exitCondition command works manually
└── Agent eval always FAILs?
    └── Review evalPrompt — may be too strict or ambiguous
```

### Resume vs Retry

| Action | What It Does | When to Use |
|--------|-------------|-------------|
| `RetryTask` | Creates new task with same prompt, fresh start | Transient failures, timeouts |
| `ResumeTask` | Creates new task with checkpoint context injected | Task was close, needs tweaks |

### Resume with Context

```json
{
  "tool": "ResumeTask",
  "arguments": {
    "taskId": "task-abc...",
    "additionalContext": "The previous attempt failed because the migration file had a syntax error on line 42. Fix that specific line."
  }
}
```

The resumed task receives:
- Previous output summary (last 50 lines)
- Git state (branch, commit, dirty files)
- Error messages from the failed attempt
- Your additional context

## Monitoring Workflow

### For Single Tasks

1. Delegate: `DelegateTask` → save taskId
2. Wait appropriate time (depends on task complexity)
3. Check: `TaskStatus` with taskId
4. If COMPLETED: `TaskLogs` to read output
5. If FAILED: `TaskLogs` to diagnose → RetryTask or ResumeTask
6. If RUNNING too long: consider CancelTask with reason

### For Loops

1. Create: `CreateLoop` → save loopId
2. Periodically check: `LoopStatus` with includeHistory
3. Watch: `currentIteration` progress, `consecutiveFailures`, `bestScore`
4. If stuck: `PauseLoop`, investigate, adjust prompt, `ResumeLoop`
5. If done: `LoopStatus` shows completed with final result

### For Orchestrations

1. Create: `CreateOrchestrator` → save orchestratorId
2. Check: `OrchestratorStatus` for plan and progress
3. The orchestrator manages its own tasks — you monitor the orchestration level
4. If stuck: `CancelOrchestrator` and try a different approach

### For Pipelines

1. Create: `CreatePipeline` → save pipelineId
2. Check: `PipelineStatus` for overall progress
3. If step failed: `TaskLogs` on the failed step's taskId
4. If stuck: `CancelPipeline` to abort and investigate

### Polling Cadence

- Simple tasks (< 5 min expected): check every 30s
- Complex tasks (5-30 min): check every 2-5 min
- Loops: check every iteration or every few minutes
- Orchestrations: check every 5-10 min (they manage their own tasks)
- **Never poll in a tight loop** — minimum 30s between status checks

## Bulk Operations

### List and Filter

```json
{ "tool": "TaskStatus", "arguments": {} }
{ "tool": "ListLoops", "arguments": { "status": "running" } }
{ "tool": "ListSchedules", "arguments": { "status": "active" } }
{ "tool": "ListOrchestrators", "arguments": { "status": "running", "limit": 10 } }
```

### Cancel Multiple

There's no bulk cancel tool. Cancel individually:

```json
{ "tool": "CancelTask", "arguments": { "taskId": "...", "reason": "Superseded by new approach" } }
{ "tool": "CancelLoop", "arguments": { "loopId": "...", "cancelTasks": true } }
{ "tool": "CancelOrchestrator", "arguments": { "orchestratorId": "...", "reason": "Goal revised" } }
```

## Troubleshooting

### Task Stays QUEUED

- **Cause**: No available workers (CPU/memory limits reached)
- **Check**: Are other tasks running? System resources available?
- **Fix**: Cancel lower-priority tasks, or wait for running tasks to complete

### Task Stays BLOCKED

- **Cause**: Dependencies haven't completed
- **Check**: `TaskStatus` on each dependency task
- **Fix**: If a dependency is stuck, investigate it. If a dependency failed, the cascade should cancel this task.

### Loop Never Completes

- **Cause**: Exit condition never passes
- **Check**: `LoopStatus` with `includeHistory: true` — look at iteration results
- **Fix**: Verify the exit condition command works manually. Check if the prompt gives the agent enough guidance.

### Agent Eval Always FAILs

- **Cause**: evalPrompt too strict or ambiguous
- **Check**: Look at `evalFeedback` in iteration history
- **Fix**: Revise evalPrompt to be clearer about pass/fail criteria

### Orchestration Stuck

- **Cause**: Orchestrator can't make progress
- **Check**: `OrchestratorStatus` — look at plan steps and which are blocked
- **Fix**: `CancelOrchestrator` and create a new one with a more specific goal or tighter guardrails

### Output Truncated

- **Cause**: Default output buffer is 10MB
- **Fix**: Set `maxOutputBuffer` on the task (max 1GB)

### Task Timeout

- **Cause**: Default timeout is 0 (disabled) — tasks run until completion or manual cancellation
- **Fix**: Set `timeout` on the task to enforce a limit (max 24 hours = 86400000ms)

### Pipeline Stuck in Pending

- **Cause**: First step hasn't started, no available workers
- **Check**: `PipelineStatus` to confirm step 0 status, check worker availability
- **Fix**: Cancel lower-priority tasks or wait for workers to free up

### Pipeline Step Failed

- **Cause**: A step task failed
- **Check**: `TaskLogs` on the failed step's taskId for error details
- **Fix**: Downstream steps are auto-cancelled. Fix the issue and create a new pipeline

### Dashboard

`beat dashboard` (or `beat dash`) provides a terminal TUI for visual monitoring of tasks, loops, orchestrations, and pipelines. Agents don't interact with the dashboard directly — use the MCP tools above.
