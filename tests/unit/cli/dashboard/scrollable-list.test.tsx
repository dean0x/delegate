/**
 * Tests for ScrollableList component.
 * Tests behavior: viewport clipping, scroll indicators, selection state.
 */

import { render } from 'ink-testing-library';
import { Text } from 'ink';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { ScrollableList } from '../../../../src/cli/dashboard/components/scrollable-list.js';

// ============================================================================
// Helpers
// ============================================================================

type StringItem = { label: string };

function makeItems(count: number): StringItem[] {
  return Array.from({ length: count }, (_, i) => ({ label: `item-${i}` }));
}

function renderList(options: {
  items: StringItem[];
  selectedIndex?: number;
  scrollOffset?: number;
  viewportHeight?: number;
}): string {
  const { items, selectedIndex = 0, scrollOffset = 0, viewportHeight = 5 } = options;
  const { lastFrame } = render(
    <ScrollableList
      items={items}
      selectedIndex={selectedIndex}
      scrollOffset={scrollOffset}
      viewportHeight={viewportHeight}
      renderItem={(item, _index, isSelected) => (
        <Text>{isSelected ? `> ${item.label}` : `  ${item.label}`}</Text>
      )}
    />,
  );
  return lastFrame() ?? '';
}

// ============================================================================
// Viewport clipping
// ============================================================================

describe('ScrollableList viewport clipping', () => {
  it('renders all items when count is within viewport', () => {
    const items = makeItems(3);
    const frame = renderList({ items, viewportHeight: 5 });
    expect(frame).toContain('item-0');
    expect(frame).toContain('item-1');
    expect(frame).toContain('item-2');
  });

  it('clips items that fall outside the viewport', () => {
    // 10 items, viewport 5, no scroll.
    // The ↓ more indicator consumes 1 slot, so effectiveHeight = 4: items 0-3 visible.
    // item-4 and beyond are clipped.
    const items = makeItems(10);
    const frame = renderList({ items, viewportHeight: 5, scrollOffset: 0 });
    expect(frame).toContain('item-0');
    expect(frame).toContain('item-3');
    expect(frame).not.toContain('item-4');
    expect(frame).not.toContain('item-9');
  });

  it('shows items starting from scrollOffset', () => {
    const items = makeItems(10);
    // scroll down to item-3 — should see item-3, item-4, item-5, item-6, item-7
    const frame = renderList({ items, viewportHeight: 5, scrollOffset: 3 });
    expect(frame).toContain('item-3');
    expect(frame).not.toContain('item-0');
    expect(frame).not.toContain('item-2');
  });

  it('handles empty items list', () => {
    const frame = renderList({ items: [], viewportHeight: 5 });
    // Should render without crashing; no items shown
    expect(frame).not.toContain('item-');
  });

  it('handles a single item', () => {
    const items = makeItems(1);
    const frame = renderList({ items, viewportHeight: 5 });
    expect(frame).toContain('item-0');
  });
});

// ============================================================================
// Selection state
// ============================================================================

describe('ScrollableList selection state', () => {
  it('renders the selected item with the ">" prefix', () => {
    const items = makeItems(3);
    const frame = renderList({ items, selectedIndex: 1 });
    expect(frame).toContain('> item-1');
  });

  it('renders non-selected items with the "  " prefix', () => {
    const items = makeItems(3);
    const frame = renderList({ items, selectedIndex: 0 });
    expect(frame).toContain('  item-1');
    expect(frame).toContain('  item-2');
  });

  it('correctly tracks selection across scroll offset', () => {
    // items 0-9, viewport 5, scrolled to offset 5 — item-7 is selected
    const items = makeItems(10);
    const frame = renderList({ items, selectedIndex: 7, scrollOffset: 5 });
    expect(frame).toContain('> item-7');
  });
});

// ============================================================================
// Scroll indicators
// ============================================================================

describe('ScrollableList scroll indicators', () => {
  it('shows no indicators when all items fit in viewport', () => {
    const items = makeItems(3);
    const frame = renderList({ items, viewportHeight: 10 });
    expect(frame).not.toContain('↑ more');
    expect(frame).not.toContain('↓ more');
  });

  it('shows down indicator (↓ more) when items overflow below', () => {
    const items = makeItems(10);
    const frame = renderList({ items, viewportHeight: 5, scrollOffset: 0 });
    expect(frame).toContain('↓ more');
  });

  it('shows up indicator (↑ more) when scrolled down', () => {
    const items = makeItems(10);
    const frame = renderList({ items, viewportHeight: 5, scrollOffset: 3 });
    expect(frame).toContain('↑ more');
  });

  it('shows both indicators when scrolled into the middle of a long list', () => {
    const items = makeItems(20);
    // Scrolled to middle: items above and below viewport
    const frame = renderList({ items, viewportHeight: 5, scrollOffset: 8 });
    expect(frame).toContain('↑ more');
    expect(frame).toContain('↓ more');
  });

  it('shows only up indicator when scrolled to the bottom', () => {
    const items = makeItems(10);
    // scrollOffset = 5 with viewportHeight = 5 means showing items 5-9 (last item is 9)
    const frame = renderList({ items, viewportHeight: 5, scrollOffset: 5 });
    expect(frame).toContain('↑ more');
    expect(frame).not.toContain('↓ more');
  });

  it('reduces visible items to accommodate scroll indicators', () => {
    // With both indicators, effective height = viewportHeight - 2
    // viewport 5, scroll offset 5 from 20 items: both indicators shown, 3 items visible
    const items = makeItems(20);
    const frame = renderList({ items, viewportHeight: 5, scrollOffset: 5 });
    // item-5, item-6, item-7 should be visible; item-8 should not (taken by ↓ indicator)
    expect(frame).toContain('item-5');
    expect(frame).toContain('item-6');
    expect(frame).toContain('item-7');
    expect(frame).not.toContain('item-8');
  });
});
