# Testing Review Report

**Branch**: feat/177-agent-adapter-migration -> main
**Date**: 2026-05-19

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Migration v28 test simulates UPDATE manually instead of running the actual migration** - `tests/unit/implementations/database.test.ts:449-472`
**Confidence**: 85%
- Problem: The `tasks.agent=gemini rows are mapped to NULL by migration` test creates a fresh in-memory DB (which runs all 28 migrations), then inserts a row with `agent='gemini'`, then manually executes `UPDATE tasks SET agent = NULL WHERE agent = 'gemini'`. However, a fresh in-memory DB already runs migration v28 during construction, so by the time the test inserts `agent='gemini'`, the UPDATE from v28 has already completed. The test is verifying that a manually-run UPDATE works, not that migration v28 correctly maps existing gemini rows during upgrade. This test would pass even if migration v28's UPDATE statement were removed -- the manual exec always runs. The test correctly proves the SQL statement works in isolation, but does not prove v28.up() actually executes it at migration time.
- Fix: To properly test this, you would need to create a DB that stops at v27, seed the `agent='gemini'` row, then apply v28 and verify the row was migrated. The current Database constructor does not support partial migration. Given the migration SQL is straightforward (`UPDATE tasks SET agent = NULL WHERE agent = 'gemini'`), the test as-written provides reasonable assurance that the SQL is correct, but the test name and comments are misleading about what is actually being validated.

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

_No issues found._

## Suggestions (Lower Confidence)

- **Adapter dispose not called on error path in unsupported provider guard test** - `tests/unit/implementations/build-tmux-command.test.ts:430-460` (Confidence: 65%) -- The `FakeAdapter` instantiated for the unsupported provider test never calls `dispose()`. While `dispose()` only clears kill timeouts (none are set in this test path), for consistency with the pattern established in other describe blocks, adding `adapter.dispose()` after the assertion would be cleaner.

- **Missing test for judge_agent='gemini' -> NULL mapping in loops table via actual CASE WHEN** - `tests/unit/implementations/database.test.ts:373-447` (Confidence: 70%) -- The v28 migration test section validates that gemini INSERTs fail (CHECK constraint) and that claude/codex/NULL INSERTs succeed, but does not test the `CASE WHEN judge_agent = 'gemini' THEN NULL ELSE judge_agent END` transformation in the INSERT...SELECT. A test that seeds a loop with `judge_agent='gemini'` at v22 and verifies it becomes NULL after v28 would be ideal, but the same migration-ordering limitation applies as with the tasks.agent test above.

- **`it.each` factory creates adapter outside lifecycle hooks** - `tests/unit/implementations/build-tmux-command.test.ts:394-409` (Confidence: 62%) -- The `it.each` approach creates the adapter inside the test body and calls `dispose()` inline. This is correct but diverges from the `beforeEach`/`afterEach` lifecycle pattern used in surrounding describe blocks. If the assertion throws before `dispose()`, the adapter leaks. Using a shared lifecycle hook pattern would be more robust.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Testing Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Rationale

The test changes in this PR are well-structured and follow established project patterns:

1. **buildTmuxCommand tests** (build-tmux-command.test.ts): Comprehensive coverage of the new `buildTmuxCommand()` method across ClaudeAdapter, CodexAdapter, ProxiedClaudeAdapter, ProcessSpawnerAdapter, and unsupported provider guard. The tests validate behavior (return shape, arg inclusion/exclusion, error codes) rather than implementation details. The `it.each` consolidation for the taskId guard is clean and avoids code duplication (avoids PF-001 -- issues are addressed, not deferred). Good use of the existing mock infrastructure and adapter lifecycle management.

2. **Database migration tests** (database.test.ts): The v28 migration section covers the essential constraint validation (gemini rejected, claude/codex/NULL accepted), index recreation, and column preservation. The tasks.agent migration test has a methodology gap (tests the SQL statement in isolation rather than the migration itself) but the SQL being tested is simple enough that this provides adequate confidence.

3. **Resource cleanup**: The PR correctly moves adapter instantiation into `beforeEach`/`afterEach` lifecycle hooks in the "return shape" describe block, fixing a pre-existing leak where adapters were created inline without disposal.

4. **Mock isolation**: The detailed comments about `isolate: false` and vi.mock deduplication are valuable -- they document a real Vitest footgun and explain why the CLI-not-in-PATH error path is intentionally not duplicated here (covered in agent-adapters.test.ts).

The one blocking MEDIUM item is about test fidelity (the migration test name implies it tests the migration but actually tests a manually-run SQL statement). This does not affect correctness -- the migration SQL is trivially correct -- but the test provides weaker guarantees than its documentation suggests.
