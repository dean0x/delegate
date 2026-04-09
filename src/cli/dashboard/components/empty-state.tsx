/**
 * EmptyState component — dim message when no items match
 * ARCHITECTURE: Pure leaf component, no side effects
 */

import { Box, Text } from 'ink';
import React from 'react';

interface EmptyStateProps {
  readonly entityName: string;
  readonly filterStatus: string | null;
  /**
   * When a filter is active and items exist in the DB that don't appear in the
   * fetched result (e.g. they all have a different status than the current filter),
   * pass the true count for the filtered status here.
   *
   * When > 0 and filterStatus !== null, shows a smart message:
   *   "{totalForFilter} {filterStatus} {entityName} exist — not in current view"
   *
   * Otherwise falls back to standard "No {filterStatus} {entityName} found".
   */
  readonly totalForFilter?: number;
}

export const EmptyState: React.FC<EmptyStateProps> = React.memo(({ entityName, filterStatus, totalForFilter }) => {
  const isSmartMessage = filterStatus !== null && totalForFilter !== undefined && totalForFilter > 0;

  const message = isSmartMessage
    ? `${totalForFilter} ${filterStatus} ${entityName} exist — not in current view`
    : filterStatus !== null
      ? `No ${filterStatus} ${entityName} found`
      : `No ${entityName} found`;

  return (
    <Box paddingX={1}>
      <Text dimColor>{message}</Text>
    </Box>
  );
});

EmptyState.displayName = 'EmptyState';
