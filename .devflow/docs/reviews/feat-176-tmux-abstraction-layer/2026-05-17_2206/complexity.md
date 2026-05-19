# Complexity Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17

## Issues in Your Changes (BLOCKING)

### HIGH

**`createSession()` exceeds 50-line threshold (58 lines, 3 concerns)** - `tmux-session-manager.ts:72-129`
**Confidence**: 85%
- Problem: This method handles three distinct concerns in sequence: (1) session creation with tmux spawn, (2) auto-variable construction, and (3) env-var injection via a batched shell command. The env-var injection block (lines 105-126) is an independent concern that could be extracted, bringing the method comfortably under the 50-line threshold.
- Fix: Extract the env-var injection block (lines 105-126) into a private `injectEnvironment(sessionName: string, config: TmuxSessionConfig, taskId: string): void` method. The remaining `createSession()` would be ~36 lines.
```typescript
// After session creation succeeds:
this.injectEnvironment(config.name, config, taskId);
return ok({ sessionName: config.name, taskId });

// New extracted method:
private injectEnvironment(sessionName: string, config: TmuxSessionConfig, taskId: string): void {
  const autoVars: Record<string, string> = {
    AUTOBEAT_TASK_ID: taskId,
    AUTOBEAT_SPAWN_TIME: new Date().toISOString(),
  };
  const allEnv = { ...(config.env ?? {}), ...autoVars };
  const validEntries = Object.entries(allEnv)
    .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key));
  if (validEntries.length > 0) {
    const commands = validEntries
      .map(([key, value]) => `tmux set-environment -t ${sessionName} ${key} '${escapeSingleQuoted(value)}'`)
      .join(' && ');
    this.deps.exec(commands);
  }
}
```

**`buildWrapperScript()` exceeds 50-line threshold (54 lines) — bash template with mixed concerns** - `tmux-hooks.ts:68-121`
**Confidence**: 82%
- Problem: This function generates a full bash script as a template literal. The 54-line count is slightly above threshold. The function mixes bash template construction (heredoc-style) with path computation. While template literals for bash scripts inherently resist decomposition (splitting the string across functions hurts readability), the function's length crosses the guideline boundary.
- Fix: Extract the `sessionDir` and `agentArgs` computation to the caller (`generateWrapper` already computes `sessionDir`), passing them as parameters instead of recomputing. Alternatively, extract the `next_seq()` bash function block into a named constant (it is a stable, self-contained shell utility). This would bring the function to ~45 lines.
```typescript
const NEXT_SEQ_FUNCTION = `next_seq() {
  (
    flock -x 200 2>/dev/null || true
    SEQ=$(cat "$SEQ_FILE" 2>/dev/null || echo 0)
    SEQ=$((SEQ + 1))
    echo $SEQ > "$SEQ_FILE"
    printf "%05d" $SEQ
  ) 200>"$SEQ_FILE.lock"
}`;
```

### MEDIUM

**`startMessagesWatcher()` reaches nesting depth 6 (callback > try > watch > lambda > setTimeout > catch)** - `tmux-connector.ts:326-366`
**Confidence**: 88%
- Problem: The deepest nesting path is: method body > try > `this.deps.watch()` callback > `setTimeout` callback > `this.handleMessageFile().catch()` handler. This reaches depth 6, well above the threshold of 4. Although the individual logic is clear, the structural nesting makes it harder to trace the control flow at a glance.
- Fix: Extract the `fs.watch` callback body into a named private method. This removes one nesting level and makes the watcher setup declarative.
```typescript
private startMessagesWatcher(session: ActiveSession): void {
  const { taskId } = session.handle;
  const { messagesDir, callbacks } = session;
  try {
    session.messagesWatcher = this.deps.watch(
      messagesDir,
      { persistent: false },
      (_eventType: string, filename: string | null) =>
        this.onMessageFileEvent(filename, session, callbacks),
    );
    session.messagesWatcher.on('error', (watchErr: Error) => {
      this.deps.logger.warn('Messages watcher error', { taskId, messagesDir, error: watchErr.message });
    });
  } catch {
    this.deps.logger.warn('Failed to start messages watcher', { taskId, messagesDir });
  }
}

private onMessageFileEvent(filename: string | null, session: ActiveSession, callbacks: SpawnCallbacks): void {
  if (!filename || filename.endsWith('.tmp') || !filename.endsWith('.json')) return;
  const { taskId } = session.handle;
  const existing = session.debounceTimers.get(filename);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    session.debounceTimers.delete(filename);
    this.handleMessageFile(path.join(session.messagesDir, filename), session, callbacks)
      .catch((err: unknown) => {
        this.deps.logger.warn('handleMessageFile threw', { taskId, filename, error: err instanceof Error ? err.message : String(err) });
      });
  }, DEBOUNCE_MS);
  session.debounceTimers.set(filename, timer);
}
```

