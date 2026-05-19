# Regression Review Report

**Branch**: feat/134-system-prompt-support -> main
**Date**: 2026-04-20
**Diff**: `git diff aa69fa2007c5ece548f8916d27d86c19bd73126e...HEAD`

## Issues in Your Changes (BLOCKING)

### HIGH

**Empty-string systemPrompt now produces empty string instead of auto-generated prompt** - `src/services/orchestration-manager.ts:321-322`
**Confidence**: 85%
- Problem: The refactored `buildFinalPrompts` method uses `??` (nullish coalescing) instead of the original `Boolean()` truthiness check. When `request.systemPrompt` is `""` (empty string), `.trim()` yields `""`, and `"" ?? orchestratorSystemPrompt` evaluates to `""` because `??` only catches `null`/`undefined`. Previously, `Boolean("")` was `false`, so the rich auto-generated orchestrator system prompt was used. Now, the loop receives an empty system prompt, losing all orchestrator role instructions, decision protocol, resilience patterns, etc.
- Fix: Use logical OR (`||`) instead of nullish coalescing, or keep the explicit truthiness check:
```typescript
// Option A: logical OR (treats "" as absent)
const finalSystemPrompt = customSystemPrompt || orchestratorSystemPrompt;

// Option B: explicit truthiness (mirrors old behavior exactly)
const hasCustom = Boolean(customSystemPrompt);
const finalSystemPrompt = hasCustom ? customSystemPrompt! : orchestratorSystemPrompt;
```
- Impact: Orchestrations created with `systemPrompt: ""` (or whitespace-only after trim) will operate without any system prompt guidance instead of receiving the auto-generated orchestrator instructions. The existing test ("should treat empty-string systemPrompt as absent") passes because its assertion is too weak -- it checks `not.toBe('   ')` and `not.toContain('ORCHESTRATOR CONTRACT')`, both of which `""` satisfies.

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

_No issues found._

## Suggestions (Lower Confidence)

- **SchedulePipelineSchema steps lack per-step systemPrompt** - `src/adapters/mcp-adapter.ts:247-253` (Confidence: 65%) -- `CreatePipelineSchema` now supports per-step `systemPrompt`, but the equivalent `SchedulePipelineSchema` steps do not. This is not a regression (never existed before) but creates an inconsistency between instant and scheduled pipelines.

## Regression Checklist

- [x] No exports removed without deprecation
- [x] No files deleted
- [x] Return types backward compatible
- [x] Side effects preserved (events, logging)
- [x] All consumers of changed code updated
- [x] CLI options preserved
- [x] API endpoints preserved
- [x] No new TODOs indicating incomplete work
- [x] Commit messages match implementation
- [x] Zod schema limit removals are intentional (`.max()` constraints lifted per design)
- [x] `cleanupFn` closure pattern captures adapter at spawn time -- eliminates post-dispose registry lookup regression
- [x] Orchestrator prompt shared-fragment refactor produces identical text output
- [x] `PipelineStepRequest` and `PipelineCreateRequest` domain types updated with `systemPrompt`
- [ ] `buildFinalPrompts` empty-string handling differs from original `Boolean()` check

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | - | 0 | 0 |

**Regression Score**: 8/10
**Recommendation**: CHANGES_REQUESTED

The single blocking issue is the `??` vs `Boolean()` semantic change in `buildFinalPrompts` that causes empty-string `systemPrompt` to bypass the auto-generated orchestrator instructions. While the edge case is unlikely to occur via normal MCP usage (users rarely pass `""`), it represents a behavioral regression from the prior implementation. A one-character fix (`??` to `||`) resolves it.

All other changes are regression-safe:
- Zod `.max()` constraint removals are intentional (text length limits lifted) -- relaxing constraints does not break existing callers
- The `cleanupFn` closure pattern in `event-driven-worker-pool.ts` is a strict improvement that eliminates a silent `?? 'claude'` fallback and post-dispose registry lookup risk
- The orchestrator-prompt shared-fragment refactor produces byte-identical output (verified by examining interpolated values)
- Domain type additions (`systemPrompt` on `PipelineStepRequest`/`PipelineCreateRequest`) are additive and optional
- Test refactors (`setupAdapter` helper, test name normalization) are mechanical with no behavioral changes
