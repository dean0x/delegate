# Resolution Summary

**Branch**: feat/v1.4.0-reliability-eval-redesign → main
**Date**: 2026-04-15_1023
**Review**: .docs/reviews/feat-v1.4.0-reliability-eval-redesign/2026-04-15_1023
**Command**: /resolve
**PR**: #136

## Statistics

| Metric | Value |
|--------|-------|
| Total Issues Resolved | 17 |
| Fixed | 17 |
| False Positive | 0 |
| Deferred to Tech Debt | 0 |
| Blocked | 0 |

## Fixed Issues

### CRITICAL (Documentation — Batch A)
| Issue | File | Commit |
|-------|------|--------|
| Wrong `evalType` enum (claimed `agent\|feedforward\|judge`, actual `feedforward\|judge\|schema`, default `feedforward`); undocumented `schema` mode added | `docs/releases/RELEASE_NOTES_v1.4.0.md`, `CHANGELOG.md` | 9ff18d6 |
| False "no new migrations" claim — v21 (heartbeat + eval columns) and v22 (loops CHECK constraint rebuild) documented with backup guidance | `docs/releases/RELEASE_NOTES_v1.4.0.md`, `CHANGELOG.md` | 9ff18d6 |

### HIGH
| Issue | File:Line | Commit |
|-------|-----------|--------|
| Judge decision filename pattern corrected from `.autobeat-judge-{judgeTaskId}` to literal `.autobeat-judge-task-{uuid}` | `docs/releases/RELEASE_NOTES_v1.4.0.md` | 9ff18d6 |
| FeedforwardEvaluator pass-through behavior (no `evalPrompt` → `decision: continue`) documented | `docs/releases/RELEASE_NOTES_v1.4.0.md`, `CHANGELOG.md` | 9ff18d6 |
| Added v1.4.0 entries to `docs/FEATURES.md` + `docs/ROADMAP.md` (released versions table, current status, eval strategies) | `docs/FEATURES.md`, `docs/ROADMAP.md` | 9ff18d6 |
| Tautological feedback-cap tests rewritten to invoke real evaluator with >16_000-char feedback | `tests/unit/services/eval-domain-batch2.test.ts:675-715` | 6075370 / 337dc9e |
| Added real O_EXCL cross-process atomicity test via `spawnSync` with child process attempting acquire | `tests/unit/services/schedule-executor-autostart.test.ts:284-369` | 6075370 / 337dc9e |
| `expect(true).toBe(true)` placeholder removed; replaced with comment explaining ESM `vi.mock` limitation and pointer to sibling coverage | `tests/unit/services/schedule-executor-autostart.test.ts:264-277` | 6075370 |
| `event as TaskFailedEvent` unchecked casts eliminated — branch directly on `event.type === 'TaskFailed'` for narrowing | `src/services/handlers/loop-handler.ts:261, 1591` | 9ff18d6 |
| **ProcessSpawner interface widened to accept full `SpawnOptions`** — fixes cross-cutting LSP violation where orchestratorId + jsonSchema were silently dropped | `src/core/interfaces.ts`, `src/implementations/process-spawner-adapter.ts` + 4 fixture files + 2 test files | 6075370 |

### MEDIUM
| Issue | File:Line | Commit |
|-------|-----------|--------|
| Tautological `EvalResult.decision` tests strengthened with DB-state side-effect assertions (loop status, iteration status) | `tests/unit/services/handlers/loop-handler.test.ts:1773-2055` | 337dc9e |
| `registerSignalHandlers` now accepts optional `exit` callable (default `process.exit.bind(process)`); tests replace `vi.spyOn(process, 'exit')` with injected fake | `src/cli/commands/schedule-executor.ts:171`, `tests/unit/services/schedule-executor-pure-fns.test.ts:158-197` | 6075370 |
| `setImmediate` sequencing in shared eval helper documented with WHY comment (load-bearing for multi-level async chain in `buildEvalPrompt`) | `tests/fixtures/eval-test-helpers.ts:157-163` | 6075370 |
| `EvalPromptBase.gitDiffInstructions` removed from interface (verified unused); remains a local composition helper | `src/services/eval-prompt-builder.ts:30` | 9ff18d6 |
| `readonly` modifiers added to all 5 fields of `IterationResultFields` (consistency with sibling types like `SpawnOptions`) | `src/services/handlers/loop-handler.ts:68-74` | 9ff18d6 |
| `acquirePidFile` caller now exhaustiveness-narrowed with `const _exhaustive: never` guard | `src/cli/commands/schedule-executor.ts:218-226` | 9ff18d6 |
| Simplifier cleanup: 3 stale positional `spawn()` calls in `network-failures.test.ts` aligned to `SpawnOptions`; removed spurious `async`/`await` on sync `Result<>` returns | `tests/unit/error-scenarios/network-failures.test.ts` | e958571 |
| Biome auto-fix: `SpawnOptions` import ordering in `interfaces.ts` after batch-D addition | `src/core/interfaces.ts` | e958571 |

## False Positives

None.

## Deferred to Tech Debt

None. All flagged issues were within standard or careful risk tiers; none required architectural overhaul.

## Blocked

None.

## Commits Created

| SHA | Message |
|-----|---------|
| 9ff18d6 | docs(v1.4.0): fix release notes factual errors (#136 review) + Batch C typescript fixes |
| 6075370 | Loop pass — Batch B + D changes (ProcessSpawner widening, test refactors, DI) |
| 049605d | Loop pass |
| 337dc9e | fix(tests): address test-quality issues from v1.4.0 review (#136) |
| e958571 | chore(resolve): simplifier + lint cleanup after v1.4.0 resolution |

## Validation

All Claude-Code-safe test suites PASS:
- typecheck, check (biome), build — clean
- **2,544 tests across 73 test files** — all green
- test:core, test:repositories, test:adapters, test:integration, test:error-scenarios, test:scheduling, test:handlers, test:services, test:cli, test:implementations

## Artifacts

- Review reports: `.docs/reviews/feat-v1.4.0-reliability-eval-redesign/2026-04-15_1023/*.md` (11 files)
- Review summary: `.docs/reviews/feat-v1.4.0-reliability-eval-redesign/2026-04-15_1023/review-summary.md`
- Resolution report: `.docs/reviews/feat-v1.4.0-reliability-eval-redesign/2026-04-15_1023/resolution-summary.md` (this file)
- PR #136 inline comments (10 posted during review phase)

## Next Action

Branch is ready for merge. Commits have been pushed to origin. PR #136 has 10 inline review comments that are now addressed by commits 9ff18d6 → e958571. Recommend re-requesting review on PR #136 (or self-merging if branch protection permits, following CLAUDE.md release process for the subsequent v1.4.0 release PR).
