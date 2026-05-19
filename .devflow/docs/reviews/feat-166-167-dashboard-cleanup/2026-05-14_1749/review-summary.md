# Code Review Summary

**Branch**: feat/166-167-dashboard-cleanup -> main
**Date**: 2026-05-14_1749

## Merge Recommendation: APPROVED_WITH_CONDITIONS

This PR successfully removes ~2,800 lines of workspace view and grid mode infrastructure while adding compact pause/resume controls for schedules and loops. The changes are architecturally sound, thoroughly tested (651 tests pass), and align with project patterns. However, 8 MEDIUM-severity issues across your changes require resolution before merge: 2 blocking code issues, 3 documentation gaps, and 3 minor UI/UX refinements. None are HIGH or CRITICAL.

---

## Issue Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW | Total |
|----------|----------|------|--------|-----|-------|
| **Blocking** | 0 | 0 | 8 | 0 | **8** |
| **Should Fix** | 0 | 0 | 2 | 0 | **2** |
| **Pre-existing** | 0 | 0 | 1 | 0 | **1** |

---

## Blocking Issues (Must Fix Before Merge)

### 1. Nested Ternary for `entityStatus` in app.tsx — 100% Confidence
**File**: `src/cli/dashboard/app.tsx:204-212`
**Reviewers**: Architecture, Complexity, Performance, React, TypeScript, UI-Design

- **Problem**: The `entityStatus` prop uses a triple-nested ternary with inline `.find()` calls on every render:
  ```typescript
  entityStatus={
    view.kind === 'detail'
      ? view.entityType === 'schedules'
        ? data?.schedules.find((s) => s.id === view.entityId)?.status
        : view.entityType === 'loops'
          ? data?.loops.find((l) => l.id === view.entityId)?.status
          : undefined
      : undefined
  }
  ```
  This violates the "tell, don't ask" pattern (pushing data-derivation logic into the shell), creates unstable references on every render (the `.find()` executes even when not needed), and harms readability.

- **Suggested Fix**: Extract to a named helper function or `useMemo` above the return statement:
  ```typescript
  const entityStatus = useMemo(() => {
    if (view.kind !== 'detail') return undefined;
    if (view.entityType === 'schedules') {
      return data?.schedules.find((s) => s.id === view.entityId)?.status;
    }
    if (view.entityType === 'loops') {
      return data?.loops.find((l) => l.id === view.entityId)?.status;
    }
    return undefined;
  }, [view, data?.schedules, data?.loops]);
  ```

### 2. Footer Hints Use Loose `string` Types Instead of Domain Enums — 85% Confidence
**File**: `src/cli/dashboard/keyboard/hints.ts:26-37, src/cli/dashboard/components/footer.tsx:17-19`
**Reviewers**: Architecture, TypeScript

- **Problem**: `detailHints()` accepts `entityType?: string` and `entityStatus?: string`, then compares against string literals (`'active'`, `'running'`, `'paused'`, `'schedules'`, `'loops'`). The codebase uses branded types (`ScheduleStatus.ACTIVE`, `LoopStatus.RUNNING`, `PanelId`). Using `string` bypasses type safety -- a typo in comparison strings produces no compile error.

- **Suggested Fix**: Use domain enums and union types:
  ```typescript
  // footer.tsx
  readonly entityType?: PanelId;
  readonly entityStatus?: ScheduleStatus | LoopStatus;

  // hints.ts
  export function detailHints(entityType?: PanelId, entityStatus?: string): string {
    // ...
    if (entityType === 'schedules' || entityType === 'loops') {
      if (entityStatus === ScheduleStatus.ACTIVE || entityStatus === LoopStatus.RUNNING) {
        return `${base} · p pause`;
      }
      if (entityStatus === ScheduleStatus.PAUSED || entityStatus === LoopStatus.PAUSED) {
        return `${base} · p resume`;
      }
    }
  }
  ```

### 3. JSDoc Numbering Inconsistency in handle-detail-keys.ts — 95% Confidence
**File**: `src/cli/dashboard/keyboard/handle-detail-keys.ts:126, 184, 278`
**Reviewers**: Consistency

