# Reliability Review Report

**Branch**: main (284f5a0 vs 5d169d8)
**Date**: 2026-05-29
**Context**: Phase 10 test suite migration -- dead code removal, mock fidelity fix, mock dedup, test:channels script

## Issues in Your Changes (BLOCKING)

### HIGH

**Test file double-execution in test:all pipeline** - `package.json:20,22,34,37`
**Confidence**: 95%
- Problem: Four test files appear in both `test:channels` and their original groups (`test:services`, `test:cli`), causing them to execute twice during `npm run test:all`:
  - `tests/unit/services/channel-manager.test.ts` -- in both `test:channels` and `test:services`
  - `tests/unit/services/channel-router.test.ts` -- in both `test:channels` and `test:services`
  - `tests/unit/cli/channel.test.ts` -- in both `test:channels` and `test:cli`
  - `tests/unit/cli/msg.test.ts` -- in both `test:channels` and `test:cli`
- Impact: Double execution wastes ~2-3s per redundant run and increases memory pressure during the full test suite -- a resource-constrained environment where the project already enforces memory limits and fork isolation. This is a bounded-iteration concern: the test pipeline runs more work than necessary with no termination benefit.
- Fix: Remove the duplicated files from their original groups so each file runs exactly once. The `test:channels` group is the canonical home for channel-related tests.

```json
// test:services — remove channel-router.test.ts and channel-manager.test.ts
"test:services": "NODE_OPTIONS='--max-old-space-size=2048' vitest run tests/unit/services/judge-exit-condition-evaluator.test.ts tests/unit/services/task-manager.test.ts tests/unit/services/recovery-manager.test.ts tests/unit/services/handler-setup.test.ts tests/unit/services/loop-manager.test.ts tests/unit/services/eval-batch3.test.ts tests/unit/services/eval-batch3-mcp.test.ts tests/unit/services/eval-domain-batch2.test.ts tests/unit/services/schedule-executor-autostart.test.ts tests/unit/services/schedule-executor-pure-fns.test.ts tests/unit/services/eval-task-waiter.test.ts tests/unit/services/bootstrap-tmux-validation.test.ts --no-file-parallelism",

// test:cli — remove channel.test.ts and msg.test.ts
"test:cli": "NODE_OPTIONS='--max-old-space-size=2048' vitest run tests/unit/cli.test.ts tests/unit/cli-init.test.ts tests/unit/cli-services.test.ts tests/unit/retry-functionality.test.ts tests/unit/read-only-context.test.ts --no-file-parallelism",
```

### MEDIUM

**Mock spawn signature diverges from TmuxSpawnCoreConfig: name is optional in mock but required in interface** - `tests/fixtures/mocks.ts:151`
**Confidence**: 85%
- Problem: The shared `createMockTmuxConnector` types `name` as optional (`name?: string`) with a fallback `config.name ?? \`beat-${config.taskId}\``, but `TmuxSpawnCoreConfig.name` is a required field. The mock will silently accept calls that omit `name`, which would fail at runtime against a real `TmuxConnectorPort`.
- Impact: Tests using this mock cannot catch regressions where a caller forgets to pass `name`. The fallback masks what would be a real bug. This is an assertion-density concern: the mock lacks the precondition check that the real interface enforces via type system.
- Fix: Make `name` required in the mock signature to match the interface.

```typescript
spawn: vi
  .fn()
  .mockImplementation(
    (config: { taskId: string; sessionsDir: string; name: string }, callbacks: SpawnCallbacks) => {
      const sessionName = config.name;
      // ...
    },
  ),
```

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

_No issues found._

## Suggestions (Lower Confidence)

- **Dead code removal completeness** - `tests/fixtures/test-data.ts` (Confidence: 65%) -- The `createMockResourceMonitor` removed from test-data.ts has a differently-typed counterpart in `mocks.ts` (line 83). Verified that no consumer imports from test-data.ts, so the removal is safe. However, the existence of two separate mock factory files (`test-data.ts` and `mocks.ts`) with overlapping concerns is a consolidation opportunity.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Reliability Score**: 8/10
**Recommendation**: CHANGES_REQUESTED

The changes are well-motivated -- dead code removal reduces confusion, mock deduplication eliminates drift risk (avoids PF-004 by ensuring consistent rollback testing via the shared mock), and the new `test:channels` group provides a clear ownership boundary for channel tests. The HIGH finding (test file double-execution) should be resolved before merge because it introduces unnecessary resource consumption in the memory-constrained `test:all` pipeline, directly counter to the project's documented memory management constraints. The MEDIUM mock fidelity finding improves assertion density (applies ADR-001 -- channel session names must be valid tmux session names, so the mock should enforce that `name` is always provided).
