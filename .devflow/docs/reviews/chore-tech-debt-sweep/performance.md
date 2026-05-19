# Performance Review Report

**Branch**: chore/tech-debt-sweep -> main
**Date**: 2026-03-20
**PR**: #109

## Overview

This PR contains three commits:
1. **Extract `registerWorker` from `spawn()`** in `EventDrivenWorkerPool` (#98)
2. **Extract `exitOnError`/`exitOnNull` CLI helpers** (#102)
3. **Dogfood `exitOnError`/`exitOnNull` in `withReadOnlyContext`/`withServices`** (style commit)

The changes are purely structural refactors -- extracting repeated patterns into shared helpers and extracting an inline method. No new I/O paths, database queries, algorithms, or data structures are introduced. The runtime behavior is identical before and after.

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Duplicate `Date.now()` calls in `registerWorker`** - `src/implementations/event-driven-worker-pool.ts:222,238`
**Confidence**: 82%
- Problem: `Date.now()` is called twice independently -- once for `WorkerState.startedAt` (line 222) and once for the DB registration `startedAt` (line 238). These two timestamps can differ by microseconds and are conceptually the same value.
- Impact: Negligible runtime cost (two `Date.now()` calls are sub-microsecond), but the semantic inconsistency between in-memory and DB timestamps could cause confusing diagnostics. This is a pre-existing issue that was moved as-is during the extract refactor.
- Fix: Capture `Date.now()` once at the top of `registerWorker` and reuse:
  ```typescript
  const now = Date.now();
  const worker: WorkerState = { ..., startedAt: now, ... };
  // ...
  this.workerRepository.register({ ..., startedAt: now, ... });
  ```

## Suggestions (Lower Confidence)

(none -- no items at 60-79% confidence)

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | - | 1 | 0 |

**Performance Score**: 9/10
**Recommendation**: APPROVED

### Rationale

This PR is a clean structural refactor with no performance impact. The changes:

- **`exitOnError`/`exitOnNull` helpers**: Zero overhead -- these are simple conditional checks that replace identical inline code. The function call overhead is negligible (single-digit nanoseconds) and the functions are small enough for V8 to inline.
- **`registerWorker` extract**: Moves code from `spawn()` into a private method on the same class. V8 will likely inline this call. No new allocations, no new I/O, no changed control flow.
- **No new loops, queries, or async patterns**: The diff strictly reduces code (net -47 lines) by consolidating repeated patterns. Runtime paths are unchanged.
- **CLI-only code paths**: All `exitOnError`/`exitOnNull` usage is in CLI commands, which are one-shot processes. Performance of these paths is not meaningfully impacted by an extra function call.

The single pre-existing note (duplicate `Date.now()`) is informational and not introduced by this PR.
