/**
 * Orchestrator prompt builder
 * ARCHITECTURE: Pure function that constructs the orchestrator prompts.
 * Returns { systemPrompt, userPrompt } — role/capability instructions belong in
 * the system prompt; the goal belongs in the user prompt.
 *
 * DECISION: Separation enables proper prompt routing per agent's native mechanism
 * (e.g., --append-system-prompt for Claude). Callers that cannot use a system
 * prompt can concatenate: systemPrompt + "\n\n" + userPrompt.
 *
 * DECISION (2026-04-22): Three exported snippet builders (buildDelegationInstructions,
 * buildStateManagementInstructions, buildConstraintInstructions) expose reusable text
 * blocks for external callers (e.g., InitCustomOrchestrator). buildOrchestratorPrompt
 * continues to use its own internal template variables — no risk of output drift.
 * The snippet builders are pure functions with no side effects.
 */

/**
 * DECISION (2026-04-10): The prompt receives agent and model so it can tell the
 * orchestrator to delegate workers with the SAME --agent and --model flags. Without
 * this, the orchestrator's workers spawn under the system default, causing inconsistent
 * behavior across the orchestration tree (e.g., orchestrator on codex, workers on claude).
 */
export interface OrchestratorPromptParams {
  readonly goal: string;
  /** Path to the orchestrator state JSON file. Omit or pass empty string for agent eval mode (no state file). */
  readonly stateFilePath?: string;
  readonly workingDirectory: string;
  readonly maxDepth: number;
  readonly maxWorkers: number;
  /** Agent provider to thread through to worker delegation commands */
  readonly agent?: string;
  /** Model to thread through to worker delegation commands */
  readonly model?: string;
}

// ── Reusable snippet builder interfaces ────────────────────────────────────────

/**
 * Parameters for building delegation instruction snippets.
 * Optional agent/model are threaded into beat CLI delegation examples.
 */
export interface DelegationInstructionParams {
  readonly agent?: string;
  readonly model?: string;
}

/**
 * Parameters for building state management instruction snippets.
 * stateFilePath is the absolute path to the orchestrator state JSON file.
 * When empty/omitted (agent eval mode), the snippet returns an empty string.
 */
export interface StateManagementInstructionParams {
  readonly stateFilePath?: string;
}

/**
 * Parameters for building constraint instruction snippets.
 */
export interface ConstraintInstructionParams {
  readonly maxWorkers: number;
  readonly maxDepth: number;
}

/**
 * Build the full delegation instructions block.
 * Covers WORKER MANAGEMENT + LOOP MANAGEMENT + AGENT EVAL MODE sections.
 *
 * DECISION: Returns the complete text for external callers (e.g. InitCustomOrchestrator)
 * building custom orchestrators. Identical to what buildOrchestratorPrompt inlines —
 * kept in sync as a single source of truth via this exported function.
 */
export function buildDelegationInstructions(params: DelegationInstructionParams): string {
  const { agent, model } = params;
  const agentFlag = agent ? ` --agent ${agent}` : '';
  const modelFlag = model ? ` --model ${model}` : '';
  const agentModelFlags = `${agentFlag}${modelFlag}`;

  return `WORKER MANAGEMENT (via beat CLI):
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
  For --strategy optimize: evaluator last line must be a numeric score`;
}

/**
 * Build the state management instructions block.
 * Covers STATE FILE read/write requirements, completion/failure semantics,
 * and resilience guidance.
 *
 * DECISION: Includes the full state management contract so external callers
 * can embed it directly into a custom orchestrator system prompt without
 * losing the completion/failure protocol or resilience guidance.
 */
export function buildStateManagementInstructions(params: StateManagementInstructionParams): string {
  const { stateFilePath } = params;

  // When stateFilePath is absent (agent eval mode), return empty — no state file contract needed.
  if (!stateFilePath) return '';

  return `STATE FILE: ${stateFilePath}
Read this file at the START of every iteration to understand current progress.
Write updated state BEFORE exiting each iteration.
When the goal is complete, set status: "complete" in the state file.
If you cannot achieve the goal, set status: "failed" with an explanation.

RESILIENCE:
- If the state file is missing or corrupted, reconstruct from active tasks
  (run beat status for each known task ID, rebuild plan from results)`;
}

/**
 * Build the constraints instructions block.
 * Covers max workers, max depth, and file-conflict guidance.
 *
 * DECISION: Includes additional qualitative constraints (sequential work for
 * overlapping files, per-module worker cap) alongside the numeric limits
 * so the snippet is self-contained for custom orchestrator prompts.
 */
