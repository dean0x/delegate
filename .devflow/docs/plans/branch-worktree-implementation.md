# Branch-Based Worktree Implementation Plan

## Overview

This plan outlines the implementation of branch-based git worktrees for Delegate, replacing the current detached HEAD approach. The new system will support multiple merge strategies (PR, auto-merge, manual, patch) with PR creation as the default, providing a clear path for integrating task changes back into the codebase.

## Architecture Changes

### Core Concepts

1. **Branch-Based Worktrees**: Every task creates a named branch instead of using detached HEAD
2. **Merge Strategies**: Four ways to handle completed task changes
3. **Flexible Cleanup**: Smart defaults with user override options
4. **Optional Isolation**: Worktrees on by default, but can be disabled for quick tasks

## Implementation Details

### 1. Domain Model Updates

**File**: `src/core/domain.ts`

Add new fields to existing interfaces:

```typescript
// Extend the existing Task interface
export interface Task {
  // ... existing fields ...
  
  // Worktree control (replaces old useWorktree and cleanupWorktree fields)
  useWorktree: boolean;       // default: true (disabled via --no-worktree)
  worktreeCleanup?: 'auto' | 'keep' | 'delete'; // default: 'auto'
  
  // Merge strategy fields (only applies when useWorktree is true)
  mergeStrategy?: 'pr' | 'auto' | 'manual' | 'patch'; // default: 'pr', undefined when no worktree
  branchName?: string;        // default: 'delegate/task-{id}'
  baseBranch?: string;        // default: current branch
  autoCommit: boolean;        // default: true
  pushToRemote: boolean;      // default: true for PR mode
  prTitle?: string;           
  prBody?: string;            
}

// Extend DelegateRequest (remove old useWorktree/cleanupWorktree boolean fields)
export interface DelegateRequest {
  // ... existing fields ...
  
  // Worktree control
  useWorktree?: boolean;      // default: true
  worktreeCleanup?: 'auto' | 'keep' | 'delete'; // default: 'auto'
  
  // Merge strategy fields  
  mergeStrategy?: 'pr' | 'auto' | 'manual' | 'patch';
  branchName?: string;
  baseBranch?: string;
  autoCommit?: boolean;
  pushToRemote?: boolean;
  prTitle?: string;
  prBody?: string;
}
```

### 2. Worktree Manager Service

**File**: `src/services/worktree-manager.ts`

Complete rewrite to support branch-based operations:

