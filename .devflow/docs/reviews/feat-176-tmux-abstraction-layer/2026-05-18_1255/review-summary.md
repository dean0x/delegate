# Code Review Summary

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-18
**Reviewers**: 10 (security, architecture, performance, complexity, consistency, testing, regression, reliability, typescript, dependencies)

## Merge Recommendation: CHANGES_REQUESTED

This branch introduces a new tmux abstraction layer with strong architectural foundations but requires fixes before merge:

- **2 CRITICAL TypeScript errors** that block compilation
- **2 CRITICAL reliability issues** that can crash the connector under normal usage
- **Multiple HIGH issues** across security, architecture, performance, testing, complexity, and consistency domains

The codebase demonstrates excellent engineering discipline (Result types, DI, immutability, comprehensive tests), but several cross-cutting issues need resolution before production readiness.

---

## Issue Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking Issues | 4 | 9 | 15 | 0 |
| Should-Fix Issues | - | - | 6 | 0 |
| Pre-existing | - | - | - | - |
| **Total** | **4** | **9** | **21** | **0** |

---

## Aggregate Scores

| Reviewer | Score | Assessment |
|----------|-------|------------|
| TypeScript | 7/10 | 2 CRITICAL compilation errors |
| Reliability | 8/10 | 1 CRITICAL callback safety issue |
| Architecture | 7/10 | 2 HIGH DI + SRP concerns |
| Security | 8/10 | 1 HIGH env var validation |
| Performance | 8/10 | 2 HIGH redundant exec + sync I/O |
| Complexity | 7/10 | 2 HIGH functions exceed thresholds |
| Consistency | 7/10 | 2 HIGH naming deviations + duplication |
| Testing | 7/10 | 4 HIGH missing test coverage |
| Regression | 9/10 | 1 MEDIUM documentation gap |
| Dependencies | 10/10 | APPROVED (zero new deps) |
| **Weighted Average** | **7.4/10** | **Requires fixes** |

---

## CRITICAL ISSUES (Must Fix Before Merge)

### TypeScript Compilation Errors

**`Set.has()` type mismatch** - `tmux-connector.ts:74`
- **Severity**: CRITICAL (100% confidence)
- **Location**: `src/implementations/tmux/tmux-connector.ts:74`
- **Problem**: `VALID_OUTPUT_TYPES: Set<'stdout' | 'stderr' | 'result'>` with `v.type` narrowed to `string` causes `npm run typecheck` to fail with TS2345.
- **Fix**: Widen Set to `Set<string>` since runtime behavior is unchanged.

**`Logger.error()` signature mismatch** - `tmux-connector.ts:297-300`
- **Severity**: CRITICAL (100% confidence)
- **Location**: `src/implementations/tmux/tmux-connector.ts:297-300`
- **Problem**: Passing `{ taskId, error }` as second argument expects `Error` instance per Logger interface; actual signature is `(message, error?, context?)`.
- **Fix**: Pass error as second argument, context as third: `logger.error(msg, errInstance, { taskId })`

---

### Reliability Issues (Callback Safety)

**Unprotected callback invocations crash the connector** - `tmux-connector.ts:734, 254, 677`
- **Severity**: CRITICAL (85% confidence)
- **Reviewers**: reliability
- **Problem**: `SpawnCallbacks.onExit()` and `onOutput()` called without try/catch. If caller-supplied callback throws:
  - In `triggerExit()`: Escapes through staleness check loop, skipping remaining session cleanup
  - In `deliverSingle()`: Aborts message delivery; all subsequent messages for that session silently dropped
  - In `destroy()`: Exception propagates, callback fires even on destroySession failure
- **Impact**: A single misbehaving callback crashes the connector or leaves the system in an inconsistent state.
- **Fix**: Wrap all callback invocations in try/catch blocks, logging errors:
  ```typescript
  // In triggerExit:
  try {
    session.callbacks.onExit(code, signal);
  } catch (cbErr: unknown) {
    this.deps.logger.error('onExit callback threw', 
      cbErr instanceof Error ? cbErr : new Error(String(cbErr)), 
      { taskId });
  }
  // In deliverSingle:
  try {
    callbacks.onOutput(msg);
  } catch (cbErr: unknown) {
    this.deps.logger.warn('onOutput callback threw', 
      cbErr instanceof Error ? cbErr : new Error(String(cbErr)), 
      { sequence: msg.sequence });
  }
  ```

