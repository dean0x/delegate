# Code Review Summary

**Branch**: feature/agent-config-passthrough -> main
**Date**: 2026-04-03_0151

## Merge Recommendation: CHANGES_REQUESTED

This PR implements per-task model override passthrough across the entire stack with strong architectural consistency and comprehensive test coverage. However, **multiple reviewers identified a critical regression**: the `model` field is stripped on database persistence for loops, schedules, and orchestrations via Zod boundary schemas that lack the `model` field definition. Additionally, the orchestration `model` field has no database migration and repository support. These gaps silently break the core feature being added. The PR also has duplicate test blocks, performance issues with repeated config file reads, and consistency gaps in JSON Schema validation constraints.

---

## Issue Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW | Total |
|----------|----------|------|--------|-----|-------|
| Blocking | 1 | 7 | 4 | 0 | 12 |
| Should Fix | 0 | 0 | 4 | 0 | 4 |
| Pre-existing | 0 | 0 | 2 | 2 | 4 |

---

## Blocking Issues (Must Fix Before Merge)

### CRITICAL (1)

**Model field stripped on loop/schedule persistence roundtrip — Zod schemas missing model definition**
- **Locations**: `src/implementations/loop-repository.ts:87-99`, `src/implementations/schedule-repository.ts:78-89,102-112,118-135`
- **Confidence**: 95%
- **Problem**: The `TaskRequestSchema`, `PipelineStepsSchema`, and `LoopConfigSchema` Zod objects in loop and schedule repositories do not include a `model` field. Zod's default `.parse()` strips unknown keys. When a loop or schedule with a model override is saved, the JSON is correctly persisted. However, when read back via `rowToLoop()` or `rowToSchedule()`, the `TaskRequestSchema.parse()` strips the `model` field from the taskTemplate, causing:
  - Loop model overrides are lost after server restart or recovery
  - Scheduled task model overrides are lost after persistence roundtrip
  - Scheduled pipeline step model overrides are lost
  - Scheduled loop model overrides are lost
- **Impact**: Any `model` override specified via MCP or CLI for loops, scheduled tasks, scheduled pipelines, or scheduled loops will silently revert to the agent's default model after the first DB roundtrip (recovery, restart, or status query). This defeats the purpose of per-task model passthrough for all persistent constructs.
- **Fix**: Add `model: z.string().optional()` to all four Zod schemas:
  ```typescript
  // loop-repository.ts TaskRequestSchema (~line 98)
  agent: z.enum(AGENT_PROVIDERS_TUPLE).optional(),
  model: z.string().optional(),

  // schedule-repository.ts TaskRequestSchema (~line 89)
  agent: z.enum(AGENT_PROVIDERS_TUPLE).optional(),
  model: z.string().optional(),

  // schedule-repository.ts PipelineStepsSchema (~line 108)
  agent: z.enum(AGENT_PROVIDERS_TUPLE).optional(),
  model: z.string().optional(),

  // schedule-repository.ts LoopConfigSchema (~line 134)
  agent: z.enum(AGENT_PROVIDERS_TUPLE).optional(),
  model: z.string().optional(),
  ```

---

### HIGH (7)

**Orchestration `model` field not persisted to database — missing migration, schema, and repository support**
- **Locations**: `src/implementations/orchestration-repository.ts:25-58,279-294`, `src/core/domain.ts:706`, `src/implementations/database.ts:3108-3129`
- **Confidence**: 95% (5 reviewers flagged this identically)
- **Problem**: The `Orchestration` domain type includes `readonly model?: string` and `createOrchestration()` sets `model: request.model`. However:
  1. No database migration v17 adds a `model` column to the `orchestrations` table (migration v16 only touches tasks)
  2. `OrchestrationRepository` does not include `model` in `toRow()`, `rowToOrchestration()`, `OrchestrationRowSchema`, `OrchestrationRow`, or SQL statements
  3. The field is silently dropped on persist and always `undefined` on read-back
