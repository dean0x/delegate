# Regression Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

**Tmux tests double-execute in test:all chain (2 occurrences)** - `package.json:20,31-33,38`
**Confidence**: 95%
- Problem: The `test:all` script chains `test:implementations` -> ... -> `test:integration` -> ... -> `test:tmux` -> `test:tmux:integration`. However:
  1. `test:implementations` runs `vitest run tests/unit/implementations` which recursively discovers `tests/unit/implementations/tmux/*.test.ts` (4 files). These same files also run under `test:tmux`.
  2. `test:integration` runs `vitest run tests/integration` which recursively discovers `tests/integration/tmux/*.test.ts` (3 files). These same files also run under `test:tmux:integration`.
- Impact: 7 test files execute twice in every `test:all` run. This wastes CI time and memory. If tmux integration tests require real tmux sessions, double-execution could cause session name collisions or resource exhaustion. The project uses `vmMemoryLimit: 1024MB` per fork; redundant forks increase peak memory.
- Fix: Add `--exclude` patterns to `test:implementations` and `test:integration` to skip the tmux subdirectory, matching the existing exclude pattern used for repository tests:
  ```json
  "test:implementations": "NODE_OPTIONS='--max-old-space-size=2048' vitest run tests/unit/implementations --exclude='**/dependency-repository.test.ts' --exclude='**/task-repository.test.ts' --exclude='**/database.test.ts' --exclude='**/checkpoint-repository.test.ts' --exclude='**/output-repository.test.ts' --exclude='**/worker-repository.test.ts' --exclude='**/loop-repository.test.ts' --exclude='**/tmux/**' --no-file-parallelism",
  "test:integration": "NODE_OPTIONS='--max-old-space-size=2048' vitest run tests/integration --exclude='**/tmux/**' --no-file-parallelism",
  ```

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **CLAUDE.md safe-commands list not updated** - `package.json:19` (Confidence: 65%) -- The `test` script's warning message lists safe commands but does not mention `test:tmux` or `test:tmux:integration`. Users running `npm test` will not see the new tmux suites in the help text. Low impact since developers familiar with the project will find them in `package.json` scripts.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | - | 0 | 0 |

### Regression Checklist

- [x] No exports removed -- all 16 existing exports preserved; 4 new exports added (additive only)
- [x] No function signatures changed -- zero lines removed from `errors.ts`
- [x] ErrorCode enum backward compatible -- 4 new string-valued members added at end; no value collisions; no exhaustive switch statements exist in codebase
- [x] All existing scripts unchanged -- `test:all` appended to (not modified in breaking way); all other scripts byte-identical to main
- [x] No files deleted -- only 2 existing files modified (`errors.ts`, `package.json`), 15 new files added
- [x] No existing behavior altered -- new code is self-contained in `src/implementations/tmux/` with no imports from existing modules

**Regression Score**: 9/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The changes are purely additive with no backward compatibility risk. The one condition is the test double-execution issue in the `test:all` chain (HIGH), which should be fixed by adding `--exclude='**/tmux/**'` to `test:implementations` and `test:integration` scripts to prevent tmux tests from running twice.