**`destroy()` unconditionally deletes session after failed destroySession** - `tmux-connector.ts:244-254`
- **Severity**: CRITICAL (82% confidence)
- **Reviewer**: reliability
- **Problem**: Comment says "Delete from activeSessions AFTER the destroySession attempt so that on failure the session remains tracked" but code always deletes. If tmux unavailable, tmux session lives but connector loses tracking — orphaned session with no retry path.
- **Impact**: Sessions cannot be retried or cleaned up if destroy fails transiently.
- **Fix**: Only delete and call onExit on success; on failure keep tracked with `session.exited = false`:
  ```typescript
  const destroyResult = this.deps.sessionManager.destroySession(handle.sessionName);
  if (destroyResult.ok) {
    this.activeSessions.delete(handle.taskId);
    this.restartSharedStalenessTimer();
    this.loggedCleanup('destroy', handle.taskId, handle.sessionsDir);
    session.callbacks.onExit(null, 'DESTROYED');
  } else {
    session.exited = false;
    this.deps.logger.warn('destroy: session kill failed, keeping tracked', 
      destroyResult.error, { taskId: handle.taskId });
  }
  return destroyResult;
  ```

---

## HIGH ISSUES (Should Fix Before Merge)

### Architecture & Dependency Injection

**Incomplete DI: Optional fs functions with concrete defaults** - `tmux-connector.ts:130-132` (2 reviewers: architecture, consistency)
- **Severity**: HIGH (85% confidence)
- **Reviewers**: architecture
- **Problem**: Constructor accepts optional `readFileSync`, `readFile`, `readdirSync` with `fs` fallbacks. `watch` is required. Inconsistent: `import * as fs` at module level creates hard dependency even when DI is the pattern. The `exec` functions in SessionManager and Validator are always required — these should be too.
- **Impact**: Tests can override, but production silently binds to `fs`. Violates stated DI principle.
- **Fix**: Make all three required in `TmuxConnectorDeps`. Remove `import * as fs` from module level (use `import type { FSWatcher }` for types only).

**TmuxConnector violates SRP with 5 responsibilities** - `tmux-connector.ts:777 lines, 15 methods` (2 reviewers: architecture, complexity)
- **Severity**: HIGH (82% confidence)
- **Reviewers**: architecture, complexity
- **Problem**: Handles session lifecycle, sentinel detection/parsing, message file reading+delivery with sequence ordering, staleness detection via shared timer, and flush-on-exit orchestration. Each is independently changeable. At 777 lines with 18-field ActiveSession, approaching god-class threshold.
- **Impact**: Adding new completion strategies or message delivery modes requires modifying this single class.
- **Fix**: Extract `MessageDeliveryPipeline` (handles pendingMessages, sequence ordering, flush, deliverSingle) and `StalenessDetector` (shared timer, staleness logic). This brings TmuxConnector to ~350 lines focused on lifecycle orchestration.

### Security

**Env var values validated only by escaping, not rejected** - `tmux-session-manager.ts:159-162`
- **Severity**: HIGH (90% confidence)
- **Reviewer**: security
- **Problem**: Env var keys validated with `POSIX_ENV_VAR_REGEX`, but values only escaped with `escapeSingleQuoted()`. While the escaping is correct (standard `'\\''` technique), defense-in-depth would add a length cap or character class validation like applied to `cwd`, `sessionsDir`, `agentCommand`, `taskId`.
- **Impact**: If escaping function regresses, attacker-controlled env values flow to shell. Current implementation is correct but lacks layered defenses.
- **Fix**: Add length cap and validation:
  ```typescript
  const MAX_ENV_VALUE_LENGTH = 4096;
  const validEntries = Object.entries(allEnv).filter(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return false;
    if (value.length > MAX_ENV_VALUE_LENGTH) return false;
    return true;
  });
  ```

### Performance

**Redundant `listSessions()` exec on every spawn** - `tmux-session-manager.ts:81` + `tmux-connector.ts:151` (2 reviewers: performance, complexity)
- **Severity**: HIGH (90% confidence)
- **Reviewers**: performance
- **Problem**: `TmuxConnector.spawn()` checks session cap in-memory (line 151), then `sessionManager.createSession()` immediately calls `listSessions()` (synchronous exec, ~5-20ms) for its own limit check. Defense-in-depth is good, but doubles exec cost on hot spawn path.
- **Impact**: ~10ms overhead per spawn (not critical since spawn is infrequent, max 20 sessions).
- **Fix**: Either accept as design tradeoff with a `DESIGN DECISION` comment, or eliminate redundant `listSessions()` by passing connector's count to session manager.

