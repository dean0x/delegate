# Security Review Report

**Branch**: feat/184-dashboard-channels -> main
**Date**: 2026-05-27T22:58
**Reviewer Focus**: Security
**Prior Resolutions**: Cycle 1 fixed 10 of 11 issues including the shell interpolation vulnerability in `capturePaneContent`. This cycle focuses on verifying the fix and any remaining or newly introduced security concerns.

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

(none)

## Analysis Notes

### Shell Injection — capturePaneContent (VERIFIED FIXED)

The Cycle 1 review identified that `capturePaneContent` interpolated an unvalidated `lines` parameter directly into a shell command (`tmux capture-pane ... -S -${lines}`). This was fixed in commit `9dffc2e` by adding validation at the top of the method:

```typescript
// tmux-session-manager.ts:450-458
if (!Number.isInteger(lines) || lines <= 0 || lines > MAX_CAPTURE_LINES) {
  return err(
    tmuxSessionFailed(
      'capturePaneContent',
      `Invalid lines value: ${lines}. Must be a positive integer <= ${MAX_CAPTURE_LINES}`,
      { lines },
    ),
  );
}
```

`MAX_CAPTURE_LINES` is set to 10,000. The validation ensures only positive integers within a safe bound reach the shell command. This is correct and sufficient — a validated positive integer cannot contain shell metacharacters.

### Shell Command Construction — Consistent Escaping Patterns

All tmux shell commands in `TmuxSessionManager` follow a consistent security pattern:

1. **Session names**: Validated against `SESSION_NAME_REGEX` before use (applies ADR-001 — channel names are constrained to tmux-safe patterns by construction)
2. **Single-quote escaping**: All user-controlled strings (cwd, keys, env values, content) are escaped via `escapeForSingleQuotes()` before embedding in single-quoted shell contexts
3. **Control keys**: Validated against `ALLOWED_CONTROL_KEYS` allowlist before unquoted interpolation
4. **Paste content**: Uses temp-file + load-buffer pattern to avoid shell expansion entirely
5. **Environment variables**: Keys validated against `POSIX_ENV_VAR_REGEX`, values length-capped at 4096 bytes

The new `capturePaneContent` method follows these existing patterns correctly.

### SQL Injection — Parameterized Queries Throughout

All SQL in `SQLiteChannelRepository` uses parameterized prepared statements. The one dynamic SQL construction (`findMembersByChannelIds`) builds an IN clause using `ids.map(() => '?').join(', ')` with separate parameter binding — this is the correct pattern for dynamic IN clauses with better-sqlite3 and is not vulnerable to SQL injection.

Migration v32 uses `db.exec()` with a static DDL string (no interpolation). Safe.

### Input Validation at Boundaries

- **Zod schemas** (`ChannelRowSchema`, `ChannelMemberRowSchema`, `ChannelMessageRowSchema`) validate all data read from the database before domain object construction. This prevents corrupt database rows from propagating invalid data.
- **`codePointSlice(message, 200)`** truncates message summaries safely at Unicode code-point boundaries before persistence. This prevents storing oversized data and handles surrogate pairs correctly.
- **`ChannelMessage.summary`** is bounded to 200 code points at the source (`channel-manager.ts`) and validated as `z.string()` (non-empty) at the persistence boundary. No risk of unbounded storage.

### Event-Driven Handler — Best-Effort Pattern

`ChannelMessagePersistenceHandler` follows the same best-effort pattern as `UsageCaptureHandler`:
- Errors are logged at `warn` level, never thrown or propagated
- Missing `summary` field is silently skipped (guard at line 85)
- No business logic depends on persistence success

This is the correct security posture for a display-only handler — a persistence failure cannot affect channel message delivery.

### Dashboard Data Flow — No Privilege Escalation Vectors

- `capturePaneContent` is wired through as an optional prop from `index.tsx` to `App`. The function is only created when `tmuxSessionManager` is available in the container, and session names are resolved from existing dashboard data (channel members with `tmuxSession` field).
- Channel mutations (pause/resume/destroy/delete) are guarded by:
  - Terminal status checks (`TERMINAL_STATUSES.channels`) before destructive operations (avoids PF-004 — multi-step rollback is only relevant for create, not dashboard mutations)
  - Optional `channelService` / `channelRepo` checks (null-guard before mutation call)
  - Best-effort try/catch blocks that swallow errors to prevent dashboard crashes
- No new authentication or authorization boundaries are introduced. This is an internal dashboard with no network-facing API surface.

### Message Pruning — Bounded Growth

`saveMessage()` includes inline pruning to `MAX_MESSAGES_PER_CHANNEL` (500 rows) after every INSERT. This prevents the `channel_messages` table from growing unboundedly in long-running channels. The pruning is best-effort — failure does not fail the save. This was identified and fixed in Cycle 1.

### No Hardcoded Secrets

Grep across the diff confirmed no hardcoded passwords, API keys, tokens, or credentials were introduced.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Security Score**: 9/10
**Recommendation**: APPROVED

The security posture of this PR is strong. The prior Cycle 1 shell interpolation vulnerability has been properly fixed with integer validation and an upper bound. All SQL is parameterized. Shell command construction follows established escaping patterns throughout. Input validation is applied at boundaries using Zod schemas and explicit guards. No new attack surfaces (network, auth, injection) are introduced — the changes are entirely internal dashboard UI and event-driven persistence. The code demonstrates defense-in-depth with consistent application of the project's security patterns.
