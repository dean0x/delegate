# Testing Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17

## Issues in Your Changes (BLOCKING)

### HIGH

**[P1] Missing Coverage: isOutputMessage type guard — missing/null field rejection**
**Confidence**: 92%
- **Source location**: `src/implementations/tmux/tmux-connector.ts:59-69` (the `isOutputMessage` function)
- **What's untested**: The type guard validates 5 fields (object non-null, sequence is number, timestamp is string, type is string and in valid set, content is string). Tests cover the invalid-type-value branch (test for `type: 'unknown-type'`) and implicitly test the happy path, but there are no tests for: (a) `null` input, (b) non-object input (string, number), (c) missing `sequence` field, (d) missing `content` field, (e) `sequence` as string instead of number.
- **Risk**: A malformed message file missing a required field could pass the type guard undetected, causing downstream runtime errors in `deliverSingle` or `onOutput` callbacks.
- **Suggested test**: Unit tests for `isOutputMessage` (or via `handleMessageFile`) with inputs like `null`, `"string"`, `{ type: "stdout", content: "x" }` (missing sequence), `{ sequence: "1", ... }` (wrong type for sequence).

---

**[P1] Missing Coverage: Validator does not cache failure results — retry-after-failure path**
**Confidence**: 90%
- **Source location**: `src/implementations/tmux/tmux-validator.ts:54-62` — `if (result.ok) this.cached = result;`
- **What's untested**: The validator intentionally only caches success, so a failed validation can be retried. No test verifies that a second `validate()` call re-runs `exec` after an initial failure. The existing cache test only covers the success-caching behavior.
- **Risk**: If the conditional caching logic is accidentally changed to cache errors too, a transient startup failure (e.g., PATH not yet set) would permanently poison the validator. This is explicitly documented as a design decision but has no regression test.
- **Suggested test**: Create a validator where exec fails on the first call then succeeds on the second. Assert that the first `validate()` returns err, the second returns ok, and `exec` was called 3+ times (2 from the retry: tmux + jq).

---

**[P1] Missing Coverage: `handleMessageFile` — invalid JSON structure passes parse but fails isOutputMessage**
**Confidence**: 88%
- **Source location**: `src/implementations/tmux/tmux-connector.ts:614-616`
- **What's untested**: When `readFile` returns valid JSON that is _not_ an OutputMessage (e.g., `{}`), the code logs `'Output message missing required fields'` and returns. The existing test for invalid type (`'unknown-type'`) covers the `VALID_OUTPUT_TYPES` branch inside `isOutputMessage`, but there is no test for structurally valid JSON that is simply not an OutputMessage (e.g., `{ "foo": "bar" }`). The "missing required fields" log message is never asserted.
- **Risk**: The warning message path is untested. If the log message or log level changes, no test catches the regression.
- **Suggested test**: Fire a message file containing `{ "foo": "bar" }` and assert `logger.warn` is called with `'Output message missing required fields'`.

---

**[P1] Missing Coverage: `flushPendingFiles` — unreadable individual message file during flush**
**Confidence**: 85%
- **Source location**: `src/implementations/tmux/tmux-connector.ts:552-559` (`parseMessageFile` catch block)
- **What's untested**: When `readFileSync` throws for one file during flush (e.g., permission denied), `parseMessageFile` returns null and logs `'Flush: failed to parse message file'`. The test for missing `messagesDir` covers `readdirSync` throwing, but no test covers `readFileSync` throwing for an individual file while other files succeed.
- **Risk**: A corrupt or locked message file during flush could silently skip messages. Without a test, there is no guarantee the flush continues processing remaining files after one fails.
- **Suggested test**: Set up flush with 3 files where the middle file throws on `readFileSync`. Assert that messages 1 and 3 are delivered and `logger.warn` is called with `'Flush: failed to parse message file'`.

---

**[P1] Missing Coverage: `dispose()` calls `onExit(null, 'SHUTDOWN')` for each session**
**Confidence**: 85%
- **Source location**: `src/implementations/tmux/tmux-connector.ts:277`
- **What's untested**: The dispose test ("dispose flushes pending messages before closing") asserts `onExit(null, 'SHUTDOWN')` for a single session, and the multi-session dispose test asserts handles are cleared but does NOT assert that `onExit(null, 'SHUTDOWN')` is called for EACH session. If dispose loops but fails to call `onExit` on the second session, no test catches it.
- **Risk**: Tasks from destroyed sessions could remain stuck in RUNNING state if `onExit` is not called for all sessions during shutdown.
- **Suggested test**: Spawn 2 sessions with separate `onExit` callbacks, call `dispose()`, and assert both `onExit` callbacks received `(null, 'SHUTDOWN')`.

