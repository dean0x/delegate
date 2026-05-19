# Autobeat Orchestrator Mode: Architecture & Design

## Part 1: What Exists Today (It's More Than You Think)

After digging into the actual codebase, Autobeat already has **most of the building blocks** for autonomous orchestration. The initial competitive analysis undersold this significantly. Here's what's actually there:

### Existing Infrastructure (Ready to Use)

**1. Background Task Execution (DelegateTask)**
The core primitive is already built. `DelegateTask` spawns a background coding agent instance, assigns it a prompt, and tracks its lifecycle through `Queued → Running → Completed/Failed/Cancelled`. This is the foundation — you can fire off agents and they work independently.

**2. DAG Task Dependencies**
Full directed acyclic graph with cycle detection (DFS algorithm), failure cascading, and session continuation. Tasks can declare `dependsOn: [taskId1, taskId2]` and they block until dependencies complete. This means multi-step workflows *already work* — the orchestrator agent can create a dependency chain and let the system handle execution ordering.

**3. Checkpoint Context Injection (continueFrom)**
When you set `continueFrom: taskId`, the dependent task's prompt is automatically enriched with the parent's checkpoint context (last 50 lines of output, git state, errors). This is the inter-agent communication mechanism — no SQLite mail system needed. Agent B reads Agent A's output because Autobeat injects it into the prompt.

**4. Eval Loops with Scoring (CreateLoop)**
Both retry strategy (`--until "npm test"`) and optimize strategy (`--eval "node measure.js" --direction minimize/maximize`). Loops track iteration history, support pause/resume, and enforce safety limits. This is the quality verification layer.

**5. Pipeline Orchestration (CreatePipeline)**
Sequential multi-step pipelines where each step can use a different agent (Claude for architecture, Codex for implementation, Gemini for review). Steps can have per-step priority, working directory, and agent overrides.

**6. Scheduling (ScheduleTask)**
Cron-based and one-time scheduling with timezone support, missed run policies, and concurrent execution prevention. This enables continuous autonomous operation.

**7. SQLite Persistence with WAL Mode**
Crash-proof state. Kill the process, reboot, come back — everything resumes. This is what Zeroshot's SQLite ledger does, and Autobeat already has it.

**8. Autoscaling Workers**
Dynamic worker pool monitors CPU and memory in real-time, spawning agents when resources are available. This is fleet management infrastructure.

**9. Event-Driven Architecture**
Central EventBus with specialized handlers (DependencyHandler, QueueHandler, WorkerHandler, PersistenceHandler, ScheduleHandler, LoopHandler). Events flow through these handlers, eliminating race conditions. This is the backbone for adding new orchestration behaviors.

**10. MCP Server Interface**
Autobeat runs as an MCP server — meaning any MCP-compatible coding agent (Claude Code, etc.) can call its tools programmatically. **This is the critical piece**: an orchestrator agent running in Claude Code can call `DelegateTask`, `CreateLoop`, `TaskStatus`, `CreatePipeline` etc. as MCP tools.

### What This Means

The orchestrator agent doesn't need new infrastructure. It needs **a system prompt and an entry point** that tells it: "You are an orchestrator. You have these MCP tools available. Break the task down. Use DelegateTask to spawn workers. Use CreateLoop to add eval gates. Use TaskStatus to monitor progress. Use the checkpoint/continueFrom system to chain agent outputs."

Autobeat isn't missing features — it's missing the **meta-layer** that uses its own tools recursively.

---

## Part 2: What's Actually Missing (The Gap Is Small)

Only a few things need to be built for the orchestrator vision:

### 1. Orchestrator Entry Point

**What:** A new CLI command and MCP tool: `beat orchestrate "build the auth system"` or `Orchestrate({ goal: "...", strategy: "autonomous" })`

**Why:** Currently, a human decides what to delegate, what loops to create, what pipelines to build. The orchestrator mode makes an agent be the human — it receives a high-level goal and autonomously creates tasks, loops, pipelines, and dependencies using Autobeat's existing tools.

