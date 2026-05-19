# Testing Review Report

**Branch**: feat/166-167-dashboard-cleanup -> main
**Date**: 2026-05-14

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Missing footer hint tests for new pause/resume behavior** - `tests/unit/cli/dashboard/footer.test.tsx`
**Confidence**: 85%
- Problem: The Footer component gained three new props (`entityType`, `entityStatus`) and the hint text now changes contextually (showing "p pause" vs "p resume" vs nothing depending on entity type/status). The footer test file was only updated to remove the workspace tests but no new tests were added for the conditional pause/resume hints or the new props. The `mainHints` function also gained "p pause/resume" text when `hasMutations=true`, which is not covered by an existing assertion.
- Fix: Add tests to `footer.test.tsx` covering the new behaviors:
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

**Missing `detailHints()` unit tests for status-conditional logic** - `src/cli/dashboard/keyboard/hints.ts`
**Confidence**: 82%
- Problem: The `detailHints()` function now has branching logic based on `entityType` and `entityStatus` (lines 28-36). This is pure logic that deserves direct unit tests. While the integration-level keyboard tests cover the behavior indirectly through the `p` key, the hint text generation itself (which determines what the user sees in the footer) is untested. There is no `hints.test.ts` file.
- Fix: Either add a dedicated `hints.test.ts` or expand the footer tests. A dedicated test file would follow the project's existing pattern of testing pure functions directly:
  ```typescript
  // tests/unit/cli/dashboard/hints.test.ts
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

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

_No critical pre-existing issues found._

## Suggestions (Lower Confidence)

- **`cancelSchedule` status check missing in `pauseOrResumeEntity`** - `src/cli/dashboard/keyboard/entity-mutations.ts:103` (Confidence: 65%) -- The `ScheduleStatus.CANCELLED` status is not explicitly guarded against in the schedule case of `pauseOrResumeEntity`, relying on the implicit fall-through of neither ACTIVE nor PAUSED matching. The existing `cancelEntity` explicitly checks terminal statuses. The current implementation is correct but less defensive.

- **Keyboard integration test: `p` key on pipelines panel not tested** - `tests/unit/cli/dashboard/use-keyboard.test.tsx` (Confidence: 62%) -- The `p` key tests cover schedules, loops, tasks, and orchestrations but do not explicitly test what happens when `p` is pressed while the pipelines panel is focused. The implementation handles it correctly (falls through to no-op via the `default` case in `pauseOrResumeEntity`), but an explicit test would prevent regression if pipelines gain pause/resume support.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Testing Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Assessment

This PR demonstrates strong testing discipline overall:

**Strengths:**
- **Thorough deletion of dead tests**: 4 test files and ~1,500 lines of workspace-related tests correctly removed alongside the source code they tested. No zombie tests remain.
- **New `entity-mutations.test.ts`** (9 tests): Covers all pause/resume paths -- active/paused schedules, running/paused loops, terminal status skips, non-pauseable kinds (task, orchestration), and error swallowing. Follows the project's behavior-focused testing pattern.
- **Expanded `use-keyboard.test.tsx`** (10 new integration tests): Covers `p` key in both main view (schedule pause, schedule resume, loop pause, loop resume) and detail view (schedule pause/resume, loop pause/resume), plus negative cases (task detail no-op, no mutations context). Uses the same `press()` + `makeMutations()` pattern established by the existing c/d tests.
- **Clean test updates**: `nav-reducer.test.ts`, `layout.test.ts`, `footer.test.tsx`, `header.test.tsx`, `orchestration-detail.test.tsx`, `use-dashboard-data.test.ts` all correctly updated to remove workspace references without leaving stale assertions. Tests trimmed from 200+ to relevant assertions only for layout.
- **All 651 dashboard tests pass** with the changes.

**Gaps (the two MEDIUM findings):**
- Footer tests do not cover the new `entityType`/`entityStatus` props or the "p pause/resume" hint in the main view mutations block.
- The `detailHints()` pure function has untested branching logic for status-conditional hint text.

These are not blocking because the keyboard integration tests provide indirect coverage of the pause/resume behavior, but the hint text rendering itself is a user-facing concern that warrants direct test coverage. `avoids PF-001` -- flagging gaps for resolution rather than deferring.
