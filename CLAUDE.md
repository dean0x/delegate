# CLAUDE.md

This file provides project-specific guidance for Claude Code when working on Backbeat.

## Project Overview

Backbeat is an MCP (Model Context Protocol) server that enables task delegation to background Claude Code instances. It uses event-driven architecture with autoscaling workers, task dependencies (DAG-based), and SQLite persistence.

**Core Concept**: Transform a dedicated server into an AI powerhouse - orchestrate multiple Claude Code instances through one main session for parallel development across repositories.

## Quick Start

```bash
# Install and build
npm install
npm run build

# Run MCP server
beat mcp start
# or: node dist/cli.js mcp start

# Development mode (auto-reload)
npm run dev

# Test - Smart Grouping (v0.3.2+)
npm run test:core           # Core domain logic (~3s) - SAFE in Claude Code
npm run test:handlers       # Service handlers (~3s) - SAFE in Claude Code
npm run test:services       # Service-layer tests (~2s) - SAFE in Claude Code
npm run test:repositories   # Data layer (~2s) - SAFE in Claude Code
npm run test:adapters       # MCP adapter (~2s) - SAFE in Claude Code
npm run test:implementations # Other implementations (~2s) - SAFE in Claude Code
npm run test:cli            # CLI tests (~2s) - SAFE in Claude Code
npm run test:integration    # Integration tests - SAFE in Claude Code
npm test                    # ⚠️  BLOCKED - Prints warning and exits (technical safeguard)
npm run test:all            # Full suite - Use in local terminal/CI only
npm run test:worker-handler # Worker tests (OPTIONAL)
npm run test:coverage       # With coverage
```

**Why grouped tests?** Vitest workers accumulate memory across test files. Grouped tests provide fast feedback and prevent resource exhaustion. Individual groups are safe to run from Claude Code.

**Technical Safeguard**: `npm test` is blocked with a warning message to prevent accidental full suite runs that crash Claude Code. Use `npm run test:all` for full suite in local terminal/CI.

**Memory Management**:
- All commands use 2GB memory limit (`--max-old-space-size=2048`)
- Vitest config: `vmMemoryLimit: '1024MB'` restarts workers at 1GB threshold
- **Claude Code constraint**: Full suite exhausts system resources even with low limits


## Architecture Notes

**Hybrid Event-Driven System**: Commands (state changes) flow through EventBus; queries use direct repository access.

**Key Pattern**: Events flow through specialized handlers:
- `DependencyHandler` → manages task dependencies and DAG validation
- `QueueHandler` → dependency-aware task queueing
- `WorkerHandler` → worker lifecycle
- `PersistenceHandler` → database operations
- `ScheduleHandler` → schedule lifecycle (create, pause, resume, cancel)
- `ScheduleExecutor` → cron/one-time execution engine (note: has direct repo writes, architectural exception to event-driven pattern)

See `docs/architecture/` for implementation details.

## Task Dependencies (v0.3.0+)

Tasks can depend on other tasks using the `dependsOn` field:
- DAG validation prevents cycles (A→B→A)
- Tasks block until dependencies complete
- Cycle detection uses DFS algorithm in `DependencyGraph`
- TOCTOU protection via synchronous SQLite transactions

See `docs/TASK-DEPENDENCIES.md` for usage patterns.

## Release Process

### Pre-Release Checklist

1. **Update version** in `package.json`:
   ```bash
   npm version patch --no-git-tag-version  # 0.3.0 → 0.3.1
   npm version minor --no-git-tag-version  # 0.3.0 → 0.4.0
   npm version major --no-git-tag-version  # 0.3.0 → 1.0.0
   ```

2. **Create release notes** (REQUIRED):
   ```bash
   # Must match version in package.json
   touch docs/releases/RELEASE_NOTES_v0.3.1.md

   # Include: features, bug fixes, breaking changes, migration notes
   ```

3. **Test everything**:
   ```bash
   npm run build
   npm run test:all
   ```

### Release Workflow

1. **Merge version bump + release notes to main** via normal PR
2. **Trigger release manually** from GitHub Actions → Release → Run workflow
   - The workflow validates version is unpublished, checks release notes exist, runs tests, publishes to npm, creates git tag, and creates GitHub release

**Publishing is never automatic.** Merging a version bump to main does NOT publish. You must explicitly trigger the Release workflow.

## Project-Specific Guidelines

### Testing

- **Technical Safeguard**: `npm test` is blocked and prints a warning (prevents accidental crashes)
- **Use individual groups** from Claude Code: `npm run test:core`, `test:handlers`, etc.
- **Full suite**: `npm run test:all` (only in local terminal/CI)
- **ROOT CAUSE of memory exhaustion**: Vitest workers accumulate memory across test files
- **Solution**: `vmMemoryLimit: '1024MB'` in vitest.config.ts restarts workers at 1GB threshold
- **Tests are sequential** via vitest config (`maxWorkers: 1`, `isolate: false`)
- **All commands use 2GB** memory limit (`--max-old-space-size=2048`)
- **No real process spawning** - all tests use mocks (MockWorkerPool, MockProcessSpawner)

### Database

- SQLite with WAL mode for concurrent access
- All mutations go through event handlers (PersistenceHandler, DependencyHandler)
- Use synchronous transactions for TOCTOU protection (cycle detection)
- `schedules` table: schedule definitions, cron/one-time config, status, timezone
- `schedule_executions` table: execution history and audit trail

### Dependencies

When adding task dependencies:
- Always validate DAG (use `DependencyGraph.wouldCreateCycle()`)
- Use synchronous `db.transaction()` for atomicity
- Emit `TaskDependencyAdded`, `TaskUnblocked` events

### MCP Tools

All tools use PascalCase: `DelegateTask`, `TaskStatus`, `TaskLogs`, `CancelTask`, `ScheduleTask`, `ListSchedules`, `GetSchedule`, `CancelSchedule`, `PauseSchedule`, `ResumeSchedule`, `CreatePipeline`, `SchedulePipeline`

## File Locations

Quick reference for common operations:

| Component | File |
|-----------|------|
| Task lifecycle | `src/core/domain.ts` |
| Event definitions | `src/core/events/events.ts` |
| Dependency graph | `src/core/dependency-graph.ts` |
| Task repository | `src/implementations/task-repository.ts` |
| Dependency repository | `src/implementations/dependency-repository.ts` |
| Event handlers | `src/services/handlers/` |
| Handler setup | `src/services/handler-setup.ts` |
| MCP adapter | `src/adapters/mcp-adapter.ts` |
| CLI | `src/cli.ts` |
| Schedule repository | `src/implementations/schedule-repository.ts` |
| Schedule handler | `src/services/handlers/schedule-handler.ts` |
| Schedule executor | `src/services/schedule-executor.ts` |
| Schedule manager | `src/services/schedule-manager.ts` |
| Cron utilities | `src/utils/cron.ts` |

## Documentation Structure

- `README.md` - User-facing quick start
- `docs/FEATURES.md` - Complete feature list
- `docs/TASK-DEPENDENCIES.md` - Task dependencies API
- `docs/architecture/` - Architecture documentation
- `docs/releases/` - Release notes by version
- `docs/ROADMAP.md` - Future plans

---

**Note**: General engineering principles (Result types, DI, immutability, etc.) are defined in your global `~/.claude/CLAUDE.md`. This file contains only Backbeat-specific guidance.
