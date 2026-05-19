# Security Review Report

**Branch**: feat/178-worker-pool-rewiring -> main
**Date**: 2026-05-19

## Issues in Your Changes (BLOCKING)

### HIGH

**`sendControlKeys` lacks input validation on `keys` parameter -- shell injection via unescaped argument** - `src/implementations/tmux/tmux-session-manager.ts:239`
**Confidence**: 85%
- Problem: `sendControlKeys()` constructs a shell command by interpolating the `keys` parameter directly into the command string without quoting or validation: `tmux send-keys -t '${name}' ${keys}`. Unlike `sendKeys()` which uses `-l` (literal mode) and `escapeForSingleQuotes()`, `sendControlKeys()` intentionally skips both protections. While the JSDoc comment states "Callers must only pass well-known tmux key names", the interface is `public` and accepts any `string`. If a future caller passes user-controlled data (e.g. from MCP tool input), the unquoted `${keys}` is directly word-split by the shell, enabling command injection (e.g., `C-c; rm -rf /`).
- Impact: Currently the only call site passes the hardcoded literal `'C-c'` (in `event-driven-worker-pool.ts:237`), so this is not *presently* exploitable. However, the method is part of the public `TmuxSessionManagerPort` and `TmuxConnectorPort` interfaces, making it reachable from any future consumer. Defense-in-depth requires the method itself to be safe regardless of caller discipline.
- Fix: Add a validation allowlist for known tmux control key names:
  ```typescript
  // Well-known tmux control key names (allowlist)
  const ALLOWED_CONTROL_KEYS = new Set(['C-c', 'C-d', 'C-z', 'C-\\', 'Enter', 'Escape']);

  sendControlKeys(name: string, keys: string): Result<void, AutobeatError> {
    const nameCheck = validateSessionName(name, 'sendControlKeys');
    if (!nameCheck.ok) return nameCheck;

    if (!ALLOWED_CONTROL_KEYS.has(keys)) {
      return err(tmuxSendKeysFailed(name, `Unsupported control key: ${keys}`));
    }

    const result = this.deps.exec(`tmux send-keys -t '${name}' ${keys}`);
    // ...
  }
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`SAFE_PATH_REGEX` rejects paths with spaces -- common on macOS** - `src/implementations/tmux/types.ts:278`
**Confidence**: 82%
- Problem: `SAFE_PATH_REGEX` (`/^(?!.*\.\.)([a-zA-Z0-9/_.\-]+)$/`) does not allow space characters. On macOS, user-created directories and mounted volumes frequently contain spaces (e.g., `/Volumes/My Drive/projects/`, `/Users/John Doe/...`). The `sessionsDir` is computed from the database path (`path.dirname(dbResult.value.getPath())` in `bootstrap.ts:544`), which could live on a path with spaces if `AUTOBEAT_DATA_DIR` is set to such a location. The `cwd` validation in `createSession()` also uses `SAFE_PATH_REGEX` (line 104), rejecting working directories with spaces.
- Impact: Users with spaces in their data directory or working directory paths would get a cryptic "unsafe path" error. The security intent (preventing shell metacharacters and path traversal) is correct, but the character class is overly restrictive. Spaces are safe inside single-quoted shell strings.
- Fix: Add space to the character class:
  ```typescript
  export const SAFE_PATH_REGEX = /^(?!.*\.\.)([a-zA-Z0-9/_.\- ]+)$/;
  ```
  All embeddings already use `singleQuoteToken()` or `escapeForSingleQuotes()`, which handle spaces correctly inside single quotes.

## Pre-existing Issues (Not Blocking)

(none above CRITICAL threshold)

## Suggestions (Lower Confidence)

- **`TmuxConnectorPort.spawn()` uses `any` config type** - `src/core/tmux-types.ts:92` (Confidence: 65%) -- The `any` type on the config parameter bypasses compile-time validation for spawn callers importing from core. While documented as an architecture exception to break a circular dependency, this weakens the type safety boundary. A branded `unknown` with runtime validation at the connector layer would be safer.

- **`buildTmuxCommand` in `ProcessSpawnerAdapter` returns a hardcoded `'echo'` command** - `src/implementations/process-spawner-adapter.ts:54` (Confidence: 70%) -- The test adapter's `buildTmuxCommand` returns `command: 'echo'` with an `as unknown as TmuxSpawnConfig` cast. If tests inadvertently reach a real tmux session manager, `echo` would be spawned in a tmux session. Not a production risk (adapter is test-only via `options.processSpawner` guard in bootstrap), but the cast silences type errors that could flag misuse.

- **`spawnSync` with `shell: true` in bootstrap** - `src/bootstrap.ts:509` (Confidence: 62%) -- The shared `tmuxExec` function uses `spawnSync(cmd, { shell: true, encoding: 'utf8' })`. The `shell: true` option routes all commands through `/bin/sh`, which means the command string is subject to shell interpretation. All tmux commands constructed by `TmuxSessionManager` properly validate session names against `SESSION_NAME_REGEX` and escape values with `escapeForSingleQuotes`, so this is safe in practice. However, `shell: true` is the riskier execution mode and any future bypass of the validation layer would be exploitable.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 0 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Security Score**: 8/10
**Recommendation**: CHANGES_REQUESTED

### Rationale

The tmux integration demonstrates strong security awareness overall: input validation via regex allowlists (`SESSION_NAME_REGEX`, `TASK_ID_REGEX`, `SAFE_PATH_REGEX`), single-quote escaping utilities as a single source of truth, path traversal prevention, POSIX env var name validation, env value length caps, and defense-in-depth session caps. The wrapper script generation is carefully designed with `set -euo pipefail`, atomic sentinel writes, and `jq` for safe JSON escaping.

The one blocking issue (`sendControlKeys` accepting arbitrary unvalidated strings into an unquoted shell command) is a defense-in-depth gap. Today's sole call site is safe (hardcoded `'C-c'`), but the public interface contract is insufficiently constrained for a method that intentionally bypasses shell escaping. Adding an allowlist is a minimal change that closes this gap without affecting current functionality. (avoids PF-001 -- fixing now rather than deferring)