**Synchronous I/O blocks event loop in flush-on-exit** - `tmux-connector.ts:530-573`
- **Severity**: HIGH (85% confidence)
- **Reviewer**: performance
- **Problem**: `flushPendingFiles` calls `readdirSync` then loops over all JSON files with `readFileSync`. Blocks event loop during shutdown for every session. With hundreds of messages, blocking duration could be significant.
- **Impact**: Acceptable design choice (sync on exit to guarantee delivery before teardown), but lack of observability makes it unmonitorable in production.
- **Fix**: Add structured logging with file count and elapsed time:
  ```typescript
  const start = Date.now();
  // ... flush logic ...
  if (jsonFiles.length > 0) {
    this.deps.logger.info('Flush completed', {
      taskId: session.handle.taskId,
      filesRead: jsonFiles.length,
      elapsedMs: Date.now() - start,
    });
  }
  ```

### Complexity

**`listSessions()` exceeds 50-line threshold with high cyclomatic complexity** - `tmux-session-manager.ts:228-279` (2 reviewers: complexity, testing)
- **Severity**: HIGH (90% confidence)
- **Reviewer**: complexity
- **Problem**: 52 lines (exceeds 50-line warning). Cyclomatic complexity ~10 from parsing loop with 6 guard clauses (`continue` statements). Parsing section is procedural blob mixing string splitting, null checks, regex validation, parseInt, NaN guards.
- **Impact**: Dense validation chain makes edge cases easy to miss during maintenance. Each `continue` is an invisible branch.
- **Fix**: Extract `private parseSessionLine(line: string): TmuxSessionInfo | null` method. Reduces `listSessions()` to ~20 lines and isolates parsing complexity.

**`createSession()` exceeds 50-line threshold** - `tmux-session-manager.ts:76-130`
- **Severity**: HIGH (85% confidence)
- **Reviewer**: complexity
- **Problem**: 55 lines (exceeds 50-line threshold). Five sequential validations (name, limit, dimensions, cwd, spawn) + exec + env injection. Cyclomatic complexity ~8 from multiple early-return paths.
- **Impact**: Adding new validation pushes function further into danger zone. Each validation adds lines and branches.
- **Fix**: Extract dimension validation into named helper to bring under 50 lines.

### Consistency

**Inconsistent class naming: `Default*` vs codebase descriptive prefix convention** - `tmux-session-manager.ts:64`, `tmux-hooks.ts:170`, `tmux-validator.ts:43`
- **Severity**: HIGH (85% confidence)
- **Reviewers**: consistency
- **Problem**: Classes use `DefaultTmuxSessionManager`, `DefaultTmuxHooks`, `DefaultTmuxValidator` while entire codebase uses descriptive prefixes: `SQLite*`, `InMemory*`, `Structured*`, `Console*`, `EventDriven*`. `TmuxConnector` itself doesn't use prefix. Creates inconsistency even within new module.
- **Impact**: Deviates from established convention, confusing to maintainers.
- **Fix**: Either drop `Default` prefix entirely (rename interfaces to `*Port` like `TmuxConnectorPort`) or use descriptive prefix. Simplest: document the deviation and use `Default` consistently across all classes and interfaces, or remove `Default` and rename interfaces to `*Port`.

**Duplicate shell-escaping functions with inconsistent naming** - `tmux-hooks.ts:40` + `tmux-session-manager.ts:49`
- **Severity**: HIGH (92% confidence)
- **Reviewers**: consistency, architecture, security
- **Problem**: Two functions implement single-quote escaping with different names and behaviors:
  - `shellSingleQuote(s)` in hooks: escapes AND wraps, returns `'escaped'`
  - `escapeSingleQuoted(value)` in session-manager: escapes only, caller adds quotes
  - Naming inconsistency obscures behavioral difference.
- **Impact**: DRY violation. If escaping logic needs to change, two places to update.
- **Fix**: Extract shared utility in `tmux-shell-utils.ts` with clearly differentiated names:
  ```typescript
  export function escapeForSingleQuotes(s: string): string {
    return s.replace(/'/g, "'\\''");
  }
  export function singleQuoteToken(s: string): string {
    return `'${escapeForSingleQuotes(s)}'`;
  }
  ```

