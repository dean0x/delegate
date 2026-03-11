# Backbeat v0.6.0 — Scheduled Pipelines

Create recurring or one-time scheduled pipelines that trigger a full multi-step pipeline on each execution. v0.6.0 also fixes dependency failure handling with automatic cascade cancellation.

---

## New Features

### SchedulePipeline MCP Tool (PR #78)

Create a schedule that triggers a sequential pipeline (2-20 steps) on each execution.

**Key Capabilities:**
- **Cron + One-Time**: Supports both recurring cron expressions and single future execution
- **Linear Dependencies**: Each trigger creates fresh tasks wired with linear dependencies (step N depends on step N-1)
- **Per-Step Configuration**: Each step can have its own prompt, priority, working directory, and agent override
- **Shared Defaults**: Schedule-level agent, priority, and working directory apply to all steps unless overridden
- **Concurrency Tracking**: Pipeline completion tracked via tail task -- prevents overlapping pipeline executions
- **`afterScheduleId` Support**: Chain pipelines after other schedules (predecessor dependency injected on step 0)

**MCP Usage:**
```typescript
await SchedulePipeline({
  name: "nightly-ci",
  steps: [
    { prompt: "run linter" },
    { prompt: "run tests" },
    { prompt: "build and deploy", priority: 0 }
  ],
  type: "cron",
  cron: "0 2 * * *",
  timezone: "America/New_York"
});
```

### CLI Pipeline Support

Create scheduled pipelines from the CLI with `--pipeline` and `--step` flags.

```bash
beat schedule create --pipeline \
  --step "lint" \
  --step "test" \
  --step "deploy" \
  --cron "0 9 * * 1-5"
```

### Cancel Schedule with In-Flight Tasks

`CancelSchedule` now supports a `cancelTasks` flag to also cancel in-flight pipeline tasks from the current execution.

**MCP:**
```typescript
await CancelSchedule({ scheduleId: "...", cancelTasks: true });
```

**CLI:**
```bash
beat schedule cancel <id> --cancel-tasks
```

### ListSchedules / GetSchedule Enhancements

- `ListSchedules` response includes `isPipeline` and `stepCount` indicators
- `GetSchedule` response includes full `pipelineSteps` when present

---

## Breaking Changes

### Dependency Failure Cascade

**Before (v0.3.0-v0.5.0):** When an upstream task failed or was cancelled, dependent tasks were unblocked and could execute. Tasks were expected to manually check dependency resolution states.

**After (v0.6.0+):** When an upstream task fails, is cancelled, or times out, all dependent tasks are automatically cancelled via cascade cancellation. Dependents never execute.

```
# v0.6.0 behavior:
Task A fails → Task B (depends on A) is automatically cancelled
             → Task C (depends on B) is automatically cancelled
```

This change was required for scheduled pipelines to fail-safe in unattended execution. The old behavior risked executing deployment steps after failed build steps.

---

## Bug Fixes

- **Dependency Failure Cascade**: Failed/cancelled upstream tasks now cascade cancellation to dependents instead of incorrectly unblocking them
- **Queue Handler Race Condition**: Fast-path `dependencyState` check prevents blocked tasks from being enqueued before dependency rows are written to DB
- **Schedule Repo Validation**: Added Zod validation for `pipeline_task_ids` at repository boundary
- **MCP Adapter**: Use `null` instead of `undefined` for `nextRunAt` fallback in `handleSchedulePipeline`
- **Timing Validation**: Deduplicated timing validation logic in `createSchedule`

---

## Database

- **Migration 8**: Adds `pipeline_steps` column to `schedules` table and `pipeline_task_ids` column to `schedule_executions` table

---

## Installation

```bash
npm install -g backbeat@0.6.0
```

Or use npx:
```json
{
  "mcpServers": {
    "backbeat": {
      "command": "npx",
      "args": ["-y", "backbeat", "mcp", "start"]
    }
  }
}
```

---

## Links

- NPM Package: https://www.npmjs.com/package/backbeat
- Documentation: https://github.com/dean0x/backbeat/blob/main/docs/FEATURES.md
- Issues: https://github.com/dean0x/backbeat/issues