---

### MEDIUM

**[P2] Missing Coverage: `listSessions` — lines with NaN for created/width/height are skipped**
**Confidence**: 85%
- **Source location**: `src/implementations/tmux/tmux-session-manager.ts:257`
- **What's untested**: The `isNaN(created) || isNaN(width) || isNaN(height)` check on line 257 silently skips lines where numeric fields cannot be parsed. The existing "malformed lines" test only covers lines with fewer than 5 parts. Lines with 5+ parts but non-numeric values (e.g., `beat-task-abc:not-a-number:0:220:50`) are not tested.
- **Risk**: A tmux version that outputs unexpected formats in numeric fields could cause sessions to silently disappear from staleness checks, leading to false STALE detection.
- **Suggested test**: Provide a line like `beat-task-abc:not-a-number:0:220:50` and assert it is skipped while a valid line in the same output is still returned.

---

**[P2] Missing Coverage: `listSessions` — non-idempotent error path**
**Confidence**: 84%
- **Source location**: `src/implementations/tmux/tmux-session-manager.ts:229-233`
- **What's untested**: When `list-sessions` returns status 1 with an error message that does NOT match `SESSION_NOT_FOUND_PATTERNS` (e.g., `'server crashed'`), the code returns `err(tmuxSessionFailed('list', ...))`. No test covers this path. The existing test only covers the "no server running" idempotent success path.
- **Risk**: An actual tmux server failure during `listSessions` would propagate an error, but no test verifies the error code or message.
- **Suggested test**: Mock exec to return `{ status: 1, stderr: 'server crashed', stdout: '' }` for a `list-sessions` command and assert `result.ok === false` with `ErrorCode.TMUX_SESSION_FAILED`.

---

**[P2] Missing Coverage: `getSessionEnvironment` — output line with no `=` sign**
**Confidence**: 82%
- **Source location**: `src/implementations/tmux/tmux-session-manager.ts:294-295`
- **What's untested**: When `show-environment` returns status 0 but the output line has no `=` character (e.g., `-REMOVED_VAR` for tmux's "removed variable" format), the code returns `ok(undefined)`. No test covers this edge case.
- **Risk**: tmux uses `-VAR_NAME` format for removed/unset variables; the code handles it implicitly but without a test.
- **Suggested test**: Mock exec to return `{ status: 0, stdout: '-MY_VAR' }` and assert `result.value === undefined`.

---

**[P2] Missing Coverage: `injectEnvironment` returns false on exec failure — observable via test**
**Confidence**: 80%
- **Source location**: `src/implementations/tmux/tmux-session-manager.ts:155-156`
- **What's untested**: When the batched `set-environment` command fails (exec returns non-zero status), `injectEnvironment` returns `false`. The code notes this is best-effort, but no test verifies that `createSession` still returns `ok` when env injection fails. The source comment says "observable only via exec mock in tests" but no test exercises this.
- **Risk**: If someone adds error propagation for env injection failure, the silent-success behavior breaks with no test to catch the regression.
- **Suggested test**: Mock exec so `new-session` succeeds but `set-environment` returns status 1. Assert `createSession` still returns ok.

---

**[P2] Missing Coverage: sentinel watcher `catch` block — `startSentinelWatcher` throws**
**Confidence**: 80%
- **Source location**: `src/implementations/tmux/tmux-connector.ts:356-359`
- **What's untested**: When `fs.watch` for the sentinel directory throws (not the messages watcher), the code catches and logs `'Failed to start sentinel watcher'`. The test "spawn succeeds even when the messages watcher throws" only covers the second `watch` call throwing. No test covers the first `watch` call (sentinel watcher) throwing.
- **Risk**: If the session directory is not ready when the sentinel watcher is created, the system degrades to staleness detection. No test verifies this degraded path works correctly.
- **Suggested test**: Mock `watch` to throw on the first call (sentinel) but succeed on the second (messages). Assert spawn still succeeds and `logger.warn` contains `'Failed to start sentinel watcher'`.

