# Complexity Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17
**Diff range**: 1bec153be5..40f9537 (incremental, 6 commits)

## Issues in Your Changes (BLOCKING)

### HIGH

**`spawn()` exceeds 50-line function length threshold (71 lines)** - `tmux-connector.ts:132-202`
**Confidence**: 85%
- Problem: The `spawn()` method is 71 lines with 5 sequential steps (validate, generate wrapper, build session state, start watchers, create session). The session state object literal alone spans 17 lines. While each step is straightforward, the function is long enough that a reader must scroll to understand the full flow.
- Fix: Extract the ActiveSession construction into a factory method:
  ```typescript
  private buildActiveSession(
    config: TmuxSpawnConfig,
    manifest: WrapperManifest,
    callbacks: SpawnCallbacks,
  ): ActiveSession {
    return {
      handle: { sessionName: config.name, taskId: config.taskId, sessionsDir: config.sessionsDir },
      sentinelWatcher: null,
      messagesWatcher: null,
      stalenessConfig: { ...DEFAULT_STALENESS_CONFIG, ...config.staleness },
      lastAliveCheck: Date.now(),
      exited: false,
      lastDeliveredSeq: 0,
      pendingMessages: new Map(),
      nextExpectedSeq: 1,
      debounceTimers: new Map(),
      messagesDir: manifest.messagesDir,
      callbacks,
      flushing: false,
    };
  }
  ```
  This would bring `spawn()` to ~50 lines and give the construction a semantic name.

**`startWatchers()` exceeds 50-line function length threshold (62 lines)** - `tmux-connector.ts:265-326`
**Confidence**: 82%
- Problem: The function sets up two independent watchers (sentinel and messages) with error handling. Both blocks follow identical structure (try/watch/on-error/catch) but the messages watcher callback has additional filtering and debounce logic at nesting depth 4 (try -> watch callback -> setTimeout callback -> handleMessageFile).
- Fix: Extract per-watcher setup into a helper, or extract the messages callback filter chain:
  ```typescript
  private startSentinelWatcher(session: ActiveSession, sessionDir: string): void { ... }
  private startMessagesWatcher(session: ActiveSession): void { ... }
  ```
  Each would be ~25 lines, well under the threshold.

**`flushPendingFiles()` exceeds 50-line function length threshold (54 lines)** - `tmux-connector.ts:417-470`
**Confidence**: 80%
- Problem: 54 lines with 4 nesting levels (try/finally -> for -> try/catch -> if). The function handles four distinct responsibilities: clearing debounce timers, reading files from disk, buffering to pendingMessages, and force-delivering out-of-order remainders. The force-deliver block (lines 459-466) is a separate concern from the sequential delivery.
- Fix: The force-deliver block could be extracted to `forceDeliverRemaining()`:
  ```typescript
  private forceDeliverRemaining(session: ActiveSession, callbacks: SpawnCallbacks): void {
    if (session.pendingMessages.size === 0) return;
    const sorted = Array.from(session.pendingMessages.entries()).sort(([a], [b]) => a - b);
    for (const [, msg] of sorted) {
      session.pendingMessages.delete(msg.sequence);
      this.deliverSingle(msg, session, callbacks);
    }
  }
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`createSession()` exceeds 50-line function length threshold (58 lines)** - `tmux-session-manager.ts:72-129`
**Confidence**: 82%
- Problem: The function handles name validation, session limit enforcement, tmux spawning, auto-variable injection, and environment variable setup. The env var injection block (lines 105-126) is a distinct concern from session creation. The diff touched line 90 (escapeSingleQuoted for cwd) and lines 121 (escapeSingleQuoted for env values).
- Fix: Extract the env var injection block:
  ```typescript
  private injectEnvironment(sessionName: string, config: TmuxSessionConfig): void {
    const taskId = sessionName.replace(/^beat-/, '');
    const autoVars = { AUTOBEAT_TASK_ID: taskId, AUTOBEAT_SPAWN_TIME: new Date().toISOString() };
    const allEnv = { ...(config.env ?? {}), ...autoVars };
    const validEntries = Object.entries(allEnv).filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key));
    if (validEntries.length === 0) return;
    const commands = validEntries
      .map(([key, value]) => `tmux set-environment -t ${sessionName} ${key} '${escapeSingleQuoted(value)}'`)
      .join(' && ');
    this.deps.exec(commands);
  }
  ```

**`buildWrapperScript()` is a 54-line heredoc template** - `tmux-hooks.ts:75-128`
**Confidence**: 65% (see Suggestions)
- This is a bash template function. The 54 lines are primarily a string literal containing the shell script. Template functions are inherently long due to the embedded content, and breaking them up can harm readability. This is borderline.

**File length: `tmux-connector.ts` at 603 lines** - `tmux-connector.ts`
**Confidence**: 82%
- Problem: The file exceeds the 500-line warning threshold. TmuxConnector has 16 methods/properties (5 public, 11 private) handling session lifecycle, watchers, staleness, message ordering, flushing, and cleanup. This is a single class with multiple responsibilities.
- Fix: The staleness detection subsystem (`restartSharedStalenessTimer`, `runSharedStalenessCheck`, `stopSharedStalenessTimer`, `stopSharedStalenessTimerIfEmpty`) is a self-contained concern (~50 lines) that could be extracted into a `StalenessMonitor` collaborator. The message delivery subsystem (`handleMessageFile`, `deliverSingle`, `deliverPendingMessages`, `flushPendingFiles`) is another candidate (~100 lines). Either extraction would bring the file well under 500 lines.

## Pre-existing Issues (Not Blocking)

No CRITICAL pre-existing complexity issues found. The codebase is well-structured with clear separation between the four classes (TmuxValidator, TmuxSessionManager, TmuxHooks, TmuxConnector).

## Suggestions (Lower Confidence)

- **Template function length is inherent** - `tmux-hooks.ts:75-128` (Confidence: 65%) -- `buildWrapperScript()` at 54 lines is primarily a bash heredoc template. Breaking it up would scatter the script logic across multiple functions, making the generated bash harder to reason about. No action recommended unless the template grows further.

- **ActiveSession interface has 12 fields** - `tmux-connector.ts:85-108` (Confidence: 70%) -- The `ActiveSession` interface carries many fields because it tracks watcher state, message ordering state, staleness state, and session identity in one bag. If `spawn()` or `startWatchers()` are extracted, grouping related fields (e.g., message ordering into a sub-interface) would improve clarity.

- **Inline POSIX regex in `createSession`** - `tmux-session-manager.ts:116` (Confidence: 60%) -- The regex `/^[A-Za-z_][A-Za-z0-9_]*$/` for env var key validation appears inline without a named constant, unlike `SESSION_NAME_REGEX` and `TASK_ID_REGEX` which are named exports. Naming it `POSIX_ENV_VAR_REGEX` would improve readability.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 3 | 0 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Complexity Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The incremental changes in this diff (shared staleness timer, async readFile, watcher error handlers, input validation, deliverSingle extraction) are all complexity *improvements* over the previous state -- the shared timer replaced O(N) per-session timers, `deliverSingle` eliminated duplicated watermark logic, and the watcher error handlers are well-structured. The three HIGH findings are about function length thresholds in `spawn()` (71 lines), `startWatchers()` (62 lines), and `flushPendingFiles()` (54 lines), which were long before and grew slightly with the additions. The file-level 603 line count also merits attention. These are not blocking for merge but should be addressed to maintain long-term maintainability as the tmux layer matures.
