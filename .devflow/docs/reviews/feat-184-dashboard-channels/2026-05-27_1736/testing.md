# Testing Review Report

**Branch**: feat-184-dashboard-channels -> main
**Date**: 2026-05-27T17:36

## Issues in Your Changes (BLOCKING)

### HIGH

**Missing tests for channel entity mutations (cancel/destroy, pause/resume, delete)** - `src/cli/dashboard/keyboard/entity-mutations.ts:84-211`
**Confidence**: 90%
- Problem: Three new `case 'channel':` branches were added to `cancelEntity()`, `pauseOrResumeEntity()`, and `deleteEntity()` (lines 84-94, 138-145, 202-211). These are non-trivial mutation paths with status guards and optional `channelService`/`channelRepo` checks, but no tests exist for any of them. The pre-existing `entity-mutations.test.ts` file covers the other 5 entity kinds but has zero channel test cases. This is NEW code that should be tested before merge.
- Fix: Add test cases to `tests/unit/cli/dashboard/entity-mutations.test.ts` covering:
  1. `cancelEntity('channel', ...)` calls `channelService.destroyChannel` when status is not destroyed/completed
  2. `cancelEntity('channel', ...)` is a no-op when status is already destroyed
  3. `cancelEntity('channel', ...)` is a no-op when `channelService` is undefined
  4. `pauseOrResumeEntity('channel', ...)` calls `pauseChannel` when active
  5. `pauseOrResumeEntity('channel', ...)` calls `resumeChannel` when paused
  6. `deleteEntity('channel', ...)` calls `channelRepo.delete` only when status is destroyed/completed

### MEDIUM

**Missing tests for channel detail keyboard navigation (member up/down)** - `src/cli/dashboard/keyboard/handle-detail-keys.ts:292-319`
**Confidence**: 85%
- Problem: A new `handleChannelNavigation()` function (lines 292-319) was added that handles up/down arrow keys to cycle `channelMemberSelectedName` through channel members. This function contains boundary logic (empty members guard, index clamping). No integration tests via `use-keyboard.test.tsx` or unit tests exercise these code paths. The existing keyboard test only verifies `channelMemberSelectedName: null` in the initial state and the Tab panel cycling includes channels -- but no test enters a channel detail view and presses up/down.
- Fix: Add tests to `use-keyboard.test.tsx` (or a dedicated `handle-detail-keys.test.ts`) covering:
  1. Up/down arrows in channel detail cycle `channelMemberSelectedName` through member names
  2. Up/down arrows with zero members are no-ops
  3. `p` key in channel detail calls pause/resume on the channel

**Missing tests for channel detail pause/resume via detail-keys 'p'** - `src/cli/dashboard/keyboard/handle-detail-keys.ts:121-125`
**Confidence**: 85%
- Problem: Lines 121-125 added a `channels` branch to the detail-view pause/resume handler that finds the channel from data and calls `pauseOrResumeEntity('channel', ...)`. This path is untested. The hint tests confirm the UI shows "p pause/resume" for channels, but no test exercises the actual keypress handler.
- Fix: Add integration test in `use-keyboard.test.tsx` or unit test for `handleDetailKeys` that verifies pressing `p` in a channel detail view triggers `pauseChannel`/`resumeChannel` on the channel service.

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

_No CRITICAL pre-existing issues found in reviewed files._

## Suggestions (Lower Confidence)

- **`useChannelPanePreview` — error result state not observable in tests** - `tests/unit/cli/dashboard/use-channel-pane-preview.test.ts:182-196` (Confidence: 70%) — The test verifies `captureFn` is called when it returns an error, and that throwing does not crash. However, the `error` field on the hook result is never asserted to equal `'(session not responding)'` after an err result. Verifying the actual error state would strengthen coverage.

- **No test for `handleMainKeys` Enter key drilling into channel detail** - `src/cli/dashboard/keyboard/handle-main-keys.ts:146-153` (Confidence: 65%) — The `case 'channels':` branch in the Enter handler (line 146-153) that sets view to channel detail is not directly tested. The Tab cycling tests confirm channels appear in panel order, but no test presses Enter on a channel item to verify the view transition. Existing tests cover Enter for other entity types (tasks, loops, etc.) but skip channels.

- **ChannelMessagePersistenceHandler: no test for `saveResult.ok === false` path** - `src/services/handlers/channel-message-persistence-handler.ts:100-105` (Confidence: 65%) — The handler gracefully handles save failures by logging a warning and returning `ok(undefined)`. No test exercises this path (e.g., passing a message with a duplicate ID or invalid FK). The error path is simple and best-effort, but a test would prevent regression if the error handling changes.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Testing Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

### Rationale

The PR introduces substantial new test coverage: 8 new test files and significant additions to 6 existing test files, totaling roughly 1,400 new test lines. Coverage for the repository layer (`channel-repository.test.ts` with 25 tests covering CRUD, constraints, atomicity, messages, and performance), the event handler (`channel-message-persistence-handler.test.ts` with 7 behavior-focused tests), the dashboard data hook (`use-dashboard-data.test.ts` with 7 new channel tests), the detail view component (`channel-detail.test.tsx` with 30+ tests), and the activity feed (`activity-feed.test.ts` with 10 channel verb mapping tests) are thorough and follow the project's behavior-driven testing patterns.

The main gap is the keyboard mutation layer: three new `case 'channel':` branches in `entity-mutations.ts` (cancel/destroy, pause/resume, delete) with status guards and optional service checks have zero test coverage. This is the highest-risk untested path because mutation bugs can destroy user data. The entity-mutations test file already covers the other 5 entity kinds in the same pattern, so adding channel cases is straightforward and consistent (applies ADR-003 reasoning -- but these are new changes, not pre-existing).

Secondary gaps are the channel detail keyboard navigation (member cycling via up/down) and the detail-view pause/resume handler, both added in `handle-detail-keys.ts`. These are lower risk (UI navigation, not data mutation) but still represent untested new logic.

The existing new tests follow good practices: behavior-driven assertions on rendered output (not implementation), proper use of fake timers for polling tests, real in-memory SQLite for repository tests, proper AAA structure, and clean fixture factories. Test names clearly describe expected behavior. No red flags (private method spying, complex setup, brittle assertions).
