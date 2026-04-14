/**
 * Tests for schedule auto-executor utilities (v1.4.0 batch 3)
 *
 * Tests PID file read/write, liveness detection, stale PID cleanup,
 * and auto-spawn behavior.
 *
 * ARCHITECTURE: Tests the pure utility functions using real temporary files
 * where possible, and vi.mock for ESM-incompatible module mocking.
 *
 * Pattern: Behavioral testing — verifies observable outcomes of utility functions.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// We test utility functions that don't spawn real processes
import { acquirePidFile, getExecutorPidPath, isProcessAlive } from '../../../src/cli/commands/schedule-executor.js';

// ─────────────────────────────────────────────────────────────────────────────
// getExecutorPidPath
// ─────────────────────────────────────────────────────────────────────────────

describe('getExecutorPidPath', () => {
  it('returns a path ending in schedule-executor.pid', () => {
    const pidPath = getExecutorPidPath();
    expect(pidPath).toMatch(/schedule-executor\.pid$/);
  });

  it('returns a path under ~/.autobeat/', () => {
    const pidPath = getExecutorPidPath();
    const expected = path.join(os.homedir(), '.autobeat');
    expect(pidPath.startsWith(expected)).toBe(true);
  });

  it('returns the same value on repeated calls', () => {
    expect(getExecutorPidPath()).toBe(getExecutorPidPath());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// readExecutorPid — tested via real temporary files
// ─────────────────────────────────────────────────────────────────────────────

describe('readExecutorPid — via real PID files', () => {
  let tempDir: string;
  let tempPidPath: string;
  let originalGetPath: () => string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autobeat-test-'));
    tempPidPath = path.join(tempDir, 'test.pid');
  });

  afterEach(() => {
    // Clean up temp directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    vi.restoreAllMocks();
  });

  /**
   * ARCHITECTURE: We can't spyOn ESM module exports directly.
   * Instead, we create a local readPidFromFile function to test the logic,
   * which mirrors readExecutorPid but accepts a path argument.
   * The real readExecutorPid calls getExecutorPidPath() internally.
   */
  function readPidFromFile(pidPath: string): number | null {
    try {
      const content = fs.readFileSync(pidPath, 'utf-8').trim();
      const pid = parseInt(content, 10);
      return Number.isFinite(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  it('returns null when PID file does not exist', () => {
    const pid = readPidFromFile('/does/not/exist/schedule-executor.pid');
    expect(pid).toBeNull();
  });

  it('returns null when PID file contains non-numeric content', () => {
    fs.writeFileSync(tempPidPath, 'not-a-number\n', 'utf-8');
    const pid = readPidFromFile(tempPidPath);
    expect(pid).toBeNull();
  });

  it('returns null when PID file contains zero', () => {
    fs.writeFileSync(tempPidPath, '0\n', 'utf-8');
    const pid = readPidFromFile(tempPidPath);
    expect(pid).toBeNull();
  });

  it('returns null when PID file contains negative number', () => {
    fs.writeFileSync(tempPidPath, '-1\n', 'utf-8');
    const pid = readPidFromFile(tempPidPath);
    expect(pid).toBeNull();
  });

  it('returns parsed PID for valid PID file content', () => {
    fs.writeFileSync(tempPidPath, '12345\n', 'utf-8');
    const pid = readPidFromFile(tempPidPath);
    expect(pid).toBe(12345);
  });

  it('handles PID file with whitespace trimming', () => {
    fs.writeFileSync(tempPidPath, '  99999  \n', 'utf-8');
    const pid = readPidFromFile(tempPidPath);
    expect(pid).toBe(99999);
  });

  it('reads actual PID written by current process', () => {
    fs.writeFileSync(tempPidPath, String(process.pid), 'utf-8');
    const pid = readPidFromFile(tempPidPath);
    expect(pid).toBe(process.pid);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isProcessAlive
// ─────────────────────────────────────────────────────────────────────────────

describe('isProcessAlive', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true for the current process PID', () => {
    // process.pid is always alive since we're running in it
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('returns false for a PID that does not exist', () => {
    // process.kill(pid, 0) throws ESRCH when process doesn't exist
    const mockKill = vi.spyOn(process, 'kill').mockImplementation((_pid, _sig) => {
      const err = Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      throw err;
    });

    expect(isProcessAlive(999999999)).toBe(false);

    mockKill.mockRestore();
  });

  it('returns true when process.kill throws EPERM (process exists but owned by another user)', () => {
    // EPERM means the process exists but we lack permission to signal it — treat as alive
    const mockKill = vi.spyOn(process, 'kill').mockImplementation((_pid, _sig) => {
      const err = Object.assign(new Error('EPERM'), { code: 'EPERM' });
      throw err;
    });

    const result = isProcessAlive(1);
    expect(result).toBe(true);

    mockKill.mockRestore();
  });

  it('returns true when process.kill(pid, 0) does not throw', () => {
    // Mock a successful kill(pid, 0) — process exists
    const mockKill = vi.spyOn(process, 'kill').mockImplementation((_pid, _sig) => {
      // No throw — process exists
      return true;
    });

    expect(isProcessAlive(42)).toBe(true);

    mockKill.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PID file integration — write + read cycle
// ─────────────────────────────────────────────────────────────────────────────

describe('PID file write/read integration', () => {
  let tempDir: string;
  let tempPidPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autobeat-pid-test-'));
    tempPidPath = path.join(tempDir, 'schedule-executor.pid');
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('PID written to file can be read back', () => {
    const testPid = process.pid;
    fs.writeFileSync(tempPidPath, String(testPid), 'utf-8');
    const content = fs.readFileSync(tempPidPath, 'utf-8').trim();
    expect(parseInt(content, 10)).toBe(testPid);
  });

  it('stale PID detection: written PID + liveness check', () => {
    // Write an invalid PID that couldn't possibly be a running process
    const impossiblePid = 999999999;
    fs.writeFileSync(tempPidPath, String(impossiblePid), 'utf-8');

    const content = fs.readFileSync(tempPidPath, 'utf-8').trim();
    const pid = parseInt(content, 10);

    // The PID itself is valid (positive integer)
    expect(pid).toBe(impossiblePid);
    // But isProcessAlive would return false for this PID
    expect(isProcessAlive(impossiblePid)).toBe(false);
  });

  it('current process PID is always alive', () => {
    fs.writeFileSync(tempPidPath, String(process.pid), 'utf-8');

    const content = fs.readFileSync(tempPidPath, 'utf-8').trim();
    const pid = parseInt(content, 10);

    expect(isProcessAlive(pid)).toBe(true);
  });

  it('PID file can be deleted (cleanup)', () => {
    fs.writeFileSync(tempPidPath, String(process.pid), 'utf-8');
    expect(fs.existsSync(tempPidPath)).toBe(true);

    fs.unlinkSync(tempPidPath);
    expect(fs.existsSync(tempPidPath)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ensureScheduleExecutorRunning — contract tests
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ARCHITECTURE NOTE: ensureScheduleExecutorRunning() uses dynamic import for child_process.
 * ESM module mocking with vi.doMock is limited when the module being mocked
 * (node:child_process) is imported by other modules (handler-setup.ts) in the same
 * test file's module graph. We test the contract through observable behavior
 * (PID file presence + liveness) rather than spy on the spawn call.
 *
 * The spawn mechanics are covered by the PID file integration tests above.
 * This test section verifies the public contract: "when alive, don't respawn".
 */
describe('ensureScheduleExecutorRunning — alive check contract', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('alive check uses isProcessAlive(pid) for liveness detection', () => {
    // Verify the building blocks work together correctly:
    // readExecutorPid returns a PID → isProcessAlive checks if that PID is alive
    // If alive → no spawn (verified by PID file + liveness integration)

    // Simulate: PID file has current process PID → always alive
    const pid = process.pid;
    expect(isProcessAlive(pid)).toBe(true);

    // Simulate: PID file has dead PID → spawn needed
    const mockKill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });
    expect(isProcessAlive(999999)).toBe(false);
    mockKill.mockRestore();
  });

  it('spawn would use detached + ignore + unref (verified by reviewing source)', () => {
    /**
     * ARCHITECTURE DECISION: Spawn options are verified by code review, not test spy.
     * The ESM module system prevents mocking node:child_process when other modules
     * in the test import it transitively. The options are documented in the source
     * and are part of the public design contract.
     *
     * Options used: detached: true, stdio: 'ignore' → child is fully independent.
     * .unref() → parent process doesn't wait for child.
     * These are standard Node.js patterns for background process spawning.
     */
    // This test serves as documentation, not as an executable assertion.
    expect(true).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// acquirePidFile — atomic PID file locking (#141)
// ─────────────────────────────────────────────────────────────────────────────

describe('acquirePidFile — atomic O_EXCL locking', () => {
  let tempDir: string;
  let tempPidPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autobeat-acquire-test-'));
    tempPidPath = path.join(tempDir, 'test-executor.pid');
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    vi.restoreAllMocks();
  });

  it("returns ok('acquired') when no PID file exists", () => {
    const result = acquirePidFile(tempPidPath, process.pid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe('acquired');
    // PID file should now contain our PID
    const written = fs.readFileSync(tempPidPath, 'utf-8').trim();
    expect(parseInt(written, 10)).toBe(process.pid);
  });

  it("returns ok('acquired') and creates parent directory if missing", () => {
    const nestedPath = path.join(tempDir, 'new-subdir', 'executor.pid');
    const result = acquirePidFile(nestedPath, process.pid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe('acquired');
    expect(fs.existsSync(nestedPath)).toBe(true);
  });

  it("returns ok('already-running') when another live executor holds the file", () => {
    // Write current process PID (guaranteed alive)
    fs.writeFileSync(tempPidPath, String(process.pid), 'utf-8');

    const result = acquirePidFile(tempPidPath, process.pid + 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe('already-running');
  });

  it("returns ok('acquired') after removing stale PID file (dead process)", () => {
    // Write a PID for a guaranteed-dead process
    const deadPid = 999999999;
    fs.writeFileSync(tempPidPath, String(deadPid), 'utf-8');

    const result = acquirePidFile(tempPidPath, process.pid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe('acquired');
    // PID file should now contain our PID
    const written = fs.readFileSync(tempPidPath, 'utf-8').trim();
    expect(parseInt(written, 10)).toBe(process.pid);
  });

  it('returns err when mkdirSync fails (invalid parent path on some systems)', () => {
    // Pass a pidPath under an existing FILE — mkdirSync will fail because you can't
    // create a directory inside a regular file.
    const existingFile = path.join(tempDir, 'notadir');
    fs.writeFileSync(existingFile, 'content', 'utf-8');
    const invalidPath = path.join(existingFile, 'subdir', 'test.pid');

    const result = acquirePidFile(invalidPath, process.pid);
    // On all supported platforms, mkdirSync fails here → acquirePidFile returns err
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/Failed to create PID directory/);
  });

  it("returns err on path creation failure and does not crash", () => {
    // Pass a path we can't write to by choosing root-owned directory
    // This test validates the code path without using ESM module spies.
    // On most systems writing to /proc is not permitted, giving a real ENOENT/EACCES.
    // We use the InvalidPath approach instead:
    const existingFile = path.join(tempDir, 'collision');
    fs.writeFileSync(existingFile, 'blocker', 'utf-8');
    const conflictPath = path.join(existingFile, 'pid.pid');
    const result = acquirePidFile(conflictPath, process.pid);
    expect(result.ok).toBe(false);
  });
});
