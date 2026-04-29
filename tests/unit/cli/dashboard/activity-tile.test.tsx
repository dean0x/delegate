/**
 * Tests for ActivityTile component
 * ARCHITECTURE: Tests behavior — tile rendering, empty state, kind labels, entry limits
 */

import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { ActivityTile } from '../../../../src/cli/dashboard/components/activity-tile.js';
import type { ActivityEntry } from '../../../../src/core/domain.js';

// ============================================================================
// Test fixtures
// ============================================================================

function makeEntry(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    timestamp: Date.now() - 5000,
    kind: 'task',
    entityId: 'task-abc12345678',
    status: 'running',
    action: 'running',
    ...overrides,
  };
}

// ============================================================================
// ActivityTile tests
// ============================================================================

describe('ActivityTile', () => {
  describe('title', () => {
    it('renders "Activity" title text', () => {
      const { lastFrame } = render(<ActivityTile activityFeed={[]} />);
      expect(lastFrame()).toContain('Activity');
    });
  });

  describe('empty state', () => {
    it('shows "No recent activity" when feed is empty', () => {
      const { lastFrame } = render(<ActivityTile activityFeed={[]} />);
      expect(lastFrame()).toContain('No recent activity');
    });

    it('does not show "No recent activity" when feed has entries', () => {
      const entry = makeEntry();
      const { lastFrame } = render(<ActivityTile activityFeed={[entry]} />);
      expect(lastFrame()).not.toContain('No recent activity');
    });
  });

  describe('kind labels — full names not abbreviations', () => {
    it('renders "orchestration" not "orch" for orchestration kind', () => {
      const entry = makeEntry({ kind: 'orchestration', entityId: 'orch-abc12345678' });
      const { lastFrame } = render(<ActivityTile activityFeed={[entry]} />);
      const frame = lastFrame() ?? '';
      expect(frame).toContain('orchestration');
      expect(frame).not.toContain('orch ');
    });

    it('renders "schedule" not "sched" for schedule kind', () => {
      const entry = makeEntry({ kind: 'schedule', entityId: 'sched-abc1234567' });
      const { lastFrame } = render(<ActivityTile activityFeed={[entry]} />);
      const frame = lastFrame() ?? '';
      expect(frame).toContain('schedule');
      expect(frame).not.toContain('sched ');
    });

    it('renders "pipeline" not "pipe" for pipeline kind', () => {
      const entry = makeEntry({ kind: 'pipeline', entityId: 'pipe-abc12345678' });
      const { lastFrame } = render(<ActivityTile activityFeed={[entry]} />);
      const frame = lastFrame() ?? '';
      expect(frame).toContain('pipeline');
      expect(frame).not.toContain('pipe ');
    });

    it('renders "task" for task kind', () => {
      const entry = makeEntry({ kind: 'task' });
      const { lastFrame } = render(<ActivityTile activityFeed={[entry]} />);
      expect(lastFrame()).toContain('task');
    });

    it('renders "loop" for loop kind', () => {
      const entry = makeEntry({ kind: 'loop', entityId: 'loop-abc12345678' });
      const { lastFrame } = render(<ActivityTile activityFeed={[entry]} />);
      expect(lastFrame()).toContain('loop');
    });
  });

  describe('maxEntries prop', () => {
    // Status values used for counting — each entry has a unique identifiable status prefix
    const UNIQUE_STATUSES = [
      'status-alpha',
      'status-bravo',
      'status-charlie',
      'status-delta',
      'status-echo',
      'status-foxtrot',
      'status-golf',
      'status-hotel',
      'status-india',
      'status-juliet',
    ];

    it('limits visible entries to maxEntries value', () => {
      const entries: ActivityEntry[] = UNIQUE_STATUSES.slice(0, 10).map((status, i) =>
        makeEntry({ status, timestamp: Date.now() - i * 1000 }),
      );
      const { lastFrame } = render(<ActivityTile activityFeed={entries} maxEntries={3} />);
      const frame = lastFrame() ?? '';
      // Counts how many unique status prefixes appear — should be exactly 3
      const matches = frame.match(/status-/g);
      expect(matches).toHaveLength(3);
    });

    it('shows up to 5 entries by default', () => {
      const entries: ActivityEntry[] = UNIQUE_STATUSES.slice(0, 8).map((status, i) =>
        makeEntry({ status, timestamp: Date.now() - i * 1000 }),
      );
      const { lastFrame } = render(<ActivityTile activityFeed={entries} />);
      const frame = lastFrame() ?? '';
      const matches = frame.match(/status-/g);
      expect(matches).toHaveLength(5);
    });
  });

  describe('time format', () => {
    it('renders HH:MM time format for each entry', () => {
      const now = new Date();
      const h = now.getHours().toString().padStart(2, '0');
      const m = now.getMinutes().toString().padStart(2, '0');
      const entry = makeEntry({ timestamp: now.getTime() });
      const { lastFrame } = render(<ActivityTile activityFeed={[entry]} />);
      expect(lastFrame()).toContain(`${h}:${m}`);
    });
  });

  describe('resilience', () => {
    it('does not crash with an empty array feed', () => {
      const { lastFrame } = render(<ActivityTile activityFeed={[]} />);
      expect(lastFrame()).toBeTruthy();
    });

    it('renders without crashing with a single entry', () => {
      const { lastFrame } = render(<ActivityTile activityFeed={[makeEntry()]} />);
      expect(lastFrame()).toBeTruthy();
    });
  });
});
