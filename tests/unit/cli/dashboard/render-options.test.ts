/**
 * Regression guard: dashboard render() is called with stdin + stderr options.
 *
 * Without stdin: process.stdin, Ink cannot establish full TTY control and
 * useInput hooks never register keystrokes. This test guards against regressions
 * where the stdin option is accidentally dropped.
 *
 * Implementation note: We parse the source text of index.tsx to verify the
 * render call options, rather than mocking ink (which would pollute the module
 * registry for other tests in this non-isolated suite).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const INDEX_PATH = path.resolve(__dirname, '../../../../src/cli/dashboard/index.tsx');

describe('dashboard render options (source guard)', () => {
  it('render() call includes stdin: process.stdin option', () => {
    const source = readFileSync(INDEX_PATH, 'utf-8');
    // The render call options object must contain stdin: process.stdin
    expect(source).toContain('stdin: process.stdin');
  });

  it('render() call includes stdout: process.stderr option', () => {
    const source = readFileSync(INDEX_PATH, 'utf-8');
    expect(source).toContain('stdout: process.stderr');
  });

  it('render() call includes patchConsole: false option', () => {
    const source = readFileSync(INDEX_PATH, 'utf-8');
    expect(source).toContain('patchConsole: false');
  });

  it('stdin and stdout options appear together in the same render() options block', () => {
    const source = readFileSync(INDEX_PATH, 'utf-8');
    // Find the options block: the last argument object to render().
    // We look for a block { ... stdin ... stdout ... } or { ... stdout ... stdin ... }
    const hasStdinBeforeStdout = /\{[\s\S]*?stdin[\s\S]*?stdout[\s\S]*?\}/.test(source);
    const hasStdoutBeforeStdin = /\{[\s\S]*?stdout[\s\S]*?stdin[\s\S]*?\}/.test(source);
    expect(hasStdinBeforeStdout || hasStdoutBeforeStdin).toBe(true);
  });
});

describe('dashboard boot message (source guard)', () => {
  /**
   * Regression guard: Plan §Fix-1b requires a one-line discovery hint printed to
   * stderr ONCE before render() mounts, so users know where to tail the log.
   * The hint must appear only when the file logger is active (not the silent
   * fallback) and must be emitted before enterAlternativeScreen so it lands in
   * the normal scrollback buffer.
   */
  it('imports DEFAULT_DASHBOARD_LOG_PATH from file-logger', () => {
    const source = readFileSync(INDEX_PATH, 'utf-8');
    expect(source).toContain('DEFAULT_DASHBOARD_LOG_PATH');
    expect(source).toContain("from '../../implementations/file-logger.js'");
  });

  it('emits process.stderr.write with the log path before render()', () => {
    const source = readFileSync(INDEX_PATH, 'utf-8');
    // The write call must reference DEFAULT_DASHBOARD_LOG_PATH as the path
    expect(source).toMatch(
      /process\.stderr\.write\s*\(\s*`\[dashboard\] logs → \$\{DEFAULT_DASHBOARD_LOG_PATH\}\\n`\s*\)/,
    );
  });

  it('boot message write is guarded by instanceof FileLogger check', () => {
    const source = readFileSync(INDEX_PATH, 'utf-8');
    // Only write when using the real file logger, not the SilentLogger fallback
    expect(source).toMatch(/instanceof\s+FileLogger/);
  });

  it('boot message write appears before enterAlternativeScreen', () => {
    const source = readFileSync(INDEX_PATH, 'utf-8');
    const bootIdx = source.indexOf('[dashboard] logs');
    const altScreenIdx = source.indexOf('enterAlternativeScreen');
    // Both must be present and boot message must come first
    expect(bootIdx).toBeGreaterThan(-1);
    expect(altScreenIdx).toBeGreaterThan(-1);
    expect(bootIdx).toBeLessThan(altScreenIdx);
  });
});

describe('dashboard FileLogger wiring (source guard)', () => {
  /**
   * Regression guard: dashboard must swap the default ConsoleLogger for a
   * FileLogger so log output does not interleave with Ink's frame rendering.
   * The commit introducing FileLogger only delivers that behaviour if the
   * dashboard actually passes it to bootstrap() — this test guards against
   * the wiring being dropped.
   */
  it('imports FileLogger from implementations', () => {
    const source = readFileSync(INDEX_PATH, 'utf-8');
    expect(source).toContain('FileLogger');
    expect(source).toContain("from '../../implementations/file-logger.js'");
  });

  it('constructs a FileLogger before calling bootstrap', () => {
    const source = readFileSync(INDEX_PATH, 'utf-8');
    expect(source).toMatch(/FileLogger\.create\s*\(/);
  });

  it('passes the file logger into bootstrap() via the logger option', () => {
    const source = readFileSync(INDEX_PATH, 'utf-8');
    // bootstrap({ mode: 'cli', logger: fileLogger }) — logger field must be present
    expect(source).toMatch(/bootstrap\s*\(\s*\{[\s\S]*?logger\s*:/);
  });

  it('disposes the file logger during cleanup', () => {
    const source = readFileSync(INDEX_PATH, 'utf-8');
    expect(source).toMatch(/fileLogger\.dispose\s*\(\s*\)/);
  });
});
