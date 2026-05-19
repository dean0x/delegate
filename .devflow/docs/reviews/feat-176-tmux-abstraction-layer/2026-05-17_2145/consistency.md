# Consistency Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17
**Diff**: git diff 40f9537...HEAD (5 commits)

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Inconsistent warn message prefix style** - `tmux-connector.ts` (multiple locations)
**Confidence**: 85%
- `tmux-connector.ts:167` — `'spawn: hooks.cleanup failed'` (method colon prefix)
- `tmux-connector.ts:206` — `'destroy: hooks.cleanup failed'` (method colon prefix)
- `tmux-connector.ts:249` — `'dispose: hooks.cleanup failed'` (method colon prefix)
- `tmux-connector.ts:354` — `'handleMessageFile threw unexpectedly'` (method name, no colon)
- `tmux-connector.ts:631` — `'triggerExit: hooks.cleanup failed'` (method colon prefix)
- Problem: The new cleanup-error warn messages use `'methodName: hooks.cleanup failed'` prefix style (4 locations), while the new `.catch()` message at line 354 uses `'handleMessageFile threw unexpectedly'` (no colon separator). Within the same file, the pre-existing warn messages use a third style: sentence-case descriptions like `'Failed to start sentinel watcher'`, `'Sentinel watcher error — degrading to staleness detection'`. The new code introduces a second new convention (`method: description`) that coexists with both the catch-style and the pre-existing sentence style.
- Fix: Since the pre-existing messages in this file use sentence-case descriptions (e.g., `'Failed to start sentinel watcher'`), align the new messages to match. Alternatively, if `method: description` is the intended new convention, apply it consistently to all new messages including the catch handler at line 354:
```typescript
// Option A: Match pre-existing sentence style
this.deps.logger.warn('Hooks cleanup failed during spawn', { ... });
this.deps.logger.warn('Hooks cleanup failed during destroy', { ... });
this.deps.logger.warn('Hooks cleanup failed during dispose', { ... });
this.deps.logger.warn('Hooks cleanup failed during exit', { ... });
this.deps.logger.warn('Message file handler threw unexpectedly', { ... });

// Option B: Consistent method-prefix style for ALL new messages
this.deps.logger.warn('spawn: hooks.cleanup failed', { ... });
this.deps.logger.warn('startMessagesWatcher: handleMessageFile threw unexpectedly', { ... });
```

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Unused `_watchPath` parameter name inconsistency** - `tmux-connector.test.ts:414` (Confidence: 65%) — The new watcher error test uses `_watchPath` for the unused parameter while `makeWatchMock()` at line 81 uses `watchPath` (no underscore prefix). Both ignore the parameter but use different naming for the same concept.

- **`await` on synchronous `spawn()` in tests** - `tmux-connector.test.ts:438,776,1004` (Confidence: 70%) — `spawn()` returns `Result<TmuxHandle, AutobeatError>` (synchronous), but tests use `await connector.spawn(...)`. This works due to JS auto-unwrapping of non-Promise values, but could mislead readers into thinking `spawn()` is async.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | - | 0 | 0 | 0 |
| Pre-existing | - | - | 0 | 0 |

**Consistency Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The changes are well-structured refactors that improve correctness (cleanup Result handling, staleness iteration-mutation fix, MIN_CHECK_INTERVAL_MS clamp, watcher error handlers). The extracted methods (`buildActiveSession`, `startSentinelWatcher`, `startMessagesWatcher`, `forceDeliverRemaining`) follow existing decomposition patterns. The SAFE_PATH_REGEX and TASK_ID_REGEX consolidation into types.ts is a clean DRY improvement. The one consistency concern is the mixed warn-message prefix convention, which is MEDIUM severity and non-blocking for merge.