```typescript
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { Task, TaskId } from '../core/domain.js';
import { Result, ok, err } from '../core/result.js';
import { Logger } from '../core/interfaces.js';
import { DelegateError, ErrorCode } from '../core/errors.js';

const execAsync = promisify(exec);

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseBranch: string;
}

export interface CompletionResult {
  action: 'pr_created' | 'merged' | 'branch_pushed' | 'patch_created';
  prUrl?: string;
  patchPath?: string;
  branch?: string;
}

export class GitWorktreeManager {
  private readonly baseDir: string;
  private readonly activeWorktrees = new Map<TaskId, WorktreeInfo>();

  constructor(
    private readonly logger: Logger,
    private readonly githubIntegration?: GitHubIntegration,
    baseDir?: string
  ) {
    this.baseDir = baseDir || path.join(process.cwd(), '.worktrees');
    this.ensureBaseDirectory();
  }

  private ensureBaseDirectory(): void {
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  async getCurrentBranch(): Promise<string> {
    const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD');
    return stdout.trim();
  }

  async createWorktree(task: Task): Promise<Result<WorktreeInfo>> {
    const branchName = task.branchName || `delegate/task-${task.id.slice(0, 8)}`;
    const baseBranch = task.baseBranch || await this.getCurrentBranch();
    const worktreePath = path.join(this.baseDir, `task-${task.id}`);

    try {
      // Create worktree with new branch
      await execAsync(`git worktree add -b ${branchName} "${worktreePath}" ${baseBranch}`);
      
      const info: WorktreeInfo = { 
        path: worktreePath, 
        branch: branchName, 
        baseBranch 
      };
      
      this.activeWorktrees.set(task.id, info);
      
      this.logger.info('Created branch-based worktree', {
        taskId: task.id,
        branch: branchName,
        base: baseBranch,
        path: worktreePath
      });
      
      return ok(info);
    } catch (error) {
      return err(new DelegateError(
        ErrorCode.SYSTEM_ERROR,
        `Failed to create worktree: ${error instanceof Error ? error.message : String(error)}`
      ));
    }
  }

  async completeTask(task: Task, info: WorktreeInfo): Promise<Result<CompletionResult>> {
    // Step 1: Check for changes
    const hasChanges = await this.hasUncommittedChanges(info.path);
    
    // Step 2: Commit if needed and requested
    if (hasChanges && task.autoCommit) {
      await this.commitChanges(info, task);
    }

    // Step 3: Execute merge strategy
    if (!task.mergeStrategy || task.mergeStrategy === 'pr') {
      return await this.createPullRequest(task, info);
    } else if (task.mergeStrategy === 'auto') {
      return await this.autoMerge(info);
    } else if (task.mergeStrategy === 'manual') {
      return await this.manualStrategy(info);
    } else if (task.mergeStrategy === 'patch') {
      return await this.createPatch(task, info);
    }

    return err(new DelegateError(
      ErrorCode.INVALID_INPUT,
      `Unknown merge strategy: ${task.mergeStrategy}`
    ));
  }

  private async hasUncommittedChanges(worktreePath: string): Promise<boolean> {
    const { stdout } = await execAsync('git status --porcelain', { cwd: worktreePath });
    return stdout.trim().length > 0;
  }

  private async commitChanges(info: WorktreeInfo, task: Task): Promise<void> {
    const message = `Task ${task.id}: ${task.prompt.slice(0, 50)}

Generated by Delegate task delegation
Task ID: ${task.id}
Branch: ${info.branch}`;

    await execAsync('git add -A', { cwd: info.path });
    await execAsync(`git commit -m "${message}"`, { cwd: info.path });
    
    this.logger.info('Committed changes in worktree', { 
      taskId: task.id, 
      branch: info.branch 
    });
  }

  private async createPullRequest(task: Task, info: WorktreeInfo): Promise<Result<CompletionResult>> {
    try {
      // Push branch to remote
      await execAsync(`git push -u origin ${info.branch}`, { cwd: info.path });
      
      // Create PR using gh CLI
      const title = task.prTitle || `Task ${task.id}: ${task.prompt.slice(0, 50)}`;
      const body = task.prBody || `Automated changes from Delegate task ${task.id}

