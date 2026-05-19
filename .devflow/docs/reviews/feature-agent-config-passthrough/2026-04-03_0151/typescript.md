# TypeScript Review Report

**Branch**: feature/agent-config-passthrough -> main
**Date**: 2026-04-03

## Issues in Your Changes (BLOCKING)

### CRITICAL

**Orchestration `model` field not persisted to database** - `src/implementations/orchestration-repository.ts`
**Confidence**: 95%
- Problem: The `Orchestration` interface (`src/core/domain.ts:706`) now includes `model?: string`, and `createOrchestration()` sets `model: request.model`. However, the `orchestrations` table has no `model` column (no migration was added in v16), and `SQLiteOrchestrationRepository` does not include `model` in `toRow()`, `rowToOrchestration()`, `OrchestrationRowSchema`, `OrchestrationRow`, or any SQL statement. The field is silently dropped on persist and always `undefined` on read-back.
- Impact: After creating an orchestration with a model override, querying it via `OrchestratorStatus` (MCP) or `beat orchestrate status` (CLI) will show `model: undefined`. The conditional spread `...(orchestration.model && { model: orchestration.model })` at `src/adapters/mcp-adapter.ts` and `src/cli/commands/orchestrate.ts` will never emit the field for rehydrated orchestrations. While the model does propagate to the loop's `taskTemplate` (which is JSON-serialized and survives persist), the orchestration record itself loses the information.
- Fix: Add migration v17 to `src/implementations/database.ts`:
  ```typescript
  {
    version: 17,
    description: 'Add model column to orchestrations for per-orchestration model override',
    up: (db) => {
      db.exec('ALTER TABLE orchestrations ADD COLUMN model TEXT');
    },
  },
  ```
  Then update `SQLiteOrchestrationRepository`:
  - Add `model: z.string().nullable()` to `OrchestrationRowSchema`
  - Add `readonly model: string | null` to `OrchestrationRow`
  - Add `model: orchestration.model ?? null` to `toRow()`
  - Add `model: data.model ?? undefined` to `rowToOrchestration()`
  - Add `model` to `saveStmt` INSERT and `updateStmt` UPDATE SQL

### HIGH

**`Record<string, unknown>` used for MCP response payloads -- weakens type safety** - `src/adapters/mcp-adapter.ts:2961,3049`
**Confidence**: 82%
- Problem: The `checkPayload` and `responsePayload` variables for the `ConfigureAgent` handler are typed as `Record<string, unknown>`, losing all compile-time guarantees about the shape of the response. A typo in a property name (e.g., `warnning` instead of `warning`) would not be caught by the type system.
- Impact: Reduces type safety in new code added in this PR. The rest of the codebase avoids `Record<string, unknown>` for structured responses.
- Fix: Define inline interface types for the response shapes:
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

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`resolveModel()` and `resolveBaseUrl()` each call `loadAgentConfig()` independently** - `src/implementations/base-agent-adapter.ts:96-118`
**Confidence**: 80%
- Problem: In a single `spawn()` call, `resolveAuth()` calls `loadAgentConfig()`, then `resolveModel()` calls it again, then `resolveBaseUrl()` calls it a third time. Each call reads and parses the config file from disk.
- Impact: Three file reads per spawn instead of one. While not a hot-path performance issue (spawn is already expensive), it violates the DRY principle and makes the config resolution harder to reason about.
- Fix: Load the config once in `spawn()` and pass it to each resolution method, or cache it for the duration of the spawn call:
  ```typescript
  const agentConfig = loadAgentConfig(this.provider);
  const resolvedModel = this.resolveModel(model, agentConfig);
  const baseUrlEnv = this.resolveBaseUrl(agentConfig);
  // resolveAuth already has its own loadAgentConfig call -- refactor to accept it too
  ```

## Pre-existing Issues (Not Blocking)

_No pre-existing CRITICAL issues found in unchanged code._

## Suggestions (Lower Confidence)

- **Zod schema `baseUrl` validation could be tightened** - `src/adapters/mcp-adapter.ts` (Confidence: 70%) -- The `ConfigureAgentSchema` uses `z.string().url()` for `baseUrl`, which validates URL format. However, the MCP tool JSON Schema description at the tool registration site (`type: 'string'`) does not include a `format: 'uri'` constraint, creating a validation gap between the JSON Schema declaration and Zod runtime validation.

- **`loadAgentConfig()` called in `resolveAuth()` without caching** - `src/implementations/base-agent-adapter.ts:74` (Confidence: 65%) -- Pre-existing pattern but exacerbated by this PR adding two more `loadAgentConfig()` calls in the same spawn path.

- **Explicit `undefined` removal in `createLoop`/`createOrchestration` is inconsistent** - `src/core/domain.ts:655-662,746-756` (Confidence: 62%) -- The PR removes explicit `undefined` assignments (e.g., `bestScore: undefined`, `loopId: undefined`, `completedAt: undefined`) from `createLoop()` and `createOrchestration()`. While `Object.freeze` on an object literal without these keys produces the same runtime behavior (property access returns `undefined`), it changes the semantics for `Object.keys()` / `JSON.stringify()` / spread operations. If any downstream code checks `'loopId' in orchestration` or uses `Object.keys()`, this is a behavioral change.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 1 | 1 | - | - |
| Should Fix | - | - | 1 | - |
| Pre-existing | - | - | - | - |

**TypeScript Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The PR demonstrates strong TypeScript patterns overall: proper use of branded types, readonly interfaces, discriminated unions, Zod boundary validation, and no `any` types. The main blocking issue is the `model` field on the `Orchestration` type being added to the domain model and used throughout the MCP/CLI layers but never persisted to or read from the database, which will cause silent data loss. The `Record<string, unknown>` usage in the ConfigureAgent handler is a localized type safety regression. Test coverage for the new features is thorough, with dedicated test suites for baseUrl passthrough, model passthrough, and Claude baseUrl warning scenarios.
