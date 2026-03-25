/**
 * Git state capture, branch management, and commit utilities
 * ARCHITECTURE: Pure functions returning Result, uses execFile for security (no shell injection)
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { BackbeatError, ErrorCode } from '../core/errors.js';
import { err, ok, Result } from '../core/result.js';

const execFileAsync = promisify(execFile);

/** Timeout for all git operations — prevents hung git from blocking the event loop */
const GIT_TIMEOUT_MS = 30_000;

/** Detect execFile timeout: Node sets `killed = true` when a child process is terminated by timeout */
function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && 'killed' in error && (error as { killed?: boolean }).killed === true;
}

/**
 * Validate a git ref name (branch or tag) to prevent argument injection.
 * Rejects names that could be interpreted as git flags or contain unsafe patterns.
 * Based on git-check-ref-format rules plus argument injection prevention.
 *
 * @returns Result<void> - ok if valid, err with descriptive message if invalid
 */
export function validateGitRefName(name: string, label = 'branch'): Result<void, BackbeatError> {
  if (!name || name.trim().length === 0) {
    return err(new BackbeatError(ErrorCode.INVALID_INPUT, `Git ${label} name must not be empty`));
  }

  // Prevent argument injection: names starting with '-' are interpreted as git flags
  if (name.startsWith('-')) {
    return err(new BackbeatError(ErrorCode.INVALID_INPUT, `Git ${label} name must not start with '-': ${name}`));
  }

  // git-check-ref-format disallows '..' (directory traversal)
  if (name.includes('..')) {
    return err(new BackbeatError(ErrorCode.INVALID_INPUT, `Git ${label} name must not contain '..': ${name}`));
  }

  // Reject control characters (ASCII 0x00-0x1F and 0x7F)
  if (/[\x00-\x1f\x7f]/.test(name)) {
    return err(
      new BackbeatError(ErrorCode.INVALID_INPUT, `Git ${label} name must not contain control characters: ${name}`),
    );
  }

  // git-check-ref-format disallows space, tilde, caret, colon, backslash
  if (/[\s~^:\\]/.test(name)) {
    return err(
      new BackbeatError(
        ErrorCode.INVALID_INPUT,
        `Git ${label} name contains invalid characters (space, ~, ^, :, or \\): ${name}`,
      ),
    );
  }

  // git-check-ref-format disallows '@{' (reflog syntax)
  if (name.includes('@{')) {
    return err(new BackbeatError(ErrorCode.INVALID_INPUT, `Git ${label} name must not contain '@{': ${name}`));
  }

  // git-check-ref-format disallows trailing '.'
  if (name.endsWith('.')) {
    return err(new BackbeatError(ErrorCode.INVALID_INPUT, `Git ${label} name must not end with '.': ${name}`));
  }

  // git-check-ref-format disallows '.lock' suffix
  if (name.endsWith('.lock')) {
    return err(new BackbeatError(ErrorCode.INVALID_INPUT, `Git ${label} name must not end with '.lock': ${name}`));
  }

  // git-check-ref-format disallows glob characters ?, *, [
  if (/[?*\[]/.test(name)) {
    return err(
      new BackbeatError(ErrorCode.INVALID_INPUT, `Git ${label} name contains glob characters (?, *, or [): ${name}`),
    );
  }

  // git-check-ref-format disallows consecutive slashes '//'
  if (name.includes('//')) {
    return err(
      new BackbeatError(ErrorCode.INVALID_INPUT, `Git ${label} name must not contain consecutive slashes: ${name}`),
    );
  }

  // git-check-ref-format disallows path components starting with '.'
  const components = name.split('/');
  for (const component of components) {
    if (component.startsWith('.')) {
      return err(
        new BackbeatError(
          ErrorCode.INVALID_INPUT,
          `Git ${label} name must not have path components starting with '.': ${name}`,
        ),
      );
    }
  }

  return ok(undefined);
}

export interface GitState {
  readonly branch: string;
  readonly commitSha: string;
  readonly dirtyFiles: readonly string[];
}

/**
 * Capture current git state for a working directory
 * Returns null if the directory is not a git repository (not an error)
 * Uses execFile (not exec) to prevent shell injection
 *
 * @param workingDirectory - Absolute path to the working directory
 * @returns GitState if in a git repo, null if not, or error on unexpected failure
 */
export async function captureGitState(workingDirectory: string): Promise<Result<GitState | null, BackbeatError>> {
  try {
    const execOpts = { cwd: workingDirectory, timeout: GIT_TIMEOUT_MS };

    // Check if this is a git directory by getting the branch
    let branch: string;
    try {
      const branchResult = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], execOpts);
      branch = branchResult.stdout.trim();
    } catch (catchError) {
      if (isTimeoutError(catchError)) throw catchError;
      // Not a git directory or git not available - not an error
      return ok(null);
    }

    // Get commit SHA
    let commitSha: string;
    try {
      const shaResult = await execFileAsync('git', ['rev-parse', 'HEAD'], execOpts);
      commitSha = shaResult.stdout.trim();
    } catch (catchError) {
      if (isTimeoutError(catchError)) throw catchError;
      // HEAD might not exist (empty repo) - not an error
      return ok(null);
    }

    // Get dirty files from git status
    let dirtyFiles: readonly string[] = [];
    try {
      const statusResult = await execFileAsync('git', ['status', '--porcelain'], execOpts);
      if (statusResult.stdout.trim()) {
        dirtyFiles = statusResult.stdout
          .split('\n')
          .filter((line) => line.length > 0)
          .map((line) => line.substring(3).trim()); // Remove status prefix (e.g., " M ", "?? ")
      }
    } catch (catchError) {
      if (isTimeoutError(catchError)) throw catchError;
      // Status failed - continue with empty dirty files
      dirtyFiles = [];
    }

    return ok({ branch, commitSha, dirtyFiles });
  } catch (error) {
    return err(
      new BackbeatError(
        ErrorCode.SYSTEM_ERROR,
        `Failed to capture git state: ${error instanceof Error ? error.message : String(error)}`,
        { workingDirectory },
      ),
    );
  }
}

