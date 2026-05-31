# Code Review Summary

**Branch**: feat/183-phase-8-channel-cli-mcp -> main
**Date**: 2026-05-26T17:09:00Z
**Timestamp**: 2026-05-26_1709
**PR**: #195

## Merge Recommendation: CHANGES_REQUESTED

Phase 8 channel CLI and MCP integration introduces solid feature coverage with 52 new tests and proper domain/service/adapter layering. The codebase correctly applies ADR-001 (single-source-of-truth for channel name regex) and avoids PF-004 (three-layer rollback in `createChannel`). However, the PR has **5 blocking issues across 3 categories** that must be resolved before merge:

1. **Silent data loss on MCP `CreateChannel`**: Top-level `systemPrompt` field is accepted by Zod but never applied to the member. CLI handles this correctly; MCP path is broken.
2. **Double database connections**: Several CLI commands (`destroy`, `pause`, `resume`, `msg`) open two separate bootstrap contexts when they could use one.
3. **Validation gaps**: CLI boundary layer lacks input validation for `--limit`, `--system-prompt`, and message length that the MCP layer correctly enforces via Zod.
4. **Inconsistent schema coverage**: MCP `CreateChannel` JSON schema omits `systemPrompt` property (documented in Zod but missing from tool listing).
5. **Incomplete test coverage**: 6 of 7 channel handlers lack service-unavailable tests; 2 handlers missing error propagation tests.

All issues are addressable without architectural changes. The pattern deviations are minor (naming `Destroy` vs `Cancel`, double regex definitions) and well-documented.

---

## Issue Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 5 | 6 | 0 |
| Should Fix | 0 | 0 | 4 | 0 |
| Pre-existing | 0 | 1 | 1 | 1 |

**Total Blocking**: 11 issues across 5 HIGH and 6 MEDIUM severity
**Reviewer Convergence**: 6 reviewers flagged the `systemPrompt` data loss issue (92-95% confidence), indicating high confidence in the finding.

---

## Blocking Issues (Ordered by Severity & Confidence)

### HIGH SEVERITY

**1. MCP CreateChannel silently drops top-level systemPrompt field** (Confidence: 93% — 4 reviewers)
- **Files**: `src/adapters/mcp-adapter.ts:603-607, 4270-4281`
- **Reviewers**: architecture, regression, consistency, typescript
- **Problem**: The `CreateChannelSchema` Zod schema defines an optional top-level `systemPrompt` field with description "System prompt for single-member channels (overrides per-member systemPrompt)". However, `handleCreateChannel()` constructs the `ChannelCreateRequest` without including `data.systemPrompt`. Zod validates the field, it passes without error, and then is silently discarded. MCP callers believe the prompt was applied to the single member when it was not. The CLI correctly handles this scenario in single mode (lines 340-343 of channel.ts).
- **Impact**: Data loss at MCP boundary. Users cannot set system prompts for single-member channels via MCP, even though the documented field appears to support it.
- **Fix**: Deduplicate with MCP JSON schema decision — either (a) remove the top-level `systemPrompt` from `CreateChannelSchema` since per-member `systemPrompt` already covers the use case, or (b) map it to the single member when `members.length === 1`:
```typescript
systemPrompt: m.systemPrompt ?? (data.members.length === 1 ? data.systemPrompt : undefined),
```

---

**2. MCP JSON schema missing systemPrompt property for CreateChannel tool** (Confidence: 95% — 2 reviewers)
- **Files**: `src/adapters/mcp-adapter.ts:1889-1940, 603`
- **Reviewers**: consistency, regression
- **Problem**: The Zod validation schema `CreateChannelSchema` (line 603) includes a top-level `systemPrompt` field, but the JSON schema exposed in the tool listing (lines 1889-1940) omits it entirely. MCP clients see the tool definition without `systemPrompt` and cannot discover or auto-complete this parameter. This compounds issue #1 — even if the handler were fixed, clients would not know the field exists.
- **Impact**: MCP API discoverability broken. Schema/implementation mismatch violates API contract.
- **Fix**: Add the missing `systemPrompt` property to the `CreateChannel` JSON schema:
```typescript
systemPrompt: {
  type: 'string',
  description: 'System prompt for single-member channels (max 100KB)',
  maxLength: 100000,
},
```

---

