/**
 * Field components — shared label+value layout for detail views
 * ARCHITECTURE: Pure leaf components, no side effects
 */

import { Box, Text } from 'ink';
import React from 'react';

interface FieldProps {
  readonly label: string;
  readonly children: React.ReactNode;
}

/** Inline field row: bold cyan label (padded to 22 chars) followed by value */
export const Field: React.FC<FieldProps> = React.memo(({ label, children }) => {
  return (
    <Box flexDirection="row" marginBottom={0}>
      <Text bold color="cyan">
        {label.padEnd(22, ' ')}
      </Text>
      <Text>{children}</Text>
    </Box>
  );
});

Field.displayName = 'Field';

interface LongFieldProps {
  readonly label: string;
  readonly value: string;
}

/** Multi-line field: bold cyan label above indented wrapped value */
export const LongField: React.FC<LongFieldProps> = React.memo(({ label, value }) => {
  return (
    <Box flexDirection="column" marginBottom={0}>
      <Text bold color="cyan">
        {label}
      </Text>
      <Box paddingLeft={2}>
        <Text wrap="wrap">{value}</Text>
      </Box>
    </Box>
  );
});

LongField.displayName = 'LongField';

interface StatusFieldProps {
  readonly children: React.ReactNode;
}

/** Inline field row pre-labelled "Status" — accepts a StatusBadge as children */
export const StatusField: React.FC<StatusFieldProps> = React.memo(({ children }) => {
  return (
    <Box flexDirection="row" marginBottom={0}>
      <Text bold color="cyan">
        {'Status'.padEnd(22, ' ')}
      </Text>
      {children}
    </Box>
  );
});

StatusField.displayName = 'StatusField';
