# Security Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17
**Review pass**: 4th (post-fix focus on remaining behavioral security bugs)

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

**Communication block sends unescaped JSON payload as tmux keystrokes** - `src/implementations/tmux/tmux-hooks.ts:54`
**Confidence**: 85%

- Problem: The communication block reads an arbitrary JSON file from the messages directory (`cat "$RESULT_FILE"`) into `$PAYLOAD`, then passes it as `tmux send-keys -t "${t}" -l "$PAYLOAD" Enter`. The `-l` flag makes tmux treat the content literally (no key-binding interpretation), but the `$PAYLOAD` variable is in a **double-quoted** shell context. If the JSON file content contains characters like backticks, `$(...)`, or `$VAR`, the shell will attempt to interpret them _before_ tmux sees the string. A crafted agent output could trigger command substitution in the shell executing the wrapper script.

  Concretely: jq produces valid JSON where double-quoted content can contain literal `$` and backtick characters. While `jq -Rs .` wraps output in JSON double quotes (making `$PAYLOAD` a JSON string with escaped internals), the file is read by `cat` — the entire JSON blob including its outer quotes goes into `PAYLOAD`. Since the `PAYLOAD` variable is expanded inside `"$PAYLOAD"` (double quotes), the shell does not perform word splitting or globbing, but it _does_ perform variable expansion and command substitution on any unescaped `$` or backtick characters that appear literally in the file content. Given that jq escapes `$` as `$` (jq does _not_ backslash-escape dollar signs inside JSON strings), an output line like `run $(whoami)` becomes JSON `{"content":"run $(whoami)"}` on disk, and when the shell expands `"$PAYLOAD"` the `$(whoami)` is executed.

- Fix: Use single quotes around the payload variable to prevent shell interpretation, or better yet, use `cat` piped directly into `tmux load-buffer` / `tmux paste-buffer`. The simplest fix is to change the send-keys invocation to avoid shell expansion of the payload:
  ```bash
  # Instead of:
  tmux send-keys -t "${t}" -l "$PAYLOAD" Enter

  # Use a heredoc or base64 encoding to avoid shell interpretation:
  tmux load-buffer -b beat-payload - <<< "$PAYLOAD"
  tmux paste-buffer -b beat-payload -t "${t}"
  tmux delete-buffer -b beat-payload
  ```
  Note: `<<<` (here-string) also performs variable expansion, so this still has the same issue. The correct approach is to pipe the file content directly to tmux without shell variable expansion:
  ```bash
  cat "$RESULT_FILE" | tmux load-buffer -b beat-payload -
  tmux paste-buffer -b beat-payload -t "${t}"
  tmux delete-buffer -b beat-payload
  ```
  Or read the file with single-quoting by assigning via `read`:
  ```bash
  PAYLOAD=$(cat "$RESULT_FILE")
  printf '%s' "$PAYLOAD" | tmux load-buffer - && tmux paste-buffer -t "${t}"
  ```

  The risk is partially mitigated by the fact that `PAYLOAD` contains the full JSON object (not just the `content` field), so the structure `{"sequence":1,...,"content":"..."}` dilutes the injection. But a determined attacker controlling agent output could craft sequences that produce executable shell syntax in the full JSON context. **avoids PF-001** (addressing rather than deferring).

### MEDIUM

**`width` and `height` interpolated into shell command without type validation** - `src/implementations/tmux/tmux-session-manager.ts:88-93`
**Confidence**: 82%

- Problem: `config.width` and `config.height` are typed as `number | undefined` in TypeScript, but are interpolated directly into the shell command string: `` `-x ${width} -y ${height}` ``. TypeScript types are erased at runtime. If a caller passes a non-numeric value (e.g., through a JSON deserialization without Zod validation, or `NaN`, or `Infinity`), it would be embedded raw in the shell command. While the current `TmuxSessionConfig` interface declares these as `number`, there is no runtime validation at the boundary.