**How it works:**
```
beat orchestrate "Build a complete auth system with JWT, OAuth2, and MFA"
```

This spawns a lead orchestrator agent whose system prompt says:

> You are an autonomous software engineering orchestrator. You have access to the Autobeat MCP tools. Your job is to break down the goal into subtasks, delegate them to worker agents, monitor their progress, validate the integrated result, and iterate until the goal is fully achieved.
>
> Available tools: DelegateTask, TaskStatus, TaskLogs, CreateLoop, CreatePipeline, CancelTask, RetryTask, ResumeTask
>
> Your workflow:
> 1. Analyze the goal and create an implementation plan
> 2. Break the plan into parallelizable subtasks
> 3. For each subtask, use DelegateTask to spawn a worker agent
> 4. Use task dependencies (dependsOn) to enforce ordering where needed
> 5. Use CreateLoop with --until for tasks that need verification
> 6. Monitor task progress with TaskStatus
> 7. When workers fail, analyze logs with TaskLogs and either RetryTask or ResumeTask with adjusted context
> 8. When all subtasks complete, run integration validation
> 9. If integration fails, create targeted fix tasks
> 10. Continue until the goal is achieved or you determine it cannot be completed

**Implementation complexity:** Medium — this is a new handler, a new CLI command, and a system prompt. The orchestrator itself runs as a Autobeat task (the system is self-hosting), which means it gets all the existing infrastructure: persistence, crash recovery, logging.

### 2. Orchestrator State File

**What:** A persistent `orchestrator-state.json` that the orchestrator agent reads at the start of each iteration and writes after making decisions. Similar to Huntley's IMPLEMENTATION_PLAN.md.

**Why:** With clean context per iteration (which Autobeat already does for loops), the orchestrator needs to remember what it decided, what's running, what passed, what failed. SQLite already tracks task state, but the orchestrator needs its own higher-level reasoning state: "I decided to split auth into JWT, OAuth, and MFA modules. JWT is done. OAuth worker failed on the token refresh endpoint. MFA hasn't started yet."

**Structure:**
```json
{
  "goal": "Build complete auth system",
  "plan": {
    "phases": [
      {
        "name": "Core JWT",
        "status": "completed",
        "taskId": "task-abc",
        "completedAt": "2026-03-26T10:00:00Z"
      },
      {
        "name": "OAuth2 Provider",
        "status": "in_progress",
        "taskId": "task-def",
        "failureCount": 1,
        "lastError": "Token refresh endpoint returns 500"
      },
      {
        "name": "MFA Integration",
        "status": "pending",
        "dependsOn": ["Core JWT", "OAuth2 Provider"]
      }
    ]
  },
  "iterations": 3,
  "totalTokensUsed": 145000,
  "totalCost": 4.35
}
```

**Implementation complexity:** Low — it's a JSON file on disk that gets read/written by the orchestrator agent. Autobeat just needs to inject its contents into the orchestrator's context at each loop iteration.

### 3. Cost & Safety Guardrails on the Meta-Loop

**What:** Configuration for the orchestrator that prevents runaway spending:
```json
{
  "orchestrator": {
    "maxTotalTokens": 5000000,
    "maxTotalCost": 50.00,
    "maxWorkerAgents": 10,
    "maxDepth": 2,
    "maxIterations": 50,
    "requireApprovalAfter": 25.00,
    "allowedOperations": ["DelegateTask", "CreateLoop", "TaskStatus", "TaskLogs", "RetryTask", "ResumeTask"]
  }
}
```

**Why:** An autonomous orchestrator that can spawn agents, retry failures, and create loops could easily run up a massive bill. The guardrails are the safety net. `maxDepth: 2` means the orchestrator can spawn workers, but workers can't spawn sub-workers (no infinite recursion). `requireApprovalAfter` pauses and asks the human for confirmation before continuing.

