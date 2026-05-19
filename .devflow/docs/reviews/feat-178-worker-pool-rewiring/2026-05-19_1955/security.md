# Security Review Report

**Branch**: feat/178-worker-pool-rewiring -> main
**Date**: 2026-05-19

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

### MEDIUM

**SAFE_PATH_REGEX allows backslash-escaped space but character class includes literal space** - `src/implementations/tmux/types.ts:281`
**Confidence**: 82%
- Problem: The updated `SAFE_PATH_REGEX` pattern `/^(?!.*\.\.)([a-zA-Z0-9/_.\ \-]+)$/` uses `\ ` inside the character class. Inside a character class `[...]`, the backslash before the space is unnecessary and works only because the regex engine treats `\ ` as a literal space. However, the regex comment block and the backslash-space notation obscure what is happening. If this regex were ever refactored to use a different quoting mechanism or regex flavor, the backslash could be misinterpreted. The functional behavior is correct (spaces are admitted, shell metacharacters are rejected), but the clarity is poor for a security-critical constant.
- Fix: Remove the unnecessary backslash to make intent explicit:
  ```typescript
  export const SAFE_PATH_REGEX = /^(?!.*\.\.)([a-zA-Z0-9/_. \-]+)$/;
  ```

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **`spawnSync` with `shell: true` and string argument in tmuxExec** - `src/bootstrap.ts:509` (Confidence: 65%) -- The bootstrap wires `tmuxExec` as `spawnSync(cmd, { shell: true })` where `cmd` is always constructed by TmuxSessionManager using validated inputs (SESSION_NAME_REGEX, SAFE_PATH_REGEX, escapeForSingleQuotes). The defense is multi-layered and currently sound. However, any future caller that passes unsanitized data through `ExecFn` would inherit shell injection risk. Consider a code comment on the `ExecFn` type noting that callers must sanitize inputs.

- **`unknown` type on TmuxConnectorPort.spawn() config weakens static type safety** - `src/core/tmux-types.ts:93` (Confidence: 60%) -- The `spawn(config: unknown, ...)` signature was chosen to break a circular dependency between core and implementations layers. The implementation casts `rawConfig as TmuxSpawnConfig` at the boundary (`tmux-connector.ts:143`). While this is a documented architectural exception, the `unknown` erases compile-time validation at the call site in `event-driven-worker-pool.ts:166`. If a caller ever passes a malformed config, the unsafe cast would silently accept it. This is a tradeoff the team has explicitly documented (not a bug), but worth noting for future awareness.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Security Score**: 9/10
**Recommendation**: APPROVED_WITH_CONDITIONS

## Security Analysis Summary

This PR rewires the worker pool from child-process-based workers to tmux-session-based workers. The security posture is strong, with several well-implemented controls:

### Positive Security Observations

1. **Shell injection defense-in-depth**: The `sendControlKeys()` method (which uses `tmux send-keys` WITHOUT `-l` literal mode) is protected by an `ALLOWED_CONTROL_KEYS` allowlist (`tmux-session-manager.ts:48-52`). Only known tmux key tokens (`C-c`, `C-d`, `C-z`, `C-\`, `Enter`, `Escape`) are accepted. The single call site in the worker pool passes hardcoded `'C-c'` (`event-driven-worker-pool.ts:274`).

2. **Session name validation**: All tmux commands validate session names against `SESSION_NAME_REGEX` (`/^beat-[a-z0-9-]+$/`) before embedding them in shell commands, preventing name-based injection.

3. **Path traversal prevention**: `SAFE_PATH_REGEX` rejects `..` sequences via negative lookahead and only admits a strict character set. The update to include spaces for macOS compatibility is safe because all path embeddings use `escapeForSingleQuotes()` / `singleQuoteToken()`.

4. **File permissions**: Wrapper scripts and session directories are created with mode `0o700` (owner-only access), preventing other users from reading or modifying session data.

5. **Timeout on spawnSync**: The `tmuxExec` function uses a 10-second timeout (`timeout: 10_000`) preventing indefinite blocking on tmux commands.

6. **Idempotent cleanup guards**: The `completionHandled` flag and `cleanupWorkerState` idempotency guard prevent double-completion races that could cause inconsistent state.

7. **No secrets in logs**: Log statements consistently omit sensitive fields (prompts are truncated, only session names and task IDs are logged).

8. **DB migration safety**: Migration v29 adds `session_name` as a nullable column with a partial index -- no data migration or backward compatibility risk (avoids PF-002 pattern).
