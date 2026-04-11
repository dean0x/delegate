/**
 * Footer component — context-sensitive keyboard help bar assertions.
 *
 * v1.3.0 (Phase F update): MAIN_HELP was updated to reflect the new metrics-view
 * key model. The old "1-4 jump" and "Tab cycle" hints are gone; the new hints
 * clearly describe the activity-focus Tab behaviour.
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

    it('contains "Tab: activity" hint describing the new focus toggle', () => {
      const { lastFrame } = render(<Footer viewKind="main" />);
      expect(lastFrame()).toContain('Tab: activity');
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
      const { lastFrame } = render(<Footer viewKind="main" />);
      expect(lastFrame()).toContain('q quit');
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
  });

  describe('viewKind="workspace"', () => {
    it('contains "fullscreen" hint', () => {
      const { lastFrame } = render(<Footer viewKind="workspace" />);
      expect(lastFrame()).toContain('fullscreen');
    });

    it('does not contain main-view "1-4 jump"', () => {
      const { lastFrame } = render(<Footer viewKind="workspace" />);
      expect(lastFrame()).not.toContain('1-4 jump');
    });
  });

  describe('viewKind="detail"', () => {
    it('contains "Esc back" hint', () => {
      const { lastFrame } = render(<Footer viewKind="detail" />);
      expect(lastFrame()).toContain('Esc back');
    });

    it('contains "↑↓ scroll" hint', () => {
      const { lastFrame } = render(<Footer viewKind="detail" />);
      expect(lastFrame()).toContain('↑↓ scroll');
    });

    it('does not render main-view hints', () => {
      const { lastFrame } = render(<Footer viewKind="detail" />);
      expect(lastFrame()).not.toContain('1-4 jump');
      expect(lastFrame()).not.toContain('Tab cycle');
    });
  });
});
