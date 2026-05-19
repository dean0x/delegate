# Security Review Report

**Branch**: feat/dashboard-redesign-v1.3.0 -> main
**Date**: 2026-04-11 22:00
**Diff**: `git diff main...HEAD` (97 files, ~12.5k insertions)
**Focus areas covered**: file-logger, output streaming, usage parser, usage repository SQL,
orchestrator attribution, MCP adapter, database migrations.

---

## Executive summary

The PR is **architecturally clean from a security standpoint**. SQL is uniformly
parameterized (including the new dynamic-IN-list query and the recursive CTEs for
`task_usage` aggregation). The file-backed dashboard logger is built around a
constant, home-directory-rooted path (no user input flows in). Untrusted Claude
agent JSON is parsed defensively in `usage-parser.ts` with bounds checks and
returns `null` on any failure. Orchestrator attribution validates the
orchestrator ID against the local DB before use, and the MCP regex prevents
arbitrary prefix injection.

A handful of **defense-in-depth gaps** are worth tightening before this ships,
mainly around:

1. ANSI/terminal-escape sanitization on the live output stream (the regex used
   misses OSC sequences and raw `ESC` control chars — task output can manipulate
   the dashboard terminal).
2. Log injection via the unescaped `AUTOBEAT_ORCHESTRATOR_ID` env var written to
   stderr in `run.ts`.
3. Loose Zod regex on `metadata.orchestratorId` (no length / charset bounds).
4. Existing pre-existing concern: `OutputRepository.loadFromFile` joins a DB
   value into a filesystem path with no `outputDir` containment check.

There are no CRITICAL findings. None block merge — all are either MEDIUM
defense-in-depth improvements or LOW informational items.

---

## Issues in Your Changes (BLOCKING)

### CRITICAL

_None._

### HIGH

_None._

### MEDIUM

**Incomplete ANSI / terminal-escape stripping in live output stream** — `src/cli/dashboard/use-task-output-stream.ts:43`
**Confidence**: 85%
- Problem: `stripAnsi()` uses the regex `/\x1b\[[0-?]*[ -/]*[@-~]/g`, which matches
  only **CSI** sequences (`ESC [` ... final byte). It does **not** match:
  - **OSC sequences**: `ESC ]` ... `BEL` or `ESC \` (e.g., `\x1b]0;evil title\x07`,
    OSC 8 hyperlink injection: `\x1b]8;;https://attacker.example/\x1b\\…\x1b]8;;\x1b\\`).
  - **Bare `ESC` / charset shifts** (`ESC (B`, `ESC =`, etc.).
  - **DCS, APC, PM, SOS** (`ESC P`, `ESC _`, `ESC ^`, `ESC X`).
  - **Single-byte C1 control characters** (`\x9b`, `\x9d`).
  These pass through `mergeOutputLines()` and are rendered directly by Ink's
  `<Text>` to the user's terminal in `output-stream-view.tsx:48,101`. Live
  Claude (or any agent) output that contains malicious escape codes — including
  output the agent fetched from a remote URL or a local file — can rewrite the
  terminal title, inject clickable hyperlinks pointing at attacker sites, or
  corrupt the dashboard layout. The threat model is meaningful here because the
  whole point of Autobeat is delegating to background agents whose stdout the
  user does not directly read.
