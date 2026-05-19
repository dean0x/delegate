# Code Review Summary

**Branch**: feat/orchestrator-mode -> main
**PR**: #123
**Date**: 2026-03-27
**Reviewers**: 10 (security, architecture, performance, complexity, consistency, regression, tests, typescript, dependencies, database)

---

## Merge Recommendation: CHANGES_REQUESTED

This PR introduces well-architected orchestration mode with strong fundamentals (event-driven patterns, Zod validation, immutable domain objects, deps-object refactoring). However, there are **6 unresolved BLOCKING issues** and **6 SHOULD-FIX issues** that must be addressed before merge:

- **3 HIGH blocking issues** in architecture (2) and database (1)
- **3 MEDIUM blocking issues** across security (1), performance (2)
- Multiple HIGH/MEDIUM findings in tests, complexity, consistency, TypeScript, and regression

---

## Issue Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW | Total |
|----------|----------|------|--------|-----|-------|
| **Blocking** | 0 | 6 | 3 | 0 | **9** |
| **Should Fix** | 0 | 0 | 6 | 0 | **6** |
| **Pre-existing** | 0 | 0 | 2 | 1 | **3** |
| **TOTAL** | 0 | 6 | 11 | 1 | **18** |

---

## 🔴 BLOCKING ISSUES (Must Fix Before Merge)

### Architecture Issues

#### 1. OrchestrationHandler uses positional params while all other handlers use deps objects
- **File**: `src/services/handlers/orchestration-handler.ts:25-43`
- **Confidence**: 92-95%
- **Severity**: HIGH
- **Impact**: Violates refactoring pattern established in this PR. All 8 other handlers/services refactored to deps-object pattern; OrchestrationHandler is the sole exception.
- **Fix**:
  ```typescript
  export interface OrchestrationHandlerDeps {
    readonly orchestrationRepo: SyncOrchestrationOperations;
    readonly loopRepo: SyncLoopOperations;
    readonly database: TransactionRunner;
    readonly eventBus: EventBus;
    readonly logger: Logger;
  }

  private constructor(deps: OrchestrationHandlerDeps) { ... }
  static async create(deps: OrchestrationHandlerDeps): Promise<Result<OrchestrationHandler>> { ... }
  ```

#### 2. OrchestrationHandler.create() silently swallows subscription failures
- **File**: `src/services/handlers/orchestration-handler.ts:48-59`
- **Confidence**: 82-88%
- **Severity**: HIGH
- **Impact**: Handler can be created successfully without receiving events. Orchestrations would remain stuck in "running" forever. Other handlers return `err()` on subscription failure.
- **Fix**: Collect subscription results and return `err()` if any critical subscription fails:
  ```typescript
  const completedSub = eventBus.subscribe<LoopCompletedEvent>('LoopCompleted', ...);
  if (!completedSub.ok) {
    return err(new AutobeatError(ErrorCode.SYSTEM_ERROR, 'Failed to subscribe to LoopCompleted'));
  }
  const cancelledSub = eventBus.subscribe<LoopCancelledEvent>('LoopCancelled', ...);
  if (!cancelledSub.ok) {
    return err(new AutobeatError(ErrorCode.SYSTEM_ERROR, 'Failed to subscribe to LoopCancelled'));
  }
  ```

#### 3. Shared exit condition script at fixed path creates race condition
- **File**: `src/core/orchestrator-state.ts:128` / `src/core/orchestrator-state.ts:130`
- **Confidence**: 82%
- **Severity**: HIGH
- **Impact**: All orchestrations write to same `check-complete.js` file. Concurrent orchestrations overwrite each other's script. Script uses `process.argv[2] || <hardcoded-fallback>`, so if arg is missing, wrong state file is evaluated.
- **Fix**: Generate unique script name per orchestration:
  ```typescript
  export function writeExitConditionScript(dir: string, orchestrationId: string, stateFilePath: string): string {
    const scriptPath = path.join(dir, `check-complete-${orchestrationId}.js`);
    const script = `try {
      const s = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
      process.exit(s.status === 'complete' ? 0 : 1);
    } catch { process.exit(1); }
    `;
    // ...
  }
  ```

### Database Issues

