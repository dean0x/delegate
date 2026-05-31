# Testing Review Report

**Branch**: feat-183-phase-8--channel-cli--mcp -> main
**Date**: 2026-05-26T17:09:00Z

## Issues in Your Changes (BLOCKING)

### HIGH

**Missing service-unavailable tests for 6 of 7 channel handlers** - `tests/unit/adapters/mcp-adapter.test.ts:3996`
**Confidence**: 90%
- Problem: Only `CreateChannel` (line 4042) tests the `channelService === undefined` guard path. The implementation guards against undefined `channelService` in all 7 handlers (`handleCreateChannel`, `handleDestroyChannel`, `handleChannelStatus`, `handleListChannels`, `handleSendChannelMessage`, `handlePauseChannel`, `handleResumeChannel`), but `DestroyChannel`, `ChannelStatus`, `ListChannels`, `SendChannelMessage`, `PauseChannel`, and `ResumeChannel` handler tests do not exercise this branch. The existing project pattern (see orchestration tools around lines 2719-2895) tests service unavailability for every handler that guards against it.
- Fix: Add a `'returns service unavailable when channelService is undefined'` test to each of the 6 remaining handler `describe` blocks, following the existing CreateChannel test pattern:
```typescript
it('returns service unavailable when channelService is undefined', async () => {
  const adapterNoChannel = makeChannelAdapter(undefined);
  const result = await adapterNoChannel.callTool('DestroyChannel', { channelId: 'ch-abc' });
  expect(result.isError).toBe(true);
  const response = JSON.parse(result.content[0].text);
  expect(response.error).toContain('unavailable');
});
```
Applies ADR-003 (pre-existing gaps tracked separately), but this is NEW code in this PR, not pre-existing.

### MEDIUM

**No tests for handler-level validation error paths on non-Create channel tools** - `tests/unit/adapters/mcp-adapter.test.ts:4075`
**Confidence**: 85%
- Problem: The MCP adapter `callTool` path for each channel handler includes Zod `safeParse` validation that returns `"Validation error: ..."` on parse failure. This is tested for `CreateChannel` (line 4033: `'returns validation error on invalid name'`), but the other 6 handler `describe` blocks (DestroyChannel, ChannelStatus, ListChannels, SendChannelMessage, PauseChannel, ResumeChannel) do not test the `callTool` → Zod validation error path through the adapter. The Zod schema tests in `'MCPAdapter - Channel Schemas'` verify schemas in isolation but not through the adapter's `callTool` dispatch. This is a gap because the schema tests validate Zod behavior, not the adapter's error formatting and `isError: true` response construction.
- Fix: Add at least one validation error test per handler `describe` that exercises `callTool` with invalid input and asserts the `Validation error` response, e.g.:
```typescript
it('returns validation error on invalid input', async () => {
  const result = await adapter.callTool('DestroyChannel', { channelId: '' });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('Validation error');
});
```

**CLI channel tests use type assertions instead of discriminated union narrowing** - `tests/unit/cli/channel.test.ts:22`
**Confidence**: 82%
- Problem: Multiple tests cast `result.value` to inline type shapes like `(result.value as { agent: string }).agent` (line 22), `result.value as { mode: string; topic?: string; ... }` (line 39), `result.value as { members: Array<...> }` (line 93). The `ParsedChannelCreate` type is a discriminated union on `mode: 'single' | 'multi'`. Using `as` casts bypasses the type system and could mask type errors in the return value. The test file has 10+ occurrences of this pattern.
- Fix: Use discriminated union narrowing after the `result.ok` guard:
```typescript
if (!result.ok) return;
const val = result.value;
expect(val.mode).toBe('single');
if (val.mode !== 'single') return; // narrows to ParsedChannelCreateSingle
expect(val.agent).toBe('claude');  // type-safe, no cast
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**ChannelStatus handler test does not verify service error propagation** - `tests/unit/adapters/mcp-adapter.test.ts:4095`
**Confidence**: 82%
- Problem: The `ChannelStatus` handler test block has `'returns channel details on success'` and `'returns error when channel not found'` (the `ok(null)` path), but does not test the `err(...)` result path from `this.channelService.getChannel()` (implementation line 4422-4425). Both `DestroyChannel` and `SendChannelMessage` blocks do include service error propagation tests.
- Fix: Add a test for the `getChannel` error path:
```typescript
it('returns error on service failure', async () => {
  mockChannelService.setGetResult(err(new Error('DB timeout')));
  const result = await adapter.callTool('ChannelStatus', { channelId: 'ch-abc' });
  expect(result.isError).toBe(true);
});
```

**ListChannels handler tests do not verify service error propagation** - `tests/unit/adapters/mcp-adapter.test.ts:4115`
**Confidence**: 82%
- Problem: The `ListChannels` describe block tests success (empty list), status filter passthrough, and limit passthrough, but does not test the `err(...)` result path from `this.channelService.listChannels()`.
- Fix: Add:
```typescript
it('returns error on service failure', async () => {
  mockChannelService.setListResult(err(new Error('DB read failure')));
  const result = await adapter.callTool('ListChannels', {});
  expect(result.isError).toBe(true);
});
```

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Missing boundary test for 64-char channel name limit** - `tests/unit/cli/channel.test.ts:238` (Confidence: 72%) -- The `channel name validation` section tests various invalid names but does not test the exact boundary: a 64-character valid name (should pass) and a 65-character name (should fail). The regex `{0,62}` in `CHANNEL_NAME_REGEX` makes this worth verifying explicitly.

- **msg.test.ts does not test member name validation** - `tests/unit/cli/msg.test.ts:40` (Confidence: 65%) -- The `parseMsgArgs` function validates the channel name against `CHANNEL_NAME_REGEX` but does not validate the member name. If member name validation is intentionally deferred to the service layer, this is fine; if it should be validated at parse time, the gap should be documented.

- **Schema tests and handler tests could be consolidated** - `tests/unit/adapters/mcp-adapter.test.ts:3851` (Confidence: 62%) -- The `MCPAdapter - Channel Schemas` section (10 tests) and `MCPAdapter - Channel Handlers` section (22 tests) could share test data via factory functions to reduce duplication between schema-level and handler-level validation tests.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Testing Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The test suite covers 52 new tests with good structure — pure function testing for CLI parsers and Zod schema validation for MCP tools. Tests follow AAA pattern, use Result types correctly, and the MockChannelService is well-designed with setter methods for configurable results. The main gaps are: (1) inconsistent service-unavailable guard coverage across channel handlers (only 1 of 7 tested vs the project pattern of testing all), (2) missing handler-level validation error path tests for 6 of 7 tools, and (3) missing error propagation tests for ChannelStatus and ListChannels. The type assertion pattern in CLI tests is a moderate concern that bypasses TypeScript's discriminated union safety.