- Fix: Replace the hand-rolled regex with the well-known
  [`strip-ansi`](https://github.com/chalk/strip-ansi) library, or at minimum
  expand the regex to cover OSC, DCS, and single-character ESC sequences. Example
  (covers CSI + OSC + DCS + single-char ESC + C1):
  ```ts
  const ANSI_REGEX =
    // CSI / OSC / DCS / SOS / PM / APC + ST or BEL terminator,
    // single-char ESC sequences, and C1 controls
    /[\x1b\x9b][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z0-9\/#&.:=?%@~_]+)*|[a-zA-Z0-9]+(?:;[-a-zA-Z0-9\/#&.:=?%@~_]*)*)?\x07)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;
  ```
  Or, preferred:
  ```ts
  import stripAnsi from 'strip-ansi';
  export function stripAnsi(input: string): string { return stripAnsi(input); }
  ```
  Add a regression test that asserts OSC 8 hyperlink injection (`\x1b]8;;url\x07text\x1b]8;;\x1b\\`)
  is removed before display.

**Log injection via unescaped `AUTOBEAT_ORCHESTRATOR_ID` env var** — `src/cli/commands/run.ts:86`
**Confidence**: 88%
- Problem: When the orchestrator ID env var doesn't match a DB row,
  `run.ts` writes the raw value to stderr:
  ```ts
  process.stderr.write(`[autobeat] AUTOBEAT_ORCHESTRATOR_ID '${envOrchId}' not found in DB, ignoring\n`);
  ```
  `envOrchId` is the unvalidated, unescaped contents of an environment variable.
  Even though env vars are user-controlled in normal use, an attacker who can
  set the variable in a sub-shell context (CI runner, sourced script, profile
  injection) can plant ANSI escape sequences, line wraps, or impersonating log
  prefixes that confuse downstream log parsers and the user's terminal. Unlike
  the structured `logger.warn` path used in the MCP adapter (which JSON-escapes),
  this raw `stderr.write` propagates the attacker's bytes verbatim.
- Fix: Strip control characters and bound the displayed length, then prefer
  the structured logger:
  ```ts
  const safeId = envOrchId.replace(/[\x00-\x1f\x7f]/g, '?').slice(0, 200);
  process.stderr.write(`[autobeat] AUTOBEAT_ORCHESTRATOR_ID '${safeId}' not found in DB, ignoring\n`);
  ```
  Or call `this.logger.warn(...)` (structured/JSON output is auto-escaped).

**`metadata.orchestratorId` Zod schema lacks length and charset bounds** — `src/adapters/mcp-adapter.ts:79-82`
**Confidence**: 82%
- Problem: The schema accepts any string starting with `orchestrator-`:
  ```ts
  orchestratorId: z.string().regex(/^orchestrator-/).optional(),
  ```
  There is no `.max()`, no `.uuid()`, and no charset constraint after the prefix.
  An attacker who can call `DelegateTask` over MCP can send a multi-megabyte
  string or one containing arbitrary bytes. The value flows into:
  - `OrchestratorId(...)` (a no-op brand cast — `src/core/domain.ts:19`)
  - `getOrchestration` (parameterized — safe from SQLi)
  - `request.orchestratorId` and ultimately the spawned worker's
    `AUTOBEAT_ORCHESTRATOR_ID` env var (`base-agent-adapter.ts`)
  - Logs (`logger.warn` — JSON-escaped, OK)
  Although the DB validation step blocks unknown IDs from being persisted,
  the value is still copied into log lines, env vars on the spawned process,
  and any future code path that may render it. This is a defense-in-depth gap
  consistent with the project's "validate at boundaries" rule (CLAUDE.md #9).
- Fix: Tighten the schema to mirror the actual format produced by
  `createOrchestration` (`orchestrator-${crypto.randomUUID()}` — i.e. 13 +
  36 = 49 chars, hex + dashes only):
  ```ts
  orchestratorId: z
    .string()
    .regex(/^orchestrator-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    .optional(),
  ```
  Or at minimum: `.max(64)` plus `/^orchestrator-[A-Za-z0-9-]+$/`.

### LOW

**`OrchestratorId` brand constructor has no validation** — `src/core/domain.ts:19`
**Confidence**: 90%
- Problem: `export const OrchestratorId = (id: string): OrchestratorId => id as OrchestratorId;`
  is a no-op cast. The same pattern applies to `TaskId`, `LoopId`, etc., so this
  is repository-wide style; the v1.3.0 PR adds a new use site that re-exposes the
  gap. The Zod boundary in mcp-adapter is the only line of defense against
  malformed IDs, which makes the regex above critical.
- Fix: Either keep the boundary-only validation (and tighten the regex per the
  MEDIUM finding above) or move format validation into the brand constructor:
  ```ts
  export const OrchestratorId = (id: string): OrchestratorId => {
    if (!/^orchestrator-[0-9a-f-]{36}$/.test(id))
      throw new AutobeatError(ErrorCode.INVALID_INPUT, `Invalid OrchestratorId: ${id}`);
    return id as OrchestratorId;
  };
  ```

---

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`AUTOBEAT_ORCHESTRATOR_ID` env var injected without validation in `BaseAgentAdapter.spawn`** — `src/implementations/base-agent-adapter.ts:144-149`
**Confidence**: 78%
- Problem: `spawn()` accepts an optional `orchestratorId: string` parameter and
  injects it directly into the spawned worker's environment:
  ```ts
  ...(orchestratorId && { AUTOBEAT_ORCHESTRATOR_ID: orchestratorId }),
  ```
  There is no validation, length check, or escaping. The value is sourced from
  call sites that have varying levels of validation: MCP adapter performs the
  loose regex check; CLI `run.ts` reads from env directly. For an env var,
  arbitrary bytes are technically permitted, but downstream consumers (e.g.,
  the child agent's `run.ts` re-reading the env var) will write it back to
  stderr unescaped — see the log-injection finding above.
- Fix: Validate the format inside `spawn()` before injection, mirroring the
  brand-constructor change:
  ```ts
  if (orchestratorId && !/^orchestrator-[0-9a-f-]{36}$/.test(orchestratorId)) {
    return err(new AutobeatError(ErrorCode.INVALID_INPUT,
      `Invalid orchestratorId format`, { orchestratorId }));
  }
  ```

### LOW

**`process.stderr.write` log path hint doubles as predictable target** — `src/cli/dashboard/index.tsx:155-157`
**Confidence**: 70%
- Problem: The dashboard prints `[dashboard] logs → ${DEFAULT_DASHBOARD_LOG_PATH}`
  to scrollback before entering the alternate screen. The path is rooted in
  `~/.autobeat/dashboard.log` and the file is opened in append mode with
  default umask, which on most systems leaves it 0644 (world-readable). A
  multi-user box would let other local users `tail -f` everything the dashboard
  logs (task IDs, prompts in info messages, etc.).
- Fix: Open the log file with explicit `mode: 0o600` and tighten the parent
  directory similarly:
  ```ts
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const handle = await open(filePath, 'a', 0o600);
  ```
  (The orchestrator state files already do this — `orchestration-manager.ts:133`
  uses `mode: 0o700`.) This brings dashboard logs in line with the project's
  existing precedent.

---

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`OutputRepository.loadFromFile` joins a DB-stored filename into a filesystem path without containment check** — `src/implementations/output-repository.ts:139,191`
**Confidence**: 75%
- Problem: `loadFromFile(taskId, fileName)` and the matching `delete` path
  do `path.join(this.outputDir, fileName)` where `fileName` is read from the
  `task_output.file_path` column. If a future code path or migration ever
  populates that column with a value containing `..` segments (or an absolute
  path, since `path.join` happily accepts them and may produce unexpected
  results), the dashboard's new live-output streaming hook will read whatever
  file the SQLite row points at — whose contents then propagate into the
  user's terminal via the still-incomplete ANSI strip pipeline.
  Today, the only writer is `saveToFile`, which always uses `${taskId}.json`
  (taskIds are branded UUID strings), so the practical risk is low. But the
  v1.3.0 dashboard significantly increases the rate at which this code path is
  exercised (live polling, multiple panels), and the pattern is fragile.
- Fix: Sanitize the filename when reading it back, before any FS call:
  ```ts
  const safeName = path.basename(fileName);
  if (safeName !== fileName) throw new Error('Invalid file_path in task_output row');
  const filePath = path.join(this.outputDir, safeName);
  ```
  (Pre-existing — informational. Recommend opening a separate hardening issue.)

### LOW

**`writeFile` in `output-repository.ts:178` does not constrain mode** — `src/implementations/output-repository.ts:178`
**Confidence**: 70%
- Problem: Task output JSON files are written under the user's data directory
  with default mode (typically 0644). On a multi-user host the worker output
  (which can include prompts containing secrets, fetched URLs, etc.) is
  world-readable. The same hardening recommendation as the dashboard log
  applies.
- Fix: Pass `{ mode: 0o600 }` to `fsPromises.writeFile`. (Pre-existing —
  informational.)

---

## Suggestions (Lower Confidence)

- **Migration v18 lacks NOT NULL guard** — `src/implementations/database.ts:728-733` (Confidence: 60%) — `orchestrator_id` is nullable by design (sub-task attribution is optional), but consider a partial CHECK constraint that, when set, the value matches `orchestrator-%`. Same defense-in-depth motivation as the MCP regex tightening.
- **Aggregate SQL queries silently coerce `NULL` rows** — `src/implementations/usage-repository.ts:103-137` (Confidence: 60%) — The recursive CTE walks the retry chain and `LEFT JOIN`s `task_usage`. If a malicious task has been deleted but its usage row was not, the orphan can never be returned (which is fine), but the converse — a task with no usage — silently sums to 0. Not a security issue, but a billing/audit concern given the dashboard now shows cost.
- **`failZombieRunningOrchestrations` PID liveness check** — `src/services/recovery-manager.ts:200-260` (Confidence: 65%) — `process.kill(pid, 0)` returns true for *any* process with that PID, including PIDs reused by an unrelated process after the original worker died. On a busy host this can keep zombie orchestrations marked as live indefinitely. Mitigation would be to check PID + start time against the worker registration row, but this is out of scope for v1.3.0.

---

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 3 | 1 |
| Should Fix | - | 0 | 1 | 1 |
| Pre-existing | - | - | 1 | 1 |

**Security Score**: 8 / 10
**Recommendation**: **APPROVED_WITH_CONDITIONS**

### Conditions for merge

1. **Replace `stripAnsi` regex** with a comprehensive implementation (or the
   `strip-ansi` library) and add a regression test for OSC sequences.
   (`use-task-output-stream.ts:43`)
2. **Sanitize the env-var echo** in `run.ts:86` (strip control chars + length cap).
3. **Tighten the Zod regex** for `metadata.orchestratorId` to bound length and
   charset (`mcp-adapter.ts:79-82`).

The remaining LOW/MEDIUM defense-in-depth items can be deferred to a hardening
PR but should be tracked.

### Why no CRITICAL/HIGH

- All SQL (including the new recursive CTE in `usage-repository.ts` and the
  dynamic IN-list in `task-repository.ts:findByOrchestratorId`) uses bound
  parameters; no string interpolation of caller-supplied values into SQL
  fragments.
- `FileLogger.create()` is called with no arguments and resolves to
  `~/.autobeat/dashboard.log`; user input does not flow into the path. The
  fallback to `SilentLogger` on open failure is correct and never throws.
- `usage-parser.ts` parses untrusted Claude JSON defensively: try/catch around
  the entire body, bounds checks (`MAX_COST_USD`), strict numeric coercion,
  and `null` returns on any failure. Prototype pollution via `JSON.parse` is
  not exploitable here because only specific own-property accesses are made
  on the parsed object (`obj.usage`, `obj.total_cost_usd`, etc.).
- The orchestrator attribution flow is gated by a DB-existence check in both
  the MCP path (`mcp-adapter.ts`) and the CLI path (`run.ts`); stale or
  fabricated IDs cannot be persisted onto a task row.
- The new dashboard mutation keybindings (`c`, `d`) all dispatch through the
  existing service layer, which enforces status transitions and ownership;
  no privileged actions bypass that layer.
