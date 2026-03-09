/**
 * Unit tests for validation utilities
 *
 * ARCHITECTURE: Tests security-critical path traversal prevention,
 * buffer size limits, and timeout validation
 * Pattern: Pure functions — real filesystem with temp dirs, no mocks
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateBufferSize, validatePath, validateTimeout } from '../../../src/utils/validation.js';

describe('validatePath', () => {
  let tempDir: string;

  beforeEach(() => {
    // Resolve symlinks (macOS /var → /private/var) so assertions match realpathSync output
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'backbeat-validation-')));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should accept a valid relative path within base', () => {
    fs.writeFileSync(path.join(tempDir, 'file.txt'), 'test');

    const result = validatePath('file.txt', tempDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(path.join(tempDir, 'file.txt'));
  });

  it('should accept a valid absolute path within base', () => {
    const filePath = path.join(tempDir, 'file.txt');
    fs.writeFileSync(filePath, 'test');

    const result = validatePath(filePath, tempDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(filePath);
  });

  it('should block path traversal with ../', () => {
    const result = validatePath('../../etc/passwd', tempDir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('Path traversal detected');
  });

  it('should block symlink-based traversal', () => {
    const linkPath = path.join(tempDir, 'evil-link');
    fs.symlinkSync('/etc', linkPath);

    const result = validatePath('evil-link/passwd', tempDir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('Path traversal detected');
  });

  it('should reject non-existent path when mustExist is true', () => {
    const result = validatePath('nonexistent.txt', tempDir, true);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('Path does not exist');
  });

  it('should accept non-existent file when parent exists (logical path)', () => {
    const result = validatePath('new-file.txt', tempDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(path.join(tempDir, 'new-file.txt'));
  });

  it('should fall back to logical path when parent does not exist', () => {
    const result = validatePath('deep/nested/file.txt', tempDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(path.join(tempDir, 'deep', 'nested', 'file.txt'));
  });

  it('should use custom baseDir', () => {
    const subDir = path.join(tempDir, 'sub');
    fs.mkdirSync(subDir);
    fs.writeFileSync(path.join(subDir, 'file.txt'), 'test');

    const result = validatePath('file.txt', subDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(path.join(subDir, 'file.txt'));
  });

  it('should reject when base directory does not exist', () => {
    const result = validatePath('file.txt', '/nonexistent/base/dir');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('Base directory does not exist');
  });
});

describe('validateBufferSize', () => {
  it('should accept a valid size within limits', () => {
    const result = validateBufferSize(1024 * 1024); // 1MB
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(1024 * 1024);
  });

  it('should reject size below minimum (< 1KB)', () => {
    const result = validateBufferSize(512);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('at least 1024 bytes');
  });

  it('should reject size above maximum (> 1GB)', () => {
    const result = validateBufferSize(1073741825);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('cannot exceed');
  });

  it('should reject NaN input', () => {
    const result = validateBufferSize(NaN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('at least 1024 bytes');
  });
});

describe('validateTimeout', () => {
  it('should accept a valid timeout', () => {
    const result = validateTimeout(30000); // 30s
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(30000);
  });

  it('should reject timeout below minimum (< 1s)', () => {
    const result = validateTimeout(500);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('at least 1000ms');
  });

  it('should reject timeout above maximum (> 24h)', () => {
    const result = validateTimeout(86400001);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('cannot exceed');
  });

  it('should reject NaN input', () => {
    const result = validateTimeout(NaN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('at least 1000ms');
  });
});
