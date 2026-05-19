# Complexity Review Report

**Branch**: feat/api-translation-proxy -> main
**Date**: 2026-04-27T11:15

## Issues in Your Changes (BLOCKING)

### HIGH

**`handleConfigureAgent` exceeds function length threshold (220+ lines)** - `src/adapters/mcp-adapter.ts:3326`
**Confidence**: 88%
- Problem: The `handleConfigureAgent` method spans ~220 lines across three `case` branches (`check`, `set`, `reset`). The `set` branch alone is ~140 lines with 6+ decision points (null checks for each config key, error aggregation, probe logic, warning generation). This is a single function with cyclomatic complexity estimated at 15+, making it hard to reason about or extend when new config keys are added.
- Fix: Extract each switch case into a dedicated private method (`handleConfigureAgentCheck`, `handleConfigureAgentSet`, `handleConfigureAgentReset`). The `set` case could further extract a `collectWriteAttempts` helper and a `computePostWriteWarnings` helper to keep each function under 30 lines.

```typescript
// Sketch — extract case branches as methods
private async handleConfigureAgent(args: unknown): Promise<MCPToolResponse> {
  const parseResult = ConfigureAgentSchema.safeParse(args);
  if (!parseResult.success) { /* ... validation error ... */ }
  const { agent, action, apiKey, baseUrl, model, translate } = parseResult.data;
  switch (action) {
    case 'check': return this.handleConfigureAgentCheck(agent);
    case 'set':   return this.handleConfigureAgentSet(agent, { apiKey, baseUrl, model, translate });
    case 'reset': return this.handleConfigureAgentReset(agent);
  }
}
```

### MEDIUM

**`messageForError` uses 6 sequential if-chains instead of a lookup** - `src/utils/url-probe.ts:121-151`
**Confidence**: 82%
- Problem: `messageForError` has cyclomatic complexity ~8 with a long chain of `if`/`if`/`if` blocks testing `error.code`. The TLS error condition alone is a 7-operand disjunction (lines 137-144). This is functional but harder to scan than a dispatch table, and each new error code extends the chain linearly.
- Fix: Extract the TLS code list into a named constant (`TLS_ERROR_CODES`) and consider using a `Map<string, (url: URL) => string>` lookup for the simple 1:1 code-to-message mappings. The TLS group check can remain as a separate predicate since it uses `startsWith`.

```typescript
const TLS_ERROR_CODES = new Set([
  'CERT_HAS_EXPIRED', 'CERT_INVALID',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT',
]);

function isTlsError(code: string): boolean {
  return TLS_ERROR_CODES.has(code) || code.startsWith('ERR_TLS') || code.startsWith('ERR_SSL');
}
```

**`messageForStatus` and `severityForStatus` duplicate status code dispatch** - `src/utils/url-probe.ts:153-200`
**Confidence**: 80%
- Problem: Both `messageForStatus` (lines 153-188) and `severityForStatus` (lines 190-200) independently dispatch on the same set of HTTP status codes (200-299, 301/302, 401, 403, 404, 405, 429, 500-599). If a new status code is handled in one function but not the other, the severity and message will be out of sync. This is a classic "shotgun surgery" smell -- adding a new case requires editing two functions in lockstep.
- Fix: Combine into a single function that returns `{ message: string; severity: 'ok' | 'warning' | 'error' }`, or define a status descriptor table:

```typescript
interface StatusDescriptor { severity: 'ok' | 'warning' | 'error'; message: string }
function describeStatus(statusCode: number, headers: http.IncomingHttpHeaders, url: URL, isDeepProbe: boolean): StatusDescriptor {
  // Single dispatch point for all status codes
}
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`OpenAIStreamParser` manages 8 mutable state fields** - `src/translation/codecs/openai-codec.ts:204-216`
**Confidence**: 82%
- Problem: The class has 8 private mutable fields: `hasEmittedMessageStart`, `hasActiveTextBlock`, `hasActiveThinkingBlock`, `currentContentIndex`, `activeToolCalls`, `savedId`, `savedModel`, `lastActiveToolIndex`, plus 2 Maps (`openaiToCanonicalIndex`, `pendingToolCalls`). The thinking block lifecycle (newly added: `hasActiveThinkingBlock`, `closeActiveThinkingBlock`) follows the exact same pattern as `hasActiveTextBlock`/`closeActiveTextBlock`. This growing state surface makes it easy to miss closing one block type before opening another.
- Fix: Consider unifying the active-block tracking into a single state variable (e.g. `activeBlockType: 'text' | 'thinking' | null`) with a single `closeActiveBlock()` method, since only one content block can be active at a time (text and thinking are mutually exclusive in the stream protocol). This would prevent the class from growing a new boolean + close method for each future block type.

```typescript
private activeBlockType: 'text' | 'thinking' | null = null;

