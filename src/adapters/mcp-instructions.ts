/**
 * MCP server instructions for connecting agents.
 * ARCHITECTURE: Injected into the MCP InitializeResult so any connecting agent
 * learns how to orchestrate Autobeat effectively. The MCP SDK sends this string
 * to clients during initialization — clients typically add it to the system prompt.
 */

export const MCP_INSTRUCTIONS = `You have access to Autobeat, an AI agent orchestration framework. It lets you delegate work to background AI agent instances, build task pipelines, create iterative loops, schedule recurring work, and run autonomous orchestrations.

## When to Use Each Capability

### Single Tasks (DelegateTask)
Use for independent, self-contained work items. Each task runs in its own agent process.
- "Run the test suite in /repo and report results"
- "Refactor the auth module to use dependency injection"
- "Generate API documentation for the user service"

### Task Dependencies (DelegateTask with dependsOn)
Use when tasks must execute in order. Build DAGs — task B waits for task A to complete.
- Step 1: DelegateTask "Write the migration" → gets taskId A
- Step 2: DelegateTask "Run the migration" with dependsOn: [A] → runs after A completes
Use \`continueFrom\` to inject the previous task's output into the next task's prompt.

### Pipelines (CreatePipeline)
Use for fixed sequential workflows (2-20 steps). Simpler than manual dependency wiring.
- lint → test → build → deploy
- Each step runs only after the previous one succeeds; failure cancels downstream steps.

### Loops (CreateLoop)
Use when you need iterative improvement — run a task repeatedly until a condition is met.

**Retry strategy**: Run until a condition passes.
- CreateLoop with strategy: "retry", exitCondition: "npm test" → keeps running until tests pass
- With evalMode: "agent", strategy: "retry" → an AI agent judges pass/fail instead of a shell command

**Optimize strategy**: Run and score each iteration, keeping the best result.
- CreateLoop with strategy: "optimize", exitCondition: "echo $SCORE", evalDirection: "maximize"
- With evalMode: "agent", strategy: "optimize", evalDirection: "maximize" → an AI agent scores each iteration 0-100

**Pipeline loops**: Repeat a multi-step pipeline per iteration.
- CreateLoop with pipelineSteps: ["lint the code", "run tests"] and exitCondition: "npm test"

**Agent eval sub-strategies** (evalMode: "agent" only, v1.3.0+):
- evalType: "feedforward" (default) → eval agent gathers findings only, loop always continues until maxIterations; works with any agent
- evalType: "schema" → Claude uses --json-schema for deterministic structured pass/fail output; requires agent: "claude"
- evalType: "judge" → two-phase: eval agent gathers findings, then a judge agent writes a continue/stop decision to .autobeat-judge file; requires evalPrompt
  - judgeAgent: "claude" (optional) → separate agent for the judge phase (defaults to loop agent)
  - judgePrompt: "custom instructions for judge" (optional) → override default judge instructions

### Schedules (ScheduleTask, SchedulePipeline, ScheduleLoop)
Use for future or recurring execution.
- ScheduleTask with scheduleType: "cron", cronExpression: "0 9 * * *" → daily at 9am
- ScheduleTask with scheduleType: "one_time", scheduledAt: "2026-04-01T09:00:00Z" → once at that time
- SchedulePipeline for recurring multi-step workflows
- ScheduleLoop for recurring iterative improvement cycles

### Orchestrations (CreateOrchestrator)
Use for complex, open-ended goals. The orchestrator autonomously breaks the goal into subtasks, delegates them, monitors progress, and iterates until done.
- "Migrate the entire API from Express to Fastify with zero downtime"
- "Add comprehensive test coverage to all service modules"
The orchestrator manages its own task graph — you just provide the goal and guardrails.

### Custom Orchestrators (InitCustomOrchestrator + CreateLoop)
Use when you want full control over orchestration strategy, prompt structure, or evaluation criteria.
Two-step pattern:
1. InitCustomOrchestrator with goal → returns state file, exit script, and instruction snippets
2. CreateLoop with your custom systemPrompt (include the delegation + state management snippets),
   strategy: "retry", exitCondition from step 1

The built-in CreateOrchestrator is this pattern with a pre-built system prompt.
InitCustomOrchestrator gives you the building blocks to create your own.

## Monitoring Patterns

### Check on work
- TaskStatus (no taskId) → list all tasks with their statuses
- TaskStatus with taskId → check a specific task
- TaskLogs with taskId → read stdout/stderr from a task
- LoopStatus with loopId, includeHistory: true → see iteration progress and scores
- OrchestratorStatus with orchestratorId → see plan steps and progress
- PipelineStatus with pipelineId → check overall pipeline status and per-step task IDs
- ListPipelines → list pipelines with optional status filter (pending/running/completed/failed/cancelled)

### React to results
- TaskLogs to read output, then decide next steps
- ResumeTask to continue from where a failed task left off (with checkpoint context)
- RetryTask to re-run a task from scratch
- CancelTask / CancelLoop / CancelOrchestrator to stop work that's going wrong
- CancelPipeline to transition a pipeline entity to cancelled status

## Agent & Model Configuration

### Per-task model override
All task-creating tools accept an optional \`model\` field to override the agent's default model:
- DelegateTask with model: "claude-opus-4-5" → uses that model for this task only
- CreatePipeline steps can each have their own model, or set a top-level default
- CreateLoop with model: "gemini-2.0-flash" → each iteration uses that model

### Agent defaults (ConfigureAgent)
Use ConfigureAgent to configure per-agent defaults that apply when no per-task override is set:
- action: "set", apiKey: "sk-..." → store API key
- action: "set", baseUrl: "https://proxy.example.com/v1" → route requests through a proxy
- action: "set", model: "claude-opus-4-5" → default model for all tasks using that agent
- action: "set", proxy: "openai" → route Anthropic API calls through a translation proxy to an OpenAI-compatible backend
- action: "check" → see current auth status and stored config (baseUrl/model/proxy shown when set)
- action: "reset" → clear all stored config for the agent

### API Proxy (proxy)
Use \`proxy\` to route Claude Code workers through any OpenAI-compatible API backend:
1. ConfigureAgent action: "set", agent: "claude", proxy: "openai"
2. ConfigureAgent action: "set", agent: "claude", baseUrl: "https://integrate.api.nvidia.com/v1"
3. ConfigureAgent action: "set", agent: "claude", apiKey: "nvapi-..."
4. ConfigureAgent action: "set", agent: "claude", model: "moonshotai/kimi-k2-thinking"

When proxy is set, a local proxy starts automatically at boot that translates Anthropic Messages API requests into OpenAI Chat Completions format. Claude Code is unaware — it sends its normal API calls which are transparently translated. Supported targets: "openai".

Set proxy to "" (empty string) to disable and return to direct Anthropic API access.

Model resolution order (highest priority wins):
1. Per-task \`model\` field (DelegateTask, pipeline step, etc.)
2. Agent config default (\`ConfigureAgent\` set model)
3. Agent's built-in default

### Per-task system prompt (systemPrompt)
DelegateTask, CreateLoop, and CreateOrchestrator accept an optional \`systemPrompt\` field.
The mechanism is per-agent:
- Claude: \`--append-system-prompt\` — appended after Claude Code's built-in instructions (preserves tool access)
- Codex: \`-c developer_instructions=<text>\` — appended after default, preserves AGENTS.md
- Gemini: \`GEMINI_SYSTEM_MD\` combining cached base prompt + user system prompt (fallback: prepended to user prompt)

Priority rules:
- DelegateTask: systemPrompt is used for that task and any retry/resume tasks created from it
- CreateLoop: systemPrompt is injected into each iteration task
- CreateOrchestrator: when provided, replaces the auto-generated role instructions entirely
  (appending would cause conflicting ROLE sections — provide a complete system prompt)

## Key Principles

1. **Parallelize when possible**: Independent tasks should run concurrently. Only use dependsOn when ordering matters.
2. **Use the right abstraction level**: Single task < Pipeline < Loop < Orchestrator. Pick the simplest one that fits.
3. **Monitor and adapt**: Check TaskStatus/TaskLogs periodically. Cancel failing work early. Resume with additional context when a task fails.
4. **Working directories matter**: Always set workingDirectory to the correct repo/project path for each task.
5. **Loops for quality**: Use retry loops with agent eval for subjective quality checks that shell scripts can't evaluate.
6. **Schedules for automation**: Recurring maintenance (dependency updates, test runs, backups) should be scheduled, not manually triggered.
`;
