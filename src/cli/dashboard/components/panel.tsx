/**
 * Panel component — bordered panel wrapper with title, focus indicator, filter badge
 * ARCHITECTURE: Pure container component, children rendered inside border
 */

import { Box, Text } from 'ink';
import React from 'react';

interface PanelProps {
  readonly title: string;
  readonly statusSummary: string;
  readonly focused: boolean;
  readonly filterStatus: string | null;
  readonly children: React.ReactNode;
}

export const Panel: React.FC<PanelProps> = React.memo(({ title, statusSummary, focused, filterStatus, children }) => {
  const borderColor = focused ? 'cyan' : undefined;

  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={borderColor} paddingX={1}>
      {/* Header row: title + optional filter badge + status summary */}
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row" gap={1}>
          <Text bold={focused} color={focused ? 'cyan' : undefined}>
            {title}
          </Text>
          {filterStatus !== null && (
            <Text color="yellow" dimColor>
              {'[filter: '}
              {filterStatus}
              {']'}
            </Text>
          )}
        </Box>
        <Text dimColor>{statusSummary}</Text>
      </Box>
      {/* Panel content */}
      {children}
    </Box>
  );
});

Panel.displayName = 'Panel';
