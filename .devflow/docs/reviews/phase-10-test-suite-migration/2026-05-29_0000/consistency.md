# Consistency Review Report

**Branch**: main (284f5a0 vs 5d169d8)
**Date**: 2026-05-29
**Context**: Phase 10 test suite migration -- dead code removal, mock fidelity fix, mock deduplication in channel-manager.test.ts, test:channels script

## Issues in Your Changes (BLOCKING)

### HIGH

**test:channels duplicates every file already covered by existing scripts in test:all** - `package.json:34`
**Confidence**: 95%
- Problem: The new `test:channels` script lists 9 test files, all of which already appear in other scripts (`test:services`, `test:handlers`, `test:repositories`, `test:cli`, `test:dashboard`). Since `test:all` chains all scripts sequentially -- including both the original scripts AND `test:channels` -- every channel test file runs twice in a full suite run. This doubles execution time for channel tests and is inconsistent with how other cross-cutting scripts work in this project (e.g., `test:scheduling` and `test:orchestration` contain files NOT already included elsewhere).
  - `channel-manager.test.ts` runs in both `test:services` and `test:channels`
  - `channel-router.test.ts` runs in both `test:services` and `test:channels`
  - `channel-handler.test.ts` runs in both `test:handlers` and `test:channels`
  - `channel-message-persistence-handler.test.ts` runs in both `test:handlers` and `test:channels`
  - `channel-repository.test.ts` runs in both `test:repositories` and `test:channels`
  - `channel.test.ts` and `msg.test.ts` run in both `test:cli` and `test:channels`
  - `channel-detail.test.tsx` and `use-channel-pane-preview.test.ts` run in both `test:dashboard` and `test:channels`
- Fix: Either (a) remove `test:channels` from the `test:all` chain (keep it as a standalone convenience script), or (b) remove the channel files from their original scripts (`test:services`, `test:handlers`, `test:repositories`, `test:cli`, `test:dashboard`) and have `test:channels` be the sole owner. Option (a) is the lowest-risk approach and matches the pattern where `test:channels` exists only as a focused convenience script for Claude Code sessions:

```json
"test:all": "npm run test:core && npm run test:handlers && npm run test:services && npm run test:repositories && npm run test:adapters && npm run test:implementations && npm run test:cli && npm run test:dashboard && npm run test:scheduling && npm run test:checkpoints && npm run test:error-scenarios && npm run test:orchestration && npm run test:translation && npm run test:integration && npm run test:tmux && npm run test:tmux:integration"
```

### MEDIUM

**Mock spawn config type annotation uses inline object type instead of TmuxSpawnCoreConfig** - `tests/fixtures/mocks.ts:151`
**Confidence**: 82%
- Problem: The updated `createMockTmuxConnector` mock uses an inline type annotation `(config: { taskId: string; sessionsDir: string; name?: string }, callbacks: SpawnCallbacks)` for the `spawn` mock implementation. The actual `TmuxConnectorPort.spawn()` signature takes `TmuxSpawnCoreConfig`, which includes required fields `taskId: TaskId` (branded type, not plain `string`), `name: string` (required, not optional), `command: string`, and `agentArgs: readonly string[]`. The mock accepts a partial, unbranded config shape that diverges from the port interface.
- Fix: While this is a partial fidelity improvement (adding `name?`), consider using `TmuxSpawnCoreConfig` directly or a partial of it, consistent with how other mocks in this file use their interface types (e.g., `createMockWorkerRepository(): WorkerRepository`, `createMockTaskRepository(): TaskRepository`). The mock already returns `MockTmuxConnector` which extends `TmuxConnectorPort`, so the spawn implementation type should align:

```typescript
spawn: vi
  .fn()
  .mockImplementation(
    (config: TmuxSpawnCoreConfig, callbacks: SpawnCallbacks) => {
      const sessionName = config.name ?? `beat-${config.taskId}`;
      // ...
    },
  ),
```

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Duplicate createMockEventBus definitions across test-data.ts and mocks.ts** - `tests/fixtures/test-data.ts:57`, `tests/fixtures/mocks.ts:32`
**Confidence**: 90%
- Problem: Two `createMockEventBus` functions exist in fixture files with different signatures and behaviors. The `mocks.ts` version returns a typed `EventBus` interface; the `test-data.ts` version returns an untyped ad-hoc object with extra methods (`removeAllListeners`, wildcard handling). This is the same class of duplication that was addressed for `createMockResourceMonitor` and `createMockWorkerPool` in this PR, but `createMockEventBus` was not consolidated.
- Fix: In a follow-up, consolidate to a single canonical implementation (likely keeping the typed `mocks.ts` version) and update all consumers. Not blocking since this is pre-existing and not introduced by the current changes.

## Suggestions (Lower Confidence)

- **CLAUDE.md test:channels count inconsistency** - `CLAUDE.md:35` (Confidence: 65%) -- The CLAUDE.md section "Pre-Release Validation" now lists `test:channels` in the grouped test chain, which means the pre-release validation also runs channel tests twice (once via `test:services`/`test:handlers`/etc. and once via `test:channels`). This could be intentional for a double-check, but is inconsistent with the principle of each test running exactly once.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Consistency Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The core changes (dead code removal, mock fidelity fix, mock deduplication) are clean and well-executed. The `createMockTmuxConnector` update correctly adds `name?` support to match channel spawning patterns (applies ADR-001 -- channel names map to tmux session names). The dead code removals (`createMockChildProcess`, `createMockStream`, `createMockWorkerPool`, `createMockResourceMonitor` from test-data.ts) are verified to have zero consumers remaining.

The blocking issue is the test file duplication in `test:all` -- all 9 channel test files run twice in a full suite because they are listed in both their original category scripts and the new `test:channels` script. This is inconsistent with existing patterns (e.g., `test:scheduling` owns its files exclusively) and wastes CI time. The fix is straightforward: remove `test:channels` from the `test:all` chain.