**3. Duplicated channel name regex between MCP adapter and domain layer** (Confidence: 92% — 2 reviewers)
- **Files**: `src/adapters/mcp-adapter.ts:569`, `src/core/domain.ts:1054`
- **Reviewers**: architecture, consistency
- **Problem**: `channelNamePattern` at line 569 duplicates `CHANNEL_NAME_REGEX` from domain.ts. The inline DECISION comment states this is intentional ("so the MCP layer validates without importing domain constants"), but this violates DIP and creates drift risk. The domain already exports this constant and the MCP adapter already imports from domain.ts (ChannelId, ChannelStatus, CommunicationMode). There is no technical reason to avoid importing the regex. If the regex changes in domain.ts (e.g., expanding allowed characters), the MCP adapter's copy silently diverges, causing validation inconsistency between CLI and MCP entry points.
- **Confidence**: 92% (2 reviewers) — This violates ADR-001's single-source-of-truth principle.
- **Impact**: Drift risk. Future maintainers may not realize both copies must stay synchronized.
- **Fix**: Import `CHANNEL_NAME_REGEX` from domain.ts and use it in the Zod schema:
```typescript
import { CHANNEL_NAME_REGEX } from '../core/domain.js';
// Remove: const channelNamePattern = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;
// Use directly:
name: z.string().regex(CHANNEL_NAME_REGEX, '...')
```

---

**4. Sequential bootstrap: channelService resolved eagerly on every CLI command** (Confidence: 85% — 1 reviewer)
- **Files**: `src/cli/services.ts:107`
- **Reviewer**: performance
- **Problem**: `withServices()` now awaits `container.resolve<ChannelService>('channelService')` on every CLI invocation, including commands that never use channels (e.g., `beat run`, `beat schedule create`, `beat loop`). `ChannelManager.create()` is async and involves event subscription and repository resolution. This adds measurable latency to the bootstrap path of all CLI commands.
- **Impact**: Performance regression. Every CLI command pays the channelService initialization cost even when channels are not used.
- **Fix**: Resolve `channelService` lazily — only when a channel command actually needs it:
```typescript
// In withServices(), remove eager channelService resolution.
// Expose a lazy resolver instead:
return {
  container,
  // ... other services
  resolveChannelService: async () => {
    const result = await container.resolve<ChannelService>('channelService');
    return result.ok ? result.value : undefined;
  },
};
```

---

**5. Async mcpAdapter factory adds unnecessary await on hot path** (Confidence: 82% — 1 reviewer)
- **Files**: `src/bootstrap.ts:714`
- **Reviewer**: performance
- **Problem**: The `mcpAdapter` registration was changed from a synchronous factory to an async factory because `channelService` requires `container.resolve()` (async). This means every `container.resolve('mcpAdapter')` now requires an `await`, even though the MCP adapter was previously synchronously constructable. On the MCP server hot path (every tool call), this adds an unnecessary async hop. The `ChannelManager.create()` call inside the factory also subscribes to events — this work is done every time the singleton is first resolved.
- **Impact**: Performance regression on MCP hot path. Unnecessary async.
- **Fix**: Pre-resolve channelService outside the mcpAdapter factory and pass it as a captured value:
```typescript
// Resolve channelService once before mcpAdapter registration
let channelService: ChannelService | undefined;
const csResult = await container.resolve<ChannelService>('channelService');
if (csResult.ok) channelService = csResult.value;

container.registerSingleton('mcpAdapter', () => {
  // synchronous factory again
  return new MCPAdapter({ ..., channelService });
});
```

---

### MEDIUM SEVERITY

**6. CLI channel list --limit accepts unbounded integer** (Confidence: 90% — 2 reviewers)
- **Files**: `src/cli/commands/channel.ts:387`
- **Reviewers**: security, reliability
- **Problem**: The `--limit` flag is parsed via `parseInt(next, 10)` but never validated for range. A user can pass `--limit 999999999` or `--limit -1` or `--limit NaN`. The MCP schema properly constrains `limit` to 1-100 via Zod, but the CLI path bypasses validation. Also, `parseInt('abc', 10)` returns `NaN` which is passed directly to `channelRepository.findAll(NaN)`. This is an inconsistency between MCP (validated) and CLI (unvalidated) entry points.
- **Fix**: Add bounds validation matching MCP schema:
```typescript
const parsed = parseInt(next, 10);
if (isNaN(parsed) || parsed < 1 || parsed > 100) {
  ui.error('--limit must be an integer between 1 and 100');
  process.exit(1);
}
```

