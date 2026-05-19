# Reliability Review Report

**Branch**: feat-176-tmux-abstraction-layer -> main
**Date**: 2026-05-17

## Issues in Your Changes (BLOCKING)

### HIGH

**deliveredSequences Set grows unbounded over session lifetime** - `src/implementations/tmux/tmux-connector.ts:309`
**Confidence**: 92%
- Problem: The `deliveredSequences` Set accumulates every delivered sequence number for the lifetime of a session. For long-running agent sessions (hours/days), this grows without bound. Unlike `pendingMessages` (which has the MAX_PENDING_MESSAGES cap), `deliveredSequences` has no eviction strategy.
- Fix: Since messages are delivered in order (monotonically increasing sequence numbers), the Set is only needed to guard against duplicates in the gap-fill delivery loop. Replace the unbounded Set with a single `lastDeliveredSeq: number` watermark:
```typescript
// Replace deliveredSequences: Set<number> with:
lastDeliveredSeq: number; // initialized to 0

// Replace the duplicate check:
if (msg.sequence > session.lastDeliveredSeq) {
  session.lastDeliveredSeq = msg.sequence;
  callbacks.onOutput(msg);
}
```

**Staleness timer has a timing logic flaw -- lastAliveCheck only advances on alive=true, creating premature stale detection** - `src/implementations/tmux/tmux-connector.ts:189-214`
**Confidence**: 85%
- Problem: The staleness timer initializes `lastAliveCheck = Date.now()` at spawn time, then only updates it when `isAlive` returns true (line 212). If the session is alive but `isAlive()` returns an error (a transient exec failure), `lastAliveCheck` is NOT updated. After `maxSilenceMs` of transient failures, the session is incorrectly marked STALE even though it may still be running. The current logic conflates "can't determine alive status" (exec error) with "session confirmed dead".
- Fix: Distinguish between "confirmed dead" and "unknown/error". Only count silence when `isAlive` explicitly returns `ok(false)`:
```typescript
const aliveResult = this.deps.sessionManager.isAlive(session.handle.sessionName);
if (aliveResult.ok) {
  if (aliveResult.value) {
    // Confirmed alive — reset
    lastAliveCheck = Date.now();
  } else {
    // Confirmed dead — check silence window
    const silentMs = Date.now() - lastAliveCheck;
    if (silentMs >= stalenessConfig.maxSilenceMs) {
      this.triggerExit(config.taskId, session, null, 'STALE', callbacks);
    }
  }
  // else: error result — don't advance or penalize, just skip this tick
}
```

### MEDIUM

**Wrapper script: set -e interacts poorly with PIPESTATUS capture after pipe** - `src/implementations/tmux/tmux-hooks.ts:57-96`
**Confidence**: 82%
- Problem: The wrapper uses `set -euo pipefail` and then reads `PIPESTATUS[0]` after the pipe `agentCommand ... | while ... done`. With `pipefail` enabled, if the agent exits non-zero, bash exits immediately at the pipe statement (because `set -e` triggers on the failing pipeline). The `EXIT_CODE=${PIPESTATUS[0]}` line is never reached. The sentinel file is never written, which means completion detection falls back entirely to the staleness timer (60s default delay vs. immediate).
- Fix: Disable `errexit` for the pipeline capture:
```bash
set +e
${config.agentCommand} ${agentArgs} 2>&1 | while IFS= read -r line; do
  ...
done
EXIT_CODE=${PIPESTATUS[0]}
set -e
```

**No bound on debounceTimers Map growth** - `src/implementations/tmux/tmux-connector.ts:149-155`
**Confidence**: 80%
- Problem: Each unique filename creates an entry in `session.debounceTimers`. If the fs.watch fires for many unique filenames rapidly (e.g., hundreds of output messages arriving in a burst), the Map can hold up to N entries simultaneously where N is the number of messages in a 50ms window. While each timer eventually fires and removes itself, there is no cap to prevent a burst from consuming excessive memory during the debounce window.
- Impact: In practice, for typical agent output rates (tens of messages per second), this is unlikely to be a problem. But the pattern violates bounded-resource principles.
- Fix: Accept or add a comment noting this is bounded by `MAX_PENDING_MESSAGES` in practice (since each debounce timer leads to a pending message, and that buffer is capped). Alternatively, add an explicit size check:
```typescript
if (session.debounceTimers.size > MAX_PENDING_MESSAGES) {
  this.deps.logger.warn('Debounce buffer overflow — delivering immediately');
  // Clear all timers and deliver synchronously
}
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**cwd value not escaped in shell command construction** - `src/implementations/tmux/tmux-session-manager.ts:99`
**Confidence**: 85%
- Problem: The `cwd` value is embedded into the tmux command with single quotes (`-c '${config.cwd}'`) but the value itself is not escaped. If `config.cwd` contains a single quote (e.g., `/Users/dean/O'Brien/project`), the shell command breaks and may execute unintended fragments.
- Fix: Apply the same single-quote escaping used for the command itself:
```typescript
const escapedCwd = config.cwd.replace(/'/g, "'\\''");
const cwdFlag = config.cwd ? ` -c '${escapedCwd}'` : '';
```

**Empty catch with no-op comment on env var injection failure** - `src/implementations/tmux/tmux-session-manager.ts:130-133`
**Confidence**: 80%
- Problem: When `set-environment` fails, the error is silently swallowed with only a code comment. For reliability, failures should at minimum be logged so operators can diagnose why a session is missing expected environment variables. The comment says "log the failure" but no actual logging occurs (no logger is injected into TmuxSessionManager).
- Fix: Either inject a logger and emit a warning, or accumulate failed env vars and return them in the Result context so the caller can log.

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Wrapper script flock portability** - `src/implementations/tmux/tmux-hooks.ts:66` (Confidence: 65%) -- `flock` is Linux-specific; macOS uses a different locking mechanism. The `2>/dev/null || true` suppresses the error on macOS but means sequence numbers are not atomically protected on that platform, which could produce duplicate sequences under high concurrency.

- **TmuxSessionConfig.cwd is typed as required but optional behavior** - `src/implementations/tmux/types.ts:17` vs `tmux-session-manager.ts:99` (Confidence: 70%) -- The type declares `cwd: string` as required, but the session manager checks `if (config.cwd)` as if it could be falsy. If the interface contract says cwd is always present, the conditional check is dead code; if it can be absent, the type should be `cwd?: string`.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Reliability Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The tmux abstraction layer demonstrates strong reliability fundamentals: bounded pending-message buffer (MAX_PENDING_MESSAGES=100), staleness detection with configurable timer, watcher-before-session ordering invariant, and comprehensive resource cleanup in dispose(). The bounded buffer cap and cleanup patterns align well with the documented feature knowledge.

However, two HIGH issues should be addressed: (1) the deliveredSequences Set grows without bound over long-lived sessions, and (2) the staleness timer conflates transient exec errors with confirmed-dead sessions, which can produce false STALE exits. The wrapper script's interaction with `set -e` and `pipefail` is also a practical reliability concern since it can prevent sentinel file creation.

*applies PF-001 — all findings surfaced for resolution, none deferred.*
