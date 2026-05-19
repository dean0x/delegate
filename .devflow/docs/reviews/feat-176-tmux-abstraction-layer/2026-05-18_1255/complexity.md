# Complexity Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-18

## Issues in Your Changes (BLOCKING)

### HIGH

**`listSessions()` exceeds 50-line threshold with high cyclomatic complexity** - `tmux-session-manager.ts:228-279`
**Confidence**: 90%
- Problem: At 52 lines, `listSessions()` exceeds the 50-line warning threshold. It has high cyclomatic complexity (~10) from a parsing loop with 6 guard clauses (`continue` statements on lines 249, 252, 259, 262, 267, plus the empty-line check). The entire parsing section (lines 246-276) is a procedural blob mixing string splitting, null checks, regex validation, parseInt calls, and NaN guards.
- Impact: This is the most complex function in the tmux layer. The dense validation chain within a loop makes it easy to miss a parsing edge case during maintenance. Each `continue` is an invisible branch.
- Fix: Extract the line-parsing loop body into a `private parseSessionLine(line: string): TmuxSessionInfo | null` method. This reduces `listSessions()` to ~20 lines and isolates the parsing complexity:
  ```typescript
  private parseSessionLine(line: string): TmuxSessionInfo | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    const parts = trimmed.split(':');
    if (parts.length < 5) return null;
    const [name, createdStr, attachedStr, widthStr, heightStr] = parts;
    if (!name || !createdStr || !attachedStr || !widthStr || !heightStr) return null;
    if (!SESSION_NAME_REGEX.test(name)) return null;
    const created = parseInt(createdStr, 10);
    const width = parseInt(widthStr, 10);
    const height = parseInt(heightStr, 10);
    if (isNaN(created) || isNaN(width) || isNaN(height)) return null;
    return { name, created, attached: attachedStr === '1', width, height };
  }
  ```

**`createSession()` exceeds 50-line threshold with sequential validation chain** - `tmux-session-manager.ts:76-130`
**Confidence**: 85%
- Problem: At 55 lines, `createSession()` is the longest method in `DefaultTmuxSessionManager`. It performs 5 sequential validations (name, session limit, dimensions, cwd path, spawn), then exec, then env injection. The cyclomatic complexity is ~8 from the multiple early-return error paths.
- Impact: Adding a new validation (e.g., command validation, new env vars) pushes this function further into the danger zone. Each new validation adds both lines and branches.
- Fix: Extract dimension validation into a named helper:
  ```typescript
  private validateDimensions(
    width: number | undefined, height: number | undefined
  ): Result<{ width: number; height: number }, AutobeatError> {
    const w = width ?? DEFAULT_WIDTH;
    const h = height ?? DEFAULT_HEIGHT;
    if (!Number.isInteger(w) || w <= 0 || !Number.isInteger(h) || h <= 0) {
      return err(tmuxSessionFailed('create', `Invalid dimensions: ${w}x${h}`, { width: w, height: h }));
    }
    return ok({ width: w, height: h });
  }
  ```

### MEDIUM

**`runSharedStalenessCheck()` has 4-level nesting with if/else inside for-loop** - `tmux-connector.ts:470-516`
**Confidence**: 85%
- Problem: At 47 lines and nesting depth 4 (class > method > for > if/else > if), this method is at the warning threshold. The `for` loop at line 489 contains an `if/else` with a nested `if` inside the `else` branch (lines 492-505). While each branch is well-commented, the structural depth forces the reader to mentally track 4 levels of context.
- Impact: Approaching but not yet exceeding critical thresholds. The two-pass pattern (collect then act) is correct and avoids mutation-during-iteration bugs, which adds inherent structural complexity.
- Fix: Extract the inner `if/else` into a named helper to flatten the loop body:
  ```typescript
  private checkSessionStaleness(
    session: ActiveSession, aliveSessions: Set<string>, now: number
  ): boolean {
    if (session.exited) return false;
    if (aliveSessions.has(session.handle.sessionName)) {
      session.lastAliveCheck = now;
      return false;
    }
    const silentMs = now - session.lastAliveCheck;
    return silentMs >= session.stalenessConfig.maxSilenceMs;
  }
  ```

