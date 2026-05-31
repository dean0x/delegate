# Phase B Handoff: Interactive Mode — Arg Cleanup, SessionState Enum, prepareForReuse Protocol

## Phase Summary

Phases A and B are complete. Five commits on `feat/stop-hook--full-interactive-mode-for-all`.

### Phase B commits (this phase)
- `c5bca53` feat(claude-adapter): remove --output-format stream-json from interactive mode
- `a74e852` feat(tmux-connector): SessionState enum + prepareForReuse + initTaskDirectory
- `0da9335` style(stop-hook): reformat runHook env spread (cosmetic)
- `ccd859c` feat(worker-pool): call prepareForReuse in reuseSession before sendKeys(prompt)

---

## All Files Created/Modified (Phases A + B)

### Phase A (created)
- `scripts/autobeat-stop-hook.sh` — Unified Stop hook script for Claude Code and Codex CLI
- `tests/integration/tmux/stop-hook.test.ts` — 29 integration tests

### Phase A (modified)
- `package.json` — Added `"autobeat-stop-hook"` to `bin`
- `src/cli/commands/init.ts` — Added Stop hook configuration to `beat init`
- `tests/unit/cli-init.test.ts` — 26 unit tests for hook config

### Phase B (modified)
- `src/implementations/claude-adapter.ts` — Removed `--output-format stream-json` from `buildTmuxArgs()` (no effect in interactive REPL mode)
- `tests/unit/implementations/build-tmux-command.test.ts` — Test updated to assert arg NOT present
- `src/implementations/tmux/types.ts` — Added `initTaskDirectory()` to `TmuxHooksPort`
- `src/core/tmux-types.ts` — Added `prepareForReuse()` to `TmuxConnectorPort`
- `src/implementations/tmux/tmux-hooks.ts` — Implemented `initTaskDirectory()`: creates `sessionsDir/taskId/messages/` + writes `.seq=0`
- `src/implementations/tmux/tmux-connector.ts` — SessionState enum, `triggerExit()` parking logic, `prepareForReuse()` method (see below)
- `tests/fixtures/mocks.ts` — Added `prepareForReuse: vi.fn()` to `MockTmuxConnector`
- `tests/unit/implementations/tmux/tmux-connector.test.ts` — 11 new tests (86 total)
- `tests/unit/implementations/tmux/tmux-hooks.test.ts` — 7 new tests (62 total)
- `src/implementations/event-driven-worker-pool.ts` — Added `prepareForReuse()` call as step 5 in `reuseSession()`
- `tests/unit/implementations/event-driven-worker-pool.test.ts` — 3 new Phase B tests (68 total)

---

## Key Architecture Established

### SessionState Enum (`src/implementations/tmux/tmux-connector.ts`)

```typescript
type SessionState = 'active' | 'parked' | 'exited';
```

`ActiveSession` now has `state: SessionState` (replaces `exited: boolean`) plus two new fields:
- `sessionDir: string` — root dir for this session's sentinel/message files
- `persistent: boolean` — true when the session was spawned with `config.persistent: true`

Transitions:
- `active` → `parked`: `triggerExit()` on a persistent session (tmux stays alive; watchers closed; session removed from `activeSessions` map)
- `active` → `exited`: `triggerExit()` on a non-persistent session (tmux destroyed; full cleanup)
- `parked` → `active`: `prepareForReuse()` (new task dir, new watchers, re-registered in map)

Staleness timer: `if (session.state !== 'active') continue;` — parked sessions are intentionally idle and must not be killed.

### prepareForReuse() Protocol

```typescript
// TmuxConnectorPort (src/core/tmux-types.ts)
prepareForReuse(handle: TmuxHandle, newTaskId: TaskId, callbacks: SpawnCallbacks): Result<void, AutobeatError>;
```

