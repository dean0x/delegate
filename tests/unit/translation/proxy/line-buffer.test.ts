/**
 * Tests for SSE line buffer
 */
import { describe, expect, it } from 'vitest';
import { LineBuffer } from '../../../../src/translation/proxy/line-buffer.js';

describe('LineBuffer', () => {
  it('returns a complete line when fed a complete line with newline', () => {
    const buf = new LineBuffer();
    const lines = buf.feed('hello world\n');
    expect(lines).toEqual(['hello world']);
  });

  it('holds partial line until next chunk', () => {
    const buf = new LineBuffer();
    const lines1 = buf.feed('partial');
    expect(lines1).toEqual([]);

    const lines2 = buf.feed(' completed\n');
    expect(lines2).toEqual(['partial completed']);
  });

  it('returns multiple complete lines from one chunk', () => {
    const buf = new LineBuffer();
    const lines = buf.feed('line1\nline2\nline3\n');
    expect(lines).toEqual(['line1', 'line2', 'line3']);
  });

  it('handles empty lines (SSE event separator)', () => {
    const buf = new LineBuffer();
    const lines = buf.feed('event: test\ndata: {"key":"val"}\n\n');
    expect(lines).toContain('event: test');
    expect(lines).toContain('data: {"key":"val"}');
    expect(lines).toContain('');
  });

  it('handles multi-line SSE event across chunks', () => {
    const buf = new LineBuffer();
    const lines1 = buf.feed('event: message\ndata: ');
    expect(lines1).toEqual(['event: message']);

    const lines2 = buf.feed('{"text":"hello"}\n\n');
    expect(lines2).toContain('data: {"text":"hello"}');
    expect(lines2).toContain('');
  });

  it('flush returns remaining buffer content', () => {
    const buf = new LineBuffer();
    buf.feed('incomplete');
    const remaining = buf.flush();
    expect(remaining).toBe('incomplete');
  });

  it('flush returns null if buffer is empty', () => {
    const buf = new LineBuffer();
    buf.feed('complete\n');
    const remaining = buf.flush();
    expect(remaining).toBeNull();
  });

  it('handles Windows line endings (CRLF)', () => {
    const buf = new LineBuffer();
    const lines = buf.feed('line1\r\nline2\r\n');
    expect(lines).toEqual(['line1', 'line2']);
  });

  it('handles consecutive newlines for empty lines', () => {
    const buf = new LineBuffer();
    const lines = buf.feed('\n\n');
    expect(lines).toEqual(['', '']);
  });

  it('processes large chunks correctly', () => {
    const buf = new LineBuffer();
    const chunk = Array(100).fill('data: line\n').join('');
    const lines = buf.feed(chunk);
    expect(lines).toHaveLength(100);
    expect(lines.every((l) => l === 'data: line')).toBe(true);
  });

  it('handles SSE [DONE] sentinel', () => {
    const buf = new LineBuffer();
    const lines = buf.feed('data: [DONE]\n\n');
    expect(lines).toContain('data: [DONE]');
  });
});
