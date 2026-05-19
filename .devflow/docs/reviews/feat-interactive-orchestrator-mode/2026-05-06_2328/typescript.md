# TypeScript Review Report

**Branch**: feat-interactive-orchestrator-mode -> main
**Date**: 2026-05-06

## Issues in Your Changes (BLOCKING)

### HIGH

**Unchecked `container.get` Results for `eventBus` and `orchestrationRepository`** - `src/cli/commands/orchestrate.ts:731-733`
**Confidence**: 95%
- Problem: Two `container.get` calls are made without checking `.ok` before use. The results (`eventBusResult`, `orchRepoResult`) are only conditionally accessed later with `if (orchRepoResult.ok)` / `if (eventBusResult.ok)`, which means failures are silently swallowed. If both fail, the orchestration finishes but neither emits events nor updates the DB status, leaving the DB row stuck at RUNNING forever. Other call sites in the same file (line 47, 477, 695) check `.ok` and exit on failure.
- Fix: Either (a) check both results immediately after `.get()` and fail with `process.exit(1)` like the `agentRegistryResult` pattern above (line 695-700), or (b) accept the best-effort approach but add a warning log when the result is not ok, similar to the PID update warning on line 760. Option (a) is preferred since a container that cannot resolve its core services is in a broken state:
```typescript
if (!eventBusResult.ok) {
  ui.error(`Failed to get event bus: ${eventBusResult.error.message}`);
  await container.dispose();
  process.exit(1);
}
if (!orchRepoResult.ok) {
  ui.error(`Failed to get orchestration repository: ${orchRepoResult.error.message}`);
  await container.dispose();
  process.exit(1);
}
```

### MEDIUM

**Migration v25: `mode` column lacks CHECK constraint** - `src/implementations/database.ts:994`
**Confidence**: 85%
- Problem: The project consistently uses CHECK constraints as defense-in-depth for enum-like columns (status columns in migrations v2, v3, v4, v10, v11, v14, v22, v24). Migration v25 adds `mode TEXT DEFAULT NULL` without `CHECK(mode IS NULL OR mode IN ('standard', 'interactive'))`. While the Zod schema in `orchestration-repository.ts:46` validates on read, the DB CHECK constraint prevents invalid data from being written by any code path (e.g., direct SQL, future migrations).
- Fix:
```sql
ALTER TABLE orchestrations ADD COLUMN mode TEXT DEFAULT NULL
  CHECK(mode IS NULL OR mode IN ('standard', 'interactive'));
```

**`createInteractiveOrchestration` skips state file cleanup on save failure** - `src/services/orchestration-manager.ts:376-382`
**Confidence**: 82%
- Problem: When `this.orchestrationRepo.save(orchestration)` fails, the method returns `err(saveResult.error)` but does not clean up the state file written at line 361 (`writeStateFile(stateFilePath, state)`). The standard `createOrchestration` method has an explicit `cleanupFiles()` helper for this path (line 157). The interactive variant omits it.
- Fix: Add state file cleanup in the save failure path:
```typescript
if (!saveResult.ok) {
  this.logger.error('Failed to save interactive orchestration', saveResult.error, {
    orchestratorId: orchestration.id,
  });
  // Best-effort cleanup of orphaned state file
  try { unlinkSync(stateFilePath); } catch { /* orphan files are harmless */ }
  return err(saveResult.error);
}
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`ScaffoldResult.exitConditionScript` and `suggestedExitCondition` made optional without downstream guards** - `src/core/orchestrator-scaffold.ts:38-39`
**Confidence**: 82%
- Problem: These fields were changed from required `string` to optional `string | undefined`. The existing consumer in `mcp-adapter.ts:3398` already has a `?? ''` guard (`scaffold.suggestedExitCondition ?? ''`), which is good. However, the standard template path in `orchestrate.ts:894` references `s.suggestedExitCondition` in a template literal without a guard: `` `--until "${s.suggestedExitCondition}"` ``. If `template` is undefined (the default), the code takes the else-branch at line 885, and `suggestedExitCondition` is defined in that path. The logic is safe at runtime because the branching guarantees it, but the types do not reflect this guarantee -- a caller using the `ScaffoldResult` type sees optional fields and may use them without guards.
- Fix: Consider using a discriminated union return type so TypeScript enforces the guarantee:
```typescript
type ScaffoldResult =
  | { template: 'interactive'; stateFilePath: string; suggestedCommand: string; instructions: ...; }
  | { template: 'standard'; stateFilePath: string; exitConditionScript: string; suggestedExitCondition: string; suggestedCommand: string; instructions: ...; };
```

## Pre-existing Issues (Not Blocking)

No critical pre-existing issues found in the reviewed files.

## Suggestions (Lower Confidence)

- **Duplicated input validation between `createOrchestration` and `createInteractiveOrchestration`** - `src/services/orchestration-manager.ts:333-352` (Confidence: 70%) -- The goal validation, working directory validation, and agent resolution are copy-pasted from `createOrchestration` (lines 74-95). Consider extracting a `validateCreateRequest` private method to avoid drift.

- **SIGINT handler restoration uses `as NodeJS.SignalsListener` cast** - `src/cli/commands/orchestrate.ts:780` (Confidence: 65%) -- `process.listeners('SIGINT')` returns `Function[]`, and the cast to `NodeJS.SignalsListener` is pragmatic but hides the actual type. A minor type-safety concern.

- **`parseOrchestrateInteractiveArgs` doesn't reject `--system-prompt` without a value when it's the last arg** - `src/cli/commands/orchestrate.ts:342` (Confidence: 60%) -- When `--system-prompt` is the last argument, `args[i + 1]` is `undefined`, and the error message fires correctly. This is handled, but the error message says "requires a prompt string" while the `--template` validator says "requires a value" -- minor inconsistency.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**TypeScript Score**: 7/10
**Recommendation**: CHANGES_REQUESTED
