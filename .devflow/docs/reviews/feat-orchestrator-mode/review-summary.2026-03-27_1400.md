# Code Review Summary

**Branch**: feat/orchestrator-mode -> main
**Date**: 2026-03-27
**PR**: #123
**Commits**: 12 (7bbc8e6..e5323b9)

---

## Merge Recommendation: CHANGES_REQUESTED

The orchestrator feature introduces a well-designed, well-tested system that follows the project's established architecture patterns closely. However, **three blocking issues must be fixed before merge:**

1. **CRITICAL**: Orchestrations in PLANNING status cannot be cancelled (DB status never updated)
2. **HIGH**: State file boundary validation is unsafe (type assertion instead of Zod schema)
3. **HIGH**: Test suite not integrated into CI (`test:orchestration` missing from `test:all`)

Additionally, **five MEDIUM-severity issues** should be addressed to ensure consistency, maintainability, and security hardening.

---

## Issue Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| **Blocking** | 1 | 2 | 5 | 0 |
| **Should Fix** | 0 | 0 | 4 | 0 |
| **Pre-existing** | 0 | 0 | 0 | 0 |
| **TOTAL** | **1** | **2** | **9** | **0** |

---

## Blocking Issues (MUST FIX)

### CRITICAL-1: Cancel does not update DB for PLANNING orchestrations
**File**: `src/services/orchestration-manager.ts:228-271`
**Confidence**: 95%
**Category**: Issues in Your Changes
**Flagged by**: TypeScript, Architecture, Consistency, Database, Regression, Security

**Problem**:
`cancelOrchestration()` allows cancelling orchestrations in `PLANNING` status (no `loopId` yet). When a PLANNING orchestration is cancelled, the method emits `OrchestrationCancelled` but **no event handler subscribes to that event**. The `OrchestrationHandler` only subscribes to `LoopCompleted` and `LoopCancelled`. Since there is no loop, the DB status is never updated from `PLANNING` to `CANCELLED`, leaving a ghost record that appears active forever.

**Impact**: Cancelled orchestrations in PLANNING state remain stuck in the database with `planning` status. `beat orchestrate list` shows them as active. API consumers believe they're cancelled but the database disagrees.

**Fix**:
Update DB directly in `cancelOrchestration()` when `loopId` is absent:

```typescript
// In OrchestrationManagerService.cancelOrchestration()
// After the loopService.cancelLoop() block:
if (!orchestration.loopId) {
  // No loop to cancel -- update DB directly
  const updated = updateOrchestration(orchestration, {
    status: OrchestratorStatus.CANCELLED,
    completedAt: Date.now(),
  });
  const updateResult = this.orchestrationRepo.update(updated);
  if (!updateResult.ok) {
    return err(updateResult.error);
  }
}
```

---

### HIGH-1: Unsafe type assertion on state file read
**File**: `src/core/orchestrator-state.ts:76-88`
**Confidence**: 88%
**Category**: Issues in Your Changes
**Flagged by**: Architecture, TypeScript, Security, Tests

**Problem**:
`readStateFile()` only checks `version === 1` then casts `parsed as OrchestratorStateFile`. No validation that required fields (`goal`, `status`, `plan`, `context`, `iterationCount`) exist or have correct types. The project convention (per CLAUDE.md) is "parse, don't validate" using Zod. A state file with `version: 1` but missing fields would pass validation and cause runtime errors downstream.

**Impact**: Corrupted state files or malicious inputs could cause crashes when CLI code accesses `state.plan[0]`, `state.status`, etc. Additionally, an attacker with filesystem write access could craft invalid state files.

**Fix**:
Add Zod schema validation:

```typescript
import { z } from 'zod';

const StateFileSchema = z.object({
  version: z.literal(1),
  goal: z.string(),
  status: z.enum(['planning', 'executing', 'validating', 'complete', 'failed']),
  plan: z.array(z.object({
    id: z.string(),
    description: z.string(),
    status: z.enum(['pending', 'in_progress', 'completed', 'failed']),
    taskId: z.string().optional(),
    dependsOn: z.array(z.string()).optional(),
    failureCount: z.number().optional(),
    lastError: z.string().optional(),
  })),
  context: z.record(z.unknown()),
  iterationCount: z.number(),
});

export function readStateFile(filePath: string): Result<OrchestratorStateFile> {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = StateFileSchema.parse(JSON.parse(raw));
    return ok(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(new Error(`Failed to read state file at ${filePath}: ${message}`));
  }
}
```

---

### HIGH-2: Orchestration tests not included in CI
**File**: `package.json:19,21`
**Confidence**: 95%
**Category**: Issues in Your Changes
**Flagged by**: Architecture, Consistency, Dependencies, Regression (all 5 reviewers flagged this)

**Problem**:
The new `test:orchestration` script was added but **not** included in the `test:all` chain. CI runs `test:all`, so the 70 new orchestration tests will never run automatically. This means regressions in orchestration code would go undetected.

**Impact**: All orchestration tests (domain, repository, handler, manager, CLI, integration) are bypassed in CI and during `npm run validate`.

**Fix**:
Add `npm run test:orchestration` to the `test:all` chain in `package.json`:

```json
"test:all": "npm run test:core && npm run test:handlers && npm run test:services && npm run test:repositories && npm run test:adapters && npm run test:implementations && npm run test:cli && npm run test:orchestration && npm run test:scheduling && npm run test:checkpoints && npm run test:error-scenarios && npm run test:integration"
```

---

## Should-Fix Issues (Recommended before merge)

### MEDIUM-1: Async/Sync convention violation in OrchestrationRepository
**File**: `src/core/interfaces.ts:700-701`
**Confidence**: 92%
**Category**: Issues in Your Changes
**Flagged by**: Consistency (HIGH) + Dependencies

**Problem**:
`OrchestrationRepository.save()` and `update()` return `Result<void>` (synchronous), while every other repository in the codebase (`TaskRepository`, `ScheduleRepository`, `LoopRepository`, etc.) returns `Promise<Result<void>>` (async). This breaks the established pattern and makes the interface fragile for future changes.

**Fix**:
Change to async to match all other repositories:

```typescript
save(orchestration: Orchestration): Promise<Result<void>>;
update(orchestration: Orchestration): Promise<Result<void>>;
```

The caller in `OrchestrationManagerService` already awaits these, so call sites are prepared.

---

### MEDIUM-2: MCP tool naming breaks established pattern
**File**: `src/adapters/mcp-adapter.ts:1143`
**Confidence**: 85%
**Category**: Issues in Your Changes
**Flagged by**: Consistency

**Problem**:
The MCP tool is named `Orchestrate` (bare verb), but the project's established pattern is verb-noun or noun-noun: `DelegateTask`, `TaskStatus`, `CancelTask`, `CreateLoop`, `ScheduleTask`, `ListSchedules`, etc. The related tools use inconsistent naming: `Orchestrate` (verb) + `OrchestratorStatus` (noun-noun) + `ListOrchestrators` (verb-noun).

**Fix**:
Rename to follow the established pattern:

```
Orchestrate        -> CreateOrchestrator  (matches CreateLoop, CreatePipeline)
OrchestratorStatus -> OrchestratorStatus  (already correct)
ListOrchestrators  -> ListOrchestrators   (already correct)
CancelOrchestrator -> CancelOrchestrator  (already correct)
```

---

### MEDIUM-3: Cleanup operations lack atomicity and safety
**File**: `src/implementations/orchestration-repository.ts:204-227`
**Confidence**: 85%
**Category**: Issues in Your Changes
**Flagged by**: Database + Performance

