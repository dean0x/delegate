# Complexity Review Report

**Branch**: feat/api-translation-proxy -> main
**Date**: 2026-04-25
**Diff**: `git diff b762591...HEAD` (incremental)

## Issues in Your Changes (BLOCKING)

### HIGH

**processToolCallDeltas nesting depth reaches 5 levels** - `src/translation/codecs/openai-codec.ts:316-376`
**Confidence**: 85%
- Problem: The restructured `processToolCallDeltas` method has 5 nesting levels: method -> for loop -> if/else -> if/else (pending vs new) -> if/else (has id/name vs park). The logic is functionally correct and an improvement over the previous flat if/else-if/else structure (which used `as` casts), but the nesting depth hits the WARNING threshold (4-6 levels = HIGH severity per complexity skill).
- Fix: Extract the inner `else` block (lines 353-373, the "brand new tool call" path) into a private helper method like `registerNewToolCall(tcIndex, tcId, tcName, tcArgs)`. This flattens the nesting by one level and gives the branch a descriptive name. The "pending promotion" block (lines 337-352) could similarly be extracted. Both are self-contained state transitions.

```typescript
// Suggested extraction:
private registerNewToolCall(
  tcIndex: number, tcId: string | undefined, tcName: string | undefined, tcArgs: string | undefined
): CanonicalStreamEvent[] {
  const events: CanonicalStreamEvent[] = [];
  const toolCallData: ActiveToolCall = {
    id: tcId ?? '', name: tcName ?? '',
    argumentsAccumulator: tcArgs ?? '', started: false,
  };
  if (tcId && tcName) {
    toolCallData.started = true;
    this.activeToolCalls.set(this.currentContentIndex, toolCallData);
    this.openaiToCanonicalIndex.set(tcIndex, this.currentContentIndex);
    events.push({ type: 'tool_call_start', index: this.currentContentIndex, id: tcId, name: tcName });
    this.lastActiveToolIndex = this.currentContentIndex;
    this.currentContentIndex++;
  } else {
    this.pendingToolCalls.set(tcIndex, toolCallData);
  }
  return events;
}
```

### MEDIUM

**handleBackendNonStreamingResponse has 5 parameters** - `src/translation/proxy/translation-proxy.ts:436-442`
**Confidence**: 82%
- Problem: The newly extracted `handleBackendNonStreamingResponse` takes 5 parameters (`backendRes`, `res`, `middlewares`, `responseTimeout`, `resolve`). This sits at the WARNING threshold (3-5 params). The streaming counterparts (`handleStreamingError`, `handleJsonFallback`, `handleSseStream`) already consolidated their callback parameters into the `StreamCallbackContext` pattern introduced in this same PR. The non-streaming handler does not use a similar grouping, creating an inconsistency.
- Fix: Introduce a `NonStreamCallbackContext` (or reuse `StreamCallbackContext` plus `responseTimeout`) to group the `responseTimeout` and `resolve` callbacks, matching the pattern used by the streaming handlers. This would reduce to 4 parameters and unify the callback style.

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

### MEDIUM

**container.dispose() is 83 lines with repetitive get-check-call pattern** - `src/core/container.ts:181-263`
**Confidence**: 80%
- Problem: The `dispose()` method follows the same pattern 5 times: `this.get(name)` -> check `.ok` -> cast to `DisposableService` -> check method exists -> call method. The proxy cleanup block added in this PR (lines 210-220) is the 4th repetition. While each block is individually simple, the method's total length (83 lines) is above the 50-line critical threshold and the repetition increases maintenance cost when adding future services to the shutdown sequence.
- Note: This is pre-existing structural debt that grew over time. The new proxy cleanup block follows the established pattern correctly and does not introduce new complexity -- it makes the existing pattern more visible.

**bootstrap() function is 473 lines** - `src/bootstrap.ts:172-645`
**Confidence**: 85%
- Problem: The `bootstrap()` function exceeds the 200-line CRITICAL threshold at 473 lines. The proxy startup block (lines 389-407) is well-structured and not the primary contributor to length, but it does add to an already long function.
- Note: Pre-existing. The function's length comes from registering many container services sequentially. Each block is low-complexity (simple factory registration), so cyclomatic complexity is moderate despite length. The proxy additions are proportional and follow established patterns.

## Suggestions (Lower Confidence)

- **processChunk method length (75 lines)** - `src/translation/codecs/openai-codec.ts:217-291` (Confidence: 65%) -- The `processChunk` method handles usage chunks, choices, delta parsing, text content, reasoning content, tool calls, and finish reasons in a single method. It is a state machine dispatcher and the sequential structure is appropriate, but at 75 lines it could benefit from extracting the "first chunk / message_start" logic into a helper.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 2 | 0 |

**Complexity Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The incremental changes actively reduce complexity in several areas: extracting `parseToolArguments` as a helper, introducing `StreamCallbackContext` to consolidate callback parameters, extracting `handleBackendNonStreamingResponse` from an inline callback, and the `TRANSLATE_TARGETS` const-to-type derivation pattern that eliminates manual sync. The `processToolCallDeltas` restructuring trades one form of complexity (flat if/else-if with unsafe casts) for another (deeper nesting with safer lookups) -- a net improvement in correctness that would benefit from one more extraction pass to flatten nesting. The parameter count on the new non-streaming handler is a minor inconsistency with the streaming pattern introduced in the same PR. No critical blocking issues.
