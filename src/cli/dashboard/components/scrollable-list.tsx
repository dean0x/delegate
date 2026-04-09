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
  /** Optional stable key extractor — prevents remount when scroll offset shifts */
  readonly keyExtractor?: (item: T, index: number) => string;
  /**
   * Optional truncation notice shown in the footer when the displayed items are fewer
   * than the total count in the database (e.g. "showing 50 of 247").
   * When viewport also overflows, merged into the down-scroll indicator line.
   */
  readonly truncationNotice?: string | null;
}

// Generic component with forwardRef pattern — use a typed wrapper instead
function ScrollableListInner<T>({
  items,
  selectedIndex,
  scrollOffset,
  viewportHeight,
  renderItem,
  keyExtractor,
  truncationNotice,
}: ScrollableListProps<T>): React.ReactElement {
  const hasScrollUp = scrollOffset > 0;
  const hasScrollDown = scrollOffset + viewportHeight < items.length;
  const hasTruncation = truncationNotice != null && truncationNotice.length > 0;

  // Effective viewport adjusted for scroll indicators.
  // The bottom slot is consumed by either the down-scroll indicator, the truncation notice, or both merged.
  const indicatorHeight = (hasScrollUp ? 1 : 0) + (hasScrollDown || hasTruncation ? 1 : 0);
  const effectiveHeight = Math.max(1, viewportHeight - indicatorHeight);

  const visibleSlice = items.slice(scrollOffset, scrollOffset + effectiveHeight);

  // Build the bottom indicator line:
  //   - viewport overflow + truncation: "↓ N more · showing X of Y [status]"
  //   - viewport overflow only:         "↓ more"
  //   - truncation only (no overflow):  "showing X of Y [status]" (right-aligned dim)
  //   - neither:                        nothing
  const renderBottomIndicator = (): React.ReactNode => {
    if (hasScrollDown && hasTruncation) {
      return <Text dimColor>{`  ↓ more · ${truncationNotice}`}</Text>;
    }
    if (hasScrollDown) {
      return <Text dimColor>{'  ↓ more'}</Text>;
    }
    if (hasTruncation) {
      return <Text dimColor>{`  ${truncationNotice}`}</Text>;
    }
    return null;
  };

  return (
    <Box flexDirection="column">
      {hasScrollUp && <Text dimColor>{'  ↑ more'}</Text>}
      {visibleSlice.map((item, idx) => {
        const absoluteIndex = scrollOffset + idx;
        const isSelected = absoluteIndex === selectedIndex;
        return (
          <Box key={keyExtractor ? keyExtractor(item, absoluteIndex) : absoluteIndex} flexDirection="row">
            {renderItem(item, absoluteIndex, isSelected)}
          </Box>
        );
      })}
      {renderBottomIndicator()}
    </Box>
  );
}

ScrollableListInner.displayName = 'ScrollableList';

// Export typed version — component is effectively memoized via the generic pattern
export const ScrollableList = ScrollableListInner as <T>(props: ScrollableListProps<T>) => React.ReactElement;