Steps performed inside `prepareForReuse()`:
1. `hooks.initTaskDirectory(newTaskId, sessionsDir)` — create new task dir + messages dir + `.seq=0`
2. Build new `ActiveSession` with `state: 'active'`, `sessionDir` from step 1
3. `startWatchers(session, callbacks)` — start `.done`/`.exit` file watchers
4. `activeSessions.set(newTaskId, session)` — register in active map
5. `restartSharedStalenessTimer()` — reset staleness detection for the new session

### reuseSession() Step Order (`src/implementations/event-driven-worker-pool.ts`)

The protocol now has 6 steps:
1. setEnvironment with new task vars
2. sendKeys `/clear` 
3. settle delay (configurable, ~200ms)
4. [Phase B, new] `prepareForReuse()` — creates task dir, watchers, registers session
5. sendKeys(prompt) — agent receives the new task prompt
6. Worker state remap (taskIdRef update, WorkerState update, event emission)

On `prepareForReuse()` failure: warn + call `cleanupPersistentSession(key)` → returns `ok(null)` → caller spawns fresh session. The iteration is not lost.

### initTaskDirectory() (`src/implementations/tmux/tmux-hooks.ts`)

```typescript
initTaskDirectory(taskId: TaskId, sessionsDir: string): Result<{ sessionDir: string; messagesDir: string }, AutobeatError>
```

Creates:
- `sessionsDir/taskId/` (mode 0o700)
- `sessionsDir/taskId/messages/` (mode 0o700)
- `sessionsDir/taskId/.seq` with content `"0"`

---

## Phase A Key Patterns (still relevant)

- Message file format: `{"sequence":N,"timestamp":"ISO8601Z","type":"result","content":"<string>"}` — matches `isOutputMessage()` in `src/implementations/tmux/tmux-connector.ts`
- Sequence counter: `$TASK_DIR/.seq` file, zero-padded 5-digit filenames (`00001-result.json`)
- Sentinel files: `$TASK_DIR/.done` (normal completion), `$TASK_DIR/.exit` (error/interrupt)
- `AUTOBEAT_TASK_ID` — hook reads from tmux session env first (supports task ID mutation on reuse)
- `AUTOBEAT_SESSIONS_DIR` — base dir for all task subdirs
- `AUTOBEAT_WORKER=true` — guard that makes hook a no-op in non-worker sessions

---

## What Phase C Needs to Know

Phase C (the wrapper script / agent launch integration) should build on:

1. **`prepareForReuse()` is already wired** — `reuseSession()` calls it before sending the prompt. Phase C does not need to touch the reuse flow.

2. **`initTaskDirectory()` is the canonical dir creator** — Use `hooks.initTaskDirectory(taskId, sessionsDir)` for fresh session spawn too (first iteration). The `.seq=0` file seeds sequence numbering for the stop hook.

3. **`AUTOBEAT_TASK_ID` must be set in tmux session env** — `setEnvironment()` already does this in the reuse path. Verify it is also set in the initial `spawn()` path (in `ClaudeAdapter.buildTmuxArgs()` or equivalent). The stop hook reads it from tmux env, not shell env, for live sessions.

4. **Staleness timer ignores `'parked'` sessions** — Phase C should not implement any additional "skip parked" logic; it is already in `TmuxConnector`.

5. **`triggerExit()` parks persistent, destroys non-persistent** — This is regression-safe. Phase C code that calls `connector.destroy()` directly on persistent handles should be reviewed; prefer `triggerExit()` to get proper parking behavior.

6. **`buildTmuxArgs()` no longer includes `--output-format stream-json`** — Claude Code output parsing in Phase C must not assume stream-json format. Use the stop hook message files as the output channel.

---

## Tests to Run

```bash
npm run test:tmux:integration   # stop-hook.test.ts (29), session-lifecycle (5), hook-script-gen (11)
npm run test:tmux               # connector (86), hooks (62), session-manager (74), validator (15)
npm run test:implementations    # event-driven-worker-pool (68) + all other impl tests
npm run test:cli                # cli-init.test.ts (68 tests)
```
