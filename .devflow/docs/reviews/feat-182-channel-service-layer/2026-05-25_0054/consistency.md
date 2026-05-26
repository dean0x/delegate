# Consistency Review Report

**Branch**: feat-182-channel-service-layer -> main
**Date**: 2026-05-25T00:54

## Issues in Your Changes (BLOCKING)

### HIGH

**Event emission error handling deviates from established service pattern (5 occurrences)** -- Confidence: 92%
- `src/services/channel-manager.ts:290`, `src/services/channel-manager.ts:317`, `src/services/channel-manager.ts:343`, `src/services/channel-manager.ts:378`, `src/services/channel-manager.ts:404`
- Problem: The established pattern in `ScheduleManagerService` and `LoopManagerService` is to (a) capture the emit result, (b) check `emitResult.ok`, (c) log with `logger.error`, and (d) `return err(emitResult.error)` to propagate the failure. ChannelManager deviates in two ways:
  - `createChannel` (line 224): Checks the result but logs with `logger.warn` and continues instead of returning an error. This is a deliberate softening compared to the established pattern, but inconsistent with other services.
  - `destroyChannel` (line 290), `pauseChannel` (line 317), `resumeChannel` (line 343), `sendMessage` (lines 378, 404): Await the emit but discard the result entirely -- no error check, no logging. Any emit failure is silently swallowed.
- Fix: Adopt the established pattern consistently:
  ```typescript
  // destroyChannel example (apply to all 5 locations)
  const emitResult = await this.eventBus.emit('ChannelDestroyed', { channelId, reason: destroyReason });
  if (!emitResult.ok) {
    this.logger.error('Failed to emit ChannelDestroyed event', emitResult.error, { channelId });
    return err(emitResult.error);
  }
  ```
  Note: For the `createChannel` case (line 224), change from `warn` + continue to `error` + `return err()` to match ScheduleManagerService/LoopManagerService.

**Missing constructor initialization log** -- `src/services/channel-manager.ts:114-122` -- Confidence: 95%
- Problem: All three existing service managers (`ScheduleManagerService`, `LoopManagerService`, `OrchestrationManagerService`) log a debug message in their constructor: `this.logger.debug('XxxService initialized')`. ChannelManager omits this, breaking the observable initialization pattern used for debugging bootstrap issues.
- Fix: Add at the end of the constructor:
  ```typescript
  constructor(deps: ChannelManagerDeps) {
    // ... existing field assignments ...
    this.logger.debug('ChannelManager initialized');
  }
  ```

### MEDIUM

**Constructor DI style inconsistency across service managers** -- `src/services/channel-manager.ts:114` -- Confidence: 80%
- Problem: `ScheduleManagerService` and `LoopManagerService` use positional constructor parameters, while `OrchestrationManagerService` and `ChannelManager` use a deps-object pattern. The codebase has two constructor conventions in the same architectural layer. ChannelManager follows the newer `OrchestrationManagerService` pattern (deps object), which is arguably better but is not the majority pattern.
- Fix: This is an observation rather than a required change. The deps-object pattern is defensible for services with 6+ dependencies (ChannelManager has 7). If the project intends to standardize, prefer the deps-object pattern going forward and document the migration plan. No immediate code change needed.

## Issues in Code You Touched (Should Fix)

### HIGH

**`require()` fallback in `TmuxSessionManager.pasteContent()` breaks ESM consistency** -- `src/implementations/tmux/tmux-session-manager.ts:378-391` -- Confidence: 85%
- Problem: The fallback for `writeFileSync` and `unlinkSync` uses `require('node:fs')`. The entire codebase uses ESM (`import`) exclusively. The `require()` call is guarded by an eslint-disable comment, signaling it deviates from project norms. The `ARCHITECTURE EXCEPTION` comment acknowledges this but the justification ("legacy callers") is speculative -- bootstrap.ts always injects the real deps.
- Fix: Since bootstrap.ts always injects these deps and the class should not be used without injection, remove the fallback entirely and make the deps required:
  ```typescript
  export interface TmuxSessionManagerDeps {
    exec: ExecFn;
    maxConcurrentSessions?: number;
    writeFileSync: (path: string, content: string) => void;
    unlinkSync: (path: string) => void;
  }
  ```
  If backward compatibility is needed, throw a clear error instead of using `require()`:
  ```typescript
  if (!this.deps.writeFileSync) {
    return err(tmuxSessionFailed('pasteContent', 'writeFileSync dep is required'));
  }
  ```

## Pre-existing Issues (Not Blocking)

*(none)*

## Suggestions (Lower Confidence)

- **`sendMessage` checks in-memory `pausedChannels` before DB status** -- `src/services/channel-manager.ts:349` (Confidence: 65%) -- After a process restart, `pausedChannels` is only rebuilt during `recoverChannels()`. If recovery has not run yet (e.g., sendMessage called early), the in-memory check could miss a PAUSED channel. Consider also checking `channel.status` from the DB fetch that follows.

- **`handleMemberOutputAsync` uses string-based channelId without type narrowing** -- `src/services/channel-manager.ts:675` (Confidence: 70%) -- `channelId` from `findChannelIdBySession()` returns `string | undefined`, but is then cast to `ChannelId` inline at call sites (`channelId as ChannelId`). The branded-type cast is scattered across three lines (675, 699, 712). A single narrowing at the top of the enqueue callback would be cleaner and safer.

- **`ChannelRouter.route()` returns empty targets for no-mode channels** -- `src/services/channel-router.ts:69` (Confidence: 60%) -- For single-agent channels with no `communicationMode`, `route()` returns `ok({ targets: [] })` (empty targets). This is semantically correct for "no routing" but could be confusing to callers who expect an error when nothing is routed. The existing callers handle it correctly, but the API could benefit from a distinct return type or documentation clarifying the "no-op routing" case.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 1 | 0 |
| Should Fix | 0 | 1 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Consistency Score**: 6/10
**Recommendation**: CHANGES_REQUESTED

The new channel service layer follows many established patterns well (factory handler pattern with `ChannelHandler.create()` + `subscribeToEvents()`, Result types everywhere, constructor injection, handler-setup integration). However, the event emission error handling (5 occurrences) systematically deviates from the pattern established by `ScheduleManagerService` and `LoopManagerService` -- silently swallowing failures where those services propagate errors. The missing initialization log is minor but breaks observability conventions. The `require()` fallback in `TmuxSessionManager` breaks ESM consistency. ADR-001 (channel name validation via `CHANNEL_NAME_REGEX` constrained to tmux `SESSION_NAME_REGEX`) is correctly applied throughout (applies ADR-001).
