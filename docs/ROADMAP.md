# Backbeat Development Roadmap

## Current Status: v0.5.0 ✅

**Status**: Released (2026-03-10)

Backbeat v0.5.0 adds multi-agent support — pluggable agent registry with adapters for Claude, Codex, and Gemini, per-task agent selection, `beat init` interactive setup, and comprehensive test coverage. See [FEATURES.md](./FEATURES.md) for complete list of current capabilities.

---

## Released Versions

### v0.4.0 - First Release as Backbeat ✅
**Status**: **RELEASED** to npm (2026-03-03)

Major features: task scheduling (cron/one-time), task resumption (checkpoints), session continuation (`continueFrom`), CLI detach mode, CLI UX overhaul (@clack/prompts), git/worktree removal, pagination, project rename (claudine → backbeat).

See [RELEASE_NOTES_v0.4.0.md](./releases/RELEASE_NOTES_v0.4.0.md) for full details.

### v0.3.0–v0.3.3 - Task Dependencies ✅
**Status**: **RELEASED**

DAG-based dependencies, cycle detection, TOCTOU protection, settling workers, graph corruption fix, pagination, configurable chain depth, DB constraints.

### v0.3.1 Optimization Items — Status

Items originally planned for v0.3.1 that were completed across v0.3.1–v0.4.0:

