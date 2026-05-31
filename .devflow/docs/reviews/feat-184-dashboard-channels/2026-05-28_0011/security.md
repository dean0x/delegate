# Security Review Report

**Branch**: feat/184-dashboard-channels -> main
**Date**: 2026-05-28
**Focus**: Security
**Files reviewed**: 47 files changed (+3108/-92)

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

### MEDIUM

(none)

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

(none)

## Detailed Analysis

### 1. SQL Injection / Database Security

**Assessment: SECURE**

All new database operations use parameterized queries:

- `saveMessageStmt` — prepared statement with named `@` parameters (`channel-repository.ts:179-182`)
- `countMessagesStmt` — prepared with positional `?` placeholder (`channel-repository.ts:184-186`)
- `pruneMessagesStmt` — prepared with positional `?` placeholders (`channel-repository.ts:188-197`)
- `getMessagesStmt` — prepared with positional `?` placeholders (`channel-repository.ts:199-201`)
- `findMembersByChannelIds` — the dynamic IN clause builds `?` placeholders from `ids.map(() => '?')`, and values are bound via `stmt.all(...ids)` (`channel-repository.ts:487-493`). The ids originate from a previous prepared-statement query (findAll/findByStatus), are string typed, and the list is bounded by `DEFAULT_LIMIT=100`. No user-controlled strings are interpolated into SQL.

Migration v32 (`database.ts:1266-1283`) uses DDL-only `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` with hardcoded SQL. No injection risk.

### 2. Command Injection / Shell Security (tmux)

**Assessment: SECURE** (applies ADR-001 -- channel names validated against tmux SESSION_NAME_REGEX)

The new `capturePaneContent` method (`tmux-session-manager.ts:446-476`) follows all existing security controls:

- **Session name validation**: `validateSessionName()` enforces `SESSION_NAME_REGEX` (`/^beat-[a-z0-9-]+$/`) before the name is interpolated into the shell command. This prevents shell metacharacter injection. The same guard is applied identically to all other session operations.
- **Lines parameter validation**: Integer-checked, positive, bounded by `MAX_CAPTURE_LINES=10_000` (`tmux-session-manager.ts:450-458`). Prevents injection of arbitrary values into `-S -${lines}`.
- **Session name quoting**: The tmux command uses single-quote wrapping: `tmux capture-pane -t '${name}' -p -S -${lines}`. Combined with the `SESSION_NAME_REGEX` allowlist (no single quotes possible), this is safe.
- **Error handling**: Session-not-found is treated as `ok('')` rather than an error, which is the correct idempotent pattern.

### 3. Input Validation at Boundaries

**Assessment: SECURE**

- **ChannelMessage Zod schema** (`channel-repository.ts:55-63`): `ChannelMessageRowSchema` validates all fields read from the database, including `z.string().min(1)` for identifiers and `z.number().int().positive()` for `created_at`. This parse-at-boundary pattern matches the existing `ChannelRowSchema` and `ChannelMemberRowSchema`.
- **Summary truncation**: `codePointSlice(message, 200)` is applied at both emission sites in `channel-manager.ts` (lines 473 and 1087) before the event is emitted. The persistence handler receives the already-truncated string. This prevents unbounded TEXT storage.
- **Message pruning**: `saveMessage()` includes inline pruning when count exceeds `MAX_MESSAGES_PER_CHANNEL=500` (`channel-repository.ts:394-402`). Pruning failure is caught and swallowed (best-effort), which does not affect the primary save. This prevents unbounded database growth.
- **getMessages limit clamping**: The effective limit is `Math.min(userLimit, MAX_MESSAGES_PER_CHANNEL)` (`channel-repository.ts:414-417`), preventing excessively large result sets.

### 4. Authentication / Authorization

**Assessment: N/A for this change scope**

Dashboard mutations (cancel/delete/pause/resume) follow the existing local-only pattern: the dashboard is a local CLI tool using bootstrapped services directly, not an HTTP API. Channel mutations go through `channelService.destroyChannel/pauseChannel/resumeChannel` which are the same service-layer methods used by MCP tools and CLI commands. No auth bypass is introduced.

