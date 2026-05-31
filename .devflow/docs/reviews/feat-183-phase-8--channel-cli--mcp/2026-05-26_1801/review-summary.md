# Code Review Summary

**Branch**: feat/183-phase-8--channel-cli--mcp -> main
**Date**: 2026-05-26 18:01 UTC
**Cycle**: 1 (initial review)

## Merge Recommendation: CHANGES_REQUESTED

**Rationale**: Two HIGH-severity blocking issues in reliability/safety and one HIGH-severity blocking issue in documentation prevent merge. Four additional MEDIUM-severity issues should be fixed. Once these are resolved, the PR can be approved.

---

## Issue Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW | Total |
|----------|----------|------|--------|-----|-------|
| Blocking | 0 | 3 | 5 | 0 | 8 |
| Should Fix | 0 | 0 | 2 | 0 | 2 |
| Pre-existing | 0 | 0 | 2 | 1 | 3 |

**Total across all reviewers**: 13 distinct issues (after deduplication)

---

## Blocking Issues (CRITICAL + HIGH)

### 🔴 HIGH: SerialQueue.drain() timeout creates race condition in sendMessage
**Severity**: HIGH | **Confidence**: 85%
**Category**: Reliability (Blocking)
**File**: `src/services/channel-manager.ts:453`

**Problem**: The `sendMessage` method calls `queue.drain(10_000)` and then checks `delivered` boolean. If the drain timeout expires before the enqueued closure executes, the method returns `err("Message delivery timed out")` — but the enqueued task remains in the promise chain and may still execute later, after the caller has been told delivery failed. This creates a race: the caller may retry or report failure while the original message is still in-flight and may be delivered to the tmux session. The `delivered` boolean and `dispatchError` variables are mutated from inside the enqueued closure after `drain()` has already resolved, creating a classic TOCTOU window.

**Impact**: In high-throughput scenarios with slow tmux paste operations, messages could be delivered twice (once from the stale closure, once from a retry). This violates at-most-once delivery guarantees expected by channel users.

**Fix**: Add a `cancelled` flag that the enqueued closure checks before dispatching. If `drain()` times out, set `cancelled = true` to prevent the orphaned task from executing:

```typescript
let cancelled = false;
queue.enqueue(async () => {
  if (cancelled) return;
  // ... dispatch logic
});
await queue.drain(10_000);
if (!delivered) {
  cancelled = true;
  return err('Message delivery timed out');
}
```

**References**: Reliability review (HIGH), avoids PF-003 (unbounded async)

---

### 🔴 HIGH: No container disposal on CLI mutation command exit
**Severity**: HIGH | **Confidence**: 82%
**Category**: Reliability (Blocking)
**File**: `src/cli/commands/channel.ts:314-317`, `src/cli/commands/msg.ts:104-108`

**Problem**: When `channelService` is `undefined` (unavailable), the handlers call `process.exit(1)` immediately after `withServices()` has bootstrapped the full container (DB, event bus, etc.). The container is never disposed. While this is a CLI (short-lived process), SQLite WAL mode can leave `-wal` and `-shm` files that are not properly checkpointed on hard exit, and any pending async operations started by bootstrap are abruptly terminated. This occurs in 5 handlers: `handleChannelCreate`, `handleChannelDestroy`, `handleChannelPause`, `handleChannelResume`, and `handleMsgCommand`.

**Impact**: Incomplete SQLite checkpoint → potential data consistency issues on next boot. Abrupt task termination → orphaned event subscriptions or tmux session management processes.

**Fix**: Call `container.dispose()` before `process.exit()`:

```typescript
const { container, resolveChannelService } = await withServices(s);
const channelService = await resolveChannelService();
if (!channelService) {
  s.stop('Failed');
  ui.error('Channel service unavailable.');
  await container.dispose();
  process.exit(1);
}
```

**References**: Reliability review (HIGH x2, flagged in 5 handlers), avoids PF-004 (incomplete cleanup)

