/**
 * Dashboard entry point
 * ARCHITECTURE: TTY guard, alternate screen management, Ink render lifecycle
 * Renders to stderr (process.stderr) so stdout remains usable for piping
 */

import ansiEscapes from 'ansi-escapes';
import { render } from 'ink';
import React from 'react';
import { createReadOnlyContext } from '../read-only-context.js';
import { App } from './app.js';

/**
 * Start the interactive terminal dashboard.
 * Checks for TTY, sets up alternate screen, renders the Ink app, then cleans up.
 */
export async function startDashboard(): Promise<void> {
  // TTY guard — dashboard requires an interactive terminal
  if (!process.stderr.isTTY) {
    process.stderr.write('Error: beat dashboard requires an interactive terminal (TTY)\n');
    process.exit(1);
  }

  const ctxResult = createReadOnlyContext();
  if (!ctxResult.ok) {
    process.stderr.write(`Error: Failed to initialize database: ${ctxResult.error.message}\n`);
    process.exit(1);
  }

  const ctx = ctxResult.value;

  // Enter alternate screen and hide cursor on stderr
  process.stderr.write(ansiEscapes.enterAlternativeScreen);
  process.stderr.write(ansiEscapes.cursorHide);

  let cleanupCalled = false;

  const cleanup = (): void => {
    if (cleanupCalled) return;
    cleanupCalled = true;

    // Restore terminal state
    process.stderr.write(ansiEscapes.cursorShow);
    process.stderr.write(ansiEscapes.exitAlternativeScreen);

    // Close database connection
    ctx.close();
  };

  // Handle SIGTERM for graceful shutdown
  // NOTE: SIGINT (Ctrl+C) is handled by Ink — do NOT register a handler for it here
  process.once('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });

  // Catch unexpected errors to ensure terminal is restored
  process.once('uncaughtException', (error) => {
    cleanup();
    process.stderr.write(`\nUnhandled error: ${error.message}\n`);
    process.exit(1);
  });

  process.once('unhandledRejection', (reason) => {
    cleanup();
    const message = reason instanceof Error ? reason.message : String(reason);
    process.stderr.write(`\nUnhandled rejection: ${message}\n`);
    process.exit(1);
  });

  const instance = render(<App ctx={ctx} />, {
    stdout: process.stderr,
    patchConsole: false,
  });

  try {
    await instance.waitUntilExit();
  } finally {
    cleanup();
  }
}
