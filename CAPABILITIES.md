# Autobeat — Capability Map

## 1. Background Tasks

```
┌─────────────────────────────────────────────────────────┐
│  SINGLE TASK                                            │
│                                                         │
│  beat run "refactor the auth module"                    │
│                                                         │
│  ┌──────────┐                                           │
│  │  Task A   │──→ runs in background ──→ result         │
│  │  P0/P1/P2 │    (Claude or Codex)                     │
│  └──────────┘                                           │
│                                                         │
│  Options:                                               │
│  ├── --agent claude|codex       (which AI runs it)      │
│  ├── --model <model-id>         (specific model)        │
│  ├── --priority p0|p1|p2        (critical/high/normal)  │
│  ├── --system-prompt "..."      (custom instructions)   │
│  ├── --timeout 3600000          (per-task timeout)       │
│  └── --working-directory /path  (where it runs)         │
│                                                         │
│  Lifecycle: QUEUED → RUNNING → COMPLETED/FAILED         │
│  Resume:    beat resume <id> --context "try X instead"  │
│  Retry:     beat retry <id>                             │
└─────────────────────────────────────────────────────────┘
```

## 2. Tasks with Dependencies (DAG)

```
┌─────────────────────────────────────────────────────────┐
│  DEPENDENCY GRAPH                                       │
│                                                         │
│  Tasks declare dependsOn — Autobeat resolves the DAG    │
│  and executes in topological order.                     │
│                                                         │
│  ┌────────┐                                             │
│  │ Lint   │──┐                                          │
│  └────────┘  │   ┌────────┐    ┌─────────┐             │
│              ├──→│ Build  │───→│ Deploy  │             │
│  ┌────────┐  │   └────────┘    └─────────┘             │
│  │ Types  │──┘                                          │
│  └────────┘                                             │
│                                                         │
│  Diamond pattern:                                       │
│                 ┌── B ──┐                               │
│            A ──┤        ├── D                           │
│                 └── C ──┘                               │
│                                                         │
│  Features:                                              │
│  ├── Cycle detection (DFS) — prevents A→B→A            │
│  ├── Failure cascade — if B fails, D is cancelled      │
│  ├── continueFrom — D gets B's checkpoint context      │
│  └── TOCTOU-safe via synchronous SQLite transactions   │
└─────────────────────────────────────────────────────────┘
```

## 3. Autoscaling Worker Pool

```
┌─────────────────────────────────────────────────────────┐
│  RESOURCE-AWARE SCHEDULING                              │
│                                                         │
│  Queue:  [P0 Task] [P0 Task] [P1 Task] [P2 Task] ...  │
│              │                                          │
│              ▼                                          │
│  ┌─────────────────────────────────┐                    │
│  │ Worker Pool (auto-scales)       │                    │
│  │                                 │                    │
│  │  CPU < 80% && RAM > 1GB free?   │                    │
│  │  ├── YES → spawn new worker     │                    │
│  │  └── NO  → wait for resources   │                    │
│  │                                 │                    │
│  │  ┌──────┐ ┌──────┐ ┌──────┐    │                    │
│  │  │ W1   │ │ W2   │ │ W3   │    │                    │
│  │  │claude│ │codex │ │claude│    │                    │
│  │  └──────┘ └──────┘ └──────┘    │                    │
│  └─────────────────────────────────┘                    │
│                                                         │
│  ├── Priority ordering (P0 > P1 > P2)                  │
│  ├── 15s settling window for new workers               │
│  ├── 10s minimum between spawns                        │
│  ├── Per-worker CPU/memory monitoring                  │
│  └── Crash recovery on restart                         │
└─────────────────────────────────────────────────────────┘
```

## 4. Pipelines

