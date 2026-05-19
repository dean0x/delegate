# TypeScript Review Report

**Branch**: feat/134-system-prompt-support -> main
**Date**: 2026-04-18

## Issues in Your Changes (BLOCKING)

### HIGH

**Non-null assertion after Boolean guard** - `src/services/orchestration-manager.ts:228`
**Confidence**: 90%
- Problem: `request.systemPrompt!` uses a non-null assertion to bypass TypeScript's narrowing. While `hasCustomSystemPrompt` guards this via `Boolean(request.systemPrompt?.trim())`, the compiler cannot narrow through a separate variable. The `!` assertion is a lint-suppression pattern that circumvents TypeScript's type safety. If the guard logic is ever refactored (e.g., `hasCustomSystemPrompt` is moved or recomputed differently), the `!` becomes a latent crash site.
- Fix: Use an inline narrowing pattern instead of `!`:
```typescript
const trimmed = request.systemPrompt?.trim();
const finalSystemPrompt = trimmed ? request.systemPrompt! : orchestratorSystemPrompt;
```
Or better, avoid `!` entirely by using the trimmed value or restructuring:
```typescript
const customSystemPrompt = request.systemPrompt?.trim();
const finalSystemPrompt = customSystemPrompt || orchestratorSystemPrompt;
const finalUserPrompt = customSystemPrompt
  ? `${operationalContract}\n\n${userPrompt}`
  : userPrompt;
```
This eliminates both the `!` assertion and the separate `hasCustomSystemPrompt` boolean, making the narrowing flow through TypeScript's own control flow analysis.

### MEDIUM

**`result!` non-null assertion in test** - `tests/unit/implementations/agent-adapters.test.ts:980`
**Confidence**: 82%
- Problem: `result!.ok` uses a non-null assertion on a variable declared with `let result: ReturnType<typeof adapter.spawn>` and assigned inside a try block. If `adapter.spawn()` throws, `result` is never assigned and `result!` would crash with a different error than the original, obscuring the root cause. While this is a test file and the current code path never throws, `!` in tests sets a pattern.
- Fix: Initialize with a sentinel or use definite assignment:
```typescript
let result: ReturnType<typeof adapter.spawn> | undefined;
try {
  result = adapter.spawn({ ... });
} finally {
  consoleSpy.mockRestore();
  adapter.dispose();
}
expect(result).toBeDefined();
expect(result!.ok).toBe(true);
```
Or restructure to avoid `!` entirely by asserting `result` is defined first.

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

_No CRITICAL pre-existing issues detected in reviewed files._

## Suggestions (Lower Confidence)

- **Duplicate operational knowledge in prompts** - `src/services/orchestrator-prompt.ts:141-159` (Confidence: 65%) -- The `operationalContract` string duplicates content from the `systemPrompt` string (state file path, working dir, CLI commands, constraints). If the system prompt text is edited, the contract must be updated in parallel. Consider extracting shared template fragments to reduce drift risk.

- **`as string[]` type assertions in tests** - `tests/unit/implementations/agent-adapters.test.ts` (multiple lines) (Confidence: 62%) -- Several spawn arg assertions cast `args as string[]`. These are pre-existing in the test file and not introduced by this PR, but the new tests follow the same pattern. The spawn mock's return type could be tightened to avoid repeated assertions.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**TypeScript Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The TypeScript quality is strong overall. The codebase uses Result types consistently, discriminated unions are properly narrowed with `if (!result.ok) return` guards, and new types (e.g., `operationalContract` return field, `systemPrompt` schema additions) are well-integrated. The one blocking HIGH issue is the `!` non-null assertion in `orchestration-manager.ts:228` which bypasses compiler narrowing -- a minor refactor eliminates it without changing behavior. The test assertion at line 980 is lower priority but worth cleaning up to maintain the project's strict typing standards.
