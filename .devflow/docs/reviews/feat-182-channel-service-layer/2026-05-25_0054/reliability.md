# Reliability Review Report

**Branch**: feat-182-channel-service-layer -> main
**Date**: 2026-05-25
**PR**: #193

## Issues in Your Changes (BLOCKING)

### HIGH

**Shared named tmux buffer creates race condition between concurrent channels** - `src/implementations/tmux/tmux-session-manager.ts:59,400-420`
**Confidence**: 95%
- Problem: `CHANNEL_BUFFER_NAME` is hardcoded to `'beat-channel'` and shared across all `pasteContent()` calls. If two channels deliver messages concurrently (or even two members of the same channel), the load-buffer / paste-buffer / delete-buffer sequence is not atomic. Channel A could load-buffer, then Channel B overwrites the buffer with its content, then Channel A pastes Channel B's content into the wrong session. This is a classic TOCTOU race on a shared mutable resource.
- Impact: Messages can be delivered to the wrong session or lost entirely. In a multi-channel system this will happen under normal load.
- Fix: Use a unique buffer name per invocation (e.g., `beat-channel-${crypto.randomUUID()}`). The temp file already uses a UUID, so extend the same pattern to the buffer name:
  ```typescript
  const bufferId = `beat-ch-${crypto.randomUUID().slice(0, 8)}`;
  const loadResult = this.deps.exec(`tmux load-buffer -b '${bufferId}' '${escapedTempFile}'`);
  // ...
  const pasteResult = this.deps.exec(`tmux paste-buffer -b '${bufferId}' -t '${sessionName}'`);
  // ...
  this.deps.exec(`tmux delete-buffer -b '${bufferId}'`);
  ```

**No size bound on content passed to `pasteContent()`** - `src/implementations/tmux/tmux-session-manager.ts:368`
**Confidence**: 90%
- Problem: `pasteContent()` writes the entire `content` string to a temp file and loads it into a tmux buffer with no upper bound on content size. Agent output can be arbitrarily large (multi-MB code dumps, large log output). This can exhaust disk space in `os.tmpdir()` or cause tmux buffer allocation failures. The existing codebase already enforces `MAX_ENV_VALUE_LENGTH = 4096` for environment values, but channel messages have no equivalent guard.
- Impact: Unbounded allocation on disk and in tmux memory. A single large message could crash the tmux server or fill the temp directory.
- Fix: Add a maximum content length constant and validate before writing:
  ```typescript
  const MAX_PASTE_CONTENT_LENGTH = 256 * 1024; // 256KB — generous for agent output
  if (content.length > MAX_PASTE_CONTENT_LENGTH) {
    return err(
      tmuxSessionFailed('pasteContent', `Content exceeds maximum length (${MAX_PASTE_CONTENT_LENGTH} bytes)`, {
        sessionName,
        contentLength: content.length,
      }),
    );
  }
  ```

**`SerialQueue.drain()` can hang indefinitely if a queued task never resolves** - `src/services/channel-manager.ts:81-83`
**Confidence**: 85%
- Problem: `SerialQueue.drain()` returns the tail of the promise chain. If any enqueued task hangs (e.g., a tmux command blocks, a repository call deadlocks), `drain()` never resolves. While `drain()` is not called from a hot path today, `destroyChannel()` calls `queue.close()` but does not await `queue.drain()`, meaning pending tasks may still be running after destroy returns. If `drain()` is ever awaited (a natural evolution), it could hang indefinitely. More critically, the `.catch(() => {})` in `enqueue` swallows all errors silently, including timeout-related ones.
- Impact: Latent hang risk. Not immediately exploitable but introduces an unbounded operation in the task chain.
- Fix: Add a timeout to `drain()`:
  ```typescript
  async drain(timeoutMs = 5_000): Promise<void> {
    const timeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('SerialQueue drain timeout')), timeoutMs),
    );
    await Promise.race([this.chain, timeout]).catch(() => { /* timeout — best effort */ });
  }
  ```

### MEDIUM

