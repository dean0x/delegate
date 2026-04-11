/**
 * File-backed Logger implementation for dashboard mode.
 *
 * Writes newline-delimited JSON log entries to a file so that normal log output
 * does not interleave with Ink's frame rendering on stderr.
 *
 * ARCHITECTURE: Implements the Logger interface. Used by startDashboard() to
 * swap the ConsoleLogger for a file-backed logger while the Ink UI is running.
 *
 * Error handling: if the file cannot be opened, falls back to a SilentLogger
 * that drops all writes — never throws into the dashboard UI.
 */

import { mkdir, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Logger } from '../core/interfaces.js';
import { LogLevel } from './logger.js';

// ============================================================================
// Default log path
// ============================================================================

/** Default path for dashboard log output. */
export const DEFAULT_DASHBOARD_LOG_PATH = path.join(os.homedir(), '.autobeat', 'dashboard.log');

// ============================================================================
// Log entry shape (JSON-serialisable)
// ============================================================================

interface LogEntry {
  readonly timestamp: string;
  readonly level: string;
  readonly message: string;
  readonly context?: Record<string, unknown>;
  readonly error?: {
    readonly name: string;
    readonly message: string;
    readonly stack?: string;
  };
}

// ============================================================================
// DisposableLogger — Logger with lifecycle dispose()
// ============================================================================

/** Logger that can be shut down cleanly. Returned by FileLogger.create(). */
export type DisposableLogger = Logger & { dispose(): Promise<void> };

// ============================================================================
// SilentLogger — no-op fallback used when the file cannot be opened
// ============================================================================

class SilentLogger implements DisposableLogger {
  debug(_message: string, _context?: Record<string, unknown>): void {}
  info(_message: string, _context?: Record<string, unknown>): void {}
  warn(_message: string, _context?: Record<string, unknown>): void {}
  error(_message: string, _error?: Error, _context?: Record<string, unknown>): void {}
  child(_context: Record<string, unknown>): Logger {
    return this;
  }
  async dispose(): Promise<void> {}
}

// ============================================================================
// FileLogger
// ============================================================================

/**
 * Writes structured JSON log lines to a file.
 * Constructed via the static `FileLogger.create()` factory which returns a
 * SilentLogger fallback if the file cannot be opened — callers always get a
 * valid DisposableLogger, never an error.
 */
export class FileLogger implements Logger {
  private readonly fileHandle: import('node:fs/promises').FileHandle;
  private readonly context: Readonly<Record<string, unknown>>;
  private readonly level: LogLevel;
  private disposed = false;

  private constructor(
    fileHandle: import('node:fs/promises').FileHandle,
    level: LogLevel = LogLevel.INFO,
    context: Record<string, unknown> = {},
  ) {
    this.fileHandle = fileHandle;
    this.level = level;
    this.context = { ...context };
  }

  /**
   * Create a FileLogger that writes to the given path.
   * Creates the parent directory if it does not exist (idempotent).
   * Returns a SilentLogger on any open/mkdir failure — never throws.
   * Pass `level` to filter writes below that severity (mirrors StructuredLogger/ConsoleLogger).
   */
  static async create(
    filePath: string = DEFAULT_DASHBOARD_LOG_PATH,
    level: LogLevel = LogLevel.INFO,
  ): Promise<DisposableLogger> {
    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      const handle = await open(filePath, 'a');
      return new FileLogger(handle, level);
    } catch {
      // Silent fallback — never throw into the dashboard UI
      return new SilentLogger();
    }
  }

  debug(message: string, context?: Record<string, unknown>): void {
    if (this.level > LogLevel.DEBUG) return;
    this.write('debug', message, undefined, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    if (this.level > LogLevel.INFO) return;
    this.write('info', message, undefined, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    if (this.level > LogLevel.WARN) return;
    this.write('warn', message, undefined, context);
  }

  error(message: string, error?: Error, context?: Record<string, unknown>): void {
    if (this.level > LogLevel.ERROR) return;
    this.write('error', message, error, context);
  }

  child(context: Record<string, unknown>): Logger {
    return new FileLogger(this.fileHandle, this.level, { ...this.context, ...context });
  }

  /**
   * Flush any pending writes and close the file handle.
   * Idempotent: safe to call multiple times.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      await this.fileHandle.sync();
      await this.fileHandle.close();
    } catch {
      // Best-effort cleanup — ignore errors on close
    }
  }

  private write(level: string, message: string, error?: Error, extraContext?: Record<string, unknown>): void {
    if (this.disposed) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context: { ...this.context, ...extraContext },
    };

    const entryWithError: Record<string, unknown> = { ...entry };
    if (error) {
      entryWithError.error = {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    }

    const line = `${JSON.stringify(entryWithError)}\n`;

    // Fire-and-forget write — errors are silently dropped to never crash the dashboard
    this.fileHandle.write(line).catch(() => {
      // Intentional: log write failures must never propagate to the UI
    });
  }
}
