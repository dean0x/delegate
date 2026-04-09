/**
 * EmptyState component — dim message when no items match
 * ARCHITECTURE: Pure leaf component, no side effects
 */

import { Box, Text } from 'ink';
import React from 'react';

interface EmptyStateProps {
  readonly entityName: string;
  readonly filterStatus: string | null;
}

export const EmptyState: React.FC<EmptyStateProps> = React.memo(({ entityName, filterStatus }) => {
  const message = filterStatus !== null ? `No ${filterStatus} ${entityName} found` : `No ${entityName} found`;

  return (
    <Box paddingX={1}>
      <Text dimColor>{message}</Text>
    </Box>
  );
});

EmptyState.displayName = 'EmptyState';