### Testing

**Missing test: `isAlive()` delegation** - `tmux-connector.test.ts:1683`
- **Severity**: HIGH (90% confidence)
- **Reviewer**: testing
- **Problem**: `sendKeys()` is tested (line 1683+) but `isAlive()` is not, despite being a simple delegation like sendKeys. Missing for parity and future regression protection.
- **Fix**: Add matching test delegating to `sessionManager.isAlive()`.

**Missing test: `dispose()` error resilience** - `tmux-connector.ts:296`
- **Severity**: HIGH (88% confidence)
- **Reviewer**: testing
- **Problem**: Design decision: "one failing teardown does not prevent remaining sessions from being cleaned up." No test verifies this behavior when first session's teardown throws.
- **Fix**: Add test where first session's teardown throws, verify second session is still cleaned up and error is logged.

**Missing test: `TmuxValidator` failure-not-cached behavior** - `tmux-validator.ts:54-62`
- **Severity**: HIGH (85% confidence)
- **Reviewer**: testing
- **Problem**: Design decision: "Only success results cached—failures returned immediately." Test covers caching successes but not that failures are NOT cached. Critical for robustness.
- **Fix**: Add test: first `validate()` fails, second succeeds, verifying retry works after transient error.

**Missing test: `cleanup()` input validation** - `tmux-hooks.ts:246-256`
- **Severity**: HIGH (85% confidence)
- **Reviewer**: testing
- **Problem**: `cleanup()` validates `taskId` and `sessionsDir` before `rmSync`. Security-critical guards are untested. `generateWrapper()` tests cover same patterns, but `cleanup()` is public interface deserving its own tests.
- **Fix**: Add two tests: invalid taskId and unsafe sessionsDir, both should return TMUX_HOOK_FAILED.

**Missing integration test: non-zero exit sentinel** - `tmux-hooks.test.ts` + hook-script-generation integration
- **Severity**: HIGH (85% confidence)
- **Reviewer**: testing
- **Problem**: Suite has "wrapper creates .done sentinel when agent exits 0" but no test for `.exit` sentinel on non-zero exit. Failure path is arguably more important.
- **Fix**: Add integration test executing agent that exits non-zero, verify `.exit` sentinel created (not `.done`).

---

## MEDIUM ISSUES (Should Address, May Block Depending on Review)

### Architecture & Design

**Port interface lives in implementation package, not core** - `src/implementations/tmux/types.ts:245-252`
- **Severity**: MEDIUM (85% confidence)
- **Reviewer**: architecture
- **Problem**: `TmuxConnectorPort` defined in `src/implementations/tmux/types.ts`. Clean Architecture says ports belong to core so dependency arrow points inward. When Phase 2/3 consumers need this port, they'll import from implementation package, inverting direction.
- **Fix**: Move `TmuxConnectorPort`, `SpawnCallbacks`, `TmuxHandle`, `TmuxSpawnConfig`, `OutputMessage` to `src/core/interfaces.ts` or new `src/core/tmux-port.ts`. Keep internal types in `implementations/tmux/types.ts`.

### Security

**Session name interpolated unquoted, relies only on regex** - `tmux-session-manager.ts:110,161,177,205,221,296`
- **Severity**: MEDIUM (82% confidence)
- **Reviewer**: security
- **Problem**: Session name embedded unquoted in commands: `tmux new-session -d -s ${config.name}`. Safe only because `SESSION_NAME_REGEX = /^beat-[a-z0-9-]+$/` validates. If regex relaxed, becomes injection vector. Quoting provides defense-in-depth at zero cost.
- **Fix**: Quote at all interpolation sites: `tmux new-session -d -s '${config.name}'`

**Wrapper `SESSIONS_DIR` uses JS template literals instead of `shellSingleQuote()`** - `tmux-hooks.ts:120`
- **Severity**: MEDIUM (80% confidence)
- **Reviewer**: security
- **Problem**: `SESSIONS_DIR='${sessionDir}'` relies on `SAFE_PATH_REGEX` validation. But `path.join(config.sessionsDir, config.taskId)` result is not re-validated. Using `shellSingleQuote()` function exists for this purpose would be more robust.
- **Fix**: Use `shellSingleQuote(sessionDir)` instead of inline template literal.

