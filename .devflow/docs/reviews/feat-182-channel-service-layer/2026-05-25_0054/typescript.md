# TypeScript Review Report

**Branch**: feat-182-channel-service-layer -> main
**Date**: 2026-05-25

## Issues in Your Changes (BLOCKING)

### HIGH

**Unsafe cast of untrusted `member.agent` string to `AgentProvider` union** - `src/services/channel-manager.ts:542`
**Confidence**: 95%
- Problem: `member.agent` comes from the `ChannelCreateRequest` — a user-facing API boundary. It is cast via `as Parameters<typeof this.agentRegistry.get>[0]` (resolving to `AgentProvider` = `'claude' | 'codex'`) without runtime validation. While `agentRegistry.get()` returns an `err()` if the provider is unknown, the cast itself silences the type checker, meaning the `member.agent` string bypasses the type-level contract. If `AgentProvider` is later extended or if a refactor removes the `get()` guard, the cast would hide a real bug. Applies ADR-001 rationale of constraining inputs to valid sets at boundaries.
- Fix: Validate `member.agent` against the canonical `AgentProvider` set before calling `get()`:
  ```typescript
  import { AGENT_PROVIDERS } from '../core/agents.js';
  // ...
  if (!AGENT_PROVIDERS.includes(member.agent as AgentProvider)) {
    return err(
      new AutobeatError(ErrorCode.INVALID_INPUT, `Unknown agent '${member.agent}'`, {
        agent: member.agent,
        memberName: member.name,
      }),
    );
  }
  const agentResult = this.agentRegistry.get(member.agent as AgentProvider);
  ```

**Repeated `as ChannelId` casts from `findChannelIdBySession` return type** - `src/services/channel-manager.ts:675,699,713`
**Confidence**: 92%
- Problem: `findChannelIdBySession()` returns `string | undefined` (line 747), forcing every call site in `handleMemberOutputAsync` and `handleMemberExitAsync` to cast the result `as ChannelId`. This undermines the branded-type safety of `ChannelId` — the whole point of branded types is that only the constructor function `ChannelId()` should produce values of that type. Three separate cast sites increase the risk that a plain `string` slips through without branding.
- Fix: Change `findChannelIdBySession` to return `ChannelId | undefined`:
  ```typescript
  private findChannelIdBySession(sessionName: string): ChannelId | undefined {
    for (const [key, handle] of this.memberHandles) {
      if (handle.sessionName === sessionName) {
        const colonIdx = key.indexOf(':');
        if (colonIdx !== -1) return key.slice(0, colonIdx) as ChannelId;
      }
    }
    return undefined;
  }
  ```
  Then remove the `as ChannelId` casts on lines 675, 699, and 713.

### MEDIUM

**`as unknown as TaskId` double-cast in recovery path** - `src/services/channel-manager.ts:453`
**Confidence**: 85%
- Problem: The recovery method builds a `TmuxHandle` with `taskId: channel.id as unknown as TaskId`. This double-cast (`ChannelId -> unknown -> TaskId`) bypasses the branded type system entirely. The comment acknowledges that `isAlive()` only uses `sessionName`, but the `TmuxHandle` type contract states `taskId` is the "Task ID that owns this session." Passing a `ChannelId` where a `TaskId` is expected creates a type-level lie that could cause subtle bugs if any future code path reads `handle.taskId` for task-related operations.
- Fix: Introduce a dedicated recovery handle factory or use a sentinel `TaskId` value:
  ```typescript
  // Option A: Sentinel value (minimal change)
  const CHANNEL_RECOVERY_TASK_ID = TaskId('channel-recovery-placeholder');
  const fakeHandle: TmuxHandle = {
    sessionName: member.tmuxSession,
    taskId: CHANNEL_RECOVERY_TASK_ID,
    sessionsDir: this.sessionsDir,
  };
  ```
  Option B (better long-term): Extract a `TmuxSessionRef` type that only requires `sessionName` for liveness checks, decoupling from the `TaskId` contract.

**`sessionName.replace(/^beat-/, '') as Channel['id']` cast** - `src/services/channel-manager.ts:557`
**Confidence**: 82%
- Problem: `buildTmuxCommand` expects a `TaskId` for its `taskId` field, but this code fabricates one from a session name by stripping the `beat-` prefix and casting the result to `Channel['id']` (which is `ChannelId`, not `TaskId`). This is a branded-type mismatch — `Channel['id']` resolves to `ChannelId` but the target field is `TaskId`. Even if the downstream code doesn't inspect the value, the type contract is violated.
- Fix: Use the `TaskId` constructor with an explicitly labeled sentinel:
  ```typescript
  taskId: TaskId(`channel-${sessionName}`),
  ```

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **`handleKey` return type could use a branded type** - `src/services/channel-manager.ts:791` (Confidence: 65%) -- The composite key `channelId:memberName` is used extensively as a Map key. A branded `HandleKey` type would prevent accidental misuse, though the current string approach works correctly.

- **`SerialQueue.enqueue` swallows errors silently** - `src/services/channel-manager.ts:66` (Confidence: 70%) -- The `.catch(() => {})` in the queue silently swallows all errors. The comment says "errors already logged by caller" but if a future enqueued task forgets to log, errors are permanently lost. Consider at minimum logging the error in the catch rather than discarding it.

- **`require('node:fs')` dynamic fallback in `TmuxSessionManager.pasteContent`** - `src/implementations/tmux/tmux-session-manager.ts:379-389` (Confidence: 62%) -- The fallback `require('node:fs')` uses CommonJS dynamic require inside an ESM-first codebase. While documented as an architecture exception, this could fail in strict ESM environments. The fallback is unlikely to be hit in production (bootstrap injects real fs), but the pattern is fragile.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**TypeScript Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The new channel infrastructure follows the codebase Result-type pattern well and uses branded types (`ChannelId`) consistently at the domain layer. However, several type-safety holes undermine the branded-type guarantees: the `member.agent` string is cast to `AgentProvider` without validation (applies ADR-001 principle of constraining inputs); `findChannelIdBySession` returns unbranded `string` forcing 3 downstream casts; and the recovery path uses `as unknown as TaskId` to cross branded-type boundaries. These are all fixable with small, localized changes that strengthen rather than weaken the type contracts.