**Problem**:
`cleanupOldOrchestrations()` performs a SELECT to find old orchestrations, then deletes state files with `unlinkSync`, then runs a separate DELETE query. These operations are not atomic. If the process crashes between file deletion and DB deletion, state files are removed but DB rows remain (orphaned). Additionally:
- Uses `unlinkSync` (synchronous blocking I/O) in a loop
- Dynamically constructs `DELETE ... WHERE id IN (...)` SQL each time (breaks prepared-statement pattern)
- Could exceed SQLite variable limit (999) with many deletions

**Fix**:
Wrap in transaction, use async file deletion, and batch deletes:

```typescript
async cleanupOldOrchestrations(retentionMs: number): Promise<Result<number>> {
  return tryCatchAsync(async () => {
    const cutoff = Date.now() - retentionMs;
    const rows = this.cleanupStmt.all(cutoff) as Array<{ id: string; state_file_path: string }>;
    if (rows.length === 0) return 0;

    // Delete DB rows first (atomic)
    const ids = rows.map((r) => r.id);
    const BATCH_SIZE = 500;
    this.db.transaction(() => {
      for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const batch = ids.slice(i, i + BATCH_SIZE);
        const placeholders = batch.map(() => '?').join(',');
        this.db.prepare(`DELETE FROM orchestrations WHERE id IN (${placeholders})`).run(...batch);
      }
    })();

    // Then delete state files (best effort -- orphan files are harmless)
    await Promise.allSettled(
      rows.map((row) =>
        fs.promises.unlink(row.state_file_path).catch(() => {
          // Non-fatal: state file may already be deleted
        })
      )
    );

    return rows.length;
  }, operationErrorHandler('cleanup old orchestrations'));
}
```

---

### MEDIUM-4: listOrchestrations ignores offset with status filter
**File**: `src/services/orchestration-manager.ts:217-226`
**Confidence**: 90%
**Category**: Issues in Your Changes
**Flagged by**: Database, TypeScript

**Problem**:
When `status` filter is provided, `listOrchestrations` calls `findByStatus(status, limit)` which has no `offset` parameter. When listing without status, `findAll(limit, offset)` is called. This is an API contract violation: the MCP `ListOrchestrators` tool advertises `offset` support, but status-filtered queries ignore it.

**Fix**:
Add `offset` parameter to `findByStatus`:

```typescript
// In OrchestrationRepository interface:
findByStatus(status: OrchestratorStatus, limit?: number, offset?: number): Promise<Result<readonly Orchestration[]>>;

// In the service:
if (status) {
  return this.orchestrationRepo.findByStatus(status, limit, offset);
}
```

---

### MEDIUM-5: Insecure random for state file naming
**File**: `src/services/orchestration-manager.ts:92`
**Confidence**: 85%
**Category**: Issues in Your Changes
**Flagged by**: Security

**Problem**:
`Math.random()` is used for state file name suffixes. `Math.random()` is not cryptographically secure and produces predictable output. State file paths are used in shell commands, making them vulnerable to symlink race conditions.

**Fix**:
Use `crypto.randomUUID()` (already used for `OrchestratorId`):

```typescript
// Before
const stateFileName = `state-${Date.now()}-${Math.random().toString(36).substring(2, 8)}.json`;

// After
import { randomUUID } from 'crypto';
const stateFileName = `state-${Date.now()}-${randomUUID().slice(0, 8)}.json`;
```

---

### MEDIUM-6: State file path used unsanitized in shell command
**File**: `src/services/orchestration-manager.ts:141`
**Confidence**: 82%
**Category**: Issues in Your Changes
**Flagged by**: Security

**Problem**:
Exit condition is constructed as `node ${exitConditionScript} ${stateFilePath}` without quoting. If the path contains shell metacharacters, command injection is possible. Currently safe (path is generated), but violates defense-in-depth.

**Fix**:
Quote the arguments:

```typescript
// Before
exitCondition: `node ${exitConditionScript} ${stateFilePath}`,

// After
exitCondition: `node ${JSON.stringify(exitConditionScript)} ${JSON.stringify(stateFilePath)}`,
```

---

