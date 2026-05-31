# Complexity Review Report

**Branch**: feat/183-phase-8--channel-cli--mcp -> main
**Date**: 2026-05-26T17:09

## Issues in Your Changes (BLOCKING)

### HIGH

**Repetitive MCP handler boilerplate (7 occurrences)** -- Confidence: 88%
- `src/adapters/mcp-adapter.ts:4233-4240`, `src/adapters/mcp-adapter.ts:4317-4324`, `src/adapters/mcp-adapter.ts:4357-4364`, `src/adapters/mcp-adapter.ts:4432-4439`, `src/adapters/mcp-adapter.ts:4490-4497`, `src/adapters/mcp-adapter.ts:4539-4546`, `src/adapters/mcp-adapter.ts:4579-4586`
- Problem: All 7 channel MCP handlers repeat identical parse-then-guard-service-then-match boilerplate: (1) Zod safeParse with the same error shape, (2) `if (!this.channelService)` guard with identical JSON error response, (3) `match(result, ...)` with the same error branch structure. This is 10-15 lines of ceremony per handler that obscures the 2-3 lines of actual business logic. The pattern contributes ~80 lines of pure duplication across the 7 handlers.
- Fix: Extract a generic helper that takes the schema, the service method, and a success mapper. For example:
  ```typescript
  private async channelToolCall<T, R>(
    schema: z.ZodType<T>,
    args: unknown,
    handler: (data: T, service: ChannelService) => Promise<Result<R>>,
    formatOk: (value: R) => Record<string, unknown>,
  ): Promise<MCPToolResponse> {
    const parseResult = schema.safeParse(args);
    if (!parseResult.success) {
      return { content: [{ type: 'text', text: `Validation error: ${parseResult.error.message}` }], isError: true };
    }
    if (!this.channelService) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Channel service unavailable' }, null, 2) }], isError: true };
    }
    const result = await handler(parseResult.data, this.channelService);
    return match(result, {
      ok: (v: R) => ({ content: [{ type: 'text', text: JSON.stringify({ success: true, ...formatOk(v) }, null, 2) }] }),
      err: (error: Error) => ({ content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }, null, 2) }], isError: true }),
    });
  }
  ```
  This is consistent with how the codebase handles other tool families and would reduce each handler to ~5 lines. Note: this is a pattern already present in the file for other tool families (the existing handlers also have this boilerplate -- the new code follows the existing pattern faithfully, which is a consistency win, but the 7 new handlers push the total repetition to a level worth addressing).

### MEDIUM

**`parseChannelCreateArgs` function length and cyclomatic complexity** -- `src/cli/commands/channel.ts:74-207`
**Confidence**: 82%
- Problem: The function is 133 lines with cyclomatic complexity ~15 (8 flag branches in the main loop, plus 5 validation branches after the loop). While the linear if-else-if parsing structure is straightforward to read, the function handles both argument parsing AND cross-field validation in a single pass. The function has 7 mutable variables declared at the top and modified inside the loop.
- Fix: Consider splitting into two functions: (1) a raw argument extractor that only handles the for-loop flag parsing, and (2) a validator that takes the extracted raw args and applies cross-field rules (mutual exclusion, single-vs-multi mode dispatch, agent provider validation). This would keep each function under 70 lines and under complexity 10. However, the current structure mirrors the pattern in `src/cli.ts` for `beat run` argument parsing (which is also a long if-else chain), so this is a moderate concern rather than critical.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`mcp-adapter.ts` file length exceeds 4600 lines** -- `src/adapters/mcp-adapter.ts`
**Confidence**: 85%
- Problem: With the addition of 636 lines for 7 channel tool schemas and handlers, `mcp-adapter.ts` has grown to 4615 lines. This exceeds the 500-line "critical" threshold by 9x. The file contains: Zod schemas for every tool, the `MCPAdapter` class with ~30+ handler methods, all tool listing metadata, and constructor/routing logic. Each new tool family (channels, pipelines, loops, schedules, orchestrations) adds ~80-100 lines of schemas + handler code.
- Fix: This is a pre-existing structural issue (the file was already ~3979 lines before this PR). However, this PR meaningfully increases the surface area. A future refactoring could extract each tool family into a separate module (e.g., `src/adapters/mcp-tools/channel-tools.ts`) that exports its schemas, tool metadata, and handler functions. The main `MCPAdapter` class would then compose these modules. This is informational for this PR since the pattern follows the established convention, but the growth trajectory is unsustainable.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`handleChannelCommand` router uses sequential if-return chains** -- `src/cli/commands/channel.ts:249-278`
**Confidence**: 60% (moved to Suggestions)

## Suggestions (Lower Confidence)

- **Sequential if-return router** - `src/cli/commands/channel.ts:249-278` (Confidence: 65%) -- The subcommand router uses 6 sequential if-return blocks. This is idiomatic for the codebase (the same pattern appears in `handleLoopCommand`, `handleOrchestrateCommand`, etc.) and is actually clearer than a map/dispatch-table approach for this small number of commands. Not a real issue.

- **Duplicated channel name regex** - `src/adapters/mcp-adapter.ts:569` (Confidence: 72%) -- The `channelNamePattern` regex is duplicated from `CHANNEL_NAME_REGEX` in `domain.ts`. The inline DECISION comment explains the rationale (MCP layer validates without importing domain constants), so this is intentional. Fragility risk exists if the regex diverges, but the test coverage (both layers validate independently) mitigates this. Applies ADR-001.

- **Long format string in `handleChannelList`** - `src/cli/commands/channel.ts:422` (Confidence: 60%) -- The template literal for channel list output is a single ~160-character line with 6 interpolated expressions. Readable enough given the columnar output intent, but could be split into a helper function if more columns are added later.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Complexity Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The new channel CLI and MCP code follows established codebase patterns consistently. The primary complexity concern is the repetitive boilerplate across 7 MCP handlers, which is a maintainability issue that could be addressed with a shared helper. The `parseChannelCreateArgs` function is at the upper edge of acceptable complexity but mirrors existing patterns. The `mcp-adapter.ts` file length is a pre-existing structural issue that this PR exacerbates but does not cause. Overall, the code is readable, well-documented with ARCHITECTURE/DECISION comments, and uses Result types throughout. Approved with the suggestion to extract the MCP handler boilerplate.
