# Consistency Review Report

**Branch**: feature/agent-config-passthrough -> main
**Date**: 2026-04-03

## Issues in Your Changes (BLOCKING)

### HIGH

**Orchestration `model` field not persisted to database** - `src/implementations/orchestration-repository.ts:25-58`, `src/implementations/database.ts:720-742`
**Confidence**: 95%
- Problem: The `Orchestration` domain type now includes `readonly model?: string` (added in `src/core/domain.ts:708`), and `createOrchestration()` sets `model: request.model`. The MCP adapter reads `orchestration.model` (line 2824) and the CLI outputs it (orchestrate.ts line 1488). However:
  1. **No database migration** adds a `model` column to the `orchestrations` table. Migration v16 only adds `model` to `tasks`. The `orchestrations` table (migration v14) has no `model` column.
  2. **OrchestrationRepository** (`orchestration-repository.ts`) does not include `model` in its `toRow()` method (lines 279-294), its `rowToOrchestration()` method (lines 297-314), its `OrchestrationRowSchema` (lines 25-39), its `OrchestrationRow` interface (lines 45-59), or its prepared SQL statements (lines 78-103).
  3. This means `model` is silently lost on persistence. After restart, `orchestration.model` will always be `undefined` even if the user set one.
  4. This is inconsistent with how `agent` was handled: `agent` has a column in the `orchestrations` table (migration v14), is in `OrchestrationRowSchema`, `OrchestrationRow`, `toRow()`, and `rowToOrchestration()`.
- Fix: Add a new migration (v17) to `ALTER TABLE orchestrations ADD COLUMN model TEXT`. Update `orchestration-repository.ts`:
  - Add `model: z.string().nullable()` to `OrchestrationRowSchema`
  - Add `readonly model: string | null` to `OrchestrationRow`
  - Add `model: orchestration.model ?? null` to `toRow()`
  - Add `model: data.model ?? undefined` to `rowToOrchestration()`
  - Add `model` to the INSERT and UPDATE SQL statements

**JSON Schema `model` field validation inconsistent across MCP tools** - `src/adapters/mcp-adapter.ts` (multiple locations)
**Confidence**: 92%
- Problem: The `DelegateTask` tool's `model` field (line 596-601) has `minLength: 1, maxLength: 200` constraints matching the Zod schema (`z.string().min(1).max(200)`). However, most other tools' JSON Schema `model` fields lack these constraints:
  - `ScheduleTask` (line 756-759): missing `minLength` and `maxLength`
  - `CreatePipeline` step-level `model` (line 888-891): missing both
  - `CreatePipeline` top-level `model` (line 912-915): missing both
  - `SchedulePipeline` step-level `model` (line 954-957): missing both
  - `SchedulePipeline` top-level `model` (line 1011-1014): missing both
  - `CreateLoop` `model` (line 1105-1108): missing both
  - `ScheduleLoop` `model` (line 1257): missing both (inline object)
  - `CreateOrchestrator` `model` (line 1300-1303): missing both
  - `ConfigureAgent` `model` (line 1408-1411): missing both
  - The Zod schemas used for validation _do_ include `.min(1).max(200)`, so this is a documentation/contract inconsistency rather than a runtime bug. MCP clients (e.g., Claude) rely on JSON Schema to understand field constraints. The inconsistency may cause clients to send invalid values that are then rejected by Zod validation with unclear errors.
- Fix: Add `minLength: 1, maxLength: 200` to all `model` JSON Schema field definitions to match the Zod validation and the `DelegateTask` pattern.

### MEDIUM

**Duplicate test blocks appended to mcp-adapter.test.ts** - `tests/unit/adapters/mcp-adapter.test.ts`
**Confidence**: 95%
- Problem: The `describe('ConfigureAgent - Claude baseUrl warning via callTool()')` block with its full set of sub-tests (set action, check action, ListAgents warning) appears to be duplicated 4 times in the test file. The diff shows the same block appended repeatedly. This will cause test execution overhead and confusing test output (same test name appearing multiple times).
- Fix: Remove the 3 duplicate `describe('ConfigureAgent - Claude baseUrl warning via callTool()')` blocks, keeping only one instance.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`createLoop` cleanup removes explicit `undefined` assignments while `createOrchestration` does the same inconsistently** - `src/core/domain.ts`
**Confidence**: 82%
- Problem: The diff removes explicit `undefined` fields from `createLoop()` (e.g., `bestScore: undefined`, `bestIterationId: undefined`, `gitBaseBranch: undefined`, `completedAt: undefined`) and from `createOrchestration()` (e.g., `loopId: undefined`, `completedAt: undefined`). While TypeScript and `Object.freeze` handle this correctly (optional fields default to `undefined` when omitted), this cleanup was applied inconsistently in the same PR as a feature change. The `createTask()` factory (line 165) still has `dependencyState: 'none'` which is explicit for a similar reason. This is a style consistency concern within the PR itself -- the cleanup is fine but should be noted as an intentional choice.
- Fix: No action required if intentional. If unintentional, restore the explicit `undefined` assignments for clarity or apply the same cleanup to all domain factory functions in a separate commit.

## Pre-existing Issues (Not Blocking)

_No critical pre-existing issues found in reviewed files._

## Suggestions (Lower Confidence)

- **Loop `model` not persisted directly in loop table** - `src/implementations/loop-repository.ts` (Confidence: 70%) -- The `model` field on loops is stored inside the `taskTemplate` JSON blob (via `task_template TEXT` column). While this works (the loop repository serializes/deserializes `taskTemplate` as JSON), it is inconsistent with how `model` is handled for tasks (dedicated column) and orchestrations (should have dedicated column per the blocking issue above). This is the existing pattern for loops/schedules (they store `taskTemplate` as JSON), so it is not a bug, but it does mean `model` cannot be queried or indexed at the database level for loops/schedules.

- **`AGENT_BASE_URL_ENV` definition appears duplicated in diff** - `src/core/agents.ts` (Confidence: 65%) -- The diff shows the `AGENT_BASE_URL_ENV` constant block appearing twice. This may be a diff rendering artifact (context from different hunks), but if it is actually duplicated in the source file, the second definition would silently shadow the first. Verify the source file has only one definition.

- **`resolveBaseUrl` in `ClaudeAdapter` checks `process.env.ANTHROPIC_BASE_URL` directly** - `src/implementations/claude-adapter.ts:2400` (Confidence: 65%) -- The override uses the literal string `ANTHROPIC_BASE_URL` instead of referencing `AGENT_BASE_URL_ENV[this.provider]`. While the `provider` is always `'claude'` for `ClaudeAdapter`, using the constant would be more consistent with the single-source-of-truth pattern established by `AGENT_BASE_URL_ENV`.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | - | 2 | 1 | - |
| Should Fix | - | - | 1 | - |
| Pre-existing | - | - | - | - |

**Consistency Score**: 6/10
**Recommendation**: CHANGES_REQUESTED

The `model` field is threaded through domain types, MCP adapter, CLI, task repository, and all agent adapters with good consistency. However, the orchestration repository is completely missing `model` persistence (no migration, no row schema, no SQL), creating a silent data loss path. The JSON Schema validation constraints are inconsistently applied across MCP tools. The test file has significant duplication (4x repeated describe block). These issues should be addressed before merge.