- **Impact**: After creating an orchestration with a model override, `beat orchestrate status <id>` and `OrchestratorStatus` MCP response will show `model: undefined`. The model does propagate to the loop's taskTemplate, but the orchestration record itself loses the information. This is inconsistent with how `agent` is handled (which has full DB support).
- **Fix**: Add migration v17:
  ```typescript
  {
    version: 17,
    description: 'Add model column to orchestrations for per-orchestration model override',
    up: (db) => {
      db.exec('ALTER TABLE orchestrations ADD COLUMN model TEXT');
    },
  }
  ```
  Update `SQLiteOrchestrationRepository`:
  - Add `model: z.string().nullable()` to `OrchestrationRowSchema`
  - Add `readonly model: string | null` to `OrchestrationRow`
  - Add `model: orchestration.model ?? null` to `toRow()`
  - Add `model: data.model ?? undefined` to `rowToOrchestration()`
  - Add `model` to INSERT and UPDATE SQL statements

**Repeated `loadAgentConfig()` calls during spawn — config file read 3 times per spawn**
- **Locations**: `src/implementations/base-agent-adapter.ts:76,101,116` (5 reviewers flagged this)
- **Confidence**: 85%
- **Problem**: A single `spawn()` call invokes `loadAgentConfig()` three times:
  1. In `resolveAuth()` (line 76)
  2. In `resolveBaseUrl()` (line 101)
  3. In `resolveModel()` (line 116)
  Each call does a synchronous `readFileSync` + `JSON.parse`. Under concurrent task spawning, this triples the config file I/O per spawn.
- **Fix**: Load the config once at the top of `spawn()` and pass it down:
  ```typescript
  const agentConfig = loadAgentConfig(this.provider);
  const authResult = this.resolveAuth(agentConfig);
  const baseUrlEnv = this.resolveBaseUrl(agentConfig);
  const resolvedModel = this.resolveModel(model, agentConfig);
  ```

**ConfigureAgent `set` action — linear save-then-check pattern creates implicit partial-write state**
- **Location**: `src/adapters/mcp-adapter.ts:2983-3065`
- **Confidence**: 82%
- **Problem**: The `set` action saves `apiKey`, `baseUrl`, and `model` sequentially with early-return on failure. If `apiKey` saves but `baseUrl` fails, the method returns an error while `apiKey` has already been persisted to disk. The caller sees `isError: true` and may assume nothing changed, but one field was written.
- **Fix**: Either batch all writes atomically or include the list of already-saved fields in the error response:
  ```typescript
  // Option A: Batch write
  const fieldsToSave: Array<{ key: 'apiKey'|'baseUrl'|'model'; value: string }> = [];
  if (apiKey) fieldsToSave.push({ key: 'apiKey', value: apiKey });
  if (baseUrl !== undefined) fieldsToSave.push({ key: 'baseUrl', value: baseUrl });
  if (model !== undefined) fieldsToSave.push({ key: 'model', value: model });
  // Save all at once via a single config write...

  // Option B: Include partial state in error
  // On failure: { success: false, error: ..., savedFields: [...] }
  ```

**JSON Schema `model` field validation inconsistent across MCP tools**
- **Locations**: `src/adapters/mcp-adapter.ts` (ScheduleTask line ~756, CreatePipeline lines ~888,912, SchedulePipeline lines ~954,1011, CreateLoop line ~1105, ScheduleLoop line ~1257, CreateOrchestrator line ~1300, ConfigureAgent line ~1408)
- **Confidence**: 92%
- **Problem**: `DelegateTask.model` (line 596) has `minLength: 1, maxLength: 200` constraints. Most other tools' JSON Schema `model` fields lack these constraints, creating inconsistency between the JSON Schema declaration and the Zod schemas which all enforce `.min(1).max(200)`. MCP clients rely on JSON Schema for validation and documentation, so the inconsistency may cause clients to send values that pass client-side validation but are rejected by Zod with unclear errors.
- **Fix**: Add `minLength: 1, maxLength: 200` to all `model` JSON Schema field definitions to match Zod schemas and DelegateTask pattern.