- **Problem**: After inserting `handlePauseResume` as section "3", subsequent function JSDoc sections were not renumbered. Current: 3 (pause/resume), 4 (loop), 4 (orchestration duplicate), 5 (generic scroll). Should be: 3, 4, 5, 6.

- **Suggested Fix**: Renumber:
  - Line 126: Keep as `4. Loop detail:` (correct)
  - Line 184: Change `4.` to `5. D3 orchestration detail:`
  - Line 278: Change `5.` to `6. Generic scroll`

### 4. Dispatcher Comment Omits `handlePauseResume` from Key Handler Ordering — 95% Confidence
**File**: `src/cli/dashboard/keyboard/handle-detail-keys.ts:342-347`
**Reviewers**: Consistency

- **Problem**: The `handleDetailKeys` JSDoc lists 5 key handlers but the chain has 6. `handlePauseResume` is missing from the numbered list.

- **Suggested Fix**: Update the comment:
  ```
  * Key handler ordering:
  *  1. Esc/Backspace -> return to previous view
  *  2. Output controls (o/[/]/g/G) -> guarded to task/orchestration only
  *  3. Pause/resume (p) -> schedules and loops only
  *  4. Loop entity type -> iteration navigation
  *  5. Orchestration entity type -> child navigation (existing D3 pattern)
  *  6. Generic scroll -> non-orchestration/non-loop detail (schedules, pipelines)
  ```

### 5. CLAUDE.md File Location Table References Deleted Workspace View — 100% Confidence
**File**: `CLAUDE.md:297`
**Reviewers**: Architecture, Consistency, Regression, React, Reliability

- **Problem**: The File Locations table still lists `| Workspace view | src/cli/dashboard/views/workspace-view.tsx |` but this file was deleted in #166. Stale reference will mislead developers.

- **Suggested Fix**: Remove the workspace view row:
  ```diff
  -| Workspace view | `src/cli/dashboard/views/workspace-view.tsx` |
  ```

### 6. Main View Footer Hint Shows "p pause/resume" for Non-Pauseable Panels — 85-90% Confidence
**File**: `src/cli/dashboard/keyboard/hints.ts:16`
**Reviewers**: Accessibility, UI-Design

- **Problem**: The `mainHints()` function unconditionally appends `p pause/resume` when `hasMutations=true`, even when the focused panel is Tasks, Orchestrations, or Pipelines (where `p` is silently ignored). This violates UI affordances -- the hint suggests an action is available when it is not. The detail view correctly conditionalizes the hint by entity type; main view should too.

- **Suggested Fix**: Pass `focusedPanel` to `mainHints()` and conditionally show the hint:
  ```typescript
  export function mainHints(hasMutations: boolean, focusedPanel?: string): string {
    const base = 'Tab: panel · ... · r refresh · q quit';
    if (hasMutations) {
      const pauseHint = focusedPanel === 'schedules' || focusedPanel === 'loops'
        ? ' · p pause/resume'
        : '';
      return `${base} · c cancel · d delete (terminal)${pauseHint}`;
    }
    return base;
  }
  ```
  Then pass `focusedPanel` from `app.tsx` to the Footer component.

### 7. Missing Footer Hint Tests for New Pause/Resume Behavior — 85% Confidence
**File**: `tests/unit/cli/dashboard/footer.test.tsx`
**Reviewers**: Testing

- **Problem**: The Footer component gained new props (`entityType`, `entityStatus`) that drive conditional hint text ("p pause" vs "p resume"). The test file was only updated to remove workspace tests but no new tests were added for the conditional pause/resume hints or the `mainHints` "p pause/resume" text when `hasMutations=true`.