### MEDIUM-7: Large functions exceed complexity thresholds
**File**: `src/cli/commands/orchestrate.ts:284` and `:180`
**Confidence**: 88% / 85%
**Category**: Issues in Your Changes
**Flagged by**: Complexity

**Problem**:
- `handleOrchestrateForeground`: 117 lines, 4-level nesting (try > if > Promise callback > if)
- `handleOrchestrateDetach`: 98 lines, 4-level nesting (spawn > setInterval > try > if)

Both exceed the 50-line threshold and the 3-level nesting threshold.

**Fix**:
Extract helper functions to reduce nesting:

```typescript
// In handleOrchestrateForeground, extract:
async function waitForLoopCompletion(
  eventBus: EventBus,
  loopId: LoopId,
  service: OrchestrationService,
  orchestrationId: OrchestratorId,
): Promise<number> {
  return new Promise<number>((resolve) => {
    // ... event subscription + SIGINT handling ...
  });
}

// In handleOrchestrateDetach, extract:
function pollForOrchestrationId(logFile: string, spinner: Spinner): void {
  const maxAttempts = 75;
  let attempt = 0;
  // ... polling logic ...
}
```

---

### MEDIUM-8: MCPAdapter constructor grows to 7 parameters
**File**: `src/adapters/mcp-adapter.ts:328-336`
**Confidence**: 80%
**Category**: Issues in Code You Touched
**Flagged by**: Architecture

**Problem**:
The MCP adapter constructor now accepts 7 positional parameters. This pattern is fragile: adding another service requires updating every call site, and optional parameters are easy to miss.

**Fix**:
Use a single dependency object:

```typescript
interface MCPAdapterDependencies {
  taskManager: TaskManager;
  logger: Logger;
  scheduleService: ScheduleService;
  loopService: LoopService;
  agentRegistry?: AgentRegistry;
  config: Configuration;
  orchestrationService?: OrchestrationService;
}

constructor(dependencies: MCPAdapterDependencies) {
  this.taskManager = dependencies.taskManager;
  // ... etc
}
```

---

### MEDIUM-9: Prompt length limit raised without guardrails
**File**: `src/services/loop-manager.ts:55-60`
**Confidence**: 85%
**Category**: Issues in Your Changes
**Flagged by**: Complexity, Regression, Security, Dependencies

**Problem**:
Internal service limit for loop prompts raised from 4000 to 16000 to accommodate orchestrator prompts. Comment says "MCP boundary schemas keep the user-facing limit at 4000 chars" but the `LoopService` is public and can be called directly by CLI or other services, bypassing MCP validation. The 4x increase leaks beyond orchestrator use.

**Fix**:
Add a documented constant and pass `maxPromptLength` option:

```typescript
/** Internal limit for service-generated prompts (e.g., orchestrator).
    MCP schemas enforce 4000 for user input. */
const INTERNAL_PROMPT_LIMIT = 16000;

// In interface
createLoop(request: LoopCreateRequest, options?: { maxPromptLength?: number }): Promise<Result<Loop>>;

// In implementation
const effectiveLimit = options?.maxPromptLength ?? 4000;
if (request.prompt.length > effectiveLimit) {
  return err(new ValidationError(`Prompt must be 1-${effectiveLimit} characters`));
}
```

---

## Reviewer Scores

| Focus | Score | Recommendation |
|-------|-------|-----------------|
| **Architecture** | 7/10 | CHANGES_REQUESTED |
| **Complexity** | 7/10 | APPROVED_WITH_CONDITIONS |
| **Consistency** | 7/10 | CHANGES_REQUESTED |
| **Database** | 7/10 | CHANGES_REQUESTED |
| **Dependencies** | 9/10 | APPROVED_WITH_CONDITIONS |
| **Performance** | 7/10 | APPROVED_WITH_CONDITIONS |
| **Regression** | 6/10 | CHANGES_REQUESTED |
| **Security** | 7/10 | CHANGES_REQUESTED |
| **Tests** | 6/10 | CHANGES_REQUESTED |
| **TypeScript** | 7/10 | CHANGES_REQUESTED |