**Task**: ${task.prompt}
**Branch**: ${info.branch}
**Base**: ${info.baseBranch}`;
      
      const { stdout } = await execAsync(
        `gh pr create --title "${title}" --body "${body}" --base ${info.baseBranch}`,
        { cwd: info.path }
      );
      
      const prUrl = stdout.trim();
      
      this.logger.info('Created pull request', { 
        taskId: task.id, 
        prUrl,
        branch: info.branch 
      });
      
      return ok({ 
        action: 'pr_created', 
        prUrl, 
        branch: info.branch 
      });
    } catch (error) {
      return err(new DelegateError(
        ErrorCode.SYSTEM_ERROR,
        `Failed to create PR: ${error instanceof Error ? error.message : String(error)}`
      ));
    }
  }

  private async autoMerge(info: WorktreeInfo): Promise<Result<CompletionResult>> {
    try {
      // Switch to base branch
      await execAsync(`git checkout ${info.baseBranch}`, { cwd: process.cwd() });
      
      // Attempt merge
      await execAsync(`git merge --no-ff ${info.branch} -m "Auto-merge: ${info.branch}"`, { 
        cwd: process.cwd() 
      });
      
      this.logger.info('Auto-merged branch', { 
        branch: info.branch,
        into: info.baseBranch 
      });
      
      return ok({ 
        action: 'merged', 
        branch: info.branch 
      });
    } catch (error) {
      return err(new DelegateError(
        ErrorCode.SYSTEM_ERROR,
        `Auto-merge failed: ${error instanceof Error ? error.message : String(error)}`
      ));
    }
  }

  private async manualStrategy(info: WorktreeInfo): Promise<Result<CompletionResult>> {
    // For manual strategy: push branch and leave for human review
    return await this.pushBranch(info);
  }

  private async pushBranch(info: WorktreeInfo): Promise<Result<CompletionResult>> {
    try {
      await execAsync(`git push -u origin ${info.branch}`, { cwd: info.path });
      
      this.logger.info('Pushed branch for manual review', { 
        branch: info.branch 
      });
      
      return ok({ 
        action: 'branch_pushed', 
        branch: info.branch 
      });
    } catch (error) {
      return err(new DelegateError(
        ErrorCode.SYSTEM_ERROR,
        `Failed to push branch: ${error instanceof Error ? error.message : String(error)}`
      ));
    }
  }

  private async createPatch(task: Task, info: WorktreeInfo): Promise<Result<CompletionResult>> {
    try {
      const patchDir = path.join(process.cwd(), '.delegate-patches');
      if (!fs.existsSync(patchDir)) {
        fs.mkdirSync(patchDir, { recursive: true });
      }
      
      const patchFile = path.join(patchDir, `task-${task.id}.patch`);
      
      // Create patch from all commits on this branch
      await execAsync(
        `git format-patch ${info.baseBranch}..HEAD --stdout > "${patchFile}"`,
        { cwd: info.path }
      );
      
      this.logger.info('Created patch file', { 
        taskId: task.id,
        patchPath: patchFile 
      });
      
      return ok({ 
        action: 'patch_created', 
        patchPath: patchFile 
      });
    } catch (error) {
      return err(new DelegateError(
        ErrorCode.SYSTEM_ERROR,
        `Failed to create patch: ${error instanceof Error ? error.message : String(error)}`
      ));
    }
  }

  async removeWorktree(taskId: TaskId): Promise<Result<void>> {
    const info = this.activeWorktrees.get(taskId);
    if (!info) {
      return ok(undefined); // Already removed
    }

    try {
      await execAsync(`git worktree remove "${info.path}" --force`);
      this.activeWorktrees.delete(taskId);
      
      this.logger.info('Removed worktree', { 
        taskId,
        path: info.path 
      });
      
      return ok(undefined);
    } catch (error) {
      // Fallback to direct removal
      await execAsync(`rm -rf "${info.path}"`);
      await execAsync('git worktree prune');
      this.activeWorktrees.delete(taskId);
      
      return ok(undefined);
    }
  }
}
```

### 3. GitHub Integration Service

**New File**: `src/services/github-integration.ts`

```typescript
import { exec } from 'child_process';
import { promisify } from 'util';
import { Result, ok, err } from '../core/result.js';
import { Logger } from '../core/interfaces.js';

const execAsync = promisify(exec);

export interface PROptions {
  title: string;
  body: string;
  baseBranch: string;
  cwd: string;
  draft?: boolean;
  labels?: string[];
}

export interface PRStatus {
  state: 'open' | 'closed' | 'merged';
  mergeable: boolean;
  url: string;
}

export class GitHubIntegration {
  constructor(private readonly logger: Logger) {}

  async isAvailable(): Promise<boolean> {
    try {
      await execAsync('gh --version');
      return true;
    } catch {
      this.logger.warn('GitHub CLI not available - PR strategy will not work');
      return false;
    }
  }

  async createPR(options: PROptions): Promise<Result<string>> {
    const available = await this.isAvailable();
    if (!available) {
      return err(new Error('GitHub CLI not available'));
    }

    try {
      const args = [
        'pr', 'create',
        '--title', `"${options.title}"`,
        '--body', `"${options.body}"`,
        '--base', options.baseBranch
      ];

      if (options.draft) args.push('--draft');
      if (options.labels?.length) {
        args.push('--label', options.labels.join(','));
      }

      const { stdout } = await execAsync(`gh ${args.join(' ')}`, { 
        cwd: options.cwd 
      });
      
      return ok(stdout.trim());
    } catch (error) {
      return err(error as Error);
    }
  }
}
```