private closeActiveBlock(): CanonicalStreamEvent[] {
  if (!this.activeBlockType) return [];
  const stopType = this.activeBlockType === 'text' ? 'content_stop' : 'thinking_stop';
  const events: CanonicalStreamEvent[] = [{ type: stopType, index: this.currentContentIndex }];
  this.currentContentIndex++;
  this.activeBlockType = null;
  return events;
}
```

## Pre-existing Issues (Not Blocking)

### HIGH

**`mcp-adapter.ts` is 3,558 lines -- far above critical threshold** - `src/adapters/mcp-adapter.ts`
**Confidence**: 95%
- Problem: At 3,558 lines, this file is over 7x the critical threshold (500 lines). It houses tool schemas, routing dispatch, and handler implementations for 26+ MCP tools in a single class. Each new tool (like the probe additions) increases the cognitive load of the entire file.
- Fix: This is a pre-existing structural issue. Consider extracting tool handlers into separate modules (e.g. `src/adapters/handlers/configure-agent.ts`) that are imported by the adapter. This is not blocking for this PR but should be tracked as tech debt.

### MEDIUM

**`bootstrap.ts` is 662 lines with a single 490-line function** - `src/bootstrap.ts:172-662`
**Confidence**: 90%
- Problem: The `bootstrap()` function is ~490 lines. It registers 15+ services, performs validation, starts the proxy, wires event handlers, runs recovery, and starts the schedule executor -- all in one imperative block. The changes in this PR (database eager init, proxy error handling) add to the already-long function.
- Fix: Pre-existing. Consider splitting into phases: `registerRepositories(container)`, `registerServices(container)`, `startProxy(container, config)`, `wireHandlers(container)`, etc.

## Suggestions (Lower Confidence)

- **`processChunk` decision depth** - `src/translation/codecs/openai-codec.ts:217-303` (Confidence: 72%) -- The method has 5 sequential content-type checks (usage, choices, reasoning, text, tool_calls) with early returns. At 85 lines it is approaching the warning threshold. Consider whether the content-type dispatching could be extracted into a strategy per delta field.

- **Duplicate probe call pattern** - `src/adapters/mcp-adapter.ts:3356-3364` and `src/cli/commands/agents.ts:167-170` (Confidence: 65%) -- The same `probeUrl(baseUrl, { apiKey, timeoutMs: 5000 })` pattern with severity-based display appears in both the MCP handler and the CLI command. If a third call site appears, consider a shared `probeAndReport` helper.

- **`cli.ts` arg parsing chain** - `src/cli.ts:85-194` (Confidence: 62%) -- The `run` subcommand's manual arg parsing loop (110 lines, 12 `if/else if` branches for flags) is a pre-existing complexity burden. A small argument parser abstraction would reduce repetition.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 1 | 1 | 0 |

**Complexity Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The branch overall manages complexity well for the scope of changes. The new `url-probe.ts` (273 lines) is cleanly structured with clear separation between the HTTP helper, message builders, and public entry point. The OpenAI codec refactoring (extracting `promoteOrAccumulatePending` and `registerNewToolCall`) was a positive complexity reduction. The thinking block lifecycle additions follow the established pattern.

The one blocking HIGH issue is the `handleConfigureAgent` method length (220+ lines) which should be decomposed before merge. The two MEDIUM blocking items (error/status code dispatch duplication in url-probe) are lower risk but worth addressing while the code is fresh.
