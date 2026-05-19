# UI Design Review Report

**Branch**: feat-165-168-dashboard-detail-views -> main
**Date**: 2026-05-13

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Inconsistent output separator styling between task-detail and orchestration-detail** - `task-detail.tsx:207`, `orchestration-detail.tsx:497`
**Confidence**: 90%
- Problem: The task detail view uses a plain horizontal rule (`'─'.repeat(20)`) as the output separator, while the orchestration detail uses a labeled separator (`─── Output: ${taskId} ────────`). This creates visual inconsistency between the two detail views that share the same output streaming feature. Users switching between task and orchestration detail will see different visual treatments for the same conceptual element. The labeled variant in orchestration-detail is the stronger design because it provides context (which child's output is shown), but task-detail lacks any label.
- Fix: Standardize the separator. For task-detail, a simple rule is adequate since there is only one task, but it should match the structural pattern. Consider using a consistent format like `─── Output ────────` in task-detail to match the orchestration variant's visual weight, or at minimum use a consistent repeat length. The current 20-char rule feels arbitrary (off the 8px grid system, though this is a TUI so grid precision is less critical).

**Output scroll-down (`]`) has no upper bound** - `handle-detail-keys.ts:91-96`
**Confidence**: 85%
- Problem: The `]` key handler increments `detailOutputScrollOffset` without any ceiling clamp. While the `OutputStreamView` component internally clamps via `Math.min(scrollOffset, Math.max(0, totalLines - 1))`, the stored offset in nav state can grow unbounded. This means the state value diverges from the actual visible position. If a user presses `]` 1000 times past the end, pressing `[` once will decrement from 1000 to 999 -- still visually at the bottom, requiring hundreds of `[` presses to actually scroll up. The `[` handler correctly clamps at 0 on the low end, but `]` lacks the symmetrical upper clamp.
- Fix: Clamp the offset in the handler, similar to how the generic scroll handler in section 5 clamps via `detailContentLength`. The output total line count is available indirectly. Consider passing the stream's line count through `params` or capping in the view component and syncing back. A simpler pragmatic fix: cap at a large but finite value (e.g., `Math.min(prev.detailOutputScrollOffset + 1, 10000)`) to prevent truly unbounded growth, since the view already clamps visually. The ideal fix is computing the upper bound from stream state.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`useEffect` without dependency array runs on every render** - `task-detail.tsx:78-85`, `orchestration-detail.tsx:404-411`
**Confidence**: 82%
- Problem: Both `TaskDetail` and `OrchestrationDetail` use `useEffect(() => { ... })` without a dependency array to measure metadata height via `measureElement()`. This means the measurement runs on every single render cycle, not just when the metadata content changes. In an Ink terminal UI with periodic refresh (the dashboard polls data), this is acceptable performance-wise since `measureElement` is cheap and the `if (height !== metadataHeight)` guard prevents unnecessary state updates. However, the missing dependency array is a React anti-pattern that signals unintentional behavior to code readers and linters.
- Fix: This is an intentional pattern in Ink -- the metadata Box height can change when data updates (e.g., new fields become visible as task state changes) and there is no stable dependency to watch. The current implementation is correct but would benefit from a comment explaining why the dependency array is intentionally omitted: `// No deps: must re-measure on every render because metadata content changes dynamically with data updates.`

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Convergence trend line width unbounded** - `loop-detail.tsx:163` (Confidence: 65%) -- With 20 scores at up to 6 chars each plus arrows, the trend string can be ~140 chars, potentially wrapping or truncating on narrower terminals (< 80 cols). Consider adding a terminal-width-aware truncation or ellipsis for the trend display.

- **Footer hint string may overflow on narrow terminals** - `hints.ts:34` (Confidence: 60%) -- The new detail hint string `'Esc back ... G tail ... q quit'` is significantly longer than the old `'Esc back ... q quit'`. On terminals under ~80 columns, this could wrap unattractively. The existing footer component may handle truncation, but the hint density increased substantially.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**UI Design Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The dashboard detail view enhancements are well-designed overall. The output streaming integration follows the existing Ink component architecture correctly with pure view components, adaptive layout computation, and proper state management through the nav reducer. The convergence trend visualization adds meaningful information density. The iteration selection mirrors the established D3 orchestration drill-through pattern, maintaining consistency.

Conditions for approval:
1. Fix the unbounded `]` scroll offset -- this is a real UX bug where scroll-up becomes broken after over-scrolling.
2. Standardize separator styling between task-detail and orchestration-detail for visual consistency.
3. Add a comment to the dependency-less `useEffect` calls explaining the intentional omission (or add `// eslint-disable-next-line react-hooks/exhaustive-deps` with rationale if a linter flags it).
