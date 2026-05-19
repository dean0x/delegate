# Consistency Review Report

**Branch**: feat/166-167-dashboard-cleanup -> main
**Date**: 2026-05-14
**PR**: #174

## Issues in Your Changes (BLOCKING)

### MEDIUM

**JSDoc on DashboardMutationContext still says "cancel/delete operations"** - `src/cli/dashboard/types.ts:38`
**Confidence**: 92%
- Problem: The `DashboardMutationContext` JSDoc reads "Mutation services passed to the dashboard for cancel/delete operations" and the DECISION comment says "manual cancel/delete keybindings need mutation access." Now that pause/resume also flows through this context, the comment is stale.
- Fix: Update both comment lines to mention cancel/delete/pause/resume:
```typescript
/**
 * Mutation services passed to the dashboard for cancel/delete/pause/resume operations.
 * DECISION (2026-04-10): The dashboard uses full bootstrap (withServices) because
 * manual cancel/delete/pause/resume keybindings need mutation access. Adds ~200-500ms to
 * dashboard startup but acceptable for interactive launch.
 */
```

**EntityKind JSDoc still says "cancel/delete"** - `src/cli/dashboard/keyboard/entity-mutations.ts:12-14`
**Confidence**: 90%
- Problem: The JSDoc on the `EntityKind` type says "panel-focused cancel/delete where the kind is derived from PanelId." Since `pauseOrResumeEntity` now also uses `EntityKind`, the comment should reflect this.
- Fix: Update to "panel-focused cancel/delete/pause/resume where the kind is derived from PanelId."

**entity-mutations.ts module-level JSDoc still says "cancel/delete"** - `src/cli/dashboard/keyboard/entity-mutations.ts:1-5`
**Confidence**: 90%
- Problem: The file header says "Unified cancel/delete dispatch for keyboard handlers" and "eliminate duplication of entity-kind routing across cancel/delete blocks." `pauseOrResumeEntity` is now also exported from this module.
- Fix: Update header to "Unified cancel/delete/pause/resume dispatch for keyboard handlers" and "eliminate duplication of entity-kind routing across cancel/delete/pause/resume blocks."

**detailHints uses raw string literals while pauseOrResumeEntity uses enum constants** - `src/cli/dashboard/keyboard/hints.ts:36-41`
**Confidence**: 82%
- Problem: `pauseOrResumeEntity` in entity-mutations.ts consistently uses `ScheduleStatus.ACTIVE`, `ScheduleStatus.PAUSED`, `LoopStatus.RUNNING`, `LoopStatus.PAUSED` for status comparisons. The `detailHints` function compares against raw string literals (`'active'`, `'running'`, `'paused'`). The JSDoc explains this is intentional ("ScheduleStatus and LoopStatus are already lowercase"), but the inconsistency within the same feature means a future enum value change would silently break hints while correctly updating mutations.
- Fix: Import and use the status enums for consistency with the sibling module:
```typescript
import { LoopStatus, ScheduleStatus } from '../../core/domain.js';
// ...
if (entityStatus === ScheduleStatus.ACTIVE || entityStatus === LoopStatus.RUNNING) {
  return `${base} · p pause`;
}
if (entityStatus === ScheduleStatus.PAUSED || entityStatus === LoopStatus.PAUSED) {
  return `${base} · p resume`;
}
```

### LOW

**Catch clause comment inconsistency across cancelEntity and pauseOrResumeEntity** - `src/cli/dashboard/keyboard/entity-mutations.ts:78-82,123-126`
**Confidence**: 80%
- Problem: `cancelEntity`'s catch comment has the line "The next 1Hz poll will refresh the UI with accurate state regardless." `pauseOrResumeEntity`'s catch omits that line. Since both functions call `refreshNow()` before the catch and rely on the same polling mechanism for state recovery, the rationale applies equally.
- Fix: Add the missing line to the `pauseOrResumeEntity` catch block for documentation consistency:
```typescript
} catch {
  // Best-effort: service errors are logged internally by each service.
  // Swallowing here prevents unhandled rejection from crashing the dashboard TUI.
  // The next 1Hz poll will refresh the UI with accurate state regardless.
}
```

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

_No issues found._

## Suggestions (Lower Confidence)

- **mainHints pause hint position relative to c/d** - `src/cli/dashboard/keyboard/hints.ts:21` (Confidence: 65%) -- The pause/resume hint is appended after "d delete (terminal)" via string concatenation, which places it at the very end of the hint string. The c/d/p keys form a logical group of entity-mutation operations; grouping them visually (e.g., "c cancel / d delete / p pause") would be more scannable, though this is a UX micro-preference.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 4 | 1 |
| Should Fix | - | - | 0 | 0 |
| Pre-existing | - | - | 0 | 0 |

**Consistency Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The workspace view removal is thorough and consistent -- all type unions, JSDoc references, breadcrumb logic, poll intervals, reducer actions, test files, and navigation state have been cleanly excised. The `'workspace'` literal has been removed from every discriminated union variant (`ViewState`, `DetailReturnTarget`, `viewKind` props) consistently.

The pause/resume feature (#167) follows established patterns well: `pauseOrResumeEntity` mirrors `cancelEntity`/`deleteEntity` in signature, error handling, and switch-on-kind structure. The new `p` key is wired symmetrically in both `handleMainKeys` and `handleDetailKeys`. Test coverage follows the existing behavioral pattern for c/d bindings.

The blocking issues are all documentation-level inconsistencies where JSDoc and comments were not updated to reflect that the mutation surface now includes pause/resume alongside cancel/delete. These are straightforward fixes that maintain the codebase's strong self-documentation pattern. The enum-vs-raw-string inconsistency in `detailHints` is low-risk but deviates from the pattern established by the sibling `pauseOrResumeEntity` function in the same module family.

Pitfall review: PF-001 (do not defer review issues) -- all findings are reported here. PF-002 (no migration for zero-user features) -- not applicable; the workspace view deletion is a clean break with no migration needed, which aligns with PF-002.
