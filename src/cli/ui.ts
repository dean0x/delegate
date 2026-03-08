/**
 * CLI Display Abstraction Layer
 *
 * All output goes to process.stderr (stdout is reserved for MCP protocol
 * and task output streaming). TTY-aware: uses @clack/prompts styled output
 * in interactive terminals, falls back to plain text in pipes/CI.
 *
 * CRITICAL CONTRACT: error() emits '❌' prefix in non-TTY mode.
 * The detach-mode polling loop relies on /^❌/m to detect errors.
 */

import * as p from '@clack/prompts';
import pc from 'picocolors';

const isTTY = process.stderr.isTTY === true;
const output = process.stderr;

// Spinner
export type Spinner = ReturnType<typeof p.spinner>;

export function createSpinner(): Spinner {
  if (!isTTY) {
    // Non-TTY: print plain start/stop lines, no animation
    return {
      start(msg?: string) {
        if (msg) output.write(`${msg}\n`);
      },
      stop(msg?: string) {
        if (msg) output.write(`${msg}\n`);
      },
      message(msg?: string) {
        void msg; // no-op in non-TTY
      },
      cancel(msg?: string) {
        if (msg) output.write(`${msg}\n`);
      },
      error(msg?: string) {
        if (msg) output.write(`❌ ${msg}\n`);
      },
      clear() {},
      get isCancelled() {
        return false;
      },
    } as Spinner;
  }
  return p.spinner({ output });
}

// Structured log — TTY: @clack styled; Non-TTY: plain
export function success(msg: string): void {
  if (isTTY) {
    p.log.success(msg, { output });
  } else {
    output.write(`${msg}\n`);
  }
}

export function error(msg: string): void {
  if (isTTY) {
    p.log.error(msg, { output });
  } else {
    // CRITICAL: ❌ prefix for detach-mode error detection
    output.write(`❌ ${msg}\n`);
  }
}

export function info(msg: string): void {
  if (isTTY) {
    p.log.info(msg, { output });
  } else {
    output.write(`${msg}\n`);
  }
}

export function step(msg: string): void {
  if (isTTY) {
    p.log.step(msg, { output });
  } else {
    output.write(`${msg}\n`);
  }
}

// Session markers (intro/outro/cancel for interactive flows)
export function intro(msg: string): void {
  if (isTTY) {
    p.intro(msg, { output });
  } else {
    output.write(`${msg}\n`);
  }
}

export function outro(msg: string): void {
  if (isTTY) {
    p.outro(msg, { output });
  } else {
    output.write(`${msg}\n`);
  }
}

export function cancel(msg: string): void {
  if (isTTY) {
    p.cancel(msg, { output });
  } else {
    output.write(`${msg}\n`);
  }
}

// Boxed display (task details, config sections)
export function note(msg: string, title?: string): void {
  if (isTTY) {
    p.note(msg, title, { output });
  } else {
    if (title) output.write(`${title}\n`);
    output.write(`${msg}\n`);
  }
}

// Status coloring — trims before matching so padded strings (e.g. "completed ") still get colored
export function colorStatus(status: string): string {
  if (!isTTY) return status;
  switch (status.trim()) {
    case 'completed':
    case 'active':
      return pc.green(status);
    case 'running':
      return pc.cyan(status);
    case 'failed':
      return pc.red(status);
    case 'queued':
    case 'expired':
      return pc.dim(status);
    case 'cancelled':
    case 'paused':
      return pc.yellow(status);
    default:
      return status;
  }
}

// Format helpers
export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

// Machine-readable stdout — no decoration
export function stdout(text: string): void {
  process.stdout.write(`${text}\n`);
}

// Bold text for headers (TTY-aware)
export function bold(text: string): string {
  return isTTY ? pc.bold(text) : text;
}

// Dim text for secondary info (TTY-aware)
export function dim(text: string): string {
  return isTTY ? pc.dim(text) : text;
}

// Cyan text for highlights (TTY-aware)
export function cyan(text: string): string {
  return isTTY ? pc.cyan(text) : text;
}

export function yellow(text: string): string {
  return isTTY ? pc.yellow(text) : text;
}