### 4. Worker Pool Updates

**File**: `src/implementations/event-driven-worker-pool.ts`

Update the existing worker pool to handle both worktree and non-worktree modes:

```typescript
// Add to WorkerState interface
interface WorkerState extends Worker {
  // ... existing fields ...
  worktreeInfo?: WorktreeInfo; // Optional, only if worktree used
}

// Update spawnWorker method
async spawnWorker(task: Task): Promise<Result<Worker>> {
  let workingDirectory: string;
  let worktreeInfo: WorktreeInfo | undefined;

  if (task.useWorktree) {
    // Create worktree with branch
    const worktreeResult = await this.worktreeManager.createWorktree(task);
    if (!worktreeResult.ok) {
      return err(worktreeResult.error);
    }
    
    worktreeInfo = worktreeResult.value;
    workingDirectory = worktreeInfo.path;
    
    this.logger.info('Using worktree for task', {
      taskId: task.id,
      branch: worktreeInfo.branch,
      path: worktreeInfo.path
    });
  } else {
    // Direct execution without worktree
    workingDirectory = task.workingDirectory || process.cwd();
    
    this.logger.warn('Task executing without worktree isolation', {
      taskId: task.id,
      directory: workingDirectory
    });
  }

  // Spawn process in determined directory
  const spawnResult = this.spawner.spawn(task.prompt, workingDirectory);
  if (!spawnResult.ok) {
    // Clean up worktree if spawn failed
    if (worktreeInfo) {
      await this.worktreeManager.removeWorktree(task.id);
    }
    return err(spawnResult.error);
  }

  // Create worker with optional worktree info
  const worker: WorkerState = {
    // ... existing worker fields ...
    worktreeInfo
  };

  this.workers.set(worker.id, worker);
  return ok(worker);
}

// Add new method for handling completion
private async handleWorkerCompletion(taskId: TaskId, exitCode: number) {
  const worker = this.workers.get(taskId);
  if (!worker) return;

  const task = worker.task;
  let mergeResult: CompletionResult | undefined;

  // Handle worktree completion if used
  if (task.useWorktree && worker.worktreeInfo) {
    // Only apply merge strategy if one is defined (it's undefined for --no-worktree)
    if (task.mergeStrategy) {
      const completionResult = await this.worktreeManager.completeTask(
        task, 
        worker.worktreeInfo
      );

      if (completionResult.ok) {
        mergeResult = completionResult.value;
        this.logger.info('Task merge strategy completed', {
          taskId,
          strategy: task.mergeStrategy,
          result: mergeResult
        });
      } else {
        this.logger.error('Merge strategy failed', completionResult.error);
      }
    }

    // Handle cleanup
    await this.handleWorktreeCleanup(task, worker.worktreeInfo);
  }

  // Emit completion event
  this.eventBus.emit('TaskCompleted', {
    task,
    exitCode,
    mergeResult
  });

  // Clean up worker
  this.workers.delete(worker.id);
  this.taskToWorker.delete(task.id);
}

private async handleWorktreeCleanup(task: Task, info: WorktreeInfo) {
  let shouldCleanup = false;

  switch (task.worktreeCleanup) {
    case 'keep':
      shouldCleanup = false;
      break;
    case 'delete':
      shouldCleanup = true;
      break;
    case 'auto':
    default:
      // Auto: cleanup for pr/auto/patch, keep for manual
      shouldCleanup = task.mergeStrategy !== 'manual';
      break;
  }

  if (shouldCleanup) {
    await this.worktreeManager.removeWorktree(task.id);
    this.logger.info('Worktree cleaned up', { taskId: task.id });
  } else {
    this.logger.info('Worktree preserved', {
      taskId: task.id,
      path: info.path,
      branch: info.branch
    });
  }
}
```