**Average Score**: 7.2/10

---

## What's Good

The orchestration feature demonstrates strong engineering discipline across multiple dimensions:

**Architecture**:
- Clean layer separation (domain, interfaces, repository, service, handler, adapter, CLI)
- Dependency injection throughout; no global state
- Result types used consistently; no thrown exceptions in business logic
- Event-driven lifecycle management via OrchestrationHandler
- Immutable domain objects with Object.freeze()
- Atomic state file writes (temp + rename pattern)

**Design Patterns**:
- Factory functions for creating domain objects
- Repository pattern with prepared statements
- Zod validation at the repository boundary (except state file)
- Event-driven architecture mirrors existing project conventions
- Handler factory pattern matches project style

**Testing**:
- 70+ tests across 7 test files covering domain, repository, handler, manager, CLI, state management, and integration
- Tests use real SQLite in-memory databases instead of mocks
- AAA (Arrange-Act-Assert) structure followed consistently
- Both happy and error paths tested
- Proper use of Result pattern in tests

**Code Quality**:
- Follows CLAUDE.md engineering principles (Result types, DI, immutability, validation at boundaries)
- Branded types for IDs (`OrchestratorId`, `OrchestratorStatus` enum)
- Readonly interfaces and const assertions
- Proper error handling with Result types
- No unsafe type casts (except the flagged ones)

**Security Posture**:
- SQL queries use parameterized statements throughout
- File permissions mostly restrictive (0o700/0o600)
- Path validation with symlink resolution
- Zod schemas at most boundaries
- No external dependencies added (clean supply chain)

---

## Action Plan

### Before Merge (Must Fix)

1. **Fix cancel PLANNING bug** (`src/services/orchestration-manager.ts:228-271`)
   - Update DB directly when loopId is absent
   - 10 min implementation + testing

2. **Add Zod validation to readStateFile** (`src/core/orchestrator-state.ts:76-88`)
   - Define StateFileSchema
   - Replace cast with .parse()
   - Update tests for malformed input
   - 15 min implementation + testing

3. **Add test:orchestration to test:all** (`package.json:19`)
   - Append to chain
   - Verify CI picks up all 70 tests
   - 2 min implementation

### Recommended Before Merge (Should Fix)

4. **Fix async/sync inconsistency** (`src/core/interfaces.ts:700-701`)
   - Convert save/update to async
   - ~5 min

5. **Rename MCP tool** (`src/adapters/mcp-adapter.ts:1143`)
   - Orchestrate → CreateOrchestrator
   - ~10 min

6. **Harden cleanup operations** (`src/implementations/orchestration-repository.ts:204-227`)
   - Add transaction, async deletion, batching
   - ~20 min

7. **Add offset to findByStatus** (`src/implementations/orchestration-repository.ts` + interface)
   - ~10 min

8. **Use crypto.randomUUID()** (`src/services/orchestration-manager.ts:92`)
   - ~3 min

9. **Quote shell arguments** (`src/services/orchestration-manager.ts:141`)
   - ~2 min

10. **Extract CLI helper functions** (`src/cli/commands/orchestrate.ts`)
    - Extract waitForLoopCompletion and pollForOrchestrationId
    - ~20 min

11. **Refactor MCPAdapter constructor** (`src/adapters/mcp-adapter.ts`)
    - Use dependency object instead of 7 positional params
    - ~15 min

12. **Add prompt length guardrails** (`src/services/loop-manager.ts:55-60`)
    - Document constant, pass options
    - ~10 min

---

## Summary

The orchestrator feature is a substantial, well-architected addition that demonstrates mastery of the project's patterns and conventions. The codebase is clean, the testing is thorough, and the design is solid. The three blocking issues are straightforward fixes that should not require architectural changes. The nine medium-severity issues are improvements to consistency, security, and maintainability that strengthen the overall quality.

With these fixes applied, this PR will be production-ready and set a high bar for future feature additions.
