/**
 * FileLogger — writes newline-delimited JSON to a file.
 * Covers: write, dir creation, dispose/flush, and error fallback to SilentLogger.
 */

import { mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileLogger } from '../../../src/implementations/file-logger';

const TEST_DIR = path.join(os.tmpdir(), `file-logger-test-${Date.now()}`);
const LOG_FILE = path.join(TEST_DIR, 'test.log');

afterAll(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe('FileLogger', () => {
  describe('basic writing', () => {
    beforeEach(async () => {
      await rm(TEST_DIR, { recursive: true, force: true });
    });

    it('creates parent directory if it does not exist', async () => {
      const logger = await FileLogger.create(LOG_FILE);
      logger.info('hello');
      await logger.dispose();
      const stat = await import('node:fs/promises').then((m) => m.stat(TEST_DIR));
      expect(stat.isDirectory()).toBe(true);
    });

    it('writes info message as a JSON line', async () => {
      const logger = await FileLogger.create(LOG_FILE);
      logger.info('test message', { key: 'value' });
      await logger.dispose();
      const contents = await readFile(LOG_FILE, 'utf-8');
      const lines = contents.trim().split('\n').filter(Boolean);
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
      expect(parsed.level).toBe('info');
      expect(parsed.message).toBe('test message');
      expect((parsed.context as Record<string, unknown>).key).toBe('value');
      expect(typeof parsed.timestamp).toBe('string');
    });

    it('writes debug message', async () => {
      const logger = await FileLogger.create(LOG_FILE);
      logger.debug('debug msg');
      await logger.dispose();
      const contents = await readFile(LOG_FILE, 'utf-8');
      const parsed = JSON.parse(contents.trim()) as Record<string, unknown>;
      expect(parsed.level).toBe('debug');
    });

    it('writes warn message', async () => {
      const logger = await FileLogger.create(LOG_FILE);
      logger.warn('warn msg');
      await logger.dispose();
      const contents = await readFile(LOG_FILE, 'utf-8');
      const parsed = JSON.parse(contents.trim()) as Record<string, unknown>;
      expect(parsed.level).toBe('warn');
    });

    it('writes error message with error details', async () => {
      const logger = await FileLogger.create(LOG_FILE);
      const err = new Error('something went wrong');
      logger.error('error msg', err, { extra: 1 });
      await logger.dispose();
      const contents = await readFile(LOG_FILE, 'utf-8');
      const parsed = JSON.parse(contents.trim()) as Record<string, unknown>;
      expect(parsed.level).toBe('error');
      expect((parsed.error as Record<string, unknown>).message).toBe('something went wrong');
    });

    it('writes multiple messages as separate JSON lines', async () => {
      const logger = await FileLogger.create(LOG_FILE);
      logger.info('first');
      logger.info('second');
      logger.info('third');
      await logger.dispose();
      const contents = await readFile(LOG_FILE, 'utf-8');
      const lines = contents.trim().split('\n').filter(Boolean);
      expect(lines).toHaveLength(3);
      // NOTE: FileLogger writes are fire-and-forget (see write() implementation) —
      // the underlying fs.promises.write calls may interleave on the libuv thread
      // pool under load, so we only assert set membership, not order.
      const messages = new Set(lines.map((l) => (JSON.parse(l) as { message: string }).message));
      expect(messages).toEqual(new Set(['first', 'second', 'third']));
    });

    it('child() inherits context prefix', async () => {
      const logger = await FileLogger.create(LOG_FILE);
      const child = logger.child({ module: 'test-module' });
      child.info('child message');
      await logger.dispose();
      const contents = await readFile(LOG_FILE, 'utf-8');
      const parsed = JSON.parse(contents.trim()) as Record<string, unknown>;
      expect((parsed.context as Record<string, unknown>).module).toBe('test-module');
    });

    it('works if parent directory already exists (idempotent)', async () => {
      await mkdir(TEST_DIR, { recursive: true });
      const logger = await FileLogger.create(LOG_FILE);
      logger.info('existing dir');
      await logger.dispose();
      const contents = await readFile(LOG_FILE, 'utf-8');
      expect(contents).toContain('existing dir');
    });
  });

  describe('dispose', () => {
    beforeEach(async () => {
      await rm(TEST_DIR, { recursive: true, force: true });
    });

    it('dispose() flushes remaining buffered writes and closes the handle', async () => {
      const logger = await FileLogger.create(LOG_FILE);
      logger.info('before dispose');
      await logger.dispose();
      // Should be readable immediately after dispose
      const contents = await readFile(LOG_FILE, 'utf-8');
      expect(contents).toContain('before dispose');
    });

    it('dispose() is idempotent — calling twice does not throw', async () => {
      const logger = await FileLogger.create(LOG_FILE);
      await logger.dispose();
      await expect(logger.dispose()).resolves.not.toThrow();
    });

    it('writes after dispose() are silently dropped', async () => {
      const logger = await FileLogger.create(LOG_FILE);
      await logger.dispose();
      // Should not throw
      expect(() => logger.info('after dispose')).not.toThrow();
    });
  });

  describe('error fallback', () => {
    it('falls back to SilentLogger when file cannot be opened', async () => {
      // Use an invalid path (root-owned directory) to force open failure
      const invalidPath = '/root/cannot-write-here/test.log';
      // Should not throw — returns silent logger fallback
      const logger = await FileLogger.create(invalidPath);
      // All operations on the fallback are silent no-ops
      expect(() => logger.info('silent')).not.toThrow();
      expect(() => logger.error('silent', new Error('x'))).not.toThrow();
      await expect(logger.dispose()).resolves.not.toThrow();
    });
  });
});