### Performance & Monitoring

**`pendingMessages` Map grows to MAX_PENDING_MESSAGES before draining aggressively** - `tmux-connector.ts:649-666`
- **Severity**: MEDIUM (82% confidence)
- **Reviewer**: performance
- **Problem**: Out-of-order messages accumulate in map. Gap-skip logic sorts and resets, but may not fully drain gaps. Map only drained on exit. Pathological pattern could oscillate near cap.
- **Fix**: After gap-skip, drain more aggressively or force-deliver if count still above lower watermark (e.g., 50).

**`restartSharedStalenessTimer()` called on every spawn creates O(N) churn** - `tmux-connector.ts:222,249,514,719`
- **Severity**: MEDIUM (82% confidence)
- **Reviewer**: performance
- **Problem**: Each spawn calls restart, creating/tearing down interval N times. Each restart iterates all sessions. With rapid spawning (pipeline with 10 tasks), inefficient.
- **Fix**: Debounce restart with `queueMicrotask()` so multiple spawns in same tick coalesce into single restart.

### Complexity

**`runSharedStalenessCheck()` has 4-level nesting** - `tmux-connector.ts:470-516`
- **Severity**: MEDIUM (85% confidence)
- **Reviewer**: complexity
- **Problem**: 47 lines, nesting depth 4 (class > method > for > if/else > if). Structural depth forces reader to track 4 levels of context.
- **Fix**: Extract inner if/else into `private checkSessionStaleness()` method to flatten loop body.

**`flushPendingFiles()` has 4-level nesting with nested try blocks** - `tmux-connector.ts:530-573`
- **Severity**: MEDIUM (82% confidence)
- **Reviewer**: complexity
- **Problem**: 44 lines with nesting depth 4 (class > method > try/finally > for). Nested try/catch for `readdirSync`, mixed concerns.
- **Fix**: Extract file-read loop into `readUndeliveredFiles()` helper, reducing flush to ~25 lines of orchestration.

**`startMessagesWatcher()` has 4-level nesting in callback** - `tmux-connector.ts:396-436`
- **Severity**: MEDIUM (80% confidence)
- **Reviewer**: complexity
- **Problem**: 41 lines, nesting depth 4 (class > method > try > callback > if/setTimeout). Callback callback has 20 lines of nested logic.
- **Fix**: Extract watch callback body into `private onMessageFileChange(session, filename)` method. Leave setup as pure watcher (~15 lines).

### Consistency

**Inline POSIX env var regex duplicated** - `tmux-session-manager.ts:155, 290`
- **Severity**: MEDIUM (88% confidence)
- **Reviewer**: consistency
- **Problem**: `/^[A-Za-z_][A-Za-z0-9_]*$/` appears twice in same file. Codebase pattern (constants.ts) would extract this as `POSIX_ENV_VAR_REGEX`.
- **Fix**: Extract to named constant in `types.ts` or file top.

**Integration test helper duplication with behavioral divergence** - `session-lifecycle.test.ts:13-37` vs `sentinel-detection.test.ts:15-31`
- **Severity**: MEDIUM (85% confidence)
- **Reviewer**: consistency
- **Problem**: `realExec()` and `isTmuxAvailable()` copy-pasted across tests. Implementations diverge: session-lifecycle includes probe session check for CI robustness, sentinel-detection doesn't. One test more resilient than the other.
- **Fix**: Extract shared `tests/integration/tmux/test-helpers.ts` with robust version (including probe).

**Inconsistent `Tmux` prefix on type names** - `src/implementations/tmux/types.ts`
- **Severity**: MEDIUM (80% confidence)
- **Reviewer**: consistency
- **Problem**: Some types prefixed (`TmuxSessionConfig`, `TmuxHandle`), others not (`OutputMessage`, `CommunicationMode`). Non-prefixed names are generic, potential for collision in larger codebase.
- **Impact**: Makes API surface harder to reason about. No collisions today but inconsistency is confusing.
- **Fix**: Either prefix all (`TmuxOutputMessage`, `TmuxExecFn`) or document convention. Since types live in dedicated `tmux/` package with barrel re-export, current approach workable but worth decision doc.