#### 4. Cancelling a PLANNING orchestration never updates DB status
- **File**: `src/services/orchestration-manager.ts:228-271`
- **Confidence**: 92%
- **Severity**: HIGH
- **Impact**: When PLANNING orchestration (no loopId) is cancelled, DB status is never updated. API reports success but data is inconsistent. OrchestrationHandler only subscribes to LoopCompleted/Cancelled, not OrchestrationCancelled.
- **Fix**: Direct DB update when no loopId:
  ```typescript
  if (!orchestration.loopId) {
    // No loop to cancel -- update DB directly
    const updated = updateOrchestration(orchestration, {
      status: OrchestratorStatus.CANCELLED,
      completedAt: Date.now(),
    });
    const updateResult = this.orchestrationRepo.update(updated);
    if (!updateResult.ok) return err(updateResult.error);
  }
  ```

### Performance Issues

#### 5. Cleanup creates unprepared statements inside a loop
- **File**: `src/implementations/orchestration-repository.ts:223`
- **Confidence**: 90%
- **Severity**: HIGH
- **Impact**: `db.prepare()` called in loop during cleanup. Prepared-statement compilation cost. Runs on every server startup during recovery. Other repositories use pre-prepared statements.
- **Fix**: Use pre-prepared DELETE statement:
  ```typescript
  // In constructor:
  this.cleanupDeleteStmt = this.db.prepare(`
    DELETE FROM orchestrations
    WHERE status IN ('completed', 'failed', 'cancelled') AND completed_at < ?
  `);

  // In cleanupOldOrchestrations():
  const rows = this.cleanupStmt.all(cutoff) as Array<{ id: string; state_file_path: string }>;
  if (rows.length === 0) return 0;
  const result = this.cleanupDeleteStmt.run(cutoff);
  // Then async file cleanup...
  ```

### Security Issues

#### 6. Cleanup deletes file paths read from DB without validation
- **File**: `src/implementations/orchestration-repository.ts:232-233`
- **Confidence**: 85%
- **Severity**: MEDIUM (HIGH for defense-in-depth)
- **Impact**: State file paths from DB passed to `unlink()` without validation. While write path is safe (validatePath at creation), delete path trusts DB blindly. Corrupted DB row or future code path could delete unintended files.
- **Fix**: Validate paths before deletion:
  ```typescript
  import path from 'path';
  const stateDir = getStateDir();
  const safePaths = filePaths.filter((fp) => {
    const resolved = path.resolve(fp);
    return resolved.startsWith(stateDir + path.sep);
  });
  await Promise.allSettled(safePaths.map((filePath) => unlink(filePath)));
  ```

#### 7. Exit condition script accepts `process.argv[2]` override
- **File**: `src/core/orchestrator-state.ts:130`
- **Confidence**: 82%
- **Severity**: MEDIUM
- **Impact**: Script uses `process.argv[2] || <hardcoded-path>` as fallback. Attacker with DB write access could override loop's exitCondition to redirect state file read, manipulating loop termination.
- **Fix**: Remove argv[2] fallback. Generate per-orchestration scripts:
  ```typescript
  const scriptPath = path.join(dir, `check-complete-${crypto.randomUUID().substring(0, 8)}.js`);
  const script = `try {
    const s = JSON.parse(require('fs').readFileSync(${JSON.stringify(stateFilePath)}, 'utf8'));
    process.exit(s.status === 'complete' ? 0 : 1);
  } catch { process.exit(1); }
  `;
  ```

#### 8. Prompt length limit removed without replacement bound
- **File**: `src/services/loop-manager.ts:55-60`
- **Confidence**: 81%
- **Severity**: MEDIUM
- **Impact**: 4000-char limit removed from service layer. MCP Zod still enforces 4000 at boundary, but internal callers (OrchestrationManagerService) have no bound. Orchestrator prompt could reach ~10,000 chars unbounded.
- **Fix**: Restore bounded limit (higher but still safe):
  ```typescript
  if (request.prompt && request.prompt.length > 16000) {
    return err(
      new AutobeatError(ErrorCode.INVALID_INPUT, 'prompt must not exceed 16000 characters', {
        field: 'prompt',
        length: request.prompt.length,
      }),
    );
  }
  ```

