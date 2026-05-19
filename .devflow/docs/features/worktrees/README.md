# Worktrees Feature (EXPERIMENTAL)

**Status**: Experimental - Default OFF
**Complexity**: High - requires git worktree knowledge
**User Feedback**: Too complex for most developers

---

## Overview

Worktrees provide **task isolation** by creating separate git worktrees for each delegated task. This enables parallel task execution without branch conflicts, but adds significant complexity.

### Why Default OFF?

Based on user feedback:
- ❌ **Too complicated** - Most developers don't understand git worktrees
- ❌ **Hard to manage** - Conflict resolution across worktrees is confusing
- ❌ **Consolidation issues** - Merging changes from multiple worktrees is non-trivial
- ✅ **Better UX** - Let developers manage their own parallelism

### Current Implementation Status

**Core Functionality**: ✅ Implemented
- Create worktree per task
- Automatic branch creation
- Isolated execution environment
- Worktree cleanup on completion

**Management Tools**: ❌ NOT Implemented (deprioritized)
- ListWorktrees MCP tool
- CleanupWorktrees MCP tool
- WorktreeStatus MCP tool
- CLI commands for worktree management
- Safety validation
- Integration tests

---

## How to Enable (Power Users Only)

### Global Enable
```bash
export USE_WORKTREES_BY_DEFAULT=true
delegate delegate "task"  # Will use worktree
```

### Per-Task Enable
```bash
delegate delegate "task" --use-worktree  # Opt-in for this task only
```

---

## Architecture

### Components Involved
- `src/services/worktree-manager.ts` - Core worktree management
- `src/services/task-manager.ts` - Task execution with worktree support
- `src/core/interfaces.ts` - WorktreeManager interface
- `src/implementations/event-driven-worker-pool.ts` - Worker isolation

### How It Works
1. Task delegated with `useWorktree: true`
2. WorktreeManager creates new worktree at `.worktrees/<task-id>`
3. Worker executes in isolated worktree
4. On completion, worktree can be cleaned up or preserved
5. Changes can be merged back to main branch

---

## Deferred Tasks (Future Consideration)

These tasks were planned but deprioritized due to complexity concerns:

### 1. ListWorktrees MCP Tool
**Purpose**: View all active worktrees with stale detection
**Priority**: Low - users can use `git worktree list`
**Effort**: Medium (2-3 hours)

**Proposed Interface**:
```typescript
{
  name: "ListWorktrees",
  description: "List all delegate worktrees with status",
  inputSchema: {
    includeStale: boolean,  // Show worktrees older than N days
    olderThanDays: number   // Age threshold
  }
}
```

### 2. CleanupWorktrees MCP Tool
**Purpose**: Safely remove old/stale worktrees
**Priority**: Medium - 129+ stale worktrees exist in wild
**Effort**: High (4-5 hours)

**Proposed Interface**:
```typescript
{
  name: "CleanupWorktrees",
  description: "Clean up old worktrees safely",
  inputSchema: {
    strategy: "safe" | "interactive" | "force",
    olderThanDays: number,
    taskIds: string[]  // Specific worktrees to remove
  }
}
```

**Safety Checks**:
- Never remove worktree with uncommitted changes
- Never remove worktree for active task
- Warn if worktree has unpushed commits
- Require confirmation for force mode

### 3. WorktreeStatus MCP Tool
**Purpose**: Get detailed status of specific worktree
**Priority**: Low - niche use case
**Effort**: Low (1-2 hours)

**Proposed Interface**:
```typescript
{
  name: "WorktreeStatus",
  description: "Get detailed worktree information",
  inputSchema: {
    taskId: string
  }
}
```

**Response**:
```typescript
{
  taskId: string,
  path: string,
  branch: string,
  ageInDays: number,
  hasUncommittedChanges: boolean,
  hasUnpushedCommits: boolean,
  diskUsage: number,
  lastModified: string
}
```

### 4. TaskStatus Enhancement
**Purpose**: Include worktree info in task status
**Priority**: Low - only useful if worktrees enabled
**Effort**: Low (1 hour)

**Changes**:
```typescript
interface TaskStatus {
  // ... existing fields
  worktree?: {
    path: string,
    branch: string,
    active: boolean
  }
}
```

### 5. CLI Commands
**Purpose**: Command-line worktree management
**Priority**: Low - advanced users can use git directly
**Effort**: Medium (3-4 hours)

**Proposed Commands**:
```bash
delegate worktree list              # List all worktrees
delegate worktree cleanup --safe    # Safe cleanup
delegate worktree status <task-id>  # Get worktree status
```

### 6. Worktree Safety Validation
**Purpose**: Prevent unsafe deletions
**Priority**: Medium - data loss prevention
**Effort**: Medium (2-3 hours)

