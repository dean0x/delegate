# Code Review Summary

**Branch**: feat/read-only-cli-90 -> main
**Date**: 2026-03-18
**PR**: #100

---

## Merge Recommendation: CHANGES_REQUESTED

This PR introduces a performance-oriented `ReadOnlyContext` pattern to bypass full bootstrap for CLI query commands, reducing startup latency by ~200-500ms. The core concept is sound and architecturally valid. However, **two blocking issues must be addressed before merge**:

1. **DIP violation**: `ReadOnlyContext` exposes concrete `Database` class instead of an interface
2. **Missing database cleanup**: CLI commands create database connections but never close them

Additionally, **one blocking test coverage issue** must be resolved: existing CLI tests now validate dead code paths (the old `TaskManager`/`ScheduleService` implementations), creating false confidence that the refactored commands work correctly.

---

## Issue Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW | Total |
|----------|----------|------|--------|-----|-------|
| **Blocking** | 0 | 3 | 2 | 0 | 5 |
| **Should Fix** | 0 | 0 | 6 | 1 | 7 |
| **Pre-existing** | 0 | 0 | 4 | 3 | 7 |

**Total Issues**: 19 (5 blocking, 7 recommended, 7 pre-existing)

---

## Blocking Issues (Must Fix Before Merge)

### 🔴 HIGH: DIP Violation - `ReadOnlyContext` Depends on Concrete `Database` Class

**Location**: `src/cli/read-only-context.ts:18,24`

**Problem**: The `ReadOnlyContext` interface exposes the concrete `Database` class instead of an abstraction:
```typescript
export interface ReadOnlyContext {
  readonly database: Database;  // CONCRETE CLASS, not interface
  readonly taskRepository: TaskRepository;
  readonly outputRepository: OutputRepository;
  readonly scheduleRepository: ScheduleRepository;
}
```

This violates the Dependency Inversion Principle that the rest of the codebase follows (via `TransactionRunner` interface, repository interfaces in `src/core/interfaces.ts`). Additionally, `OutputRepository` is imported from the implementation layer rather than from `src/core/interfaces.ts`, amplifying the violation.

**Impact**: HIGH - Tight coupling to SQLite implementation. Callers who receive `ReadOnlyContext` cannot substitute test doubles without pulling in the concrete Database class.

**Fix**: Apply one of two options:

**Option A** (Preferred): Remove `database` from the public interface; manage lifecycle internally:
```typescript
export interface ReadOnlyContext {
  readonly taskRepository: TaskRepository;
  readonly outputRepository: OutputRepository;  // Move to core/interfaces.ts
  readonly scheduleRepository: ScheduleRepository;
  close(): void;
}
```

**Option B**: Expose only the lifecycle interface:
```typescript
interface Closeable {
  close(): void;
  isOpen(): boolean;
}

export interface ReadOnlyContext {
  readonly database: Closeable;
  readonly taskRepository: TaskRepository;
  readonly outputRepository: OutputRepository;
  readonly scheduleRepository: ScheduleRepository;
}
```

**Related Pre-existing Issue**: `OutputRepository` interface lives in `src/implementations/output-repository.ts` instead of `src/core/interfaces.ts`. Move it to `src/core/interfaces.ts` with this fix.

---

### 🔴 HIGH: Missing Database Cleanup in CLI Commands

**Location**: `src/cli/commands/logs.ts`, `src/cli/commands/status.ts`, `src/cli/commands/schedule.ts`

**Problem**: Commands call `withReadOnlyContext(s)` to create a `Database` connection, but never close it:
- Tests correctly call `ctx.database.close()` in every test case, establishing the expected pattern
- CLI production code relies on `process.exit()` to clean up the OS file handle
- This violates the project's own "Resource cleanup - Always use try/finally or using pattern" from CLAUDE.md

**Impact**: HIGH - While `process.exit()` currently handles cleanup, this pattern could cause resource leaks if these functions are ever called without exiting (e.g., embedded in tests, REPL, or long-running processes). The divergence between test cleanup and production code creates maintenance confusion.