The `cancelEntity` handler for channels (`entity-mutations.ts:84-90`) correctly checks `mutations.channelService` existence before calling, and checks `TERMINAL_STATUSES.channels` to prevent double-destroy. The `deleteEntity` handler (`entity-mutations.ts:200-205`) correctly restricts deletion to terminal statuses only.

### 5. Data Exposure / Information Leakage

**Assessment: SECURE**

- **Summary-only storage**: The `ChannelMessage` domain type stores only a 200-code-point summary, not the full message content (`domain.ts:1197`). Full message content is never persisted to the channel_messages table.
- **Pane preview is display-only**: `capturePaneContent` output flows to the terminal rendering layer only. It is not logged, persisted, or transmitted. The `ARCHITECTURE` JSDoc explicitly documents this constraint.
- **No sensitive data in events**: `ChannelMessageSentEvent.summary` is the only field added to the event schema. The full message body is not exposed through the event bus.

### 6. Denial of Service / Resource Exhaustion

**Assessment: SECURE**

- **Statement cache unbounded growth**: The `membersByChannelIdsStmtCache` (`channel-repository.ts:136`) is a `Map<number, Statement>` keyed by arity. Since `findAll` and `findByStatus` are bounded by `DEFAULT_LIMIT=100`, the arity range is 0-100, capping the cache at ~100 entries. This is acceptable.
- **Pane preview polling**: 3-second interval with guard against overlapping polls (`use-channel-pane-preview.ts:41-51`). The `fetching` ref prevents concurrent tmux exec calls.
- **Dashboard poll cycle**: Channel data is fetched via `channelRepository.findAll(FETCH_LIMIT)` alongside all other entities in the existing 1-second poll. No new unbounded queries.

### 7. Event Handler Security

**Assessment: SECURE**

The `ChannelMessagePersistenceHandler` (`channel-message-persistence-handler.ts`) follows the established `UsageCaptureHandler` pattern:

- Factory pattern with `create()` prevents uninitialized use
- Errors logged as warn, never thrown/propagated (best-effort)
- Guards on optional `summary` field: events without a summary are silently skipped (line 85)
- Message ID uses `crypto.randomUUID()` (line 90) -- cryptographically secure UUID generation
- Handler registration in `handler-setup.ts:554-569` is optional/non-fatal, matching the pattern of all other optional handlers

### 8. Foreign Key / Referential Integrity

**Assessment: SECURE**

Migration v32 includes `REFERENCES channels(id) ON DELETE CASCADE` on the `channel_id` column. This ensures channel_messages are automatically cleaned up when a channel is deleted, preventing orphaned rows.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | - | 0 | 0 |

**Security Score**: 9/10
**Recommendation**: APPROVED

## Rationale

This PR introduces no security vulnerabilities. All security-sensitive areas are well-handled:

1. **SQL operations** use parameterized queries throughout. The dynamic IN-clause in `findMembersByChannelIds` builds only `?` placeholders and binds values separately -- no string interpolation of user data into SQL.
2. **Shell command construction** in `capturePaneContent` applies the same `validateSessionName` + `SESSION_NAME_REGEX` guard as all other tmux operations (applies ADR-001). The lines parameter is validated as a bounded positive integer.
3. **Data truncation** and **pruning** prevent unbounded storage growth.
4. **Boundary validation** via Zod schemas ensures data integrity on database reads.
5. **Event handling** is best-effort with proper error isolation.
6. **Resource cleanup** follows established patterns (CASCADE deletes, polling guards, statement caching).

The one point deducted from the score is a minor observation: the pruning failure catch block in `saveMessage` (line 492) is a bare `catch {}` that swallows all errors without logging. While this is intentional (documented as "best-effort"), a `logger.debug` call would improve observability of unexpected pruning failures without impacting the best-effort contract. This is a style preference, not a security issue.
