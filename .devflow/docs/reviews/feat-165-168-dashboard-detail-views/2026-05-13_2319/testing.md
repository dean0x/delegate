# Testing Review Report

**Branch**: feat-165-168-dashboard-detail-views -> main
**Date**: 2026-05-13
**PR**: #172 — Dashboard detail view improvements (task output streaming #165, loop eval data #168)

## Issues in Your Changes (BLOCKING)

### HIGH

**Missing tests for `includeEvalResponse` MCP parameter and new response fields** - `src/adapters/mcp-adapter.ts`
**Confidence**: 92%
- Problem: The PR adds a new `includeEvalResponse` boolean parameter to the `LoopStatusSchema` and surfaces three new response fields (`evalType`, `judgeAgent`, `judgePrompt`) in the LoopStatus response. The existing MCP adapter test suite (`tests/unit/adapters/mcp-adapter.test.ts`) has tests for `includeSystemPrompt` on LoopStatus (lines 3278-3307) but no tests for `includeEvalResponse` or the new eval config fields. This is a new user-facing MCP API surface — callers rely on these fields and on the opt-in gating of `evalResponse`.
- Fix: Add tests mirroring the `includeSystemPrompt` pattern:
  1. `includeEvalResponse=true` returns `evalResponse` in iteration objects
  2. `includeEvalResponse` absent (default false) omits `evalResponse` from iterations
  3. Response includes `evalType`, `judgeAgent`, `judgePrompt` fields

**Missing tests for `parseEvalResponseJson` — private but complex JSON parsing logic** - `src/cli/dashboard/views/loop-detail.tsx:177`
**Confidence**: 85%
- Problem: `parseEvalResponseJson` handles untrusted JSON input with multiple type coercions (`string` scores parsed as numbers via `Number()`, optional fields). This function is private (not exported), so it cannot be unit tested independently. The `loop-detail-helpers.test.ts` file tests `resolveIterationIndex` and `renderConvergenceLine` (both exported pure functions) but the JSON parsing logic has zero test coverage.
- Fix: Export `parseEvalResponseJson` and add unit tests covering: valid JSON with all fields, partial fields, `score` as string, invalid JSON, non-object JSON, nested/unexpected types. Alternatively, test it indirectly through React component rendering with `SelectedIterationEval`.

### MEDIUM

**No test for `SelectedIterationEval` component rendering behavior** - `src/cli/dashboard/views/loop-detail.tsx:205`
**Confidence**: 82%
- Problem: The `SelectedIterationEval` component renders eval feedback, structured/raw eval responses, exit codes, error messages, git diff summaries, and a drill hint. It has conditional rendering paths (JSON vs raw evalResponse, presence/absence of each field). None of these rendering paths have tests. The component is internal (not exported), so it would need either export or indirect testing through `LoopDetail`.
- Fix: Add snapshot or behavioral tests for `SelectedIterationEval` covering: iteration with evalFeedback only, iteration with structured JSON evalResponse, iteration with raw non-JSON evalResponse, iteration with no content (returns null), iteration with taskId (shows drill hint).

**Orchestration detail output rendering has no component-level tests** - `src/cli/dashboard/views/orchestration-detail.tsx:489-518`
**Confidence**: 80%
- Problem: The orchestration detail view now conditionally renders an output stream panel for the selected child task. This includes: empty stream states ("Waiting for output...", "No output captured", "Loading output..."), the `OutputStreamView` component, and a "terminal too small" fallback. The keyboard tests verify `detailOutputVisible` nav state changes, but no tests verify the actual rendering behavior in the orchestration detail component (whether the output section appears/hides, whether the correct child stream is resolved).
- Fix: Add component-level tests for `OrchestrationDetail` verifying: output hidden by default (`childOutputVisible=false`), output shown when `childOutputVisible=true` and a stream exists, "terminal too small" message, empty stream placeholder text.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`useEffect` without dependency array runs on every render** - `src/cli/dashboard/views/task-detail.tsx:78`, `src/cli/dashboard/views/orchestration-detail.tsx:404`
**Confidence**: 65% (moved to Suggestions -- see below)

## Pre-existing Issues (Not Blocking)

_None identified at CRITICAL severity._

## Suggestions (Lower Confidence)

- **`useEffect` without dependency array re-measures on every render** - `task-detail.tsx:78`, `orchestration-detail.tsx:404` (Confidence: 65%) -- Both components use `useEffect(() => { ... })` with no dependency array to call `measureElement()`. In Ink's terminal rendering model this is acceptable (renders are infrequent, DOM measurement has no web-like reflow cost), but it is unconventional React. If this pattern is validated by Ink documentation or project convention, no action needed. If not, consider adding `[metadataRef.current]` or an empty `[]` with a manual trigger.

- **No test for `detailOutputAutoTail`/`detailOutputScrollOffset` reset when child selection changes in orchestration detail** - `handle-detail-keys.ts:168-169` (Confidence: 70%) -- When navigating up/down through orchestration children, `detailOutputAutoTail` is reset to `true` and `detailOutputScrollOffset` to `0`. The keyboard test for `orch-child-sel` asserts only the `orchestrationChildSelectedTaskId` change, not these two resets.

- **Footer test updated but minimal** - `tests/unit/cli/dashboard/footer.test.tsx:98-99` (Confidence: 62%) -- The detail hint string changed from `'Esc back . up-down scroll . r refresh . q quit'` to include output controls (`'o output . [/] scroll . G tail'`). The test checks for `'up-down select'` but does not verify the new output-specific hints (`o output`, `[/] scroll`, `G tail`).

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | - | 0 | 0 |

**Testing Score**: 7/10

The PR adds 505 new test lines across 3 new test files. The pure-function tests (`loop-detail-helpers.test.ts`, `layout.test.ts` additions) are excellent -- they follow AAA structure, test edge cases and boundaries, and cover the convergence trend algorithm thoroughly. The keyboard integration tests (`use-keyboard.test.tsx`) are well-structured, testing all new keybindings (output controls `o/[/]/g/G`, loop iteration navigation, main-to-detail state resets) through behavioral assertions on rendered output. The nav-reducer tests verify immutability and structural sharing for new state fields.

The gaps are: (1) the MCP adapter's new `includeEvalResponse` parameter and new response fields lack tests entirely, (2) the `parseEvalResponseJson` JSON parsing function is untested, and (3) the visual rendering behavior of the output stream in task/orchestration detail views has no component-level tests.

**Recommendation**: CHANGES_REQUESTED
