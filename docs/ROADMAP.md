# Autobeat Development Roadmap

## Current Status: v1.1.0 RELEASED (2026-04-01)

Agent eval mode, skill system, and skill installer. Built on top of v1.0.0's autonomous orchestration.

---

## Released Versions

### v0.8.2 - Package Rename ✅
**Status**: **RELEASED** (2026-03-26)

Renamed backbeat → autobeat across the entire codebase and npm registry. CLI binary `beat` unchanged.

### v0.8.0–v0.8.1 - Loop Enhancements + Git Integration ✅
**Status**: **RELEASED** (2026-03-25/26)

Loop pause/resume, scheduled loops, git integration (commit-per-iteration, revert on failure), O(1) reset target.

### v0.7.0 - Task/Pipeline Loops ✅
**Status**: **RELEASED** (2026-03-21)

Condition-driven iteration — retry strategy (`--until`) and optimize strategy (`--eval --direction minimize/maximize`). Pipeline loops repeat multi-step workflows. The [Ralph Loop](https://ghuntley.com/loop/) pattern as a first-class primitive.

### v0.6.0 - Architectural Simplification ✅
**Status**: **RELEASED** (2026-03-20)

Hybrid event model, SQLite worker coordination, ReadOnlyContext CLI, scheduled pipelines, bug fixes, tech debt cleanup.

### v0.5.0 - Multi-Agent Support ✅
**Status**: **RELEASED** (2026-03-10)

Agent registry with pluggable adapters (Claude, Codex, Gemini), per-task agent selection, `beat init` interactive setup.

### v0.4.0 - Scheduling + Resumption ✅
**Status**: **RELEASED** (2026-03-03)

Task scheduling (cron/one-time), checkpoints, session continuation (`continueFrom`), CLI detach mode, CLI UX overhaul.

### v0.3.0–v0.3.3 - Task Dependencies ✅
**Status**: **RELEASED**

DAG-based dependencies, cycle detection, TOCTOU protection, failure cascading, pagination, configurable chain depth.

### v0.2.0–v0.2.1 - Foundation ✅
**Status**: **RELEASED**

Autoscaling workers, event-driven architecture, SQLite persistence.

---

### v1.1.0 - Agent Eval Mode & Skill System ✅
**Status**: **RELEASED** (2026-04-01)

Agent eval mode for loop exit conditions (AI judges pass/fail instead of shell commands). Agent orchestration skill with structured reference files. Skill installer via `beat init --install-skills`. MCP instructions and ConfigureAgent/ListAgents tools.

## v1.0.0 - Autonomous Orchestration

**Status**: **RELEASED** (2026-03-28)

The flagship feature: a meta-agent that uses Autobeat's own infrastructure recursively. Give it a goal, walk away, come back to finished work.

```bash
beat orchestrate "Build a complete auth system with JWT, OAuth2, and MFA"
```

### What It Does

The orchestrator is a loop that runs a lead agent whose system prompt gives it access to all of Autobeat's MCP tools. Each iteration, the agent:

1. Reads its persistent state file (plan, worker status, iteration history)
2. Breaks the goal into subtasks and delegates to worker agents via `DelegateTask`
3. Uses task dependencies (`dependsOn`) to enforce execution ordering
4. Monitors worker progress with `TaskStatus` and `TaskLogs`
5. Creates eval loops (`CreateLoop`) for tasks that need verification
6. Retries or adjusts failed workers with enriched context
7. Updates its state file and continues until the goal is met

### Features Delivered

- **CLI**: `beat orchestrate`, `beat orchestrate status`, `beat orchestrate list`, `beat orchestrate cancel`
- **MCP Tools**: `Orchestrate`, `OrchestrationStatus`, `ListOrchestrations`, `CancelOrchestration`
- **Detach Mode**: Fire-and-forget background orchestration with log polling
- **Foreground Mode**: Blocking mode with SIGINT cancellation support
- **State File**: Persistent JSON state file with plan, steps, iteration history
- **Guardrails**: `maxDepth`, `maxWorkers`, `maxIterations` safety limits
- **Crash Recovery**: Full SQLite persistence with startup recovery
- **Multi-Agent**: Per-orchestration agent selection (Claude, Codex, Gemini)
- **Event-Driven**: `OrchestrationCreated`, `OrchestrationCompleted`, `OrchestrationCancelled` events
- **Test Coverage**: 77 orchestration tests across unit, handler, repository, and integration suites

### Design Philosophy

The competitive landscape builds infrastructure the agent could do itself — worktree management, CI parsing, PR automation, inter-agent messaging. Every line of that code becomes technical debt as models improve.

Autobeat's bet is the opposite: **the thinnest possible orchestration layer** that trusts the agent. What Autobeat provides:

1. **The loop primitive** — run, evaluate, iterate
2. **The delegation primitive** — spawn background agents with dependency ordering
3. **The persistence primitive** — crash-proof state that survives restarts
4. **The orchestrator agent** — a meta-agent that uses all three primitives to self-organize

Everything else — worktrees, CI, PRs, code review, testing, deployment — is the agent's job. As models get smarter, the framework automatically gets more powerful without changing a line of code.

---

## Post-v1 — Future Development

### Agent Failover & Smart Routing
Automatic agent switching on rate limits, intelligent task routing based on complexity/cost/agent strengths, cooldown management.

### Workflow Recipes & Templates
Reusable YAML/JSON workflow specifications with variable substitution, conditional logic, and a recipe registry.

### Monitoring & REST API
TUI dashboard, REST API alongside MCP, metrics, Slack/webhook notifications, audit logging.

### Distributed Processing
Multi-server support, shared state (Redis backend), fault tolerance, task affinity.

---

## Research & Experimentation

- **Smart Task Splitting**: Break large tasks into smaller parallel units
- **Result Aggregation**: Fan-out same task to multiple agents, compare results
- **Cost Tracking**: Token usage and estimated cost across orchestrations
- **Docker Sandboxing**: Containerized task execution for isolation
- **Issue Tracker Integration**: Feed GitHub/Linear issues directly to orchestrator

---

## Version Timeline

| Version | Status | Focus |
|---------|--------|-------|
| v0.2.0–v0.2.1 | ✅ Released | Foundation (autoscaling, events, persistence) |
| v0.3.0–v0.3.3 | ✅ Released | Task Dependencies (DAG) |
| v0.4.0 | ✅ Released | Scheduling, Resumption, CLI |
| v0.5.0 | ✅ Released | Multi-Agent Support |
| v0.6.0 | ✅ Released | Architectural Simplification |
| v0.7.0 | ✅ Released | Task/Pipeline Loops |
| v0.8.0–v0.8.2 | ✅ Released | Loop Enhancements, Git Integration, Rename |
| **v1.0.0** | ✅ Released | **Autonomous Orchestration** |
| **v1.1.0** | ✅ Released | **Agent Eval Mode & Skill System** |

---

## Contributing

1. **Create Issue**: Use GitHub issues with feature request template
2. **Community Discussion**: Discuss in GitHub Discussions
3. **Use Cases**: Provide concrete examples of how you'd use the feature

For questions about the roadmap, please open a [GitHub Discussion](https://github.com/dean0x/autobeat/discussions).
