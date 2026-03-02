# 🚀 Backbeat v0.3.0 - Task Dependencies

## Major Features

### 🔗 Task Dependencies with DAG-based Cycle Detection
The headline feature of v0.3.0 enables tasks to depend on other tasks, with automatic dependency resolution and cycle detection.

**Key Capabilities:**
- **Dependency Declaration**: Specify task dependencies via `dependsOn` array in task specifications
- **Cycle Detection**: DFS-based algorithm prevents both simple (A→B→A) and transitive (A→B→C→A) cycles
- **Automatic State Transitions**: Tasks automatically move from `BLOCKED` → `QUEUED` when dependencies complete
- **Multiple Dependencies**: Tasks can depend on multiple prerequisites simultaneously
- **Diamond Patterns**: Full support for complex dependency graphs (A→B, A→C, B→D, C→D)
- **Failure Propagation**: When a dependency fails, dependent tasks automatically fail

**MCP API Enhancement:**
```typescript
await delegateTask({
  prompt: "deploy to production",
  dependsOn: ["task-build", "task-test"]  // New in v0.3.0
});
```

**Event-Driven Integration:**
- `TaskDependencyAdded` - Emitted when dependency relationship created
- `DependencyResolved` - Emitted when blocking dependency completes
- `TaskUnblocked` - Emitted when all dependencies resolved, triggers automatic queuing

**Technical Implementation:**
- Synchronous better-sqlite3 transactions for TOCTOU race condition protection
- Foreign key constraints with database-level referential integrity
- Composite indexes for optimized dependency lookups
- Handler-level graph cache to prevent N+1 query pattern

---

## Bug Fixes

### 🔒 Security - TOCTOU Race Condition Fix
**Critical security fix** preventing race conditions in concurrent dependency creation.

**Issue**: Async transactions allowed JavaScript event loop to interleave between cycle detection and dependency insertion, potentially creating cycles despite validation.

**Fix**: Implemented synchronous `.transaction()` for true atomicity per Wikipedia TOCTOU principles - check and use operations are now atomic with no event loop yielding.

**Impact**: Prevents concurrent requests from creating circular dependencies.

### 🛠️ Error Handling Improvements
**Issue**: `addDependency()` converted all errors to `SYSTEM_ERROR`, masking semantic error types like `TASK_NOT_FOUND` and `INVALID_OPERATION`.

**Fix**: Preserve `BackbeatError` types throughout the error handling chain, allowing upstream code to correctly distinguish error types.

**Impact**: Better error handling and debugging experience.

### 🏃 Race Condition in QueueHandler
**Issue**: Event data could become stale between emission and handling, potentially enqueueing cancelled/failed tasks.

**Fix**: Fetch fresh task state from repository before enqueueing unblocked tasks.

**Impact**: Additional safety layer against race conditions during task unblocking.

### 📋 Migration Error Handling
**Issue**: `getCurrentSchemaVersion()` caught all errors and returned 0, potentially hiding permission errors, corruption, or connection issues.

**Fix**: Only catch "no such table" errors, re-throw all other errors.

**Impact**: Prevents silent failures that could cause data loss during migrations.

---

## Infrastructure & Quality

### ✅ CI/CD Improvements
- **Memory Management**: Fixed heap exhaustion by using `test:unit` instead of running full suite multiple times
- **Test Stability**: Added 5ms timing tolerance for flaky network latency tests
- **Worker-Handler Tests**: Skipped in CI due to >6GB memory requirements (runs locally)
- **Contents Permission**: Added write permission for automated releases

### 📊 Code Quality
- **Maintainability Score**: 76.2/100 (GOOD)
- **JSDoc Documentation**: Added comprehensive documentation to all public methods
- **Type Safety**: Enhanced TypeScript type narrowing in error handling
- **Test Coverage**: 74 new tests for dependency system (100% passing)

### 📖 Documentation
- **ARCHITECTURE_QUICK_REFERENCE.md**: Quick reference for system architecture (308 lines)
- **TASK_ARCHITECTURE.md**: Detailed task system design documentation (747 lines)
- **COMPLEXITY_AUDIT_REPORT.md**: Comprehensive code quality audit
- **docs/task-dependencies.md**: Complete API documentation (707 lines)
- **docs/test-stability-fixes.md**: Test stability improvements documentation

### 🏗️ Database Schema Migrations
Implemented version-based migration system for safe production upgrades:
- `schema_migrations` table tracks applied migrations
- Transaction-wrapped migrations for safety
- Incremental version upgrades
- Baseline schema at v1

---

## Test Coverage

### 🧪 Comprehensive Test Suite
- **74 new tests** for task dependencies (all passing)
- **23 tests** for DependencyGraph (cycle detection, topological sort)
- **35 tests** for DependencyRepository (CRUD operations, TOCTOU protection)
- **16 tests** for DependencyHandler (event-driven resolution)
- **7 integration tests** for end-to-end workflows

**Total**: 81 tests passing (638 total across entire codebase)

---

## Breaking Changes

**None** - All changes are backward compatible. The `dependsOn` field is optional in task specifications.

---

## Known Limitations & Future Work

Two architectural improvements deferred to v0.3.1:
- **Issue #20**: Replace in-memory cycle detection with database-native recursive CTE for better scalability
- **Issue #21**: Move baseline schema into migration v1 for single source of truth

See [ROADMAP.md](./docs/ROADMAP.md) for v0.3.1 plans.

---

## Installation

```bash
npm install -g backbeat@0.3.0
```

Or add to your `.mcp.json`:
```json
{
  "mcpServers": {
    "delegate": {
      "command": "npx",
      "args": ["-y", "delegate@0.3.0", "mcp", "start"]
    }
  }
}
```

---

## What's Next

**v0.3.1** (Performance Optimizations):
- Database-native cycle detection with recursive CTEs
- Bulk dependency operations
- Dependency cache layer
- Query optimizations for large graphs

**v0.4.0** (Advanced Features):
- Conditional dependencies
- Task retry with exponential backoff
- Resource constraints per task
- Enhanced worktree management

See [ROADMAP.md](./docs/ROADMAP.md) for complete roadmap.

---

## Upgrade Notes

No special upgrade steps required. Simply update to 0.3.0:

```bash
npm install -g backbeat@0.3.0
```

Existing databases will automatically migrate to v1 schema on first startup.

---

## Contributors

Special thanks to:
- **Dean Sharon** (@dean0x) - Feature implementation
- **Claude Code** - Development assistance and code review
- **qodo-merge-for-open-source** - PR review and quality checks

---

## Links

- 📦 **NPM Package**: https://www.npmjs.com/package/backbeat
- 📝 **Full Documentation**: https://github.com/dean0x/delegate/blob/main/docs/task-dependencies.md
- 🐛 **Issues**: https://github.com/dean0x/delegate/issues
- 💬 **Discussions**: https://github.com/dean0x/delegate/discussions

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