**Implementation complexity:** Low — config validation and token/cost tracking integrated into the existing EventBus.

### 4. Worker Isolation Convention (Not Infrastructure)

**What:** Instead of building worktree management code, the orchestrator's system prompt includes instructions for workers:

> When delegating a subtask, include in the worker's prompt:
> "Before starting work, create a git worktree: `git worktree add ../Autobeat-worker-{taskId} -b feature/{task-description}`. Work in that directory. When complete, create a PR. After PR is merged or reviewed, clean up: `git worktree remove ../Autobeat-worker-{taskId}`"

**Why:** This is the core insight — the coding agent handles git operations. Autobeat doesn't need to build worktree infrastructure. The orchestrator agent tells worker agents to isolate themselves. If a worker is Claude Code, it knows how to create worktrees, branches, and PRs.

**Implementation complexity:** Zero code — it's prompt engineering in the orchestrator's system prompt. The key learning from Overstory is that worktree isolation matters; the key insight from your philosophy is that the agent does it, not the framework.

---

## Part 3: The Orchestrator System Prompt (Stealing From Competitors)

This is where the competitive intelligence becomes actionable. Here's what to incorporate from each competitor into the orchestrator's system prompt:

### From Zeroshot: The Validation Pattern

Zeroshot's best pattern is independent validation — the implementer and the validator are separate agents. The orchestrator should be prompted to use this pattern:

> After any worker completes an implementation task, create a separate validation task with a DIFFERENT agent (or the same agent with a reviewer persona). The validator should:
> 1. Read the implementation via TaskLogs
> 2. Run the test suite
> 3. Check for code quality issues
> 4. Either approve (mark task complete) or reject (provide specific failure reasons)
>
> If rejected, create a fix task that depends on the rejection output (using continueFrom) and loop until the validator approves.

This gives you Zeroshot's multi-agent pipeline through prompt engineering, not code.

### From Agent Orchestrator: Reactive CI Feedback

Agent Orchestrator's killer feature is CI→agent→fix. The orchestrator should be prompted:

> After delegating an implementation task, create a follow-up verification loop:
> ```
> CreateLoop({
>   prompt: "Run the full CI pipeline. If any check fails, read the failure logs and fix the issues.",
>   strategy: "retry",
>   exitCondition: "npm run ci",
>   maxIterations: 5,
>   dependsOn: [implementationTaskId]
> })
> ```
> This creates an automated CI feedback loop using Autobeat's existing loop infrastructure.

### From Overstory: Multi-Agent Awareness

Overstory's wisdom about compounding errors informs the guardrails:

