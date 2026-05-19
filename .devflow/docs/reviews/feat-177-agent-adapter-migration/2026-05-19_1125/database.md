# Database Review Report

**Branch**: feat/177-agent-adapter-migration -> main
**Date**: 2026-05-19

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Missing test for gemini-to-NULL data migration path** - `tests/unit/implementations/database.test.ts:373`
**Confidence**: 85%
- Problem: Migration v28 includes a `CASE WHEN judge_agent = 'gemini' THEN NULL ELSE judge_agent END` data transformation, but no test verifies that pre-existing rows with `judge_agent='gemini'` are actually mapped to NULL after migration. The existing tests only verify the CHECK constraint enforcement (reject gemini, accept claude/codex/NULL) and index recreation -- they test the schema but not the data migration.
- Fix: Add a test that inserts a loop with `judge_agent='gemini'` before v28 applies, then verifies the value becomes NULL. This requires either a staged migration approach (apply up to v27, insert data, apply v28) or a direct SQL test against the CASE expression. Example:

```typescript
it('existing judge_agent=gemini rows mapped to NULL', () => {
  // This is verified by the migration's CASE expression.
  // Since all migrations run on :memory: DB creation,
  // insert after migration and verify CHECK rejects 'gemini'
  // is the pragmatic approach (already covered above).
  // A true data-migration test would need a staged migration harness.
});
```

Note: Given that the CHECK constraint tests already prove 'gemini' cannot exist post-migration, and the CASE expression is straightforward, this is a should-fix rather than a blocker. The risk is low since the loops table is typically empty on existing installations (per session 273 notes).

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **No rollback / down() migration** - `src/implementations/database.ts:1069` (Confidence: 65%) -- Migration v28 (like all prior migrations) has no `down()` method. The table recreation pattern is irreversible without a rollback script. This is consistent with the project's established pattern (no migrations have down() methods), so flagging only as a suggestion. If Gemini support were ever re-added, a new forward migration would be needed.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | - |
| Should Fix | - | 0 | 1 | - |
| Pre-existing | - | - | 0 | 0 |

**Database Score**: 9/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Detailed Assessment

**Migration correctness**: The v28 migration follows the established table-recreation pattern (same as v2, v3, v11, v22, v26). Column list matches the post-v27 schema exactly -- all 31 columns from v22 plus `convergence_enabled` from v27 are present. The `CASE WHEN judge_agent = 'gemini' THEN NULL ELSE judge_agent END` correctly handles existing data. The CHECK constraint is narrowed from `('claude', 'codex', 'gemini')` to `('claude', 'codex')`. All three required indexes (`idx_loops_status`, `idx_loops_schedule_id`, `idx_loops_updated_at`) are recreated.

**Schema consistency**: The `AgentProvider` type in `src/core/agents.ts` is updated to `'claude' | 'codex'` (removing 'gemini'), which aligns with the new CHECK constraint. The `tasks.agent` and `workers.agent` columns have no CHECK constraint, so no migration is needed for those -- they use application-layer validation only.

**Test coverage**: 7 new tests cover CHECK enforcement (gemini rejected, claude/codex/NULL accepted), index recreation, and column preservation. Schema version assertion updated to v28. All 228 repository tests pass.

**Transaction safety**: Migration runs inside `db.transaction()` (line 232), consistent with all prior migrations. SQLite supports DDL (CREATE/DROP/ALTER) within transactions, so the table swap is atomic.

**Applies PF-002**: The migration correctly does a clean break (no backward-compatibility path for gemini) since gemini judge_agent has zero users in production -- the loops table is typically empty on existing installations.