### Database Schema Issues

#### 9. `findByStatus` does not support offset -- pagination silently broken
- **File**: `src/implementations/orchestration-repository.ts:112-114` / `src/services/orchestration-manager.ts:217-226`
- **Confidence**: 90%
- **Severity**: MEDIUM
- **Impact**: MCP tool `ListOrchestrators` exposes `offset` to users, but `findByStatus` silently drops it. Prepared statement lacks `OFFSET ?`. Pagination with status filter broken.
- **Fix**: Add offset to findByStatus:
  ```sql
  SELECT * FROM orchestrations WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?
  ```
  ```typescript
  async findByStatus(status: OrchestratorStatus, limit?: number, offset?: number): Promise<...>
  ```

---

## ⚠️ SHOULD-FIX ISSUES (Strong Recommendations)

### TypeScript & Type Safety

#### 10. Unsafe `as OrchestratorStatus` cast in MCP adapter
- **File**: `src/adapters/mcp-adapter.ts:2701`
- **Confidence**: 88%
- **Severity**: MEDIUM
- **Impact**: Zod schema enum values cast to OrchestratorStatus without type-safe alignment. If either changes, compiler won't catch mismatch.
- **Fix**: Use `z.nativeEnum(OrchestratorStatus)`:
  ```typescript
  const ListOrchestratorsSchema = z.object({
    status: z.nativeEnum(OrchestratorStatus).optional(),
    // ...
  });
  ```

#### 11. `toRow()` returns `Record<string, unknown>` -- loses type safety
- **File**: `src/implementations/orchestration-repository.ts:267-283`
- **Confidence**: 80%
- **Severity**: MEDIUM
- **Impact**: Any typo in property name (e.g., `loopid` vs `loopId`) passes silently to SQLite, binding as NULL. No compile error.
- **Fix**: Define typed binding parameters interface:
  ```typescript
  interface OrchestrationBindParams {
    readonly id: string;
    readonly goal: string;
    readonly loopId: string | null;
    // ... all fields ...
  }
  private toRow(orchestration: Orchestration): OrchestrationBindParams { ... }
  ```

### Tests

#### 12. No MCP adapter tests for 4 new orchestration tool handlers
- **File**: `src/adapters/mcp-adapter.ts:252-445`
- **Confidence**: 95%
- **Severity**: HIGH (blocking for test quality)
- **Impact**: ~200 lines of new business logic (4 handlers) with zero test coverage. Zod validation, path validation, service errors, undefined service guard all untested.
- **Fix**: Add test cases for CreateOrchestrator, OrchestratorStatus, ListOrchestrators, CancelOrchestrator (follow existing simulate* pattern).

#### 13. No tests for orchestration cleanup in RecoveryManager
- **File**: `src/services/recovery-manager.ts:203-210`
- **Confidence**: 92%
- **Severity**: HIGH (blocking for test quality)
- **Impact**: New cleanupOldOrchestrations method in Phase 1c recovery. Zero tests. Cleanup path never exercised by test suite.
- **Fix**: Add cleanup section mirroring loop cleanup tests (called with correct retention, logs count, skips when undefined).

### Consistency Issues

#### 14. RecoveryManagerDeps uses inconsistent field naming
- **File**: `src/services/recovery-manager.ts:20-28`
- **Confidence**: 88%
- **Severity**: MEDIUM
- **Impact**: Mixed naming: `repository`, `dependencyRepo`, `workerRepository`, `loopRepository`, `orchestrationRepository`. Other deps interfaces use abbreviated suffix consistently.
- **Fix**: Rename to consistent `Repo` suffix:
  ```typescript
  export interface RecoveryManagerDeps {
    readonly taskRepo: TaskRepository;
    readonly queue: TaskQueue;
    readonly eventBus: EventBus;
    readonly logger: Logger;
    readonly workerRepo: WorkerRepository;
    readonly dependencyRepo: DependencyRepository;
    readonly loopRepo?: LoopRepository;
    readonly orchestrationRepo?: OrchestrationRepository;
  }
  ```