- **Suggested Fix**: Add tests covering:
  ```typescript
  describe('viewKind="main" + hasMutations=true', () => {
    it('contains "p pause/resume" mutation hint', () => {
      const { lastFrame } = render(<Footer viewKind="main" hasMutations />);
      expect(lastFrame()).toContain('p pause/resume');
    });
  });

  describe('viewKind="detail" with entity context', () => {
    it('contains "p pause" for active schedule detail', () => {
      const { lastFrame } = render(
        <Footer viewKind="detail" entityType="schedules" entityStatus="active" />,
      );
      expect(lastFrame()).toContain('p pause');
    });

    it('contains "p resume" for paused loop detail', () => {
      const { lastFrame } = render(
        <Footer viewKind="detail" entityType="loops" entityStatus="paused" />,
      );
      expect(lastFrame()).toContain('p resume');
    });

    it('does not contain "p pause" for task detail', () => {
      const { lastFrame } = render(
        <Footer viewKind="detail" entityType="tasks" entityStatus="running" />,
      );
      expect(lastFrame()).not.toContain('p pause');
      expect(lastFrame()).not.toContain('p resume');
    });
  });
  ```

### 8. Missing Unit Tests for `detailHints()` Status-Conditional Logic — 82% Confidence
**File**: `src/cli/dashboard/keyboard/hints.ts` (no test file exists)
**Reviewers**: Testing

- **Problem**: The `detailHints()` function has branching logic based on `entityType` and `entityStatus` (lines 28-36). This pure logic deserves direct unit tests, not just indirect coverage via keyboard integration tests. The hint text rendering (what users see) is a user-facing concern.

- **Suggested Fix**: Create `tests/unit/cli/dashboard/hints.test.ts`:
  ```typescript
  import { describe, expect, it } from 'vitest';
  import { detailHints, getHints, mainHints } from '../../../../src/cli/dashboard/keyboard/hints.js';

  describe('detailHints', () => {
    it('includes "p pause" for schedules with status active', () => {
      expect(detailHints('schedules', 'active')).toContain('p pause');
    });
    it('includes "p resume" for loops with status paused', () => {
      expect(detailHints('loops', 'paused')).toContain('p resume');
    });
    it('omits pause/resume for tasks', () => {
      const result = detailHints('tasks', 'running');
      expect(result).not.toContain('p pause');
      expect(result).not.toContain('p resume');
    });
    it('omits pause/resume when no entity type', () => {
      expect(detailHints()).not.toContain('p pause');
    });
  });
  ```

---

## Should-Fix Issues (Code You Touched)

### 1. Stale JSDoc Comment in domain.ts Referencing "workspace view" — 85% Confidence
**File**: `src/core/domain.ts:885`
**Reviewer**: Regression

- **Problem**: The `OrchestratorChild` interface JSDoc says "ARCHITECTURE: Read-only projection used by workspace view." The workspace view no longer exists; this interface is now used by the orchestration detail children list. The comment creates confusion about what consumes this type.

- **Suggested Fix**: Update to:
  ```typescript
  /**
   * ARCHITECTURE: Read-only projection used by orchestration detail view.
   */
  ```

### 2. Fire-and-Forget Async in `handlePauseResume` Without Comment — 82% Confidence
**File**: `src/cli/dashboard/keyboard/handle-detail-keys.ts:114, 119`
**Reviewer**: Reliability

- **Problem**: `handlePauseResume` calls `void pauseOrResumeEntity(...)` without a comment explaining the intentional promise ignoring. The `pauseOrResumeEntity` function itself has the catch-all rationale, but the call site lacks context. This is consistent with the existing `cancelEntity`/`deleteEntity` pattern but less documented than it could be.

- **Suggested Fix**: This is already handled correctly by `pauseOrResumeEntity`'s internal try/catch. The `void` prefix is the correct pattern. Optionally add a clarifying comment at the call site:
  ```typescript
  // Fire-and-forget; pauseOrResumeEntity catches errors to prevent TUI crashes
  void pauseOrResumeEntity(...);
  ```

---

## Pre-existing Issues (Not Blocking)

### 1. `handlePauseResume` Consumes 'p' Key Even When `mutations` Absent — 80% Confidence
**File**: `src/cli/dashboard/keyboard/handle-detail-keys.ts:109`
**Reviewers**: TypeScript, React

- **Problem**: When `input === 'p'` in detail view but `mutations` is undefined, the function returns `true` at line 109, consuming the 'p' key even without mutations. This prevents downstream handlers from processing it. However, 'p' is not used by downstream handlers (loop/orchestration navigation, generic scroll), so the behavior is acceptable. Informational only.

