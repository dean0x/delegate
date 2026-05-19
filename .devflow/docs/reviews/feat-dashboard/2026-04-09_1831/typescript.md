# TypeScript Review Report

**Branch**: feat-dashboard -> main
**Date**: 2026-04-09

## Issues in Your Changes (BLOCKING)

### HIGH

**Type assertions (`as`) used where type guards or discriminated unions would be safer (6 occurrences)** -- Confidence: 85%
- `src/cli/dashboard/views/detail-view.tsx:60`, `detail-view.tsx:62`, `detail-view.tsx:64`, `detail-view.tsx:66`
- `src/cli/dashboard/use-dashboard-data.ts:104`, `use-dashboard-data.ts:109`
- Problem: `entity as Loop`, `entity as Task`, `entity as Schedule`, `entity as Orchestration`, `entityId as LoopId`, `entityId as ScheduleId` -- these are type assertions that bypass TypeScript's type checker. The `findEntity` function returns a union type `Loop | Task | Schedule | Orchestration | undefined`, and the switch dispatches based on `entityType` (a string enum), but the compiler does not narrow the return type because the switch is in a separate function. The `entityId as LoopId` and `entityId as ScheduleId` casts discard branded-type safety.
- Fix: For `detail-view.tsx`, make `findEntity` return a discriminated union or restructure so the switch in `DetailView` directly accesses the typed arrays:
  ```typescript
  // Option A: Inline the lookup into each case
  switch (entityType) {
    case 'loops': {
      const loop = data.loops.find((l) => l.id === entityId);
      if (!loop) return <NotFound />;
      return <LoopDetail loop={loop} ... />;
    }
    // ...
  }
  ```
  For `use-dashboard-data.ts`, the `entityId` is `string` but `LoopId`/`ScheduleId` are branded types. These casts are unavoidable at the boundary (ViewState stores a plain `string`), but the fix is to store the entityId as a union of branded IDs in `ViewState`:
  ```typescript
  // In types.ts — stronger typing for entityId
  export type ViewState =
    | { readonly kind: 'main' }
    | { readonly kind: 'detail'; readonly entityType: 'loops'; readonly entityId: LoopId }
    | { readonly kind: 'detail'; readonly entityType: 'tasks'; readonly entityId: TaskId }
    | { readonly kind: 'detail'; readonly entityType: 'schedules'; readonly entityId: ScheduleId }
    | { readonly kind: 'detail'; readonly entityType: 'orchestrations'; readonly entityId: OrchestratorId };
  ```

**Type assertions in `getPanelItems` lose type safety (4 occurrences)** -- Confidence: 82%
- `src/cli/dashboard/use-keyboard.ts:31`, `use-keyboard.ts:33`, `use-keyboard.ts:35`, `use-keyboard.ts:37`
- Problem: Each branch casts the domain entity array to `readonly { id: string; status: string }[]`. This works because `Loop`, `Task`, `Schedule`, and `Orchestration` all have `id` and `status` fields, but the cast erases the actual types and would silently compile if a domain type removed one of those fields. This violates the TypeScript skill's anti-pattern: `data as User` should be `if (isUser(data))`.
- Fix: Define a shared interface for the common shape and use `satisfies` or intersection typing:
  ```typescript
  interface Identifiable { readonly id: string; readonly status: string }
  // Then the return type is just readonly Identifiable[] — no casts needed
  // because all 4 domain types structurally satisfy this interface.
  function getPanelItems(panelId: PanelId, data: DashboardData): readonly Identifiable[] {
    switch (panelId) {
      case 'loops': return data.loops;
      case 'tasks': return data.tasks;
      case 'schedules': return data.schedules;
      case 'orchestrations': return data.orchestrations;
    }
  }
  ```
  This works because TypeScript's structural typing allows the assignment without casts since all four domain types have `id: string` (via branded types extending string) and `status: string`.

### MEDIUM

**`statusColor` default case is unreachable but returns silently** -- Confidence: 85%
- `src/cli/dashboard/components/status-badge.tsx:14-32`
- Problem: The `statusColor` function accepts `string` and uses a `switch` with a `default` fallback. This means it silently handles unknown status values without any compile-time safety. Since the project uses enums (`TaskStatus`, `LoopStatus`, `ScheduleStatus`, `OrchestratorStatus`), the function could accept a union type and use an exhaustive `never` check. As written, if a new status value is added to any domain enum, this function will silently return `'gray'` with no compiler warning.
- Fix: Accept a union of all known status strings and add exhaustive checking with a `never` default for compile-time safety, or keep the `string` parameter but add a comment documenting why `default` is intentional (cross-entity function covers multiple enums).

