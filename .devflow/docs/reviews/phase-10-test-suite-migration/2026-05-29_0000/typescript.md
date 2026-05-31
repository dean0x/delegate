# TypeScript Review Report

**Branch**: main (284f5a0 vs 5d169d8)
**Date**: 2026-05-29

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Mock spawn config type diverges from TmuxSpawnCoreConfig** - `tests/fixtures/mocks.ts:151`
**Confidence**: 85%
- Problem: The mock `spawn` implementation declares its config parameter as `{ taskId: string; sessionsDir: string; name?: string }`, which differs from the real `TmuxConnectorPort.spawn` signature that accepts `TmuxSpawnCoreConfig`. The real type has `name: string` (required), `taskId: TaskId` (branded type, not `string`), and additional required fields (`command`, `agentArgs`). The mock makes `name` optional and `taskId` is `string` instead of `TaskId`, masking potential type mismatches in callers.
- Impact: Tests can call `spawn` with a config object that would not compile against the real interface (e.g., omitting `name`, passing `string` instead of `TaskId`). This reduces confidence that tested call-sites are type-correct.
- Fix: Type the mock config parameter as `TmuxSpawnCoreConfig` and use `config.name` directly (it is required on the real type). If some callers genuinely pass a partial config (e.g., channel-manager passes `name` but not `command`), consider accepting `Pick<TmuxSpawnCoreConfig, 'taskId' | 'sessionsDir' | 'name'>` or the full type. The `as TaskId` cast on line 159 would also become unnecessary if the config parameter used `TaskId`:

```typescript
// Before (line 151)
(config: { taskId: string; sessionsDir: string; name?: string }, callbacks: SpawnCallbacks) => {
  const sessionName = config.name ?? `beat-${config.taskId}`;
  // ...
  taskId: config.taskId as TaskId,

// After — align with TmuxSpawnCoreConfig
(config: TmuxSpawnCoreConfig, callbacks: SpawnCallbacks) => {
  const sessionName = config.name;
  // ...
  taskId: config.taskId,
```

Note: This is a pre-existing pattern that was modified in this diff (the `name?: string` was added). The original mock already used `string` for `taskId`; this diff improved fidelity by adding the `name` parameter but did not fully close the gap.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Test file overlap between test:channels, test:services, and test:cli** - `package.json:22,34,37`
**Confidence**: 82%
- Problem: The new `test:channels` script includes files that are already present in `test:services` (`channel-manager.test.ts`, `channel-router.test.ts`) and `test:cli` (`channel.test.ts`, `msg.test.ts`). When `test:all` runs sequentially, these 4 files execute twice, doubling their runtime and memory usage.
- Impact: In CI (`test:all`), the full suite runs these files twice. For local Claude Code usage with individual groups, there is no impact. The duplication is inconsistent with the project's existing pattern where test scripts have non-overlapping file lists (e.g., `test:implementations` uses `--exclude` to avoid overlap with `test:tmux`).
- Fix: Remove the duplicated files from `test:services` and `test:cli` now that `test:channels` is the canonical home for channel-related tests. Alternatively, add `--exclude` patterns to the existing scripts:

```jsonc
// Remove from test:services: channel-router.test.ts, channel-manager.test.ts
// Remove from test:cli: channel.test.ts, msg.test.ts
// These are now covered by test:channels
```

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Unsafe `as TaskId` cast in mock** - `tests/fixtures/mocks.ts:159` (Confidence: 70%) -- The `config.taskId as TaskId` cast bypasses branded type validation. In production, `TaskId()` is a branded constructor that enforces format constraints. The mock silently accepts any string. Consider using `TaskId(config.taskId)` to mirror production behavior, though this only matters if `TaskId` has runtime validation beyond branding.

- **Inconsistent `Function` type usage in mock event bus** - `tests/fixtures/mocks.ts:41-49` (Confidence: 65%) -- The `createMockEventBus` uses the `Function` type (uppercase) for handler parameters, which TypeScript's ESLint rules typically flag as `@typescript-eslint/ban-types`. A more precise type would be `(data: unknown) => void`. This is pre-existing and unchanged in this diff.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**TypeScript Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The type safety improvements are directionally correct -- replacing `MockTmuxHandle` with the real `TmuxHandle` type and using `TaskId` branded type in the rollback test are genuine fidelity gains. The dead code removal is clean with no orphaned references. Two conditions: (1) the mock spawn config type should be tightened to match `TmuxSpawnCoreConfig` rather than using a looser inline type, and (2) the test file overlap between `test:channels`, `test:services`, and `test:cli` should be resolved to maintain the non-overlapping invariant established by other test groups.