**`SpawnCallbacks` re-exported through two sources** - `tmux-connector.ts:38` + `index.ts:9`
- **Severity**: MEDIUM (82% confidence)
- **Reviewer**: consistency, typescript
- **Problem**: types.js -> tmux-connector.js -> index.ts re-export chain. `SpawnCallbacks` is pure type from `types.ts` — barrel could export directly from `types.js` like all other types, eliminating the re-export in connector.
- **Fix**: Remove line 38 from tmux-connector.ts, add `SpawnCallbacks` to type-only block in index.ts (lines 18-37).

### TypeScript Strictness

**`taskId` uses plain string instead of branded TaskId type** - `types.ts:41,58,98`
- **Severity**: MEDIUM (85% confidence) HIGH category but listed in "Should Fix"
- **Reviewer**: typescript
- **Problem**: Codebase uses branded types (`TaskId`, `WorkerId`) in domain layer to prevent ID confusion. Tmux layer uses plain `string` for taskId. Defeats branding purpose.
- **Impact**: `WorkerId` or arbitrary string could pass as `taskId` without type error.
- **Fix**: Import and use branded `TaskId` from `src/core/domain.js`:
  ```typescript
  import type { TaskId } from '../../core/domain.js';
  export interface TmuxSpawnConfig extends TmuxSessionConfig {
    taskId: TaskId;
  }
  ```
  Note: Requires connector's `activeSessions: Map<TaskId, ActiveSession>` and callers to provide branded TaskId. If tmux layer intentionally below domain, add JSDoc `@design` comment.

**Missing `readonly` on public interface fields** - `types.ts:21-34,39-48,54-61,75-84`
- **Severity**: MEDIUM (80% confidence)
- **Reviewer**: typescript
- **Problem**: Codebase uses `readonly` extensively on domain types (340+ occurrences). Tmux config/handle/message interfaces have no `readonly` modifiers. Violates immutability-by-default principle.
- **Fix**: Add `readonly` to `TmuxHandle`, `TmuxSessionConfig`, `TmuxSpawnConfig`, `WrapperConfig`, `WrapperManifest`, `OutputMessage`, `TmuxSessionInfo`, `TmuxInfo`, `StalenessConfig`.
  Note: `ActiveSession` (internal, mutates fields) should NOT be readonly.

**Non-null assertions without safety checks** - `tmux-connector.ts:663, 691`
- **Severity**: MEDIUM (80%+ confidence)
- **Reviewer**: typescript
- **Problem**: 
  - Line 663: `sortedSeqs[0]!` uses non-null assertion. Guard ensures non-empty, but `noUncheckedIndexedAccess` would flag.
  - Line 691: `pendingMessages.get(nextExpectedSeq)!` uses non-null assertion. Prior `has()` check makes safe at runtime, but TypeScript cannot narrow `Map.get()` based on prior `has()`.
- **Fix**: Replace assertions with safe fallbacks checking for undefined.

**Logger.error() signature mismatch** - `tmux-connector.ts:297-300` (CRITICAL category, listed in both sections)
- **Severity**: MEDIUM (HIGH details) / CRITICAL (blocks compilation)
- Already listed above in CRITICAL section.

### Reliability

**No precondition assertion on StalenessConfig values** - `tmux-connector.ts:321-324`
- **Severity**: MEDIUM (83% confidence)
- **Reviewer**: reliability
- **Problem**: `buildActiveSession` merges user-provided `config.staleness` into defaults without validating `maxSilenceMs > 0` or `maxSilenceMs > checkIntervalMs`. Caller could pass `{ maxSilenceMs: 0 }`, causing every session immediately declared stale (line 498: `silentMs >= 0` always true).
- **Impact**: Sessions permanently stale even if alive.
- **Fix**: Validate both fields in `buildActiveSession`:
  ```typescript
  if (stalenessConfig.maxSilenceMs <= 0) {
    return err(tmuxSessionFailed('spawn', 'maxSilenceMs must be positive'));
  }
  if (stalenessConfig.maxSilenceMs <= stalenessConfig.checkIntervalMs) {
    return err(tmuxSessionFailed('spawn', 'maxSilenceMs must exceed checkIntervalMs'));
  }
  ```

**Wrapper sentinel guard has degraded fallback without clear logging** - `tmux-hooks.ts:130-136` + `tmux-connector.ts:359-388`
- **Severity**: MEDIUM (80% confidence)
- **Reviewer**: reliability
- **Problem**: If sentinel watcher fails to initialize (line 385 catch logs warning), connector degrades to staleness-only detection. With default `maxSilenceMs: 60_000`, session crash can silently appear alive for 60 seconds. Documented as design choice, but silent degradation without clear indication.
- **Fix**: Log at INFO level (not just warn) when falling back, and consider reduced initial staleness check (5 seconds after spawn, then switch to configured interval).