**Channel recovery fire-and-forget with no error propagation to caller** - `src/bootstrap.ts:747-758`
**Confidence**: 82%
- Problem: `channelService.recoverChannels()` is called fire-and-forget with `.then()`. If recovery fails, the error is logged but the caller has no way to know recovery failed. This is acceptable for task recovery (existing pattern), but channel recovery differs because it modifies in-memory state (`memberHandles`, `messageQueues`, `pausedChannels`). If recovery fails partway, the in-memory maps may be partially populated, leading to inconsistent routing decisions. The existing task recovery pattern logs and moves on, but channel recovery populates Maps that drive message delivery.
- Impact: Partial recovery leaves the ChannelManager in an inconsistent state where some channels have handles and queues but others do not, even though they appear ACTIVE in the database.
- Fix: Consider wrapping the entire recovery in a try/catch within `recoverChannels()` that clears all in-memory state on failure, so the manager starts clean:
  ```typescript
  // At the top of recoverChannels():
  // Clear all in-memory state first to ensure idempotency
  this.memberHandles.clear();
  this.messageQueues.clear();
  this.pausedChannels.clear();
  this.currentTurn.clear();
  ```

**`findChannelIdBySession` is O(N) linear scan on every member output** - `src/services/channel-manager.ts:747-756`
**Confidence**: 80%
- Problem: Every time a channel member produces output, `handleMemberOutputAsync` calls `findChannelIdBySession`, which scans all entries in `memberHandles`. With 10 channels x 10 members = 100 entries, this runs 100 iterations on every single message. While bounded (max 10 members per channel is enforced), the bound is per-channel, not on total channels. There is no limit on the number of channels.
- Impact: Linear degradation as channels accumulate. Not a crash risk but a latency concern for message routing under scale.
- Fix: Maintain a reverse lookup map `sessionName -> channelId` alongside `memberHandles`. Update it in `createChannel`, `recoverChannels`, and `cleanupInMemory`.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`destroyChannel` sends C-c but does not actually wait for grace period** - `src/services/channel-manager.ts:258-273`
**Confidence**: 85%
- Problem: The code sends `C-c` via `sendControlKeys`, then immediately checks `isAlive` and calls `destroy`. The comment says "Brief grace period" and "Synchronous kill flow mirrors WorkerHandler pattern" but there is no actual delay between sending C-c and checking isAlive. In WorkerHandler, the grace period is implemented with a 2-second setTimeout. Here, the isAlive check runs in the same synchronous tick, making the C-c signal completely ineffective -- the process has not had time to react to SIGINT.
- Impact: The C-c signal is wasted. Every destroy is effectively a force-kill, which may cause agents to lose unsaved state.
- Fix: Either remove the C-c + isAlive check (since it has no effect) and go straight to `destroy()`, or implement a real grace period as WorkerHandler does.

## Pre-existing Issues (Not Blocking)

No CRITICAL pre-existing issues identified.

## Suggestions (Lower Confidence)

- **No bound on total number of channels** - `src/services/channel-manager.ts:126` (Confidence: 70%) -- Unlike `MAX_CONCURRENT_SESSIONS` for tmux sessions, there is no limit on how many channels can be created. Each channel consumes a SerialQueue, Map entries, and 1-10 tmux sessions. Without a cap, a caller could exhaust tmux sessions indirectly.

- **`recoverChannels` iterates channels sequentially** - `src/services/channel-manager.ts:441` (Confidence: 65%) -- Each channel's recovery makes N `isAlive` calls (one per member), each involving a `tmux has-session` exec. With many channels, recovery time is O(channels x members) synchronous exec calls. Consider batching via `listSessions()` once.

- **Round-robin tracking state not persisted** - `src/services/channel-manager.ts:109-110` (Confidence: 60%) -- `currentTurn` and round-robin state are in-memory only. After process restart, the turn resets to the first member by joinedAt, which may not be the correct next speaker. This could cause duplicate or missed turns.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 3 | 0 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Reliability Score**: 5/10
**Recommendation**: CHANGES_REQUESTED

The shared tmux buffer race condition is the most significant reliability issue -- it will cause message corruption under concurrent channel usage. The unbounded content size in `pasteContent` and the ineffective grace period in `destroyChannel` are secondary but should be addressed before merge. The `SerialQueue.drain()` timeout issue is a latent risk that should be hardened now to avoid future hangs. ADR-001 (channel name validation constrained to SESSION_NAME_REGEX) is correctly applied throughout -- channel names are validated and used directly as tmux session name suffixes without transformation (applies ADR-001).