> CRITICAL ORCHESTRATION RULES:
> 1. Never run more than 3 workers modifying the same module simultaneously — merge conflicts compound
> 2. If a worker fails 3 times on the same task, escalate to a different approach (don't just retry)
> 3. After completing parallel work, ALWAYS run an integration task that tests the combined output
> 4. Track total cost. If you've spent more than 50% of the budget on one subtask, stop and reassess the plan
> 5. Prefer sequential work over parallel work when tasks touch overlapping files

### From Loom/Ralph: The Loop Mindset

Huntley's core insight: "No sophisticated orchestration needed — just a dumb loop that keeps restarting the agent." The orchestrator itself should run as a loop:

```
beat loop "orchestrate: Build the auth system" \
  --until "node scripts/verify-auth-complete.js" \
  --max-iterations 30 \
  --context-file orchestrator-state.json
```

The orchestrator runs in a Autobeat loop. Each iteration, it reads its state file, checks TaskStatus for all workers, makes decisions, spawns/retries/completes tasks, updates its state file, and either signals completion or continues. The loop evaluates whether the overall goal is met via the exit condition.

This is **loops all the way down**: the orchestrator is a loop, and the workers it spawns can themselves be loops.

---

## Part 4: Implementation Roadmap

### Phase 1: Orchestrator Entry Point (1-2 weeks)

**New files:**
- `src/services/handlers/orchestrator-handler.ts` — manages orchestrator lifecycle
- `src/services/orchestrator-manager.ts` — orchestrator state, prompt construction
- `src/core/orchestrator-state.ts` — state file read/write
- System prompt template (embedded or configurable)

**Modified files:**
- `src/cli.ts` — add `beat orchestrate` command
- `src/adapters/mcp-adapter.ts` — add `Orchestrate` MCP tool
- `src/core/events/events.ts` — add orchestrator events
- `src/services/handler-setup.ts` — wire up OrchestratorHandler

**How it works internally:**
1. `beat orchestrate "goal"` creates a special task of type `orchestrator`
2. The task gets a system prompt that describes the orchestrator role + available Autobeat MCP tools
3. The task is wrapped in a loop (using existing CreateLoop infrastructure) with the exit condition being the goal verification
4. Each loop iteration: the orchestrator agent reads its state file → calls Autobeat MCP tools to manage workers → writes updated state
5. Existing persistence handles crash recovery

### Phase 2: Guardrails & Cost Tracking (1 week)

**New files:**
- `src/services/cost-tracker.ts` — track token usage and estimated cost across all tasks in an orchestration
- `src/core/guardrails.ts` — depth limiting, max workers, budget enforcement

**Modified files:**
- `src/core/domain.ts` — add `orchestratorId` field to tasks (link workers to their orchestrator)
- Event handlers — integrate cost tracking on task completion

### Phase 3: Polish & Patterns (1-2 weeks)

- Pre-built orchestration templates (e.g., "feature-development", "bug-fix", "refactor", "code-review")
- `beat orchestrate "goal" --template feature-development` to use battle-tested orchestration patterns
- Orchestrator TUI: `beat orchestrate status <id>` shows a tree of the orchestrator + all its workers + their statuses
- Documentation and examples

---

## Part 5: Why This Wins

The competitive landscape is building **infrastructure the agent could do itself**. Every line of worktree management, CI parsing, PR automation, and inter-agent messaging in Zeroshot, Agent Orchestrator, and Overstory is technical debt that becomes obsolete as agents improve.

Autobeat's bet is the opposite: **the thinnest possible orchestration layer** that trusts the agent to handle infrastructure. What Autobeat provides:

1. **The loop primitive** — run, evaluate, iterate (already built)
2. **The delegation primitive** — spawn background agents with dependency ordering (already built)
3. **The persistence primitive** — crash-proof state that survives restarts (already built)
4. **The orchestrator agent** — a meta-agent that uses all three primitives to self-organize (to be built)

That's it. Four things. Everything else — worktrees, CI, PRs, code review, testing, deployment — is the agent's job.

The competitors have thousands of lines of code implementing things the agent can already do. Autobeat has hundreds of lines implementing things the agent *can't* do (persistence, scheduling, eval scoring, resource management) and delegates everything else to the agent.

As models get smarter, the competitors' code becomes increasingly redundant while Autobeat's thin layer becomes increasingly powerful. The orchestrator agent automatically gets better at CI integration, code review, and multi-repo coordination — without Autobeat changing a line of code.

**The tagline writes itself: "The orchestration framework that gets better every time the model improves."**

---

## Summary: What to Build (Minimal Viable Orchestrator)

| What | Effort | Priority |
|------|--------|----------|
| `beat orchestrate` CLI command + MCP tool | Medium | P0 |
| Orchestrator system prompt (incorporate competitor patterns) | Low | P0 |
| Orchestrator state file (JSON read/write per iteration) | Low | P0 |
| Cost/token tracking across orchestration | Low | P1 |
| Depth & worker count guardrails | Low | P1 |
| `orchestratorId` field linking workers to orchestrator | Low | P1 |
| Orchestrator status tree view | Medium | P2 |
| Pre-built orchestration templates | Medium | P2 |
| Documentation & examples | Medium | P2 |

**Total estimated new code: ~500-800 lines of TypeScript + system prompt engineering.** The rest is already built.
