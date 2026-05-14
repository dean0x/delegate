/**
 * Tests for pure layout computation functions
 * ARCHITECTURE: Tests behaviors — dimension matrices, degraded modes, edge cases
 */

import { describe, expect, it } from 'vitest';
import { computeDetailOutputLayout, computeMetricsLayout } from '../../../../src/cli/dashboard/layout.js';

// ============================================================================
// computeMetricsLayout
// ============================================================================

describe('computeMetricsLayout', () => {
  describe('standard terminal 80x24', () => {
    it('computes correct layout for 80x24', () => {
      const layout = computeMetricsLayout({ columns: 80, rows: 24 });
      expect(layout.headerHeight).toBe(2);
      expect(layout.footerHeight).toBe(1);
      expect(layout.availableHeight).toBe(21);
      expect(layout.topRowHeight).toBe(8);
      expect(layout.bottomRowHeight).toBe(13);
      expect(layout.tileCount).toBe(2);
      expect(layout.mode).toBe('full');
    });
  });

  describe('large terminal 120x40', () => {
    it('computes correct layout for 120x40', () => {
      const layout = computeMetricsLayout({ columns: 120, rows: 40 });
      expect(layout.availableHeight).toBe(37);
      expect(layout.topRowHeight).toBe(12);
      expect(layout.bottomRowHeight).toBe(25);
      expect(layout.tileCount).toBe(4);
      expect(layout.mode).toBe('full');
    });
  });

  describe('very large terminal 200x60', () => {
    it('computes correct layout for 200x60', () => {
      const layout = computeMetricsLayout({ columns: 200, rows: 60 });
      expect(layout.availableHeight).toBe(57);
      expect(layout.topRowHeight).toBe(14);
      expect(layout.bottomRowHeight).toBe(43);
      expect(layout.tileCount).toBe(4);
      expect(layout.mode).toBe('full');
    });
  });

  describe('tiny terminal 40x10', () => {
    it('returns too-small mode for 40x10', () => {
      const layout = computeMetricsLayout({ columns: 40, rows: 10 });
      expect(layout.mode).toBe('too-small');
    });
  });

  describe('narrow terminal', () => {
    it('returns narrow mode when columns < 60 and rows >= 14', () => {
      const layout = computeMetricsLayout({ columns: 55, rows: 20 });
      expect(layout.mode).toBe('narrow');
    });

    it('returns too-small when rows < 14 even if columns >= 60', () => {
      const layout = computeMetricsLayout({ columns: 80, rows: 12 });
      expect(layout.mode).toBe('too-small');
    });
  });

  describe('tileCount boundaries', () => {
    it('returns tileCount 2 when columns < 90', () => {
      expect(computeMetricsLayout({ columns: 89, rows: 24 }).tileCount).toBe(2);
    });

    it('returns tileCount 3 when columns >= 90 and < 120', () => {
      expect(computeMetricsLayout({ columns: 90, rows: 24 }).tileCount).toBe(3);
      expect(computeMetricsLayout({ columns: 119, rows: 24 }).tileCount).toBe(3);
    });

    it('returns tileCount 4 when columns >= 120', () => {
      expect(computeMetricsLayout({ columns: 120, rows: 24 }).tileCount).toBe(4);
      expect(computeMetricsLayout({ columns: 200, rows: 24 }).tileCount).toBe(4);
    });
  });

  describe('topRowHeight clamping', () => {
    it('clamps topRowHeight minimum to 8', () => {
      const layout = computeMetricsLayout({ columns: 80, rows: 18 });
      expect(layout.topRowHeight).toBe(8);
    });

    it('clamps topRowHeight maximum to 14', () => {
      const layout = computeMetricsLayout({ columns: 80, rows: 60 });
      expect(layout.topRowHeight).toBe(14);
    });
  });
});

// ============================================================================
// computeDetailOutputLayout (#165)
// ============================================================================

describe('computeDetailOutputLayout', () => {
  it('normal terminal (rows=30, meta=15) returns viewport=11, tooSmall=false', () => {
    const layout = computeDetailOutputLayout({ rows: 30, metadataHeight: 15 });
    expect(layout.tooSmall).toBe(false);
    expect(layout.outputViewportHeight).toBe(11);
  });

  it('tiny terminal (rows=15, meta=12) returns tooSmall=true', () => {
    const layout = computeDetailOutputLayout({ rows: 15, metadataHeight: 12 });
    expect(layout.tooSmall).toBe(true);
    expect(layout.outputViewportHeight).toBe(0);
  });

  it('large terminal (rows=80, meta=20) returns viewport=56, tooSmall=false', () => {
    const layout = computeDetailOutputLayout({ rows: 80, metadataHeight: 20 });
    expect(layout.tooSmall).toBe(false);
    expect(layout.outputViewportHeight).toBe(56);
  });

  it('zero metadata (rows=30, meta=0) returns viewport=26, tooSmall=false', () => {
    const layout = computeDetailOutputLayout({ rows: 30, metadataHeight: 0 });
    expect(layout.tooSmall).toBe(false);
    expect(layout.outputViewportHeight).toBe(26);
  });

  it('metadata fills screen (rows=20, meta=18) returns tooSmall=true', () => {
    const layout = computeDetailOutputLayout({ rows: 20, metadataHeight: 18 });
    expect(layout.tooSmall).toBe(true);
    expect(layout.outputViewportHeight).toBe(0);
  });

  it('boundary: exactly 5 available rows returns tooSmall=false', () => {
    const layout = computeDetailOutputLayout({ rows: 9, metadataHeight: 0 });
    expect(layout.tooSmall).toBe(false);
    expect(layout.outputViewportHeight).toBe(5);
  });

  it('boundary: exactly 4 available rows returns tooSmall=true', () => {
    const layout = computeDetailOutputLayout({ rows: 8, metadataHeight: 0 });
    expect(layout.tooSmall).toBe(true);
  });
});
