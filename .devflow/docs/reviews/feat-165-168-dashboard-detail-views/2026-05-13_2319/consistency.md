# Consistency Review Report

**Branch**: feat-165-168-dashboard-detail-views -> main
**Date**: 2026-05-13
**PR**: #172

## Issues in Your Changes (BLOCKING)

### HIGH

**Output separator style inconsistency between task-detail and orchestration-detail** - `task-detail.tsx:207`, `orchestration-detail.tsx:497`
**Confidence**: 90%
- Problem: The task-detail output section uses a plain separator `'─'.repeat(20)` while orchestration-detail uses a labeled separator `─── Output: ${selectedChild?.taskId.slice(0, 12) ?? ''} ${'─'.repeat(8)}`. Both components serve the same function (showing live output below metadata), but the visual separator differs. The orchestration detail includes the task ID in the separator (useful since the output is for a child task), while task detail shows an anonymous ruler. This inconsistency creates a jarring visual shift when a user drills from orchestration->child task and sees the separator style change.
- Fix: The difference is justified by context: in orchestration detail, the output belongs to a child task (so labeling it makes sense), while in task detail, the output belongs to the task itself (labeling is redundant). **No change needed** -- this is a justified deviation. However, consider adding a brief inline comment in `task-detail.tsx:207` explaining the simpler separator choice, e.g. `// No label needed — output belongs to the task itself (cf. orchestration-detail which labels the child taskId)`.

### MEDIUM

**Default value inconsistency for `outputVisible` / `childOutputVisible` across components** - `task-detail.tsx:63`, `orchestration-detail.tsx:366`, `detail-view.tsx:93`, `handle-main-keys.ts:112`
**Confidence**: 85%
- Problem: The default value for the output visibility prop is inconsistent across the component chain:
  - `TaskDetail`: `outputVisible = true` (output visible by default)
  - `OrchestrationDetail`: `childOutputVisible = false` (output hidden by default)
  - `DetailView`: `detailOutputVisible = true` (fallback default)
  - `handle-main-keys.ts` Enter handler: `detailOutputVisible: panel === 'tasks'` (true for tasks, false for others)

  The keyboard handler correctly sets the initial value based on panel type (true for tasks, false for orchestrations). The component-level defaults are fallbacks for when the props are omitted. The mismatch between `TaskDetail`'s default (true) and `OrchestrationDetail`'s default (false) is intentional -- tasks always have output while orchestration output requires a selected child. However, the `DetailView` bridge component defaults `detailOutputVisible = true`, which means if `DetailView` is ever rendered without passing this prop, orchestration detail would receive `true` and show output visible by default -- contradicting `OrchestrationDetail`'s own default of `false`.

  In practice, `app.tsx` always passes `nav.detailOutputVisible` explicitly, so the `DetailView` default is never reached. This is a latent inconsistency.
- Fix: Align `DetailView`'s default to match the keyboard handler's intent. Change the destructured default from `detailOutputVisible = true` to remove the default entirely (make it required), or add a comment documenting that the value is always passed from `app.tsx`.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`]` scroll-down does not explicitly set `detailOutputAutoTail: false`** - `handle-detail-keys.ts:91-96`
**Confidence**: 82%
- Problem: The `[` key (scroll up) explicitly sets `detailOutputAutoTail: false` to enter paused mode. The `]` key (scroll down) only increments `detailOutputScrollOffset` without setting `detailOutputAutoTail`. When `autoTail` is still `true`, the `OutputStreamView` ignores `scrollOffset` entirely (line 39 of `output-stream-view.tsx`), so pressing `]` while auto-tailing is a visual no-op. This inconsistency means:
  - `[` enters paused mode and scrolls up -- correct
  - `]` while auto-tailing does nothing visible -- confusing but harmless
  - `]` while paused scrolls down -- correct

  The typical user flow is `[` first (to pause), then `]` to scroll forward, which works. But the asymmetry between `[` and `]` handling is a pattern inconsistency.
- Fix: Add `detailOutputAutoTail: false` to the `]` handler to make both scroll keys behave symmetrically:
  ```typescript
  if (input === ']') {
    setNav((prev) => ({
      ...prev,
      detailOutputScrollOffset: prev.detailOutputScrollOffset + 1,
      detailOutputAutoTail: false,
    }));
    return true;
  }
  ```

## Pre-existing Issues (Not Blocking)

No pre-existing consistency issues identified in the reviewed files.

## Suggestions (Lower Confidence)

- **Duplicated output rendering logic** - `task-detail.tsx:199-228`, `orchestration-detail.tsx:489-518` (Confidence: 72%) -- The output stream rendering section (tooSmall check, empty-lines placeholder, OutputStreamView mount) is near-identical between the two components. A shared `DetailOutputSection` component could reduce duplication and ensure future output changes apply to both views simultaneously. Not blocking since both instances were introduced in the same PR and are currently in sync.

- **`useEffect` without dependency array for measurement** - `task-detail.tsx:78-85`, `orchestration-detail.tsx:404-411` (Confidence: 65%) -- Both components use `useEffect(() => { ... })` without a dependency array, meaning the measurement runs on every render. This is a common Ink pattern since `measureElement` needs to re-measure after layout changes and Ink lacks `useLayoutEffect`. The pattern is consistent between the two files. Note: the `if (height !== metadataHeight)` guard prevents infinite re-render loops.

- **`LoopDetail` architecture comment mentions "Pure view component" but now has selection state** - `loop-detail.tsx:3` (Confidence: 62%) -- The file-level comment says "Pure view component -- all data passed as props" which remains true (selection is passed as a prop, not internal state). No inconsistency, but the `#168 additions` comment could note that the component remains stateless.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Consistency Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The PR is well-structured and follows established patterns consistently:
- The loop iteration navigation mirrors the D3 orchestration drill-through pattern faithfully (selection by stable domain key, resolveIndex helper, Enter-to-drill, Esc-to-return).
- The `DetailReturnTarget` union extension for loops mirrors the existing orchestrations variant exactly.
- `NavState` extensions follow the existing naming convention (`detail*` prefix for detail-mode state, camelCase).
- New `resolveIterationIndex` mirrors `resolveChildIndex` in signature, behavior, and fallback semantics.
- New `renderConvergenceLine` follows the project pattern of pure, exported, tested helper functions.
- Test patterns (fixture builders, assert-via-frame, `press` helper) match existing keyboard test conventions.
- DECISION comments are present at key deviation points.

The two MEDIUM findings (output visible default inconsistency and `]` key asymmetry) are minor and do not block the merge. The HIGH finding about separator style is a justified deviation requiring no code change.