---

## Summary Statistics

- **Total Issues**: 11 (8 blocking, 2 should-fix, 1 pre-existing)
- **Reviewers Reporting Same Issue**: High deduplication
  - Nested ternary in app.tsx: 6 reviewers (100% confidence after dedup)
  - Footer hints string types: 2 reviewers (85% baseline → 95% after boost)
  - CLAUDE.md workspace reference: 5 reviewers (100% baseline)
  - Main view hint UI: 2 reviewers (85% baseline)
  - Missing tests: 1-2 reviewers per gap

- **Confidence Calculation**: Baseline confidence + 10% boost per additional reviewer reporting the same issue (capped at 100%)
  - Example: Nested ternary (Architecture 85%, Performance 82%, Complexity 85%, React 82%, TypeScript 80%, UI-Design 82%) → 85% baseline, 5 additional reviewers → 85% + (5 × 10%) = 135% capped at 100%

---

## Strengths

1. **Architecture**: Workspace removal is thorough and consistent. All type unions narrowed correctly; no orphaned references.
2. **Test Coverage**: 651 dashboard tests pass. New `pauseOrResumeEntity` has 9 unit tests + 10 integration tests. Workspace test cleanup (4 files, ~1,500 LOC) is complete.
3. **Pattern Consistency**: `pauseOrResumeEntity` mirrors `cancelEntity`/`deleteEntity` in signature, error handling, refresh pattern. Keyboard handlers follow established conventions.
4. **Type Safety**: The `ViewState` union properly narrowed from 3 variants to 2. `exhaustive: never` checks confirm no dead branches.
5. **Performance Gain**: Eliminated 750ms workspace poll interval and `fetchWorkspaceExtras()` queries. Net positive for DB load and memory.

---

## Action Plan

1. **Extract entityStatus to named variable or useMemo** (app.tsx:204-212) — improves readability and performance
2. **Fix JSDoc numbering** (handle-detail-keys.ts) — 10 minutes
3. **Update dispatcher comment** (handle-detail-keys.ts:342-347) — 5 minutes
4. **Remove workspace reference from CLAUDE.md** (line 297) — 2 minutes
5. **Fix main view hint to conditionally show p pause/resume** (hints.ts) — depends on addressing #1
6. **Add footer and hints unit tests** (footer.test.tsx + hints.test.ts) — 30 minutes
7. **Update domain.ts comment** (domain.ts:885) — 1 minute
8. **Add comment to handlePauseResume** (handle-detail-keys.ts) — optional, 2 minutes

**Total estimated remediation time**: ~60 minutes

---

## Reviewer Breakdown

| Focus | Status | Key Findings |
|-------|--------|--------------|
| Security | APPROVED | No vulnerabilities detected (9/10) |
| Architecture | APPROVED_WITH_CONDITIONS | 2 MEDIUM blocking + 1 MEDIUM should-fix |
| Performance | APPROVED | 1 MEDIUM blocking; net positive on removal (9/10) |
| Complexity | APPROVED_WITH_CONDITIONS | 1 MEDIUM blocking (nested ternary) |
| Consistency | APPROVED_WITH_CONDITIONS | 2 MEDIUM blocking (JSDoc numbering, dispatcher comment) |
| Regression | APPROVED_WITH_CONDITIONS | 2 MEDIUM blocking (CLAUDE.md, domain.ts comment) |
| Testing | APPROVED_WITH_CONDITIONS | 2 MEDIUM blocking (footer tests, hints tests) |
| Reliability | APPROVED | 2 findings (1 should-fix, 1 pre-existing) |
| TypeScript | APPROVED_WITH_CONDITIONS | 2 MEDIUM blocking (type safety, render path) |
| React | APPROVED_WITH_CONDITIONS | 1 MEDIUM blocking + 1 should-fix |
| Accessibility | APPROVED_WITH_CONDITIONS | 2 MEDIUM (main view hint feedback, no action feedback) |
| UI-Design | APPROVED_WITH_CONDITIONS | 2 MEDIUM (main view hint, nested ternary) |

---

**Next Step**: Address the 8 blocking issues, then re-run focused review on modified sections before merge.