/**
 * Create and checkout a git branch
 * Uses `git checkout -B` (force create/reset) for crash recovery safety —
 * if the branch already exists from a prior crashed iteration, it is reset
 * rather than failing.
 *
 * @param workingDirectory - Absolute path to the working directory
 * @param branchName - Name of the branch to create/checkout
 * @param fromRef - Optional ref to branch from (e.g., 'main'). If omitted, branches from current HEAD.
 * @returns Result<void> on success, error on failure
 */
export async function createAndCheckoutBranch(
  workingDirectory: string,
  branchName: string,
  fromRef?: string,
): Promise<Result<void, BackbeatError>> {
  const nameValidation = validateGitRefName(branchName, 'branch');
  if (!nameValidation.ok) return nameValidation;

  if (fromRef) {
    const refValidation = validateGitRefName(fromRef, 'ref');
    if (!refValidation.ok) return refValidation;
  }

  try {
    // Use '--' separator to prevent branch names from being interpreted as flags
    const args = fromRef ? ['checkout', '-B', branchName, fromRef, '--'] : ['checkout', '-B', branchName, '--'];

    await execFileAsync('git', args, { cwd: workingDirectory, timeout: GIT_TIMEOUT_MS });
    return ok(undefined);
  } catch (error) {
    return err(
      new BackbeatError(
        ErrorCode.SYSTEM_ERROR,
        `Failed to create/checkout branch '${branchName}': ${error instanceof Error ? error.message : String(error)}`,
        { workingDirectory, branchName, fromRef },
      ),
    );
  }
}

/**
 * Capture git diff summary between two refs (branch names or commit SHAs)
 * Returns the `git diff --stat` output as a summary string, or null if there are no changes.
 * Uses execFile (not exec) to prevent shell injection.
 *
 * @param workingDirectory - Absolute path to the working directory
 * @param fromRef - Base branch name or commit SHA for comparison
 * @param toRef - Target branch name or commit SHA for comparison
 * @returns Result containing diff summary string or null if no changes
 */
export async function captureGitDiff(
  workingDirectory: string,
  fromRef: string,
  toRef: string,
): Promise<Result<string | null, BackbeatError>> {
  const fromValidation = validateGitRefName(fromRef, 'ref');
  if (!fromValidation.ok) return fromValidation;

  const toValidation = validateGitRefName(toRef, 'ref');
  if (!toValidation.ok) return toValidation;

  try {
    // '--' separator prevents ref names from being interpreted as flags
    const diffResult = await execFileAsync('git', ['diff', '--stat', `${fromRef}..${toRef}`, '--'], {
      cwd: workingDirectory,
      timeout: GIT_TIMEOUT_MS,
    });

    const summary = diffResult.stdout.trim();
    if (!summary) {
      return ok(null);
    }

    return ok(summary);
  } catch (error) {
    return err(
      new BackbeatError(
        ErrorCode.SYSTEM_ERROR,
        `Failed to capture git diff (${fromRef}..${toRef}): ${error instanceof Error ? error.message : String(error)}`,
        { workingDirectory, fromRef, toRef },
      ),
    );
  }
}

/**
 * Get the current HEAD commit SHA
 * Returns the full 40-character hex SHA of the current HEAD commit.
 *
 * @param workingDirectory - Absolute path to the working directory
 * @returns Result containing the 40-char hex SHA, or error on failure
 */
export async function getCurrentCommitSha(workingDirectory: string): Promise<Result<string, BackbeatError>> {
  try {
    const result = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: workingDirectory,
      timeout: GIT_TIMEOUT_MS,
    });
    return ok(result.stdout.trim());
  } catch (error) {
    return err(
      new BackbeatError(
        ErrorCode.SYSTEM_ERROR,
        `Failed to get current commit SHA: ${error instanceof Error ? error.message : String(error)}`,
        { workingDirectory },
      ),
    );
  }
}

