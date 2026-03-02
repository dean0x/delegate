# Backbeat v0.4.0 - Project Rename + Task Scheduling & Resumption

## Project Rename: claudine → backbeat

This release renames the project from `claudine` to `backbeat` to avoid trademark concerns with Anthropic's "Claude" branding. This is a **clean break** — no data migration from `~/.claudine/`.

| Before | After |
|--------|-------|
| `npm install -g claudine` | `npm install -g backbeat` |
| `claudine mcp start` | `beat mcp start` |
| `CLAUDINE_DATABASE_PATH` | `BACKBEAT_DATABASE_PATH` |
| `CLAUDINE_DATA_DIR` | `BACKBEAT_DATA_DIR` |
| `~/.claudine/claudine.db` | `~/.backbeat/backbeat.db` |
| `.claudine-patches/` | `.backbeat-patches/` |
| `ClaudineError` / `isClaudineError` | `BackbeatError` / `isBackbeatError` |

See the **Breaking Changes** section below for full migration guide.

## Major Features

### Task Scheduling (Cron & One-Time)

Schedule tasks for future or recurring execution with full lifecycle management.

**Key Capabilities:**
- **Cron Schedules**: Standard 5-field cron expressions (`0 9 * * 1-5` for weekday mornings)
- **One-Time Schedules**: ISO 8601 datetime scheduling with timezone support
- **Timezone Support**: IANA timezone names (e.g., `America/New_York`, `Europe/London`)
- **Missed Run Policies**: `skip` (default), `catchup`, or `fail` for overdue triggers
- **Max Runs**: Limit total executions for recurring schedules
- **Expiration**: Auto-expire schedules after a given datetime
- **Execution History**: Full audit trail of every schedule trigger and resulting task

**MCP Tools (6 new):**
- `ScheduleTask` - Create cron or one-time schedules
- `ListSchedules` - List with optional status filtering
- `GetSchedule` - Get schedule details with execution history
- `CancelSchedule` - Cancel with reason tracking
- `PauseSchedule` / `ResumeSchedule` - Pause and resume schedules

**CLI Commands (6 new + pipeline):**
```bash
# Cron schedule
beat schedule create "run linter" --type cron --cron "0 9 * * 1-5"

# One-time schedule
beat schedule create "deploy v2" --type one_time --at "2026-03-01T09:00:00Z"

# List and manage
beat schedule list --status active
beat schedule get <id> --history
beat schedule pause <id>
beat schedule resume <id>
beat schedule cancel <id> "no longer needed"

# Pipeline: sequential tasks with delays
beat pipeline "set up DB" --delay 5m "run migrations" --delay 10m "seed data"
```

**Architecture:**
- `ScheduleManagerService`: Business logic extracted from MCP adapter, reused by CLI
- `ScheduleHandler`: Event-driven lifecycle management (create, trigger, cancel, pause, resume)
- `ScheduleExecutor`: Tick-based engine with configurable intervals, concurrent execution prevention, graceful shutdown
- `ScheduleRepository`: SQLite persistence with prepared statements and Zod boundary validation
- Database migrations v4-v6: `schedules`, `schedule_executions`, `task_checkpoints` tables, `continue_from` column

### Task Resumption

Resume failed or completed tasks with enriched context from automatic checkpoints.

**Key Capabilities:**
- **Auto-Checkpoints**: Automatically captured on task completion or failure
- **Git State Capture**: Branch, commit SHA, dirty files recorded at checkpoint time
- **Output Summary**: Last 50 lines of stdout/stderr preserved for context
- **Enriched Prompts**: Resumed tasks receive full checkpoint context in their prompt
- **Retry Chains**: Track resume lineage via `parentTaskId` and `retryOf` fields
- **Additional Context**: Provide extra instructions when resuming

**MCP Tool:**
- `ResumeTask` - Resume a terminal task with optional additional context

**CLI Command:**
```bash
beat resume <task-id>
beat resume <task-id> --context "Try a different approach this time"
```

**Architecture:**
- `CheckpointHandler`: Subscribes to `TaskCompleted`/`TaskFailed`, auto-captures checkpoints
- `CheckpointRepository`: SQLite persistence for `task_checkpoints` table (migration v5)
- `git-state.ts`: Utility to capture git branch, SHA, and dirty files via child_process
- `TaskManagerService.resume()`: Fetches checkpoint, constructs enriched prompt, creates new task

### Session Continuation (`continueFrom`)

Pass checkpoint context through dependency chains so dependent tasks automatically receive output, git state, and errors from their predecessors.