---

### 🔴 HIGH: systemPrompt description contradicts code behavior (documentation)
**Severity**: HIGH | **Confidence**: 92%
**Category**: Documentation (Blocking)
**File**: `src/adapters/mcp-adapter.ts:600`, `src/adapters/mcp-adapter.ts:1936`

**Problem**: The Zod schema description at line 600 says `"System prompt for single-member channels (overrides per-member systemPrompt)"`. The tool listing description at line 1936 repeats this. However, the actual code at line 4282 implements the opposite: `m.systemPrompt ?? (data.members.length === 1 && idx === 0 ? data.systemPrompt : undefined)` — using the nullish coalescing operator, per-member systemPrompt takes precedence (wins) over top-level systemPrompt. The inline code comment at line 4281 correctly says "per-member wins", but the two descriptions presented to API consumers are wrong. This directly misleads MCP tool callers into expecting the wrong override behavior.

**Impact**: MCP clients that read the tool descriptions will implement logic assuming top-level overrides per-member, which contradicts the actual behavior. This causes integration errors.

**Fix**: Change both descriptions from "overrides per-member systemPrompt" to "fallback when per-member systemPrompt is not set":

```typescript
// Line 600 (Zod schema):
.describe('System prompt for single-member channels (used when per-member systemPrompt is not set)')

// Line 1936 (tool listing):
'System prompt for single-member channels (used when per-member systemPrompt is not set, max 100KB)'
```

**References**: Documentation review (HIGH)

---

### 🔴 MEDIUM: Repetitive channelService unavailability guard in 7 MCP handlers
**Severity**: MEDIUM (HIGH architecture impact) | **Confidence**: 85%
**Category**: Architecture (Blocking)
**File**: `src/adapters/mcp-adapter.ts:4247`, `4333`, `4373`, `4448`, `4506`, `4555`, `4595`

**Problem**: Every channel handler repeats an identical 7-line `if (!this.channelService)` guard block. This is a Shallow Module anti-pattern — the guard logic is duplicated rather than encapsulated, inflating the handler section by ~50 lines of pure repetition. When the error format changes, all 7 sites must be updated in lockstep. The codebase has pattern precedent: schedule, loop, and orchestration handlers do not have equivalent guards because those services are mandatory, but the inconsistency makes the codebase harder to maintain.

**Impact**: Code duplication → higher maintenance cost → increased risk of divergence if the guard logic needs to change.

**Fix**: Extract a private `requireChannelService(): ChannelService | MCPToolResponse` guard method that returns either the service or the error response. Each handler calls it once:

```typescript
private requireChannelService(): ChannelService | MCPToolResponse {
  if (this.channelService) return this.channelService;
  return {
    content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Channel service unavailable' }, null, 2) }],
    isError: true,
  };
}

// In each handler:
const svc = this.requireChannelService();
if ('isError' in svc) return svc as MCPToolResponse;
```

**References**: Architecture review (HIGH), Complexity review (suggestion at 70%)

---

### 🔴 MEDIUM: parseChannelCreateArgs has 137 lines with cyclomatic complexity ~18-20
**Severity**: MEDIUM (HIGH cognitive complexity) | **Confidence**: 90%
**Category**: Complexity (Blocking)
**File**: `src/cli/commands/channel.ts:74-210`

**Problem**: The `parseChannelCreateArgs` function spans lines 74-210 (137 lines) and contains a for-loop with 10 `if/else if` branches for flag parsing, followed by 7 sequential validation checks with early returns. Cyclomatic complexity is approximately 18-20, exceeding the warning threshold and approaching critical. The function handles two concerns: argument tokenization/extraction AND multi-mode semantic validation. High complexity makes the logic difficult to test comprehensively and understand at a glance.

**Impact**: Maintenance burden → increased bug risk in future flag additions → difficult to test all branches.

**Fix**: Split into two functions: (1) a tokenizer that extracts raw flag values, and (2) a validator that applies semantic rules:

```typescript
// Tokenizer: extract raw flags (~50 lines, low complexity)
function tokenizeChannelCreateFlags(args: readonly string[]): Result<RawChannelCreateFlags, string> { ... }

// Validator: check constraints (~60 lines, moderate complexity)
function validateChannelCreateFlags(flags: RawChannelCreateFlags): Result<ParsedChannelCreate, string> { ... }

// Compose
export function parseChannelCreateArgs(args: readonly string[]): Result<ParsedChannelCreate, string> {
  const flags = tokenizeChannelCreateFlags(args);
  if (!flags.ok) return flags;
  return validateChannelCreateFlags(flags.value);
}
```

**References**: Complexity review (HIGH)

---

### 🔴 MEDIUM: Missing length limit on topic field
**Severity**: MEDIUM | **Confidence**: 85%
**Category**: Security (Blocking)
**File**: `src/adapters/mcp-adapter.ts:594`, `src/cli/commands/channel.ts:110-112`

**Problem**: The `topic` field in `CreateChannelSchema` is `z.string().optional()` with no `.max()` constraint. While the downstream `pasteContent()` enforces a 256KB byte limit (causing a delivery failure), the topic is first persisted to the `channels` table with no size guard at the MCP boundary. An attacker could submit a multi-megabyte topic string that consumes database storage and memory during parsing. The `message` field in `SendChannelMessageSchema` correctly limits to 262,144 chars; `systemPrompt` correctly limits to 100,000 chars. The CLI `--topic` flag also accepts the value without any length check.

**Impact**: Potential DoS via unbounded topic field → database bloat → memory exhaustion during parsing.

**Fix**: Add `.max(262_144)` to both the MCP schema and CLI parser to align with the existing `SendChannelMessage` message cap:

MCP schema:
```typescript
topic: z.string().max(262_144).optional().describe('Initial topic delivered to members on creation'),
```

CLI parser:
```typescript
} else if (arg === '--topic' && next !== undefined) {
  if (next.length > 262_144) {
    return err('--topic must be at most 262,144 characters');
  }
  topic = next;
```

**References**: Security review (MEDIUM x2)

---

### 🔴 MEDIUM: parseChannelCreateArgs CLI parser missing test coverage
**Severity**: MEDIUM | **Confidence**: 85%
**Category**: Testing (Blocking)
**File**: `tests/unit/cli/channel.test.ts`

**Problem**: The `parseChannelCreateArgs` function enforces a 100,000-character limit on `--system-prompt` (line 121), but no test verifies the boundary or rejection. The happy path is tested but the error path is not. This is a boundary validation on user input — the same class of boundary that `parseMsgArgs` correctly tests at 262,144 chars. Additionally, the shorthand flags `-a` (for `--agent`) and `-w` (for `--working-directory`) are not tested, even though they are documented in the code. All 31 tests use long-form flags exclusively.

**Impact**: Regression risk — if the boundary logic is accidentally removed or the argument index math changes, no test would catch it.

**Fix**: Add tests for:
1. Reject `--system-prompt` exceeding 100,000 chars
2. Accept `--system-prompt` at exactly 100,000 chars
3. Accept `-a` shorthand for `--agent`
4. Accept `-w` shorthand for `--working-directory`

**References**: Testing review (MEDIUM x2)

---

### 🔴 MEDIUM: Missing memberName validation in parseMsgArgs
**Severity**: MEDIUM | **Confidence**: 82%
**Category**: TypeScript/Validation (Blocking)
**File**: `src/cli/commands/msg.ts:73`

**Problem**: `channelName` is validated against `CHANNEL_NAME_REGEX` (line 80), but `memberName` is passed through without any format validation. In `parseChannelCreateArgs` and `CreateChannelSchema`, member names ARE validated against the same regex. This inconsistency violates the "parse at boundaries" principle — obviously invalid names should be rejected early with a clear message rather than deferred to a generic "not found" service error (defense-in-depth exists, but the boundary should validate).

