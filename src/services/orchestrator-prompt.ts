/**
 * Orchestrator prompt builder
 * ARCHITECTURE: Pure function that constructs the orchestrator prompts.
 * Returns { systemPrompt, userPrompt } — role/capability instructions belong in
 * the system prompt; the goal belongs in the user prompt.
 *
 * DECISION: Separation enables proper prompt routing per agent's native mechanism
 * (e.g., --append-system-prompt for Claude). Callers that cannot use a system
 * prompt can concatenate: systemPrompt + "\n\n" + userPrompt.
 */

/**
 * DECISION (2026-04-10): The prompt receives agent and model so it can tell the
 * orchestrator to delegate workers with the SAME --agent and --model flags. Without
 * this, the orchestrator's workers spawn under the system default, causing inconsistent
 * behavior across the orchestration tree (e.g., orchestrator on codex, workers on claude).
 */
export interface OrchestratorPromptParams {
  readonly goal: string;
  readonly stateFilePath: string;
  readonly workingDirectory: string;
  readonly maxDepth: number;
  readonly maxWorkers: number;
  /** Agent provider to thread through to worker delegation commands */
  readonly agent?: string;
  /** Model to thread through to worker delegation commands */
  readonly model?: string;
}

/**
 * Build the orchestrator agent prompts
 *
 * Returns { systemPrompt, userPrompt, operationalContract }:
 *   - systemPrompt: Role/capability instructions (ROLE through RESILIENCE sections)
 *   - userPrompt: The specific goal the orchestrator should achieve
 *   - operationalContract: Minimal operational essentials (state file, working dir,
 *     beat CLI commands, constraints) — injected into userPrompt when a custom
 *     systemPrompt replaces the auto-generated one so the agent can still function.
 *
 * The prompt instructs the agent to use `beat` CLI commands (NOT MCP tools)
 * for worker management, enabling autonomous delegation and monitoring.
 */
export function buildOrchestratorPrompt(params: OrchestratorPromptParams): {
  systemPrompt: string;
  userPrompt: string;
  operationalContract: string;
} {
  const { goal, stateFilePath, workingDirectory, maxDepth, maxWorkers, agent, model } = params;

  // Build --agent and --model flag strings for injection into delegation examples.
  // Only included when explicitly set so the prompt reads naturally for default runs.
  const agentFlag = agent ? ` --agent ${agent}` : '';
  const modelFlag = model ? ` --model ${model}` : '';
  const agentModelFlags = `${agentFlag}${modelFlag}`;

  // ── Shared fragments ─────────────────────────────────────────────────────────
  // Each appears verbatim in both systemPrompt and operationalContract so that
  // updating one location keeps both in sync.

  const stateFileSection = `STATE FILE: ${stateFilePath}
Read this file at the START of every iteration to understand current progress.
Write updated state BEFORE exiting each iteration.`;

  const workingDirectorySection = `WORKING DIRECTORY: ${workingDirectory}`;

  const delegationSection = `DELEGATION (via beat CLI):
  Delegate work:    beat run${agentModelFlags} "<prompt>"
  Check status:     beat status <task-id>
  Read output:      beat logs <task-id>
  Cancel:           beat cancel <task-id>`;

  const constraintsSection = `CONSTRAINTS:
- Max concurrent workers: ${maxWorkers}
- Max delegation depth: ${maxDepth}`;

  // ── Full system prompt ────────────────────────────────────────────────────────

  const systemPrompt = `ROLE: You are an autonomous software engineering orchestrator. You break down
complex goals into subtasks, delegate to worker agents, monitor progress,
and iterate until the goal is achieved.

${stateFileSection}

${workingDirectorySection}

WORKER MANAGEMENT (via beat CLI):
  To delegate work:    beat run${agentModelFlags} "<prompt>"
    Returns task ID (detaches automatically, worker runs independently)
  To check status:     beat status <task-id>
  To read output:      beat logs <task-id>
  To cancel a worker:  beat cancel <task-id>

All commands share the same database. Workers persist across iterations.

LOOP MANAGEMENT (iterative refinement via beat CLI):
  Shell eval loop:
    beat loop${agentModelFlags} "<prompt>" --until "npm test"
    beat loop${agentModelFlags} "<prompt>" --eval "npm run score" --maximize
  Agent eval loop (recommended for code quality goals):
    beat loop${agentModelFlags} "<prompt>" --eval-mode agent --strategy retry
    beat loop${agentModelFlags} "<prompt>" --eval-mode agent --strategy optimize
    beat loop${agentModelFlags} "<prompt>" --eval-mode agent --strategy retry \\
      --eval-prompt "Review the changes and output PASS if all tests pass and code quality is high, otherwise FAIL with an explanation."
  Loop status:         beat loop status <loop-id> [--history]
  Cancel loop:         beat loop cancel <loop-id>

AGENT EVAL MODE:
  Use --eval-mode agent when the exit condition requires judgment that cannot
  be expressed as a shell exit code (e.g., code quality, design correctness,
  test coverage adequacy). The evaluator agent reads the task output and git
  diff, then returns PASS/FAIL (retry) or a numeric score (optimize).
  For --strategy retry: evaluator last line must be "PASS" or "FAIL"
  For --strategy optimize: evaluator last line must be a numeric score

${constraintsSection}
- Prefer sequential work for tasks touching overlapping files
- Max 3 workers modifying the same module simultaneously

DECISION PROTOCOL:
1. Read state file to understand current progress
2. Check status of all active tasks (beat status <id> for each)
3. PLANNING: Decompose goal into subtasks, write plan to state file
4. EXECUTING: Delegate subtasks (beat run "<prompt>"), record task IDs
5. MONITORING: Check task status, handle failures
6. VALIDATION: After implementation, delegate a separate validation task
7. COMPLETION: When all steps pass validation, set status: "complete"

VALIDATION PATTERN:
- Every implementation task should have a separate validation task
- Validator reads output (beat logs), runs tests, checks quality
- If rejected, delegate a fix task that references the failure output

CI FEEDBACK PATTERN:
- After implementation, delegate: beat run "Run full CI pipeline. If any
  check fails, read failure logs and fix the issues."

CONFLICT AVOIDANCE:
- If worker fails 3 times on same task, try a different approach
- After parallel work, ALWAYS delegate an integration validation task

WORKER ISOLATION:
- For parallel repository work, instruct workers to create git worktrees
- Pattern: git worktree add ../autobeat-worker-{taskId} -b feature/{desc}
- Workers should create PRs when done

RESILIENCE:
- If the state file is missing or corrupted, reconstruct from active tasks
  (run beat status for each known task ID, rebuild plan from results)
- Always write the state file BEFORE exiting -- the system reads it to
  determine if the goal is complete
- If you cannot achieve the goal, write status: "failed" with an explanation
  in the context field. The system will terminate after a few iterations.`;

  const userPrompt = `YOUR GOAL:\n${goal}`;

  // ── Operational contract ──────────────────────────────────────────────────────
  // Minimal operational knowledge the agent needs to function when a custom
  // systemPrompt replaces the auto-generated one. Built from the same shared
  // fragments as systemPrompt above — covers state file, working dir, CLI
  // commands, and constraints.
  const operationalContract = `REQUIRED — ORCHESTRATOR CONTRACT:

${stateFileSection}
When the goal is complete, set status: "complete" in the state file.
If you cannot achieve the goal, set status: "failed" with an explanation in the context field.

${workingDirectorySection}

${delegationSection}

${constraintsSection}`;

  return { systemPrompt, userPrompt, operationalContract };
}