export function buildConstraintInstructions(params: ConstraintInstructionParams): string {
  const { maxWorkers, maxDepth } = params;

  return `CONSTRAINTS:
- Max concurrent workers: ${maxWorkers}
- Max delegation depth: ${maxDepth}
- Prefer sequential work for tasks touching overlapping files
- Max 3 workers modifying the same module simultaneously`;
}

// ── Main prompt builder ────────────────────────────────────────────────────────

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

  // State file section is conditional: omitted entirely when no state file (agent eval mode).
  const stateFileSection = stateFilePath
    ? `STATE FILE: ${stateFilePath}
Read this file at the START of every iteration to understand current progress.
Write updated state BEFORE exiting each iteration.`
    : '';

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

  // State file block only appears when stateFilePath is set
  const stateFileSectionBlock = stateFileSection ? `\n${stateFileSection}\n` : '';

  // DECISION PROTOCOL and RESILIENCE sections differ based on whether a state file is used.
  const decisionProtocol = stateFilePath
    ? `DECISION PROTOCOL:
1. Read state file to understand current progress
2. Check status of all active tasks (beat status <id> for each)
3. PLANNING: Decompose goal into subtasks, write plan to state file
4. EXECUTING: Delegate subtasks (beat run "<prompt>"), record task IDs
5. MONITORING: Check task status, handle failures
6. VALIDATION: After implementation, delegate a separate validation task
7. COMPLETION: When all steps pass validation, set status: "complete"`
    : `DECISION PROTOCOL:
1. Check status of all active tasks (beat status <id> for each)
2. PLANNING: Decompose goal into subtasks
3. EXECUTING: Delegate subtasks (beat run "<prompt>"), record task IDs
4. MONITORING: Check task status, handle failures
5. VALIDATION: After implementation, delegate a separate validation task
6. COMPLETION: When all delegated tasks pass validation, your work is done`;

  const resilienceSection = stateFilePath
    ? `RESILIENCE:
- If the state file is missing or corrupted, reconstruct from active tasks
  (run beat status for each known task ID, rebuild plan from results)
- Always write the state file BEFORE exiting -- the system reads it to
  determine if the goal is complete
- If you cannot achieve the goal, write status: "failed" with an explanation
  in the context field. The system will terminate after a few iterations.`
    : `RESILIENCE:
- If context is lost, reconstruct from active tasks
  (run beat status for each known task ID, rebuild plan from results)
- The system evaluates your output to determine if the goal is achieved`;

  const systemPrompt = `ROLE: You are an autonomous software engineering orchestrator. You break down
complex goals into subtasks, delegate to worker agents, monitor progress,
and iterate until the goal is achieved.
${stateFileSectionBlock}
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

${decisionProtocol}

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

${resilienceSection}`;

  const userPrompt = `YOUR GOAL:\n${goal}`;

  // ── Operational contract ──────────────────────────────────────────────────────
  // Minimal operational knowledge the agent needs to function when a custom
  // systemPrompt replaces the auto-generated one. Built from the same shared
  // fragments as systemPrompt above — covers state file (when present), working
  // dir, CLI commands, and constraints.
  const stateFileContractBlock = stateFileSection
    ? `${stateFileSection}
When the goal is complete, set status: "complete" in the state file.
If you cannot achieve the goal, set status: "failed" with an explanation in the context field.

`
    : '';

  const operationalContract = `REQUIRED — ORCHESTRATOR CONTRACT:

${stateFileContractBlock}${workingDirectorySection}

${delegationSection}

${constraintsSection}`;

  return { systemPrompt, userPrompt, operationalContract };
}

/**
 * Build the goal-aware eval prompt for the agent evaluator in agent eval mode.
 *
 * DECISION: Goal is wrapped in XML-style delimiter tags (<goal>…</goal>) to
 * prevent prompt injection — a user-supplied goal cannot escape the delimiters
 * and alter the evaluator's instructions.
 *
 * ARCHITECTURE: Extracted from OrchestrationManagerService.createOrchestration()
 * so all prompt construction lives in this module (SRP).
 */
export function buildGoalEvalPrompt(goal: string): string {
  return `You are evaluating whether an orchestration goal has been achieved.

<goal>${goal}</goal>

Review the orchestrator's output from this iteration. Consider:
- Did the orchestrator indicate the goal is complete?
- Are there remaining tasks or unresolved issues mentioned?
- Does the output suggest all planned work has been done?

PASS if the goal appears achieved. FAIL if work remains.`;
}