**Impact**: Confusing error messages — users get "not found" when they could get "invalid member name" immediately.

**Fix**: Add validation for `memberName` after slash parsing:

```typescript
if (memberName && !CHANNEL_NAME_REGEX.test(memberName)) {
  return err(
    `Invalid member name "${memberName}": must be lowercase alphanumeric with interior hyphens, max 64 chars`,
  );
}
```

**References**: TypeScript review (MEDIUM)

---

## Should-Fix Issues (MEDIUM confidence, non-blocking)

### ⚠️ MEDIUM: Unsafe agent cast in MCP CreateChannel handler
**Severity**: MEDIUM | **Confidence**: 82%
**Category**: Architecture (Should Fix)
**File**: `src/adapters/mcp-adapter.ts:4279`

**Problem**: The `as import('../core/agents.js').AgentProvider` cast performs an unchecked type assertion on user input that has only been validated as `z.string().min(1)` by the Zod schema. The `CreateChannelSchema` member agent field accepts any non-empty string. If an invalid agent string reaches `channelService.createChannel()`, the error depends on service-layer validation. The CLI parser correctly validates with `isAgentProvider()`, making this inconsistency visible. This violates "parse at boundaries".

**Recommendation**: Add agent validation to the Zod schema using `z.enum(AGENT_PROVIDERS_TUPLE)`, matching the CLI pattern and eliminating the unsafe cast entirely. This is recommended but not blocking if the service layer validation is comprehensive (which it should be).

**References**: Architecture review (MEDIUM)

---

### ⚠️ MEDIUM: Unsafe resolveChannelId error swallowing
**Severity**: MEDIUM | **Confidence**: 88%
**Category**: Reliability (Should Fix)
**File**: `src/cli/commands/channel.ts:289-297`

**Problem**: `resolveChannelId` returns `null` for both "not found" and "repository error" cases (`if (!result.ok) return null`). A database connection failure, corrupt index, or query timeout would be reported as "Channel not found" rather than the actual error. This masks transient failures as permanent-not-found conditions.

**Recommendation**: Return the error or propagate it so the caller can distinguish "not found" from "failed to look up". This prevents operators from being misled about failure causes.

**References**: Reliability review (MEDIUM)

---

## Pre-existing Issues (NOT BLOCKING)

### ℹ️ PRE-EXISTING MEDIUM: 6 npm audit vulnerabilities
**Severity**: MEDIUM | **Confidence**: 95%
**Category**: Dependencies (Pre-existing)

**Problem**: `npm audit` reports 6 vulnerabilities across transitive dependencies: `fast-uri` (HIGH — path traversal), `hono` (MODERATE — 5 advisories). All are pre-existing on `main` and are not introduced by this branch. No new dependencies were added.

**Recommendation**: Run `npm audit fix` in a separate PR. This PR does not introduce new attack surface.

**References**: Dependencies review (MEDIUM, pre-existing)

---

## Convergence Status (Cycle 1)

**Convergent findings** (multiple reviewers agree):
1. Repetitive channelService guard (Architecture 85% + Complexity 70%)
2. SerialQueue drain race (Reliability 85%)
3. Container disposal on exit (Reliability 82% x2)
4. systemPrompt description drift (Documentation 92%)
5. parseChannelCreateArgs complexity (Complexity 90%)
6. Missing systemPrompt test (Testing 85%)
7. Topic length limit missing (Security 85% x2)

**Divergent findings** (single reviewer, lower confidence):
- workingDirectory overly restrictive (Security 82%, LOW severity)
- ReadOnlyContext breaking change (Regression 82%, mitigated)

**Clear consensus**: 3 HIGH-severity items + 5 MEDIUM items must be fixed before merge.

---

## Quality Observations