**`runSharedStalenessCheck()` reaches nesting depth 5 with if/else inside for-loop** - `tmux-connector.ts:400-446`
**Confidence**: 80%
- Problem: The nesting path is: method body > for loop > `if (session.exited) continue` > `if (aliveSessions.has(...))` > `else` > `if (silentMs >= ...)`. Depth 5 is above the threshold of 4. The two-phase approach (collect then trigger) is correct architecture, but the inner loop body has branching that could be flattened.
- Fix: Extract the per-session check into a private helper that returns a classification.
```typescript
private classifySession(
  session: ActiveSession, aliveSessions: Set<string>, now: number
): 'alive' | 'stale' | 'skip' {
  if (session.exited) return 'skip';
  if (aliveSessions.has(session.handle.sessionName)) {
    session.lastAliveCheck = now;
    return 'alive';
  }
  const silentMs = now - session.lastAliveCheck;
  return silentMs >= session.stalenessConfig.maxSilenceMs ? 'stale' : 'skip';
}
```

**`ActiveSession` has 12 mutable fields -- wide state surface** - `tmux-connector.ts:88-111`
**Confidence**: 80%
- Problem: `ActiveSession` carries 12 fields, of which 7 are mutated during the session lifecycle (`sentinelWatcher`, `messagesWatcher`, `exited`, `lastDeliveredSeq`, `pendingMessages`, `nextExpectedSeq`, `flushing`). The `exited` flag alone is checked in 5 locations across 4 methods. While each field is justified individually, the aggregate state surface makes it harder to reason about invariants -- particularly the ordering between `exited`, `flushing`, and watcher cleanup.
- Fix: Consider grouping the message-ordering fields (`lastDeliveredSeq`, `pendingMessages`, `nextExpectedSeq`, `flushing`) into a separate `MessageBuffer` object with its own methods (`buffer()`, `deliverConsecutive()`, `forceFlush()`). This would reduce `ActiveSession` to 9 fields and encapsulate the sequence-ordering invariants.

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

_No issues found. All code in these files is new._

## Suggestions (Lower Confidence)

- **`TmuxConnector` file length (677 lines)** - `tmux-connector.ts` (Confidence: 70%) -- The file is above the 500-line warning threshold. The class has 18 methods. If the `MessageBuffer` extraction from the MEDIUM finding above is applied, the file would drop to approximately 580 lines. Consider also whether `startSentinelWatcher` + `startMessagesWatcher` + `closeSession` could live in a small `WatcherManager` utility in the future.

- **`flushPendingFiles()` nested try/catch in try/finally** - `tmux-connector.ts:460-507` (Confidence: 65%) -- The method has a try/finally guard (re-entrancy via `flushing`) wrapping an inner try/catch for directory reading, and then a per-file try/catch in the for-loop. Nesting depth reaches 4. The logic is correct but the triple-try pattern is dense. If the `MessageBuffer` extraction is applied, this concern is naturally resolved.

- **`buildWrapperScript` bash template testability** - `tmux-hooks.ts:68-121` (Confidence: 60%) -- Template-literal bash scripts resist static analysis. A structural change (e.g., a builder that assembles sections) would improve testability, but the current integration tests cover the script adequately. Low priority.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Complexity Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The codebase demonstrates disciplined decomposition overall -- `spawn()` was explicitly kept under 50 lines via `buildActiveSession()` extraction, helpers like `deliverSingle()` and `loggedCleanup()` reduce duplication, and the two-phase collect-then-trigger pattern in staleness avoids iterator-mutation bugs. The two HIGH findings (`createSession` at 58 lines, `buildWrapperScript` at 54 lines) are marginally over threshold and straightforward to fix. The two MEDIUM findings (nesting depth 5-6 in watcher/staleness callbacks) are the more impactful improvements -- extracting the callback bodies into named methods would meaningfully improve traceability. The `ActiveSession` state surface (12 fields, 7 mutable) is the deepest architectural concern but is acceptable for a v1 abstraction layer; the `MessageBuffer` extraction is a natural follow-up.

**Conditions for approval**: Fix the two HIGH findings (extract env-var injection from `createSession`, reduce `buildWrapperScript` below 50 lines). The MEDIUM findings are recommended but not blocking.