### 5. CLI Updates

**File**: `src/cli.ts`

Add new command-line arguments:

```typescript
// Update help text
const delegateHelp = `
Task Commands:
  delegate <prompt> [options]  Delegate a task to Claude Code
    -p, --priority P0|P1|P2      Task priority (default: P2)
    
    Worktree Control:
    --no-worktree                 Run directly without worktree isolation
    --keep-worktree               Always preserve worktree after completion
    --delete-worktree             Always cleanup worktree after completion
    
    Merge Strategy (requires worktree):
    -s, --strategy STRATEGY       Merge strategy: pr|auto|manual|patch (default: pr)
    -b, --branch NAME             Custom branch name
    --base BRANCH                 Base branch (default: current)
    --no-commit                   Don't auto-commit changes
    --pr-title TITLE              PR title (for pr strategy)
    --pr-body BODY                PR description
    
    Execution:
    -w, --working-directory DIR   Working directory for task
    -t, --timeout MS              Task timeout in milliseconds
    -o, --max-output-buffer BYTES Maximum output buffer size
`;

// Parse arguments
function parseDelegateArgs(args: string[]): DelegateOptions {
  const options: DelegateOptions = {
    useWorktree: true,  // Default: use worktree
    worktreeCleanup: 'auto',  // Default: smart cleanup
    mergeStrategy: 'pr',  // Default: create PR
    autoCommit: true,
    pushToRemote: true
  };

  let promptWords: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // Worktree control (new flags replacing old ones)
    if (arg === '--no-worktree') {
      options.useWorktree = false;
      options.mergeStrategy = undefined; // Merge strategies don't apply without worktree
    } else if (arg === '--keep-worktree') {
      options.worktreeCleanup = 'keep';
    } else if (arg === '--delete-worktree') {
      options.worktreeCleanup = 'delete';
    }
    // Merge strategy
    else if (arg === '--strategy' || arg === '-s') {
      const strategy = args[++i];
      if (['pr', 'auto', 'manual', 'patch'].includes(strategy)) {
        options.mergeStrategy = strategy as any;
      } else {
        console.error(`❌ Invalid strategy: ${strategy}`);
        process.exit(1);
      }
    }
    // Branch options
    else if (arg === '--branch' || arg === '-b') {
      options.branchName = args[++i];
    } else if (arg === '--base') {
      options.baseBranch = args[++i];
    }
    // PR options
    else if (arg === '--pr-title') {
      options.prTitle = args[++i];
    } else if (arg === '--pr-body') {
      options.prBody = args[++i];
    }
    // Other options
    else if (arg === '--no-commit') {
      options.autoCommit = false;
    }
    // ... existing argument parsing ...
    else {
      promptWords.push(arg);
    }
  }

  options.prompt = promptWords.join(' ');
  return options;
}
```

### 6. MCP Adapter Updates

**File**: `src/adapters/mcp-adapter.ts`