| Item | Status | Shipped In |
|------|--------|------------|
| Batch Dependency Resolution | ✅ Done | v0.3.1 |
| Multi-Dependency Transactions | ✅ Done | v0.3.1 (atomic `addDependencies()`) |
| Input Validation Limits (100 deps, 100 depth) | ✅ Done | v0.3.1 |
| Chain Depth Calculation (`getMaxDepth()`) | ✅ Done | v0.3.1 |
| Database CHECK Constraint (resolution column) | ✅ Done | v0.3.2 (migration v2) |
| Configurable Chain Depth Limit | ✅ Done | v0.3.2 |
| Handler Setup Extraction | ✅ Done | v0.4.0 (PR #42) |
| Pagination (`findAll()` default 100) | ✅ Done | v0.4.0 (PR #43) |
| Incremental Graph Updates | Open | — |
| Parallel Dependency Validation | Open | — |
| Transitive Query Memoization | Open | — |
| Remove Cycle Detection from Repository Layer | Open | — |
| Consolidate Graph Caching | Open | — |
| JSDoc Coverage for dependency APIs | Open | — |
| Failed/Cancelled Dependency Propagation Semantics | ✅ Done | v0.6.0 (cascade cancellation) |

Open items are low priority — they'll be addressed opportunistically or when performance demands it.

---

## Future Development

### v0.5.0 - Multi-Agent Support ✅
**Status**: **RELEASED** (2026-03-10)

Agent registry with pluggable adapters (Claude, Codex, Gemini), per-task agent selection, `beat init` interactive setup, `beat agents list`, default agent configuration, auth checking, and comprehensive test coverage (#54).

---

### v0.6.0 - Architectural Simplification + Bug Fixes
**Status**: 🎯 In Progress
**Issue**: [#105](https://github.com/dean0x/backbeat/issues/105)

Architectural simplification (hybrid event model, SQLite worker coordination, ReadOnlyContext CLI), scheduled pipelines, bug fixes, and tech debt cleanup.

#### Features (merged)
- Simplify Event System — replace 18 overhead events with direct calls (#91)
- SQLite worker coordination + output persistence (#94)
- ReadOnlyContext for lightweight CLI query commands (#100)
- Scheduled pipelines with dependency cascade fix (#78)
- `runInTransaction` for atomic multi-step DB operations (#85)

#### Remaining (bugs + tech debt)
1. #84 — RecoveryManager dependency checks (bug)
2. #82 — cancelTasks scope fix (bug)
3. #83 — ScheduleExecutor transaction wrapping (tech-debt)
4. #101 — Move OutputRepository to core/interfaces.ts (tech-debt)
5. #104 — BootstrapOptions mode enum (tech-debt)
6. #95 — Output totalSize fix (bug)

---

### v0.7.0 - Task/Pipeline Loops
**Goal**: Condition-driven iteration
**Priority**: High — completes the orchestration story
**Issue**: [#79](https://github.com/dean0x/backbeat/issues/79)

#### Task/Pipeline Loops (#79)
Repeat a task or pipeline until an exit condition is met — the [Ralph Wiggum Loop](https://ghuntley.com/loop/) pattern.

```bash
beat loop "implement next item from spec.md" \
  --until "npm test && npm run build" \
  --max-iterations 10
```

- Exit condition: shell command returning exit code 0
- Max iterations: required safety cap
- Fresh context per iteration (Ralph pattern) or continue from checkpoint
- Composable with schedules: "every night, loop until spec is done"

#### Builds On
- v0.4.0 schedules (cron/one-time), checkpoints, `continueFrom`
- v0.4.1 pipelines (`CreatePipeline`)
- v0.5.0 multi-agent per-task selection
- v0.6.0 architectural simplification + scheduled pipelines

---

### v0.8.0 - Agent Failover & Smart Routing
**Goal**: Automatic agent switching on rate limits, intelligent task routing
**Priority**: High — makes multi-agent practically useful

#### Features
- **Rate Limit Detection**: Per-agent signal parsing (stderr patterns, exit codes, API errors)
- **Automatic Failover**: When an agent hits limits mid-task, checkpoint and resume with a different agent
- **Failover Priority Chain**: User-defined agent preference order (e.g., claude → codex → gemini)
- **Smart Routing**: Route tasks based on complexity, cost, or agent strengths
- **Usage Tracking**: Track per-agent usage to predict limit exhaustion
- **Cooldown Management**: Track rate limit windows, re-enable agents when limits reset

#### Builds On
- v0.4.0 checkpoint/resumption system (`continueFrom`)
- v0.5.0 agent registry and adapters

---

### v0.9.0 - Workflow Recipes & Templates
**Goal**: Reusable multi-step workflows with predefined DAGs
**Priority**: Medium — power user productivity

#### Features
- **Recipe Definitions**: YAML/JSON workflow specifications
- **Recipe Registry**: Built-in and user-defined recipes
- **Variable Substitution**: Parameterize recipes with runtime values
- **Conditional Logic**: If/else branches based on task results
- **Recipe CLI**: `beat recipe run <name>` for one-command workflows
- **Recipe Sharing**: Export/import recipes between projects

#### Example Recipe
```yaml
name: pr-review
description: "Lint, test, review, and summarize a PR"
variables:
  branch: { required: true }
tasks:
  - name: lint
    prompt: "Run linter on {{branch}} and fix issues"
    agent: claude

  - name: test
    prompt: "Run test suite, fix failures"
    agent: claude
    dependsOn: [lint]

  - name: review
    prompt: "Review changes on {{branch}} for security and quality"
    agent: claude
    dependsOn: [test]
    continueFrom: test

  - name: summarize
    prompt: "Write a PR summary based on review findings"
    agent: claude
    dependsOn: [review]
    continueFrom: review
```

#### CLI
```bash
beat recipe list
beat recipe run pr-review --branch feature/auth
beat recipe run refactor --target src/services/
beat recipe create my-workflow  # interactive recipe builder
```

#### Builds On
- v0.4.0 task dependencies (DAG), scheduling, `continueFrom`
- v0.5.0 per-task agent selection
- v0.7.0 task/pipeline loops, loops

---

### v0.10.0 - Monitoring & REST API
**Goal**: Production observability and external integrations
**Priority**: Medium — production readiness

#### Features
- **TUI Dashboard**: Terminal UI showing running tasks, agents, output streams, resource usage
- **REST API**: HTTP API alongside MCP for non-MCP clients (OpenAPI spec)
- **Metrics**: Task completion rates, execution times, agent usage, failover frequency
- **Notifications**: Slack/email/webhook alerts on task completion or failure
- **Audit Logging**: Complete audit trail for all operations
- **Multi-User Support**: User authentication and task isolation

---

### v1.0.0 - Distributed Processing
**Goal**: Scale across multiple servers for enterprise deployments
**Priority**: Low — when there's actual demand

#### Features
- **Multi-Server Support**: Distribute tasks across Backbeat instances
- **Shared State**: Centralized task queue (Redis backend)
- **Fault Tolerance**: Automatic failover on server failures
- **Server Discovery**: Registration and health checks
- **Task Affinity**: Route related tasks to the same server

---

## Research & Experimentation

### Future Investigations
- **Smart Task Splitting**: Break large tasks into smaller parallel units
- **Result Aggregation**: Fan-out same task to multiple agents, compare results
- **Resource Prediction**: Predict agent resource needs based on prompt analysis
- **Auto-Recovery**: Intelligent retry strategies based on failure classification
- **Mid-Task Checkpoints**: Capture checkpoints during execution, not just at terminal states

### Community Requests
- **Windows Support**: Better Windows compatibility and testing
- **Docker Integration**: Containerized task execution
- **Plugin System**: Custom task executors and integrations

---

## Version Timeline

| Version | Status | Focus |
|---------|--------|-------|
| v0.2.0 | ✅ Released | Autoscaling + Persistence |
| v0.2.1 | ✅ Released | Event-driven Architecture |
| v0.3.0 | ✅ Released | Task Dependencies (DAG) |
| v0.3.1–3 | ✅ Released | Dependency optimizations + security |
| v0.4.0 | ✅ Released | Scheduling, Resumption, Rename to Backbeat |
| v0.5.0 | ✅ Released | Multi-Agent Support |
| v0.6.0 | 🎯 In Progress | Architectural Simplification + Bug Fixes |
| v0.7.0 | 📋 Planned | Task/Pipeline Loops |
| v0.8.0 | 📋 Planned | Agent Failover + Smart Routing |
| v0.9.0 | 📋 Planned | Workflow Recipes & Templates |
| v0.10.0 | 💭 Research | Monitoring + REST API + Dashboard |
| v1.0.0 | 💭 Research | Distributed Processing |

---

## Contributing to the Roadmap

### How to Request Features
1. **Create Issue**: Use GitHub issues with feature request template
2. **Community Discussion**: Discuss in GitHub Discussions
3. **Use Cases**: Provide concrete examples of how you'd use the feature

For questions about the roadmap, please open a [GitHub Discussion](https://github.com/dean0x/backbeat/discussions).