### Strengths
1. ✅ **Result types used consistently** — all fallible operations return `Result<T, E>`. No exceptions in business logic.
2. ✅ **Zod schemas at boundaries** — all MCP inputs validated before processing.
3. ✅ **Dependency injection** — channelService properly wired through Container with optional handling.
4. ✅ **Pattern compliance** — follows established loop/schedule CLI conventions (withReadOnlyContext for queries, withServices for mutations).
5. ✅ **Rollback completeness** — createChannel correctly cleans DB, tmux sessions, and in-memory state (avoids PF-004).
6. ✅ **Channel name validation** — consistently uses `CHANNEL_NAME_REGEX` across CLI, MCP, and service layers (applies ADR-001).
7. ✅ **Test coverage** — 104 new test cases across channel, msg, and MCP adapter files. Behavior-focused, good boundary testing.
8. ✅ **Performance patterns** — lazy resolution for optional service, batch operations, in-memory cache with proper invalidation.

### Areas for Improvement
1. ⚠️ **Duplicate guard boilerplate** — 7 MCP handlers repeat the same unavailability check
2. ⚠️ **File size** — MCP adapter now 4,622 lines, approaching maintainability limits
3. ⚠️ **Dual schema definitions** — Zod schemas + JSON Schema tool definitions both need updates (pre-existing pattern)

---

## Decisions Applied

- **ADR-001**: Channel name validation uses `CHANNEL_NAME_REGEX` consistently across CLI, MCP, and service boundaries, maintaining tmux session name compatibility.
- **Avoids PF-004**: The createChannel rollback path correctly handles all three layers (DB, tmux, in-memory), preventing orphaned resources.
- **Avoids PF-003**: (Partial) SerialQueue backpressure gap identified but pre-existing; the drain timeout race is a new HIGH-severity regression that should be fixed.

---

## Action Plan for Resolution

**Priority 1 (HIGH - must fix):**
1. Fix SerialQueue drain race (add cancellation flag)
2. Add container.dispose() on CLI exit paths (5 handlers)
3. Fix systemPrompt description (2 locations)
4. Extract `requireChannelService()` guard method (7 handlers affected)
5. Add topic length validation (MCP + CLI)
6. Split parseChannelCreateArgs into tokenizer + validator

**Priority 2 (MEDIUM - should fix before merge):**
7. Add agent validation to CreateChannelSchema Zod
8. Fix resolveChannelId to propagate errors (not swallow)
9. Add missing test cases (--system-prompt boundary, shorthand flags)
10. Add memberName validation in parseMsgArgs

**Priority 3 (Post-merge improvements):**
- Extract MCP channel handlers into dedicated module
- Generate JSON Schema from Zod to eliminate duplication
- Add SerialQueue backpressure bounds

---

## Test Summary

**New test files**: 3
- `tests/unit/cli/channel.test.ts` — 31 tests
- `tests/unit/cli/msg.test.ts` — 13 tests
- `tests/unit/adapters/mcp-adapter.test.ts` — 60 new tests (25 schema + 35 handler)

**Total**: 104 test cases

**Coverage gaps** (should be addressed in resolution):
- `--system-prompt` length boundary (100,000 chars)
- Shorthand flags `-a` and `-w`
- Invalid member name format
- Both per-member and top-level systemPrompt together

---

## Files Changed Summary

**18 files changed**: 2,623 lines added (+), 1 line removed (-)

**Key files**:
- `src/adapters/mcp-adapter.ts` — 7 Zod schemas, 7 MCP tool handlers (+390 lines)
- `src/cli/commands/channel.ts` — new Channel CLI command (+600 lines)
- `src/cli/commands/msg.ts` — new msg CLI command (+150 lines)
- `src/services/channel-manager.ts` — ChannelService implementation (+800 lines)
- `src/implementations/channel-repository.ts` — SQLite data layer
- Tests — 104 new test cases
- Documentation — help text, MCP instructions, CLAUDE.md updates

---

**Next Step**: Developer addresses the 8 blocking issues (3 HIGH + 5 MEDIUM) according to the Action Plan above. Return to code-review for Cycle 2 validation.
