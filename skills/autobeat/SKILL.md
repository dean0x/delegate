---
name: autobeat
description: >-
  Use when delegating work to background agents, creating workflows, choosing
  between autobeat primitives (tasks, pipelines, loops, orchestrations, schedules),
  monitoring progress, or troubleshooting failures.
user-invocable: false
allowed-tools: Read, Grep, Glob
---

# Autobeat Agent Orchestration

Autobeat lets you delegate work to background AI agent instances, build task pipelines,
create iterative loops, schedule recurring work, and run autonomous orchestrations.
Three runtimes supported: Claude, Codex, Gemini.

## Iron Law

> **USE THE SIMPLEST PRIMITIVE THAT FITS**
>
> Single task beats pipeline. Pipeline beats loop. Loop beats orchestrator.
> Each level adds overhead and complexity — only escalate when the simpler
> primitive genuinely cannot express your intent. If you catch yourself building
> a pipeline with one step, use a task. If you're manually wiring 5 sequential
> tasks with dependsOn, use a pipeline.

## When This Skill Activates

- Delegating work to background agents
- Choosing between tasks, pipelines, loops, schedules, or orchestrations
- Building multi-step workflows or dependency graphs
- Setting up iterative improvement (retry/optimize loops)
- Monitoring task progress or troubleshooting failures
- Scheduling recurring work

## Capability Hierarchy

Use this decision tree to pick the right primitive:

```
Is it a single, self-contained piece of work?
  YES → DelegateTask (single task)

Is it a fixed sequence of steps?
  YES → How many steps?
    2-20 → CreatePipeline
    >20  → Break into multiple pipelines or use orchestrator

Does it need iterative improvement?
  YES → Is the exit condition objective (shell exit code / script score)?
    YES → CreateLoop with evalMode: shell
    NO  → CreateLoop with evalMode: agent (AI judges quality)

Is the goal open-ended and complex?
  YES → CreateOrchestrator (autonomous planning + delegation)

Should it run on a schedule?
  YES → Wrap any of the above: ScheduleTask, SchedulePipeline, ScheduleLoop
```

### Primitive Comparison

| Primitive | Use When | Complexity | Autonomy |
|-----------|----------|-----------|----------|
| Task | Single work item | Lowest | None |
| Pipeline | Fixed sequence (2-20 steps) | Low | None |
| Loop | Iterative improvement | Medium | Exit condition only |
| Orchestrator | Open-ended goals | Highest | Full (plans + delegates) |
| Schedule | Any of the above, recurring/deferred | +1 layer | Timer-driven |

## Quick Reference

### MCP Tools

| Tool | Purpose |
|------|---------|
| `DelegateTask` | Run a single task in a background agent |
| `TaskStatus` | Check task status (omit taskId for all) |
| `TaskLogs` | Read stdout/stderr from a task |
| `CancelTask` | Cancel a running task |
| `RetryTask` | Re-run a failed/completed task |
| `ResumeTask` | Resume from checkpoint with context |
| `CreatePipeline` | Sequential task chain (2-20 steps) |
| `CreateLoop` | Iterative retry/optimize loop |
| `LoopStatus` | Check loop progress and history |
| `ListLoops` | List loops with status filter |
| `CancelLoop` | Cancel an active loop |
| `PauseLoop` | Pause a loop mid-iteration |
| `ResumeLoop` | Resume a paused loop |
| `ScheduleTask` | Schedule a task (cron or one-time) |
| `SchedulePipeline` | Schedule a recurring pipeline |
| `ScheduleLoop` | Schedule a recurring loop |
| `ListSchedules` | List schedules with status filter |
| `ScheduleStatus` | Get schedule details + history |
| `PauseSchedule` | Pause a schedule |
| `ResumeSchedule` | Resume a paused schedule |
| `CancelSchedule` | Cancel a schedule |
| `CreateOrchestrator` | Autonomous goal execution |
| `OrchestratorStatus` | Check orchestration progress |
| `ListOrchestrators` | List orchestrations |
| `CancelOrchestrator` | Cancel an orchestration |
| `ListAgents` | List available agents with auth status |
| `ConfigureAgent` | Check auth, store/reset API keys |

### CLI Commands

| Command | Purpose |
|---------|---------|
| `beat run "<prompt>"` | Delegate a task |
| `beat status [task-id]` | Check task status |
| `beat logs <task-id>` | Read task output |
| `beat cancel <task-id>` | Cancel a task |
| `beat resume <task-id>` | Resume from checkpoint |
| `beat pipeline "<step1>" --delay 5m "<step2>"` | Create pipeline |
| `beat loop "<prompt>" --until "<cmd>"` | Retry loop |
| `beat loop "<prompt>" --eval "<cmd>" --maximize` | Optimize loop |
| `beat loop "<prompt>" --eval-mode agent --strategy retry` | Agent eval loop |
| `beat schedule create "<prompt>" --cron "0 9 * * *"` | Cron schedule |
| `beat orchestrate "<goal>"` | Start orchestration |
| `beat orchestrate status <id>` | Check orchestration |

## Composition Patterns

**Pipeline-in-Loop**: Repeat a multi-step pipeline until quality passes.
```
CreateLoop { pipelineSteps: ["lint", "test", "build"], strategy: "retry", exitCondition: "npm test" }
```

**Loop-in-Schedule**: Run an optimization loop daily.
```
ScheduleLoop { strategy: "optimize", cronExpression: "0 2 * * *", ... }
```

**Task Dependencies (manual DAG)**: Fan-out, then fan-in.
```
A = DelegateTask("generate data")
B = DelegateTask("process subset 1", dependsOn: [A])
C = DelegateTask("process subset 2", dependsOn: [A])
D = DelegateTask("merge results", dependsOn: [B, C], continueFrom: B)
```

## Anti-Patterns

| Mistake | Why It's Wrong | Fix |
|---------|---------------|-----|
| Pipeline with 1 step | Unnecessary overhead | Use DelegateTask |
| Manual dependsOn chain for sequential tasks | Error-prone wiring | Use CreatePipeline |
| Loop without exit condition (shell mode) | Runs forever | Set exitCondition or use evalMode: agent |
| Orchestrator for simple sequences | Overkill | Use Pipeline or Loop |
| Polling TaskStatus in a tight loop | Wastes resources | Check periodically (30s+) |
| Ignoring workingDirectory | Tasks run in wrong directory | Always set workingDirectory |
| Unlimited maxIterations with no failures cap | Risk of infinite loop | Set maxIterations or maxConsecutiveFailures |

## Extended References

Load these for deep dives on specific capabilities:

- **[orchestration.md](references/orchestration.md)** — Choosing primitives, composition patterns, orchestrator guardrails. Load when planning complex workflows.
- **[loops.md](references/loops.md)** — Retry/optimize strategies, agent eval mode, git integration, recipes. Load when creating loops.
- **[dependencies.md](references/dependencies.md)** — DAGs, pipelines, context passing, failure cascade. Load when wiring task dependencies.
- **[monitoring.md](references/monitoring.md)** — Status checking, recovery, troubleshooting. Load when monitoring or debugging.
- **[capability-matrix.md](references/capability-matrix.md)** — Complete parameter tables for all MCP tools and CLI commands. Load for exact parameter names and defaults.