- Fix: Add explicit runtime validation. Since this is an infrastructure layer and per CLAUDE.md principles ("validate at boundaries"), the session manager should assert the values are finite positive integers before embedding:
  ```typescript
  const width = config.width ?? DEFAULT_WIDTH;
  const height = config.height ?? DEFAULT_HEIGHT;
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    return err(tmuxSessionFailed('create', `Invalid dimensions: ${width}x${height}`));
  }
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`cleanup()` does not validate `taskId` or `sessionsDir` before `path.join` + `rmSync`** - `src/implementations/tmux/tmux-hooks.ts:181-189`
**Confidence**: 82%

- Problem: `generateWrapper()` validates `taskId` against `TASK_ID_REGEX` and `sessionsDir` against `SAFE_PATH_REGEX` before creating directories, but `cleanup()` does not perform the same validation before calling `path.join(sessionsDir, taskId)` and `rmSync`. If `cleanup()` is ever called directly (not through the connector which uses the same taskId it already validated at spawn time), a crafted `taskId` containing path traversal (e.g., `../../etc`) combined with `recursive: true, force: true` could delete unintended directories.

  The current call sites all flow through `TmuxConnector.loggedCleanup()` which passes the same `taskId` used in `spawn()` (already validated). But `cleanup()` is part of the public `TmuxHooks` interface and can be called by future consumers without the connector's validation gating.

- Fix: Add the same `TASK_ID_REGEX` and `SAFE_PATH_REGEX` checks at the top of `cleanup()`:
  ```typescript
  cleanup(taskId: string, sessionsDir: string): Result<void, AutobeatError> {
    if (!TASK_ID_REGEX.test(taskId)) {
      return err(tmuxHookFailed('cleanup', `invalid taskId: ${taskId}`, { taskId }));
    }
    if (!SAFE_PATH_REGEX.test(sessionsDir)) {
      return err(tmuxHookFailed('cleanup', `unsafe sessionsDir: ${sessionsDir}`, { sessionsDir }));
    }
    // ... existing logic
  }
  ```

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Symlink following in `rmSync` and `mkdirSync`** - `src/implementations/tmux/tmux-hooks.ts:157-159,184` (Confidence: 65%) -- `mkdirSync` with `recursive: true` and `rmSync` with `recursive: true, force: true` will follow symlinks. If an attacker could plant a symlink at `{sessionsDir}/{taskId}` pointing elsewhere, `rmSync` would delete the target. Mitigated by 0o700 permissions on the parent directory and the fact that taskId is validated, but worth noting for defense-in-depth if the sessions directory is ever on a shared filesystem.

- **`flock` failure silenced** - `src/implementations/tmux/tmux-hooks.ts:84` (Confidence: 62%) -- The wrapper script uses `flock -x 200 2>/dev/null || true`, which silences flock failures and continues without the lock. On platforms where flock is unavailable (some minimal containers), concurrent output lines could produce duplicate or corrupted sequence numbers. The generated JSON files would still be atomically renamed (mv is atomic on the same filesystem), so data loss is unlikely, but sequence ordering guarantees degrade.

- **TOCTOU in concurrent session limit** - `src/implementations/tmux/tmux-session-manager.ts:77-86` (Confidence: 70%) -- The concurrent session limit check (`listSessions()` then `createSession`) has a TOCTOU window. Two concurrent `createSession` calls could both see 19 sessions, both proceed, and end up with 21 sessions. Mitigated by the fact that session creation is expected to be serialized by the caller (event-driven architecture), but the session manager itself does not enforce atomicity.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Security Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The codebase demonstrates strong security awareness overall: session name validation via regex, taskId validation, SAFE_PATH_REGEX for paths, single-quote escaping in sendKeys, communication target filtering, env var key validation, 0o700 file permissions, and documented trust boundaries. The primary concern is the communication block's double-quoted `$PAYLOAD` variable expansion which could allow command substitution via crafted agent output. The width/height validation gap and cleanup validation gap are lower-risk but straightforward to fix.
