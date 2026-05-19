# TypeScript Review Report

**Branch**: feat/v1.4.0-reliability-eval-redesign -> main
**Date**: 2026-04-14T15:37:00Z

## Issues in Your Changes (BLOCKING)

### HIGH

**`as` casts bypass type safety in loop repository row-to-domain conversion** - `src/implementations/loop-repository.ts:686-687`
**Confidence**: 88%
- Problem: The new eval redesign fields use `as` type assertions instead of validated Zod transforms on the read path. `data.eval_type as EvalType` and `data.judge_agent as Loop['judgeAgent']` bypass runtime validation. The Zod schema validates `eval_type` as `z.string().nullable().optional()` but never constrains it to the `EvalType` enum values (`'feedforward' | 'judge' | 'schema'`). If a corrupted or manually-edited DB row contains an unexpected string (e.g., `'foobar'`), it would pass Zod validation and flow silently into domain types as an invalid `EvalType`, violating the project convention established in PF-005 ("Zod parse on every read").
- Fix: Add `.refine()` or use `z.enum()` in the Zod schema for `eval_type`, and add a proper enum validator for `judge_agent` matching the `AgentProvider` type:
  ```typescript
  eval_type: z.enum(['feedforward', 'judge', 'schema']).nullable().optional(),
  judge_agent: z.enum(['claude', 'codex', 'gemini']).nullable().optional(),
  ```

**Exhaustiveness guard in CompositeExitConditionEvaluator has unreachable fallback that masks future bugs** - `src/services/composite-exit-condition-evaluator.ts:53-56`
**Confidence**: 85%
- Problem: The `default` branch of the exhaustive switch on `evalType` first assigns `const _exhaustive: never = evalType` (which correctly produces a compile error if a new enum variant is added) but then returns `this.feedforwardEvaluator.evaluate(loop, taskId)` as a runtime fallback. This means if the compile-time check is somehow bypassed (e.g., JS caller, JSON deserialization), the code silently falls through to feedforward instead of throwing, which could mask a misconfigured `evalType` at runtime. The project convention from the TypeScript skill is to `throw new Error()` using the `never` variable.
- Fix: Replace the safe fallback with a throw:
  ```typescript
  default: {
    const _exhaustive: never = evalType;
    throw new Error(`Unhandled evalType: ${_exhaustive}`);
  }
  ```

### MEDIUM

**`string | null | undefined` triple-union on LoopRow interface fields** - `src/implementations/loop-repository.ts:157-159,180`
**Confidence**: 82%
- Problem: The new `eval_type`, `judge_agent`, `judge_prompt`, and `eval_response` fields on the `LoopRow` and `LoopIterationRow` interfaces use `string | null | undefined`. SQLite columns are either present (string or null) or absent (when the migration has not yet run). The Zod schema handles this with `.nullable().optional()`. However, the `LoopRow` interface is a manually-written type mirror -- the `| undefined` part is never actually produced by SQLite and adds unnecessary type width. This mismatch between what SQLite actually returns and what TypeScript allows could hide bugs where `undefined` is incorrectly treated as a valid DB value.
- Fix: Use `string | null` on the row interfaces (matching what SQLite actually returns), and keep `.optional()` only on the Zod schema to handle the column-not-yet-added case during migration transitions.

**Timeout default changed to 0 (disabled) with `.min(0)` allows accidental no-timeout** - `src/core/configuration.ts:20`
**Confidence**: 80%
- Problem: The timeout field changed from `.min(1000).max(3600000).default(1800000)` to `.min(0).max(86400000).default(0)`. The change is documented with a design decision comment. However, `min(0)` means any non-negative value including very small values like 1ms or 10ms would pass Zod validation, which is almost certainly a misconfiguration. The old `min(1000)` prevented sub-second timeouts that would kill tasks immediately. Since `0` means "disabled", consider a validation that accepts either exactly `0` (disabled) or `>= 1000` (meaningful timeout).
- Fix: Use a Zod refinement:
  ```typescript
  timeout: z.number().min(0).max(86400000).default(0).refine(
    (v) => v === 0 || v >= 1000,
    { message: 'timeout must be 0 (disabled) or >= 1000ms' }
  ),
  ```

