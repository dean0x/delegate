/**
 * Footer component — context-sensitive keyboard help bar assertions.
 *
 * Phase B update: Hint strings are now sourced from keyboard/hints.ts.
 * Main view hint now includes "1-5: panel" for the five-panel jump keys.
 */

import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { Footer } from '../../../../src/cli/dashboard/components/footer';

describe('Footer', () => {
  describe('viewKind="main" (metrics view)', () => {
    it('does NOT contain "1-4 jump" hint (pre-redesign grid artifact)', () => {
      const { lastFrame } = render(<Footer viewKind="main" />);
      expect(lastFrame()).not.toContain('1-4 jump');
    });

    it('does NOT contain "Tab cycle" hint (pre-redesign wording)', () => {
      const { lastFrame } = render(<Footer viewKind="main" />);
      expect(lastFrame()).not.toContain('Tab cycle');
    });

    it('contains "Tab: panel" hint describing panel cycling', () => {
      const { lastFrame } = render(<Footer viewKind="main" />);
      expect(lastFrame()).toContain('Tab: panel');
    });

    it('contains "1-5: panel" hint for five-panel jump keys', () => {
      const { lastFrame } = render(<Footer viewKind="main" />);
      expect(lastFrame()).toContain('1-5: panel');
    });

    it('contains "↑↓: select" hint', () => {
      const { lastFrame } = render(<Footer viewKind="main" />);
      expect(lastFrame()).toContain('↑↓: select');
    });

    it('contains "Enter: detail" hint', () => {
      const { lastFrame } = render(<Footer viewKind="main" />);
      expect(lastFrame()).toContain('Enter: detail');
    });

    it('contains "r refresh" hint', () => {
      const { lastFrame } = render(<Footer viewKind="main" />);
      expect(lastFrame()).toContain('r refresh');
    });

    it('contains "q quit" hint', () => {
      // The full hint string can wrap at terminal boundary; normalise whitespace before asserting
      const { lastFrame } = render(<Footer viewKind="main" />);
      const frame = (lastFrame() ?? '').replace(/\s+/g, ' ');
      expect(frame).toContain('q quit');
    });
  });

  describe('viewKind="main" + hasMutations=true', () => {
    it('contains "c cancel" mutation hint', () => {
      const { lastFrame } = render(<Footer viewKind="main" hasMutations />);
      expect(lastFrame()).toContain('c cancel');
    });

    it('contains "d delete (terminal)" mutation hint', () => {
      const { lastFrame } = render(<Footer viewKind="main" hasMutations />);
      expect(lastFrame()).toContain('d delete (terminal)');
    });

    it('does NOT contain "1-4 jump" even with mutations', () => {
      const { lastFrame } = render(<Footer viewKind="main" hasMutations />);
      expect(lastFrame()).not.toContain('1-4 jump');
    });

    it('does NOT contain "Tab cycle" even with mutations', () => {
      const { lastFrame } = render(<Footer viewKind="main" hasMutations />);
      expect(lastFrame()).not.toContain('Tab cycle');
    });

    it('does NOT contain "p pause/resume" when focusedPanel is tasks (not pauseable)', () => {
      const { lastFrame } = render(<Footer viewKind="main" hasMutations focusedPanel="tasks" />);
      expect(lastFrame()).not.toContain('p pause/resume');
    });

    it('does NOT contain "p pause/resume" when focusedPanel is orchestrations (not pauseable)', () => {
      const { lastFrame } = render(<Footer viewKind="main" hasMutations focusedPanel="orchestrations" />);
      expect(lastFrame()).not.toContain('p pause/resume');
    });

    it('does NOT contain "p pause/resume" when focusedPanel is pipelines (not pauseable)', () => {
      const { lastFrame } = render(<Footer viewKind="main" hasMutations focusedPanel="pipelines" />);
      expect(lastFrame()).not.toContain('p pause/resume');
    });

    it('contains "p pause/resume" when focusedPanel is schedules', () => {
      const { lastFrame } = render(<Footer viewKind="main" hasMutations focusedPanel="schedules" />);
      expect(lastFrame()).toContain('p pause/resume');
    });

    it('contains "p pause/resume" when focusedPanel is loops', () => {
      const { lastFrame } = render(<Footer viewKind="main" hasMutations focusedPanel="loops" />);
      expect(lastFrame()).toContain('p pause/resume');
    });

    it('does NOT contain "p pause/resume" when focusedPanel is undefined', () => {
      const { lastFrame } = render(<Footer viewKind="main" hasMutations />);
      expect(lastFrame()).not.toContain('p pause/resume');
    });
  });

  describe('viewKind="detail"', () => {
    it('contains "Esc back" hint', () => {
      const { lastFrame } = render(<Footer viewKind="detail" />);
      expect(lastFrame()).toContain('Esc back');
    });

    it('contains "↑↓ select" hint', () => {
      const { lastFrame } = render(<Footer viewKind="detail" />);
      expect(lastFrame()).toContain('↑↓ select');
    });

    it('does not render main-view hints', () => {
      const { lastFrame } = render(<Footer viewKind="detail" />);
      expect(lastFrame()).not.toContain('1-4 jump');
      expect(lastFrame()).not.toContain('Tab cycle');
    });

    it('contains "p pause" for active schedule in detail view', () => {
      const { lastFrame } = render(<Footer viewKind="detail" entityType="schedules" entityStatus="active" />);
      const frame = (lastFrame() ?? '').replace(/\s+/g, ' ');
      expect(frame).toContain('p pause');
    });

    it('contains "p resume" for paused schedule in detail view', () => {
      const { lastFrame } = render(<Footer viewKind="detail" entityType="schedules" entityStatus="paused" />);
      const frame = (lastFrame() ?? '').replace(/\s+/g, ' ');
      expect(frame).toContain('p resume');
    });

    it('contains "p pause" for running loop in detail view', () => {
      const { lastFrame } = render(<Footer viewKind="detail" entityType="loops" entityStatus="running" />);
      const frame = (lastFrame() ?? '').replace(/\s+/g, ' ');
      expect(frame).toContain('p pause');
    });

    it('contains "p resume" for paused loop in detail view', () => {
      const { lastFrame } = render(<Footer viewKind="detail" entityType="loops" entityStatus="paused" />);
      const frame = (lastFrame() ?? '').replace(/\s+/g, ' ');
      expect(frame).toContain('p resume');
    });

    it('does NOT contain "p pause" or "p resume" for task in detail view', () => {
      const { lastFrame } = render(<Footer viewKind="detail" entityType="tasks" entityStatus="running" />);
      const frame = lastFrame() ?? '';
      expect(frame).not.toContain('p pause');
      expect(frame).not.toContain('p resume');
    });

    it('does NOT contain "p pause" or "p resume" when no entityType provided in detail view', () => {
      const { lastFrame } = render(<Footer viewKind="detail" />);
      const frame = lastFrame() ?? '';
      expect(frame).not.toContain('p pause');
      expect(frame).not.toContain('p resume');
    });
  });
});