**Missing baseUrl validation in CLI path**
- **Location**: `src/cli/commands/agents.ts:106`
- **Confidence**: 85%
- **Problem**: The CLI `beat agents config set <agent> baseUrl <value>` accepts any string without URL validation. The MCP path correctly validates with `z.string().url()`, but the CLI path skips validation. A malformed or malicious URL (e.g., `file:///etc/passwd`) would be stored in config and later injected as an environment variable for spawned agent processes.
- **Fix**: Add URL validation in the CLI path before calling `saveAgentConfig`:
  ```typescript
  if (key === 'baseUrl') {
    try {
      new URL(value);
    } catch {
      ui.error(`Invalid URL for baseUrl: "${value}". Must be a valid URL (e.g. https://proxy.example.com/v1)`);
      process.exit(1);
    }
  }
  ```

**`Record<string, unknown>` used for MCP response payloads — weakens type safety**
- **Locations**: `src/adapters/mcp-adapter.ts:2961,3049`
- **Confidence**: 82%
- **Problem**: `checkPayload` and `responsePayload` variables are typed as `Record<string, unknown>`, losing compile-time guarantees about response shape. A typo in a property name (e.g., `warnning` instead of `warning`) would not be caught by the type system.
- **Fix**: Define inline interface types for response shapes:
  ```typescript
  interface CheckResponse {
    success: boolean;
    ready?: boolean;
    method?: string;
    hint?: string;
    storedKey?: string;
    baseUrl?: string;
    model?: string;
    warning?: string;
  }
  const checkPayload: CheckResponse = { ... };
  ```

**Orchestration `model` field not tested for persistence — test only checks event, not DB roundtrip**
- **Location**: `tests/unit/services/orchestration-manager.test.ts` (and testing report)
- **Confidence**: 95%
- **Problem**: The test at line 154 ("should pass model to loop creation when model is specified") verifies the LoopCreated event carries the model but does not verify the orchestration itself round-trips `model` through the repository. This means the persistence gap went undetected.
- **Fix**: Add a repository-level round-trip test verifying that after creating an orchestration with a model, reading it back returns the same model.

---

### MEDIUM (4)

**Duplicated test blocks in mcp-adapter.test.ts**
- **Location**: `tests/unit/adapters/mcp-adapter.test.ts`
- **Confidence**: 95%
- **Problem**: The `describe('ConfigureAgent - Claude baseUrl warning via callTool()')` block appears to be duplicated 4 times in the test file, causing test execution overhead and confusing test output.
- **Fix**: Remove the 3 duplicate describe blocks, keeping only one instance.

**Duplicated `AGENT_BASE_URL_ENV` constant definition**
- **Location**: `src/core/agents.ts`
- **Confidence**: 65%
- **Problem**: The diff shows the `AGENT_BASE_URL_ENV` constant block appearing twice. If literally duplicated in the source file, the second definition would shadow the first.
- **Fix**: Verify the source file has only one definition and remove any duplicate.

**`handleConfigureAgent` method approaching cognitive complexity threshold**
- **Location**: `src/adapters/mcp-adapter.ts:2932-3086`
- **Confidence**: 85%
- **Problem**: The method is now 154 lines with 3 switch branches, each containing nested conditionals for error handling and Claude-specific warning logic. The `set` case has 5 levels of nesting. The method is approaching complexity limits for a single handler.
- **Fix**: Extract the `set` case into `handleConfigureAgentSet()` and the `check` case into `handleConfigureAgentCheck()` as separate private methods.

**Duplicated Claude baseUrl warning logic across 3 locations**
- **Locations**: `src/adapters/mcp-adapter.ts:2960-2971,3035-3047,260-264`
- **Confidence**: 88%
- **Problem**: The Claude-specific warning (`"Warning: Claude requires an API key when using a custom baseUrl..."`) is copy-pasted identically in three separate places: the `check` action, the `set` action, and the `ListAgents` tool handler. If the warning text or condition needs to change, all three must be updated in sync.
- **Fix**: Extract to a shared helper:
  ```typescript
  function getClaudeBaseUrlWarning(
    provider: AgentProvider,
    baseUrl: string | undefined,
    apiKey: string | undefined,
  ): string | undefined {
    if (provider === 'claude' && baseUrl && !apiKey) {
      return 'Warning: Claude requires an API key when using a custom baseUrl. The base URL will be ignored with login-based auth.';
    }
    return undefined;
  }
  ```

---

## Should-Fix Issues (Same File)

### MEDIUM (4)

**No tests for `model` passthrough in TaskManager.retry() and TaskManager.resume()**
- **Locations**: `src/services/task-manager.ts:5977,6083`
- **Confidence**: 82%
- **Problem**: The production code threads `model` through retry and resume, but no tests verify the model field survives these operations.
- **Fix**: Add tests in `task-manager.test.ts` for retry and resume with model preservation.

**No tests for schedule/pipeline/loop `model` field threading through ScheduleHandler**
- **Location**: `src/services/handlers/schedule-handler.ts:4424`
- **Confidence**: 80%
- **Problem**: The `handlePipelineTrigger` and `createScheduledLoop` methods thread `model`, but the service-layer threading of `model` from schedule -> triggered task has no dedicated test assertions.
- **Fix**: Add targeted tests verifying scheduled task trigger, pipeline trigger, and scheduled loop creation all thread model correctly.

**`resolveModel()` and `resolveBaseUrl()` each call `loadAgentConfig()` independently**
- **Location**: `src/implementations/base-agent-adapter.ts:96-118`
- **Confidence**: 80%
- **Problem**: Violates DRY principle and makes config resolution harder to reason about.
- **Fix**: Load config once in `spawn()` and pass to each resolution method (as noted in CRITICAL issue above).

**`mcp-adapter.ts` continues to grow — now 3086 lines with `model` touching 15+ locations**
- **Location**: `src/adapters/mcp-adapter.ts`
- **Confidence**: 80%
- **Problem**: File mixes schema definitions, tool registration, and handler logic, making it harder to navigate.
- **Fix**: Consider extracting Zod schemas and tool listing definitions into separate files (e.g., `mcp-schemas.ts`, `mcp-tool-definitions.ts`). Not urgent, but track as tech debt.

---

## Pre-existing Issues (Not Blocking)

### MEDIUM (2)

**`ProcessSpawnerAdapter` compatibility layer has no retirement path**
- **Location**: `src/implementations/process-spawner-adapter.ts:8`
- **Confidence**: 82%
- **Problem**: The adapter's own documentation states "This adapter will be removed once all tests migrate to mock AgentAdapters." The PR extends the adapter's lifetime by adding `model` parameter passthrough rather than migrating tests off it.
- **Impact**: Tests relying on `MockProcessSpawner` never exercise the model resolution chain (per-task > agent-config > CLI default).

**`saveAgentConfig` loads config twice when called in sequence**
- **Location**: `src/core/configuration.ts`
- **Confidence**: 70%
- **Problem**: When the `set` action calls `saveAgentConfig` 3 times in sequence (apiKey, baseUrl, model), the file is read 3 times and written 3 times. Functionally correct but wasteful.

### LOW (2)

**`ProcessSpawner` interface duplicates `AgentAdapter.spawn` signature**
- **Location**: `src/core/interfaces.ts:58-64`
- **Confidence**: 80%
- **Problem**: Two interfaces with identical `spawn()` signatures for the same purpose is a design smell.

**Loop `model` not persisted directly in loop table — stored inside taskTemplate JSON**
- **Location**: `src/implementations/loop-repository.ts`
- **Confidence**: 70%
- **Problem**: Inconsistent with how `model` is handled for tasks (dedicated column). Cannot be queried or indexed at DB level.

---

## Action Plan

**Before merge, all blocking issues must be resolved:**

1. **Add `model` field to 4 Zod schemas** (loop-repository, schedule-repository × 3) to fix silent data loss on persistence roundtrip
2. **Create migration v17** and update `OrchestrationRepository` to persist orchestration `model` field
3. **Consolidate `loadAgentConfig()` calls in `BaseAgentAdapter.spawn()`** to load once and pass through
4. **Fix ConfigureAgent `set` action** to batch writes atomically or include partial-write state in error
5. **Add `minLength` and `maxLength` to all JSON Schema `model` fields** to match Zod schemas
6. **Add URL validation in CLI baseUrl setter**
7. **Replace `Record<string, unknown>` with typed interfaces** for MCP response payloads
8. **Remove duplicate test blocks** from mcp-adapter.test.ts and verify no other duplicates
9. **Extract Claude baseUrl warning to shared helper** to prevent duplication

**After merge (should-fix):**
- Add tests for TaskManager retry/resume with model preservation
- Add tests for ScheduleHandler model threading
- Extract MCP schemas and tool definitions to separate files (tech debt)
- Migrate tests off ProcessSpawnerAdapter (tech debt)

---

## Summary

The PR demonstrates strong architectural consistency in threading the `model` field through all layers (MCP, domain, database, adapters, CLI). However, the feature has critical gaps:

1. **Zod boundary schemas strip `model` on DB roundtrip** for loops and schedules (CRITICAL)
2. **Orchestration model field has no DB support** (HIGH)
3. **Performance regression: 3x config file reads per spawn** (HIGH)
4. **Multiple consistency and validation gaps** across JSON Schema definitions and CLI paths (HIGH × 4)

These issues must be fixed before merge to ensure the per-task model passthrough feature works end-to-end without silent data loss.
