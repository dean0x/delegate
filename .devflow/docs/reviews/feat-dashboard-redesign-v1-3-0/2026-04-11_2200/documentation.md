# Documentation Review Report

**Branch**: feat/dashboard-redesign-v1.3.0 -> main
**Date**: 2026-04-11 22:00
**Reviewer**: documentation
**PR**: dean0x/autobeat#133

---

## Issues in Your Changes (BLOCKING)

### CRITICAL

**`package.json` version not bumped to 1.3.0** — Confidence: 100%
- Location: `/Users/dean/Sandbox/autobeat/package.json:3`
- Problem: `package.json` still declares `"version": "1.2.0"` while every other release artifact (CHANGELOG.md `## [1.3.0] - 2026-04-11`, `RELEASE_NOTES_v1.3.0.md`, `docs/releases/RELEASE_NOTES.md` listing v1.3.0 as "Latest Release", `docs/ROADMAP.md` "Current Status: v1.3.0 RELEASED", `docs/FEATURES.md` "## Dashboard Redesign (v1.3.0)") has been updated for 1.3.0. Per CLAUDE.md Release Process §9 ("Gotchas"), the release workflow hard-fails if `npm view autobeat version` equals `package.json` version, and the workflow is `workflow_dispatch` only. If this PR is merged and the workflow triggered without bumping `package.json`, the workflow will fail because:
  1. CLAUDE.md says `package.json` version "must be bumped BEFORE triggering the workflow"
  2. The `Files to Update` table marks `package.json + package-lock.json` as required (✅)
- Impact: Release will not publish. CHANGELOG.md and ROADMAP.md will be lying about the released state.
- Fix: Run `npm version 1.3.0 --no-git-tag-version` to bump both `package.json` and `package-lock.json` atomically. Commit the change as part of this branch before merging.

