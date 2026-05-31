# Testing Review Report

**Branch**: feat/183-phase-8--channel-cli--mcp -> main
**Date**: 2026-05-26

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Missing error path coverage for `--system-prompt` length limit in CLI parser** - `tests/unit/cli/channel.test.ts`
**Confidence**: 85%
- Problem: `parseChannelCreateArgs` at `src/cli/commands/channel.ts:121` enforces a 100,000-character limit on `--system-prompt`, but no test verifies the rejection. The happy path (`--system-prompt 'You are a helpful assistant'`) is tested but the boundary/error path is not. This is a boundary validation on user input — the same class of boundary that `parseMsgArgs` correctly tests at 262,144 chars (`msg.test.ts:87-100`).
- Fix: Add two tests — one at the limit (100,000 chars) and one above it:
```typescript
it('rejects --system-prompt exceeding 100000 chars', () => {
  const longPrompt = 'a'.repeat(100_001);
  const result = parseChannelCreateArgs(['my-channel', '--agent', 'claude', '--system-prompt', longPrompt]);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toContain('100,000');
});

it('accepts --system-prompt at exactly 100000 chars', () => {
  const maxPrompt = 'a'.repeat(100_000);
  const result = parseChannelCreateArgs(['my-channel', '--agent', 'claude', '--system-prompt', maxPrompt]);
  expect(result.ok).toBe(true);
});
```

**No test for invalid `--working-directory` path in CLI parser** - `tests/unit/cli/channel.test.ts`
**Confidence**: 82%
- Problem: `parseChannelCreateArgs` at `src/cli/commands/channel.ts:114-118` validates the working directory via `validatePath()` and returns an error result on failure. The MCP adapter test (`mcp-adapter.test.ts:4053-4061`) tests the equivalent rejection for relative paths, but the CLI parser's own validation path is untested. Since the CLI parser delegates to `validatePath` (which resolves relative paths rather than rejecting them outright), the actual error path depends on whether the resolved directory exists — the test gap is for the case where `validatePath` returns an err.
- Fix: Add a test with a non-existent base directory path:
```typescript
it('rejects invalid working directory', () => {
  const result = parseChannelCreateArgs([
    'my-channel', '--agent', 'claude',
    '--working-directory', '/nonexistent/path/that/should/not/exist',
  ]);
  // validatePath with mustExist=false still resolves; this depends on validatePath behavior
  // The real edge case is testing with a path that validatePath rejects
});
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Missing shorthand flag tests (`-a` and `-w`)** - `tests/unit/cli/channel.test.ts`
**Confidence**: 80%
- Problem: `parseChannelCreateArgs` accepts `-a` as a shorthand for `--agent` (line 89) and `-w` as a shorthand for `--working-directory` (line 113), but no test exercises these shorthands. All 31 tests use the long-form flags exclusively. If the shorthand aliases are accidentally removed or the argument index math changes, no test would catch it.
- Fix: Add at least one test per shorthand:
```typescript
it('accepts -a shorthand for --agent', () => {
  const result = parseChannelCreateArgs(['my-channel', '-a', 'claude']);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  if (result.value.mode !== 'single') return;
  expect(result.value.agent).toBe('claude');
});

it('accepts -w shorthand for --working-directory', () => {
  const result = parseChannelCreateArgs(['my-channel', '--agent', 'claude', '-w', cwd]);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.workingDirectory).toBe(cwd);
});
```

## Pre-existing Issues (Not Blocking)

No CRITICAL pre-existing testing issues found.

## Suggestions (Lower Confidence)

- **No test for multi-slash in member target** - `tests/unit/cli/msg.test.ts` (Confidence: 65%) — The `parseMsgArgs` function splits on the first `/` only (`msg.ts:61`), but no test confirms what happens with a target like `channel/member/extra`. The comment at `msg.test.ts:42` mentions "member name may contain slashes in theory" but the test only uses `ch/member` (single slash). A test with `ch/mem/ber msg` would verify the "first-slash-only" contract more rigorously.

- **MCP adapter channel schema tests only validate Zod parse, not JSON Schema parity** - `tests/unit/adapters/mcp-adapter.test.ts` (Confidence: 62%) — The schema tests at lines 3851-3993 validate the Zod schemas exported for internal use, but the MCP tool definitions (lines 1886-2032) use a separate hand-written JSON Schema. There is no test asserting parity between the Zod schema and the JSON Schema declared in `listTools()`. If a constraint is updated in one but not the other, they could silently diverge.

- **No test for `CreateChannel` with both per-member and top-level `systemPrompt`** - `tests/unit/adapters/mcp-adapter.test.ts` (Confidence: 68%) — The MCP handler at `mcp-adapter.ts:4282` has logic to apply the top-level `systemPrompt` to a single-member channel, falling back to per-member value. No test exercises the precedence when both `m.systemPrompt` and `data.systemPrompt` are provided simultaneously for a single-member channel.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Testing Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Assessment

The new test suite is well-structured and follows established project patterns (applies ADR-001 for channel name validation consistency). Key strengths:

1. **Behavior-focused**: Tests assert on observable output (Result ok/err, parsed values), not internal implementation details.
2. **Proper AAA structure**: Each test has clear arrange-act-assert flow.
3. **Consistent with codebase**: Uses the same `if (!result.ok) return;` type-narrowing guard pattern found in `orchestrate.test.ts` and `orchestrate-init.test.ts` (16 and 13 instances respectively).
4. **Good boundary coverage**: Message length limit at 262,144 chars is tested at exact boundary and beyond (`msg.test.ts:87-100`). MaxRounds boundaries (0, 10001) are covered.
5. **Error propagation**: MCP adapter tests verify service errors propagate correctly, service-unavailable guard works, and validation errors are surfaced — all three error categories per handler.
6. **Mock quality**: `MockChannelService` implements the full `ChannelService` interface with configurable results and call recording, following the Fake pattern appropriately.

The two blocking MEDIUM issues are straightforward boundary tests for `--system-prompt` length and `-a`/`-w` shorthands. The 3 suggestions are lower-confidence items that would improve coverage completeness but are not regressions.

Total new tests: 31 (channel.test.ts) + 13 (msg.test.ts) + 60 (mcp-adapter.test.ts) = 104 individual `it()` blocks across the three files (25 schema + 35 handler in the MCP adapter file).
