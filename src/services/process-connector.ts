/**
 * Process Connector Service
 * Connects process stdout/stderr to OutputCapture and periodically flushes to OutputRepository
 */

import { ChildProcess } from 'child_process';
import { TaskId } from '../core/domain.js';
import { Logger, OutputCapture } from '../core/interfaces.js';
import { OutputRepository } from '../implementations/output-repository.js';

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

export class ProcessConnector {
  private readonly flushIntervals = new Map<TaskId, NodeJS.Timeout>();
  private readonly flushingInProgress = new Set<TaskId>();

  constructor(
    private readonly outputCapture: OutputCapture,
    private readonly logger: Logger,
    private readonly outputRepository: OutputRepository,
    private readonly flushIntervalMs: number = 5000,
  ) {}

  /**
   * Connect a process to output capture with periodic DB persistence
   */
  connect(process: ChildProcess, taskId: TaskId, onExit: (code: number | null) => void): void {
    let exitHandled = false;

    const safeOnExit = (code?: number | null) => {
      if (exitHandled) {
        this.logger.debug('Multiple onExit calls prevented', { taskId, code });
        return;
      }
      exitHandled = true;

      // Stop periodic flushing
      this.stopFlushing(taskId);

      // Final flush, then free memory, then signal completion (Edge Cases B, C)
      this.flushOutput(taskId)
        .then(() => this.outputCapture.clear(taskId)) // Free in-memory buffer after persist
        .catch((e) =>
          this.logger.error('Final flush failed', toError(e), { taskId }),
        )
        .finally(() => onExit(code ?? null)); // Use nullish coalescing to preserve 0
    };

    // Capture stdout
    if (process.stdout) {
      process.stdout.on('data', (data: Buffer) => {
        const text = data.toString();
        const result = this.outputCapture.capture(taskId, 'stdout', text);

        if (!result.ok) {
          this.logger.error('Failed to capture stdout', result.error, { taskId });
        }
      });
    }

    // Capture stderr
    if (process.stderr) {
      process.stderr.on('data', (data: Buffer) => {
        const text = data.toString();
        const result = this.outputCapture.capture(taskId, 'stderr', text);

        if (!result.ok) {
          this.logger.error('Failed to capture stderr', result.error, { taskId });
        }
      });
    }

    // Start periodic output flushing to DB
    const interval = setInterval(() => {
      // Backpressure guard: skip if previous flush is still in-flight
      if (this.flushingInProgress.has(taskId)) {
        this.logger.debug('Skipping flush — previous flush still in-flight', { taskId });
        return;
      }

      this.flushingInProgress.add(taskId);
      this.flushOutput(taskId)
        .catch((e) =>
          this.logger.error('Periodic flush failed', toError(e), { taskId }),
        )
        .finally(() => {
          this.flushingInProgress.delete(taskId);
        });
    }, this.flushIntervalMs);
    this.flushIntervals.set(taskId, interval);

    // Handle process exit
    process.on('exit', (code) => {
      this.logger.debug('Process exited', { taskId, code, codeType: typeof code });
      safeOnExit(code);
    });

    // Handle process error
    process.on('error', (error) => {
      this.logger.error('Process error', error, { taskId });
      const result = this.outputCapture.capture(taskId, 'stderr', `Process error: ${error.message}\n`);

      if (!result.ok) {
        this.logger.error('Failed to capture error', result.error, { taskId });
      }

      safeOnExit(1);
    });
  }

  /**
   * Stop periodic output flushing for a task.
   * Called by WorkerPool.kill() before sending SIGTERM to prevent
   * flush attempts after the database closes (Edge Case I).
   */
  stopFlushing(taskId: TaskId): void {
    const interval = this.flushIntervals.get(taskId);
    if (interval) {
      clearInterval(interval);
      this.flushIntervals.delete(taskId);
    }
    this.flushingInProgress.delete(taskId);
  }

  /**
   * Flush current in-memory output to the database.
   * Reads accumulated output from OutputCapture and writes a snapshot via save().
   */
  async flushOutput(taskId: TaskId): Promise<void> {
    const outputResult = this.outputCapture.getOutput(taskId);
    if (!outputResult.ok) return;

    const output = outputResult.value;
    if (output.totalSize === 0) return;

    const saveResult = await this.outputRepository.save(taskId, output);
    if (!saveResult.ok) {
      this.logger.error('Failed to persist output', saveResult.error, { taskId });
    }
  }
}