### Testing

**Real `sleep()` in timing-sensitive assertions risks CI flakiness** - `tmux-connector.test.ts:875-880`
- **Severity**: MEDIUM (82% confidence)
- **Reviewer**: testing
- **Problem**: "out-of-order delivery" test uses real `sleep(80)` between fires. On slow CI, 80ms may not be enough for debounce (50ms) + async readFile. Debounce double-fire test uses fake timers; these don't.
- **Impact**: Flaky test on slower CI runners.
- **Fix**: Refactor to use `vi.useFakeTimers()` + `vi.advanceTimersByTime()` + `await Promise.resolve()` flushes, or use `vi.waitFor()` with timeout.

**Non-JSON files not filtered in message watcher** - `tmux-connector.test.ts`
- **Severity**: MEDIUM (80% confidence)
- **Reviewer**: testing
- **Problem**: Test at line 765 filters `.tmp` files, but no test for non-JSON (`.log`, `.txt`, no extension). Source code has guard (`if (!filename.endsWith('.json')) return;`) that's untested.
- **Fix**: Add test verifying non-JSON files ignored.

**Missing integration test scenarios** - various
- **Severity**: MEDIUM (65-72% confidence)
- **Reviewer**: testing
- **Problem**: Edge case coverage gaps: getSessionEnvironment no-equals-sign, listSessions NaN parsing, sentinel_guard EXIT trap.
- **Fix**: Add missing integration tests for failure paths.

### Regression

**`npm test` warning message doesn't list new safe commands** - `package.json:19`
- **Severity**: MEDIUM (82% confidence)
- **Reviewer**: regression
- **Problem**: Warning message lists safe test groups but `test:tmux` and `test:tmux:integration` not included. Claude Code users may not discover these new safe groups.
- **Impact**: Developer experience issue.
- **Fix**: Add `npm run test:tmux` and `npm run test:tmux:integration` to safe commands list in warning message (or defer to CLAUDE.md update).

---

## Should-Fix Issues (Code You Touched)

### Code Quality

**`WatchFn` type defined as `typeof fs.watch` instead of structurally** - `tmux-connector.ts:41`
- **Severity**: MEDIUM (80% confidence)
- **Reviewer**: architecture
- **Problem**: Type couples to Node's `fs` module. `ExecFn` in types.ts is defined structurally `(cmd: string) => ExecResult`, not `typeof exec`. Inconsistent.
- **Fix**: Define `WatchFn` structurally in types.ts like `ExecFn`.

**`TmuxConnector` stores deps bag AND extracts functions** - `tmux-connector.ts:129-133`
- **Severity**: LOW (65% confidence, "should-fix" category)
- **Reviewer**: consistency
- **Problem**: Stores `deps` as field but also extracts `readFileSyncFn`, `readFileFn`, `readdirSyncFn`. Other implementations fully destructure. Mixing patterns is unusual.
- **Fix**: Either fully destructure or fully store as `deps`. Pick one pattern.

---

## What's Done Well

### Across All Reviewers

1. **Strong security awareness**: Reject-bad-input strategy at every trust boundary (TASK_ID_REGEX, SESSION_NAME_REGEX, SAFE_PATH_REGEX, POSIX env key validation). Shell escaping is correct (standard `'\\''` technique). Communication security via paste-buffer instead of send-keys prevents variable expansion.

2. **Excellent architectural foundations**: Clean interface segregation (4 separate interfaces: Connector, SessionManager, Hooks, Validator). Consistent Result types throughout. Proper DI via Deps interfaces. Error factory pattern follows established convention. Barrel export cleanly separates type-only and runtime re-exports.

3. **Thoughtful performance design**: Shared staleness timer (single `listSessions()` per tick instead of O(N) `isAlive()` calls). MAX_PENDING_MESSAGES cap prevents unbounded memory growth. Debounce on fs.watch events. Batch environment injection. `skipTimerRestart` optimization for batch stale detection.

