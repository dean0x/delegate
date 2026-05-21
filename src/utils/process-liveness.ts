/**
 * Process liveness utility.
 *
 * DESIGN DECISION: Extracted from inline lambdas in recovery-manager.ts and
 * use-dashboard-data.ts to eliminate duplication and provide a single, tested
 * definition.  The EPERM case is the key subtlety: the OS rejects the signal
 * because we lack permission to signal the process, which proves the process
 * exists and is alive.
 */

/**
 * Returns true if the process identified by `pid` is alive.
 *
 * Uses `process.kill(pid, 0)` which sends no signal but validates that the
 * target PID exists and is reachable.
 *
 * - Returns `true`  when the process exists and we have permission to signal it.
 * - Returns `true`  on EPERM: process exists but we lack permission (still alive).
 * - Returns `false` on ESRCH: no such process.
 * - Returns `false` on any other error (defensive — treats unknown as dead).
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