```
┌─────────────────────────────────────────────────────────┐
│  PIPELINE — sequential multi-step execution             │
│                                                         │
│  beat pipeline "lint the code" "run tests" "deploy"     │
│                                                         │
│  ┌──────┐     ┌──────┐     ┌──────┐                    │
│  │Step 1│────→│Step 2│────→│Step 3│                    │
│  │ Lint │     │ Test │     │Deploy│                    │
│  └──────┘     └──────┘     └──────┘                    │
│                                                         │
│  ├── 2–20 steps per pipeline                           │
│  ├── Per-step: priority, working dir, agent, model     │
│  ├── Failure cascade — step 2 fails → step 3 cancelled │
│  ├── Per-step delays between steps                     │
│  └── First-class entity with status tracking           │
│                                                         │
│  MCP: CreatePipeline, PipelineStatus, ListPipelines,   │
│       CancelPipeline                                    │
└─────────────────────────────────────────────────────────┘
```

## 5. Schedules

```
┌─────────────────────────────────────────────────────────┐
│  SCHEDULED TASKS & PIPELINES                            │
│                                                         │
│  beat schedule create "run nightly tests"               │
│      --cron "0 2 * * *" --timezone America/New_York     │
│                                                         │
│  ┌──────────────────────────────────────┐               │
│  │            Scheduler                 │               │
│  │                                      │               │
│  │  CRON:     "0 9 * * 1-5"  ──→ fires │               │
│  │  ONE-TIME: "2026-06-01T09:00:00Z"   │               │
│  └──────────────┬───────────────────────┘               │
│                 │                                        │
│      ┌──────────▼──────────┐                            │
│      │ Single Task         │   — or —                   │
│      │ Full Pipeline       │  (2-20 steps per trigger)  │
│      └─────────────────────┘                            │
│                                                         │
│  Options:                                               │
│  ├── Timezone (IANA, DST-aware)                        │
│  ├── Missed run policy: skip | catchup | fail          │
│  ├── Max runs (cap total executions)                   │
│  ├── Expiration date                                   │
│  ├── Pause / Resume                                    │
│  └── Concurrent execution prevention (lock-based)      │
└─────────────────────────────────────────────────────────┘
```

## 6. Loops

```
┌─────────────────────────────────────────────────────────┐
│  ITERATIVE LOOPS — retry or optimize until done         │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │  RETRY STRATEGY                                 │    │
│  │                                                 │    │
│  │  beat loop "fix the failing test"               │    │
│  │      --until "npm test"                         │    │
│  │                                                 │    │
│  │  Iter 1 → run task → eval "npm test" → FAIL    │    │
│  │  Iter 2 → run task → eval "npm test" → FAIL    │    │
│  │  Iter 3 → run task → eval "npm test" → PASS    │    │
│  │                                                 │    │
│  │  Goal: keep going until exit condition passes   │    │
│  └─────────────────────────────────────────────────┘    │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │  OPTIMIZE STRATEGY                              │    │
│  │                                                 │    │
│  │  beat loop "optimize the query"                 │    │
│  │      --eval "node benchmark.js"                 │    │
│  │      --minimize                                 │    │
│  │                                                 │    │
│  │  Iter 1 → score: 450ms                         │    │
│  │  Iter 2 → score: 380ms  ← new best (kept)      │    │
│  │  Iter 3 → score: 520ms  ← worse (discarded)    │    │
│  │  Iter 4 → score: 290ms  ← new best (kept)      │    │
│  │                                                 │    │
│  │  Direction: --minimize OR --maximize            │    │
│  │  Only improvements are kept; regressions revert │    │
│  └─────────────────────────────────────────────────┘    │
│                                                         │
│  PIPELINE LOOPS — multi-step per iteration:             │
│  beat loop --pipeline --step "lint" --step "test"       │
│      --until "npm run e2e"                              │
│                                                         │
│  Config:                                                │
│  ├── maxIterations (default 10, 0=unlimited)           │
│  ├── maxConsecutiveFailures (default 3)                │
│  ├── cooldown between iterations                       │
│  ├── evalTimeout (default 60s)                         │
│  ├── freshContext (true=clean slate each iteration)    │
│  ├── Pause / Resume mid-loop                           │
│  └── Git branch tracking (commit per iteration,       │
│      revert on failure)                                 │
└─────────────────────────────────────────────────────────┘
```

## 7. Loop Evaluation Methods

