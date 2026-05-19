# Architecture Review Report

**Branch**: feature/agent-config-passthrough -> main
**Date**: 2026-04-03

## Summary of Changes

This PR introduces per-task model override passthrough across the entire stack: domain types, MCP schemas, CLI flags, agent adapters, task repository persistence, database migration, schedule/pipeline/loop/orchestrator threading, and corresponding tests. It also removes the old `ProcessSpawner` implementation in favor of the `BaseAgentAdapter` hierarchy and adds `model` parameter to the `ProcessSpawner` interface and `ProcessSpawnerAdapter`.

## Issues in Your Changes (BLOCKING)

### HIGH

**`loadAgentConfig()` called inside hot path without caching** - `src/implementations/base-agent-adapter.ts:76,103,116`
**Confidence**: 85%
- Problem: `resolveAuth()`, `resolveBaseUrl()`, and `resolveModel()` each independently call `loadAgentConfig(this.provider)`, which reads and parses the config JSON file from disk synchronously. During a single `spawn()` invocation, this results in 3 separate disk reads and JSON parses of the same file for the same provider. While individually fast, this is architecturally wasteful and could compound under concurrent spawning (multiple workers starting simultaneously).
- Fix: Read the agent config once at the top of `spawn()` and pass it down, or cache it per-spawn call:

```typescript
// In spawn(), before resolveAuth:
const agentConfig = loadAgentConfig(this.provider);
const authResult = this.resolveAuth(agentConfig);
const baseUrlEnv = this.resolveBaseUrl(agentConfig);
const resolvedModel = this.resolveModel(model, agentConfig);
```

This follows the project's principle of "measure, benchmark, optimize" and eliminates 2 unnecessary disk I/O operations per spawn.

### MEDIUM

**`resolveModel()` static call in BaseAgentAdapter couples to file system** - `src/implementations/base-agent-adapter.ts:114-118`
**Confidence**: 82%
- Problem: `resolveModel()` directly calls `loadAgentConfig()` (a static/module-level function that reads from disk), making the base adapter dependent on file system state for model resolution. This violates DIP -- the adapter should receive its configuration through constructor injection rather than reaching out to the file system at runtime. The same pattern exists for `resolveAuth()` and `resolveBaseUrl()`, but those are pre-existing. The new `resolveModel()` extends rather than fixes the pattern.
- Fix: This is acceptable for now as it follows the existing pattern in `resolveAuth()` and `resolveBaseUrl()`. However, when refactoring, consider injecting `AgentConfig` via the constructor or a factory to make adapters fully testable without file system side effects.

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`ProcessSpawnerAdapter` compatibility layer has no retirement path** - `src/implementations/process-spawner-adapter.ts:8`
**Confidence**: 82%
- Problem: The file's own documentation states "This adapter will be removed once all tests migrate to mock AgentAdapters." The PR adds `model` parameter passthrough to this adapter, extending its lifetime rather than migrating tests off it. The adapter now has a 4-parameter spawn signature matching the full `AgentAdapter` interface, which means tests relying on it continue to bypass the `BaseAgentAdapter` template method entirely (auth resolution, env stripping, base URL injection, model resolution).
- Impact: The compatibility shim means tests using `MockProcessSpawner` never exercise the model resolution chain (per-task > agent-config > CLI default). Tests pass but don't validate the real production code path.

### LOW

**`ProcessSpawner` interface in `core/interfaces.ts` duplicates `AgentAdapter.spawn` signature** - `src/core/interfaces.ts:58-64`
**Confidence**: 80%
- Problem: The `ProcessSpawner` interface now has an identical `spawn()` signature to `AgentAdapter.spawn()` (both accept `prompt, workingDirectory, taskId?, model?`). Two interfaces with the same method signature for the same purpose is a design smell. The `ProcessSpawner` exists only for backward compatibility via `ProcessSpawnerAdapter`.
- Fix: Consider deprecating `ProcessSpawner` interface and migrating remaining tests to use mock `AgentAdapter` implementations directly.

## Suggestions (Lower Confidence)

- **Model validation could use a shared schema** - `src/adapters/mcp-adapter.ts` (Confidence: 70%) -- The model field validation `z.string().min(1).max(200)` is repeated across 10+ Zod schemas (DelegateTask, ScheduleTask, CreatePipeline steps, SchedulePipeline steps, CreateLoop, ScheduleLoop, CreateOrchestrator, ConfigureAgent). Extracting a shared `ModelSchema` constant would follow the single source of truth pattern and prevent drift if limits change.

- **`BaseAgentAdapter.resolveModel()` has no validation** - `src/implementations/base-agent-adapter.ts:114` (Confidence: 65%) -- The method accepts any string as a model name without validation. While MCP schemas validate at the boundary, CLI `--model` goes through minimal validation. The adapters could defensively validate model format to catch misuse early, though the CLI agents themselves will reject invalid model names.

- **Orchestration model passthrough uses conditional spread** - `src/services/orchestration-manager.ts:160` (Confidence: 62%) -- `...(orchestration.model !== undefined && { model: orchestration.model })` is used instead of simply passing `model: orchestration.model`. When `model` is `undefined`, both approaches produce the same result since `LoopCreateRequest.model` is already optional. The conditional spread adds complexity without benefit.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 1 | 1 |

**Architecture Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Rationale

The PR demonstrates strong architectural consistency:

1. **Clean layered passthrough**: The `model` field flows correctly through all layers (MCP schema -> domain types -> service layer -> adapters -> CLI args) without any layer skipping or shortcutting. Each layer handles the field at its appropriate abstraction level.

2. **Follows existing patterns**: The model override follows the same resolution chain pattern established for `agent` and `baseUrl` (per-task > config > default). The `buildArgs()` template method in each adapter correctly handles the optional model flag for Claude (`--model`), Codex (`--model`), and Gemini (`--model`).

3. **Database migration is correct**: Migration v16 adds the `model TEXT` column properly, TaskRowSchema and TaskRow interface are updated, and the repository save/update/map statements handle the field.

4. **Domain model integrity maintained**: `TaskRequest`, `Task`, `PipelineStepRequest`, `PipelineCreateRequest`, `ScheduleCreateRequest`, `LoopCreateRequest`, `OrchestratorCreateRequest`, `ScheduledPipelineCreateRequest` all correctly include the optional `model` field. Factory functions (`createTask`, `createLoop`, `createOrchestration`) preserve it.

5. **Immutability preserved**: All domain types maintain `readonly` fields. No mutations introduced.

6. **Test coverage**: New tests cover agent config model storage, adapter model arg passing, MCP tool model forwarding, task repository model persistence, and orchestration model threading.

The one blocking issue (repeated `loadAgentConfig` disk reads per spawn) is a performance optimization that should be addressed but is not architecturally dangerous. The condition for approval is addressing the HIGH-severity finding about consolidating the 3 disk reads per spawn into 1.