---

**7. CLI msg command has no message length limit** (Confidence: 85% — 1 reviewer)
- **Files**: `src/cli/commands/msg.ts:50`
- **Reviewer**: security
- **Problem**: The `parseMsgArgs` function joins all remaining args into a message string with no upper bound. The MCP `SendChannelMessageSchema` properly limits messages to 262,144 characters (256KB), but the CLI path has no equivalent guard. An extremely large message could cause memory pressure.
- **Fix**: Add a length check:
```typescript
const message = messageWords.join(' ');
if (message.length > 262_144) {
  return err('Message too long. Maximum length is 256KB (262,144 characters).');
}
```

---

**8. CLI --system-prompt flag has no length limit** (Confidence: 82% — 1 reviewer)
- **Files**: `src/cli/commands/channel.ts:121`
- **Reviewer**: security
- **Problem**: The `--system-prompt` flag for `beat channel create` accepts an arbitrary-length string. The MCP `CreateChannelSchema` limits `systemPrompt` to 100,000 characters, but the CLI has no guard. This is an inconsistency between entry points.
- **Fix**: Add a length check:
```typescript
if (next.length > 100_000) {
  return err('--system-prompt exceeds maximum length of 100,000 characters');
}
```

---

**9. Double database connections in CLI destroy/pause/resume commands** (Confidence: 85% — 1 reviewer)
- **Files**: `src/cli/commands/channel.ts:300-312, 500-509, 529+537, 555+564`
- **Reviewer**: reliability
- **Problem**: `handleChannelDestroy`, `handleChannelPause`, and `handleChannelResume` each call `withServices(s)` (full bootstrap) and then call `resolveChannelIdOrExit(idOrName)` which internally opens `withReadOnlyContext()`. This creates two separate database connections for a single CLI command. The same issue affects the `msg` command (see issue #10).
- **Fix**: Resolve channel ID using the context from `withServices` (which already has access to channelRepository via its container):
```typescript
const { channelService, container } = await withServices(s);
const channelRepo = getFromContainer<ChannelRepository>(container, 'channelRepository');
const channelId = await resolveChannelId(idOrName, channelRepo);
```

---

**10. Double database connections in msg command + TOCTOU paused-channel check** (Confidence: 88% — 1 reviewer)
- **Files**: `src/cli/commands/msg.ts:91-124`
- **Reviewer**: performance (counted as reliability issue)
- **Problem**: `handleMsgCommand` opens `withReadOnlyContext()` to resolve channel name and check status (lines 92-120), closes it, then opens `withServices()` for the full bootstrap (line 124). This is two database opens for one command. Additionally, the paused-channel check at line 132 is performed against a stale read-only snapshot. The service-level check uses an in-memory `pausedChannels` Set that is empty in CLI mode (fresh bootstrap with no recovery), so the CLI-side check will fail-fast but the service would succeed, creating inconsistent behavior.
- **Fix**: Resolve channel name inside `withServices()` path and remove client-side paused check:
```typescript
const { channelService, container } = await withServices(s);
if (!channelService) { /* error */ }
const channelRepo = getFromContainer<ChannelRepository>(container, 'channelRepository');
const channelResult = await channelRepo.findByName(channelName);
// ... status checks only (let service enforce paused state)
```

---

**11. Missing service-unavailable tests for 6 of 7 channel MCP handlers** (Confidence: 90% — 1 reviewer)
- **Files**: `tests/unit/adapters/mcp-adapter.test.ts:3996-4075`
- **Reviewer**: testing
- **Problem**: Only `CreateChannel` handler (line 4042) tests the `channelService === undefined` guard path. The implementation guards in all 7 handlers (`handleDestroyChannel`, `handleChannelStatus`, `handleListChannels`, `handleSendChannelMessage`, `handlePauseChannel`, `handleResumeChannel`) but the tests omit this coverage. This violates the project pattern: orchestration tools (seen at lines 2719-2895) test service unavailability for every handler that guards against it.
- **Fix**: Add a test to each of the 6 remaining handler `describe` blocks:
```typescript
it('returns service unavailable when channelService is undefined', async () => {
  const adapterNoChannel = makeChannelAdapter(undefined);
  const result = await adapterNoChannel.callTool('DestroyChannel', { channelId: 'ch-abc' });
  expect(result.isError).toBe(true);
  const response = JSON.parse(result.content[0].text);
  expect(response.error).toContain('unavailable');
});
```

---

## Suggestions (Lower Confidence)

### Testing Gaps (MEDIUM — affects behavior but not critical)

**12. No handler-level validation error path tests for 6 of 7 channel tools** (Confidence: 85% — 1 reviewer)
- **Files**: `tests/unit/adapters/mcp-adapter.test.ts:4075`
- **Problem**: The MCP adapter `callTool` path for each handler includes Zod `safeParse` validation that returns `"Validation error: ..."` on parse failure. This is tested for `CreateChannel` but not for the other 6 handlers. The schema tests validate Zod in isolation but not through the adapter's `callTool` dispatch and error formatting.
- **Fix**: Add at least one validation error test per handler:
```typescript
it('returns validation error on invalid input', async () => {
  const result = await adapter.callTool('DestroyChannel', { channelId: '' });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('Validation error');
});
```

**13. ChannelStatus and ListChannels handlers lack error propagation tests** (Confidence: 82% — 1 reviewer)
- **Files**: `tests/unit/adapters/mcp-adapter.test.ts:4095, 4115`
- **Problem**: Both handlers test success and "not found" paths but not the `err(...)` result from the service call. DestroyChannel and SendChannelMessage both include this test.
- **Fix**: Add error propagation tests for both handlers.

**14. CLI channel tests use type assertions instead of discriminated union narrowing** (Confidence: 82% — 1 reviewer)
- **Files**: `tests/unit/cli/channel.test.ts:22`
- **Problem**: Tests cast `result.value` to inline type shapes like `(result.value as { agent: string }).agent` instead of using discriminated union narrowing. The `ParsedChannelCreate` type is a discriminated union on `mode: 'single' | 'multi'`.
- **Fix**: Use narrowing after `result.ok` guard:
```typescript
if (!result.ok) return;
const val = result.value;
expect(val.mode).toBe('single');
if (val.mode !== 'single') return; // narrows type
expect(val.agent).toBe('claude');  // type-safe
```

---

### Pattern Consistency Issues (MEDIUM)

**15. DestroyChannel naming deviates from established Cancel* pattern** (Confidence: 82% — 1 reviewer)
- **Files**: `src/adapters/mcp-adapter.ts:783`, `src/cli/commands/channel.ts`
- **Problem**: All other MCP lifecycle-ending operations use `Cancel` prefix: `CancelTask`, `CancelSchedule`, `CancelLoop`, `CancelOrchestrator`, `CancelPipeline`. Channels use `DestroyChannel` instead. The CLI also uses `beat channel destroy` vs. `beat loop cancel`. While "destroy" may be semantically accurate (channels kill tmux sessions), the inconsistency creates a steeper learning curve for users.
- **Fix**: Either rename to `CancelChannel` for consistency, or add JSDoc explaining why channels use a different verb.

**16. Repetitive MCP handler boilerplate across 7 channel handlers** (Confidence: 88% — 1 reviewer)
- **Files**: `src/adapters/mcp-adapter.ts:4233-4594` (7 occurrences)
- **Problem**: All 7 channel handlers repeat identical parse-then-guard-service-then-match boilerplate (~10-15 lines per handler). The pattern exists elsewhere in the file but the 7 handlers push the total to a level worth addressing. The existing orchestration tools use the same pattern, so this is consistency win but with a maintainability cost as the count grows.
- **Fix**: Extract a generic helper:
```typescript
private async channelToolCall<T, R>(
  schema: z.ZodType<T>,
  args: unknown,
  handler: (data: T, service: ChannelService) => Promise<Result<R>>,
  formatOk: (value: R) => Record<string, unknown>,
): Promise<MCPToolResponse> {
  // ... unified boilerplate
}
```

---

### Pre-existing Issues (Not Blocking)

**17. Fast-uri HIGH severity vulnerability in transitive dependencies** (Confidence: 95%)
- **Files**: `package-lock.json`
- **Problem**: `fast-uri` has two HIGH-severity advisories (path traversal, host confusion). This is pre-existing and not introduced by this PR.
- **Action**: Track in separate maintenance PR with `npm audit fix`.

---

## Convergence Status

| Issue | Reviewers Flagging | Confidence | Category |
|-------|-------------------|-----------|----------|
| systemPrompt data loss | architecture, regression, consistency, typescript | 93% | HIGH blocking |
| systemPrompt JSON schema gap | consistency, regression | 95% | HIGH blocking |
| Duplicated regex (drift risk) | architecture, consistency | 92% | HIGH blocking |
| Eager channelService bootstrap | performance | 85% | HIGH blocking |
| Async mcpAdapter factory | performance | 82% | HIGH blocking |
| --limit validation missing | security, reliability | 90% | MEDIUM blocking |
| msg length validation missing | security | 85% | MEDIUM blocking |
| --system-prompt validation missing | security | 82% | MEDIUM blocking |
| Double DB connections | reliability, performance (issue #9/#10) | 85-88% | MEDIUM blocking |
| Service-unavailable test gaps | testing | 90% | MEDIUM blocking |

**Key Insight**: The `systemPrompt` data loss issue was flagged independently by 4 different reviewers (architecture, regression, consistency, typescript) with 93% average confidence, indicating high signal. The performance issues (eager bootstrap + async factory) came from the same reviewer but represent a real regression on the hot path.

---

## Action Plan

**Priority 1 (Fix first):**
1. Remove or map top-level `systemPrompt` in `CreateChannelSchema` (issues #1 + #2)
2. Import `CHANNEL_NAME_REGEX` from domain (issue #3)
3. Add input validation guards for CLI boundary (issues #6-8)

**Priority 2 (Performance):**
4. Lazy-resolve `channelService` instead of eager (issue #4)
5. Pre-resolve channelService outside mcpAdapter factory (issue #5)
6. Consolidate double-bootstrap in CLI commands (issues #9-10)

**Priority 3 (Test coverage):**
7. Add service-unavailable tests to all 7 handlers (issue #11)
8. Add handler-level validation error tests (issue #12)
9. Add error propagation tests (issue #13)
10. Fix type assertions in CLI tests (issue #14)

**Priority 4 (Naming/Pattern consistency):**
11. Document or rename `DestroyChannel` (issue #15)
12. Extract MCP handler boilerplate helper (issue #16)

---

## Scores by Reviewer

| Reviewer | Score | Recommendation |
|----------|-------|-----------------|
| Architecture | 7/10 | CHANGES_REQUESTED |
| Complexity | 7/10 | APPROVED_WITH_CONDITIONS |
| Consistency | 7/10 | CHANGES_REQUESTED |
| Dependencies | 9/10 | APPROVED |
| Performance | 7/10 | CHANGES_REQUESTED |
| React | 10/10 | APPROVED |
| Regression | 8/10 | CHANGES_REQUESTED |
| Reliability | 7/10 | CHANGES_REQUESTED |
| Security | 8/10 | APPROVED_WITH_CONDITIONS |
| Testing | 7/10 | CHANGES_REQUESTED |
| TypeScript | 8/10 | APPROVED_WITH_CONDITIONS |

**Summary**: 6 reviewers recommend CHANGES_REQUESTED, 3 recommend APPROVED_WITH_CONDITIONS, 1 recommends APPROVED, 0 recommend BLOCK MERGE.

---

## Quality Assessment

**Strengths:**
- Proper domain/service/adapter layering with Result types throughout
- Test coverage is comprehensive (52 tests across parsers, schemas, handlers)
- ADR-001 correctly applied (channel name validation constrained to tmux SESSION_NAME_REGEX)
- PF-004 avoidance: three-layer rollback in `createChannel` covers DB, tmux sessions, and in-memory state
- Pure parsing functions exported for testability
- No arbitrary type assertions (all are boundary casts post-Zod validation)
- Import hygiene: proper `import type` usage across all new files

**Weaknesses:**
- Silent data loss path (systemPrompt field) at MCP boundary
- Performance regression on CLI bootstrap and MCP hot path
- Validation inconsistency between MCP (Zod-enforced) and CLI (no guards)
- Incomplete test coverage for guard paths and error cases
- Pattern deviations documented but unresolved (naming, double regex)

**Overall**: Feature-complete with solid architecture, but boundary layer has gaps (validation, data handling) that undermine confidence in production readiness. Issues are all addressable with targeted fixes in Priority 1-3.
