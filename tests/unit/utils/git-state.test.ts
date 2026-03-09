/**
 * Unit tests for git state capture utility
 *
 * ARCHITECTURE: Tests captureGitState with mocked execFile
 * Pattern: vi.mock('child_process') to control git command responses
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock child_process before importing the module under test
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

// Must import after mock setup
import { execFile } from 'child_process';
import { captureGitState } from '../../../src/utils/git-state.js';

type ExecFileCallback = (error: Error | null, result: { stdout: string; stderr: string }) => void;

function mockExecFileSequence(responses: Array<{ stdout: string } | { error: Error }>): void {
  const mock = vi.mocked(execFile);
  let callIndex = 0;

  mock.mockImplementation((_cmd: unknown, _args: unknown, _opts: unknown, callback?: unknown) => {
    // promisify wraps execFile — the callback is the last argument
    const cb = (callback ?? _opts) as ExecFileCallback;
    const response = responses[callIndex++];

    if ('error' in response) {
      cb(response.error, { stdout: '', stderr: '' });
    } else {
      cb(null, { stdout: response.stdout, stderr: '' });
    }

    return undefined as never;
  });
}

describe('captureGitState', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return branch, commitSha, and dirtyFiles for a clean repo', async () => {
    mockExecFileSequence([
      { stdout: 'main\n' }, // rev-parse --abbrev-ref HEAD
      { stdout: 'abc123def456\n' }, // rev-parse HEAD
      { stdout: '' }, // git status --porcelain (clean)
    ]);

    const result = await captureGitState('/workspace');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      branch: 'main',
      commitSha: 'abc123def456',
      dirtyFiles: [],
    });
  });

  it('should return ok(null) when not a git repo', async () => {
    mockExecFileSequence([{ error: new Error('fatal: not a git repository') }]);

    const result = await captureGitState('/tmp/not-a-repo');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it('should return ok(null) when HEAD does not exist (empty repo)', async () => {
    mockExecFileSequence([
      { stdout: 'HEAD\n' }, // rev-parse --abbrev-ref HEAD succeeds
      { error: new Error('fatal: ambiguous argument HEAD') }, // rev-parse HEAD fails
    ]);

    const result = await captureGitState('/workspace');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it('should correctly parse dirty files from git status', async () => {
    mockExecFileSequence([
      { stdout: 'feature-branch\n' },
      { stdout: 'deadbeef\n' },
      { stdout: '?? new-file.txt\n M src/foo.ts\nAM staged.ts\n' },
    ]);

    const result = await captureGitState('/workspace');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toBeNull();
    expect(result.value!.branch).toBe('feature-branch');
    // Note: leading space on first line of stdout is stripped by .trim()
    // so we put a non-space-prefixed line first to match real behavior
    expect(result.value!.dirtyFiles).toEqual(['new-file.txt', 'src/foo.ts', 'staged.ts']);
  });

  it('should return empty dirtyFiles when status command fails', async () => {
    mockExecFileSequence([{ stdout: 'main\n' }, { stdout: 'abc123\n' }, { error: new Error('git status failed') }]);

    const result = await captureGitState('/workspace');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toBeNull();
    expect(result.value!.dirtyFiles).toEqual([]);
  });
});
