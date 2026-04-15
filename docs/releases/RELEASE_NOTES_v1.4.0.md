# Autobeat v1.4.0 — Evaluator Redesign & Reliability

New evaluation modes for loops, a two-phase judge evaluator, atomic PID file management, and a suite of internal reliability improvements targeting testability and correctness in the loop/schedule execution path.

---

## Highlights

- **Three evaluation modes**: `feedforward` (default — findings without a stop decision), `judge` (two-phase eval+judge with TOCTOU-safe file decisions), and `schema` (deterministic Claude `--json-schema` eval)
- **Database migrations v21 and v22**: Worker heartbeat column, loop eval columns (v21); CHECK constraints on `eval_type` and `judge_agent` via table recreation (v22) — back up your database before upgrading
- **Atomic PID file locking**: Schedule executor uses O_EXCL file creation to prevent double-execution races
- **SpawnOptions refactor**: `AgentAdapter.spawn()` now accepts a named options object instead of 6 positional parameters
- **Extracted pure functions**: `refetchAfterAgentEval`, `handleStopDecision`, `buildEvalPromptBase`, `checkActiveSchedules`, `registerSignalHandlers`, `startIdleCheckLoop` — all fully unit-tested

---

## New Evaluation Modes

The `evalType` field accepts three values: `'feedforward'` (default), `'judge'`, or `'schema'`. It is set per loop and stored in the `loops.eval_type` column.

### Feedforward (`evalType: 'feedforward'`) — Default

Gathers agent findings on every iteration and injects them as context into the next iteration's prompt — without making a stop/continue decision. The loop always runs to `maxIterations`.

Use this when you want progressive feedback during iteration but don't need a quality gate.

```json
{
  "evalType": "feedforward",
  "evalPrompt": "Review the changes and note any issues for the next iteration.",
  "maxIterations": 10
}
```

**No `evalPrompt` configured?** The evaluator returns immediately with no findings (`{ decision: 'continue', feedback: undefined }`) — a pure pass-through. The loop runs to `maxIterations` with no eval agent spawned.

### Judge (`evalType: 'judge'`)

Two-phase evaluation:

1. **Eval agent** (phase 1): runs `evalPrompt` and produces narrative findings
2. **Judge agent** (phase 2): reads findings and writes a structured JSON decision to `.autobeat-judge-task-{uuid}` in the working directory

The filename includes the full judge task ID (`task-{uuid}`) to prevent TOCTOU races — the work agent cannot guess it. Claude's `--json-schema` is used as belt-and-suspenders when `judgeAgent: 'claude'`. If both mechanisms fail, the evaluator defaults to `continue: true` (never blocks unexpectedly).

```json
{
  "evalType": "judge",
  "evalPrompt": "Review the test suite and identify any remaining failures.",
  "judgeAgent": "claude",
  "judgePrompt": "Based on the findings, should iteration continue? Stop when all tests pass."
}
```

Decision file format written by the judge agent:
```json
{"continue": true, "reasoning": "3 tests still failing — keep going."}
```
or
```json
{"continue": false, "reasoning": "All tests pass and code review is clean."}
```

### Schema (`evalType: 'schema'`)

Deterministic structured output evaluation using Claude's `--json-schema` flag. The eval agent is prompted with `evalPrompt` and must respond with a JSON object matching a fixed schema:

```json
{"continue": true, "reasoning": "..."}
```