#### 15. State file status enum diverges from domain OrchestratorStatus
- **File**: `src/core/orchestrator-state.ts:20` vs `src/core/domain.ts:663`
- **Confidence**: 85%
- **Severity**: MEDIUM
- **Impact**: State file uses `'executing'` vs `'running'`, `'complete'` vs `'completed'`. Overlapping values have different names, creating mapping hazard.
- **Fix**: Align overlapping statuses:
  ```typescript
  readonly status: 'planning' | 'running' | 'validating' | 'completed' | 'failed' | 'cancelled';
  ```

### Complexity Issues

#### 16. `handleOrchestrateForeground` exceeds length and nesting thresholds
- **File**: `src/cli/commands/orchestrate.ts:214-330`
- **Confidence**: 88%
- **Severity**: MEDIUM
- **Impact**: 116 lines, 10+ branches, 4-level nesting. Event subscription and SIGINT handling in nested Promise callback. Exceeds 50-line threshold.
- **Fix**: Extract event-waiting logic:
  ```typescript
  function waitForLoopCompletion(
    eventBus: EventBus,
    loopId: LoopId,
    service: OrchestrationService,
    orchestrationId: OrchestratorId,
  ): Promise<number> {
    return new Promise<number>((resolve) => {
      let resolved = false;
      const subscriptionIds: string[] = [];
      const cleanup = () => { for (const id of subscriptionIds) eventBus.unsubscribe(id); };
      // ... subscriptions ...
    });
  }
  ```

#### 17. `parseOrchestrateCreateArgs` has 12 branches with repeated pattern
- **File**: `src/cli/commands/orchestrate.ts:76-139`
- **Confidence**: 82%
- **Severity**: MEDIUM
- **Impact**: Cyclomatic complexity ~14. Numeric flag parsing pattern duplicated 3 times for max-depth/workers/iterations.
- **Fix**: Extract helper to deduplicate:
  ```typescript
  function parseIntFlag(args: readonly string[], i: number, name: string, min: number, max: number):
    Result<{ value: number; nextIndex: number }, string> {
    const next = args[i + 1];
    const val = parseInt(next, 10);
    if (isNaN(val) || val < min || val > max) return err(`${name} must be ${min}-${max}`);
    return ok({ value: val, nextIndex: i + 1 });
  }
  ```

### Regression Issues

#### 18. `withServices()` makes orchestrationService required
- **File**: `src/cli/services.ts:89-94`
- **Confidence**: 83%
- **Severity**: MEDIUM
- **Impact**: orchestrationService resolved with `exitOnError()`. If service resolution fails (e.g., migration not applied), ALL CLI commands using withServices fail, not just orchestrate commands. Affects cancel, retry, resume, schedule, loop, pipeline commands.
- **Fix**: Make orchestrationService optional:
  ```typescript
  const orchestrationServiceResult = container.get<OrchestrationService>('orchestrationService');
  const orchestrationService = orchestrationServiceResult.ok ? orchestrationServiceResult.value : undefined;
  // Return with optional field
  ```

### Other High-Impact Should-Fix Issues

#### 19. `cleanupOldOrchestrations` uses dynamic SQL with unbounded IN clause
- **File**: `src/implementations/orchestration-repository.ts:219-222`
- **Confidence**: 80%
- **Severity**: MEDIUM
- **Impact**: Unbounded IN clause. If thousands of old orchestrations exist, SQL statement exceeds SQLite's `SQLITE_MAX_VARIABLE_NUMBER` (999), causing runtime error.
- **Fix**: Batch deletions:
  ```typescript
  const BATCH_SIZE = 500;
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const placeholders = batch.map(() => '?').join(',');
    this.db.prepare(`DELETE FROM orchestrations WHERE id IN (${placeholders})`).run(...batch);
  }
  ```

#### 20. `cleanupOldOrchestrations` SELECT and DELETE not atomic
- **File**: `src/implementations/orchestration-repository.ts:204-227`
- **Confidence**: 85%
- **Severity**: MEDIUM
- **Impact**: Not wrapped in transaction. Crash between file deletions and DB delete = orphaned rows pointing to missing files.
- **Fix**: Wrap operations in transaction or move file deletions after transaction commits.

---

## ℹ️ INFORMATION (Pre-existing or Lower Priority)

