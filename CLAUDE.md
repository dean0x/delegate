# CLAUDE.md

This file provides project-specific guidance for Claude Code when working on Autobeat.

## Project Overview

Autobeat is an MCP (Model Context Protocol) server that enables task delegation to background Claude Code instances. It uses hybrid event-driven architecture with workers, task dependencies (DAG-based), and SQLite persistence.

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
- Vitest config: `pool: 'forks'` with `vmMemoryLimit: '1024MB'` — hard-kills forks at 1GB, OS reclaims instantly
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
- `LoopHandler` → loop iteration engine (retry/optimize strategies, exit condition evaluation)
- `UsageCaptureHandler` → captures Claude token/cost usage on TaskCompleted, writes to `task_usage` via UsageParser

See `docs/architecture/` for implementation details.

## Task Dependencies (v0.3.0+)

Tasks can depend on other tasks using the `dependsOn` field:
- DAG validation prevents cycles (A→B→A)
- Tasks block until dependencies complete
- Cycle detection uses DFS algorithm in `DependencyGraph`
- TOCTOU protection via synchronous SQLite transactions

See `docs/TASK-DEPENDENCIES.md` for usage patterns.

## Release Process

A mechanical, execution-ready recipe for cutting a release. Follow top-to-bottom.

### 0. Pre-Flight Checks

Before starting a release, verify:

- [ ] On `main` branch with clean working tree
- [ ] `git pull origin main` — up to date
- [ ] `npm whoami` — authenticated to npm
- [ ] `npm view autobeat version` — confirms last published version
- [ ] `gh auth status` — authenticated to GitHub
- [ ] No open release PRs or in-flight workflow runs

### 1. Version Decision Matrix

| Bump | Example | When |
|------|---------|------|
| `patch` | 1.2.0 → 1.2.1 | Bug fixes only, no new user-facing behavior |
| `minor` | 1.2.0 → 1.3.0 | Additive features, no breaking changes |
| `major` | 1.2.0 → 2.0.0 | Breaking changes to APIs, CLI, config, or data format |

### 2. Files to Update

| File | Required? | Note |
|------|-----------|------|
| `package.json` + `package-lock.json` | ✅ | Use `npm version <bump> --no-git-tag-version` (updates both atomically) |
| `docs/releases/RELEASE_NOTES_v<version>.md` | ✅ | Release workflow hard-fails without it |
| `CHANGELOG.md` | ✅ | Add `## [<version>] - <date>` entry **immediately below** the `[Unreleased]` section and its `---` separator (keep `[Unreleased]` as empty placeholder per Keep-a-Changelog) |
| `docs/releases/RELEASE_NOTES.md` | ✅ | Update latest/previous lists |
| `docs/FEATURES.md` | ✅ minor/major, skip patch | Add `## ✅ <Feature> (v<version>)` section, update "Last Updated" header. Patch releases: skip unless the fix changes user-visible behavior |
| `docs/ROADMAP.md` | ✅ minor/major, skip patch | Update current status, add to Released Versions, remove delivered items from upcoming sections. Patch releases: skip unless the fix changes user-visible behavior |
| `README.md` | Only if pinned version references change | `grep 'autobeat@' README.md` first |
| `CLAUDE.md` MCP tools list | Only if new MCP tools added | Check `src/adapters/mcp-adapter.ts` — existing tools with new params don't require updates |
| `skills/autobeat/` | Only if skill files change | Rarely updated per release |

### 3. Release Notes Template

Use `docs/releases/RELEASE_NOTES_v1.1.0.md` or `RELEASE_NOTES_v1.2.0.md` as canonical examples. Required sections:

1. **Title**: `# Autobeat v<version> — <tagline>`
2. **Feature sections** with code examples (CLI, MCP, config)
3. **Architecture** notes (new modules, data flow)
4. **Database** section listing any migrations
5. **What's Changed Since v<prev>**: bulleted PR list with `#123` links
6. **Migration Notes**: breaking changes, auto-applied migrations, user actions
7. **Installation**: `npm install -g autobeat@<version>` + npx MCP snippet
8. **Links**: npm, docs, issues

### 4. Pre-Release Validation (Claude Code-safe)

```bash
npm run typecheck && npm run check && npm run build
# Grouped tests — SAFE in Claude Code (npm test is BLOCKED by safeguard):
npm run test:core && npm run test:handlers && npm run test:services && \
  npm run test:repositories && npm run test:adapters && \
  npm run test:implementations && npm run test:cli && \
  npm run test:dashboard && npm run test:scheduling && \
  npm run test:checkpoints && npm run test:error-scenarios && \
  npm run test:orchestration && npm run test:integration
```

CI runs the full `npm run test:all` in the release workflow — do not attempt it from Claude Code.

### 5. Snyk Scan (best-effort)

