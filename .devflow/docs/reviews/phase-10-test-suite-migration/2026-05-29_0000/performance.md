# Performance Review Report

**Branch**: main (284f5a0 vs 5d169d8)
**Date**: 2026-05-29

## Issues in Your Changes (BLOCKING)

### HIGH

**Test file duplication in `test:all` chain causes 7-9 test files to execute twice** - `package.json:20,34`
**Confidence**: 95%
- Problem: The new `test:channels` script (line 34) aggregates 9 channel-related test files that already belong to existing test groups (`test:services`, `test:handlers`, `test:cli`, `test:repositories`, `test:dashboard`). Since `test:all` (line 20) runs all groups sequentially, every channel test file is executed twice during the full suite:
  - `channel-manager.test.ts` -- in `test:services` AND `test:channels`
  - `channel-router.test.ts` -- in `test:services` AND `test:channels`
  - `channel-handler.test.ts` -- in `test:handlers` AND `test:channels`
  - `channel-message-persistence-handler.test.ts` -- in `test:handlers` AND `test:channels`
  - `channel.test.ts` (CLI) -- in `test:cli` AND `test:channels`
  - `msg.test.ts` (CLI) -- in `test:cli` AND `test:channels`
  - `channel-repository.test.ts` -- in `test:repositories` AND `test:channels`
  - `channel-detail.test.tsx` -- in `test:dashboard` (dir glob) AND `test:channels`
  - `use-channel-pane-preview.test.ts` -- in `test:dashboard` (dir glob) AND `test:channels`
- Impact: In `test:all` and CI, these 9 test files run twice. Each vitest invocation pays JIT, module resolution, and DB setup costs. With `pool: 'forks'` and 2GB memory limit, each duplicate group spawns a separate OS process with full initialization overhead. This wastes CI minutes and compounds the memory-exhaustion risk that the grouped test strategy was designed to mitigate.
- Fix: Either (a) remove channel test files from their original groups (`test:services`, `test:handlers`, `test:cli`, `test:repositories`, `test:dashboard`) now that `test:channels` owns them, or (b) exclude `test:channels` from `test:all` since its files are already covered by the existing groups. Option (a) is cleaner -- it consolidates channel tests into one group. Example for option (a):

```json
"test:services": "... (remove channel-router.test.ts and channel-manager.test.ts)",
"test:handlers": "... (remove channel-handler.test.ts and channel-message-persistence-handler.test.ts)",
"test:cli": "... (remove channel.test.ts and msg.test.ts)",
"test:repositories": "... (remove channel-repository.test.ts)"
```

For `test:dashboard` (which uses a directory glob), either add `--exclude` flags for the channel files or move the channel dashboard test files out of the `tests/unit/cli/dashboard/` directory.

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

(none -- all findings above threshold)

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | - | 0 | 0 |

**Performance Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The dead code removal and mock fidelity fix are clean with no performance concerns. The sole blocking issue is test file duplication in the `test:all` CI chain: adding `test:channels` to `test:all` without removing channel files from their original groups causes all 9 channel test files to execute twice, wasting CI time and compounding memory pressure. This is a straightforward fix -- consolidate ownership so each test file belongs to exactly one group in the `test:all` chain.
