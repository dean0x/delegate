# Dependencies Reference

Deep dive on DAG-based task dependencies, pipelines, context passing, and failure cascade.

## Dependency Basics

Tasks can depend on other tasks via the `dependsOn` array. A dependent task stays BLOCKED until all its dependencies complete successfully.

### Simple Chain (A → B)

```json
// Step 1: Create task A
{ "tool": "DelegateTask", "arguments": { "prompt": "Write the migration script" } }
// Returns: { "taskId": "task-abc..." }

// Step 2: Create task B that depends on A
{ "tool": "DelegateTask", "arguments": {
    "prompt": "Run the migration",
    "dependsOn": ["task-abc..."]
  }
}
```

CLI:
```bash
A=$(beat run "Write the migration" | grep -o 'task-[a-f0-9-]*')
beat run "Run the migration" --depends-on "$A"
```

### Context Passing with `continueFrom`

When task B depends on task A, B can receive A's checkpoint context (output summary, git state, errors):

```json
{
  "tool": "DelegateTask",
  "arguments": {
    "prompt": "Review and validate the migration results",
    "dependsOn": ["task-abc..."],
    "continueFrom": "task-abc..."
  }
}
```

- `continueFrom` must reference a task in the `dependsOn` list (auto-added if missing)
- The checkpoint context is prepended to the dependent task's prompt
- Includes: last 50 lines of output, git branch/commit, dirty files, error messages

## Pipelines vs Manual Dependencies

### When to Use Pipelines

- Fixed, known sequence of 2-20 steps
- No need for fan-out or complex DAG shapes
- Simpler than manually wiring `dependsOn`

```json
{
  "tool": "CreatePipeline",
  "arguments": {
    "steps": [
      { "prompt": "Lint the code" },
      { "prompt": "Run unit tests" },
      { "prompt": "Run integration tests" },
      { "prompt": "Build production artifacts" }
    ]
  }
}
```

### When to Use Manual Dependencies

- Non-linear graphs (fan-out, fan-in, diamond)
- Dynamic task creation (don't know all steps upfront)
- Need fine-grained control over which tasks trigger which

## DAG Patterns

### Fan-Out

One task spawns multiple parallel tasks:

```
     A
    / \
   B   C
```

```json
A = DelegateTask("Generate test data")
B = DelegateTask("Process subset 1", dependsOn: [A])
C = DelegateTask("Process subset 2", dependsOn: [A])
```

B and C run in parallel once A completes.

### Fan-In

Multiple tasks converge to one:

```
   B   C
    \ /
     D
```

```json
D = DelegateTask("Merge results", dependsOn: [B, C])
```

D runs only after both B and C complete.

### Diamond

Combines fan-out and fan-in:

```
     A
    / \
   B   C
    \ /
     D
```

```json
A = DelegateTask("Generate data")
B = DelegateTask("Process path 1", dependsOn: [A])
C = DelegateTask("Process path 2", dependsOn: [A])
D = DelegateTask("Merge and validate", dependsOn: [B, C], continueFrom: B)
```

### Linear Chain with Context

```
A → B → C
```

Each step receives the previous step's context:

```json
A = DelegateTask("Write the API")
B = DelegateTask("Write tests for the API", dependsOn: [A], continueFrom: A)
C = DelegateTask("Review and fix issues", dependsOn: [B], continueFrom: B)
```

C receives B's context, which already includes A's context — context flows through the chain.

## Failure Cascade

When a task in a dependency chain fails or is cancelled:

1. All direct dependents are automatically **cancelled** (not unblocked)
2. Cancellation cascades transitively through the entire downstream graph
3. This prevents wasted work on tasks that depend on failed prerequisites

### Example

```
A → B → D
A → C → D
```

If A fails:
- B is cancelled (depends on A)
- C is cancelled (depends on A)
- D is cancelled (depends on B and C, both cancelled)

### Pipeline Failure Cascade

Pipelines use the same mechanism. If step 2 of a 5-step pipeline fails:
- Steps 3, 4, 5 are all cancelled
- Step 1 (already completed) is unaffected

### Cancel with Tasks

When cancelling a schedule that has in-flight pipeline tasks:

```json
{ "tool": "CancelSchedule", "arguments": { "scheduleId": "...", "cancelTasks": true } }
```

This cancels the schedule AND all running tasks from the current execution.

## Scheduled Pipelines

Wrap a pipeline in a schedule for recurring execution:

```json
{
  "tool": "SchedulePipeline",
  "arguments": {
    "steps": [
      { "prompt": "Pull latest changes and run migrations" },
      { "prompt": "Run full test suite" },
      { "prompt": "Deploy to staging" }
    ],
    "scheduleType": "cron",
    "cronExpression": "0 9 * * 1-5",
    "timezone": "America/New_York"
  }
}
```

Each trigger creates a fresh set of pipeline tasks with linear dependencies.

### Schedule Chaining (`afterSchedule`)

Chain schedules so one runs after another:

```json
S1 = ScheduleTask("Run migrations", scheduleType: "cron", cronExpression: "0 1 * * *")
S2 = SchedulePipeline(steps: [...], scheduleType: "cron", cronExpression: "0 1 * * *", afterSchedule: S1.id)
```

S2's first step gets a dependency on S1's latest task. S2 waits for S1 to complete before starting.

## Per-Step Overrides

Pipeline and scheduled pipeline steps support per-step configuration:

```json
{
  "tool": "CreatePipeline",
  "arguments": {
    "steps": [
      { "prompt": "Lint", "priority": "P1" },
      { "prompt": "Test", "priority": "P0", "workingDirectory": "/path/to/test-repo" },
      { "prompt": "Deploy", "agent": "codex" }
    ],
    "priority": "P2",
    "workingDirectory": "/path/to/repo",
    "agent": "claude"
  }
}
```

- Step-level `priority`, `workingDirectory`, `agent` override pipeline-level defaults
- Unset step fields inherit from the pipeline-level value

## Validation Rules

- **Cycle detection**: DAG validation prevents cycles (A→B→A) using DFS algorithm
- **TOCTOU protection**: Dependency addition uses synchronous SQLite transactions
- **Task existence**: Referenced task IDs must exist
- **Terminal state**: Dependencies can only be on existing tasks
- **Max fan-out**: No hard limit, but keep practical (< 50 concurrent dependents)

## Recipes

### Code Review Pipeline

```json
{
  "tool": "CreatePipeline",
  "arguments": {
    "steps": [
      { "prompt": "Run static analysis (biome, eslint) and report findings" },
      { "prompt": "Run security audit (npm audit, snyk test)" },
      { "prompt": "Run full test suite with coverage" },
      { "prompt": "Generate review summary from previous step outputs" }
    ],
    "workingDirectory": "/path/to/repo"
  }
}
```

### Data Processing Diamond

```json
A = DelegateTask("Download and validate dataset from S3")
B = DelegateTask("Clean and normalize text fields", dependsOn: [A])
C = DelegateTask("Extract and validate numeric features", dependsOn: [A])
D = DelegateTask("Merge cleaned data and generate report", dependsOn: [B, C])
```