```
┌─────────────────────────────────────────────────────────┐
│  THREE EVAL STRATEGIES (evalType)                       │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │  FEEDFORWARD (default)                          │    │
│  │                                                 │    │
│  │  Iter N output ──→ injected as context ──→      │    │
│  │      Iter N+1 prompt                            │    │
│  │                                                 │    │
│  │  No judge. Passes findings forward so each      │    │
│  │  iteration builds on the last. Runs all         │    │
│  │  iterations up to maxIterations.                │    │
│  └─────────────────────────────────────────────────┘    │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │  SCHEMA                                         │    │
│  │                                                 │    │
│  │  Iter output ──→ eval agent ──→ structured JSON │    │
│  │                                                 │    │
│  │  Agent must respond with:                       │    │
│  │  { "continue": true/false, "reasoning": "..." } │    │
│  │                                                 │    │
│  │  Deterministic, no separate judge needed.       │    │
│  └─────────────────────────────────────────────────┘    │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │  JUDGE (two-phase)                              │    │
│  │                                                 │    │
│  │  Phase 1: Eval agent generates findings         │    │
│  │              │                                  │    │
│  │              ▼                                  │    │
│  │  Phase 2: Judge agent reads findings,           │    │
│  │           writes continue/stop decision         │    │
│  │                                                 │    │
│  │  judgeAgent: claude | codex                     │    │
│  │  judgePrompt: custom instructions for judge     │    │
│  │                                                 │    │
│  │  Separates "what happened" from "should we      │    │
│  │  continue" for independent reasoning.           │    │
│  └─────────────────────────────────────────────────┘    │
│                                                         │
│  SHELL EVAL (evalMode: 'shell')                         │
│  ├── Exit code 0 = pass, non-zero = fail               │
│  └── Script stdout parsed as score (optimize strategy) │
│                                                         │
│  AGENT EVAL (evalMode: 'agent')                         │
│  ├── AI agent reads iteration output                   │
│  ├── Returns pass/fail (retry) or score 0-100 (opt)    │
│  └── Custom evalPrompt for evaluation guidance         │
└─────────────────────────────────────────────────────────┘
```

## 8. Scheduled Loops

```
┌─────────────────────────────────────────────────────────┐
│  SCHEDULED LOOPS — compose loops with schedules         │
│                                                         │
│  beat schedule create --loop "optimize perf"            │
│      --eval "node bench.js" --maximize                  │
│      --cron "0 3 * * 0"                                │
│                                                         │
│  Every Sunday 3am:                                      │
│  ┌──────────┐    ┌──────────────────────────────┐       │
│  │ Schedule  │───→│ New Loop Instance            │       │
│  │ (cron)    │    │  Iter 1 → Iter 2 → ... Done │       │
│  └──────────┘    └──────────────────────────────┘       │
│                                                         │
│  Next Sunday 3am:                                       │
│  ┌──────────┐    ┌──────────────────────────────┐       │
│  │ Schedule  │───→│ Fresh Loop Instance          │       │
│  │ (cron)    │    │  Iter 1 → Iter 2 → ... Done │       │
│  └──────────┘    └──────────────────────────────┘       │
└─────────────────────────────────────────────────────────┘
```

## 9. Orchestration

```
┌─────────────────────────────────────────────────────────┐
│  AUTONOMOUS ORCHESTRATOR — goal-driven meta-agent       │
│                                                         │
│  beat orchestrate "migrate the app from Express to Hono"│
│                                                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Lead Agent (the orchestrator)                    │   │
│  │                                                   │   │
│  │  1. Reads the goal                                │   │
│  │  2. Breaks it into a plan                         │   │
│  │  3. Delegates subtasks to workers                 │   │
│  │  4. Monitors progress                             │   │
│  │  5. Iterates until goal achieved                  │   │
│  │                                                   │   │
│  │  ┌────────┐  ┌────────┐  ┌────────┐              │   │
│  │  │Worker 1│  │Worker 2│  │Worker 3│   (parallel) │   │
│  │  │ claude │  │ codex  │  │ claude │              │   │
│  │  └────────┘  └────────┘  └────────┘              │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│  Modes:                                                 │
│  ├── Detached (default) — runs in background           │
│  ├── --foreground — blocks, Ctrl+C to cancel           │
│  └── -i/--interactive — foreground TTY session         │
│                                                         │
│  Guardrails:                                            │
│  ├── maxDepth: 1-10 (delegation nesting, default 3)    │
│  ├── maxWorkers: 1-20 (concurrent agents, default 5)   │
│  └── maxIterations: 1-200 (orchestrator loops, def 50) │
│                                                         │
│  Custom scaffolding:                                    │
│  beat orchestrate init "my goal"                        │
│  └── Generates state file, exit condition script,      │
│      and system prompt for fine-grained control         │
│                                                         │
│  Crash recovery: persisted to SQLite, auto-resumes     │
└─────────────────────────────────────────────────────────┘
```