**Checks**:
- Validate worktree not active before removal
- Check for uncommitted changes
- Check for unpushed commits
- Verify disk space before creation

### 7. Integration Tests
**Purpose**: Test worktree lifecycle
**Priority**: Low - feature is experimental
**Effort**: High (4-5 hours)

**Test Coverage**:
- Create/delete worktree lifecycle
- Parallel task execution in separate worktrees
- Conflict handling
- Cleanup strategies
- Error scenarios

### 8. Documentation Updates
**Purpose**: User guide for worktrees
**Priority**: Low - feature discouraged for most users
**Effort**: Medium (2-3 hours)

**Content**:
- When to use worktrees
- How to enable
- Troubleshooting guide
- Migration from non-worktree mode

---

## Migration Guide

### From Worktree Mode to Simple Mode

If you have existing worktrees:

1. **List existing worktrees**:
   ```bash
   git worktree list
   ```

2. **For each worktree, decide**:
   - **Keep changes**: Commit and merge to main
   - **Discard changes**: Remove worktree

3. **Commit important changes**:
   ```bash
   cd .worktrees/<task-id>
   git add .
   git commit -m "Preserve work from task <task-id>"
   git push origin <branch-name>
   ```

4. **Remove worktree**:
   ```bash
   git worktree remove .worktrees/<task-id>
   ```

5. **Disable worktrees**:
   ```bash
   unset USE_WORKTREES_BY_DEFAULT  # Remove env var
   ```

### From Simple Mode to Worktree Mode

If you want to opt-in:

1. **Ensure working directory clean**:
   ```bash
   git status  # Should be clean
   ```

2. **Enable worktrees**:
   ```bash
   export USE_WORKTREES_BY_DEFAULT=true
   ```

3. **Delegate tasks**:
   ```bash
   delegate delegate "task"  # Will use worktree
   ```

---

## Known Issues

### Issue: Stale Worktrees Accumulate
**Symptom**: `.worktrees/` directory grows large
**Impact**: Disk space usage
**Workaround**: Manual cleanup with `git worktree remove`
**Fix**: Implement CleanupWorktrees tool (deferred)

### Issue: Merge Conflicts Across Worktrees
**Symptom**: Tasks modify same files, conflicts on merge
**Impact**: Manual conflict resolution required
**Workaround**: Coordinate tasks manually, avoid concurrent edits
**Fix**: Better conflict detection (not planned)

### Issue: Confusing for Beginners
**Symptom**: Users don't understand worktree concept
**Impact**: Cognitive load, support burden
**Workaround**: Default OFF, power users only
**Fix**: Better documentation (deferred)

---

## Design Decisions

### Why Not Remove Entirely?

Worktrees solve real problems for power users:
- **Parallel execution**: Run multiple tasks safely
- **Isolation**: Task failures don't contaminate main workspace
- **Branch management**: Automatic branch per task

### Why Default OFF?

User feedback showed:
- 95% of users don't need parallelism
- Worktree complexity outweighs benefits
- Simple mode is easier to reason about
- Better UX: let developers manage their own workflow

### Future Consideration

If user demand increases:
- Re-evaluate default setting
- Implement management tools
- Improve documentation
- Add integration tests

---

## Technical Details

### Worktree Directory Structure
```
.worktrees/
├── task-abc123/           # Worktree for task abc123
│   ├── .git              # Git directory link
│   └── ...               # Task files
├── task-def456/           # Worktree for task def456
│   ├── .git
│   └── ...
```

### Branch Naming Convention
- Format: `delegate-task-<task-id>`
- Example: `delegate-task-abc123def456`
- Auto-created, auto-cleaned (if configured)

### Configuration Options
```typescript
{
  useWorktreesByDefault: false,        // Enable worktrees globally
  maxWorktreeAgeDays: 30,              // Cleanup threshold
  maxWorktrees: 50,                    // Maximum concurrent worktrees
  worktreeRequireSafetyCheck: true     // Require safety validation
}
```

### Environment Variables
```bash
USE_WORKTREES_BY_DEFAULT=true        # Enable globally
WORKTREE_MAX_AGE_DAYS=30             # Cleanup age threshold
WORKTREE_MAX_COUNT=50                # Maximum worktrees
WORKTREE_REQUIRE_SAFETY_CHECK=true   # Safety checks
```

---

## References

- [Git Worktree Documentation](https://git-scm.com/docs/git-worktree)
- [Original Feature Request](../../plans/worktree-management.md) (if exists)
- [User Feedback Thread](#) (internal discussion)

---

**Last Updated**: 30-09-2025
**Status**: Experimental, default OFF
**Next Review**: When user demand increases or v1.0.0 release