**Fix**: Add `ctx.database.close()` in a `finally` block before `process.exit()`. Example for `status.ts`:
```typescript
export async function getTaskStatus(taskId?: string) {
  const s = ui.createSpinner();
  let ctx: ReadOnlyContext | undefined;
  try {
    s.start(taskId ? `Fetching status for ${taskId}...` : 'Fetching tasks...');
    ctx = withReadOnlyContext(s);
    // ... existing command logic ...
  } catch (error) {
    s.stop('Failed');
    ui.error(errorMessage(error));
    process.exit(1);
  } finally {
    ctx?.database.close();
  }
}
```

Apply the same pattern to `logs.ts` and `schedule.ts`.

---

### 🔴 HIGH: Stale CLI Tests - Testing Dead Code Paths

**Location**: `tests/unit/cli.test.ts:576-740, 1002-1048`

**Problem**: The PR refactors status, logs, schedule-list, and schedule-get from `TaskManager`/`ScheduleService` to direct repository access via `ReadOnlyContext`. However, the existing CLI tests still validate the old mock-based paths via `simulateStatusCommand(mockTaskManager)` and `mockScheduleService.listSchedules()`.

The actual CLI commands now call:
- `ctx.taskRepository.findById()` / `ctx.taskRepository.findAllUnbounded()`
- `ctx.outputRepository.get()`
- `ctx.scheduleRepository.findAll()` / `ctx.scheduleRepository.findById()`

But the tests never exercise these paths. Instead they test `mockTaskManager.getStatus()` and `mockScheduleService.listSchedules()` which are no longer called by production code.

**Impact**: HIGH - Tests pass with false confidence. The refactored CLI commands have **zero integration-level test coverage**. The new `read-only-context.test.ts` validates the factory function but not the CLI commands that consume it.

**Fix**: Either:
1. **Update existing CLI tests** to use `ReadOnlyContext` with actual repositories (and mocked `process.exit` / `ui`) instead of `MockTaskManager` / `MockScheduleService`
2. **Add new integration tests** for the refactored CLI commands (`getTaskStatus`, `getTaskLogs`, `handleScheduleCommand` for list/get) that exercise the actual production code paths

---

### 🔴 MEDIUM: Missing Type-Only Imports in `read-only-context.ts`

**Location**: `src/cli/read-only-context.ts:16,19`

**Problem**: Interface types are imported as value imports instead of type-only imports:
```typescript
// Current (incorrect)
import { ScheduleRepository, TaskRepository } from '../core/interfaces.js';
import { OutputRepository } from '../implementations/output-repository.js';

// Should be
import type { ScheduleRepository, TaskRepository } from '../core/interfaces.js';
import type { OutputRepository } from '../implementations/output-repository.js';
```

**Impact**: MEDIUM - While the TypeScript compiler handles this, it violates the skill checklist and makes intent unclear (are these interfaces used as values or only types?).

**Fix**: Add `type` keyword to the three interface imports.

---

### 🔴 MEDIUM: Unused Import `ReadOnlyContext` in Test File

**Location**: `tests/unit/read-only-context.test.ts:5`

**Problem**: The test file imports `ReadOnlyContext` as a named export but never uses it as a type annotation:
```typescript
import { createReadOnlyContext, ReadOnlyContext } from '../../src/cli/read-only-context.js';
// ReadOnlyContext is never used; only createReadOnlyContext is called
```

**Impact**: MEDIUM - Dead import adds cognitive load and violates lint rules.

**Fix**: Remove the unused import:
```typescript
import { createReadOnlyContext } from '../../src/cli/read-only-context.js';
```

---

## Should-Fix Issues (Recommended, Not Blocking)

### ⚠️ HIGH: Pre-existing Unvalidated `statusEnum` Carry-Forward

**Location**: `src/cli/commands/schedule.ts:276-279`

**Problem**: User-supplied `--status` value is cast to `ScheduleStatus` enum without validation:
```typescript
const statusValue = ScheduleStatus[statusEnum.toUpperCase() as keyof typeof ScheduleStatus];
```

If a user passes `--status constructor`, the lookup hits inherited `Object.prototype` properties rather than enum values, yielding unexpected values like `[Function: ScheduleStatus]`.

This pattern existed in the original code (via `service.listSchedules()`), but the refactor to direct repository access preserves it without adding validation.

**Impact**: HIGH for consistency - Parameterized prepared statements prevent SQL injection, so no security risk. However, passing prototype-chain property names produces confusing behavior.