## 10. Multi-Agent Support

```
┌─────────────────────────────────────────────────────────┐
│  AGENTS                                                 │
│                                                         │
│  Built-in:    Claude  ·  Codex                         │
│                                                         │
│  Per-agent config (~/.autobeat/config.json):            │
│  ├── apiKey                                            │
│  ├── baseUrl (custom endpoints / proxies)              │
│  ├── model (specific model ID)                         │
│  ├── proxy: "openai" (translation proxy for any        │
│  │   OpenAI-compatible backend — OpenRouter, vLLM,     │
│  │   Together, etc.)                                   │
│  └── runtime: "ollama" (local LLM execution)           │
│                                                         │
│  Every primitive (task, loop, pipeline, schedule,       │
│  orchestration) can target a specific agent.            │
└─────────────────────────────────────────────────────────┘
```

## 11. Task Resumption & Checkpoints

```
┌─────────────────────────────────────────────────────────┐
│  CHECKPOINTS & RESUME                                   │
│                                                         │
│  Task completes/fails → auto-checkpoint captured:       │
│  ├── Last 50 lines of output                           │
│  ├── Git branch, commit SHA, dirty files               │
│  └── Error info (if failed)                            │
│                                                         │
│  beat resume <task-id> --context "try a different approach"
│                                                         │
│  ┌────────┐         ┌────────────┐                      │
│  │Task v1 │──fail──→│ Checkpoint │                      │
│  └────────┘         └─────┬──────┘                      │
│                           │ context injected             │
│                     ┌─────▼──────┐                      │
│                     │  Task v2   │                      │
│                     │ (resumed)  │                      │
│                     └────────────┘                      │
│                                                         │
│  continueFrom: dependent task gets predecessor's       │
│  checkpoint context injected into its prompt            │
└─────────────────────────────────────────────────────────┘
```

## 12. Observability

```
┌─────────────────────────────────────────────────────────┐
│  DASHBOARD & MONITORING                                 │
│                                                         │
│  beat dashboard                                         │
│                                                         │
│  ┌─────────────┬──────────────┬──────────────────┐      │
│  │   Tasks     │   Workers    │  Orchestrations  │      │
│  │  12 active  │   3 running  │   2 in progress  │      │
│  └─────────────┴──────────────┴──────────────────┘      │
│  ┌───────────────────────────────────────────────┐      │
│  │  Activity Feed / Entity Browser               │      │
│  │  ├── Live agent output streaming (1-2s lag)   │      │
│  │  ├── 24h rolling cost/token aggregates        │      │
│  │  ├── Per-orchestration workspace view         │      │
│  │  └── Keyboard-driven (vim-style nav)          │      │
│  └───────────────────────────────────────────────┘      │
│                                                         │
│  Cost tracking:                                         │
│  ├── Input/output/cache tokens per task                │
│  ├── USD cost per task                                 │
│  └── 24h rolling aggregate in dashboard                │
│                                                         │
│  Structured JSON logging with per-module context        │
└─────────────────────────────────────────────────────────┘
```

## Capability Hierarchy

```
  Simple ──────────────────────────────────────── Complex

  Task          Pipeline        Loop            Orchestrator
  ─────         ────────        ────            ────────────
  One prompt    2-20 steps      Iterative       Goal-driven
  One result    sequential      retry/optimize  autonomous
                with deps       with eval       plans & delegates

  Any of these can be:
  ├── Scheduled (cron or one-time)
  ├── Run with any agent (Claude, Codex, or proxy/Ollama)
  ├── Given a system prompt
  └── Monitored via dashboard or CLI status commands
```
