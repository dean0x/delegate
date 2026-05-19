# Architecture Review Report

**Branch**: chore/tech-debt-sweep -> main
**Date**: 2026-03-20
**PR**: #109
**Commits**: 3 (e615c1e, c306792, d7d27c8)
**Files Changed**: 5 (net -47 lines)

## Issues in Your Changes (BLOCKING)

No blocking issues found.

## Issues in Code You Touched (Should Fix)

No should-fix issues found.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Incomplete `exitOnError`/`exitOnNull` adoption across CLI commands** - `src/cli/commands/run.ts`, `src/cli/commands/config.ts`, `src/cli/commands/agents.ts`, `src/cli/commands/pipeline.ts`
**Confidence**: 82%
- Problem: The PR introduces `exitOnError` and `exitOnNull` as centralized Result-unwrapping utilities and applies them consistently in `logs.ts`, `status.ts`, `schedule.ts`, and `services.ts`. However, at least 5 other CLI command files (`run.ts:29,218,226,262`, `config.ts:77,96`, `agents.ts:117,168`, `pipeline.ts:52`, `init.ts:79,112`) still use the old inline `if (!result.ok) { ui.error(...); process.exit(1); }` pattern. This creates an inconsistency in the CLI layer -- half the commands use the new helpers, half still inline the boilerplate.
- Impact: Maintenance burden. Future developers editing untouched files won't know which pattern to follow. A follow-up PR sweeping remaining commands would complete the pattern.
- Fix: Apply `exitOnError`/`exitOnNull` to remaining CLI commands in a separate follow-up PR.

## Suggestions (Lower Confidence)

- **`exitOnError` return type and `process.exit` narrowing** - `src/cli/services.ts:15` (Confidence: 65%) -- TypeScript does not type `process.exit()` as `never` by default, so the function signature `exitOnError<T>(...): T` is technically correct but relies on `process.exit` being unreachable. Adding an explicit `never` annotation or `throw` after `process.exit(1)` would make the control flow clearer to both TypeScript and future readers. This is minor since the current code works correctly.

- **`scheduleCreate` argument parsing could benefit from extraction** - `src/cli/commands/schedule.ts:61-248` (Confidence: 62%) -- The `scheduleCreate` function is ~190 lines with a large for-loop for argument parsing interleaved with validation, followed by branching for pipeline vs. single-task creation. This is pre-existing complexity not introduced by this PR, but the function was touched. Extracting argument parsing into a dedicated function would improve SRP compliance.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | - | 1 | 0 |

**Architecture Score**: 9/10
**Recommendation**: APPROVED

## Rationale

This PR is a well-executed tech debt cleanup with strong architectural merit:

1. **DRY principle applied correctly** (commit c306792): The `exitOnError` and `exitOnNull` helpers extract a repeated 4-line pattern (check result, stop spinner, print error, exit) into reusable single-call utilities. This eliminates ~60 lines of boilerplate across 3 command files while preserving identical runtime behavior.

2. **Clean method extraction** (commit e615c1e): Extracting `registerWorker()` from the 40-line inline block in `spawn()` improves SRP -- `spawn()` now orchestrates (spawn process, register, setup timeout, connect output) while `registerWorker()` owns the atomic register-or-rollback logic. The rollback semantics (kill process, remove from maps on UNIQUE violation) are preserved exactly.

3. **Self-dogfooding** (commit d7d27c8): `withReadOnlyContext` and `withServices` now use the same `exitOnError` helper they export, eliminating a "cobbler's children" inconsistency.

4. **Layer boundaries respected**: The new helpers live in `src/cli/services.ts` (CLI layer), not in core. They depend on `Result` from core (correct dependency direction) and on `ui`/`Spinner` from CLI (same layer). No layering violations introduced.

5. **Explicit return types added**: Functions like `scheduleCreate`, `scheduleCancel`, `schedulePause`, `scheduleResume` now have explicit `Promise<void>` return types, improving type documentation.

The only note is that the pattern adoption is partial -- several CLI commands still use inline Result checking. This is not blocking since the PR scope was specifically the schedule/status/logs commands and worker pool, and incomplete adoption in untouched files is expected for an incremental cleanup.