---

**[P2] Missing Coverage: `handleMessageFile` — readFile throws (non-rejection, sync throw from callback)**
**Confidence**: 80%
- **Source location**: `src/implementations/tmux/tmux-connector.ts:384-389` (the `.catch` handler in `startMessagesWatcher`)
- **What's untested**: The `.catch` handler on `handleMessageFile` logs `'handleMessageFile threw unexpectedly'`. The existing test "calls logger.warn when readFile rejects" covers the readFile rejection, but the `.catch` handler specifically fires when `handleMessageFile` itself throws (not just when readFile rejects). These are the same path in practice, but the logged message `'handleMessageFile threw unexpectedly'` is never directly asserted.
- **Risk**: Low risk as the existing test implicitly covers this, but the specific log message is not verified.
- **Suggested test**: Assert that the warn call specifically contains `'handleMessageFile threw unexpectedly'` (or acknowledge the existing test is sufficient and mark as covered).

---

**[P2] Missing Coverage: `cleanup` validation — taskId and sessionsDir security validation**
**Confidence**: 82%
- **Source location**: `src/implementations/tmux/tmux-hooks.ts:212-222`
- **What's untested**: `cleanup()` validates `taskId` against `TASK_ID_REGEX` and `sessionsDir` against `SAFE_PATH_REGEX` before calling `rmSync`. Only the happy path and `rmSync` throw are tested. No test verifies that cleanup rejects an invalid `taskId` or unsafe `sessionsDir`.
- **Risk**: The cleanup method is a public interface. Without validation tests, someone could regress the security checks and allow path traversal via `cleanup('../../etc', '/tmp')`.
- **Suggested test**: Call `cleanup('$(evil)', '/tmp/sessions')` and assert it returns err with `TMUX_HOOK_FAILED`. Same for `cleanup('task-ok', "/tmp/it's-bad")`.

---

**[P2] Missing Coverage: `handleMessageFile` — message files with `.tmp` suffix and non-`.json` suffix are ignored**
**Confidence**: 80%
- **Source location**: `src/implementations/tmux/tmux-connector.ts:376-378`
- **What's untested**: The messages watcher ignores files ending in `.tmp` (tested) and also ignores files NOT ending in `.json` (line 378). There is no test for a non-`.json`, non-`.tmp` file like `00001-stdout.txt` or `README` appearing in the messages directory.
- **Risk**: Low — the guard is straightforward. But filesystem events from unexpected files (e.g., editor swap files `.swp`) could trigger unnecessary processing without this guard.
- **Suggested test**: Fire `fireMessage('00001-stdout.txt')` and assert `onOutput` is not called and no readFile attempt is made.

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Missing Coverage: `handleSentinel` for unknown sentinel filenames** - `src/implementations/tmux/tmux-connector.ts:343` (Confidence: 65%) — The sentinel watcher callback only processes `.done` and `.exit` filenames. Other files (e.g., `.seq`, editor temp files) are silently ignored. No negative test verifies that a random file like `.seq` in the session directory does NOT trigger onExit.

- **Missing Coverage: `forceDeliverRemaining` with empty pending map** - `src/implementations/tmux/tmux-connector.ts:569-570` (Confidence: 60%) — The early-return guard `if (session.pendingMessages.size === 0) return` is implicitly exercised by flush tests that have no pending messages, but no test explicitly targets this guard.

- **Missing Coverage: Batch stale detection — multiple sessions go stale in the same tick** - `src/implementations/tmux/tmux-connector.ts:479-486` (Confidence: 70%) — The code collects stale entries into an array and processes them in a batch to avoid mutating `activeSessions` during iteration, then restarts the timer once. No test spawns 2+ sessions and makes both go stale in the same tick to verify batch behavior and single timer restart.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 5 | 7 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Testing Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The test suite is solid with 160+ tests covering the main happy paths, error paths, and concurrency scenarios. The 12 identified gaps are primarily around secondary error branches, type guard edge cases, and security validation on the `cleanup()` public interface. None are critical — the existing tests would catch most regressions. The P1 findings (validator retry-after-failure, isOutputMessage edge cases, dispose multi-session onExit) represent the highest-value additions for coverage confidence.
