/**
 * Schedule auto-executor background process
 *
 * ARCHITECTURE: Hidden internal subcommand `beat schedule executor`.
 * Why: Schedule execution requires a running server process (bootstrap in 'server' mode).
 * Rather than requiring users to manually start an executor, we auto-spawn it on
 * schedule create/resume. This keeps the user-facing API clean.
 *
 * DECISION: Auto-spawn executor on create + resume.
 * Why: user shouldn't need to know about background processes. PID file race is benign —
 * per-schedule dedup in ScheduleExecutor prevents double execution even if two executors
 * start simultaneously.
 *
 * DECISION: PID file at ~/.autobeat/schedule-executor.pid.
 * Why: single global PID file per user eliminates the need for schedule-specific tracking.
 * One executor handles all active schedules.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bootstrap } from '../../bootstrap.js';
import { ScheduleStatus } from '../../core/domain.js';
import type { ScheduleRepository } from '../../core/interfaces.js';
import type { Result } from '../../core/result.js';
import { err, ok } from '../../core/result.js';

/** Path to the PID file for the background executor process */
export function getExecutorPidPath(): string {
  const dir = path.join(os.homedir(), '.autobeat');
  return path.join(dir, 'schedule-executor.pid');
}

/**
 * Read PID from the PID file. Returns null if file doesn't exist or is invalid.
 * @param pidPath Optional explicit path — defaults to getExecutorPidPath()
 */
