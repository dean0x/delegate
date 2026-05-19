# Consistency Review Report

**Branch**: feat/api-translation-proxy -> main
**Date**: 2026-04-27

## Issues in Your Changes (BLOCKING)

### HIGH

**Inconsistent database registration pattern** - `src/bootstrap.ts:257-275`
**Confidence**: 85%
- Problem: The database registration was changed from `registerSingleton` (lazy factory) to `registerValue` (eager instantiation wrapped in try/catch). Every other repository/service in bootstrap.ts uses `registerSingleton` with a factory callback. This breaks the registration pattern uniformity: all ~15 other services use `container.registerSingleton('name', () => { ... })` while database now uses an eager `try { ... container.registerValue('database', db) } catch { ... }` block outside a factory.
- Fix: The eager pattern is justified here (catching native module ABI mismatch at bootstrap time before any lazy factory runs), but should have a DECISION comment explaining why this is an intentional deviation from the registerSingleton pattern used by every other service. For example:
```typescript
// DECISION: Database is eagerly instantiated (registerValue) instead of lazy
// (registerSingleton) to detect native module ABI mismatches at bootstrap time,
// before any downstream factories attempt to resolve 'database'.
try {
  const dbLogger = logger.child({ module: 'database' });
  const db = new Database(undefined, dbLogger);
  container.registerValue('database', db);
} catch ...
```

**SetPayload interface removed, CheckPayload retained -- inconsistent response typing** - `src/adapters/mcp-adapter.ts:3521-3536`
**Confidence**: 82%
- Problem: The `check` action defines a local `CheckPayload` interface (line 3366) to type its response object, then uses `const checkPayload: CheckPayload = { ... }`. The `set` action previously had an equivalent `SetPayload` interface that was removed in this PR, and the response object is now inlined directly into `JSON.stringify`. This creates an asymmetry within the same switch-case block: `check` has typed payloads, `set` has inline object literals.
- Fix: Either remove `CheckPayload` too (both actions use inline literals) or keep both typed. Consistency within the same function matters more than either style choice. The simpler fix is to inline `CheckPayload` as well:
```typescript
case 'check': {
  // ...
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        success: true,
        ...status,
        ...(agentConfig.apiKey && { storedKey: maskApiKey(agentConfig.apiKey) }),
        // ...
      }, null, 2),
    }],
  };
}
```

### MEDIUM

**Dynamic import vs. static import for probeUrl** - `src/cli/commands/agents.ts:165`
**Confidence**: 84%
- Problem: In `agents.ts` the `probeUrl` function is loaded via dynamic import (`await import('../../utils/url-probe.js')`) with a comment about avoiding network code loading. However, in `mcp-adapter.ts` the same function is imported statically at the top level (`import { probeUrl } from '../utils/url-probe.js'`). Both files use probeUrl only conditionally (when baseUrl-related fields change), yet only agents.ts uses dynamic import. This inconsistency suggests the optimization rationale does not apply uniformly.
- Fix: Either use static imports in both files (mcp-adapter already does), or add a brief comment in mcp-adapter explaining why dynamic import is not needed there (e.g., MCP adapter always loads the full module set). The simplest fix is to use static import in agents.ts too since mcp-adapter already eagerly loads it:
```typescript
import { probeUrl } from '../../utils/url-probe.js';
```

**Probe error handling inconsistency between check and set actions** - `src/adapters/mcp-adapter.ts:3361` vs `src/adapters/mcp-adapter.ts:3516`
**Confidence**: 80%
- Problem: In the `check` action (line 3361), when `probeResult.ok` is true, the full `UrlProbeResult` is included in the response regardless of severity. In the `set` action (line 3516), the probe result is only surfaced as a warning when `probeResult.ok && probeResult.value.severity !== 'ok'`. When `probeResult` is `err()`, `check` silently omits connectivity while `set` silently ignores the error. The handling is functionally different for the same utility.
- Fix: This may be intentional (check shows full diagnostics, set only warns on problems), but should have a brief comment explaining the asymmetry. Add a comment above the set action probe block:
```typescript
// Unlike 'check' (which includes full connectivity for diagnostics),
// 'set' only surfaces non-ok probe results as warnings.
```

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

_No issues found._

## Suggestions (Lower Confidence)

- **Double loadAgentConfig call in agents.ts** - `src/cli/commands/agents.ts:161,184` (Confidence: 65%) -- When `key === 'translate'` and `value !== ''`, `loadAgentConfig(agent)` is called twice in succession: once for the probe block (line 161) and once for the translate-missing-fields warning (line 183). Could consolidate into a single call.

- **Version script lacks error handling** - `scripts/generate-version.mjs:6` (Confidence: 60%) -- The script uses `JSON.parse(readFileSync(...))` without try/catch. If package.json is missing or malformed, the error message would be a raw Node exception rather than a helpful build error. Other build scripts in the project (e.g., release-preflight.sh) include explicit validation.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Consistency Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The PR demonstrates strong consistency in several areas:
- VERSION constant consistently replaces all package.json imports (complete migration)
- DECISION comment style normalized from `DECISION (DD1)` / `DECISION (DD2)` to plain `DECISION:` throughout
- Thinking block lifecycle (`thinking_start`/`thinking_delta`/`thinking_stop`) follows the same start/delta/stop pattern as text and tool_call blocks in the IR
- Result type usage is maintained in all new code (url-probe, proxy changes)
- Error handling in bootstrap uses AutobeatError consistently (proxy failure error upgraded from plain Error)
- The `closeActiveThinkingBlock` method mirrors the structure of `closeActiveTextBlock` and `closeActiveToolCall` exactly

The blocking items are about internal consistency between check/set actions in the same handler and the registration pattern deviation in bootstrap. None are functional issues.
