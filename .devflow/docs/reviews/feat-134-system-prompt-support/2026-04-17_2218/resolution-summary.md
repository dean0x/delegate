# Resolution Summary

**Branch**: feat/134-system-prompt-support -> main
**Date**: 2026-04-17_2218
**Review**: .docs/reviews/feat-134-system-prompt-support/2026-04-17_2218
**Command**: /resolve

## Statistics
| Metric | Value |
|--------|-------|
| Total Issues | 16 |
| Fixed | 10 |
| False Positive | 6 |
| Deferred | 0 |
| Blocked | 0 |

## Fixed Issues
| Issue | File:Line | Commit |
|-------|-----------|--------|
| TaskRequestSchema missing systemPrompt — silent data loss on DB round-trip | schedule-repository.ts:78 | 7512b11 |
| LoopConfigSchema missing systemPrompt — silent data loss on DB round-trip | schedule-repository.ts:124 | 7512b11 |
| createScheduledLoop taskTemplate omits systemPrompt (consistency gap) | schedule-manager.ts:508 | 7512b11 |
| No tests for systemPrompt in schedule flows (6 service + 4 DB tests added) | schedule-manager.test.ts, schedule-repository.test.ts | 7512b11 |
| mkdirSync called on every Gemini spawn (hoisted to constructor) | gemini-adapter.ts:37 | 67aa82b |
| Path traversal risk in cleanupTaskFile (containment guard added) | gemini-adapter.ts:63 | 67aa82b |
| No unit tests for GeminiBasePromptCache (9 tests added) | agent-adapters.test.ts | 67aa82b |
| Worker pool cleanup not wrapped in try/catch (best-effort guard added) | event-driven-worker-pool.ts:308 | be43f63 |
| No tests for worker pool cleanup delegation (3 tests added) | event-driven-worker-pool.test.ts | be43f63 |
| Mock adapter missing cleanup() method | agent-registry.test.ts:13 | 9dce51b |
| Console.error spy leak risk in Gemini test | agent-adapters.test.ts:968 | 9dce51b |

## False Positives
| Issue | File:Line | Reasoning |
|-------|-----------|-----------|
| CLI run command 162-line arg-parsing block | cli.ts:63-224 | Pre-existing pattern; PR only added ~11 lines following established convention |
| parseLoopCreateArgs 153 lines / 21 branches | loop.ts:211-363 | Pre-existing; PR added ~6 lines |
| cli.ts is 359 lines as procedural script | cli.ts:1-359 | Pre-existing organic growth (341 lines on main) |
| Dash-guard pattern inconsistency | cli.ts, orchestrate.ts, loop.ts | Intentional design decision — system prompts are freeform text that may start with dashes |
| `as AgentProvider` cast on Zod data | mcp-adapter.ts:2025,2439,2861 | Pre-existing pattern (9+ occurrences on main); no new casts introduced by this PR |
| Agent registry lookup on every cleanup call | event-driven-worker-pool.ts:308 | O(1) Map lookup; storing adapter on WorkerState would couple domain type to infrastructure |

## Commits Created
- 7512b11 fix: preserve systemPrompt through schedule DB round-trip
- 67aa82b fix(gemini): hoist mkdirSync to constructor, add path-traversal guard, and add GeminiBasePromptCache unit tests
- be43f63 fix(worker-pool): make adapter cleanup() truly best-effort and add tests
- 9dce51b test: fix mock interface drift and spy leak in agent tests
- b2e7dc2 chore: simplify GeminiBasePromptCache and hoist test spy lifecycle

## Simplification
- Precomputed `#resolvedCacheDir` in constructor (avoid per-call `path.resolve`)
- Hoisted `consoleSpy` to describe-level beforeEach/afterEach in GeminiBasePromptCache tests

## Tech Debt Added
None.
