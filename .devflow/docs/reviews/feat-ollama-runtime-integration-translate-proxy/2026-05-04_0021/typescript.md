# TypeScript Review Report

**Branch**: feat-ollama-runtime-integration-translate-proxy -> main
**Date**: 2026-05-04T00:21

## Issues in Your Changes (BLOCKING)

### HIGH

**Hardcoded ollama binary check in checkAgents ignores runtime value** - `src/cli/commands/agents.ts:101-103`
**Confidence**: 85%
- Problem: When `agentConfig.runtime` is truthy, the code unconditionally checks `isCommandInPath('ollama')` and displays `"ollama CLI"` regardless of the actual runtime value. The `Runtime` type is `(typeof RUNTIME_TARGETS)[number]`, which currently only contains `'ollama'`, but the code does not use `agentConfig.runtime` to determine which binary to check. If a new runtime (e.g. `'docker'`) is added to `RUNTIME_TARGETS`, this function would still check for and report `ollama`.
- Fix: Use the runtime value dynamically:
  ```typescript
  if (agentConfig.runtime) {
    const runtimeBinary = agentConfig.runtime; // e.g. 'ollama'
    const found = isCommandInPath(runtimeBinary);
    const status = found ? ui.cyan('[found]') : '[not found]';
    ui.info(`  ${ui.dim(`runtime: ${agentConfig.runtime} — ${runtimeBinary} CLI ${status}`)}`);
  }
  ```
  This also benefits from the exhaustive `never` pattern used in `resolveRuntime()` when a new runtime is added -- the check here would naturally extend without hardcoding.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Non-null assertion on proxyUrl getter** - `src/translation/proxy/proxy-manager.ts:118,157`
**Confidence**: 80%
- Problem: Two uses of `this.proxyUrl!` in the `start()` method. While both are safe in the current control flow (the port is either checked or just assigned), non-null assertions bypass type narrowing and could mask regressions if the class is refactored. The project's CLAUDE.md explicitly states `user!.name!` is an anti-pattern; the preferred pattern is `user?.name ?? default`.
- Fix: Since `this.port` is verified non-undefined immediately before both usages, extract the URL inline or use a local variable:
  ```typescript
  // Line 118: after guard `this.port !== undefined`
  const url = `http://127.0.0.1:${this.port}`;
  return ok({ port: this.port, proxyUrl: url });

  // Line 157: after assignment `this.port = startResult.value.port`
  const url = `http://127.0.0.1:${this.port}`;
  return ok({ port: this.port, proxyUrl: url });
  ```
  Note: This was actually the pre-existing pattern before this PR refactored to use `this.proxyUrl!`. The refactoring introduced the assertion where it did not exist before.

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Repetitive test helper for protected method access** - `tests/unit/implementations/agent-adapters.test.ts:1181-1250` (Confidence: 65%) -- The pattern `(adapter as unknown as { resolveRuntime(c: AgentConfig, m?: string): unknown }).resolveRuntime(...)` is repeated 6 times. A local helper function would reduce noise: `const callResolveRuntime = (a: ClaudeAdapter, c: AgentConfig, m?: string) => (a as unknown as ...).resolveRuntime(c, m)`.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 0 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**TypeScript Score**: 8/10
**Recommendation**: CHANGES_REQUESTED

The type system usage is strong overall: const tuple derivation patterns (`PROXY_TARGETS`, `RUNTIME_TARGETS`), `as const satisfies` for Zod enums, exhaustive `never` guard in `resolveRuntime`, proper `Result<T>` return types, and no `any` types anywhere in the diff. The `isRuntimeSupportedForAgent` function correctly uses `readonly string[]` widening to make `.includes()` work with the broader `AgentProvider` type. The main concern is the hardcoded `'ollama'` in the CLI display function which breaks the extensibility pattern established in the rest of the PR.
