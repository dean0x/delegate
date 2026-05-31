# Security Review Report

**Branch**: feat-184-dashboard-channels -> main
**Date**: 2026-05-27
**PR**: #196

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Missing `lines` parameter validation in `capturePaneContent` — shell command injection vector** - `src/implementations/tmux/tmux-session-manager.ts:443`
**Confidence**: 85%
- Problem: The `lines` parameter is interpolated directly into a shell command (`-S -${lines}`) without any validation that it is a positive integer. While the current call site always uses the default (`10`) or passes `undefined`, the method signature accepts `number` and the type system does not constrain it. A non-integer, negative, or specially-crafted value would produce a malformed tmux command. More critically, this method follows the same pattern as `validateDimensions` (lines 167-172) for width/height, yet omits the equivalent guard for `lines`.
- Impact: Defense-in-depth gap. If any future caller passes a user-controlled or externally-derived `lines` value, it enters the shell command unescaped. The `name` parameter is validated via `SESSION_NAME_REGEX`, but `lines` has no equivalent gate. Current risk is LOW because the only caller hardcodes the default, but the method is part of the public `TmuxSessionManagerPort` interface and can be called by any consumer.
- Fix: Add integer validation consistent with `validateDimensions`:
```typescript
capturePaneContent(name: string, lines = 10): Result<string, AutobeatError> {
  const nameCheck = validateSessionName(name, 'capturePaneContent');
  if (!nameCheck.ok) return nameCheck;

  // SECURITY: Validate lines is a positive integer before embedding in shell command
  if (!Number.isInteger(lines) || lines <= 0) {
    return err(
      tmuxSessionFailed('capturePaneContent', `lines must be a positive integer, got ${lines}`, {
        sessionName: name,
        lines,
      }),
    );
  }

  const result = this.deps.exec(`tmux capture-pane -t '${name}' -p -S -${lines}`);
  // ...rest unchanged
```

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Summary field unbounded before `codePointSlice`** - `src/services/channel-manager.ts:464,1078` (Confidence: 65%) — The `codePointSlice(message, 200)` call truncates after allocating the full `Array.from(str)`. For very large messages (multi-MB agent outputs), this creates a transient array proportional to input length. Consider guarding with `str.length > maxCodePoints * 4 ? str.slice(0, maxCodePoints * 4) : str` before the Array.from to cap allocation. Low urgency since tmux paste-buffer already limits content to 256KB (`MAX_PASTE_CONTENT_LENGTH`).

- **`crypto.randomUUID()` usage in persistence handler** - `src/services/handlers/channel-message-persistence-handler.ts:90` (Confidence: 62%) — Message IDs use `cm-${crypto.randomUUID()}` which is cryptographically secure and appropriate. No concern with the entropy source, but the `cm-` prefix combined with UUID means message IDs are never validated against the ChannelMessageRowSchema `id: z.string().min(1)` constraint on write (only on read). If the schema is ever tightened (e.g., regex pattern), writes could succeed but reads would fail validation. Minor consistency concern.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Security Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Positive Security Observations

1. **Parameterized SQL everywhere** — All database queries use prepared statements (`this.db.prepare(...)` with bound parameters). No string interpolation in SQL. (applies ADR-001 — channel names validated via SESSION_NAME_REGEX subset)
2. **Zod boundary validation on DB reads** — `ChannelRowSchema`, `ChannelMemberRowSchema`, and `ChannelMessageRowSchema` parse every row coming out of SQLite, preventing type confusion from corrupt or tampered data.
3. **Session name validation consistent** — The new `capturePaneContent` method validates `name` via `validateSessionName` before embedding in a shell command, matching all other session operations. (applies ADR-001)
4. **Immutable domain objects** — `Object.freeze()` applied to all channel/member/message objects returned from the repository, preventing mutation after construction.
5. **Best-effort error handling in handler** — `ChannelMessagePersistenceHandler` logs errors as warnings and returns `ok(undefined)`, preventing message persistence failures from cascading into channel communication.
6. **Channel rollback is complete** — `createChannel` rollback on `ChannelCreated` emit failure now includes `channelRepository.delete()`, avoiding the orphan record pitfall. (avoids PF-004)
7. **FK cascade on channel_messages** — Migration v32 uses `ON DELETE CASCADE` on `channel_id`, so deleting a channel automatically cleans up its message history.
8. **No hardcoded secrets** — No credentials, tokens, or API keys in any changed file.
9. **Terminal status guard on mutations** — Dashboard keyboard handlers check entity status before allowing cancel/delete/pause/resume operations, preventing invalid state transitions.

### Condition for Approval

Fix the `lines` parameter validation in `capturePaneContent` (the single MEDIUM blocking issue). This is a defense-in-depth gap that should be closed before the method is exposed on a public port interface.
