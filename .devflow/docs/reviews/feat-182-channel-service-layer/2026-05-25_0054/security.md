# Security Review Report

**Branch**: feat-182-channel-service-layer -> main
**Date**: 2026-05-25T00:54
**PR**: #193

## Issues in Your Changes (BLOCKING)

### HIGH

**Shared tmux buffer name creates race condition for concurrent channels** - `src/implementations/tmux/tmux-session-manager.ts:59,400-410`
**Confidence**: 85%
- Problem: `CHANNEL_BUFFER_NAME = 'beat-channel'` is a single static buffer name used by all `pasteContent()` calls. When two channels deliver messages concurrently, the sequence (load-buffer -> paste-buffer -> delete-buffer) for one channel can interleave with another, causing channel A's content to be pasted into channel B's session or vice versa. This is a data integrity issue — message content leaks across channel boundaries.
- Impact: In multi-channel deployments, messages from one channel could be delivered to members of a different channel. While the `SerialQueue` serializes within a single channel, it does not serialize across different channels calling `pasteContent` simultaneously.
- Fix: Use a unique buffer name per invocation (e.g., incorporate `crypto.randomUUID()` into the buffer name) or use the tmux `-` stdin buffer mode with process substitution to avoid named buffers entirely:
```typescript
const bufferName = `beat-ch-${crypto.randomUUID().slice(0, 8)}`;
// Use bufferName instead of CHANNEL_BUFFER_NAME in load-buffer, paste-buffer, delete-buffer
```
- Applies ADR-001 (channel names -> tmux session names)

### MEDIUM

**No size limit on content passed to pasteContent()** - `src/implementations/tmux/tmux-session-manager.ts:368-426`
**Confidence**: 82%
- Problem: Unlike `setSessionEnvironment()` which enforces `MAX_ENV_VALUE_LENGTH` (4096 bytes), `pasteContent()` accepts content of arbitrary size and writes it to a temp file. A pathologically large message (e.g., from a runaway agent producing megabytes of output) could exhaust disk space in `/tmp` or cause excessive memory consumption during `writeFileSync`.
- Impact: Denial of service via temp directory exhaustion. The temp file is cleaned up in `finally`, but the write itself is unbounded.
- Fix: Add a `MAX_PASTE_CONTENT_LENGTH` constant (e.g., 1MB) and validate before writing:
```typescript
const MAX_PASTE_CONTENT_LENGTH = 1_048_576; // 1 MB
if (content.length > MAX_PASTE_CONTENT_LENGTH) {
  return err(tmuxSessionFailed('pasteContent', `Content exceeds maximum length (${MAX_PASTE_CONTENT_LENGTH} bytes)`));
}
```

**User-controlled input reflected in error messages without sanitization** - `src/services/channel-manager.ts:129-136`
**Confidence**: 80%
- Problem: Channel name from `request.name` is interpolated directly into the error message: ``Invalid channel name '${request.name}'``. While this is a Result-based error (not an HTTP response), if error messages are ever logged to structured JSON or surfaced in MCP responses, control characters or excessively long names could cause log injection or output formatting issues.
- Impact: Low in current architecture since errors return as `AutobeatError` objects. However, defense-in-depth principles suggest truncating or sanitizing user input in error messages. The `CHANNEL_NAME_REGEX` validation runs before the message is constructed but it is placed inside the error branch itself (test fails -> construct message with bad input).
- Fix: Truncate the name in the error message:
```typescript
const truncatedName = request.name.slice(0, 64);
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Fire-and-forget channel recovery with no retry or bounded timeout** - `src/bootstrap.ts:747-758`
**Confidence**: 80%
- Problem: `channelService.recoverChannels()` is called fire-and-forget (`.then()` with error logging). If recovery stalls (e.g., deadlocked tmux session), the promise hangs silently forever. The existing task recovery at line 740-744 has the same pattern, but adding another fire-and-forget pathway compounds the risk.
- Impact: A hanging recovery blocks no other operations (fire-and-forget), but the promise leak means the process cannot cleanly track outstanding work for graceful shutdown. If a future change makes recovery blocking, this becomes a liveness issue.
- Fix: Consider adding a timeout wrapper consistent with the existing task recovery pattern. At minimum, document that both recovery paths are intentionally fire-and-forget with explicit bounded expectations.

## Pre-existing Issues (Not Blocking)

(No critical pre-existing security issues found in the reviewed files.)

## Suggestions (Lower Confidence)

- **Temp file created with default permissions** - `src/implementations/tmux/tmux-session-manager.ts:395` (Confidence: 65%) -- `writeFileSync(tempFile, content)` uses default file permissions (0o666 minus umask). On shared systems, other users could read the temp file briefly before it is deleted. Consider writing with mode `0o600` for defense-in-depth: `writeFileSync(tempFile, content, { mode: 0o600 })`. However, the injected `writeFileSync` signature only accepts `(path, content)`, so this would require a signature change.

- **Member agent type cast without runtime validation** - `src/services/channel-manager.ts:542` (Confidence: 62%) -- `member.agent as Parameters<typeof this.agentRegistry.get>[0]` casts the agent string to the registry's expected type. If an invalid agent name is provided by the MCP caller, the `agentRegistry.get()` call handles it gracefully (returns err), but the type assertion bypasses compile-time safety. Consider using a Zod schema or union-type validation at the service boundary.

- **handleKey composite key could collide if channelId contains ':'** - `src/services/channel-manager.ts:791-793` (Confidence: 60%) -- The `handleKey()` method joins `channelId` and `memberName` with `:`. ChannelId is a branded UUID (no colons), so collision is not currently possible, but the pattern is fragile if the ID format ever changes.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Security Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

### Rationale

The code demonstrates strong security fundamentals throughout:
- Session names are validated against `SESSION_NAME_REGEX` before shell embedding (applies ADR-001)
- The `pasteContent()` temp-file approach correctly avoids shell expansion of special characters ($, backticks, newlines)
- Control key allowlisting (`ALLOWED_CONTROL_KEYS`) prevents injection via `sendControlKeys()`
- Input is validated at service boundaries (channel name regex, member count bounds, name uniqueness)
- `escapeForSingleQuotes()` is consistently used for all shell-embedded values
- Dependency injection enables full unit testing without real tmux

The primary concern is the shared `CHANNEL_BUFFER_NAME` race condition (HIGH), which could cause cross-channel message leakage in production multi-channel scenarios. The unbounded content size in `pasteContent()` is a secondary concern worth addressing for robustness.
