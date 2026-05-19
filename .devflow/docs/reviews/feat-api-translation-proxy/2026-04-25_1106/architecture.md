# Architecture Review Report

**Branch**: feat/api-translation-proxy -> main
**Date**: 2026-04-25
**Diff**: `git diff b762591...HEAD` (incremental)

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Container.dispose() uses duck-typed DisposableService for proxyManager.stop()** - `src/core/container.ts:214-220`
**Confidence**: 82%
- Problem: The `DisposableService` interface declares `stop?(): unknown` which is a catch-all duck type. `Container.dispose()` calls `await proxyManager.stop()` which works because ProxyManager.stop() returns `Promise<void>`, and `await unknown` is valid JS. However, the duck-typing approach means any service registered as `proxyManager` must happen to have a `.stop()` method with the right async semantics. This is the same pre-existing pattern used for `scheduleExecutor.stop()`, `resourceMonitor.stopMonitoring()`, etc. -- but adding another service to the duck-typed dispose chain deepens the coupling to this untyped pattern.
- Impact: If a different implementation is ever registered under `proxyManager` without a compatible `stop()` method, the call will silently succeed (returning `undefined`) or misbehave. The `as DisposableService` cast hides this at compile time.
- Fix: This is an incremental addition to an existing pattern -- not a new architectural violation. The correct long-term fix would be to introduce a `Disposable` interface (e.g., `{ dispose(): Promise<void> }`) and have Container track disposable services explicitly, but that is a separate refactoring concern. The current change is consistent with the existing pattern.

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

_No pre-existing CRITICAL issues in the changed files._

## Suggestions (Lower Confidence)

- **Dual proxy shutdown paths** - `src/index.ts:77-80` and `src/core/container.ts:214-220` (Confidence: 65%) -- Both `index.ts` signal handler and `Container.dispose()` can stop the proxy. The DD3 comment explicitly notes ProxyManager.stop() is idempotent and this is intentional, so this is by design. However, the index.ts handler runs its own manual shutdown sequence that partially overlaps with dispose(), which could drift over time. Consider eventually consolidating all shutdown into dispose() only.

- **PromptCacheState shared mutability across concurrent requests** - `src/translation/middleware/prompt-cache.ts:24-26` (Confidence: 72%) -- The `PromptCacheState` object is shared across all per-request PromptCacheMiddleware instances via reference. Both `lastPrefixHash` reads and writes happen synchronously within the Node.js event loop (inside processResponse), so there is no data race in the strict sense. However, concurrent requests will overwrite each other's `lastPrefixHash`, meaning cache hit detection is approximate (last-writer-wins). The DECISION comment in proxy-manager.ts acknowledges this is intentional -- cache estimation is best-effort, not exact.

- **`TRANSLATE_TARGETS` requires manual narrowing cast at usage sites** - `src/core/configuration.ts:268`, `src/cli/commands/agents.ts:131` (Confidence: 60%) -- Both `loadAgentConfig` and `agentsConfigSet` cast `TRANSLATE_TARGETS as readonly string[]` to use `.includes()`. This is a well-known TypeScript limitation with `const` tuples and `.includes()`, and the cast is the standard workaround. Not an architectural concern.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Architecture Score**: 8/10
**Recommendation**: APPROVED

### Rationale

The changes demonstrate sound architectural judgment across several dimensions:

1. **Single source of truth (TRANSLATE_TARGETS)**: Consolidating the translate target list from a duplicated `SUPPORTED_TRANSLATE_TARGETS` local constant into a canonical `TRANSLATE_TARGETS` export with a derived `TranslateTarget` type eliminates a synchronization hazard. The type is derived from the runtime constant (`(typeof TRANSLATE_TARGETS)[number]`), so they cannot drift.

2. **ModeFlags extension (skipProxy)**: Adding `skipProxy` to `ModeFlags` and driving it from `deriveModeFlags()` is consistent with the existing pattern for `skipResourceMonitoring`, `skipScheduleExecutor`, and `skipRecovery`. The mode-to-flag mapping is centralized and testable. The DD1 decision comment explains why proxy starts in both `server` and `run` modes (both spawn workers).

3. **Fatal proxy failure (DD2)**: Changing proxy startup failure from a non-fatal warning to a fatal `Result.err` is the correct architectural choice. When the user has explicitly configured `translate`, silently falling back to direct Anthropic API would produce confusing downstream errors (wrong API key, wrong model). The error message includes remediation steps.

4. **Proxy cleanup in Container.dispose() (DD3)**: Adding proxy shutdown to the centralized dispose chain is a DRY improvement. Previously, only `index.ts` shut down the proxy. Now `run.ts`, `orchestrate.ts`, and any future callers that use `container.dispose()` automatically get proxy cleanup. The idempotency of ProxyManager.stop() handles the overlap with the index.ts handler.

5. **PromptCacheMiddleware shared state pattern**: Extracting cross-request state into a separate `PromptCacheState` interface and injecting it via constructor is a clean separation. Per-request fields (`currentPrefixHash`, `currentPrefixTokens`) remain instance-scoped, while the cross-request `lastPrefixHash` is shared intentionally. This resolves a design tension where the middlewareFactory pattern (per-request instances) conflicted with the need for cross-request cache tracking.

6. **StreamCallbackContext refactoring**: Consolidating `resetIdleTimer`, `clearIdleTimer`, and `resolve` callbacks into a `StreamCallbackContext` interface reduces parameter sprawl across `handleStreamingError`, `handleJsonFallback`, and `handleSseStream` from 5-7 parameters to 3-5. This is a clean application of the Parameter Object pattern.

7. **openai-codec simplification**: Extracting `parseToolArguments` helper and restructuring the tool call delta processing to use early `Map.get()` with `!== undefined` checks instead of `has()` + `get()` eliminates redundant lookups and improves readability.

No SOLID violations, no layering issues, no circular dependencies, and all dependency directions remain correct (configuration -> bootstrap -> container, not the reverse).