**Key Capabilities:**
- **`continueFrom` field**: Specify a dependency whose checkpoint context is injected into the dependent task's prompt
- **Automatic enrichment**: Output summary, git state, and errors prepended to prompt before execution
- **Race-safe**: Subscribe-first pattern with 5-second timeout ensures checkpoint availability
- **Validation**: `continueFrom` must reference a task in `dependsOn` (auto-added if missing)
- **Chain support**: A→B→C where B receives A's context, C receives B's (which includes A's)

**MCP:**
```typescript
await DelegateTask({
  prompt: "npm test",
  dependsOn: [buildTaskId],
  continueFrom: buildTaskId
});
```

**CLI:**
```bash
beat run "npm test" --depends-on task-abc --continue-from task-abc
```

---

## Bug Fixes

### FK Cascade on Task/Schedule Updates
**Issue**: `INSERT OR REPLACE` in task and schedule repositories triggered `ON DELETE CASCADE`/`ON DELETE SET NULL` on child tables (`schedule_executions`, `task_checkpoints`), destroying execution history and checkpoint data during routine status updates.

**Fix**: Separated `save()` (initial insert with `INSERT OR IGNORE`) from `update()` (proper `UPDATE ... WHERE id = ?`). Refactored `PersistenceHandler` to use `update()` for all status changes.

**Impact**: Schedule execution history and task checkpoints now survive task lifecycle transitions.

### CJS/ESM Import Compatibility
**Issue**: `cron-parser@4.9.0` is CommonJS. Node.js ESM runtime cannot use named imports from CJS modules, causing `SyntaxError: Named export 'parseExpression' not found` in CI.

**Fix**: Changed to default import with destructure pattern. Added separate type-only import for TypeScript types.

**Impact**: CLI and schedule executor now work correctly in Node.js ESM environments.

---

## Infrastructure

### Schedule Service Extraction
Extracted ~375 lines of schedule business logic from MCP adapter into `ScheduleManagerService`. MCP adapter is now a thin protocol wrapper delegating to the service. CLI reuses the same service for full feature parity.

### CLI Bootstrap Helper
Added `withServices()` helper that eliminates 15-line bootstrap boilerplate repeated across every CLI command. Returns typed service references with no `as any` casts.

### Database Migrations
- **v4**: `schedules` and `schedule_executions` tables (cron config, timezone, missed run policy, execution history)
- **v5**: `task_checkpoints` table (auto-checkpoints with git state, output summary) and `after_schedule_id` column
- **v6**: `continue_from` column on tasks table (session continuation through dependency chains)

---

## Test Coverage

### New Test Files (11)
- `schedule-manager.test.ts` - Service method validation, error propagation (456 lines)
- `schedule-handler.test.ts` - Event handler lifecycle tests (441 lines)
- `schedule-executor.test.ts` - Tick engine, missed run policies, concurrency (435 lines)
- `schedule-repository.test.ts` - CRUD, pagination, FK constraints (557 lines)
- `checkpoint-repository.test.ts` - CRUD, boundary validation (555 lines)
- `checkpoint-handler.test.ts` - Auto-checkpoint on task events (477 lines)
- `cron.test.ts` - Cron parsing, next run calculation, timezone (224 lines)
- `task-scheduling.test.ts` - End-to-end schedule lifecycle integration (616 lines)
- `task-resumption.test.ts` - End-to-end resume with retry chains integration (559 lines)
- `cli.test.ts` - Schedule, pipeline, and resume command coverage (693 lines added)
- `mcp-adapter.test.ts` - Updated for schedule tools

**Total**: ~9,900 lines added across 41 files. 844+ tests passing.

---

## Breaking Changes

### Package Rename
- **npm package**: `claudine` → `backbeat`
- **CLI command**: `claudine` → `beat`
- **MCP server name**: `claudine` → `backbeat`
- **Update your MCP config** to use the new package and server name

### Environment Variables
- `CLAUDINE_DATABASE_PATH` → `BACKBEAT_DATABASE_PATH`
- `CLAUDINE_DATA_DIR` → `BACKBEAT_DATA_DIR`

### Data Paths
- `~/.claudine/claudine.db` → `~/.backbeat/backbeat.db`
- Existing data at `~/.claudine/` is **not migrated** — start fresh

### Library API
- `ClaudineError` → `BackbeatError`
- `isClaudineError()` → `isBackbeatError()`
- `toClaudineError()` → `toBackbeatError()`

Scheduling and resumption features are additive — existing databases auto-migrate on startup.

---

## Installation

```bash
npm install -g backbeat@0.4.0
```

Or add to your `.mcp.json`:
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

## What's Next

See [ROADMAP.md](../ROADMAP.md) for complete roadmap.

---

## Upgrade Notes

No special upgrade steps required. Simply update to 0.4.0:

```bash
npm install -g backbeat@0.4.0
```

Existing databases will automatically migrate through v4-v6 schemas on first startup.

---

## Contributors

- **Dean Sharon** (@dean0x) - Feature design and implementation
- **Claude Code** - Development assistance and code review

---

## Links

- NPM Package: https://www.npmjs.com/package/backbeat
- Documentation: https://github.com/dean0x/delegate/blob/main/docs/FEATURES.md
- Issues: https://github.com/dean0x/delegate/issues