Run `mcp__Snyk__snyk_code_scan` on `src/` with `severity_threshold: medium`.

- **Quota / auth / rate-limit failure**: log and continue — do not block release
- **High/Critical findings introduced by new code**: stop, fix, re-scan
- **Medium/Low findings**: note in PR description; do not block

Pre-existing findings in unchanged code paths are not regressions — continue. To distinguish: run `git diff v<prev>..HEAD -- <flagged file>`. Unchanged files = pre-existing findings, note and continue. Changed files = potentially introduced, evaluate and fix if High/Critical.

### 6. Commit / PR / Merge

```bash
git checkout -b release/v<version>
# make all file edits above
git add package.json package-lock.json CHANGELOG.md \
        docs/releases/RELEASE_NOTES_v<version>.md \
        docs/releases/RELEASE_NOTES.md \
        docs/FEATURES.md docs/ROADMAP.md CLAUDE.md

git commit -m "chore: release v<version> — <tagline>"
git push -u origin release/v<version>

gh pr create --title "chore: release v<version>" --body "..."
```

Merge: `gh pr merge --squash` (use `--admin` if branch protection blocks and no reviewer is available for a release PR).

### 7. Trigger Release Workflow

```bash
git checkout main && git pull origin main
gh workflow run release.yml --ref main

# Poll for completion
gh run watch $(gh run list --workflow=release.yml --branch=main --limit=1 --json databaseId --jq '.[0].databaseId')
```

### 8. Post-Release Verification

```bash
npm view autobeat version                    # must print <version>
gh release view v<version>                   # must exist with notes
git fetch --tags && git tag -l v<version>    # must exist locally
gh run list --workflow=release.yml --limit=1 # must show status: completed/success
```

### 9. Gotchas

- **Release workflow is `workflow_dispatch` only.** Merging to main does NOT publish. Publishing requires an explicit `gh workflow run release.yml --ref main`.
- **`package.json` version must be bumped BEFORE triggering the workflow.** The workflow hard-fails if `npm view autobeat version` equals `package.json` version.
- **Release notes file must exist** with exact name `RELEASE_NOTES_v<version>.md` in `docs/releases/` before triggering the workflow.
- **`npm test` is BLOCKED in Claude Code** by a safeguard script. Use grouped suites (`test:core`, `test:handlers`, etc.). Full `test:all` runs in CI and the release workflow.
- **Orphan published version recovery** — three failure modes:
  1. Fails **before** `npm publish` → re-run the workflow
  2. `npm publish` succeeds, `git tag` fails → manual tag + release:
     ```bash
     git tag v<version> && git push origin v<version>
     gh release create v<version> --notes-file docs/releases/RELEASE_NOTES_v<version>.md
     ```
  3. Tag succeeds, GitHub release fails → `gh release create v<version> --notes-file docs/releases/RELEASE_NOTES_v<version>.md`
- **Branch protection on `main`**: Release PRs may require `gh pr merge --squash --admin` if no reviewer is available. Use sparingly and only for release chores.
- **Consolidating skipped versions**: If multiple version bumps landed without publishing, pick the lowest unpublished version. Merge all CHANGELOG sections, release notes, FEATURES/ROADMAP entries. Delete release notes files for folded versions. Update source code version comments to match the chosen version.
- **Release notes index validation**: Verify the index matches the files on disk:
  ```bash
  diff <(ls docs/releases/RELEASE_NOTES_v*.md | sed 's|.*/RELEASE_NOTES_||;s|\.md||' | sort -V) \
       <(grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' docs/releases/RELEASE_NOTES.md | sort -V | uniq)
  ```

### 10. Release Infrastructure

Safety nets that exist in the codebase but are not part of the manual release steps:

- **`prepublishOnly` script** (`package.json`): Runs `npm run build && test -f dist/cli.js` — prevents `npm publish` if the build fails silently. If this fails, fix the build before retrying.
- **`.npmignore`**: Controls what ships to npm (excludes tests, source maps, dev configs, `.github/`). If adding new file categories, verify they appear/don't appear in the published package.
- **`publishConfig: { "access": "public" }`** (`package.json`): Ensures scoped package publishes publicly. Removing this causes `npm publish` to fail with 402 for non-paid scopes.
- **CI workflow (`ci.yml`)**: Runs typecheck + lint + build + full test suite on every push to main and PRs. This is an implicit gate before any release branch merges.
- **Pre-flight script** (`scripts/release-preflight.sh`): Validates auth, branch state, version bump, release notes existence, and runs build pipeline. Run before starting any release.

## Project-Specific Guidelines

### Testing

