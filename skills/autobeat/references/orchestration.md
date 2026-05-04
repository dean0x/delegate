# Orchestration Reference

Deep dive on choosing primitives, composition patterns, and orchestrator configuration.

## Primitive Selection Matrix

| Scenario | Primitive | Rationale |
|----------|-----------|-----------|
| Run tests in a repo | Task | Single command, single output |
| Refactor a module | Task | Self-contained, one agent context |
| lint → test → build → deploy | Pipeline | Fixed sequence, failure cascades |
| Fix failing tests iteratively | Loop (retry) | Repeat until tests pass |
| Optimize perf score | Loop (optimize) | Score and improve each iteration |
| Migrate entire API framework | Orchestrator | Open-ended, requires planning |
| Nightly test suite | ScheduleTask | Recurring single task |
| Daily lint → test → deploy | SchedulePipeline | Recurring fixed sequence |
| Weekly code quality sweep | ScheduleLoop | Recurring iterative improvement |

## Single Tasks

The simplest primitive. Use for any self-contained work item.

### MCP

```json
{
  "tool": "DelegateTask",
  "arguments": {
    "prompt": "Run the test suite in /repo and report results",
    "workingDirectory": "/path/to/repo",
    "agent": "claude",
    "priority": "P2",
    "timeout": 300000
  }
}
```

### CLI

```bash
beat run "Run the test suite and report results" -w /path/to/repo --agent claude
```

### Key Parameters

- `prompt` (required): What the agent should do
- `workingDirectory`: Absolute path — always set this
- `agent`: claude | codex | gemini (falls back to configured default)
- `priority`: P0 (critical), P1 (high), P2 (normal, default)
- `timeout`: ms, default 0 (disabled), max 24h (86400000ms)
- `maxOutputBuffer`: bytes, default 10MB, max 1GB

## Pipelines

Fixed sequential workflows. Each step runs after the previous succeeds. Failure cancels downstream.

### MCP

```json
{
  "tool": "CreatePipeline",
  "arguments": {
    "steps": [
      { "prompt": "Run linter and fix all issues" },
      { "prompt": "Run test suite" },
      { "prompt": "Build production artifacts" }
    ],
    "workingDirectory": "/path/to/repo",
    "agent": "claude"
  }
}
```

### CLI

```bash
beat pipeline "Run linter" --delay 0m "Run tests" --delay 0m "Build artifacts" -w /path/to/repo
```

### Key Behaviors

- 2-20 steps per pipeline
- Each step gets its own task with automatic `dependsOn` wiring
- Per-step overrides for priority, workingDirectory, agent
- Failure in any step cancels all downstream steps (failure cascade)
- Context flows through `continueFrom` between steps

## Orchestrations

Autonomous goal execution. The orchestrator is a meta-agent that uses Autobeat's own CLI to break down goals, delegate to workers, monitor progress, and iterate.

### MCP

```json
{
  "tool": "CreateOrchestrator",
  "arguments": {
    "goal": "Migrate the Express API to Fastify with zero regression",
    "workingDirectory": "/path/to/repo",
    "agent": "claude",
    "maxDepth": 3,
    "maxWorkers": 5,
    "maxIterations": 50
  }
}
```

### CLI

```bash
beat orchestrate "Migrate the Express API to Fastify" -w /path/to/repo
beat orchestrate "Migrate the Express API to Fastify" --foreground  # block and wait
```

### Guardrails

| Parameter | Default | Range | Purpose |
|-----------|---------|-------|---------|
| `maxDepth` | 3 | 1-10 | Max delegation depth |
| `maxWorkers` | 5 | 1-20 | Max concurrent worker agents |
| `maxIterations` | 50 | 1-200 | Max orchestrator loop iterations |
| `model` | — | string | Model override (overrides agent-config default) |
| `systemPrompt` | — | string | Custom system prompt (replaces auto-generated role instructions) |

**Caveat**: `systemPrompt` replaces the auto-generated role instructions entirely — it does not append. This prevents conflicting ROLE sections.

### How It Works

1. A loop is created internally that runs the orchestrator agent
2. The agent reads a persistent state file with plan and progress
3. Each iteration: read state → check workers → delegate/monitor → update state
4. The orchestrator uses `beat run`, `beat status`, `beat logs`, `beat loop` CLI commands
5. Completion: agent writes `status: "complete"` to state file

### When to Use Orchestrator vs Manual Wiring

