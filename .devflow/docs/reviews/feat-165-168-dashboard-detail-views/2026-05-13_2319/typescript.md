# TypeScript Review Report

**Branch**: feat-165-168-dashboard-detail-views -> main
**Date**: 2026-05-13
**PR**: #172 — Dashboard detail view improvements (#165 output streaming, #168 loop eval data)

## Issues in Your Changes (BLOCKING)

### HIGH

**useEffect without dependency array runs on every render** - `task-detail.tsx:78`, `orchestration-detail.tsx:404`
**Confidence**: 85%
- Problem: Both `useEffect(() => { ... })` calls lack a dependency array, causing `measureElement()` to run on every single render. While the `if (height !== metadataHeight)` guard prevents unnecessary setState calls, the measurement itself is executed every render cycle. In a dashboard that re-renders on 250ms animation ticks (`TICK_ANIM`), this means `measureElement()` fires 4 times per second even when metadata content is unchanged.
- Fix: Add a dependency array. The measurement only needs to re-run when the metadata content changes. Since the ref content changes reactively with props, an empty dependency is not sufficient, but a layout effect would be more appropriate for DOM measurement:
```typescript
// Option A: useLayoutEffect with no deps (semantic signal that this is layout measurement)
useLayoutEffect(() => {
  if (metadataRef.current) {
    const { height } = measureElement(metadataRef.current);
    if (height !== metadataHeight) {
      setMetadataHeight(height);
    }
  }
});

// Option B: Track a content fingerprint and use it as a dependency
// (heavier refactor, but avoids running measurement on animation ticks)
```
Note: This is a pattern decision. Ink's `measureElement` is lightweight and the `height !== metadataHeight` guard prevents state thrashing. If this is an intentional "measure after every render" pattern for Ink components where content changes are not easily tracked, adding a code comment documenting the intent would resolve this finding.

### MEDIUM

**Redundant `as TaskId` cast after type guard** - `handle-detail-keys.ts:142`
**Confidence**: 90%
- Problem: `iter.taskId as TaskId` is unnecessary. The `LoopIteration.taskId` field is typed as `TaskId | undefined`. After the guard on line 137 (`if (!iter || !iter.taskId) return true`), TypeScript narrows `iter.taskId` to `TaskId`. The `as` cast suppresses the type system without adding safety.
- Fix: Remove the cast:
```typescript
entityId: iter.taskId,
```

**`as Record<string, unknown>` cast after `unknown` parse** - `loop-detail.tsx:181`
**Confidence**: 82%
- Problem: After parsing JSON as `unknown` and checking `typeof parsed !== 'object' || parsed === null`, the code uses `const obj = parsed as Record<string, unknown>`. While the preceding guard ensures `parsed` is a non-null object, the `as` cast bypasses the type system. This is a minor anti-pattern per the TypeScript skill (`as` suppresses narrowing).
- Fix: Use a type-safe narrowing pattern:
```typescript
const obj: Record<string, unknown> = parsed as Record<string, unknown>;
```
This is functionally identical but the pattern is established here. Alternatively, a type predicate function `isRecord(v: unknown): v is Record<string, unknown>` would be more robust but heavier for a view-layer helper. Low impact — the guard logic is correct.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`resolveDetailStreamTaskId` uses `as TaskId` cast on `view.entityId`** - `app.tsx:142`
**Confidence**: 85%
- Problem: `view.entityId as TaskId` casts a generic `string` to a branded `TaskId`. The `ViewState` type stores `entityId` as a string (or the branded type depending on which union member). If the discriminated union already narrows `entityId` to `TaskId` when `entityType === 'tasks'`, the cast is redundant. If it does not, the cast masks a type gap in the `ViewState` definition.
- Fix: Check whether `ViewState` narrows `entityId` per `entityType`. If it does, remove the cast. If not, consider adding branded types to the `ViewState` union members. This is consistent with the project's branded-type discipline for domain identifiers.

**`nav.orchestrationChildSelectedTaskId as TaskId` cast** - `app.tsx:144`
**Confidence**: 85%
- Problem: `NavState.orchestrationChildSelectedTaskId` is typed as `string | null`. After the truthiness check, this is cast to `TaskId`. The field should ideally be `TaskId | null` in `NavState` to avoid boundary casts.
- Fix: Update `NavState.orchestrationChildSelectedTaskId` type from `string | null` to `TaskId | null`. This would eliminate the cast and propagate type safety to all consumers. This is a pre-existing typing gap that the new code surfaces.

## Pre-existing Issues (Not Blocking)

_No critical pre-existing issues found in the reviewed files._

## Suggestions (Lower Confidence)

- **`streamTaskStatuses` creates a new `Map()` on every render** - `app.tsx:165` (Confidence: 65%) — When `view.kind !== 'workspace'`, a new `Map()` is allocated every render. Consider extracting `const EMPTY_MAP: ReadonlyMap<TaskId, string> = new Map()` as a module-level constant to avoid GC pressure.

- **`parseEvalResponseJson` return type could use a named interface** - `loop-detail.tsx:177` (Confidence: 62%) — The inline `{ decision?: string; score?: number; reasoning?: string } | null` return type is repeated implicitly at the call site. A named `ParsedEvalResponse` interface would improve readability.

- **`originalReturnTo` type narrowing in loop Esc handler duplicates orchestration pattern** - `handle-detail-keys.ts:61-68` (Confidence: 70%) — The loop and orchestration Esc return handlers share identical structure. A shared utility like `handleReturnToDetail(returnTo, setView)` would reduce duplication across the two entity types.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**TypeScript Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The TypeScript patterns are solid overall. The `useEffect` without dependency array is the most impactful finding — it runs measurement code on every render including animation ticks. The `as` casts are minor but contrary to the project's strict-typing discipline. The new code follows established patterns well (discriminated unions for `DetailReturnTarget`, branded types for IDs, readonly interfaces for props, React.memo for view components). Test coverage is thorough with dedicated pure-function tests for the new helpers.

Conditions:
1. Confirm the `useEffect` without deps is intentional for Ink measurement, or add dependency tracking
2. Remove the redundant `as TaskId` cast on `iter.taskId` in handle-detail-keys.ts:142
