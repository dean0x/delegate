# Loops Reference

Deep dive on retry and optimize strategies, eval modes, git integration, and loop recipes.

## Strategy Overview

| Strategy | Goal | Exit Condition | Output |
|----------|------|---------------|--------|
| **retry** | Get something to pass | Pass/fail (exit 0 = pass) | First passing result |
| **optimize** | Find the best result | Numeric score | Iteration with best score |

## Retry Strategy

Runs a task repeatedly until the exit condition passes (exit code 0) or limits are reached.

### Shell Eval (default)

```json
{
  "tool": "CreateLoop",
  "arguments": {
    "prompt": "Fix all failing tests in src/",
    "strategy": "retry",
    "exitCondition": "npm test",
    "workingDirectory": "/path/to/repo",
    "maxIterations": 10,
    "maxConsecutiveFailures": 3
  }
}
```

CLI:
```bash
beat loop "Fix all failing tests" --until "npm test" -w /path/to/repo
```

### Agent Eval

Use when the exit condition requires judgment (code quality, design correctness, etc.):

```json
{
  "tool": "CreateLoop",
  "arguments": {
    "prompt": "Refactor the auth module for better testability",
    "strategy": "retry",
    "evalMode": "agent",
    "evalPrompt": "Review the refactoring. PASS if dependency injection is used correctly and all tests pass. FAIL with explanation otherwise.",
    "workingDirectory": "/path/to/repo"
  }
}
```

CLI:
```bash
beat loop "Refactor the auth module" --eval-mode agent --strategy retry \
  --eval-prompt "Review changes. PASS if DI is correct and tests pass, else FAIL."
```

**Agent eval behavior (retry)**:
- Evaluator agent reads the task output and git diff
- Must output `PASS` or `FAIL` as the last line
- Optional explanation before the verdict
- `evalPrompt` customizes what the evaluator checks

## Optimize Strategy

Runs a task repeatedly, scoring each iteration, keeping improvements.

### Shell Eval

The exit condition script must output a numeric score to stdout:

```json
{
  "tool": "CreateLoop",
  "arguments": {
    "prompt": "Optimize the database query performance",
    "strategy": "optimize",
    "exitCondition": "node scripts/benchmark.js",
    "evalDirection": "minimize",
    "workingDirectory": "/path/to/repo",
    "maxIterations": 20
  }
}
```

CLI:
```bash
beat loop "Optimize query performance" --eval "node scripts/benchmark.js" --minimize
```

### Agent Eval

The evaluator agent scores each iteration 0-100:

```json
{
  "tool": "CreateLoop",
  "arguments": {
    "prompt": "Improve test coverage for the payment module",
    "strategy": "optimize",
    "evalMode": "agent",
    "evalDirection": "maximize",
    "evalPrompt": "Score the test coverage quality 0-100. Consider: branch coverage, edge cases, error paths, integration vs unit balance.",
    "workingDirectory": "/path/to/repo"
  }
}
```

CLI:
```bash
beat loop "Improve test coverage" --eval-mode agent --strategy optimize --maximize \
  --eval-prompt "Score coverage quality 0-100: branches, edge cases, error paths."
```

**Agent eval behavior (optimize)**:
- Evaluator agent reads the task output and git diff
- Must output a numeric score (0-100) as the last line
- `evalDirection`: `maximize` (higher is better) or `minimize` (lower is better)
- Only iterations that improve on the best score are kept

## Loop Configuration

| Parameter | Default | Range | Description |
|-----------|---------|-------|-------------|
| `maxIterations` | 10 | 0 = unlimited | Safety cap on iteration count |
| `maxConsecutiveFailures` | 3 | 0 = unlimited | Stop after N consecutive failures |
| `cooldownMs` | 0 | ≥ 0 | Delay between iterations (ms) |
| `evalTimeout` | 60000 | 1000-600000 | Eval script timeout (ms) |
| `freshContext` | true | boolean | Fresh agent context per iteration |
| `evalMode` | shell | shell, agent | How to evaluate iterations |
| `evalPrompt` | (default) | string | Custom eval instructions (agent mode) |
| `evalDirection` | — | minimize, maximize | Score direction (optimize only) |
| `gitBranch` | — | string | Git branch for iteration tracking |
| `priority` | P2 | P0, P1, P2 | Task priority per iteration |

### Fresh Context vs Checkpoint Continuation

- `freshContext: true` (default): Each iteration starts with a clean agent context. The agent sees only the original prompt. Best for independent attempts.
- `freshContext: false`: Each iteration continues from the previous iteration's checkpoint. The agent sees the original prompt plus the previous iteration's output, git state, and errors. Best for incremental improvement.

## Pipeline Loops

Repeat a multi-step pipeline per iteration instead of a single task.