**Loose `string` typing for status parameters across components** -- Confidence: 80%
- `src/cli/dashboard/format.ts:61` (`statusIcon`), `src/cli/dashboard/components/status-badge.tsx:14` (`statusColor`), `src/cli/dashboard/components/status-badge.tsx:43` (`StatusBadge`)
- Problem: All three accept `status: string` rather than a union of the known domain status types. This means any arbitrary string is accepted without compile-time validation, which contradicts the project's pattern of using enums (`TaskStatus`, `LoopStatus`, etc.) for status values.
- Fix: Define a `DashboardStatus` union type covering all entity statuses and use it consistently:
  ```typescript
  type DashboardStatus = TaskStatus | LoopStatus | ScheduleStatus | OrchestratorStatus;
  ```
  Alternatively, keep `string` if the intent is to be resilient to future status values, but document the decision.

**`RUNNING_FRAMES` array index not bounds-checked** -- Confidence: 80%
- `src/cli/dashboard/components/status-badge.tsx:58`
- Problem: `RUNNING_FRAMES[frameIdx]` accesses the array with a number index. With `noUncheckedIndexedAccess` enabled (recommended by the TypeScript skill checklist), this would return `string | undefined`. If tsconfig does not enable this flag, the access is unchecked and could return `undefined` if `frameIdx` is somehow out of bounds.
- Fix: Use nullish coalescing: `const icon = isAnimated ? (RUNNING_FRAMES[frameIdx] ?? '●') : statusIcon(status);`

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`ReadOnlyContext` interface lacks `countByStatus` typing guarantee** -- Confidence: 80%
- `src/cli/read-only-context.ts:31-38`
- Problem: The `ReadOnlyContext` interface references `TaskRepository`, `LoopRepository`, `ScheduleRepository`, and `OrchestrationRepository`, which now all include `countByStatus()`. This is structurally fine, but `ReadOnlyContext` was designed for CLI query commands and the interface documentation does not mention the dashboard use case. The dashboard relies on `countByStatus()` existing on each repository, which is a new contract. If anyone creates an alternative `ReadOnlyContext` implementation (e.g., for testing), they may not realize `countByStatus` is required.
- Fix: No code change needed -- the interface already requires the full repository types. Consider adding a documentation comment noting the dashboard dependency.

## Pre-existing Issues (Not Blocking)

_No critical pre-existing issues found in reviewed files._

## Suggestions (Lower Confidence)

- **`pkg` parsed with `JSON.parse` is unvalidated** - `src/cli/dashboard/index.tsx:40-41` (Confidence: 65%) -- `JSON.parse` returns `any`; the `(pkg as { version?: string })` assertion is a partial validation. A Zod schema or runtime check would be safer, though this is a self-owned file with a known structure.

- **`formatRunProgress` uses falsy check for `max`** - `src/cli/dashboard/format.ts:128` (Confidence: 70%) -- `if (!max)` treats `0`, `null`, and `undefined` identically as "unlimited". The function's JSDoc says `0` means unlimited, so the behavior is intentional, but `!max` is a loose check that would also catch `NaN`. An explicit `max === null || max === undefined || max === 0` would be more precise.

- **Loop timestamps: `createdAt`/`updatedAt` are `number` in domain type but memory says loops use Date objects** - (Confidence: 60%) -- The MEMORY.md note says "Loop timestamps use Date objects" but the actual `Loop` interface in `domain.ts:575-576` declares `createdAt: number` and `updatedAt: number`. The `relativeTime()` function in `format.ts` correctly expects epoch ms. Either the memory note is outdated or it refers to the repository layer's conversion. No action needed if the domain type is authoritative.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**TypeScript Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The code demonstrates strong TypeScript patterns overall: immutable `readonly` types everywhere, proper Result type usage, discriminated unions for `ViewState`, and well-typed component props. The main concern is the pattern of `as` type assertions (10 total across 2 files) where type-safe alternatives exist. The `getPanelItems` casts are straightforward to eliminate via structural typing, and the `detail-view.tsx` casts can be removed by inlining lookups. The loose `string` typing for status parameters is a design trade-off that could be tightened with a union type.