**`DEFAULT_CONFIG` object removed without verifying all consumers use Zod defaults** - `src/core/configuration.ts`
**Confidence**: 80%
- Problem: The `DEFAULT_CONFIG` object was removed in favor of relying entirely on Zod `.default()` values in the `ConfigurationSchema`. This is architecturally cleaner (single source of truth). However, a grep confirms no remaining references to `DEFAULT_CONFIG` in the codebase, so this is properly handled. The concern is that the default timeout value changed from 1800000 (30min) to 0 (disabled) as part of this cleanup -- this behavioral change could surprise users upgrading who relied on the implicit 30-minute safety net.
- Fix: This is acceptable as a deliberate design decision (documented in the code comment). No code fix needed, but the release notes should explicitly call out the timeout default change as a behavioral change.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`data.eval_mode as EvalMode` cast in rowToLoop without Zod enum validation** - `src/implementations/loop-repository.ts:668`
**Confidence**: 82%
- Problem: The existing `evalMode: data.eval_mode as EvalMode` line (unchanged in this PR) uses a type assertion. The Zod schema has `eval_mode: z.nativeEnum(EvalMode).default(EvalMode.SHELL)` which does validate at the Zod boundary. However, the `as EvalMode` cast is redundant given Zod already validated, and the pattern is inconsistent with the new `eval_type` field which does NOT use a nativeEnum Zod validator. The new fields should follow the validated pattern, not the unvalidated one.
- Fix: This reinforces the BLOCKING issue above -- the new `eval_type` field should use `z.enum()` or `z.nativeEnum()` like `eval_mode` does, rather than bare `z.string()`.

**`data.status as LoopIteration['status']` cast without Zod validation** - `src/implementations/loop-repository.ts:721`
**Confidence**: 80%
- Problem: Pre-existing pattern where iteration status is cast with `as` rather than validated. The Zod schema does have a `z.enum(...)` for status that covers this, but the cast is belt-and-suspenders. Consistent with the approach used for other enum-like fields, this should rely on the Zod parse result type directly.
- Fix: No code change needed since Zod validates before the cast, but worth noting as a pre-existing inconsistency that the new eval fields should not replicate.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Known pitfall PF-005 (Zod parse on every repo read) not fully resolved** - `src/implementations/loop-repository.ts`
**Confidence**: 85%
- Problem: PF-005 documents that new repo read methods must use Zod parse, not `as` casts. The loop repository's existing `rowToLoop` and `rowToIteration` methods do use `LoopRowSchema.parse(row)` and `LoopIterationRowSchema.parse(row)` respectively, which is correct at the top level. However, the enum-like fields within those schemas use `z.string()` rather than `z.enum()`, so the "parse" step accepts any string for `eval_type` and `judge_agent`. This is a partial application of PF-005.

## Suggestions (Lower Confidence)

- **Duplicate structured output parsing logic across evaluators** - `src/services/agent-exit-condition-evaluator.ts:226-280`, `src/services/judge-exit-condition-evaluator.ts:316-346` (Confidence: 70%) -- Both `tryParseStructuredOutput` methods share the same Claude JSON-envelope parsing pattern (marker search, `structured_output` extraction). Consider extracting into a shared utility to eliminate duplication and ensure consistent parsing behavior.

- **Feedback byte cap uses `entry.length` (chars) not bytes** - `src/services/handlers/loop-handler.ts:1487-1492` (Confidence: 65%) -- The `MAX_FEEDBACK_BYTES` constant name suggests byte counting, but `entry.length` measures UTF-16 code units. For ASCII-only content this is equivalent, but multi-byte characters would exceed the intended cap. If the cap is truly meant to be bytes, use `Buffer.byteLength(entry)`. If chars are intended, rename to `MAX_FEEDBACK_CHARS`.

- **`process.argv[1]` assumption in schedule executor spawn** - `src/cli/commands/schedule-executor.ts:77` (Confidence: 62%) -- `process.argv[1]` is assumed to be the CLI entry point. This holds for normal `beat` invocations but may break if the binary is invoked via `npx`, symlinks, or other indirect mechanisms where `argv[1]` is not the expected path.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | - | 2 | 2 | - |
| Should Fix | - | - | 2 | - |
| Pre-existing | - | - | 1 | - |

**TypeScript Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The core architecture is well-structured with good use of discriminated unions, Result types, DI (FsAdapter for JudgeEvaluator), and immutable domain objects. The main TypeScript-specific concerns are: (1) `as` casts on new Zod-validated fields that should use proper enum schemas for runtime safety, matching the existing `eval_mode` pattern and the project's PF-005 pitfall; and (2) the exhaustive switch default branch that silently falls back instead of throwing. These are straightforward fixes that would bring the new code in line with existing conventions.
