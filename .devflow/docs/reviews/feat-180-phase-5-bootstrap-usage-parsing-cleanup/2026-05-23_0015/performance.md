# Performance Review Report

**Branch**: feat/180-phase-5-bootstrap-usage-parsing-cleanup -> main
**Date**: 2026-05-23

## Issues in Your Changes (BLOCKING)

### HIGH

**Fixed 300ms sleep in reuseSession() blocks event loop during every loop iteration** - `src/implementations/event-driven-worker-pool.ts:295`
**Confidence**: 85%
- Problem: `reuseSession()` uses a hardcoded `await new Promise(resolve => setTimeout(resolve, 300))` to wait for `/clear` to settle. This 300ms sleep runs on every loop iteration reuse. While 300ms is individually small, it is a fixed wall-clock cost per iteration that accumulates over long-running loops (e.g., 100 iterations = 30s of pure sleep). More importantly, the 300ms value is a magic number with no feedback mechanism -- if `/clear` takes 50ms or 500ms, this value is either wasteful or insufficient.
- Fix: Consider making the settle time configurable via a constructor option (e.g., `clearSettleMs`) with a 300ms default, so it can be tuned and tested without code changes. Document the measurement rationale for 300ms.

```typescript
// In EventDrivenWorkerPoolDeps:
readonly clearSettleMs?: number;

// In constructor:
this.clearSettleMs = deps.clearSettleMs ?? 300;

// In reuseSession():
await new Promise<void>((resolve) => setTimeout(resolve, this.clearSettleMs));
```

### MEDIUM

**Duplicate TmuxValidator instantiation at bootstrap** - `src/bootstrap.ts:557`
**Confidence**: 82%
- Problem: When `options.tmuxConnector` is not injected and mode is not `cli`, a new `TmuxValidator({ exec: tmuxExec })` is constructed and `validate()` is called. Later, at line 536, a second `TmuxValidator({ exec: tmuxExec })` is constructed as part of the `TmuxConnector` deps. Each `TmuxValidator` construction is cheap, but `validate()` calls `spawnSync('tmux -V')` which is a ~5-20ms blocking operation. The `TmuxConnector` also calls `validate()` internally on spawn. This is not a significant cost in isolation but represents redundant work during startup.
- Fix: Hoist the validator instance and reuse it for both the eager validation and the TmuxConnector construction.

```typescript
const tmuxValidator = new TmuxValidator({ exec: tmuxExec });

// Eager validation:
if (!options.tmuxConnector && mode !== 'cli') {
  const validationResult = tmuxValidator.validate();
  // ...
}

// Pass same validator to TmuxConnector:
container.registerSingleton('tmuxConnector', () => {
  return new TmuxConnector({
    validator: tmuxValidator,
    sessionManager,
    // ...
  });
});
```

**Polling loop in interactive orchestrator uses setInterval(50ms)** - `src/cli/commands/orchestrate-interactive.ts:351`
**Confidence**: 80%
- Problem: After tmux attach exits and the session is dead, the code polls for `agentExited` flag using `setInterval(50ms)` with a 2-second deadline. This creates up to 40 timer callbacks in a tight loop just to detect a boolean flag change. While the 2s deadline bounds the cost, the polling pattern is less efficient than event-driven notification.
- Fix: Use a simple `setTimeout` chain or a single `Promise` that the `onExit` callback resolves directly, avoiding the tight poll loop. Since `onExit` is already a callback, a resolver pattern is cleaner:

```typescript
// Before session spawn, set up a promise:
let resolveExit: () => void;
const exitPromise = new Promise<void>((resolve) => { resolveExit = resolve; });

// In onExit callback:
onExit: (code) => {
  agentExitCode = code;
  agentExited = true;
  resolveExit();
},

// After attach returns, wait with timeout:
if (!agentExited) {
  await Promise.race([
    exitPromise,
    new Promise<void>((resolve) => setTimeout(resolve, 2000)),
  ]);
}
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**process.env iteration in buildSpawnEnv creates full copy of environment** - `src/implementations/base-agent-adapter.ts:396-399`
**Confidence**: 80%
- Problem: `Object.entries(process.env).filter(...)` iterates all environment variables (often 50-200 entries) and creates intermediate arrays on every `buildTmuxCommand()` call. While this is not a hot path (called once per task spawn), the `envPrefixesToStrip` check uses `Array.some()` per entry -- making it O(env * prefixes). This is a pre-existing pattern but was previously in `spawn()` and `spawnInteractive()` too; now consolidated to a single path which is an improvement.
- Fix: No immediate fix needed since this is called once per spawn and the environment size is bounded. Note for future: if many adapters or high-throughput scenarios emerge, consider caching the filtered environment.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Sequential killAll() blocks for 3s per worker** - `src/implementations/event-driven-worker-pool.ts:535`
**Confidence**: 85%
- Problem: `killAll()` runs `Promise.all(workerIds.map(id => this.kill(id)))` which looks parallel but each `kill()` internally `await`s a 3-second grace period (`setTimeout(resolve, 3_000)` at line 501). While Promise.all does run them concurrently, the `gracefulShutdownSession()` method sends C-c and then waits 3s before checking liveness. For N workers, this is bounded by max(3s) not N*3s since they run concurrently. The decision comment at line 497 documents this tradeoff well. No action needed -- this is informational.

## Suggestions (Lower Confidence)

- **Eager tmux validation in CLI mode** - `src/cli/commands/orchestrate-interactive.ts:100-125` (Confidence: 65%) -- The `validateTmux()` function calls `spawnSync('tmux', ['-V'])` synchronously. This is fine for a one-shot CLI command but duplicates validation logic that exists in `TmuxValidator`. Consider importing and reusing `TmuxValidator` instead of duplicating the version parsing.

- **Object.freeze on every createTask call** - `src/core/domain.ts:259` (Confidence: 60%) -- `createTask()` calls `Object.freeze()` on every task creation. For high-throughput loops with persistent sessions, this freezing adds a small overhead per iteration. Pre-existing pattern, and the cost of `Object.freeze` on a ~20-field object is negligible in practice.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Performance Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The persistent session reuse design is architecturally sound for performance -- eliminating session creation overhead per loop iteration is a significant win. The O(1) map lookup for persistent sessions, the concurrency guard, and the dead-session fallback are well-designed. The main conditions are: (1) make the 300ms settle time configurable rather than hardcoded, and (2) replace the 50ms polling loop in the interactive orchestrator with an event-driven pattern. Neither is blocking for merge but both should be addressed.