**Release notes reference non-existent PR numbers (#134, #135)** — Confidence: 99%
- Location: `/Users/dean/Sandbox/autobeat/docs/releases/RELEASE_NOTES_v1.3.0.md:251-258`
- Problem: The "What's Changed Since v1.2.0" section attributes 9 entries to PRs `#135` and `#134`. The actual PR for this branch is **#133** (`feat: dashboard redesign v1.3.0`), and `gh pr view 134` / `gh pr view 135` both return `Could not resolve to a PullRequest with the number of 134/135`. These PR numbers do not exist.
- Lines containing the wrong references:
  - Line 251: `(#135)` — dashboard redesign
  - Line 252: `(#135)` — output streaming
  - Line 253: `(#135)` — cost tracking
  - Line 254: `(#135)` — orchestrator_id
  - Line 255: `(#135)` — cancel cascade
  - Line 256: `(#135)` — responsive layout
  - Line 257: `(#135)` — ActivityPanel fix
  - Line 258: `(#134)` — zombie orchestration
  - Line 259: `(#134)` — orchestration creation failure
- Impact: Once published as a GitHub Release, every link in the "What's Changed" section will be broken. Users clicking through to learn more will hit 404s. This is exactly the kind of "actively misleading" documentation flagged by the documentation Iron Law.
- Fix: Replace all `(#135)` and `(#134)` references with `(#133)`, since this branch contains all of the fixes/features listed (the dashboard redesign, the orchestration recovery fixes, etc., are all part of the same branch). Verify by running `git log --oneline main...HEAD` to confirm scope.

**Layout mode thresholds in release notes do not match code** — Confidence: 99%
- Location: `/Users/dean/Sandbox/autobeat/docs/releases/RELEASE_NOTES_v1.3.0.md:170-174` vs `/Users/dean/Sandbox/autobeat/src/cli/dashboard/layout.ts:64-95`
- Problem: The "Responsive Layout" section in the release notes states:

  | Mode | Condition (release notes) | Actual code (`computeMetricsLayout`) |
  |------|---------------------------|---------------------------------------|
  | `full` | ≥ 80 cols × 20 rows | ≥ 60 cols AND ≥ 14 rows |
  | `narrow` | < 80 cols | < 60 cols (when rows ≥ 14) |
  | `too-small` | < 60 cols **or** < 14 rows | < 14 rows (column count is irrelevant) |

  Specifically (`layout.ts:78-84`):
  ```typescript
  if (rows < 14) {
    mode = 'too-small';
  } else if (columns < 60) {
    mode = 'narrow';
  } else {
    mode = 'full';
  }
  ```

  The release notes get all three thresholds wrong:
  1. `full` threshold is 60 cols × 14 rows, not 80 × 20
  2. `narrow` threshold is < 60 cols, not < 80 cols
  3. `too-small` is rows-only (< 14), not "cols < 60 OR rows < 14"
- Impact: A user on an 80-column terminal who reads "≥ 80 cols × 20 rows for full mode" will expect tile + panel layout. They will get it (because the actual `full` threshold is 60 × 14), but anyone trying to debug the dashboard or tune their terminal will be misled. Worse, a user on a 65-column terminal will incorrectly expect `narrow` mode.
- Fix: Update the release notes table to:

  ```markdown
  | Mode | Condition | Behavior |
  |------|-----------|---------|
  | `full` | ≥ 60 cols and ≥ 14 rows | Normal tile + panel layout |
  | `narrow` | < 60 cols and ≥ 14 rows | Single-column stack, tiles only |
  | `too-small` | < 14 rows | Resize prompt |
  ```

  Optionally also add a note about the workspace layout (`columns < 50 || rows < 15` triggers `too-small` workspace mode).

### HIGH

**`g` / `G` keybinding description is incorrect/incomplete** — Confidence: 92%
- Location: `/Users/dean/Sandbox/autobeat/docs/releases/RELEASE_NOTES_v1.3.0.md:82` (Workspace View key table)
- Problem: The release notes table says:
  ```
  | `g` / `G` | Jump to top / re-engage auto-tail |
  ```
  This conflates two distinct keys into a single description. Reading the code (`use-keyboard.ts:489-522`):
  - `g` — Jumps to top **and disables** auto-tail (`autoTailEnabled: false`)
  - `G` — Jumps to bottom **and re-engages** auto-tail (`autoTailEnabled: true`)

  The release notes never mention "jump to bottom" and never tell users that `g` disables auto-tail. The combined slash phrasing (`Jump to top / re-engage auto-tail`) reads as if those are alternative descriptions of the same behavior, not two different keys.
- Impact: Users will be surprised when `G` jumps to the bottom of the buffer (the convention from vi/less is `g` = top, `G` = bottom — release notes should follow the same convention). Users will also not know that `g` disables auto-tail until they hit it.
- Fix: Split the row into two:
  ```markdown
  | `g` | Jump to top of focused task panel (disables auto-tail) |
  | `G` | Jump to bottom and re-engage auto-tail |
  ```

**`UsageCaptureHandler` not documented in `docs/architecture/EVENT_FLOW.md`** — Confidence: 90%
- Location: `/Users/dean/Sandbox/autobeat/docs/architecture/EVENT_FLOW.md:430` (Handler Types table)
- Problem: The Handler Types table in EVENT_FLOW.md lists Standard handlers (PersistenceHandler, QueueHandler, WorkerHandler) and Factory handlers (DependencyHandler, ScheduleHandler, CheckpointHandler). The new `UsageCaptureHandler` (introduced in this PR) uses the same factory pattern (`UsageCaptureHandler.create()` per `usage-capture-handler.ts:50`) but is not listed. Likewise, the `OrchestrationHandler` (introduced earlier) is also missing — pre-existing gap, but the v1.3.0 release is the right time to fix it.
- Impact: Architecture document drifts further from reality. New developers cannot use it as a reliable index of handlers. The "key handlers" list in CLAUDE.md (lines 54-61) also omits UsageCaptureHandler and OrchestrationHandler.
- Fix:
  1. Add `UsageCaptureHandler` to the Factory column in EVENT_FLOW.md:430:
     ```
     | **Factory** | DependencyHandler, ScheduleHandler, CheckpointHandler, OrchestrationHandler, UsageCaptureHandler | Requires async initialization |
     ```
  2. Add UsageCaptureHandler to the CLAUDE.md "Key Pattern" handlers list (CLAUDE.md:54-61):
     ```
     - `UsageCaptureHandler` → captures Claude token/cost usage on TaskCompleted
     ```
  3. Add a brief event flow diagram for `TaskCompleted → UsageCaptureHandler → UsageRepository` similar to how the release notes show it.

**Missing keybindings in `docs/FEATURES.md` v1.3.0 keybinding table** — Confidence: 88%
- Location: `/Users/dean/Sandbox/autobeat/docs/FEATURES.md:18-28`
- Problem: The "New Keyboard Shortcuts (v1.3.0)" table in FEATURES.md is incomplete relative to the release notes and the actual implementation. Missing:
  - `g` / `G` — jump to top/bottom of task output panel
  - `c` — cancel cascade (orchestration in nav, child task in grid, entity in activity feed)
  - `PgUp` / `PgDn` — page through task grid (`use-keyboard.ts:524-540`)
  - `Tab` / `Shift+Tab` workspace cycling (between nav and grid)
  - `1`–`9` panel jump in workspace grid (`use-keyboard.ts:436-444`)
  - `d` — delete terminal entities from activity feed (`use-keyboard.ts:771-808`)

  The release notes list most of these (except `d` and `1-9`), but FEATURES.md is supposed to be the authoritative feature list per CLAUDE.md ("docs/FEATURES.md - Complete feature list").
- Impact: A user reading FEATURES.md to learn what the v1.3.0 dashboard can do will not discover these shortcuts. They will need to read release notes (which themselves omit `d` and `1-9`).
- Fix: Add the missing rows. Recommended additions:
  ```markdown
  | `g` / `G` | Jump to top / bottom of focused task panel (G re-engages auto-tail) |
  | `c` | Cancel: orchestration (with cascade) / child task / activity-focused entity |
  | `PgUp` / `PgDn` | Page through task grid in workspace |
  | `Tab` / `Shift+Tab` (workspace) | Cycle between orchestration nav and task grid |
  | `1`–`9` (workspace grid) | Jump to grid panel by number |
  | `d` (activity focus) | Delete focused entity (terminal status only) |
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Stale `// ARCHITECTURE` comment in `workspace-types.ts` references "main-view"** — Confidence: 90%
- Location: `/Users/dean/Sandbox/autobeat/src/cli/dashboard/workspace-types.ts:3`
- Problem: The ARCHITECTURE comment says: `Separate from NavState to keep main-view reducer independent`. The release notes explicitly call out that `main-view.tsx` was deleted as a breaking change. The comment now references a deleted file. New developers reading this file will be confused by the dangling reference.
- Impact: Documentation drift inside source code. Comments that contradict the codebase erode trust in all comments.
- Fix: Update the comment to reference the new module name:
  ```typescript
  /**
   * Workspace view navigation state
   * ARCHITECTURE: Separate from NavState to keep MetricsView reducer independent
   * Pattern: Immutable state with factory function for initialization
   */
  ```

**`CHANGELOG.md` 1.3.0 entry missing PR/issue references** — Confidence: 82%
- Location: `/Users/dean/Sandbox/autobeat/CHANGELOG.md:11-33`
- Problem: Every prior CHANGELOG entry from v1.0.0 onward includes PR references like `(#131)`, `(#130)`, `(#114)`, but the new v1.3.0 entry has none. This is inconsistent with the established CHANGELOG style. Compare to v1.2.0 (line 40) and v0.7.0 (line 198).
- Impact: CHANGELOG drifts in style across versions. Readers cannot trace changes back to specific PRs from CHANGELOG alone (must fall back to release notes — which themselves reference wrong PR numbers, see CRITICAL above).
- Fix: After fixing the PR-number issue in the release notes, add `(#133)` to each Added/Changed/Fixed/Breaking bullet in the CHANGELOG.md v1.3.0 section. Example:
  ```markdown
  - **Dashboard Redesign**: Two-view dashboard (#133)
  ```

**`docs/FEATURES.md` "v0.6.0 Hybrid Event Model" architecture section says "34 events"** — Confidence: 78%
- Location: `/Users/dean/Sandbox/autobeat/docs/FEATURES.md:273`
- Problem: The line states `Singleton EventBus: Shared event bus across all system components (34 events)`. Counting `^export interface .*Event` in `src/core/events/events.ts` returns 35 (excluding `BaseEvent`). The count was 34 after v1.0.0 (per memory: "3 new events (34 total)"), and `LoopPaused`/`LoopResumed` from v0.8.0 plus subsequent additions take the count higher. This is technically pre-existing drift, but since FEATURES.md is being touched in this PR, updating it would be appropriate.
- Impact: Stale count in feature documentation. Low priority — readers rarely care about exact event counts — but it's incorrect.
- Fix: Either count events accurately and update to `(35 events)`, or remove the parenthetical to avoid future drift: `Singleton EventBus: Shared event bus across all system components`.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`docs/architecture/EVENT_FLOW.md` is stale beyond just UsageCaptureHandler** — Confidence: 85%
- Location: `/Users/dean/Sandbox/autobeat/docs/architecture/EVENT_FLOW.md` (entire document)
- Problem: EVENT_FLOW.md mentions handlers up to and including `CheckpointHandler` but predates `LoopHandler`, `OrchestrationHandler`, and now `UsageCaptureHandler`. The "Centralized Handler Setup (v0.3.4+)" section is also out of date. Since the file is `architecture/` documentation, not part of the v1.3.0 changeset, it is informational only. But the v1.3.0 release adds yet another handler that should eventually be documented here.
- Fix (separate PR): Refresh `EVENT_FLOW.md` with the current handler set (Persistence, Queue, Worker, Dependency, Schedule, Checkpoint, Loop, Orchestration, UsageCapture).

## Suggestions (Lower Confidence)

- **Consider documenting `OUTPUT_FLUSH_INTERVAL_MS` env var in FEATURES.md** - `docs/FEATURES.md:186-192` (Confidence: 70%) — The "Environment Variables" section already lists `TASK_TIMEOUT`, `MAX_OUTPUT_BUFFER`, `CPU_THRESHOLD`, `MEMORY_RESERVE`, `LOG_LEVEL`. The new `OUTPUT_FLUSH_INTERVAL_MS` (mentioned in release notes as a way to opt out of the new 1000ms default) should join the list to maintain completeness.
- **CHANGELOG.md `[Unreleased]` section is empty** - `CHANGELOG.md:7-9` (Confidence: 65%) — Per Keep-a-Changelog convention, `[Unreleased]` should be present as a placeholder, which it is. Minor nit: there is no body content under it. Some projects add a placeholder comment like `<!-- Add unreleased changes here -->`. Optional.
- **`docs/releases/RELEASE_NOTES_v1.3.0.md` Activity Feed Navigation table omits `d` (delete)** - `RELEASE_NOTES_v1.3.0.md:43-55` (Confidence: 70%) — The Activity Feed Navigation table lists Tab/↑/↓/Enter/Esc/Shift+Tab but omits `d` for deleting a terminal entity from the activity feed (`use-keyboard.ts:771-808`). Could be intentional (advanced/dangerous), but worth a callout.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 3 | 3 | 0 | - |
| Should Fix | - | 0 | 3 | - |
| Pre-existing | - | - | 1 | - |

**Documentation Score**: 6/10
**Recommendation**: **CHANGES_REQUESTED**

**Blocking summary**:
1. `package.json` MUST be bumped to 1.3.0 before merging — release workflow will hard-fail otherwise.
2. PR number references in `RELEASE_NOTES_v1.3.0.md` must be corrected from `#134`/`#135` to `#133`.
3. Layout mode threshold table in release notes must match code (60×14, not 80×20).

The release artifacts (CHANGELOG, FEATURES, ROADMAP, RELEASE_NOTES) are otherwise present, well-organized, and follow the established v1.2.0 template. The new dashboard features are documented thoroughly in the release notes with code examples and architecture diagrams. After the three CRITICAL items are fixed, this is publish-ready.