**Recommendation**: Add validation as a follow-up to your changes while refactoring the function:
```typescript
const validStatuses = Object.values(ScheduleStatus);
const statusValue = statusEnum
  ? ScheduleStatus[statusEnum.toUpperCase() as keyof typeof ScheduleStatus]
  : undefined;
if (statusEnum && (!statusValue || !validStatuses.includes(statusValue))) {
  ui.error(`Invalid status: ${status}. Valid values: ${validStatuses.join(', ')}`);
  process.exit(1);
}
```

---

### ⚠️ MEDIUM: Repeated Error-Handling Boilerplate

**Location**: `src/cli/commands/logs.ts`, `src/cli/commands/schedule.ts`

**Problem**: Functions like `getTaskLogs()` and `scheduleGet()` now have 3+ sequential Result-check-and-exit blocks, each repeating the same pattern:
```typescript
if (!result.ok) {
  s.stop('Failed');
  ui.error(`error: ${result.error.message}`);
  process.exit(1);
}
```

This inflates line count (logs.ts: 56 → 76 lines, schedule.ts: 55 → 76 lines).

**Impact**: MEDIUM - Boilerplate increases visual noise. Still under 85-line warning threshold but trending upward.

**Recommendation**: Extract a small helper:
```typescript
function exitOnError<T>(result: Result<T>, s: Spinner, msg?: string): T {
  if (!result.ok) {
    s.stop('Failed');
    ui.error(msg || result.error.message);
    process.exit(1);
  }
  return result.value;
}
```

---

### ⚠️ MEDIUM: `findAllUnbounded()` in Task List Command

**Location**: `src/cli/commands/status.ts:62`

**Problem**: `getTaskStatus()` (list all tasks) uses `findAllUnbounded()` which loads every task with no limit. For users with thousands of accumulated tasks, this dumps all rows to the terminal and memory.

The paginated variant `findAll(limit?)` has a default limit of 100.

**Impact**: MEDIUM - Poor UX for heavy users. Pre-existing pattern (old `taskManager.getStatus()` called the same method), but now is an opportunity to improve.

**Recommendation**: Switch to paginated `findAll()`:
```typescript
const result = await ctx.taskRepository.findAll();  // defaults to 100
```

Or add a `--limit` flag like `schedule list` has.

---

### ⚠️ MEDIUM: Sequential Database Queries Without Parallelization

**Location**: `src/cli/commands/logs.ts:13-26`

**Problem**: `getTaskLogs()` makes two sequential queries: first `findById()` to validate the task exists, then `outputRepository.get()` to fetch output. These are independent and could be parallelized with `Promise.all()`.

**Impact**: MEDIUM - Adds one extra database round-trip per invocation (~1-5ms with SQLite). Minor overhead but unnecessary.

**Recommendation**: Use `Promise.all()`:
```typescript
const [taskResult, outputResult] = await Promise.all([
  ctx.taskRepository.findById(TaskId(taskId)),
  ctx.outputRepository.get(TaskId(taskId)),
]);
```

Or remove the task existence check entirely if not needed (output repo already returns null for missing tasks).

---

### ⚠️ MEDIUM: `scheduleGet` History Fetch Error Handling Inconsistency

**Location**: `src/cli/commands/schedule.ts:330-334`

**Problem**: When `repo.getExecutionHistory()` fails, the code prints an error but **continues rendering** the schedule without the history section and **exits with code 0** (success). This is graceful degradation, inconsistent with every other repository call in the codebase that exits with code 1 on failure.

**Impact**: MEDIUM - Inconsistent error handling. Exit code 0 despite an error misleads consumers who script against exit codes.

**Recommendation**: Either exit with code 1 on history fetch failure (consistent with all other repo failures), or add a comment documenting that history is optional and graceful-degradation is intentional.

---

### ⚠️ MEDIUM: Unnecessary Type Assertion Removes `readonly`

**Location**: `src/cli/commands/status.ts:66`

**Problem**: `result.value as Task[]` casts `readonly Task[]` to mutable `Task[]`. The old code had this cast to disambiguate a union type; after refactoring to direct `findAllUnbounded()`, the return type is already `readonly Task[]`, making the cast unnecessary and dangerous.

**Impact**: MEDIUM - Silently removes `readonly` modifier, weakening immutability guarantees. While no mutation happens in the current loop, the cast could mask future bugs.