- **Technical Safeguard**: `npm test` is blocked and prints a warning (prevents accidental crashes)
- **Use individual groups** from Claude Code: `npm run test:core`, `test:handlers`, etc.
- **Full suite**: `npm run test:all` (only in local terminal/CI)
- **Pool strategy**: `pool: 'forks'` — each worker is a separate OS process; `vmMemoryLimit` kills and replaces forks cleanly
- **Memory limit**: `vmMemoryLimit: '1024MB'` in vitest.config.ts — hard-kills forks at 1GB, OS reclaims instantly
- **Tests are sequential** via vitest config (`maxWorkers: 1`, `isolate: false`)
- **All commands use 2GB** memory limit (`--max-old-space-size=2048`)
- **No real process spawning** - all tests use mocks (MockWorkerPool, MockProcessSpawner)

### Database

- SQLite with WAL mode for concurrent access
- All mutations go through event handlers (PersistenceHandler, DependencyHandler)
- Use synchronous transactions for TOCTOU protection (cycle detection)
- `workers` table: active worker registrations with ownerPid for crash detection (migration v9)
- `schedules` table: schedule definitions, cron/one-time config, status, timezone
- `schedule_executions` table: execution history and audit trail
- `loops` table: loop definitions, strategy, exit condition, iteration state (migration v10)
- `loop_iterations` table: per-iteration execution records with scores and results (migration v10)
- `tasks.orchestrator_id` column: nullable FK for sub-task attribution to an orchestration (migration v18)
- `task_usage` table: one row per task with input/output/cache tokens and total_cost_usd (migration v19)

### Dependencies

When adding task dependencies:
- Always validate DAG (use `DependencyGraph.wouldCreateCycle()`)
- Use synchronous `db.transaction()` for atomicity
- Emit `TaskDependencyAdded`, `TaskUnblocked` events

### MCP Tools

All tools use PascalCase: `DelegateTask`, `TaskStatus`, `TaskLogs`, `CancelTask`, `RetryTask`, `ResumeTask`, `CreatePipeline`, `CreateLoop`, `LoopStatus`, `ListLoops`, `CancelLoop`, `PauseLoop`, `ResumeLoop`, `ScheduleTask`, `SchedulePipeline`, `ScheduleLoop`, `ListSchedules`, `ScheduleStatus`, `PauseSchedule`, `ResumeSchedule`, `CancelSchedule`, `CreateOrchestrator`, `OrchestratorStatus`, `ListOrchestrators`, `CancelOrchestrator`, `ListAgents`, `ConfigureAgent`

`DelegateTask` accepts an optional `metadata.orchestratorId` field for orchestrator attribution. Long-running MCP servers should pass this so sub-tasks are attributed to the calling orchestration even when the process ID changes across restarts.

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
| MCP instructions | `src/adapters/mcp-instructions.ts` |
| CLI | `src/cli.ts` |
| Worker repository | `src/implementations/worker-repository.ts` |
| Schedule repository | `src/implementations/schedule-repository.ts` |
| Schedule handler | `src/services/handlers/schedule-handler.ts` |
| Schedule executor | `src/services/schedule-executor.ts` |
| Schedule manager | `src/services/schedule-manager.ts` |
| Cron utilities | `src/utils/cron.ts` |
| Loop repository | `src/implementations/loop-repository.ts` |
| Loop handler | `src/services/handlers/loop-handler.ts` |
| Loop manager | `src/services/loop-manager.ts` |
| Agent exit condition evaluator | `src/services/agent-exit-condition-evaluator.ts` |
| Composite exit condition evaluator | `src/services/composite-exit-condition-evaluator.ts` |
| Migrate command | `src/cli/commands/migrate.ts` |
| Agent skill content | `skills/autobeat/` |
| Metrics view | `src/cli/dashboard/views/metrics-view.tsx` |
| Workspace view | `src/cli/dashboard/views/workspace-view.tsx` |
| Terminal size hook | `src/cli/dashboard/use-terminal-size.ts` |
| Responsive layout | `src/cli/dashboard/layout.ts` |
| Output streaming hook | `src/cli/dashboard/use-task-output-stream.ts` |
| Activity feed helper | `src/cli/dashboard/activity-feed.ts` |
| Usage repository | `src/implementations/usage-repository.ts` |
| Usage parser | `src/services/usage-parser.ts` |
| Usage capture handler | `src/services/handlers/usage-capture-handler.ts` |
| Keyboard handlers | `src/cli/dashboard/keyboard/` |

## Documentation Structure

- `README.md` - User-facing quick start
- `docs/FEATURES.md` - Complete feature list
- `docs/TASK-DEPENDENCIES.md` - Task dependencies API
- `docs/architecture/` - Architecture documentation
- `docs/releases/` - Release notes by version
- `docs/ROADMAP.md` - Future plans

---

**Note**: General engineering principles (Result types, DI, immutability, etc.) are defined in your global `~/.claude/CLAUDE.md`. This file contains only Autobeat-specific guidance.
