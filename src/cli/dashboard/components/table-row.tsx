/**
 * TableRow component — column-aligned row with optional selection highlighting
 * ARCHITECTURE: Pure leaf component, no side effects
 */

import { Text } from 'ink';
import React from 'react';
import { truncateCell } from '../format.js';

interface Cell {
  readonly text: string;
  readonly width: number;
}

interface TableRowProps {
  readonly cells: readonly Cell[];
  readonly selected?: boolean;
}

export const TableRow: React.FC<TableRowProps> = React.memo(({ cells, selected = false }) => {
  const content = cells.map(({ text, width }) => truncateCell(text, width).padEnd(width)).join(' ');

  return (
    <Text bold={selected} inverse={selected}>
      {selected ? '▶ ' : '  '}
      {content}
    </Text>
  );
});

TableRow.displayName = 'TableRow';