**Fix**: Remove the assertion:
```typescript
for (const task of result.value) {  // works on readonly arrays
```

---

### ⚠️ MEDIUM: Non-Null Assertions Instead of Null Guards in Tests

**Location**: `tests/unit/read-only-context.test.ts:56-57, 135-136`

**Problem**: Test uses non-null assertions (`findResult.value!.prompt`) instead of null guards. While preceded by `expect().not.toBeNull()`, TypeScript does not narrow types based on test assertions.

**Impact**: MEDIUM - Anti-pattern per TypeScript guidelines. Risk is low in tests, but inconsistent with the proper `if (!result.ok) return` guard pattern used elsewhere in the same file.

**Fix**: Use null guards instead:
```typescript
const task = findResult.value;
if (!task) return;
expect(task.prompt).toBe('test read-only context');
```

---

### ⚠️ LOW: Inconsistent Spinner Pattern in Schedule Command

**Location**: `src/cli/commands/schedule.ts:17-20`

**Problem**: The read-only path creates a spinner with `'Initializing...'` then `'Ready'` states. Other read-only commands use contextual messages directly (`'Fetching status for ...'`). Two different spinner patterns.

**Impact**: LOW - Minor UX inconsistency. Users see different initialization feedback depending on which read-only command they run.

**Recommendation**: Align patterns (simpler status/logs pattern preferred).

---

## Pre-existing Issues (Not Blocking)

### ℹ️ MEDIUM: `OutputRepository` Interface in Implementation Layer

**Location**: `src/implementations/output-repository.ts:15`

**Problem**: Every other repository interface (`TaskRepository`, `ScheduleRepository`, etc.) is in `src/core/interfaces.ts`. `OutputRepository` is the sole exception, defined alongside its implementation. This pre-existing issue is amplified by the new `ReadOnlyContext` which must import from the implementation layer.

**Recommendation**: Move `OutputRepository` to `src/core/interfaces.ts` as a follow-up to this PR. Update imports in `bootstrap.ts`, `task-manager.ts`, `process-connector.ts`, `event-driven-worker-pool.ts`, and `read-only-context.ts`.

---

### ℹ️ MEDIUM: `BootstrapOptions` Accumulating Boolean Flags

**Location**: `src/bootstrap.ts:33-43`

**Problem**: The interface now has 3 `skip*` boolean flags (`skipResourceMonitoring`, `skipScheduleExecutor`, `skipRecovery`). Combinatorial space (8 configurations) makes it hard to reason about which components are active.

**Recommendation**: Consider a `mode` enum (`'full' | 'cli-mutation' | 'cli-query'`) in a future PR. Current 3 flags are still manageable.

---

### ℹ️ MEDIUM: Large `schedule.ts` Command File

**Location**: `src/cli/commands/schedule.ts:439 lines`

**Problem**: File exceeds 300-line warning threshold. Contains 7 functions (create, list, get, cancel, pause, resume, dispatch). Pre-existing before this PR.

**Recommendation**: Split into `schedule/{create,list,get,etc}.ts` in a follow-up.

---

### ℹ️ MEDIUM: Large `scheduleCreate` Function

**Location**: `src/cli/commands/schedule.ts:57-256` (199 lines, cyclomatic complexity ~20)

**Problem**: Pre-existing, not changed in this PR, but touched by dispatcher refactor. Function has 15+ flag-parsing branches, complex for-loop argument parser.

**Recommendation**: Extract into helper functions in a follow-up.

---

### ℹ️ LOW: `ReadOnlyContext` Bypasses DI Container

**Location**: `src/cli/read-only-context.ts:34-43`

**Problem**: `createReadOnlyContext()` directly instantiates `new Database()`, `new SQLiteTaskRepository()`, etc. instead of using the DI container. This creates a parallel construction path that must stay in sync with `bootstrap()`.

**Recommendation**: This is an acceptable architectural trade-off for the ~200-500ms performance gain. Mitigate by documenting which bootstrap registrations must stay in sync (with a comment), or use a shared factory for the repository constructors.

---

### ℹ️ LOW: Repeated Context Creation Pattern in Tests

**Location**: `tests/unit/read-only-context.test.ts`

**Problem**: Every test repeats the same 4-line pattern:
```typescript
const result = createReadOnlyContext();
expect(result.ok).toBe(true);
if (!result.ok) return;
const ctx = result.value;
```