**`flushPendingFiles()` has 4-level nesting with nested try blocks** - `tmux-connector.ts:530-573`
**Confidence**: 82%
- Problem: At 44 lines with nesting depth 4 (class > method > try/finally > for), this method contains a try/finally wrapping the main logic, plus a nested try/catch for `readdirSync` (lines 541-546). The method mixes three concerns: debounce cleanup, disk reads, and pending delivery.
- Impact: The nested try blocks and mixed concerns make it harder to reason about error paths. If the `parseMessageFile` or `deliverPendingMessages` calls throw, the `finally` block still fires (correct) but the flow is non-obvious at a glance.
- Fix: The nested try/catch for readdirSync is already minimal (4 lines). A small improvement would be extracting the file-read loop (lines 550-563) into a `readUndeliveredFiles(session)` helper that returns the count of new pending messages, reducing `flushPendingFiles` to ~25 lines of orchestration.

**`startMessagesWatcher()` has 4-level nesting in callback chain** - `tmux-connector.ts:396-436`
**Confidence**: 80%
- Problem: At 41 lines with nesting depth 4 (class > method > try > callback > if/setTimeout), the fs.watch callback at line 403 contains guard checks, a debounce timer setup, and an async handler invocation. The callback itself has 20 lines of nested logic.
- Impact: The callback nesting is inherent to the fs.watch API. The debounce-and-delegate pattern is standard but the callback length makes the watcher setup harder to scan.
- Fix: Extract the watch callback body into a `private onMessageFileChange(session: ActiveSession, filename: string): void` method. This leaves `startMessagesWatcher` as a pure watcher setup (~15 lines) and the message handling logic as a testable method.

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

_No pre-existing issues found._

## Suggestions (Lower Confidence)

- **`tmux-connector.ts` file length (777 lines)** - `tmux-connector.ts:1-777` (Confidence: 70%) -- The file exceeds the 500-line warning threshold. The class has 17 methods (6 public, 11 private). The ActiveSession interface and helper functions at the top add ~120 lines before the class starts. However, the class is cohesive (all methods relate to session lifecycle management) and splitting would introduce coupling across files. Monitor as more methods are added during the v1.6.0 migration.

- **`buildWrapperScript()` embeds a 60-line bash script as a template literal** - `tmux-hooks.ts:108-168` (Confidence: 65%) -- The bash template string makes the TypeScript function appear short (29 lines of TS) but the embedded script is substantial. This is a standard pattern for code generation and the script is well-structured. Could become a maintenance concern if the script grows further.

- **`dispose()` has a try/catch inside a for-loop** - `tmux-connector.ts:273-303` (Confidence: 62%) -- The per-session try/catch in `dispose()` (line 280-301) adds nesting depth 4, but this is intentionally defensive to ensure all sessions are cleaned up even if one fails. The pattern is correct for a shutdown path.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 3 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Complexity Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The tmux abstraction layer demonstrates intentional complexity management -- the author has clearly already applied extraction to keep most functions near or under 50 lines (e.g., `spawn()` delegates to `createAndRegisterSession()`, `flushPendingFiles` delegates to `parseMessageFile` and `forceDeliverRemaining`). The two HIGH findings (`listSessions` at 52 lines, `createSession` at 55 lines) are marginal threshold violations that would benefit from extraction of parsing/validation helpers. The three MEDIUM findings are at nesting depth 4, which is the warning threshold but not critical. The codebase is well-commented with design decision documentation, named constants, and clean separation between the four modules. No unbounded loops or unclear control flow detected.

Conditions for approval:
1. Extract `parseSessionLine()` from `listSessions()` to bring it under 50 lines
2. Extract dimension validation from `createSession()` to bring it under 50 lines