### MCP

```json
{
  "tool": "CreateLoop",
  "arguments": {
    "pipelineSteps": [
      "Run static analysis and identify issues",
      "Fix all identified issues",
      "Run full test suite to verify"
    ],
    "strategy": "retry",
    "exitCondition": "npm test && npx biome check src/",
    "maxIterations": 5
  }
}
```

### CLI

```bash
beat loop --pipeline \
  --step "Run static analysis" \
  --step "Fix issues" \
  --step "Run tests" \
  --until "npm test && npx biome check src/"
```

### Behavior

- 2-20 steps per pipeline iteration
- Steps execute sequentially with linear dependencies within each iteration
- Exit condition evaluated after all pipeline steps complete
- Each iteration creates a fresh set of pipeline tasks

## Git Integration

Track loop iterations with git commits on a dedicated branch.

### Enable Git Tracking

```json
{
  "tool": "CreateLoop",
  "arguments": {
    "prompt": "Optimize bundle size",
    "strategy": "optimize",
    "exitCondition": "node measure.js",
    "evalDirection": "minimize",
    "gitBranch": "loop/bundle-optimization"
  }
}
```

CLI:
```bash
beat loop "Optimize bundle size" --eval "node measure.js" --minimize --git-branch loop/bundle-opt
```

### Git Behavior

- One branch for the entire loop lifecycle
- One commit per successful iteration
- Failed or discarded iterations are fully reverted to the appropriate target commit
- Best iteration commit SHA tracked for O(1) reset target lookup
- Git diffs tracked between iterations for context

## Loop Lifecycle

```
RUNNING → (iterations...) → COMPLETED (exit condition met)
RUNNING → (iterations...) → FAILED (max failures or max iterations)
RUNNING → PAUSED (PauseLoop) → RUNNING (ResumeLoop)
RUNNING → CANCELLED (CancelLoop)
```

### Pause and Resume

```json
{ "tool": "PauseLoop", "arguments": { "loopId": "...", "force": false } }
```

- Graceful pause (default): waits for current iteration to finish
- Force pause: cancels current iteration immediately
- State persists across server restarts
- Resume continues from where it left off

## Recipes

### Test Fixer

```json
{
  "tool": "CreateLoop",
  "arguments": {
    "prompt": "Read the failing test output and fix the root cause. Do not modify tests unless they are genuinely wrong.",
    "strategy": "retry",
    "exitCondition": "npm test",
    "workingDirectory": "/path/to/repo",
    "maxIterations": 5,
    "maxConsecutiveFailures": 3,
    "freshContext": false
  }
}
```

### Performance Optimizer

```json
{
  "tool": "CreateLoop",
  "arguments": {
    "prompt": "Profile the application, identify the slowest endpoint, and optimize it. Focus on database queries and unnecessary allocations.",
    "strategy": "optimize",
    "exitCondition": "node scripts/benchmark.js",
    "evalDirection": "minimize",
    "workingDirectory": "/path/to/repo",
    "maxIterations": 10,
    "gitBranch": "loop/perf-optimization"
  }
}
```

### Agent Quality Loop

```json
{
  "tool": "CreateLoop",
  "arguments": {
    "prompt": "Review the PR changes and improve code quality: reduce complexity, improve naming, add missing error handling.",
    "strategy": "optimize",
    "evalMode": "agent",
    "evalDirection": "maximize",
    "evalPrompt": "Score the code quality 0-100. Consider: readability, error handling, naming, complexity, test coverage. Output just the number.",
    "workingDirectory": "/path/to/repo",
    "maxIterations": 5,
    "gitBranch": "loop/quality-improvement"
  }
}
```

### Scheduled Nightly Loop

```json
{
  "tool": "ScheduleLoop",
  "arguments": {
    "prompt": "Run dependency audit, update outdated packages, and verify nothing breaks.",
    "strategy": "retry",
    "exitCondition": "npm audit --audit-level=high && npm test",
    "scheduleType": "cron",
    "cronExpression": "0 2 * * *",
    "timezone": "America/New_York",
    "maxIterations": 3,
    "workingDirectory": "/path/to/repo"
  }
}
```

### Pipeline Loop with Agent Eval

```json
{
  "tool": "CreateLoop",
  "arguments": {
    "pipelineSteps": [
      "Analyze code coverage gaps in src/services/",
      "Write tests to cover the identified gaps",
      "Run the full test suite to verify"
    ],
    "strategy": "optimize",
    "evalMode": "agent",
    "evalDirection": "maximize",
    "evalPrompt": "Score the test coverage improvement 0-100. Check: new branches covered, edge cases, no redundant tests.",
    "maxIterations": 5,
    "workingDirectory": "/path/to/repo"
  }
}
```
