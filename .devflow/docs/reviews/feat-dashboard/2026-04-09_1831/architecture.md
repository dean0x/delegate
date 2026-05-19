# Architecture Review Report

**Branch**: feat-dashboard -> main
**Date**: 2026-04-09
**PR**: #131

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Type assertions bypass type safety in detail-view.tsx and use-keyboard.ts** - `src/cli/dashboard/views/detail-view.tsx:60-66`, `src/cli/dashboard/use-keyboard.ts:31-37`
**Confidence**: 82%
- Problem: `detail-view.tsx` uses `entity as Loop`, `entity as Task`, etc. after a `findEntity()` that returns a union type `Loop | Task | Schedule | Orchestration | undefined`. While the `switch` on `entityType` guarantees correctness at runtime, the compiler loses narrowing because `findEntity()` returns the full union. Similarly, `use-keyboard.ts` casts `data.loops as readonly { id: string; status: string }[]` -- downcasting domain types to a structural subset via assertion rather than letting the type system verify compatibility.
- Fix: For `detail-view.tsx`, use per-type lookup helpers (or overloaded `findEntity` signatures returning the narrowed type for each `PanelId` literal) so the compiler narrows the return type per case. For `use-keyboard.ts`, define a shared `{ readonly id: string; readonly status: string }` interface that the domain types extend, and use a generic constraint or mapped accessor instead of assertions.

```typescript
// detail-view.tsx — overloaded signatures eliminate assertions
function findLoop(data: DashboardData, id: string): Loop | undefined {
  return data.loops.find((l) => l.id === id);
}
// Then: case 'loops': { const loop = findLoop(data, entityId); ... }

// use-keyboard.ts — extract shared interface
interface Identifiable { readonly id: string; readonly status: string }
// Domain types already satisfy this structurally, so no cast needed:
function getPanelItems(panelId: PanelId, data: DashboardData): readonly Identifiable[] { ... }
```

**Type assertion for branded IDs in use-dashboard-data.ts** - `src/cli/dashboard/use-dashboard-data.ts:104,109`
**Confidence**: 80%
- Problem: `entityId as LoopId` and `entityId as ScheduleId` bypass branded type safety. The `entityId` is a plain `string` from `ViewState`, but `LoopId` and `ScheduleId` are branded types. If `ViewState` is constructed with the wrong ID (e.g., a task ID is used to look up a loop), the assertion silently succeeds and the query returns no data rather than failing at compile time.
- Fix: Carry the branded ID through from selection. When entering detail view (`useKeyboard` sets `entityId`), the ID already comes from the entity's `.id` field which is already branded. Thread the branded type through `ViewState` using a discriminated union:

```typescript
export type ViewState =
  | { readonly kind: 'main' }
  | { readonly kind: 'detail'; readonly entityType: 'loops'; readonly entityId: LoopId }
  | { readonly kind: 'detail'; readonly entityType: 'tasks'; readonly entityId: TaskId }
  | { readonly kind: 'detail'; readonly entityType: 'schedules'; readonly entityId: ScheduleId }
  | { readonly kind: 'detail'; readonly entityType: 'orchestrations'; readonly entityId: OrchestratorId };
```

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

_No critical pre-existing issues._

## Suggestions (Lower Confidence)

- **Hardcoded viewport height** - `src/cli/dashboard/views/main-view.tsx:25`, `src/cli/dashboard/use-keyboard.ts:169` (Confidence: 65%) -- `PANEL_VIEWPORT_HEIGHT = 10` and the matching `viewportHeight = 10` in the keyboard hook are magic numbers that don't respond to actual terminal size. For small terminals (just above the 20-row minimum), 10 rows per panel may overflow. Consider deriving from `process.stderr.rows` or passing terminal dimensions through context.

- **Hardcoded polling interval** - `src/cli/dashboard/use-dashboard-data.ts:168` (Confidence: 70%) -- The 1-second polling interval is hardcoded inline. For systems with many entities, frequent polling (8 parallel DB queries/sec) may cause noticeable load on a shared SQLite database. Consider making the interval configurable or adaptive (e.g., slow down when in detail view where data changes less frequently).

- **`process.exit()` calls in index.tsx guards** - `src/cli/dashboard/index.tsx:27,35,46` (Confidence: 60%) -- The TTY guard, size guard, and DB init guard all call `process.exit(1)` directly. This is acceptable for a CLI entry point but diverges from the project's Result-type pattern. The `startDashboard()` function could return a `Result<void>` and let the CLI dispatcher in `src/cli.ts` handle the exit. This would make testing the guard logic easier without mocking `process.exit`.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Architecture Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Architecture Strengths

1. **Clean layering and dependency direction**: The dashboard correctly depends only on `core/domain.ts`, `core/interfaces.ts`, and `core/result.ts` -- never on implementations, services, or adapters. This follows the Dependency Rule (Clean Architecture) precisely.

2. **ReadOnlyContext is a well-designed segregated interface (ISP)**: Rather than depending on the full bootstrap Container with its 15+ components, the dashboard uses a narrow read-only context exposing only the 5 repositories it needs. This is textbook Interface Segregation.

3. **Functional core / imperative shell separation**: State lives in `App.tsx` (the shell), all view components are stateless and receive data as props, hooks encapsulate side effects (polling, keyboard input), and format utilities are pure functions. This is an excellent application of the "functional core, imperative shell" pattern.

4. **Repository interface evolution is consistent**: The new `countByStatus()` method was added to all 4 repository interfaces with identical signatures, matching the existing `findAll()`/`count()` convention. SQL implementations are structurally identical across all repositories.

5. **Component decomposition is appropriately deep**: Components are genuinely deep modules (Ousterhout): `ScrollableList` hides viewport clipping complexity behind a simple props interface; `Panel` hides border/focus/filter rendering; `StatusBadge` hides animation logic. No shallow wrappers.

6. **Dynamic import for the dashboard**: `src/cli.ts` uses `await import('./cli/dashboard/index.js')` rather than a static import, so the React/Ink dependency tree is never loaded for non-dashboard commands. This preserves CLI startup performance.

### Conditions for Approval

The two MEDIUM type-assertion issues are not blocking correctness (the runtime behavior is correct because the switch statements guarantee the right type at each branch), but they weaken compile-time safety. These should be addressed as a follow-up to maintain the project's "type everything, no `any` types" standard.