**Use orchestrator** when:
- The goal requires planning (you can't enumerate the steps upfront)
- Steps depend on the output of previous steps (dynamic task graph)
- Recovery and adaptation are needed (handle failures, try alternative approaches)

**Don't use orchestrator** when:
- Steps are known upfront → Pipeline
- It's iterative improvement on one task → Loop
- It's a single task → DelegateTask

## Custom Orchestrators

For orchestrations that need custom eval criteria, custom prompt structure, or multi-phase logic, use `InitCustomOrchestrator` to scaffold building blocks and compose them into a `CreateLoop`.

### When to Use

| | `CreateOrchestrator` | `InitCustomOrchestrator` + `CreateLoop` |
|---|---|---|
| Prompt | Auto-generated role instructions | You provide full systemPrompt |
| Eval | Built-in state file polling | Your custom evalPrompt + evalType |
| Control | Turnkey — autobeat manages everything | Full control — you compose the loop |
| Best for | Standard goal execution | Custom eval, multi-phase, specialized prompts |

### Workflow

1. Call `InitCustomOrchestrator` with your goal → receive artifacts (state file, exit script, snippets)
2. Compose a `CreateLoop` using the artifacts: set `systemPrompt` with delegation snippets, `exitCondition` with the exit script, `evalPrompt` for custom evaluation
3. Monitor with `LoopStatus`

### MCP

```json
{
  "tool": "InitCustomOrchestrator",
  "arguments": {
    "goal": "Migrate Express API to Fastify with zero regression",
    "workingDirectory": "/path/to/repo",
    "agent": "claude",
    "maxWorkers": 5,
    "maxDepth": 3
  }
}
```

### CLI

```bash
beat orchestrate init "Migrate Express API to Fastify" -w /path/to/repo -a claude
```

## Schedules

Wrap any primitive in a schedule for deferred or recurring execution.

### Schedule Types

- **cron**: Standard 5-field expression (minute hour day month weekday)
- **one_time**: ISO 8601 datetime for single future execution

### MCP — Scheduled Task

```json
{
  "tool": "ScheduleTask",
  "arguments": {
    "prompt": "Run dependency audit and update packages",
    "scheduleType": "cron",
    "cronExpression": "0 9 * * 1",
    "timezone": "America/New_York",
    "workingDirectory": "/path/to/repo"
  }
}
```

### MCP — Scheduled Pipeline

```json
{
  "tool": "SchedulePipeline",
  "arguments": {
    "steps": [
      { "prompt": "Run lint" },
      { "prompt": "Run tests" },
      { "prompt": "Deploy to staging" }
    ],
    "scheduleType": "cron",
    "cronExpression": "0 9 * * *",
    "timezone": "UTC"
  }
}
```

### MCP — Scheduled Loop

```json
{
  "tool": "ScheduleLoop",
  "arguments": {
    "prompt": "Optimize bundle size",
    "strategy": "optimize",
    "exitCondition": "node scripts/measure-bundle.js",
    "evalDirection": "minimize",
    "scheduleType": "cron",
    "cronExpression": "0 2 * * 0"
  }
}
```

### Schedule Configuration

| Parameter | Purpose |
|-----------|---------|
| `timezone` | IANA timezone (default: UTC), DST-aware |
| `missedRunPolicy` | `skip` (default), `catchup`, or `fail` |
| `maxRuns` | Limit total cron executions |
| `expiresAt` | ISO 8601 expiry datetime |
| `afterSchedule` | Chain after another schedule (dependency) |

### Schedule Lifecycle

- **active** → **paused** (PauseSchedule) → **active** (ResumeSchedule)
- **active** → **cancelled** (CancelSchedule)
- **active** → **completed** (maxRuns reached or expired)
- Concurrent execution prevented: overlapping triggers are skipped

## Pipeline Management

Pipelines are first-class entities with their own IDs (`pipeline-xxxx`).

| Tool | Purpose |
|------|---------|
| `PipelineStatus` | Get pipeline status, step progress, failure details |
| `ListPipelines` | List pipelines with optional status filter |
| `CancelPipeline` | Cancel a pipeline and optionally all in-flight step tasks |

Pipeline states: pending, running, completed, failed, cancelled.

## Composition Patterns

### Pipeline-in-Loop

Repeat a multi-step pipeline until a condition is met:

```json
{
  "tool": "CreateLoop",
  "arguments": {
    "pipelineSteps": ["Lint and fix all warnings", "Run full test suite", "Build production artifacts"],
    "strategy": "retry",
    "exitCondition": "npm run build && npm test",
    "maxIterations": 5
  }
}
```

### Scheduled Pipeline-in-Loop

Run a quality improvement loop every night:

```json
{
  "tool": "ScheduleLoop",
  "arguments": {
    "pipelineSteps": ["Run static analysis", "Fix identified issues", "Run tests"],
    "strategy": "retry",
    "exitCondition": "npm test && npm run lint",
    "scheduleType": "cron",
    "cronExpression": "0 2 * * *",
    "maxIterations": 3
  }
}
```

### Fan-Out / Fan-In with Tasks

```
A = DelegateTask("Generate test data")
B = DelegateTask("Process partition 1", dependsOn: [A])
C = DelegateTask("Process partition 2", dependsOn: [A])
D = DelegateTask("Merge and validate", dependsOn: [B, C])
```

### Schedule Chaining

```
Schedule S1: "Run migrations" (cron, daily at 1am)
Schedule S2: "Run integration tests" (cron, daily, afterSchedule: S1)
```

S2's tasks get a dependency on S1's latest task — S2 waits for S1 to finish.
