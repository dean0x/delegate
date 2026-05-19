# Consistency Review Report

**Branch**: chore/tech-debt-sweep -> main
**Date**: 2026-03-20

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Spinner stop message changed from "Initialization failed" to "Failed"** - `src/cli/services.ts:17`
**Confidence**: 85%
- Problem: The old `withReadOnlyContext` called `s?.stop('Initialization failed')` and the old `withServices` also used `s?.stop('Initialization failed')`. Now both go through `exitOnError` which always uses `s?.stop('Failed')`. The loss of the more specific "Initialization failed" message is an unnecessary simplification -- the spinner text previously told users *what* failed (initialization), now it just says "Failed".
- Fix: Add a `stopMsg` parameter to `exitOnError` (like `exitOnNull` already has), defaulting to `'Failed'`, and pass `'Initialization failed'` from `withReadOnlyContext` and `withServices`:

```typescript
export function exitOnError<T>(
  result: Result<T>,
  s?: Spinner,
  prefix?: string,
  stopMsg = 'Failed',
): T {
  if (!result.ok) {
    s?.stop(stopMsg);
    ui.error(prefix ? `${prefix}: ${result.error.message}` : result.error.message);
    process.exit(1);
  }
  return result.value;
}
```

Then in `withServices`:
```typescript
const container = exitOnError(await bootstrap({ mode: 'cli' }), s, 'Bootstrap failed', 'Initialization failed');
```

### LOW

**Incomplete adoption: 6 CLI command files still use the old boilerplate pattern** - Multiple files
**Confidence**: 90%
- Problem: This PR introduces `exitOnError`/`exitOnNull` helpers and applies them in `logs.ts`, `status.ts`, and `schedule.ts`. However, 6 other CLI command files still use the old `if (!result.ok) { ... process.exit(1) }` pattern:
  - `cancel.ts:12` - `if (result.ok) { ... } else { ... }`
  - `retry.ts:12` - `if (result.ok) { ... } else { ... }`
  - `resume.ts:17` - `if (result.ok) { ... } else { ... }`
  - `pipeline.ts:52` - `if (!result.ok) { ... }`
  - `run.ts:218,226,262` - three separate `if (!result.ok)` blocks
  - `agents.ts:117,168` - `if (!result.ok) { ... }`
- This creates an inconsistency: some commands use the new helpers, some use the old pattern. The PR title is "tech-debt-sweep" but the sweep is only partial for the CLI layer.
- Fix: Consider converting the remaining files in a follow-up commit or documenting that the remaining files are intentionally left for a future pass.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Missing return type annotations on non-touched CLI functions** - `cancel.ts:5`, `retry.ts:5`, `resume.ts:5`, `pipeline.ts:5`
**Confidence**: 82%
- Problem: This PR added explicit `Promise<void>` return types to `scheduleCreate`, `scheduleCancel`, `schedulePause`, and `scheduleResume` in `schedule.ts`, establishing a pattern that all CLI command functions should have explicit return types. However, peer functions in `cancel.ts` (`cancelTask`), `retry.ts` (`retryTask`), `resume.ts` (`handleResumeCommand`), and `pipeline.ts` (`handlePipelineCommand`) still lack return type annotations. Since this PR specifically added return types as a consistency improvement, the remaining functions are now more visibly inconsistent.
- Fix: These are in untouched files, so not blocking. Consider addressing in a follow-up.

## Pre-existing Issues (Not Blocking)

_No critical pre-existing issues found._

## Suggestions (Lower Confidence)

- **`exitOnError` parameter asymmetry with `exitOnNull`** - `src/cli/services.ts:15-36` (Confidence: 70%) -- `exitOnNull` has a `stopMsg` parameter allowing callers to customize the spinner stop text, but `exitOnError` hardcodes `'Failed'`. This asymmetry may cause confusion when developers expect the same level of customization from both helpers.

- **`run.ts` has a special case preventing `exitOnError` adoption** - `src/cli/commands/run.ts:226-230` (Confidence: 65%) -- The `runTask` function calls `await container.dispose()` before `process.exit(1)` in its error branches. This cleanup step means `exitOnError` cannot be directly substituted without extending it or using a different pattern (e.g., a cleanup callback). Worth documenting if the remaining files are left unconverted.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 1 |
| Should Fix | - | 0 | 1 | - |
| Pre-existing | - | - | 0 | 0 |

**Consistency Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The PR achieves its stated goal of extracting `exitOnError`/`exitOnNull` helpers and demonstrates consistent application across the three files it touches (logs, status, schedule). The worker pool `registerWorker` extraction is clean and follows existing Result-based patterns. The two conditions are: (1) consider restoring the "Initialization failed" spinner stop message via a `stopMsg` parameter to avoid unnecessary simplification, and (2) document or plan a follow-up for the 6 remaining CLI files still using the old boilerplate pattern, so the partial adoption does not become permanent.
