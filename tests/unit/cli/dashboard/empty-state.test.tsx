/**
 * Tests for EmptyState component.
 * Tests behavior: message text for filtered/unfiltered states and smart totalForFilter.
 */

import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { EmptyState } from '../../../../src/cli/dashboard/components/empty-state.js';

describe('EmptyState', () => {
  describe('no filter', () => {
    it('shows "No loops found" when no filter and no totalForFilter', () => {
      const { lastFrame } = render(<EmptyState entityName="loops" filterStatus={null} />);
      expect(lastFrame()).toContain('No loops found');
    });

    it('shows "No tasks found" for tasks entity', () => {
      const { lastFrame } = render(<EmptyState entityName="tasks" filterStatus={null} />);
      expect(lastFrame()).toContain('No tasks found');
    });
  });

  describe('with filter, no items in DB', () => {
    it('shows "No running loops found" when filter is set and totalForFilter is 0', () => {
      const { lastFrame } = render(
        <EmptyState entityName="loops" filterStatus="running" totalForFilter={0} />,
      );
      expect(lastFrame()).toContain('No running loops found');
    });

    it('shows "No failed loops found" when filter is set and totalForFilter is undefined', () => {
      const { lastFrame } = render(
        <EmptyState entityName="loops" filterStatus="failed" />,
      );
      expect(lastFrame()).toContain('No failed loops found');
    });
  });

  describe('smart message — filter active + items exist in DB', () => {
    it('shows count + entity + "exist — not in current view" when filter hides all items', () => {
      const { lastFrame } = render(
        <EmptyState entityName="loops" filterStatus="failed" totalForFilter={32} />,
      );
      const frame = lastFrame() ?? '';
      expect(frame).toContain('32 failed loops exist — not in current view');
    });

    it('works for tasks entity with "running" filter', () => {
      const { lastFrame } = render(
        <EmptyState entityName="tasks" filterStatus="running" totalForFilter={7} />,
      );
      const frame = lastFrame() ?? '';
      expect(frame).toContain('7 running tasks exist — not in current view');
    });

    it('does NOT show smart message when totalForFilter is 0', () => {
      const { lastFrame } = render(
        <EmptyState entityName="loops" filterStatus="failed" totalForFilter={0} />,
      );
      const frame = lastFrame() ?? '';
      expect(frame).not.toContain('exist — not in current view');
      expect(frame).toContain('No failed loops found');
    });

    it('does NOT show smart message when filterStatus is null even if totalForFilter > 0', () => {
      // totalForFilter with no filter is a nonsensical combination — fall back to standard message
      const { lastFrame } = render(
        <EmptyState entityName="loops" filterStatus={null} totalForFilter={10} />,
      );
      const frame = lastFrame() ?? '';
      expect(frame).not.toContain('exist — not in current view');
      expect(frame).toContain('No loops found');
    });
  });
});
