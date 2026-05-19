# Consistency Review Report

**Branch**: feat-interactive-orchestrator-mode -> main
**Date**: 2026-05-06

## Issues in Your Changes (BLOCKING)

### HIGH

**cleanup() called with orchestration ID instead of task-scoped ID** - `src/cli/commands/orchestrate.ts:819`
**Confidence**: 90%
- Problem: `adapter.cleanup(orchestration.id)` passes an orchestration ID to a method documented as `cleanup(taskId: string)`. The `AgentAdapter.cleanup()` interface (`src/core/agents.ts:314`) expects a task ID and its JSDoc says "@param taskId - The task whose resources should be cleaned up". For the Gemini adapter, this method constructs a file path using `${taskId}.md` to delete the system prompt temp file. Since `spawnInteractive` calls `resolveSpawnConfig` without a `taskId`, the temp file is created with a random UUID fragment (line 238 of `base-agent-adapter.ts`), which will never match `orchestration.id`. The cleanup becomes a silent no-op, leaking the temp file on disk.
- Fix: Pass the orchestration ID as the `taskId` parameter in `resolveSpawnConfig` so the temp file is named with the orchestration ID, matching the cleanup call:
  ```typescript
  // In handleOrchestrateInteractive, pass orchestration.id to spawnInteractive
  // so it flows through resolveSpawnConfig as taskId for consistent naming.
  // OR: Track the generated safeId and pass it to cleanup.
  ```
  The simplest fix is to include `orchestratorId` in `resolveSpawnConfig` as the fallback for `taskId` when `taskId` is undefined, so the file naming is deterministic and cleanup works.

### MEDIUM

**Missing CHECK constraint on orchestrations.mode column** - `src/implementations/database.ts:994`
**Confidence**: 85%
- Problem: Migration v25 adds `mode TEXT DEFAULT NULL` without a CHECK constraint. The codebase consistently uses CHECK constraints for enum-like columns as defense-in-depth: `status` columns in tasks (v3), schedules (v4), loops (v10/v11/v22), orchestrations (v14), pipelines (v24), and `eval_type`/`judge_agent` in loops (v22). The `OrchestratorMode` type restricts to `'standard' | 'interactive'` in TypeScript, but the DB column accepts any string. This deviates from the established pattern of matching domain constraints in the schema.
- Fix: Add a CHECK constraint to the ALTER TABLE:
  ```sql
  ALTER TABLE orchestrations ADD COLUMN mode TEXT DEFAULT NULL
    CHECK(mode IS NULL OR mode IN ('standard', 'interactive'));
  ```

**Removed DECISION comment without replacement** - `src/cli/commands/orchestrate.ts:835`
**Confidence**: 82%
- Problem: The diff shows removal of a DECISION comment that documented why `validatePath` is called without `mustExist` in `handleOrchestrateInit`. The comment read: "DECISION: validatePath without mustExist -- workingDirectory is only embedded in the printed usage snippet, not created on disk. Scaffold files go to ~/.autobeat/. Requiring existence would reject valid future directories with no security benefit." The codebase uses DECISION comments as documentation of non-obvious design choices (per CLAUDE.md's feedback_design_decision_jsdoc.md). This removal loses the reasoning behind the design choice.
- Fix: Restore the DECISION comment above the `if (parsed.workingDirectory)` block in `handleOrchestrateInit`.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**handleOrchestrateInteractive lacks top-level try/catch unlike handleOrchestrateForeground** - `src/cli/commands/orchestrate.ts:684`
**Confidence**: 82%
- Problem: `handleOrchestrateForeground` (lines 464-547) wraps its entire body in a `try/catch` that calls `container.dispose()` and `process.exit(1)` on any unexpected error. `handleOrchestrateInteractive` (lines 684-823) does not have this outer try/catch. If any of the awaited operations throw unexpectedly (e.g., `container.get()` throwing instead of returning err, or a DB corruption), the function will leak the container and the child process. This is an inconsistency in error handling patterns between two parallel handler functions.
- Fix: Wrap `handleOrchestrateInteractive` body in a try/catch with cleanup, matching the foreground handler's pattern.

**Direct container.get() calls bypass service abstraction** - `src/cli/commands/orchestrate.ts:731-733`
**Confidence**: 80%
- Problem: `handleOrchestrateInteractive` directly calls `container.get('eventBus')` and `container.get('orchestrationRepository')` to get services for DB updates and event emission. Meanwhile, the `orchestrationService` (already obtained via `withServices`) has methods for these operations. The foreground handler (`handleOrchestrateForeground`) uses `service.cancelOrchestration()` through the service layer. The interactive handler bypasses the service layer for status updates and event emission, creating an inconsistent access pattern. For example, the status update to FAILED/COMPLETED/CANCELLED is done directly on the repo instead of through the service.
- Fix: Add a method to `OrchestrationService` (e.g., `completeInteractiveOrchestration(id, status)`) that handles the DB update + event emission, and call it from the CLI handler instead of reaching into the container directly.

## Pre-existing Issues (Not Blocking)

_(none)_

## Suggestions (Lower Confidence)

- **ScaffoldResult optional fields widen existing contract** - `src/core/orchestrator-scaffold.ts:38-39` (Confidence: 70%) -- `exitConditionScript` and `suggestedExitCondition` changed from required to optional. Existing callers (like `mcp-adapter.ts:3398`) now need null-coalescing (`?? ''`). An alternative design would be a discriminated union (`StandardScaffoldResult | InteractiveScaffoldResult`) to make the type system enforce which fields are available, matching how the CLI uses `OrchestrateCreateParsed | OrchestrateInteractiveParsed`.

- **SIGINT handler restoration casts to NodeJS.SignalsListener** - `src/cli/commands/orchestrate.ts:780` (Confidence: 65%) -- `process.listeners('SIGINT')` returns `Function[]`, and the cast to `NodeJS.SignalsListener` is safe in practice but skips type checking. The existing foreground handler uses a named handler with `process.removeListener` for SIGINT, which is a cleaner pattern.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Consistency Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The interactive orchestrator mode is well-structured and generally follows existing patterns. The main consistency gaps are: (1) the `cleanup()` semantic mismatch where an orchestration ID is passed to a method expecting a task ID, (2) a missing CHECK constraint that breaks the defense-in-depth pattern used by all other enum columns, (3) a removed DECISION comment, and (4) the interactive handler bypasses the service layer for DB updates and event emission unlike parallel handlers. The test coverage is thorough (814 lines) and follows existing test patterns well.
