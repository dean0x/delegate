# Backbeat v0.6.0 — Architectural Simplification + Scheduled Pipelines

v0.6.0 is a dual-theme release: **architectural simplification** (hybrid event model, SQLite worker coordination, ReadOnlyContext, atomic transactions) and **scheduled pipelines** (recurring/one-time multi-step pipelines with dependency failure cascade). Also includes bug fixes and tech debt cleanup across 8 PRs.

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

`CancelSchedule` now supports a `cancelTasks` flag to also cancel in-flight pipeline tasks from all active executions.

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

### Architectural Simplification

#### Event System Simplification (PR #91)

Replaced 18 overhead events with direct repository calls. Removed 3 services (QueryHandler, OutputHandler, AutoscalingManager). EventBus reduced from 42 to 25 events. Commands (state changes) still flow through events; queries use direct calls — a hybrid model that eliminates unnecessary indirection.

#### SQLite Worker Coordination (PR #94)

New `workers` table with PID-based crash detection replaces in-memory-only worker tracking. Enables cross-process output visibility and proper crash recovery. `WorkerRepository` and `OutputRepository` are now required constructor parameters.

#### ReadOnlyContext for CLI Queries (PR #100)

Lightweight bootstrap mode for read-only CLI commands (`status`, `list`, `logs`). Skips EventBus, worker pool, and schedule executor initialization. ~200-400ms faster startup for query commands.

#### Atomic Transactions (PR #85)

`runInTransaction` provides atomic multi-step database operations with automatic rollback on failure. Used by schedule operations to prevent partial state on errors.

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

### Constructor Changes (PR #94)

`WorkerRepository` and `OutputRepository` are now required parameters in constructors that previously didn't need them. This enables cross-process worker tracking and persistent output storage.

### Event System Reduction (PR #91)

EventBus reduced from 42 to 25 events. Query operations (task status, logs, list) use direct repository calls instead of events. Code that subscribed to removed events must be updated.

### BootstrapOptions Mode Enum (PR #104)

`BootstrapOptions` drops boolean flags (`isCli`, `isRun`, `isReadOnly`) in favor of `mode: BootstrapMode` (`'server'` | `'cli'` | `'run'`).

---

## Bug Fixes

- **Dependency Failure Cascade**: Failed/cancelled upstream tasks now cascade cancellation to dependents instead of incorrectly unblocking them
- **Queue Handler Race Condition**: Fast-path `dependencyState` check prevents blocked tasks from being enqueued before dependency rows are written to DB
- **Schedule Repo Validation**: Added Zod validation for `pipeline_task_ids` at repository boundary
- **MCP Adapter**: Use `null` instead of `undefined` for `nextRunAt` fallback in `handleSchedulePipeline`
- **Timing Validation**: Deduplicated timing validation logic in `createSchedule`
- **RecoveryManager Dependency Checks** (PR #106, issue #84): Crash recovery now validates dependency state before re-queuing tasks
- **CancelSchedule Scope** (PR #106, issue #82): `cancelTasks` now cancels tasks from ALL active executions, not just the latest
- **Output totalSize** (PR #106, issue #95): `totalSize` recalculated after tail-slicing via shared `linesByteSize` utility
- **FAIL Policy Atomicity** (PR #107, issue #83): ScheduleExecutor FAIL policy wrapped in transaction — atomic cancel+audit with event emission after transaction commits

---

## Tech Debt / Refactoring

- **OutputRepository DIP Compliance** (PR #107, issue #101): Interface moved from `implementations/` to `core/interfaces.ts`, aligning with Dependency Inversion Principle
- **BootstrapMode Enum** (PR #107, issue #104): Three boolean flags replaced with a single `mode` field — cleaner API, extensible for future modes
- **Multi-Provider Branding** (PR #86): Neutralize Claude-specific language throughout codebase for multi-provider positioning

---

## Database

- **Migration 8**: Adds `pipeline_steps` column to `schedules` table and `pipeline_task_ids` column to `schedule_executions` table
- **Migration 9**: Adds `workers` table for cross-process worker tracking with PID-based crash detection

---

## PRs Included

| PR | Description |
|----|-------------|
| #78 | Scheduled pipelines with dependency cascade fix |
| #85 | `runInTransaction` for atomic DB operations |
| #86 | Neutralize Claude-specific branding |
| #91 | Simplify Event System (18 events removed, 3 services removed) |
| #94 | SQLite worker coordination + output persistence |
| #100 | ReadOnlyContext for lightweight CLI queries |
| #106 | Correctness bugs (#84, #82, #95) |
| #107 | Tech debt cleanup (#101, #104, #83) |

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