**Recommendation**: Extract a helper (optional, but reduces DRY violation).

---

### ℹ️ LOW: Database Constructor Synchronous I/O

**Location**: `src/implementations/database.ts:62-88`

**Problem**: Constructor uses `fs.mkdirSync()`, `fs.existsSync()`, and SQLite synchronous operations, blocking the event loop. Pre-existing pattern.

**Recommendation**: Acceptable for startup-only use. No action needed.

---

### ℹ️ LOW: Missing `verbatimModuleSyntax` in TypeScript Config

**Location**: `tsconfig.json`

**Problem**: The project does not enable `verbatimModuleSyntax`, so the compiler silently drops type-only imports regardless of syntax used. This allows sloppy import hygiene to work unintentionally.

**Recommendation**: Consider enabling in a future global TypeScript cleanup.

---

## Score Summary

| Reviewer | Score | Recommendation | Key Issues |
|----------|-------|-----------------|-----------|
| **Security** | 9/10 | APPROVED | No auth bypass; parameterized queries protect against injection |
| **Architecture** | 7/10 | CHANGES_REQUESTED | HIGH: DIP violation (concrete Database); MEDIUM: cleanup in commands |
| **Performance** | 8/10 | APPROVED_WITH_CONDITIONS | HIGH: DB cleanup required; MEDIUM: unbounded query in list |
| **Complexity** | 7/10 | APPROVED_WITH_CONDITIONS | MEDIUM: boilerplate in error handling (cosmetic) |
| **Consistency** | 7/10 | APPROVED_WITH_CONDITIONS | MEDIUM: unused import, spinner pattern inconsistency |
| **Regression** | 9/10 | APPROVED | Behavioral parity with old paths maintained |
| **Tests** | 5/10 | CHANGES_REQUESTED | HIGH: stale CLI tests; missing coverage for new code |
| **TypeScript** | 7/10 | APPROVED_WITH_CONDITIONS | HIGH: missing type-only imports, unused import |

**Average Score**: 7.4/10

---

## What This PR Does Well

1. **Sound architectural concept**: Separating read-only query paths from full mutation bootstrap (CQRS-lite pattern) is well-established and reduces unnecessary component initialization.

2. **Performance win**: Eliminating ~200-500ms of bootstrap for CLI query commands (`status`, `logs`, `schedule list`, `schedule get`) is a meaningful improvement for developer experience.

3. **Minimal scope**: The core change (`ReadOnlyContext` interface and factory) is small (~44 lines) and easy to understand.

4. **Correct behavior parity**: The refactored CLI commands produce identical output and error codes as the original implementations.

5. **Good test structure**: The new `read-only-context.test.ts` uses proper patterns (temp directory isolation, `beforeEach`/`afterEach` cleanup, Result unwrapping).

6. **Smart recovery optimization**: The `skipRecovery` flag for CLI commands is correct (short-lived processes should not trigger recovery).

---

## Action Plan Before Merge

**BLOCKING (Must Fix)**:
1. Fix DIP violation: Remove concrete `Database` from `ReadOnlyContext` interface or narrow to `Closeable` interface
2. Add database cleanup: Call `ctx.database.close()` in `finally` blocks before `process.exit()`
3. Fix stale tests: Update existing CLI tests to exercise actual refactored code paths, or add new integration tests
4. Fix type-only imports: Add `type` keyword to interface imports in `read-only-context.ts`
5. Remove unused import: Delete `ReadOnlyContext` from test file imports

**RECOMMENDED (High Priority)**:
6. Add `statusEnum` validation in `scheduleList`
7. Consider extracting error-handling helpers for boilerplate reduction
8. Switch to `findAll()` with limit for task listing

**FOLLOW-UP (Can Be Future PR)**:
- Move `OutputRepository` to `src/core/interfaces.ts`
- Split `schedule.ts` into per-function files
- Refactor `scheduleCreate` function
- Consider `BootstrapOptions` mode enum pattern

---

## Summary

This PR is a **good performance improvement with sound architecture**, but requires **three blocking fixes** related to design principles (DIP), resource cleanup, and test coverage before merge. The fixes are straightforward and do not require rearchitecting the solution.

**Estimated effort to address all blocking issues**: ~2-3 hours (DIP refactor, cleanup calls, test updates).