export interface LoopGitContext {
  readonly gitBaseBranch?: string;
  readonly gitStartCommitSha?: string;
}

/**
 * Capture git context for loop creation (shared by LoopManager and ScheduleHandler)
 *
 * Calls captureGitState once and reuses its commitSha as gitStartCommitSha,
 * avoiding a redundant `git rev-parse HEAD` call.
 *
 * gitBaseBranch is populated only when a gitBranch is provided in the request.
 *
 * @param workingDirectory - Absolute path to the working directory
 * @param gitBranch - Optional git branch from the loop/schedule request
 * @returns LoopGitContext with resolved fields (both undefined when not in a git repo)
 */
export async function captureLoopGitContext(
  workingDirectory: string,
  gitBranch?: string,
): Promise<Result<LoopGitContext, BackbeatError>> {
  const gitStateResult = await captureGitState(workingDirectory);
  if (!gitStateResult.ok) {
    return gitStateResult;
  }

  if (!gitStateResult.value) {
    // Not a git repo — both fields remain undefined
    return ok({});
  }

  return ok({
    gitBaseBranch: gitBranch ? gitStateResult.value.branch : undefined,
    gitStartCommitSha: gitStateResult.value.commitSha,
  });
}

/**
 * Stage all changes and create a commit
 * Runs `git add -A`, checks if anything is staged, and commits if so.
 * Returns the commit SHA on success, or null if nothing to commit
 * (e.g., the agent already committed everything).
 *
 * @param workingDirectory - Absolute path to the working directory
 * @param message - Commit message
 * @returns Result containing commit SHA (string) or null if nothing to commit
 */
export async function commitAllChanges(
  workingDirectory: string,
  message: string,
): Promise<Result<string | null, BackbeatError>> {
  try {
    const execOpts = { cwd: workingDirectory, timeout: GIT_TIMEOUT_MS };

    // Stage all changes
    await execFileAsync('git', ['add', '-A', '--'], execOpts);

    // Check if anything is staged — exit code 0 means nothing staged
    try {
      await execFileAsync('git', ['diff', '--cached', '--quiet'], execOpts);
      // Exit code 0 = nothing staged = nothing to commit
      return ok(null);
    } catch {
      // Non-zero exit = there are staged changes = proceed to commit
    }

    // Commit with the provided message — use '--' to prevent message interpretation
    await execFileAsync('git', ['commit', '-m', message, '--'], execOpts);

    // Get the SHA of the new commit
    const shaResult = await execFileAsync('git', ['rev-parse', 'HEAD'], execOpts);
    return ok(shaResult.stdout.trim());
  } catch (error) {
    return err(
      new BackbeatError(
        ErrorCode.SYSTEM_ERROR,
        `Failed to commit changes: ${error instanceof Error ? error.message : String(error)}`,
        { workingDirectory },
      ),
    );
  }
}

/**
 * Validate a commit SHA format for safe use in git commands.
 * Accepts 7-40 hex characters, rejects patterns that could be used for injection.
 *
 * @returns true if valid, false otherwise
 */
function isValidCommitSha(sha: string): boolean {
  if (!sha || sha.length < 7 || sha.length > 40) return false;
  if (sha.startsWith('-')) return false;
  if (sha.includes('..')) return false;
  return /^[0-9a-f]+$/.test(sha);
}

/**
 * Hard-reset the working directory to a specific commit SHA
 * Runs `git reset --hard <sha>` followed by `git clean -fd` to also remove
 * untracked files created by agents.
 *
 * CRITICAL: `git clean -fd` is needed because `git reset --hard` alone does NOT
 * remove untracked files that were created after the target commit.
 *
 * @param workingDirectory - Absolute path to the working directory
 * @param commitSha - Hex SHA (7-40 chars) to reset to
 * @returns Result<void> on success, error on failure or invalid SHA
 */
export async function resetToCommit(workingDirectory: string, commitSha: string): Promise<Result<void, BackbeatError>> {
  if (!isValidCommitSha(commitSha)) {
    return err(
      new BackbeatError(
        ErrorCode.INVALID_INPUT,
        `Invalid commit SHA format: "${commitSha}" — must be 7-40 hex characters, no leading '-', no '..'`,
        { workingDirectory, commitSha },
      ),
    );
  }

  try {
    const execOpts = { cwd: workingDirectory, timeout: GIT_TIMEOUT_MS };

    // Reset tracked files to target commit — '--' prevents SHA from being interpreted as flag
    await execFileAsync('git', ['reset', '--hard', commitSha, '--'], execOpts);

    // Remove untracked files and directories created after the target commit
    await execFileAsync('git', ['clean', '-fd'], execOpts);

    return ok(undefined);
  } catch (error) {
    return err(
      new BackbeatError(
        ErrorCode.SYSTEM_ERROR,
        `Failed to reset to commit ${commitSha}: ${error instanceof Error ? error.message : String(error)}`,
        { workingDirectory, commitSha },
      ),
    );
  }
}
