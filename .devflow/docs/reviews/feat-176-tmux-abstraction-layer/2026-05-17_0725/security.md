# Security Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17
**Pass**: Bug hunting (3rd review) — sibling analysis of prior shell injection, over-escaping, PIPESTATUS fixes

## Issues in Your Changes (BLOCKING)

### HIGH

**Env var value escaping inconsistency: unnecessary backslash doubling corrupts values** - `tmux-session-manager.ts:122`
**Confidence**: 92%

- Problem: The new batched env var injection escapes backslashes (`\\` -> `\\\\`) before wrapping in single quotes. Inside single quotes, backslashes are LITERAL per POSIX shell rules — they need no escaping. This means any env var value containing `\` will be stored with doubled backslashes in the tmux environment.

  Example: Value `C:\Users\foo` becomes `'C:\\Users\\foo'` in the shell command. Since single quotes make everything literal, tmux receives and stores `C:\\Users\\foo` (with doubled backslashes) instead of the intended `C:\Users\foo`.

  This is the **same class of bug** as the over-escaping fix in commit `ee4662f` (which removed spurious `$` and backtick escaping from `escapeSendKeys` for the exact same reason — single-quoted contexts need only single-quote escaping).

- Fix: Remove the backslash replacement. Only single-quote escaping is needed:
  ```typescript
  const commands = validEntries
    .map(([key, value]) => {
      const escaped = escapeSingleQuoted(value);
      return `tmux set-environment -t ${config.name} ${key} '${escaped}'`;
    })
    .join(' && ');
  ```
  Alternatively, reuse the existing `escapeSingleQuoted()` function (already defined in this file) instead of inline escaping.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Wrapper script embeds `sessionDir` in bash double-quotes — shell metacharacters in path would execute** - `tmux-hooks.ts:76`
**Confidence**: 82%

- Problem: The wrapper script template uses bash double-quotes for the `SESSIONS_DIR` assignment:
  ```bash
  SESSIONS_DIR="${sessionDir}"
  ```
  This is a JavaScript template literal where `${sessionDir}` is replaced at generation time. The resulting bash script uses double-quotes, where `$`, backticks, and `\` have special meaning. If `sessionDir` (constructed from `config.sessionsDir + config.taskId`) ever contained shell metacharacters like `$(cmd)` or `` `cmd` ``, they would execute when the wrapper script runs.

  Currently both `sessionsDir` (system config path) and `taskId` (UUID-based) are trusted, but this is defense-in-depth violation — the tmux layer has no boundary validation for these inputs.

- Fix: Use single quotes instead of double quotes for the path assignment. Since `$SESSIONS_DIR` is referenced later via bash variable expansion (which requires double quotes at point of USE), only the assignment needs changing:
  ```bash
  SESSIONS_DIR='${sessionDir.replace(/'/g, "'\\''")}'
  ```
  Or better, validate `sessionDir` against a safe-path regex (no `$`, backticks, or non-printable characters) before embedding.

### MEDIUM

**No `taskId` validation at tmux layer boundary — path traversal and script injection possible** - `tmux-hooks.ts:67` and `tmux-connector.ts:127`
**Confidence**: 80%

- Problem: `taskId` is used in `path.join(config.sessionsDir, config.taskId)` for directory creation and in the wrapper script without any validation. While upstream generates `task-<UUID>` format IDs, the tmux layer accepts any string. A `taskId` containing `../` could traverse directories; one containing shell metacharacters would inject into the wrapper script (via the `SESSIONS_DIR` double-quote context above).

  The `config.name` (session name) is validated against `SESSION_NAME_REGEX` (`/^beat-[a-z0-9-]+$/`), but `taskId` bypasses this check entirely.

- Fix: Add taskId validation in `generateWrapper()` or at the connector's `spawn()` entry point:
  ```typescript
  // Safe taskId: alphanumeric, hyphens, underscores only (matches UUID-based format)
  const TASK_ID_REGEX = /^[a-z0-9][a-z0-9_-]*$/;
  if (!TASK_ID_REGEX.test(config.taskId)) {
    return err(tmuxHookFailed('generateWrapper', `Invalid taskId: ${config.taskId}`));
  }
  ```

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`agentCommand` and `agentArgs` embedded in wrapper script without escaping** - `tmux-hooks.ts:96`
**Confidence**: 85%

- Problem: The wrapper script embeds `config.agentCommand` and `config.agentArgs.join(' ')` directly into bash without quoting or escaping:
  ```bash
  ${config.agentCommand} ${agentArgs} 2>&1 | while ...
  ```
  The comment on line 11-13 acknowledges this is intentional ("callers are responsible for ensuring these values come from trusted configuration"). However, there is no assertion, validation, or type-level enforcement (e.g., a branded type) that would prevent an untrusted value from reaching this code path.

  This is documented as an accepted risk. Noting it as pre-existing since it was present before this diff and the code explicitly documents the trust assumption.

## Suggestions (Lower Confidence)

- **`config.cwd` path traversal** - `tmux-session-manager.ts:90` (Confidence: 65%) — `config.cwd` is single-quote escaped for shell safety, but no path validation prevents specifying arbitrary directories. Low risk since the tmux session can only access what the OS user can access, but a symlink-following attack could be relevant in multi-tenant setups.

- **`width`/`height` type coercion** - `tmux-session-manager.ts:88-89` (Confidence: 62%) — These are typed as `number | undefined` but interpolated directly into the shell command. If TypeScript's type system is bypassed (e.g., raw JSON from MCP tools), a string value like `"100; rm -rf /"` would inject into the command. The `SESSION_NAME_REGEX` validation on `config.name` prevents this scenario from being reachable via normal code paths.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 0 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Security Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The HIGH-severity env var escaping bug is the same bug class as commit `ee4662f` (the over-escaping fix already applied to `escapeSendKeys`). The fix was applied to `sendKeys` but not carried through to the env var value escaping, which was simultaneously refactored in this branch. The MEDIUM issues are defense-in-depth improvements that should be addressed but are not exploitable through current code paths (avoids PF-002 — this is an unpublished feature with controlled inputs).
