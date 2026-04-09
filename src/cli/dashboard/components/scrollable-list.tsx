/**
 * ScrollableList component — viewport-clipped list with selection cursor
 * ARCHITECTURE: Pure component — all state passed as props, no internal state
 */

import { Box, Text } from 'ink';
import React from 'react';

interface ScrollableListProps<T> {
  readonly items: readonly T[];
  readonly selectedIndex: number;
  readonly scrollOffset: number;
  readonly viewportHeight: number;
  readonly renderItem: (item: T, index: number, isSelected: boolean) => React.ReactNode;
}

// Generic component with forwardRef pattern — use a typed wrapper instead
function ScrollableListInner<T>({
  items,
  selectedIndex,
  scrollOffset,
  viewportHeight,
  renderItem,
}: ScrollableListProps<T>): React.ReactElement {
  const hasScrollUp = scrollOffset > 0;
  const hasScrollDown = scrollOffset + viewportHeight < items.length;

  // Effective viewport adjusted for scroll indicators
  const indicatorHeight = (hasScrollUp ? 1 : 0) + (hasScrollDown ? 1 : 0);
  const effectiveHeight = Math.max(1, viewportHeight - indicatorHeight);

  const visibleSlice = items.slice(scrollOffset, scrollOffset + effectiveHeight);

  return (
    <Box flexDirection="column">
      {hasScrollUp && <Text dimColor>{'  ↑ more'}</Text>}
      {visibleSlice.map((item, idx) => {
        const absoluteIndex = scrollOffset + idx;
        const isSelected = absoluteIndex === selectedIndex;
        return (
          <Box key={absoluteIndex} flexDirection="row">
            {renderItem(item, absoluteIndex, isSelected)}
          </Box>
        );
      })}
      {hasScrollDown && <Text dimColor>{'  ↓ more'}</Text>}
    </Box>
  );
}

ScrollableListInner.displayName = 'ScrollableList';

// Export typed version — component is effectively memoized via the generic pattern
export const ScrollableList = ScrollableListInner as <T>(props: ScrollableListProps<T>) => React.ReactElement;