Use this when you want strict structured output from Claude (no judge agent required). Only works with `judgeAgent: 'claude'` (or the loop's default agent if it is Claude).

```json
{
  "evalType": "schema",
  "evalPrompt": "Assess whether all acceptance criteria are met. Respond with continue=false only when all criteria pass.",
  "maxIterations": 5
}
```

---

## Reliability Improvements

### Atomic PID File Locking (#141)

The schedule executor now uses `O_EXCL` (create-or-fail) semantics when acquiring its PID file. Concurrent executor startups cannot both succeed — one receives `already-running` and exits cleanly. Stale PID files from crashed processes are detected via liveness check and cleaned up automatically.

```
acquirePidFile(pidPath, pid) → Result<'acquired' | 'already-running', Error>
```

### SpawnOptions Interface (#139)

`AgentAdapter.spawn()` now accepts a single `SpawnOptions` object:

```typescript
interface SpawnOptions {
  readonly prompt: string;
  readonly workingDirectory: string;
  readonly taskId?: string;
  readonly model?: string;
  readonly orchestratorId?: string;
  readonly jsonSchema?: string;
}
```

This is an internal refactor — no observable behaviour change. Existing functionality is identical.

---

## Architecture Notes

### New Modules

| Module | Purpose |
|--------|---------|
| `src/services/feedforward-evaluator.ts` | Feedforward exit condition evaluator |
| `src/services/judge-exit-condition-evaluator.ts` | Two-phase eval+judge evaluator |
| `src/services/eval-prompt-builder.ts` | Shared eval prompt context builder |
| `src/core/agents.ts` → `SpawnOptions` | Named spawn options interface |
| `tests/fixtures/eval-test-helpers.ts` | Shared eval test fixtures |

### Extracted Pure Functions

All extracted functions are DI-injectable and have dedicated unit tests:

- `refetchAfterAgentEval(loop, taskId)` — stale-state guard in `LoopHandler`
- `handleStopDecision(loop, iteration, evalResult, status)` — stop-path logic in `LoopHandler`
- `buildEvalPromptBase(loop, taskId, loopRepo)` — shared eval prompt context
- `acquirePidFile(pidPath, pid)` — atomic PID file locking
- `checkActiveSchedules(scheduleRepo)` — schedule liveness check
- `registerSignalHandlers(cleanup, proc?)` — SIGTERM/SIGINT registration
- `startIdleCheckLoop(scheduleRepo, intervalMs, onIdle, warn)` — idle exit timer

---

## Database Migrations

Two migrations are applied automatically on first startup after upgrading to v1.4.0.

**Back up your database before upgrading.** Migration v22 recreates the `loops` table — it is a destructive operation that cannot be rolled back without a backup.

### Migration v21 — Worker heartbeat + loop eval columns

- `workers.last_heartbeat INTEGER` — nullable; tracks when the owning process last wrote to the DB. Used for liveness detection.
- `loops.eval_type TEXT DEFAULT 'feedforward'` — evaluation strategy for the loop (`'feedforward'`, `'judge'`, or `'schema'`). Defaults to `'feedforward'` for backward compatibility with existing loops.
- `loops.judge_agent TEXT` — which agent runs the judge phase (`'claude'`, `'codex'`, or `'gemini'`). Nullable.
- `loops.judge_prompt TEXT` — custom prompt for the judge agent. Nullable.

### Migration v22 — CHECK constraints on eval_type and judge_agent (table rebuild)

SQLite does not support adding CHECK constraints via `ALTER TABLE`, so v22 recreates the `loops` table with:

- `eval_type CHECK (eval_type IS NULL OR eval_type IN ('feedforward', 'judge', 'schema'))`
- `judge_agent CHECK (judge_agent IS NULL OR judge_agent IN ('claude', 'codex', 'gemini'))`

All existing rows are copied into the new table before the old one is dropped. **This is a full table rebuild — back up your `~/.autobeat/autobeat.db` file before upgrading.**

---

## What's Changed Since v1.3.0

- #136 — feat: feedforward and judge evaluator modes
- #137 — refactor(loop-handler): extract refetchAfterAgentEval helper
- #138 — refactor(loop-handler): extract handleStopDecision helper
- #139 — refactor(agents): SpawnOptions object replaces 6 positional spawn() params
- #140 — refactor(eval): extract buildEvalPromptBase shared utility
- #141 — fix(schedule-executor): atomic PID file locking with sentinel result
- #142 — refactor(schedule-executor): extract pure functions with DI for testability
- #143 — refactor(tests): extract shared eval test fixtures

---

## Migration Notes

- **Back up your database before upgrading.** Migrations v21 and v22 are applied automatically on first startup. v22 recreates the `loops` table — a backup is required if you need rollback capability. Back up `~/.autobeat/autobeat.db` before running `npm install -g autobeat@1.4.0`.
- **`AgentAdapter.spawn()` signature change**: If you have custom `AgentAdapter` implementations (not using `BaseAgentAdapter`), update `spawn(prompt, workingDirectory, ...)` to `spawn({ prompt, workingDirectory, ... })`. The `ProcessSpawnerAdapter` compatibility shim is unaffected.
- Existing loops with no `evalType` configured are treated as `feedforward` (backward-compatible default set by migration v21).
- New optional fields `evalType`, `judgeAgent`, `judgePrompt` on loop creation — all optional with sensible defaults.

---

## Installation

```bash
npm install -g autobeat@1.4.0
```

MCP config (npx):
```json
{
  "mcpServers": {
    "autobeat": {
      "command": "npx",
      "args": ["-y", "autobeat@1.4.0", "mcp", "start"]
    }
  }
}
```

---

## Links

- [npm](https://www.npmjs.com/package/autobeat)
- [GitHub Issues](https://github.com/dean0x/autobeat/issues)
- [Changelog](../../CHANGELOG.md)
