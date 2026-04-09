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
  statusColor,
  statusIcon,
  truncateCell,
  truncationNotice,
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

describe('statusColor', () => {
  it('maps running to cyan', () => {
    expect(statusColor('running')).toBe('cyan');
  });

  it('maps active to cyan', () => {
    expect(statusColor('active')).toBe('cyan');
  });

  it('maps planning to cyan', () => {
    expect(statusColor('planning')).toBe('cyan');
  });

  it('maps completed to green', () => {
    expect(statusColor('completed')).toBe('green');
  });

  it('maps failed to red', () => {
    expect(statusColor('failed')).toBe('red');
  });

  it('maps cancelled to red', () => {
    expect(statusColor('cancelled')).toBe('red');
  });

  it('maps paused to yellow', () => {
    expect(statusColor('paused')).toBe('yellow');
  });

  it('maps queued to gray', () => {
    expect(statusColor('queued')).toBe('gray');
  });

  it('maps expired to gray', () => {
    expect(statusColor('expired')).toBe('gray');
  });

  it('maps unknown status to gray', () => {
    expect(statusColor('unknown-status')).toBe('gray');
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

  it('uses ASCII fast-path for printable ASCII strings', () => {
    // All chars in 0x20–0x7E range — should use slice, not stringWidth loop
    const result = truncateCell('Hello, world!', 8);
    expect(result).toBe('Hello, …');
    expect(result.length).toBeLessThanOrEqual(8);
  });

  it('handles wide Unicode characters (2-column emoji/CJK)', () => {
    // Each CJK char is 2 columns wide. maxWidth=5 → targetWidth=4 → fits 2 chars (4 cols)
    const result = truncateCell('日本語', 5);
    expect(result).toBe('日本…');
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

describe('truncationNotice', () => {
  it('returns null when displayed equals total', () => {
    expect(truncationNotice(50, 50, null)).toBeNull();
  });

  it('returns null when displayed exceeds total', () => {
    // Defensive: shouldn't happen but guard against it
    expect(truncationNotice(50, 47, null)).toBeNull();
  });

  it('returns "showing 50 of 247" when truncated with no filter', () => {
    expect(truncationNotice(50, 247, null)).toBe('showing 50 of 247');
  });

  it('returns "showing 5 of 15 running" when truncated with filter', () => {
    expect(truncationNotice(5, 15, 'running')).toBe('showing 5 of 15 running');
  });

  it('returns null when filtered count matches total', () => {
    expect(truncationNotice(5, 5, 'running')).toBeNull();
  });

  it('returns null when both counts are 0', () => {
    expect(truncationNotice(0, 0, null)).toBeNull();
  });

  it('handles filter with failed status', () => {
    expect(truncationNotice(10, 32, 'failed')).toBe('showing 10 of 32 failed');
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