export function readExecutorPid(pidPath?: string): number | null {
  const resolvedPath = pidPath ?? getExecutorPidPath();
  try {
    const content = fs.readFileSync(resolvedPath, 'utf-8').trim();
    const pid = parseInt(content, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Check if a PID corresponds to a running process.
 * EPERM means the process exists but we lack permission — treated as alive.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Atomically acquire the PID file using O_EXCL (create-or-fail).
 *
 * DECISION: Atomic O_EXCL create-or-fail prevents PID file race.
 * Returns sentinel rather than calling process.exit() to keep exit
 * logic at the caller, which is easier to test and audit.
 *
 * Residual TOCTOU: After unlinking a stale PID and before re-opening,
 * a concurrent racing process could create the file. Accepted — extremely
 * unlikely (3+ concurrent racing executors with the same stale PID).
 *
 * @returns ok('acquired') when PID file was created and owned
 * @returns ok('already-running') when another live executor holds the PID file
 * @returns err(Error) on unrecoverable I/O failures
 */
export function acquirePidFile(pidPath: string, pid: number): Result<'acquired' | 'already-running', Error> {
  try {
    fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  } catch (mkdirErr) {
    return err(new Error(`Failed to create PID directory: ${String(mkdirErr)}`));
  }

  try {
    // O_EXCL | O_CREAT — atomic: fails with EEXIST if file already present
    const fd = fs.openSync(pidPath, 'wx');
    fs.writeSync(fd, String(pid));
    fs.closeSync(fd);
    return ok('acquired');
  } catch (e1) {
    const errno = e1 as NodeJS.ErrnoException;
    if (errno.code !== 'EEXIST') {
      return err(new Error(`Failed to acquire PID file: ${String(errno)}`));
    }
    // File exists — check if the owning process is still alive
    const existingPid = readExecutorPid(pidPath);
    if (existingPid !== null && isProcessAlive(existingPid)) {
      return ok('already-running');
    }
    // Stale file — unlink and retry once
    try {
      fs.unlinkSync(pidPath);
      const fd = fs.openSync(pidPath, 'wx');
      fs.writeSync(fd, String(pid));
      fs.closeSync(fd);
      return ok('acquired');
    } catch (e2) {
      return err(new Error(`Failed to acquire PID file after stale-file retry: ${String(e2)}`));
    }
  }
}

/**
 * Ensure the schedule executor is running in the background.
 * If an executor is already alive (PID file + liveness check), returns immediately.
 * Otherwise spawns a new detached background process and logs the PID.
 *
 * Called after: createSchedule, createScheduledLoop, createScheduledPipeline, resumeSchedule.
 * NOT called after: cancelSchedule, pauseSchedule (those deactivate schedules).
 */
export async function ensureScheduleExecutorRunning(): Promise<void> {
  const existingPid = readExecutorPid();
  if (existingPid !== null && isProcessAlive(existingPid)) {
    // Executor is already running — nothing to do
    return;
  }

  // Stale PID file or no file — spawn a new executor
  const { spawn } = await import('node:child_process');

  // Spawn the executor as a detached background process
  // Uses the same node binary and CLI entry point we're currently running under
  const child = spawn(process.execPath, [process.argv[1], 'schedule', 'executor'], {
    detached: true,
    stdio: 'ignore',
  });

  child.unref();

  if (child.pid) {
    process.stderr.write(`Schedule executor started in background (PID: ${child.pid})\n`);
  }
}

/**
 * Check whether any ACTIVE schedules exist in the repository.
 *
 * DECISION: Extracted for testability — pure function over a repository,
 * no process side-effects. Returns Result so callers can distinguish
 * "no active schedules" from "repo error" (callers stay alive on error).
 */
export async function checkActiveSchedules(scheduleRepo: ScheduleRepository): Promise<Result<boolean, Error>> {
  try {
    const activeResult = await scheduleRepo.findByStatus(ScheduleStatus.ACTIVE);
    if (!activeResult.ok) {
      return err(activeResult.error as Error);
    }
    return ok(activeResult.value.length > 0);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

/**
 * Register SIGTERM and SIGINT handlers that call cleanup and exit.
 *
 * DECISION: Inject process abstraction and exit callable for testability.
 * Default to global `process` and `process.exit` in production. Tests pass fakes.
 * Avoids spying on globals (cleanup risk between tests).
 *
 * @param cleanup - Cleanup function to call before exiting
 * @param proc - Process-like object with `.on()` for signal registration (default: global process)
 * @param exit - Exit callable (default: process.exit.bind(process)) — injected in tests to avoid real exit
 */
export function registerSignalHandlers(
  cleanup: () => void,
  proc: Pick<NodeJS.Process, 'on'> = process,
  exit: (code: number) => void = process.exit.bind(process),
): void {
  const exitCleanly = (signal: string): void => {
    process.stderr.write(`Schedule executor: received ${signal}, shutting down\n`);
    cleanup();
    exit(0);
  };
  proc.on('SIGTERM', () => exitCleanly('SIGTERM'));
  proc.on('SIGINT', () => exitCleanly('SIGINT'));
}

/**
 * Start the idle-check interval loop.
 * Calls onIdle() and returns the timer handle when no active schedules remain.
 * The caller is responsible for clearing the timer (or calling onIdle to exit).
 *
 * DECISION: Extracted for testability — works with fake timers in tests.
 * Returns NodeJS.Timeout so callers can unref() or clearInterval().
 */
export function startIdleCheckLoop(
  scheduleRepo: ScheduleRepository,
  intervalMs: number,
  onIdle: () => void,
  warn: (message: string) => void,
): NodeJS.Timeout {
  return setInterval(async () => {
    const hasActiveResult = await checkActiveSchedules(scheduleRepo);
    if (hasActiveResult.ok && !hasActiveResult.value) {
      warn('Schedule executor: no active schedules — exiting');
      onIdle();
    }
    // On error: stay alive (conservative) — do nothing
  }, intervalMs);
}

/**
 * Main handler for `beat schedule executor`.
 *
 * Boots the server in 'server' mode (activates ScheduleExecutor, RecoveryManager,
 * ResourceMonitor), writes its PID to ~/.autobeat/schedule-executor.pid, and
 * keeps the process alive until all active schedules are exhausted.
 *
 * The process exits automatically when no active schedules remain (checked every 5 min).
 * SIGTERM/SIGINT trigger a clean exit with PID file cleanup.
 */
export async function handleScheduleExecutor(): Promise<void> {
  // Atomically acquire the PID file — prevents race between concurrent executor startups
  const pidPath = getExecutorPidPath();
  const acquireResult = acquirePidFile(pidPath, process.pid);
  if (!acquireResult.ok) {
    process.stderr.write(`Schedule executor: PID file acquisition failed: ${acquireResult.error.message}\n`);
    process.exit(1);
  }
  if (acquireResult.value === 'already-running') {
    // Another executor is alive — nothing to do, exit cleanly
    process.exit(0);
  } else if (acquireResult.value !== 'acquired') {
    // Exhaustiveness guard: if a new sentinel is ever added to the Result union this becomes a type error
    const _exhaustive: never = acquireResult.value;
    throw new Error(`Unhandled acquire result: ${_exhaustive}`);
  }

  const cleanup = (): void => {
    try {
      fs.unlinkSync(pidPath);
    } catch {
      // Ignore cleanup errors — file may have been deleted by another process
    }
  };

  // Register signal handlers using extracted helper
  registerSignalHandlers(cleanup);

  // Bootstrap in 'server' mode — activates ScheduleExecutor, RecoveryManager, monitoring
  const bootstrapResult = await bootstrap({ mode: 'server' });
  if (!bootstrapResult.ok) {
    process.stderr.write(`Schedule executor: bootstrap failed: ${bootstrapResult.error.message}\n`);
    cleanup();
    process.exit(1);
  }

  const container = bootstrapResult.value;

  // Keep process alive
  process.stdin.resume();

  // Every 5 minutes: check if any active schedules exist — exit gracefully if none
  const IDLE_CHECK_INTERVAL_MS = 5 * 60 * 1000;
  const scheduleRepoResult = container.get<ScheduleRepository>('scheduleRepository');
  if (!scheduleRepoResult.ok) {
    process.stderr.write(
      `Schedule executor: failed to resolve scheduleRepository: ${scheduleRepoResult.error.message}\n`,
    );
    cleanup();
    process.exit(1);
  }
  const idleCheckTimer = startIdleCheckLoop(
    scheduleRepoResult.value,
    IDLE_CHECK_INTERVAL_MS,
    () => {
      clearInterval(idleCheckTimer);
      cleanup();
      process.exit(0);
    },
    (msg) => process.stderr.write(`${msg}\n`),
  );

  // Allow the process to exit naturally if idle check timer is the only thing keeping it alive
  // (After bootstrap completes, other timers/connections will keep process alive during execution)
  idleCheckTimer.unref();
}