4. **Strong test infrastructure**: 168 tests passing. Tests validate behavior not implementation. Clean AAA patterns. All external deps injected (fs, exec, timers). Excellent edge case coverage (null filenames, double-fire debounce, re-entrancy, out-of-order delivery). Security validation thorough for generateWrapper(). Integration tests properly gated with `skipIf(!tmuxAvailable)`. Flush-before-exit well-tested.

5. **Code organization**: Clear module separation (validation, session management, hooks, orchestration). Well-commented with design decision documentation. Named constants throughout. Proper error handling patterns with Result types.

6. **Zero new dependencies**: Uses only Node.js builtins (fs, path, child_process, os) and internal modules. No production or dev dependency additions. Avoids third-party tmux libraries, minimizing attack surface.

---

## Cross-Cutting Themes

Several issues appear across multiple reviewers, indicating systemic patterns:

1. **Shell escaping inconsistency** (Security, Architecture, Consistency): Duplicate functions (`shellSingleQuote` vs `escapeSingleQuoted`) with different names, and inconsistent application (SESSIONS_DIR uses JS template literal instead of dedicated function). Should be unified in shared utility.

2. **Callback safety** (Reliability, Testing): Unprotected `onExit`/`onOutput` callback invocations and missing test coverage for error paths. Critical issue flagged by both reliability reviewer and testing reviewer's findings on dispose error resilience.

3. **DI incompleteness** (Architecture, Consistency): Optional fs functions with concrete defaults violate DI principle. Inconsistent with how `exec` is always required in other classes.

4. **Complexity nesting** (Complexity, Testing): Multiple methods approaching 4-level nesting threshold. Timing-sensitive tests use real `sleep()` instead of fake timers. Both contribute to maintainability and stability concerns.

5. **Type safety** (TypeScript, Architecture, Consistency): Missing `readonly` modifiers (immutability), unbranded `taskId` strings (loses domain safety), and re-export chain inconsistencies.

---

## Merge Readiness Assessment

**Cannot merge as-is.** This branch requires fixes in the following order of priority:

### Phase 1: CRITICAL (Must Fix - Blocking Compilation & Crashes)
- [ ] Fix TypeScript compilation errors (Set.has, Logger.error)
- [ ] Protect callback invocations (onExit, onOutput) with try/catch
- [ ] Fix destroy() unconditional deletion logic

### Phase 2: HIGH (Must Fix - Core Issues)
- [ ] Make fs functions required in TmuxConnectorDeps (complete DI)
- [ ] Extract MessageDeliveryPipeline and StalenessDetector from TmuxConnector (SRP)
- [ ] Move TmuxConnectorPort to src/core/interfaces.ts (clean architecture)
- [ ] Extract parseSessionLine() from listSessions() (complexity threshold)
- [ ] Extract dimension validation from createSession() (complexity threshold)
- [ ] Extract duplicate shell-escaping to shared utility (consistency, DRY)
- [ ] Fix session naming prefix (consistency)
- [ ] Add missing test coverage (isAlive, dispose error resilience, validator failure-not-cached, cleanup validation)

### Phase 3: MEDIUM (Should Fix Before Merge)
- [ ] Add env var value validation with length cap (security depth)
- [ ] Document or eliminate redundant listSessions() check (performance)
- [ ] Add observability to flushPendingFiles (performance)
- [ ] Add readonly modifiers to public interfaces (typescript immutability)
- [ ] Use branded TaskId type (typescript domain safety)
- [ ] Update npm test warning message (regression)
- [ ] All other MEDIUM issues

**Estimated effort**: 3-4 hours for Phase 1, 4-5 hours for Phase 2, 2-3 hours for Phase 3. Total ~10-12 hours for production-ready state.

---

## Recommended Resolution Order

1. **Day 1 (Critical)**: Fix TypeScript errors, callback safety, destroy() logic. Re-run `npm run typecheck` to confirm.
2. **Day 1 (High Priority)**: DI completeness, extract shell utilities, naming consistency.
3. **Day 2 (Architecture)**: Extract classes from TmuxConnector, move port interface, complexity extractions.
4. **Day 2 (Testing)**: Add missing tests (now easier with cleaner classes).
5. **Day 3 (Polish)**: Type safety improvements, observability, remaining MEDIUM issues.
6. **Final**: Run full test suite (`npm run test:all`) and Snyk scan before final approval.

---

**Synthesized by**: Synthesizer Agent (review mode)
**Quality**: This is a complex, well-engineered feature with identifiable, fixable issues. No architectural dead-ends; all findings are actionable.