- **PF-005/PF-006 Known Pitfalls** in loop-handler (getResetTargetSha O(n), commitAllChanges sequential spawns) not addressed, but pre-existing issues
- **test:orchestration script not in test:all** (caught by dependencies reviewer) -- already fixed in commit
- **Stale comment in TEST_STANDARDS.md** showing old positional constructor pattern
- **Math.random() used for log file uniqueness** (should use crypto.randomUUID())
- **Detach log directory/files created without restrictive permissions** (should use 0o700/0o600)
- **Prompt length validation comment stale** in loop-manager

---

## Quality Assessment

### Strengths
- ✅ Event-driven pattern consistent with existing architecture
- ✅ Typed deps objects refactoring across 8+ classes well-executed
- ✅ Zod validation at all I/O boundaries
- ✅ Immutable domain objects with Object.freeze()
- ✅ No external dependencies added (clean)
- ✅ SQLite migrations well-structured
- ✅ Result<T,E> pattern used throughout
- ✅ Repository pattern followed correctly
- ✅ Self-review and fix iteration demonstrated

### Critical Gaps
- ❌ 3 HIGH architecture/database issues (handler pattern, DB atomicity, pagination)
- ❌ 2 HIGH test gaps (MCP adapters, recovery manager)
- ❌ Shared exit condition script race condition
- ❌ Consistency issues in deps naming and status enums
- ❌ Type-unsafe casts and Record<string, unknown> returns
- ❌ CLI complexity thresholds exceeded

### Required Before Merge
1. Fix OrchestrationHandler to use deps-object pattern (HIGH priority)
2. Make subscription failures return err() not ok() (HIGH priority)
3. Fix concurrent orchestration exit condition script race (HIGH priority)
4. Add PLANNING-state cancellation DB update (HIGH priority)
5. Replace dynamic db.prepare() with pre-prepared statement in cleanup (HIGH priority)
6. Add offset parameter to findByStatus pagination (MEDIUM priority)
7. Add comprehensive MCP adapter tests (HIGH for test coverage)
8. Add RecoveryManager cleanup tests (HIGH for test coverage)

---

## Action Plan

### Phase 1: Architecture & Database Fixes (2-3 hours)
- [ ] Refactor OrchestrationHandler to deps-object pattern
- [ ] Fix subscription failure handling to return err()
- [ ] Fix concurrent exit condition script with unique names per orchestration
- [ ] Add PLANNING-state DB direct update in cancel
- [ ] Replace dynamic db.prepare() with pre-prepared statement
- [ ] Add offset to findByStatus pagination

### Phase 2: Tests (1-2 hours)
- [ ] Add 4 MCP adapter tool handler test suites
- [ ] Add RecoveryManager orchestration cleanup tests
- [ ] Add handler-setup wiring tests for OrchestrationHandler

### Phase 3: Quality Improvements (1 hour)
- [ ] Fix type-unsafe casts with z.nativeEnum() and typed interfaces
- [ ] Standardize RecoveryManagerDeps field naming
- [ ] Align state file status enums with domain
- [ ] Extract CLI complexity helpers (waitForLoopCompletion, parseIntFlag)
- [ ] Make orchestrationService optional in withServices()

### Phase 4: Documentation (30 min)
- [ ] Update TEST_STANDARDS.md with deps-object examples
- [ ] Update stale comments in loop-manager
- [ ] Add UNIQUE constraint to loop_id column (optional)

---

## Recommendation Summary

**CHANGES_REQUESTED** - The PR introduces a solid orchestration feature with well-thought architecture and strong engineering fundamentals. The 9 blocking issues are all fixable straightforward changes. The main clusters are:

1. **Pattern inconsistency**: OrchestrationHandler not refactored to deps-object
2. **Silent failures**: Subscription failures and data inconsistencies
3. **Race conditions**: Shared exit condition script
4. **Test coverage gaps**: MCP adapters and recovery manager
5. **Type safety**: Unsafe casts and Record<string, unknown>

None are architecturally fundamental, but they must be resolved before merge to maintain the high quality bar the codebase has established. Estimated fix time: **4-5 hours** for experienced developer familiar with the codebase.
