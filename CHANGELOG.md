# Changelog

All notable changes to Autobeat will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

---

## [1.4.0] - 2026-04-15

### Added
- **FeedforwardEvaluator** (`evalType: 'feedforward'`): New default evaluation mode that gathers agent findings on every iteration and feeds them into the next iteration's prompt as context, without making a stop/continue decision. Loop runs to `maxIterations` unconditionally. When no `evalPrompt` is set, acts as a pure pass-through (no eval agent spawned) (#136)
- **JudgeExitConditionEvaluator** (`evalType: 'judge'`): Two-phase eval+judge strategy. Phase 1 eval agent generates narrative findings; Phase 2 judge agent reads findings and writes a structured JSON decision to `.autobeat-judge-task-{uuid}` in the working directory (unique per judge task, prevents TOCTOU), optionally using Claude's `--json-schema` belt-and-suspenders mechanism. Defaults to `continue: true` if both mechanisms fail (#136)
- **Schema evaluator** (`evalType: 'schema'`): Deterministic structured output evaluation via Claude's `--json-schema`. Eval agent must respond with `{"continue": bool, "reasoning": string}`. No separate judge agent required (#136)
- `evalType` field on `Loop` domain object (`'feedforward'` | `'judge'` | `'schema'`); defaults to `'feedforward'` for backward compatibility (#136)
- `judgeAgent` and `judgePrompt` fields on `Loop` for configuring the judge agent and decision prompt independently of the eval agent (#136)
- `EvalMode` enum aligning internal evaluation dispatch with `evalType` (#136)
- `buildEvalPromptBase()` shared utility: extracts git diff context, tool instructions, and iteration header used by all three evaluators (#140)
- `acquirePidFile()`: Atomic O_EXCL PID file acquisition with sentinel Result return (`acquired` | `already-running`), stale-file cleanup, and recovery from concurrent startup races (#141)
- `checkActiveSchedules()`, `registerSignalHandlers()`, `startIdleCheckLoop()`: Extracted pure functions from `handleScheduleExecutor` for unit testability (#142)
- `SpawnOptions` interface: Replaces 6 positional parameters on `AgentAdapter.spawn()` with a named options object (#139)

### Database
- **Migration v21**: Adds `workers.last_heartbeat INTEGER` (liveness tracking), `loops.eval_type TEXT DEFAULT 'feedforward'`, `loops.judge_agent TEXT`, and `loops.judge_prompt TEXT` columns (#136)
- **Migration v22**: Recreates `loops` table with CHECK constraints on `eval_type IN ('feedforward', 'judge', 'schema')` and `judge_agent IN ('claude', 'codex', 'gemini')`. **Full table rebuild — back up `~/.autobeat/autobeat.db` before upgrading** (#136)

### Changed
- `handleScheduleExecutor` now uses atomic PID file acquisition (`acquirePidFile`) instead of a read-then-write pattern (#141)
- `AgentAdapter.spawn()` signature changed from 6 positional params to `spawn(options: SpawnOptions)` — all implementations and call sites updated (#139)

### Internal Refactoring
- `refetchAfterAgentEval()` extracted from `LoopHandler.handleTaskTerminal()` to encapsulate stale-state guard (#137)
- `handleStopDecision()` extracted from `LoopHandler` to deduplicate stop-path logic shared between `handleRetryResult` and `handleOptimizeResult` (#138)
- Shared eval test fixtures extracted to `tests/fixtures/eval-test-helpers.ts` to eliminate duplicated helpers across 3 test files (#143)

---

## [1.3.0] - 2026-04-11

### Added
- **Dashboard Redesign**: Two-view dashboard — Metrics view (resources/cost/throughput tiles + activity feed) and Workspace view (per-orchestration live task grid with streaming output panels) (#133)
- **Live agent output streaming**: 1-2s output latency in Workspace view via per-task polling with ring buffer and auto-tail (#133)
- **Cost and token tracking**: `UsageCaptureHandler` + `UsageParser` capture Claude token usage and USD cost into new `task_usage` table; 24h aggregate shown in Metrics view cost tile (#133)
- **Orchestrator_id propagation**: Sub-tasks attributed to their orchestration via `tasks.orchestrator_id`; propagated through CLI (`AUTOBEAT_ORCHESTRATOR_ID` env) and MCP (`metadata.orchestratorId`) spawn paths (#133)
- **Cancel cascade for orchestrations**: `c` on an orchestration cancels it and all in-flight attributed child tasks (#133)
- **Responsive layout**: Terminal size detection via `process.stderr`; adapts to narrow/full/too-small modes; recomputes on SIGWINCH (#133)
- **Activity feed keyboard navigation**: Tab cycles into activity focus; ↑/↓ navigate rows; Enter opens detail view (#133)

### Changed
- `outputFlushIntervalMs` default: 5000ms → 1000ms (set `OUTPUT_FLUSH_INTERVAL_MS=5000` to opt out) (#133)
- Metrics view replaces the old 4-panel grid as the default main view (#133)

### Fixed
- ActivityPanel Enter dispatch was ungated — now routed through activity focus mode (#133)
- Zombie RUNNING orchestrations detected via worker liveness check on recovery (#133)
- Orchestration creation failure now applies compensating soft-delete to prevent phantom rows (#133)

### Breaking
- `src/cli/dashboard/views/main-view.tsx` removed; consumers of dashboard internals must update imports to `metrics-view.tsx` (#133)
- **Database**: Migrations v18 (`tasks.orchestrator_id`) and v19 (`task_usage`) auto-applied on first startup (#133)

---

## [1.2.0] - 2026-04-10

### Added
- **Terminal Dashboard** (`beat dashboard` / `beat dash`): Rich Ink-based terminal UI with 4 panels (loops, tasks, schedules, orchestrations), keyboard navigation (Tab/Shift+Tab, 1-4, j/k, Enter, Esc, f, q, r), detail views per entity, per-panel filter cycles, truncation indicators, and smart EmptyState with true counts (#131)
- **Agent baseUrl & model passthrough**: Per-agent `baseUrl` and `model` configuration in `~/.autobeat/config.json`; `--model`/`-m` CLI flag on `beat run` and `beat orchestrate`; provider env var injection (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `GEMINI_BASE_URL`); Claude experimental-betas auto-disable on custom `baseUrl`; extended `ConfigureAgent`/`ListAgents` MCP tools with `baseUrl`/`model` support (#130)

### 🗄️ Database
- **Migration 16**: Adds `model` column to `tasks` and `orchestrations` tables

---

## [1.1.0] - 2026-04-01

### Added
- **Agent Eval Mode**: Loops can use an AI agent to evaluate iteration results instead of shell commands. `evalMode: 'agent'` (MCP) / `--eval-mode agent` (CLI). Custom evaluation prompts via `evalPrompt` / `--eval-prompt`.
- **Agent Orchestration Skill**: Structured skill files in `skills/autobeat/` with capability hierarchy, tool reference, composition patterns, and monitoring guides.
- **Skill Installer**: `beat init --install-skills [--skills-agents claude,codex]` copies skill files to agent-specific directories (`.claude/`, `.agents/`, `.gemini/`).
- **MCP Instructions**: Server-side instructions injected into MCP protocol for structured agent context.
- **ListAgents MCP Tool**: List available agents with registration and auth status.
- **ConfigureAgent MCP Tool**: Check auth status, store API key, or reset stored key for an agent.

### Fixed
- **CRON schedule nextRunAt**: `createSchedule()` factory now populates `nextRunAt` for CRON schedules immediately. Previously returned `undefined` until the handler persisted it.

---

## [1.0.0] - 2026-03-28

### 🚀 Features
- **Orchestrator Mode**: Autonomous goal execution via a meta-agent that uses Autobeat's own infrastructure (task delegation, dependency ordering, eval loops, crash recovery) to break down goals and drive them to completion
- **4 CLI Commands**: `beat orchestrate`, `beat orchestrate status`, `beat orchestrate list`, `beat orchestrate cancel` with detach/foreground modes
- **4 MCP Tools**: `CreateOrchestrator`, `OrchestratorStatus`, `ListOrchestrators`, `CancelOrchestrator`
- **Persistent State File**: JSON state file with atomic I/O (temp + rename) for crash resilience, stored in `~/.autobeat/orchestrator-state/`
- **Guardrails**: Configurable `maxDepth` (1-10), `maxWorkers` (1-20), `maxIterations` (1-200) safety limits
- **Multi-Agent Orchestration**: Per-orchestration agent selection (Claude, Codex, Gemini)

### 🔄 Refactoring
- **RecoveryManagerDeps**: Standardized naming pattern for all handler dependency types
- **waitForLoopCompletion**: Extracted from CLI into reusable service function
- **handleOrchestrateForeground**: Extracted for testability

### 🔄 Events
- 3 new events (34 total): `OrchestrationCreated`, `OrchestrationCompleted`, `OrchestrationCancelled`

### 🗄️ Database
- **Migration 14**: `orchestrations` table with goal, status, guardrail columns, loop FK, and indexes on status and loop_id

### 📚 Documentation
- README overhauled for autonomous orchestration positioning
- ROADMAP updated for v1.0.0 release

### 🧪 Test Coverage
- 88 new orchestration tests across 8 test files (state, CLI, repository, service, handler, prompt, integration)
- 1,500+ total tests passing

### ℹ️ Semver Note
Despite the major version bump, all changes from v0.8.2 are **additive**. No breaking changes. v1.0.0 marks the completion of autonomous orchestration -- the original vision for Autobeat.

---

## [0.8.2] - 2026-03-26

### 💥 Breaking Changes
- **Package rename**: `backbeat` → `autobeat` (npm package, env vars, data dir, types, MCP server name)
- **Environment variables**: `BACKBEAT_*` → `AUTOBEAT_*` (no backward compatibility fallback)
- **Data directory**: `~/.backbeat/` → `~/.autobeat/`
- **Database file**: `backbeat.db` → `autobeat.db`
- **Error types**: `BackbeatError` → `AutobeatError`, `isBackbeatError` → `isAutobeatError`, `toBackbeatError` → `toAutobeatError`
- **Event type**: `BackbeatEvent` → `AutobeatEvent`
- **MCP server name**: `backbeat` → `autobeat`

### 🚀 Features
- **`beat migrate` command**: Automated migration from backbeat to autobeat — moves data directory, renames database file, updates MCP configs, scans shell profiles for env var references

### Unchanged
- CLI binary `beat` and all command names
- All MCP tool names (`DelegateTask`, `TaskStatus`, etc.)
- All functionality and APIs

---

## [0.8.1] - 2026-03-26

### 🐛 Bug Fixes
- **Git Integration**: Replaced broken branch-per-iteration strategy with correct commit-per-iteration design. One branch for the entire loop, one commit per successful iteration. Failed/discarded iterations fully reverted to the appropriate target commit.

### 🔄 Refactoring
- **Domain model**: Added `gitStartCommitSha` (loop), `gitCommitSha` and `preIterationCommitSha` (iteration). Old fields kept for migration safety.
- **Git utilities**: Added `getCurrentCommitSha()`, `commitAllChanges()`, `resetToCommit()` with SHA validation.

### ⚡ Performance
- **O(1) reset target**: `getResetTargetSha()` replaced O(n) iteration scan with cached
  `bestIterationCommitSha` lookup on the Loop domain.

### 🗄️ Database
- **Migration 12**: Adds `git_start_commit_sha` to loops, `git_commit_sha` and `pre_iteration_commit_sha` to loop_iterations.
- **Migration 13**: Adds `best_iteration_commit_sha` to loops for O(1) reset target lookup.

### 📦 Dependencies
- Security updates: hono, @hono/node-server, express-rate-limit, flatted, picomatch

---

## [0.8.0] - 2026-03-25

### 🚀 Features
- **Loop Pause/Resume**: Pause active loops mid-iteration, resume from last checkpoint. Paused state persists across restart. MCP: `PauseLoop`, `ResumeLoop`. CLI: `beat loop pause`, `beat loop resume`
- **Scheduled Loops**: Compose loops with cron/one-time schedules. Each execution creates a new loop instance. MCP: `ScheduleLoop`. CLI: `beat schedule create --loop`
- **Git Integration**: Optional `--git-branch` for git-aware loop iteration tracking. Diffs tracked between iterations. (Corrected in v0.8.1)

### 🖥️ CLI Improvements
- `--direction minimize|maximize` → `--minimize`/`--maximize` boolean flags (mutual exclusion validated)
- `--continue-context` → `--checkpoint`
- `schedule get` / `loop get` → `schedule status` / `loop status`
- Deprecated `beat loop get` prints rename hint

### 🔄 Refactoring
- Parser types converted to discriminated unions for exhaustive pattern matching (#114)
- `parseScheduleCreateArgs` extracted as pure function
- Schedule parser consistency and usability improvements

### ⚠️ Breaking Changes
- **MCP Tool Rename**: `GetSchedule` → `ScheduleStatus`
- **CLI Flag Renames**: `--direction` → `--minimize`/`--maximize`, `--continue-context` → `--checkpoint`
- **CLI Subcommand Renames**: `get` → `status` (schedule and loop)

### 🗄️ Database
- **Migration 11**: `loop_pause_state` column, `schedule_id` FK on loops table, git config storage

### 🔄 Events
- 2 new events (31 total): `LoopPaused`, `LoopResumed`

---

## [0.7.2] - 2026-03-22

### 📦 Dependencies
- **Updated `better-sqlite3`** from 12.6.2 to 12.8.0

### 🧪 Test Fixes
- **Fixed flaky CI test**: Widened packet loss simulation tolerance (0.15-0.50 from 0.2-0.4) to prevent random CI failures

---

## [0.7.1] - 2026-03-22

### 🐛 Bug Fixes
- **Missing `picocolors` dependency**: CLI commands crashed on global npm installs with `ERR_MODULE_NOT_FOUND` — `picocolors` was used but not declared in `package.json`

---

## [0.7.0] - 2026-03-22

### 🚀 Features
- **Task Loops**: Iterative task execution with retry (run until exit code 0) and optimize (score-based, minimize/maximize) strategies
- **Pipeline Loops**: Repeat a multi-step pipeline (2-20 steps) per iteration with linear dependencies and tail-task tracking
- **Safety Controls**: Max iterations (default 10), max consecutive failures (default 3), configurable cooldown between iterations
- **4 New MCP Tools**: `CreateLoop`, `LoopStatus`, `ListLoops`, `CancelLoop`
- **CLI Commands**: `beat loop`, `beat loop list`, `beat loop status`, `beat loop cancel` with pipeline support (`--pipeline --step`)

### 🧪 Test Coverage
- 94 new loop tests (45 repository + 24 service + 20 handler + 5 integration)
- 1,136 total tests passing

### 🗄️ Database
- **Migration 10**: `loops` table (definitions, strategy, exit condition, iteration state) and `loop_iterations` table (per-iteration records with scores and results)

### 🔄 Events
- 4 new events (29 total): `LoopCreated`, `LoopIterationCompleted`, `LoopCompleted`, `LoopCancelled`

---

## [0.6.0] - 2026-03-20

### 🚀 Features
- **Scheduled Pipelines**: `SchedulePipeline` MCP tool — cron/one-time multi-step pipelines with linear dependencies, per-step config, concurrency tracking, and `afterScheduleId` chaining
- **CLI Pipeline Scheduling**: `beat schedule create --pipeline --step "..." --cron "..."`
- **Cancel with In-Flight Tasks**: `CancelSchedule` supports `cancelTasks` flag to cancel all active execution tasks
- **ListSchedules/ScheduleStatus Enhancements**: `isPipeline`, `stepCount`, and full `pipelineSteps` in responses

### 🏗️ Architecture
- **Event System Simplification**: 42 → 25 events; removed 18 overhead events and 3 services (QueryHandler, OutputHandler, AutoscalingManager); hybrid model (commands via events, queries via direct calls)
- **SQLite Worker Coordination**: `workers` table with PID-based crash detection replaces in-memory tracking
- **ReadOnlyContext**: Lightweight bootstrap for read-only CLI commands (~200-400ms faster startup)
- **Atomic Transactions**: `runInTransaction` for multi-step DB operations with automatic rollback

### ⚠️ Breaking Changes
- **Dependency Failure Cascade**: Failed/cancelled upstream tasks now cascade cancellation to dependents (previously incorrectly unblocked them)
- **Constructor Changes**: `WorkerRepository` and `OutputRepository` now required in constructors
- **BootstrapMode Enum**: `mode: 'server'|'cli'|'run'` replaces boolean flags (`isCli`, `isRun`, `isReadOnly`)

### 🐛 Bug Fixes
- RecoveryManager validates dependency state before re-queuing tasks
- `CancelSchedule` cancels tasks from ALL active executions, not just latest
- Output `totalSize` recalculated after tail-slicing via shared `linesByteSize` utility
- FAIL policy wrapped in transaction — atomic cancel+audit with event emission after commit
- Queue handler race condition: fast-path `dependencyState` check prevents blocked tasks from being enqueued

### 🗄️ Database
- **Migration 8**: `pipeline_steps` column on `schedules`, `pipeline_task_ids` on `schedule_executions`
- **Migration 9**: `workers` table for cross-process worker tracking

---

## [0.5.0] - 2026-03-10

### 🚀 Features
- **Multi-Agent Support**: Pluggable agent registry with adapters for Claude (`claude`), OpenAI Codex (`codex`), and Google Gemini (`gemini-cli`) — per-task agent selection across MCP and CLI
- **`beat init`**: Interactive setup wizard for configuring default agent
- **`beat agents list`**: Show registered agents with status and default marker

### 🐛 Bug Fixes
- **git-state dirty file parsing**: `.trim()` on full stdout was truncating first porcelain filename; fixed to trim per-line

### 🧪 Test Coverage
- 54 new tests (21 handler unit + 33 validation/output/process/git-state)
- 900+ tests passing across all groups

---

## [0.4.1] - 2026-03-04

### 🚀 Features
- **CreatePipeline MCP Tool**: New `CreatePipeline` tool for creating sequential task pipelines via MCP (closes CLI/MCP feature parity gap). Accepts 2–20 steps with per-step priority and working directory overrides
- **Pipeline Service Extraction**: Pipeline creation logic extracted from CLI into `ScheduleManagerService.createPipeline()` — one business logic path shared by MCP and CLI

### 🏗️ Architecture
- **CLI Pipeline Refactor**: `beat pipeline` command refactored from inline schedule loop to shared service call (68 → 42 lines)

### 🧪 Test Coverage
- 17 new tests (11 service + 6 adapter) covering pipeline bounds, chaining, priority/workDir inheritance, prompt truncation, and failure propagation

---

## [0.4.0] - 2026-03-03

First release as **autobeat** (renamed from `claudine`). 17 commits since v0.3.3, covering scheduling, resumption, architectural simplification, CLI overhaul, and two-phase rename.

### 🚀 Major Features
- **Task Scheduling**: Cron and one-time schedule support with 6 new MCP tools (`ScheduleTask`, `ListSchedules`, `ScheduleStatus`, `CancelSchedule`, `PauseSchedule`, `ResumeSchedule`) and 6 CLI commands. Full lifecycle management with pause/resume, missed run policies, timezone support, and execution history
- **Task Resumption**: Resume failed/completed tasks with auto-checkpoints capturing output summary and git state. New `ResumeTask` MCP tool and `beat resume` CLI command
- **Session Continuation** (`continueFrom`): Pass checkpoint context through dependency chains — dependent tasks automatically receive output, git state, and errors from predecessors
- **CLI Detach Mode**: `--detach` flag (now default) re-spawns CLI as background process for fire-and-forget delegation. Use `--no-detach` for foreground mode
- **CLI UX Overhaul**: Complete output redesign with `@clack/prompts` — spinners, structured output, colored status displays, clean box layouts
- **Pipeline Command**: `beat pipeline` for sequential tasks with delays between steps

### 🏗️ Architecture
- **Git/Worktree Removal**: Removed 9 git fields, 5 interfaces, 3 events, 10+ CLI flags, deleted `worktree-manager.ts`, `github-integration.ts`, `worktree-handler.ts`. Major architectural simplification — Autobeat focuses on orchestration, not source control
- **Handler Setup Extraction**: Extracted handler registration from `bootstrap.ts` into dedicated `handler-setup.ts`
- **Schedule Service Extraction**: ~375 lines of schedule logic extracted from MCP adapter into `ScheduleManagerService`. CLI reuses same service for full feature parity
- **CLI Bootstrap Helper**: `withServices()` eliminates 15-line bootstrap boilerplate per command

### 🚀 Performance Improvements
- **Pagination for findAll() methods**: Added `limit` and `offset` parameters to `TaskRepository.findAll()` and `DependencyRepository.findAll()` with default limit of 100 records per page
- **New findAllUnbounded() methods**: Explicit unbounded retrieval for operations that genuinely need all records (e.g., graph initialization)
- **New count() methods**: Support pagination UI with total record counts without fetching all data

### 🐛 Bug Fixes
- **FK Cascade on Task/Schedule Updates**: Separated `save()` from `update()` to prevent `INSERT OR REPLACE` from triggering `ON DELETE CASCADE` on child tables
- **CJS/ESM Import Compatibility**: Fixed `cron-parser` named import failure in Node.js ESM runtime
- **5 bug fixes in rename PR #60**: Various fixes discovered during the claudine → delegate migration

### 🛠️ Infrastructure
- **Vitest 3 → 4**: Upgraded to resolve npm audit vulnerabilities (zero test changes)
- **Biome Linter & Formatter**: Replaced ESLint/Prettier with Biome for launch readiness
- **Explicit Release Workflow**: Removed auto-publish; releases now require manual GitHub Actions trigger
- **Prepublish Safety Check**: Ensures `dist/` directory exists before `npm publish`
- **Test Infrastructure**: Smart test grouping, deterministic synchronization, `npm test` blocked with safety warning, 2GB memory limits
- **Database Migrations**: v4 (schedules), v5 (checkpoints), v6 (continue_from)
- **Tech Debt Quick Wins**: Various cleanup from PR #41

### ⚠️ Breaking Changes
- **Package Rename**: `claudine` → `autobeat` (npm package, CLI binary `beat`, MCP server name, config paths)
- **Environment Variables**: `CLAUDINE_*` → `AUTOBEAT_*`
- **Data Paths**: `~/.claudine/` → `~/.autobeat/` (no migration — start fresh)
- **Library API**: `ClaudineError` → `AutobeatError`, `isClaudineError()` → `isAutobeatError()`
- **findAll() Pagination**: Returns max 100 results by default. Use `findAllUnbounded()` for all records
- **Git/Worktree Fields Removed**: `useWorktree`, `branchName`, `mergeStrategy` and related CLI flags no longer accepted

### 🧪 Test Coverage
- 11 new test files (~9,900 lines) covering scheduling, checkpoints, resumption, CLI, and integration
- 1,200+ tests passing across all groups

---

## [0.3.3] - 2025-12-09

### 🐛 Bug Fixes
- **Fixed broken npm package**: v0.3.2 was published without `dist/` directory due to stale TypeScript build cache
- **Fixed clean script**: Changed `.tsbuildinfo` to `tsconfig.tsbuildinfo` to match actual TypeScript output filename

---

## [0.3.2] - 2025-12-08

### 🛠️ Technical Improvements
- **Configurable chain depth limit**: `DependencyHandler.create()` now accepts `options.maxChainDepth`
- **Database defense-in-depth**: Added CHECK constraint on `resolution` column via migration v2
- **Type safety**: Explicit `DependencyRow` and `TaskRow` interfaces replace `Record<string, any>`

### 🗑️ Removed
- **Dead code cleanup**: Removed unused `getQueueStats()`, `getNextTask()`, `requeueTask()` methods from QueueHandler

### 📚 Documentation
- Fixed incorrect `getMaxDepth()` complexity claim (was "O(1) cached", now "O(V+E) with memoization")

---

## [0.3.1] - 2025-12-01

### 🔒 Security Fixes
- **CRITICAL: Graph Corruption Fix (Issue #28)**: Deep copy in `wouldCreateCycle()` prevents dependency graph corruption
  - Shallow copy (`new Map(this.graph)`) corrupted dependency graph because Set values remained as references
  - Cycle detection could permanently add edges to the graph, causing unpredictable task execution
  - Fixed with proper deep copy: `new Map(Array.from(this.graph.entries()).map(([k, v]) => [k, new Set(v)]))`
- **npm audit vulnerabilities fixed**: Resolved 3 security issues (1 HIGH, 2 MODERATE)
  - glob CLI command injection (HIGH) - GHSA-5j98-mcp5-4vw2
  - body-parser denial of service (MODERATE) - GHSA-wqch-xfxh-vrr4
  - vite path traversal on Windows (MODERATE) - GHSA-93m4-6634-74q7
- **Configuration validation logging**: No longer silently falls back to defaults when env vars fail validation

### 🚀 Performance Improvements
- **Settling workers tracking**: Prevents spawn burst overload during high-load scenarios
  - Load average is a 1-minute rolling average that doesn't reflect recent spawns
  - New `recordSpawn()` tracks workers in 15-second settling window
  - Projects resource usage including workers not yet reflected in metrics
  - Increased `minSpawnDelayMs` from 50ms to 1000ms for additional protection

### 🛠️ Technical Improvements
- **Type safety**: Replaced `any` type with `Worker` in `getWorkerStats()` return type
- **Test compatibility**: Added `recordSpawn()` to TestResourceMonitor
- **🔒 Input Validation Limits (Issue #12)**: Security hardening for dependency system
  - Maximum 100 dependencies per task to prevent DoS attacks
  - Maximum 100 dependency chain depth to prevent stack overflow
  - Clear error messages with current counts and limits
  - Validation enforced at repository level for consistency
- **🔄 Atomic Multi-Dependency Transactions (Issue #11)**: Data consistency improvements
  - New `addDependencies()` batch method with atomic all-or-nothing semantics
  - Transaction rollback on any validation failure (cycle detection, duplicate, task not found)
  - Prevents partial dependency state in database
  - DependencyHandler updated to use atomic batch operations
- **📊 Chain Depth Calculation**: New `DependencyGraph.getMaxDepth()` algorithm
  - DFS with memoization for O(V+E) complexity
  - Handles diamond-shaped graphs efficiently
  - Used for security validation of chain depth limits

### 🐛 Bug Fixes
- **Command Injection**: Fixed potential security vulnerabilities in git operations
- **Test Reliability**: Fixed flaky tests with proper mocking
- **Parameter Consistency**: Aligned CLI and MCP tool parameters

### 🧪 Test Coverage
- **5 new tests** for settling workers tracking in ResourceMonitor
- **3 regression tests** for graph immutability after cycle checks
- **18 tests** for v0.3.1 security and consistency improvements:
  - 11 tests for atomic batch dependency operations (rollback, validation)
  - 3 tests for max dependencies per task validation (100 limit)
  - 1 test for max chain depth validation (100 limit)
  - 7 tests for DependencyGraph.getMaxDepth() algorithm

### 📚 Documentation
- Updated `docs/architecture/TASK_ARCHITECTURE.md` with correct deep copy pattern
- Fixed stale line numbers in `docs/TASK-DEPENDENCIES.md` (wouldCreateCycle at line 240)

## [0.3.0] - 2025-10-18

### 🚀 Major Features
- **🔗 Task Dependencies**: DAG-based dependency management for complex workflows
  - Specify task dependencies using `dependsOn` field in task specifications
  - Automatic cycle detection (simple and transitive) using DAG algorithms
  - Tasks automatically transition from BLOCKED → QUEUED when dependencies complete
  - Diamond dependency patterns fully supported
  - Event-driven dependency resolution through EventBus
  - Atomic dependency operations with TOCTOU race condition protection
  - Foreign key validation preventing references to non-existent tasks

### 🛠️ Technical Improvements
- **Event-Driven Architecture Complete**: All operations now go through EventBus
  - Documented EventBus type casting as tech debt
- **Database Schema Migrations**: Version-based migration system
  - schema_migrations table for tracking applied migrations
  - Transaction-wrapped migrations for safety
  - Support for incremental schema evolution
- **MCP API Enhancement**: Added dependsOn parameter to DelegateTask
  - UUID pattern validation for dependency task IDs
  - Complete integration with task dependency system
- **Performance Optimizations**:
  - Handler-level graph cache prevents N+1 query pattern
  - Composite database index for getDependents() queries
  - Cache invalidation on TaskDependencyAdded events

### 🐛 Bug Fixes
- **Security - TOCTOU Race Condition**: Fixed critical race condition in dependency cycle detection
  - Synchronous transactions prevent concurrent cycle creation
  - Atomic check-and-add operations using better-sqlite3
  - Verified protection with concurrent operation tests
- **Error Handling Improvements**:
  - Preserve semantic AutobeatError types in addDependency (TASK_NOT_FOUND, INVALID_OPERATION)
  - Fixed error masking that converted validation failures to SYSTEM_ERROR
  - Migration error handling only catches "no such table" errors
  - Re-throws permission, corruption, and connection errors
- **Race Condition in QueueHandler**: Fetch fresh task state before enqueueing unblocked tasks
  - Prevents stale event data from enqueueing cancelled/failed tasks
  - Added TaskRepository dependency to QueueHandler
- **CI Stability**:
  - Fixed memory exhaustion by running only unit tests in CI
  - Added 5ms tolerance to network latency timing assertions
  - Skipped memory-intensive worker-handler tests in CI environment
  - Configured NODE_OPTIONS for per-test-suite memory management
- **CI Releases**: Added contents write permission for automated releases

### 📚 Documentation Updates
- **Task Dependencies**: Complete API documentation in docs/task-dependencies.md
- **Architecture**: Added ARCHITECTURE_QUICK_REFERENCE.md and TASK_ARCHITECTURE.md
- **Quality Audit**: COMPLEXITY_AUDIT_REPORT.md (76.2/100 maintainability score)
- **Test Stability**: Documented fixes in docs/test-stability-fixes.md
- **ROADMAP.md**: Updated with v0.3.0 status and v0.3.1/v0.4.0 plans
- **README.md**: Added dependency examples and usage patterns

### 🧪 Test Coverage
- **74 new tests** for task dependency system:
  - 23 tests for DependencyGraph (DAG operations)
  - 33 tests for DependencyRepository (persistence)
  - 16 tests for DependencyHandler (event-driven integration)
  - 7 integration tests for end-to-end dependency workflows
  - TOCTOU race condition protection verification
- **All 638 tests passing** (integration tests included)

### 📦 Infrastructure
- Added .npmignore for proper npm package publishing
- Added tsconfig.dev.json for development-specific builds
- Enhanced vitest.config.ts for better test isolation
- Added cleanup script for orphaned test processes
- Added TypeScript build artifacts to .gitignore

### ⚠️ Known Limitations
- Two architectural improvements deferred to v0.3.1:
  - Issue #20: EventBus type safety improvements
  - Issue #21: Dependency graph optimization for large-scale workflows

### 🔗 References
- PR #9: Task Dependencies v0.3.0 - Post-Review Fixes
- Comprehensive Review: .docs/reviews/feat-task-dependencies_2025-10-17_0933.md

## [0.2.1] - 2025-09-05

### 🚀 Major Features
- **🖥️ CLI Interface**: Direct task management without MCP connection
  - `beat run <prompt>`: Delegate tasks directly
  - `beat status [task-id]`: Check task status
  - `beat logs <task-id>`: Retrieve task output
  - `beat cancel <task-id> [reason]`: Cancel running tasks
- **🏗️ Event-Driven Architecture**: Complete architectural overhaul
  - EventBus-based coordination across all components
  - Event handlers for persistence, queue, worker, and output management
  - Zero direct state management in TaskManager

### 🛠️ Technical Improvements  
- **🔧 Process Handling**: Fixed Claude CLI stdin hanging issue
  - Replaced stdin hack with proper `stdio: ['ignore', 'pipe', 'pipe']`
  - Eliminated meaningless JSON injection to stdin
  - Robust process spawning without workarounds
- **🎯 Event System**: Comprehensive event-driven refactor
  - `TaskDelegated`, `TaskQueued`, `WorkerSpawned` events
  - Specialized event handlers for different concerns
  - Singleton EventBus shared across all components

### 🐛 Bug Fixes
- **Exit Code Handling**: Fixed critical bug where exit code 0 was converted to null
  - Changed `code || null` to `code ?? null` to preserve success status
  - Tasks now properly complete with success status
- **Output Capture**: Resolved Claude CLI hanging on stdin expectations
- **Event Emission**: Fixed missing TaskQueued events causing tasks to stay queued

### 📚 Documentation Updates
- **README.md**: Updated with event-driven architecture and CLI commands
- **CLAUDE.md**: Complete rewrite reflecting current implementation
- **FEATURES.md**: Added v0.2.1 features and event-driven patterns

### ⚠️ Breaking Changes
- **Internal Only**: All breaking changes are internal architecture improvements
- **API Compatibility**: All MCP tools remain fully compatible
- **CLI Addition**: New CLI commands are additive, not breaking

### 🔧 Developer Experience
- **Better Testing**: CLI commands enable testing without MCP reconnection
- **Cleaner Architecture**: Event-driven design eliminates race conditions
- **Improved Reliability**: Proper process handling prevents hanging

## [0.2.0] - 2025-09-02

### 🐛 Critical Bug Fixes
- **Task Resubmission Bug**: Fixed critical issue where tasks were resubmitted on every MCP server restart, causing Claude instances to crash
- **Duplicate Prevention**: Added `contains()` method to TaskQueue to prevent duplicate task processing
- **Database Recovery**: Improved RecoveryManager to only restore QUEUED/RUNNING tasks, not all tasks
- **Cleanup Logic**: Added automatic cleanup of old completed tasks (7 day retention) on startup
- **Output Buffer Logic**: Fixed bug where zero buffer size configurations were ignored due to falsy value handling

### 📚 Documentation Overhaul  
- **FEATURES.md**: New comprehensive documentation of all implemented features
- **ROADMAP.md**: Unified roadmap replacing 3+ conflicting versions
- **CHANGELOG.md**: Added proper version history and migration guides
- **Documentation Cleanup**: Archived outdated/conflicting documentation in `.docs/archive/`
- **README.md**: Updated to accurately reflect v0.2.1 capabilities
- **CLAUDE.md**: Updated with current architecture information

### 🛠️ Build & Development
- **Package Scripts**: Added missing npm scripts that were documented but didn't exist:
  - `npm run test:comprehensive` - Run tests with coverage
  - `npm run test:coverage` - Same as above for compatibility
  - `npm run validate` - Full validation pipeline (typecheck + build + test)
- **Configuration Examples**: Fixed MCP configuration examples to use correct entry points

### 💡 Technical Improvements
- **Mock Factories**: Updated test mock factories with new methods (cleanupOldTasks, contains)
- **Type Safety**: Enhanced TaskRepository and TaskQueue interfaces
- **Error Handling**: Better error separation in RecoveryManager

### 📝 Notes
- No breaking changes - fully backward compatible with v0.2.0
- All MCP tools continue to work exactly the same
- Database migration is automatic on first startup

## [0.2.0] - 2025-09-02

### 🚀 Added
- **Task Persistence**: SQLite database with automatic task recovery on startup
- **Autoscaling Manager**: Dynamic worker pool that scales based on CPU and memory
- **Recovery Manager**: Restores QUEUED/RUNNING tasks after crashes or restarts
- **Priority System**: P0 (Critical), P1 (High), P2 (Normal) task prioritization
- **Resource Monitoring**: Real-time CPU and memory usage tracking
- **Output Management**: Buffered output capture with file overflow
- **Configuration System**: Environment variable configuration with validation
- **Database Cleanup**: Automatic removal of old completed tasks (7 day retention)
- **Per-Task Configuration**: Override timeout and buffer size per task
- **Working Directory Support**: Run tasks in custom working directories
- **Task Status Tracking**: Complete lifecycle management (QUEUED → RUNNING → COMPLETED/FAILED/CANCELLED)

### 🛠️ Enhanced
- **MCP Tools**: All tools now support the full feature set
  - `DelegateTask`: Added priority, timeout, maxOutputBuffer, workingDirectory parameters
  - `TaskStatus`: Shows comprehensive task information including resource usage
  - `TaskLogs`: Added tail parameter for log output control
  - `CancelTask`: Proper task cancellation with cleanup
- **Error Handling**: Comprehensive Result pattern implementation
- **Logging**: Structured JSON logging with contextual information
- **CLI Interface**: Full CLI implementation with `mcp start`, `mcp test`, `mcp config` commands

### 🐛 Fixed  
- **Task Resubmission Bug**: Fixed critical bug where tasks were resubmitted on every MCP server restart
- **Duplicate Prevention**: Added checks to prevent duplicate task processing
- **Memory Leaks**: Proper cleanup of completed tasks and workers
- **Process Handling**: Improved process spawning and termination

### 📚 Documentation
- **FEATURES.md**: Comprehensive list of all implemented features
- **ROADMAP.md**: Unified development roadmap with accurate timelines
- **README.md**: Updated to reflect actual v0.2.0 capabilities
- **CLAUDE.md**: Updated with current architecture and implementation status
- **Documentation Cleanup**: Archived outdated/conflicting documentation

### ⚙️ Technical
- **Dependencies**: Zod schema validation for all inputs
- **Database**: SQLite with WAL mode for better concurrency
- **Architecture**: Clean dependency injection with Result types
- **Testing**: Comprehensive test suite with mock factories
- **Build**: TypeScript compilation with proper ES modules

---

## [0.1.0] - 2025-08-XX (Initial Release)

### 🚀 Added
- **Basic MCP Server**: Initial Model Context Protocol server implementation
- **Single Task Execution**: Basic task delegation to background Claude Code instances
- **Core MCP Tools**:
  - `DelegateTask`: Submit single task for execution
  - `TaskStatus`: Basic status checking
  - `TaskLogs`: Output retrieval
  - `CancelTask`: Task cancellation
- **Process Management**: Claude Code process spawning and monitoring
- **Output Capture**: Basic stdout/stderr capture
- **CLI Interface**: Basic command-line interface

### 📝 Notes
- Single-task execution only (no concurrency)
- In-memory state (no persistence)
- Basic error handling
- Limited configuration options

---

## Migration Guide

### Upgrading to v0.2.0

#### For New Users
- Install via npm: `npm install -g autobeat`
- Configure MCP: See [README.md](./README.md#configuration) for setup instructions
- No migration needed for new installations

#### For v0.1.0 Users
- **Task State**: All previous in-memory task state will be lost during upgrade
- **Configuration**: Check new environment variables in [README.md](./README.md#configuration)
- **MCP Tools**: Existing tool usage remains compatible, but new parameters are available
- **Database**: SQLite database will be created automatically on first run

#### Breaking Changes
- None - v0.2.0 is backward compatible with v0.1.0 MCP tool usage

---

## Support

- **Documentation**: See [README.md](./README.md) for setup and usage
- **Features**: See [FEATURES.md](./FEATURES.md) for complete feature list
- **Roadmap**: See [ROADMAP.md](./ROADMAP.md) for future plans
- **Issues**: Report bugs at [GitHub Issues](https://github.com/dean0x/autobeat/issues)
- **Discussions**: Feature requests at [GitHub Discussions](https://github.com/dean0x/autobeat/discussions)