/**
 * Tests for dashboard format utilities
 * TDD: Written before production code (RED phase)
 */

import { describe, expect, it } from 'vitest';
import {
  formatRunProgress,
  panelStatusSummary,
  relativeTime,
  scoreTrend,
  statusIcon,
  truncateCell,
} from '../../../../src/cli/dashboard/format.js';

describe('relativeTime', () => {
  const now = Date.now();

  it('returns "just now" for 0ms ago', () => {
    expect(relativeTime(now)).toBe('just now');
  });

  it('returns "just now" for under 60 seconds ago', () => {
    expect(relativeTime(now - 30_000)).toBe('just now');
  });

  it('returns "just now" for exactly 59 seconds ago', () => {
    expect(relativeTime(now - 59_000)).toBe('just now');
  });

  it('returns minutes for 60 seconds ago', () => {
    expect(relativeTime(now - 60_000)).toBe('1m ago');
  });

  it('returns minutes for 2 minutes ago', () => {
    expect(relativeTime(now - 2 * 60_000)).toBe('2m ago');
  });

  it('returns hours for 1 hour ago', () => {
    expect(relativeTime(now - 60 * 60_000)).toBe('1h ago');
  });

  it('returns hours for 3 hours ago', () => {
    expect(relativeTime(now - 3 * 60 * 60_000)).toBe('3h ago');
  });

  it('returns days for 24 hours ago', () => {
    expect(relativeTime(now - 24 * 60 * 60_000)).toBe('1d ago');
  });

  it('returns days for 7 days ago', () => {
    expect(relativeTime(now - 7 * 24 * 60 * 60_000)).toBe('7d ago');
  });

  it('returns "in Xm" for future dates', () => {
    // Add 30s buffer so the diff stays within the 2-minute bucket during test execution
    expect(relativeTime(now + 2 * 60_000 + 30_000)).toBe('in 2m');
  });

  it('returns "in Xh" for future dates in hours', () => {
    expect(relativeTime(now + 3 * 60 * 60_000 + 30_000)).toBe('in 3h');
  });

  it('returns "in Xd" for future dates in days', () => {
    expect(relativeTime(now + 2 * 24 * 60 * 60_000 + 30_000)).toBe('in 2d');
  });
});

describe('statusIcon', () => {
  it('maps running to ●', () => {
    expect(statusIcon('running')).toBe('●');
  });

  it('maps completed to ✓', () => {
    expect(statusIcon('completed')).toBe('✓');
  });

  it('maps failed to ✗', () => {
    expect(statusIcon('failed')).toBe('✗');
  });

  it('maps queued to ○', () => {
    expect(statusIcon('queued')).toBe('○');
  });

  it('maps paused to ⏸', () => {
    expect(statusIcon('paused')).toBe('⏸');
  });

  it('maps cancelled to ✗', () => {
    expect(statusIcon('cancelled')).toBe('✗');
  });

  it('maps active to ●', () => {
    expect(statusIcon('active')).toBe('●');
  });

  it('maps planning to ○', () => {
    expect(statusIcon('planning')).toBe('○');
  });

  it('returns ○ for unknown status', () => {
    expect(statusIcon('unknown-status')).toBe('○');
  });
});

describe('scoreTrend', () => {
  it('returns → when previous is undefined', () => {
    expect(scoreTrend(0.9, undefined, 'maximize')).toBe('→');
  });

  it('maximize: returns ↑ when current > previous', () => {
    expect(scoreTrend(0.9, 0.7, 'maximize')).toBe('↑');
  });

  it('maximize: returns ↓ when current < previous', () => {
    expect(scoreTrend(0.5, 0.8, 'maximize')).toBe('↓');
  });

  it('maximize: returns → when current equals previous', () => {
    expect(scoreTrend(0.7, 0.7, 'maximize')).toBe('→');
  });

  it('minimize: returns ↑ when current < previous (improvement)', () => {
    expect(scoreTrend(0.3, 0.8, 'minimize')).toBe('↑');
  });

  it('minimize: returns ↓ when current > previous (decline)', () => {
    expect(scoreTrend(0.9, 0.5, 'minimize')).toBe('↓');
  });

  it('minimize: returns → when current equals previous', () => {
    expect(scoreTrend(0.5, 0.5, 'minimize')).toBe('→');
  });
});

describe('truncateCell', () => {
  it('returns string unchanged if under maxWidth', () => {
    expect(truncateCell('hello', 10)).toBe('hello');
  });

  it('returns string unchanged if exactly maxWidth', () => {
    expect(truncateCell('hello', 5)).toBe('hello');
  });

  it('truncates and adds ".." if over maxWidth', () => {
    const result = truncateCell('hello world', 8);
    expect(result).toBe('hello w…');
    expect(result.length).toBeLessThanOrEqual(8);
  });

  it('handles ASCII correctly', () => {
    const result = truncateCell('abcdefghij', 6);
    expect(result).toBe('abcde…');
  });

  it('handles empty string', () => {
    expect(truncateCell('', 5)).toBe('');
  });

  it('handles maxWidth of 1', () => {
    const result = truncateCell('hello', 1);
    expect(result.length).toBeLessThanOrEqual(1);
  });
});

describe('formatRunProgress', () => {
  it('returns "3/10" for finite max', () => {
    expect(formatRunProgress(3, 10)).toBe('3/10');
  });

  it('returns "0/5" for zero current', () => {
    expect(formatRunProgress(0, 5)).toBe('0/5');
  });

  it('returns "3/∞" when max is null', () => {
    expect(formatRunProgress(3, null)).toBe('3/∞');
  });

  it('returns "3/∞" when max is undefined', () => {
    expect(formatRunProgress(3, undefined)).toBe('3/∞');
  });

  it('returns "3/∞" when max is 0', () => {
    expect(formatRunProgress(3, 0)).toBe('3/∞');
  });
});

describe('panelStatusSummary', () => {
  it('returns empty string for empty counts', () => {
    expect(panelStatusSummary({})).toBe('');
  });

  it('returns single status correctly', () => {
    expect(panelStatusSummary({ running: 2 })).toBe('2 running');
  });

  it('returns multiple statuses joined by comma', () => {
    const result = panelStatusSummary({ running: 2, paused: 1 });
    expect(result).toContain('2 running');
    expect(result).toContain('1 paused');
  });

  it('skips zero-count statuses', () => {
    const result = panelStatusSummary({ running: 2, paused: 0 });
    expect(result).toBe('2 running');
    expect(result).not.toContain('paused');
  });

  it('handles all zero counts', () => {
    expect(panelStatusSummary({ running: 0, paused: 0 })).toBe('');
  });
});
