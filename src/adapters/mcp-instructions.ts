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

## Monitoring Patterns

### Check on work
- TaskStatus (no taskId) → list all tasks with their statuses
- TaskStatus with taskId → check a specific task
- TaskLogs with taskId → read stdout/stderr from a task
- LoopStatus with loopId, includeHistory: true → see iteration progress and scores
- OrchestratorStatus with orchestratorId → see plan steps and progress

### React to results
- TaskLogs to read output, then decide next steps
- ResumeTask to continue from where a failed task left off (with checkpoint context)
- RetryTask to re-run a task from scratch
- CancelTask / CancelLoop / CancelOrchestrator to stop work that's going wrong

## Key Principles

1. **Parallelize when possible**: Independent tasks should run concurrently. Only use dependsOn when ordering matters.
2. **Use the right abstraction level**: Single task < Pipeline < Loop < Orchestrator. Pick the simplest one that fits.
3. **Monitor and adapt**: Check TaskStatus/TaskLogs periodically. Cancel failing work early. Resume with additional context when a task fails.
4. **Working directories matter**: Always set workingDirectory to the correct repo/project path for each task.
5. **Loops for quality**: Use retry loops with agent eval for subjective quality checks that shell scripts can't evaluate.
6. **Schedules for automation**: Recurring maintenance (dependency updates, test runs, backups) should be scheduled, not manually triggered.
`;