Update the DelegateTask tool schema (Note: MCP tools don't have CLI-style flags, they use explicit parameters):

```typescript
{
  name: 'DelegateTask',
  description: 'Delegate a task to a background Claude Code instance',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'The task for Claude Code to execute',
      },
      priority: {
        type: 'string',
        enum: ['P0', 'P1', 'P2'],
        default: 'P2',
      },
      // Worktree control (replaces old boolean useWorktree/cleanupWorktree)
      useWorktree: {
        type: 'boolean',
        description: 'Use git worktree for isolation (default: true)',
        default: true,
      },
      worktreeCleanup: {
        type: 'string',
        enum: ['auto', 'keep', 'delete'],
        description: 'Cleanup behavior: auto (based on strategy), keep, or delete',
        default: 'auto',
      },
      // Merge strategy (only applies when useWorktree is true)
      mergeStrategy: {
        type: 'string',
        enum: ['pr', 'auto', 'manual', 'patch'],
        description: 'How to handle changes after task completion (requires worktree)',
        default: 'pr',
      },
      branchName: {
        type: 'string',
        description: 'Custom branch name (default: delegate/task-{id})',
      },
      baseBranch: {
        type: 'string',
        description: 'Base branch for worktree (default: current branch)',
      },
      autoCommit: {
        type: 'boolean',
        description: 'Auto-commit changes (default: true)',
        default: true,
      },
      prTitle: {
        type: 'string',
        description: 'PR title for pr strategy',
      },
      prBody: {
        type: 'string',
        description: 'PR description for pr strategy',
      },
      workingDirectory: {
        type: 'string',
        description: 'Working directory (for non-worktree mode)',
      },
      timeout: {
        type: 'number',
        description: 'Task timeout in milliseconds',
      },
    },
    required: ['prompt'],
  },
}
```

### 7. Bootstrap Updates

**File**: `src/bootstrap.ts`

Register the new GitHub integration service:

```typescript
// Add import
import { GitHubIntegration } from './services/github-integration.js';

// Register GitHub integration
container.registerSingleton('githubIntegration', () => {
  const github = new GitHubIntegration(
    getFromContainer<Logger>(container, 'logger').child({ module: 'GitHub' })
  );
  
  // Check availability but don't fail
  github.isAvailable().then(available => {
    if (!available) {
      logger.warn('GitHub CLI not available - PR merge strategy disabled');
    }
  });
  
  return github;
});

// Update worktree manager registration
container.registerSingleton('worktreeManager', () => {
  return new GitWorktreeManager(
    getFromContainer<Logger>(container, 'logger').child({ module: 'WorktreeManager' }),
    getFromContainer<GitHubIntegration>(container, 'githubIntegration')
  );
});
```

## Testing Strategy

### Unit Tests
1. Test each merge strategy independently
2. Test worktree creation with branches
3. Test cleanup behavior matrix
4. Test error handling for each strategy

### Integration Tests
1. Full task lifecycle with each merge strategy
2. CLI argument parsing and validation
3. MCP tool invocation with all parameters
4. GitHub CLI integration (with mock)

### Manual Testing Checklist
- [ ] Create task with default settings (PR mode)
- [ ] Create task without worktree (`--no-worktree`)
- [ ] Test each merge strategy
- [ ] Test cleanup overrides (`--keep-worktree`, `--delete-worktree`)
- [ ] Test with custom branch names
- [ ] Test PR creation with custom title/body
- [ ] Test patch generation and application
- [ ] Test auto-merge with and without conflicts

## Cleanup Behavior Matrix

| Merge Strategy | Default Cleanup | --keep-worktree | --delete-worktree |
|---------------|-----------------|-----------------|-------------------|
| `pr`          | Delete          | Keep            | Delete            |
| `auto`        | Delete          | Keep            | Delete            |
| `manual`      | Keep            | Keep            | Delete            |
| `patch`       | Delete          | Keep            | Delete            |
| No worktree   | N/A             | N/A             | N/A               |

## Example Usage

```bash
# Default: PR with worktree
delegate delegate "refactor authentication"

# Quick local check without isolation
delegate delegate "check status" --no-worktree

# Auto-merge with forced cleanup
delegate delegate "update deps" --strategy auto --delete-worktree

# Manual review, preserve worktree
delegate delegate "experimental" --strategy manual --keep-worktree

# Create patch, keep worktree for more work
delegate delegate "optimization" --strategy patch --keep-worktree

# Custom PR with cleanup
delegate delegate "new feature" \
  --branch feature/awesome \
  --pr-title "Add awesome feature" \
  --pr-body "Implements #123" \
  --delete-worktree
```

## Success Criteria

- Branch-based worktrees work correctly
- All four merge strategies function properly
- GitHub CLI integration creates PRs successfully
- Cleanup behavior follows the matrix
- No legacy detached HEAD code remains
- Clear error messages for all failure cases

## Dependencies

- Git (required)
- GitHub CLI (`gh`) - optional, required only for PR strategy
- Node.js 20+
- SQLite (existing dependency)